// Recover the work of subagents that died with their CLI process.
//
// THE HAZARD
// ----------
// Every subagent the driven Claude Code run starts (the Agent/Task tool, incl.
// `run_in_background` ones) lives INSIDE the CLI process this driver spawns for
// the step. `waitForBackgroundTasks` (background-tasks.js) holds the step open
// so they survive a NORMAL turn end. It cannot help on the other two exits:
//
//   1. the caller aborts (DSH session disconnect / restart / user stop) — the
//      run loop breaks on `signal.aborted` and the transport is torn down;
//   2. the process is killed outright — no `finally` runs at all.
//
// In both cases the subagent dies mid-flight and its final reply is never
// produced, so from the delegating side the delegation delivered NOTHING.
//
// WHAT IS ACTUALLY RECOVERABLE
// ----------------------------
// The reply is gone, but the reasoning is not: Claude Code streams every
// subagent turn to disk as it happens, at
//
//   <claudeHome>/projects/<project-slug>/<sessionId>/subagents/agent-<id>.jsonl
//
// one JSON record per line, each carrying `sessionId`, `agentId`, `cwd` and
// `isSidechain: true`. So a killed subagent leaves its complete transcript
// minus the last step. Nothing needs to be flushed while being killed (which is
// exactly when flushing is least reliable) — the data is already there, and
// what is missing is DELIVERY.
//
// THE MECHANISM
// -------------
// A write-ahead marker, not a shutdown hook:
//
//   * the moment a run first reports live background work, `markRunAtRisk()`
//     writes a small marker naming that run's Claude session id;
//   * a run that finishes cleanly deletes its own marker;
//   * therefore ANY marker still on disk at the start of a later run belongs to
//     a run that did not finish — including one that was hard-killed, which is
//     the case a `finally`-based design cannot see.
//
// `harvestOrphanedRuns()` reads those leftover markers, pulls the last assistant
// text out of each subagent transcript, writes one readable report per orphaned
// run, and returns a note for the driver to narrate. Recovery therefore lands on
// the user's NEXT turn — which is precisely when they are back.
//
// Every filesystem entry point takes an injectable `fs`/path root so the whole
// module is unit-testable offline (see test-agent-harvest.mjs).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Real-filesystem port. Tests pass their own object with the same shape. */
const REAL_FS = { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync }

/** Longest transcript this module will parse, so a runaway log cannot stall a turn. */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

/** Characters of recovered text quoted inline; the rest stays in the report file. */
export const NOTE_EXCERPT_CHARS = 400

/** Markers older than this are swept without being reported (stale from long-gone runs). */
export const MARKER_TTL_MS = 24 * 60 * 60 * 1000

/** `~/.claude` unless the caller overrides it. */
export function claudeHome(opts = {}) {
  return opts.claudeHome ?? join(opts.homeDir ?? homedir(), '.claude')
}

/** `$DSH_HOME/storages/claude-driver` — where this module keeps its own state. */
export function driverStateDir(opts = {}) {
  if (opts.stateDir) return opts.stateDir
  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(opts.homeDir ?? homedir(), '.dsh')
  return join(dshHome, 'storages', 'claude-driver')
}

function markerDir(opts = {}) {
  return join(driverStateDir(opts), 'runs-at-risk')
}

function reportDir(opts = {}) {
  return join(driverStateDir(opts), 'recovered')
}

function listDir(fs, dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** A file name safe on Windows and POSIX, derived from an untrusted id. */
export function safeName(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 120)
}

/**
 * Locate every subagent transcript Claude Code wrote for one CLI session.
 *
 * The project directory is a slug of the run's cwd whose exact rule is Claude
 * Code's business, so this walks the project directories instead of recomputing
 * it — the `<sessionId>/subagents` suffix is what actually identifies the run.
 * @param sessionId - Claude Code `session_id` of the run.
 * @param opts - `{claudeHome, homeDir, fs}` overrides for tests.
 * @returns absolute transcript paths, newest last.
 */
export function findSubagentTranscripts(sessionId, opts = {}) {
  const fs = opts.fs ?? REAL_FS
  const id = String(sessionId ?? '')
  if (!id) return []
  const root = join(claudeHome(opts), 'projects')
  const found = []
  for (const project of listDir(fs, root)) {
    const dir = join(root, project, id, 'subagents')
    for (const entry of listDir(fs, dir)) {
      if (entry.startsWith('agent-') && entry.endsWith('.jsonl')) found.push(join(dir, entry))
    }
  }
  return found
}

/** Flatten one SDK message's content to plain text (blocks or bare string). */
function contentText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Read one subagent transcript into the parts worth handing back.
 *
 * `lastText` is the subagent's most recent assistant text — for a subagent that
 * died mid-report this is the closest thing to a deliverable that exists.
 * @param file - absolute transcript path.
 * @param opts - `{fs}` override for tests.
 * @returns the parsed summary, or undefined when the file is unreadable/empty.
 */
export function readAgentTranscript(file, opts = {}) {
  const fs = opts.fs ?? REAL_FS
  let raw
  try {
    const size = fs.statSync(file)?.size
    if (typeof size === 'number' && size > MAX_TRANSCRIPT_BYTES) return undefined
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let agentId
  let prompt = ''
  let lastTimestamp
  const texts = []
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof record.agentId === 'string' && record.agentId) agentId = record.agentId
    if (typeof record.timestamp === 'string' && record.timestamp) lastTimestamp = record.timestamp
    if (record.type === 'user' && !prompt) prompt = contentText(record.message).trim()
    if (record.type === 'assistant') {
      const text = contentText(record.message).trim()
      if (text) texts.push(text)
    }
  }
  if (agentId === undefined && texts.length === 0) return undefined
  return {
    file,
    agentId: agentId ?? 'unknown',
    prompt,
    texts,
    lastText: texts.length ? texts[texts.length - 1] : '',
    lastTimestamp,
  }
}

/**
 * Write the marker that says "this run had background work in flight".
 *
 * Called the first time a run reports live background tasks, NOT on every run:
 * a run with nothing at risk should leave nothing behind to sweep.
 * @param record - `{sessionId, dshSessionId, cwd, startedAt, tasks}`.
 * @param opts - `{stateDir, dshHome, homeDir, fs}` overrides for tests.
 * @returns the marker path, or undefined when it could not be written.
 */
export function markRunAtRisk(record, opts = {}) {
  const fs = opts.fs ?? REAL_FS
  const sessionId = String(record?.sessionId ?? '')
  if (!sessionId) return undefined
  const dir = markerDir(opts)
  const file = join(dir, `${safeName(sessionId)}.json`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          version: 1,
          sessionId,
          dshSessionId: record?.dshSessionId ?? null,
          cwd: record?.cwd ?? null,
          startedAt: record?.startedAt ?? null,
          markedAt: record?.markedAt ?? null,
          tasks: Array.isArray(record?.tasks) ? record.tasks.slice(0, 32) : [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return file
  } catch {
    return undefined
  }
}

/**
 * Drop one run's marker — the run ended on its own terms, so nothing is orphaned.
 * @param sessionId - Claude Code `session_id` of the run.
 * @param opts - `{stateDir, dshHome, homeDir, fs}` overrides for tests.
 */
export function clearRunAtRisk(sessionId, opts = {}) {
  const fs = opts.fs ?? REAL_FS
  const id = String(sessionId ?? '')
  if (!id) return
  try {
    fs.rmSync(join(markerDir(opts), `${safeName(id)}.json`), { force: true })
  } catch {
    /* best effort: a stale marker only costs one extra harvest attempt */
  }
}

/** Read every marker currently on disk. */
export function readRunsAtRisk(opts = {}) {
  const fs = opts.fs ?? REAL_FS
  const dir = markerDir(opts)
  const out = []
  for (const entry of listDir(fs, dir)) {
    if (!entry.endsWith('.json')) continue
    const file = join(dir, entry)
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed.sessionId === 'string' && parsed.sessionId) out.push({ ...parsed, file })
    } catch {
      // Unreadable marker: drop it rather than retry forever.
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

/** Render one orphaned run's recovered transcripts as a readable report. */
export function renderReport(run, agents) {
  const lines = [
    `# Claude Code 子代理抢救报告`,
    ``,
    `这一轮的 Claude Code 进程在子代理跑完之前就结束了（会话断开、被中止，或进程被杀）。`,
    `子代理的最终回复没有产出，但它们的完整过程已经落盘，下面是能救回来的部分。`,
    ``,
    `- Claude 会话: \`${run.sessionId}\``,
    `- DSH 会话: \`${run.dshSessionId ?? '未知'}\``,
    `- 工作目录: \`${run.cwd ?? '未知'}\``,
    `- 标记时间: ${run.markedAt ?? run.startedAt ?? '未知'}`,
    `- 抢救到的子代理: ${agents.length}`,
    ``,
  ]
  if (Array.isArray(run.tasks) && run.tasks.length) {
    lines.push(`中断时仍在运行的后台任务：`, ...run.tasks.map((task) => `- ${task}`), ``)
  }
  for (const agent of agents) {
    lines.push(
      `---`,
      ``,
      `## 子代理 \`${agent.agentId}\``,
      ``,
      `- transcript: \`${agent.file}\``,
      `- 最后活动: ${agent.lastTimestamp ?? '未知'}`,
      `- assistant 段落数: ${agent.texts.length}`,
      ``,
    )
    if (agent.prompt) {
      lines.push(`### 交给它的任务`, ``, '```', agent.prompt.slice(0, 2000), '```', ``)
    }
    lines.push(`### 它最后产出的内容`, ``, agent.lastText || '_（这个子代理还没产出任何文本）_', ``)
    if (agent.texts.length > 1) {
      lines.push(
        `<details><summary>更早的 ${agent.texts.length - 1} 段过程输出</summary>`,
        ``,
        ...agent.texts.slice(0, -1).flatMap((text, index) => [`**#${index + 1}**`, ``, text, ``]),
        `</details>`,
        ``,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

/** Driver-authored narration pointing at what was recovered. Never model text. */
export function renderHarvestNote(recovered) {
  if (!recovered.length) return ''
  const blocks = recovered.map((entry) => {
    const heads = entry.agents
      .map((agent) => {
        const excerpt = agent.lastText.replace(/\s+/g, ' ').trim().slice(0, NOTE_EXCERPT_CHARS)
        return `  · ${agent.agentId}：${excerpt ? `${excerpt}${agent.lastText.length > NOTE_EXCERPT_CHARS ? '…' : ''}` : '（无文本产出）'}`
      })
      .join('\n')
    return `上一轮有 ${entry.agents.length} 个 Claude Code 子代理随进程一起中断，已从磁盘抢救出它们的过程输出：\n${heads}\n  完整报告：${entry.report}`
  })
  return `\n\n[claude-driver ${blocks.join('\n')}]`
}

/**
 * Sweep leftover markers and recover what their subagents managed to produce.
 *
 * Safe to call at the start of every run: with no leftover markers it touches
 * nothing and returns an empty result. Markers are cleared whether or not
 * anything was recovered, so a run that left no subagent trace is not retried
 * forever.
 * @param opts - `{claudeHome, stateDir, dshHome, homeDir, fs, now, skipSessionId}`.
 * @returns `{recovered, note}` — per-run recovered agents plus the narration.
 */
export function harvestOrphanedRuns(opts = {}) {
  const fs = opts.fs ?? REAL_FS
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const recovered = []
  for (const run of readRunsAtRisk(opts)) {
    // The in-flight run owns its own marker; only PREVIOUS runs are orphans.
    if (opts.skipSessionId && run.sessionId === opts.skipSessionId) continue
    const started = Date.parse(run.markedAt ?? run.startedAt ?? '')
    const expired = Number.isFinite(started) && now - started > MARKER_TTL_MS
    const agents = expired
      ? []
      : findSubagentTranscripts(run.sessionId, opts)
          .map((file) => readAgentTranscript(file, opts))
          .filter((agent) => agent !== undefined && (agent.lastText || agent.texts.length))
    if (agents.length) {
      const dir = reportDir(opts)
      const report = join(dir, `${safeName(run.markedAt ?? String(now))}-${safeName(run.sessionId)}.md`)
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(report, renderReport(run, agents), 'utf8')
        recovered.push({ sessionId: run.sessionId, agents, report })
      } catch {
        // Could not persist the report: still surface the excerpts inline.
        recovered.push({ sessionId: run.sessionId, agents, report: '(报告写入失败)' })
      }
    }
    try {
      fs.rmSync(run.file, { force: true })
    } catch {
      /* ignore: worst case the next run re-reports it */
    }
  }
  return { recovered, note: renderHarvestNote(recovered) }
}
