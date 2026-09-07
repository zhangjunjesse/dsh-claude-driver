// Pure unit tests (no network, no SDK spawn, no real filesystem) for recovering
// subagents that died with their CLI process. The hazard this covers is the one
// waitForBackgroundTasks CANNOT: a caller abort or an outright kill leaves the
// subagent's final reply unproduced, and only its on-disk transcript survives.
// Run: node test-agent-harvest.mjs
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  clearRunAtRisk,
  findSubagentTranscripts,
  harvestOrphanedRuns,
  markRunAtRisk,
  readAgentTranscript,
  readRunsAtRisk,
  renderHarvestNote,
  safeName,
} from './lib/agent-harvest.js'
import { streamClaudeChunks } from './lib/index.js'

// --- an in-memory filesystem with just the surface the module ports ----------
function memfs(seed = {}) {
  const files = new Map(Object.entries(seed))
  const dirs = () => {
    const set = new Set()
    for (const path of files.keys()) {
      const parts = path.split(/[\\/]/)
      for (let i = 1; i < parts.length; i += 1) set.add(parts.slice(0, i).join('\\'))
    }
    return set
  }
  return {
    files,
    existsSync: (path) => files.has(path) || dirs().has(path),
    mkdirSync: () => {},
    readdirSync: (path) => {
      const prefix = `${path}\\`
      const names = new Set()
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue
        names.add(file.slice(prefix.length).split(/[\\/]/)[0])
      }
      if (!names.size && !dirs().has(path)) throw new Error(`ENOENT: ${path}`)
      return [...names]
    },
    readFileSync: (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`)
      return files.get(path)
    },
    writeFileSync: (path, data) => files.set(path, data),
    rmSync: (path) => files.delete(path),
    statSync: (path) => ({ size: (files.get(path) ?? '').length }),
  }
}

const CLAUDE_HOME = 'C:\\home\\.claude'
const STATE_DIR = 'C:\\home\\.dsh\\storages\\claude-driver'
const SESSION = 'sess-1'

function transcriptPath(sessionId, agentId, project = 'proj-a') {
  return join(CLAUDE_HOME, 'projects', project, sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

function transcript(agentId, { prompt, texts }) {
  const lines = [
    JSON.stringify({
      type: 'user',
      isSidechain: true,
      agentId,
      sessionId: SESSION,
      timestamp: '2026-09-07T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }),
    ...texts.map((text, index) =>
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        agentId,
        sessionId: SESSION,
        timestamp: `2026-09-07T10:0${index + 1}:00.000Z`,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      }),
    ),
  ]
  return `${lines.join('\n')}\n`
}

// --- transcripts are found by session id, not by guessing the project slug ---
{
  const fs = memfs({
    [transcriptPath(SESSION, 'a1')]: transcript('a1', { prompt: 'p', texts: ['x'] }),
    [transcriptPath(SESSION, 'a2', 'proj-b')]: transcript('a2', { prompt: 'p', texts: ['y'] }),
    [transcriptPath('other-session', 'a3')]: transcript('a3', { prompt: 'p', texts: ['z'] }),
  })
  const found = findSubagentTranscripts(SESSION, { fs, claudeHome: CLAUDE_HOME })
  assert.equal(found.length, 2, 'both project directories are searched')
  assert.ok(
    !found.some((file) => file.includes('other-session')),
    'another run’s subagents are never harvested',
  )
}

// --- the last assistant text is what a killed subagent leaves behind ---------
{
  const file = transcriptPath(SESSION, 'a1')
  const fs = memfs({
    [file]: transcript('a1', { prompt: 'write the report', texts: ['reading files', 'Writing the full report now.'] }),
  })
  const parsed = readAgentTranscript(file, { fs })
  assert.equal(parsed.agentId, 'a1')
  assert.equal(parsed.prompt, 'write the report', 'the delegation prompt is recovered')
  assert.equal(parsed.texts.length, 2)
  assert.equal(parsed.lastText, 'Writing the full report now.', 'last assistant text wins')
}

// --- a malformed transcript degrades to "nothing", never to a throw ----------
{
  const file = transcriptPath(SESSION, 'bad')
  const fs = memfs({ [file]: 'not json\n{"type":"assistant"\n' })
  assert.equal(readAgentTranscript(file, { fs }), undefined, 'unparseable lines yield no record')
  assert.equal(readAgentTranscript('C:\\missing.jsonl', { fs }), undefined, 'a missing file never throws')
}

// --- marker lifecycle: written once, cleared by a run that finishes ----------
{
  const fs = memfs()
  const opts = { fs, stateDir: STATE_DIR }
  markRunAtRisk({ sessionId: SESSION, dshSessionId: 'dsh-1', cwd: 'C:\\w', markedAt: '2026-09-07T10:00:00.000Z' }, opts)
  assert.equal(readRunsAtRisk(opts).length, 1, 'the marker is on disk while work is in flight')
  clearRunAtRisk(SESSION, opts)
  assert.equal(readRunsAtRisk(opts).length, 0, 'a clean finish retires its own marker')
}

// --- the payoff: a leftover marker recovers the dead subagent's work ---------
{
  const fs = memfs({
    [transcriptPath(SESSION, 'a1')]: transcript('a1', {
      prompt: 'write report A',
      texts: ['scanning', 'Writing the full report now.'],
    }),
    [transcriptPath(SESSION, 'a2')]: transcript('a2', { prompt: 'write report B', texts: ['half of report B'] }),
  })
  const opts = { fs, stateDir: STATE_DIR, claudeHome: CLAUDE_HOME }
  markRunAtRisk(
    { sessionId: SESSION, dshSessionId: 'dsh-1', cwd: 'C:\\w', markedAt: new Date().toISOString(), tasks: ['report A'] },
    opts,
  )

  const { recovered, note } = harvestOrphanedRuns(opts)
  assert.equal(recovered.length, 1, 'the orphaned run is picked up')
  assert.equal(recovered[0].agents.length, 2, 'both dead subagents are recovered')
  assert.match(note, /2 个 Claude Code 子代理/, 'the note names how many were salvaged')
  assert.match(note, /Writing the full report now\./, 'the note quotes what the subagent last produced')

  const report = fs.files.get(recovered[0].report)
  assert.ok(report, 'a full report is written to disk')
  assert.match(report, /half of report B/, 'the report carries content the inline note truncates')
  assert.match(report, /write report A/, 'the report records what each subagent was asked to do')

  assert.equal(readRunsAtRisk(opts).length, 0, 'the marker is consumed, so recovery never repeats')
  assert.equal(harvestOrphanedRuns(opts).recovered.length, 0, 'a second sweep finds nothing')
}

// --- the in-flight run must not harvest itself -------------------------------
{
  const fs = memfs({
    [transcriptPath(SESSION, 'a1')]: transcript('a1', { prompt: 'p', texts: ['partial'] }),
  })
  const opts = { fs, stateDir: STATE_DIR, claudeHome: CLAUDE_HOME }
  markRunAtRisk({ sessionId: SESSION, markedAt: new Date().toISOString() }, opts)
  const { recovered } = harvestOrphanedRuns({ ...opts, skipSessionId: SESSION })
  assert.equal(recovered.length, 0, 'the live run’s own marker is left alone')
  assert.equal(readRunsAtRisk(opts).length, 1, 'and its marker survives for a later sweep')
}

// --- a marker with no surviving transcript is retired, not retried forever ----
{
  const fs = memfs()
  const opts = { fs, stateDir: STATE_DIR, claudeHome: CLAUDE_HOME }
  markRunAtRisk({ sessionId: 'ghost', markedAt: new Date().toISOString() }, opts)
  const { recovered, note } = harvestOrphanedRuns(opts)
  assert.equal(recovered.length, 0, 'nothing to recover')
  assert.equal(note, '', 'and nothing is narrated')
  assert.equal(readRunsAtRisk(opts).length, 0, 'the dead marker is swept')
}

// --- an ancient marker is swept without reading transcripts ------------------
{
  const fs = memfs({
    [transcriptPath(SESSION, 'a1')]: transcript('a1', { prompt: 'p', texts: ['stale work'] }),
  })
  const opts = { fs, stateDir: STATE_DIR, claudeHome: CLAUDE_HOME }
  markRunAtRisk({ sessionId: SESSION, markedAt: '2020-01-01T00:00:00.000Z' }, opts)
  const { recovered } = harvestOrphanedRuns(opts)
  assert.equal(recovered.length, 0, 'markers past the TTL are not reported')
  assert.equal(readRunsAtRisk(opts).length, 0, 'but they are still swept')
}

// --- narration is empty when there is nothing to say -------------------------
{
  assert.equal(renderHarvestNote([]), '', 'no recovery, no note')
  assert.equal(safeName('a/b\\c:d'), 'a-b-c-d', 'ids are made filename-safe')
}

// === wiring: the driver must actually narrate and mark, not just be able to ===

const ctx = { get: () => undefined, logger: { info: () => {}, warn: () => {} } }
const baseOptions = {
  provider: 'claude-code',
  sessionId: 'dsh-1',
  model: 'fable',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
}
// Numbers in the script act as delays (ms), so deadline behaviour is testable.
const mockQuery = (messages) => () =>
  (async function* () {
    for (const message of messages) {
      if (typeof message === 'number') {
        await new Promise((resolve) => setTimeout(resolve, message))
        continue
      }
      yield message
    }
  })()

async function run(settings, messages) {
  const chunks = []
  const merged = { resumeChain: false, queryImpl: mockQuery(messages), ...settings }
  for await (const chunk of streamClaudeChunks(ctx, baseOptions, merged)) chunks.push(chunk)
  return chunks
}

const textOf = (chunks) =>
  chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')

// --- last turn's orphans are delivered at the START of this turn --------------
{
  const fs = memfs({
    [transcriptPath('dead-session', 'a1')]: transcript('a1', {
      prompt: 'write the long report',
      texts: ['Writing the full report now.'],
    }),
  })
  const opts = { fs, stateDir: STATE_DIR, claudeHome: CLAUDE_HOME }
  markRunAtRisk({ sessionId: 'dead-session', markedAt: new Date().toISOString() }, opts)

  const chunks = await run({ harvestOptions: opts }, [
    { type: 'assistant', session_id: 's-new', message: { content: [{ type: 'text', text: 'fresh answer' }] } },
    { type: 'result', subtype: 'success', session_id: 's-new', result: 'fresh answer', usage: {} },
  ])
  const text = textOf(chunks)
  assert.match(text, /子代理随进程一起中断/, 'the salvage is narrated')
  assert.match(text, /Writing the full report now\./, 'and it carries what the dead subagent produced')
  assert.ok(text.indexOf('Writing the full report') < text.indexOf('fresh answer'), 'salvage lands before the new reply')
  assert.equal(readRunsAtRisk(opts).length, 0, 'the marker is consumed by the delivering turn')
}

// --- narration never counts as model text (must not mask an empty reply) ------
{
  const fs = memfs({
    [transcriptPath('dead-session', 'a1')]: transcript('a1', { prompt: 'p', texts: ['partial work'] }),
  })
  const opts = { fs, stateDir: STATE_DIR, claudeHome: CLAUDE_HOME }
  markRunAtRisk({ sessionId: 'dead-session', markedAt: new Date().toISOString() }, opts)

  const chunks = await run({ harvestOptions: opts }, [
    { type: 'result', subtype: 'success', session_id: 's-new', result: 'recovered reply', usage: {} },
  ])
  assert.match(textOf(chunks), /recovered reply/, 'an empty-text run still falls back to the result')
}

// --- live background work marks the run; a clean finish retires the marker ----
{
  const fs = memfs()
  const opts = { fs, stateDir: STATE_DIR, claudeHome: CLAUDE_HOME }
  await run({ harvestOptions: opts, backgroundTaskTimeoutMs: 50 }, [
    { type: 'system', subtype: 'background_tasks_changed', session_id: 'live-1', tasks: [{ task_id: 't1', description: 'report' }] },
    { type: 'result', subtype: 'success', session_id: 'live-1', result: 'done', usage: {} },
    { type: 'system', subtype: 'background_tasks_changed', session_id: 'live-1', tasks: [] },
    { type: 'system', subtype: 'task_notification', session_id: 'live-1', task_id: 't1', status: 'completed', summary: 'report' },
  ])
  assert.equal(readRunsAtRisk(opts).length, 0, 'a run whose tasks settled leaves nothing orphaned')
}

// --- a run that never settles leaves the marker behind for the next turn ------
{
  const fs = memfs()
  const opts = { fs, stateDir: STATE_DIR, claudeHome: CLAUDE_HOME }
  await run({ harvestOptions: opts, backgroundTaskTimeoutMs: 30 }, [
    { type: 'system', subtype: 'background_tasks_changed', session_id: 'stuck-1', tasks: [{ task_id: 't1', description: 'endless report' }] },
    { type: 'result', subtype: 'success', session_id: 'stuck-1', result: 'done', usage: {} },
    200,
  ])
  const left = readRunsAtRisk(opts)
  assert.equal(left.length, 1, 'the timed-out run stays marked')
  assert.equal(left[0].sessionId, 'stuck-1')
  assert.deepEqual(left[0].tasks, ['endless report'], 'the marker names what was still running')
}

console.log('test-agent-harvest: all assertions passed')
