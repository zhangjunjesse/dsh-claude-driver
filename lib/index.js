import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createClaudeCodeProvider } from './subagent-provider.js'
import { resetClaudeExecutableCache, resolveClaudeExecutable } from './claude-executable.js'
import { locateClaude } from './claude-executable.js'
import { createClaudeLoginCommand, createLoginManager, credentialEnvVar, isAuthFailureMessage } from './login.js'
import { applyClaudePriority, claudeProcessEnv, spawnPrioritized } from './claude-process.js'
import { createClaudeCodeAdapter, createModelDiscovery, withDiscoveryWarning } from './model-catalog.js'
import {
  BACKGROUND_DRAIN_MS,
  briefTaskSummary,
  MAX_TASK_SUMMARY_CHARS,
  openEndedPrompt,
  renderBackgroundNote,
  renderBackgroundNotes,
} from './background-tasks.js'
import { clearRunAtRisk, harvestOrphanedRuns, markRunAtRisk } from './agent-harvest.js'
import { createStallGuard } from './stall-guard.js'
import { ensureClaudeCli } from './deps.js'
import { createClaudeDoctorCommand } from './doctor.js'
export { createClaudeDoctorCommand }
import { renderClaudeEventNote, renderPulse } from './claude-events.js'
import { createTaskLedger } from './task-ledger.js'
import { dshCardFor, resultContentFor } from './builtin-cards.js'
export { dshCardFor }
import { createJobMirror } from './job-mirror.js'
import { currentSession, resolvePermissions } from './permission-sync.js'
import { readSessionEvents } from './session-log.js'
import { attachSteering } from './steering.js'
export { readSessionEvents }
import { forgetNativeCompaction, noteTurnRan, runNativeCompaction, wasNativelyCompacted } from './native-compact.js'
import { claudeUsage, registerUsageRoute } from './claude-usage.js'
import { claudeSessionStatsProjection, persistUsageRecord, usageRecordFor } from './claude-session-stats.js'
import {
  formatStopNotice,
  normalizeStopPercent,
  pauseGoalForStop,
  sessionIdFor,
  usageGuard,
  watchStopCompaction,
} from './usage-guard.js'
export { usageGuard } from './usage-guard.js'

// Claude Code totals fold from the turn records persisted in the session log.
function registerSessionStatsProjection(ctx) {
  ctx.sessionProjections.register(claudeSessionStatsProjection)
}

async function persistTurnUsage(ctx, options, result, requests) {
  const session = currentSession(ctx)
  if (!options?.sessionId || session?.id !== options.sessionId) return false
  return persistUsageRecord(usageRecordFor(result, requests), { session })
}

// Re-exported for existing consumers (tests, other lib modules) that import
// these from here — the implementations now live in background-tasks.js
// (shared with subagent-provider.js) so both `query()` call sites spare
// Claude Code's own background tasks the same way; see that module's header
// comment for the three preconditions this exists to satisfy.
export { briefTaskSummary, MAX_TASK_SUMMARY_CHARS, openEndedPrompt, renderBackgroundNote, renderBackgroundNotes }

export const name = 'claude-driver'

// Claude Code's built-in question tool (camelCase `multiSelect` schema) vs
// DSH's own bridged tool (snake_case `multi_select`). Only the latter has a
// renderer on the DSH side — see DEFAULTS.disableBuiltinAskUserQuestion.
export const BUILTIN_ASK_USER_QUESTION = 'AskUserQuestion'

// DSH feature (bridged tool) -> the Claude Code built-ins that duplicate it.
// On a claude-code turn the DSH feature is the source of truth (DSH renders,
// persists and governs it), so the duplicate is withheld while it is bridged.
export const DSH_OWNED_BUILTINS = Object.freeze({
  exit_plan_mode: ['EnterPlanMode', 'ExitPlanMode'],
  schedule_create: ['CronCreate', 'CronList', 'CronDelete'],
  todo_write: ['TodoWrite'],
  web_search: ['WebSearch'],
  web_fetch: ['WebFetch'],
})
export const ASK_USER_QUESTION_TOOL = 'ask_user_question'

// Tools DSH itself ships (base + web bundles). bridgeTools:'plugins' bridges
// everything outside this set, so Claude Code's own built-ins stay the only
// core toolset and their DSH twins are not re-sent as MCP schemas. Unknown
// names bridge by default; add new base tools through coreTools instead.
export const DSH_CORE_TOOLS = Object.freeze([
  'ask_user_question',
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image',
  'present', 'skill', 'todo_write', 'web_search', 'web_fetch',
  'working_directory', 'workflow', 'plugin_manager',
  'job_list', 'job_output', 'job_kill',
  'list_agents', 'send_message', 'wait_agent',
  'subagent', 'subagent_fork', 'list_subagent_models',
  'create_goal', 'get_goal', 'update_goal',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
])

const DEFAULTS = {
  provider: 'claude-code',
  model: 'sonnet',
  // Unset on purpose: the Claude permission mode follows the DSH session's
  // sandbox mode (see permission-sync.js). Set it to pin a mode explicitly.
  permissionMode: undefined,
  followDshPermissions: true,
  // Interactive-session ceiling for Claude Code's internal tool loop. 12 keeps
  // chat turns responsive; raise per-route via config for heavy agentic work.
  maxTurns: 100,
  // Scheduling priority for every Claude Code CLI process (turns, prewarm,
  // discovery, subagents, login, probes). 19 is the lowest priority, so model
  // work yields to the rest of the machine; false keeps the host default.
  nice: 19,
  // 'medium' keeps extended thinking short for chat responsiveness; users can
  // still pick 'high'/'max' in the session UI or via patch config.
  effort: 'medium',
  // No default proxy: a baked-in address nobody listens on makes the CLI retry
  // the API forever (silent hang). Set it per machine in your profile patch.
  proxy: undefined,
  allowedTools: undefined,
  // Extra tool names to withhold from Claude Code, merged with the built-in
  // AskUserQuestion suppression below.
  disallowedTools: undefined,
  // Withhold Claude Code's BUILT-IN `AskUserQuestion` tool.
  //
  // The CLI gates that tool on "does this host have an interactive surface?",
  // and it answers that question by looking for a `canUseTool` callback — which
  // this driver installs on every turn that bridges any DSH tool (see below).
  // Measured 2026-09-16 (CLI 2.1.258 / SDK 0.3.260, one variable changed):
  // bare query -> 29 tools, no AskUserQuestion; + canUseTool -> 32 tools, WITH
  // AskUserQuestion; + disallowedTools:['AskUserQuestion'] -> 31, gone again.
  //
  // But `canUseTool` can only answer allow/deny — it cannot RENDER a
  // multiple-choice card. So the CLI parks the dialog for a host that will
  // never display it and, on expiry, hands the model
  // "The user did not answer the questions." Worse, the whole episode is
  // INVISIBLE in DSH: native cards are emitted only for bridged DSH tools
  // (buildToolBridge.rendersCard keys on bridgedNames) and the built-in text
  // fallback `showToolProgress` is off by default — so nothing at all reaches
  // the GUI and the user cannot tell a swallowed question from a hang.
  //
  // DSH's own `ask_user_question` tool does render a real card, so the fix is
  // to withhold the broken built-in and let the model fall back to it. GUARDED:
  // the suppression applies ONLY when that DSH tool is actually bridged this
  // turn, otherwise withholding it would leave the model with no way to ask at
  // all. bridgeTools:'plugins' keeps it bridged through bridgeToolNames.
  disableBuiltinAskUserQuestion: true,
  // Narrate FAILED built-in tool results (including the swallowed-dialog case
  // above) as one text line. Built-ins render no native card and the
  // `showToolProgress` fallback is off by default, so without this a failed
  // built-in round-trip leaves no trace at all in the GUI.
  narrateBuiltinToolErrors: true,
  cwd: undefined,
  pathToClaudeCodeExecutable: undefined,
  // AUTH failure (expired/missing Claude login): run `claude auth login`, show the
  // URL, retry the turn once. false = only append a /claude-login hint.
  autoLogin: true,
  loginWaitMs: 5 * 60_000,
  // Session model-picker catalog (advisory; strings or {id,name,description,contextWindow,maxTokens}).
  // contextWindow is REQUIRED for DSH automatic compaction to work on this
  // route: dsh-compaction-basic's pressure path reads
  // resolveModelInfo().context.contextWindow and throws
  // TargetPressureConfigError (degraded to a warn, i.e. compaction silently
  // off) when it is absent. Values below are the REAL windows reported by
  // Claude Code itself (query.getContextUsage().rawMaxTokens, probed
  // 2026-08-20): all four aliases=1M (re-probed 2026-10-28, SDK 0.3.312). The previous
  // uniform 200k inflated the DSH context percentage ~5x for fable/sonnet/opus.
  // Left unset on purpose: names, versions and context windows come from Claude
  // Code's own supportedModels(), so new releases need no plugin change. Set it
  // only to pin/rename entries; explicit values always win over discovery.
  models: undefined,
  // Reasoning-effort vocabulary offered in the picker; `effort` above is the default level.
  efforts: ['low', 'medium', 'high', 'max'],
  displayName: 'Claude Code',
  // Set false to skip the catalog-adapter registration (picker visibility off).
  registerCatalog: true,
  // Auto-build the picker catalog from Claude's own supportedModels() list so
  // new model families/versions appear without editing the plugin or config.
  // Discovery is lazy + cached and falls back to `models`/defaults on failure.
  autoDiscoverModels: true,
  // Namespace key for llm.registerModelDiscovery (settings Models page discovery).
  settingsNs: 'claude-driver',
  // Five-hour plan-window guard: at `usageStopPercent` (default 95%) every
  // Claude turn in this host stops at its next safe boundary and no new turn
  // runs until the window resets; the live session is compacted once after the
  // stop. false disables it. The quota is account-wide, so the latch is too.
  usageStopPercent: 95,
  // Compact the live Claude session once after a stop (native /compact).
  usageStopCompaction: true,
  // Reuse the Claude Code session across steps of the same DSH session
  // (query({options:{resume}})) so follow-up turns skip the cold boot and only
  // send the new user tail. Mapping lives in-process; a DSH restart clears it
  // and the next turn pays one fresh boot (expected).
  resumeChain: true,
  // Pre-boot the NEXT turn's Claude Code CLI while the user is still reading
  // this turn's answer, so their next message skips the CLI's local
  // initialization entirely.
  //
  // Why this exists: every turn spawns a fresh CLI process, and its LOCAL
  // bootstrap costs ~3.5-4s before any network request is made (measured
  // 2026-09-16: init frame at 3.56s with the API pointed at a black-hole
  // address, i.e. zero network; identical on fresh vs resume; identical on
  // CLI 2.1.234 and 2.1.260). Prewarm spawns the next turn's process with
  // `resume` + an OPEN streaming input right after a turn completes; the
  // arriving user message is then PUSHED into the standing process. Probe:
  // push→result 4.9s prewarmed vs 8.5s cold on the same session (-3.6s).
  //
  // The adopted process must match the arriving turn (same resume id, model,
  // effort, bridged tool set) — any mismatch, death, or TTL expiry falls back
  // to the exact cold path, so the worst case is today's behaviour. Requires
  // waitForBackgroundTasks (the open-input transport). Default OFF while the
  // feature is being field-validated.
  prewarm: false,
  // How long an idle prewarmed process is kept before being killed (the user
  // may simply stop chatting; an unadopted CLI must not linger forever).
  prewarmTtlMs: 900000,
  // Token-level streaming (includePartialMessages) so text/thinking render as
  // they are generated instead of per completed block.
  partialStream: true,
  // Ask the CLI for API-side thinking SUMMARIES (`--thinking-display`).
  //
  // Current-generation models (Sonnet 4.6 / Fable class) stream REDACTED
  // thinking by default: `thinking_delta` frames arrive, but `delta.thinking`
  // is the EMPTY STRING — the API sends only pings plus an `estimated_tokens`
  // running total (sdk.d.ts SDKThinkingTokensMessage: "during the
  // redacted-thinking phase (where the API otherwise streams only pings)").
  // The driver's reasoning path keys on non-empty text, so without this flag a
  // turn that burned 650 thinking tokens emitted ZERO reasoning deltas and the
  // GUI had no reasoning block to render — the user saw only the generic
  // spinner with no way to tell thinking from a hang.
  //
  // Measured 2026-09-16 (CLI 2.1.258 / SDK 0.3.260 / sonnet, effort=high, same
  // prompt): default -> 6 thinking_delta frames, 0 chars of text;
  // `--thinking-display summarized` -> 39 frames, 357 chars. NOTE the inline
  // `settings: { showThinkingSummaries: true }` query option was probed too and
  // does NOT work (0 chars) — the CLI flag is the only lever that does.
  //
  // 'summarized' (default) requests summaries; 'omitted' suppresses them;
  // null/false leaves the CLI's own default untouched.
  thinkingDisplay: 'summarized',
  // Fallback liveness signal for the redacted-thinking phase: when a turn
  // thinks but no summary text is available, surface the CLI's
  // `system/thinking_tokens` progress frames (which the driver otherwise
  // ignored entirely) as a growing dot line inside the reasoning block, so a
  // long silent think is visibly alive rather than indistinguishable from a
  // stall. Suppressed automatically as soon as real thinking text shows up.
  thinkingHeartbeat: true,
  // Emit a lightweight text-delta progress line for every internal tool_use
  // Claude Code performs (SDK does not stream those otherwise). Bridged DSH
  // tools already render native cards and Claude Code narrates in its own text,
  // so this narration is redundant noise by default — disable with
  // showToolProgress:false (it is already off by default).
  showToolProgress: false,
  // Compact activity line for Claude Code's BUILT-IN tools (Bash/Read/WebFetch/
  // …), naming the tool AND its subject.
  //
  // Built-ins render no native card (nativeToolCards covers bridged DSH tools
  // only) and `showToolProgress` — the sole existing fallback — is off by
  // default, so a turn that spends a minute in Bash/WebFetch looks identical to
  // a hang: the fix for redacted thinking (thinkingHeartbeat) made the THINKING
  // phase visible, but left the TOOL phase a black box. Unlike
  // showToolProgress's bare "正在调用工具 Bash…", this carries the subject
  // (`Bash · npm test`, `Read · lib/index.js`), which is what makes the line
  // worth its screen space rather than noise.
  //
  // Bridged DSH tools are skipped (their card already says it). When
  // showToolProgress is ON it wins for every tool, so the legacy narration
  // stays byte-identical and the two never double up.
  narrateBuiltinTools: true,
  // WHERE driver narration about built-in tools goes: 'reasoning' (default)
  // appends the activity lines and error notes to the collapsible thinking
  // block, 'text' interleaves them with the model's answer (pre-0.7.0
  // behaviour). Reasoning is the default because interleaving turned out to
  // read as noise: the [Claude Code] ⚙ lines were glued into the middle of the
  // prose (observed in the field 2026-09-16). The legacy showToolProgress
  // narrator is exempt — when explicitly enabled it keeps its historical
  // text-channel output byte-for-byte.
  toolNarrationChannel: 'reasoning',
  // Native DSH tool cards for bridged tools: around every bridged
  // tools.execute, append the same durable `tool/call` + `tool/result`
  // session-event pair the DSH agent loop writes for its own scheduled calls
  // (dsh-agent-loop appendToolCall/appendToolResult, lib/index.js:292-317), so
  // the GUI renders native tool cards instead of the text progress line.
  // Research verdict: safe to write mid-model-step — the session invariant
  // (dsh-session invariant.js:58-79) only requires the named turn/step to be
  // the open one and the result to cite a pending callId via
  // sourceEventSeqs; the conversation UI keys cards purely on callId; no
  // consumer anchors tool events to the assistant message. Text progress
  // (showToolProgress) remains the fallback for Claude built-in tools and for
  // contexts without an appendable session. Disable with nativeToolCards:false.
  nativeToolCards: true,
  // Which DSH tools cross the MCP bridge. true bridges all of them (legacy),
  // 'plugins' bridges only tools outside DSH_CORE_TOOLS so Claude Code's own
  // built-ins stay the single core toolset and their DSH twins are no longer
  // re-sent as MCP schemas, false bridges none. Built-ins still render as DSH
  // cards (builtinToolCards), so the card/approval surface is unchanged.
  bridgeTools: true,
  // Override the core exclusion list for bridgeTools:'plugins'.
  coreTools: undefined,
  // Names bridged even when they are DSH core tools. ask_user_question stays
  // bridged by default because the built-in AskUserQuestion cannot render in
  // DSH (canUseTool can only allow or deny).
  bridgeToolNames: ['ask_user_question'],
  // System prompt for a claude-code turn. 'full' (default) appends DSH's
  // assembled prompt and every system-role message; 'user' appends only the
  // operator instruction files; 'none' appends nothing, leaving Claude Code's
  // own preset untouched.
  systemPromptMode: 'full',
  // Absolute files for 'user' mode. Default: ~/.dsh/AGENTS.md plus AGENTS.md in
  // the workspace directory and its parents (64 KiB cap).
  userPromptFiles: undefined,
  // The Claude Code CLI binary normally arrives with the SDK (an optional
  // dependency), but installs with `--omit=optional`, a pruned store, or an
  // unsupported libc leave it missing. On load (in the background) and before a
  // turn that has none, the driver LOOKS for a usable CLI first (configured
  // path, SDK-bundled, previous private install, ~/.local/bin, PATH) and only
  // when none exists installs the SDK-pinned platform package into its own
  // prefix under $DSH_HOME/storages/claude-driver/cli. Never global, never sudo,
  // never an npm install script. false = report only; use /claude-doctor install.
  autoInstallCli: true,
  // Claude Code's OWN background tasks (Bash run_in_background, backgrounded
  // subagents/workflows) live inside the CLI process this driver spawns for the
  // step. Measured on SDK 0.3.252: a 15s background task started by the model is
  // killed ~3-5s after the run's `result`, so a task the model reported as
  // "running in the background" silently dies and its output is never
  // collected. Sparing it requires ALL THREE of: streaming input (stdin stays
  // open — the string `prompt` form is a one-shot run the CLI fails closed on),
  // `perTaskStopAffordance`, and not tearing the session down while tasks are
  // live. With this on the driver does exactly that and holds the DSH step open
  // until the tasks settle (validated: task ran 15/15 with `NOTIF=completed`).
  // Set false to restore the previous one-shot behaviour verbatim.
  waitForBackgroundTasks: true,
  // Upper bound (ms) on that hold, so a runaway task cannot pin a chat turn
  // open forever. On expiry the step finishes and the note names the tasks that
  // were still running; the caller's abort signal also releases the wait.
  backgroundTaskTimeoutMs: 300000,
  // Recover subagents that died with a previous run's CLI process (caller
  // abort, DSH disconnect/restart, or an outright kill — none of which the hold
  // above can help with). At the start of each run the driver sweeps leftover
  // write-ahead markers, pulls each dead subagent's last assistant text out of
  // its on-disk transcript, writes a report under
  // $DSH_HOME/storages/claude-driver/recovered/, and narrates one line naming
  // it. Read-only with respect to the run itself; set false to disable.
  harvestOrphanedSubagents: true,
  // Bridge Claude built-in tools (Bash/Edit/Write/WebFetch/…) into DSH's
  // approval service (approval.request → the "拒绝/允许一次" card). Default
  // false: the DSH approval wire schema only supports one-shot grants, so
  // every Bash call would raise a fresh prompt — opt in per deployment.
  approveBuiltinTools: false,
  // Read-only built-ins that skip the approval prompt even when
  // approveBuiltinTools is on (prompt-fatigue control). Override via config.
  builtinAllowlist: ['Read', 'Grep', 'Glob'],
}

// DSH sessionId -> Claude Code session_id, for the resume chain. Module-level
// on purpose: survives across llm/stream calls, cleared on process restart.
const resumeSessions = new Map()

// ---------------------------------------------------------------------------
// Prewarm pool: chainKey -> a standing, already-booted CLI process waiting for
// the conversation's next user message (see DEFAULTS.prewarm). Module-level
// like resumeSessions; a DSH restart clears it and the children die with the
// host (their stdin pipe closes).
// ---------------------------------------------------------------------------

const prewarmPool = new Map()
// At most this many standing processes across ALL conversations; oldest wins
// eviction. Each one is a full CLI process, so the cap is deliberately tiny.
const PREWARM_POOL_MAX = 2

// Test/diagnostic access (do not mutate in production).
export function getPrewarmPool() {
  return prewarmPool
}

// A pushable open-ended prompt: yields nothing until push(), then stays open
// (same contract as openEndedPrompt, which waitForBackgroundTasks relies on).
// close() ends the iterable — the CLI reads it as stdin EOF and exits; this is
// half of disposal. The other half is controller.abort(): NEVER dispose via
// iterator.return() on the SDK query — with an open input iterable that call
// parks behind a next() that will never resolve (measured: it hangs forever).
export function pushableInput() {
  const queue = []
  let notify = null
  let closed = false
  const wake = () => {
    if (notify) {
      const fn = notify
      notify = null
      fn()
    }
  }
  return {
    push(message) {
      if (closed) return
      queue.push(message)
      wake()
    },
    close() {
      closed = true
      wake()
    },
    iterable: (async function* () {
      while (true) {
        while (queue.length) yield queue.shift()
        if (closed) return
        await new Promise((resolve) => {
          notify = resolve
        })
      }
    })(),
  }
}

// Model/effort resolution shared by the live call and the prewarm compat
// check — MUST stay in lockstep with what buildSdkOptions is handed.
export function resolveModelEffort(options, settings) {
  return {
    model: (typeof options?.model === 'string' && options.model) || settings.model,
    effort: (typeof options?.reasoningEffort === 'string' && options.reasoningEffort) || settings.effort,
  }
}

// Fingerprint of the system prompt a prewarmed process was spawned with.
export function systemPromptKey(options, settings = {}, ctx) {
  return systemPromptText(options, settings, ctx)
}

// Canonical fingerprint of the DSH tool set offered to a turn. The bridged MCP
// server is frozen at spawn, so a prewarmed process is only adoptable by a
// turn offering the exact same tools.
export function toolSetKey(options) {
  const tools = Array.isArray(options?.tools) ? options.tools : []
  return tools
    .map((schema) => schema?.name)
    .filter((name) => typeof name === 'string')
    .sort()
    .join(',')
}

// Spawn the standing process for a conversation's anticipated next turn.
// Called at the END of a successful run, still inside the llm/stream call —
// which matters: buildToolBridge captures agents.currentInitiator() as its
// card-agent fallback, and here that is still this conversation's agent.
export function createPrewarmEntry(ctx, options, settings, { chainKey, resumeId }) {
  const controller = new AbortController()
  const input = pushableInput()
  const { model, effort } = resolveModelEffort(options, settings)
  const bridge = buildToolBridge(ctx, options, settings, controller)
  const sdkOptions = buildSdkOptions(ctx, options, settings, {
    resumeId,
    controller,
    bridge,
    model,
    effort,
    waitForBackground: true,
  })
  const runQuery = typeof settings.queryImpl === 'function' ? settings.queryImpl : query
  const q = runQuery({ prompt: input.iterable, options: sdkOptions })
  const entry = {
    chainKey,
    resumeId,
    model,
    effort,
    toolKey: toolSetKey(options),
    systemKey: systemPromptKey(options, settings, ctx),
    permissionMode: sdkOptions.permissionMode,
    query: q,
    controller,
    input,
    bridge,
    buffer: [],
    waiters: [],
    ended: false,
    error: undefined,
    disposed: false,
    timer: undefined,
    dispose(reason) {
      if (entry.disposed) return
      entry.disposed = true
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      // Input EOF first (clean CLI exit), abort as the backstop kill.
      try {
        input.close()
      } catch {}
      try {
        controller.abort()
      } catch {}
      // Release anyone streaming this entry. The SDK query does NOT reliably
      // terminate its iterator on abort (the same hazard that rules out
      // `iterator.return()` here — see CHANGELOG [0.6.0]), so the pump can stay
      // parked forever; a consumer waiting on it would then hang instead of
      // failing. Killing the transport out from under a live turn is always a
      // bug, but it must surface as an error in seconds, never as a silent
      // spinner.
      if (!entry.ended) {
        entry.ended = true
        entry.error =
          entry.error ?? new Error(`claude-driver: prewarmed session disposed mid-stream: ${reason}`)
        entry.waiters.splice(0).forEach((fn) => fn())
      }
      ctx?.logger?.info?.(`claude-driver: prewarmed session (resume ${resumeId}) disposed: ${reason}`)
    },
  }
  // Background pump: buffers every SDK message so adoption can replay them in
  // order, and doubles as the death detector (a child that exits or errors
  // while idling marks the entry unusable instead of surprising the adopter).
  ;(async () => {
    try {
      for await (const msg of q) {
        entry.buffer.push(msg)
        entry.waiters.splice(0).forEach((fn) => fn())
      }
    } catch (error) {
      entry.error = error
    } finally {
      entry.ended = true
      entry.waiters.splice(0).forEach((fn) => fn())
    }
  })()
  return entry
}

// The adopted entry's message stream, same shape the main loop's `for await`
// expects from a live SDK query. Buffered messages first (normally none — the
// CLI sends nothing before its first input), then live pumped ones.
export function prewarmMessages(entry) {
  return (async function* () {
    let i = 0
    while (true) {
      while (i < entry.buffer.length) yield entry.buffer[i++]
      if (entry.ended) {
        if (entry.error) throw entry.error
        return
      }
      await new Promise((resolve) => entry.waiters.push(resolve))
    }
  })()
}

// Whether a standing prewarmed process can serve the arriving turn: alive, and
// spawned for exactly this resume id, model, effort, bridged tool set and
// permission mode (a mode is fixed at spawn, so a DSH permission switch since
// then makes the process unusable).
export function prewarmAdoptable(candidate, expected) {
  return (
    !candidate.disposed &&
    !candidate.ended &&
    candidate.resumeId === expected.resumeId &&
    candidate.model === expected.model &&
    candidate.effort === expected.effort &&
    candidate.toolKey === expected.toolKey &&
    (expected.systemKey === undefined || candidate.systemKey === expected.systemKey) &&
    candidate.permissionMode === expected.permissionMode
  )
}

// Remove-and-return, so two concurrent calls can never adopt the same process.
//
// Leaving the pool ALWAYS disarms the idle TTL. That timer measures how long an
// UNADOPTED process has been loitering; once the entry is out of the pool it is
// either the live transport of an in-flight turn or about to be disposed, and
// in the first case letting the deadline fire would close the input stream and
// abort the CLI *mid-answer*. Observed in the wild (2026-09-17): a process
// prewarmed at 09:39:56 was adopted at 09:51:58 and killed at 09:54:56 by its
// original 15-minute deadline, leaving the turn to spin for ~50 minutes.
export function takePrewarm(chainKey, pool = prewarmPool) {
  if (chainKey === undefined) return undefined
  const entry = pool.get(chainKey)
  if (entry !== undefined) {
    pool.delete(chainKey)
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }
  return entry
}

export function disposePrewarm(chainKey, reason, pool = prewarmPool) {
  const entry = takePrewarm(chainKey, pool)
  entry?.dispose(reason)
}

// End-of-turn hook. Failure here must never damage the turn that just
// succeeded, so everything is caught and reduced to a warn.
export function maybeCreatePrewarm(ctx, options, settings, chainKey, resumeId, pool = prewarmPool) {
  if (settings?.prewarm !== true) return
  // The open-input transport is what keeps the standing process feedable.
  if (settings?.waitForBackgroundTasks === false) return
  try {
    disposePrewarm(chainKey, 'replaced by a newer turn', pool)
    while (pool.size >= PREWARM_POOL_MAX) {
      const oldestKey = pool.keys().next().value
      disposePrewarm(oldestKey, 'pool capacity', pool)
    }
    const entry = createPrewarmEntry(ctx, options, settings, { chainKey, resumeId })
    pool.set(chainKey, entry)
    const ttl = Number(settings.prewarmTtlMs ?? DEFAULTS.prewarmTtlMs)
    entry.timer = setTimeout(() => {
      if (pool.get(chainKey) === entry) pool.delete(chainKey)
      entry.dispose('idle TTL expired')
    }, ttl)
    entry.timer?.unref?.()
    ctx?.logger?.info?.(`claude-driver: prewarmed the next Claude session (resume ${resumeId}) for ${chainKey}`)
  } catch (error) {
    ctx?.logger?.warn?.(`claude-driver: prewarm failed (next turn boots cold): ${String(error?.message ?? error)}`)
  }
}

// Test/diagnostic access to the resume chain (do not mutate in production).
export function getResumeSessions() {
  return resumeSessions
}

// One session/event observation: a committed compaction summary invalidates
// the session's resume mapping (the Claude-side context predates the
// compaction). Returns whether a mapping was actually dropped. `sessions` is
// injectable for tests; production uses the module-level map.
export function clearResumeOnCompaction(session, event, sessions = resumeSessions, pool = prewarmPool) {
  if (event?.type !== 'compaction/summary') return false
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || !sessionId) return false
  // Claude already compacted this exact session natively, and the summary DSH is
  // committing is Claude's: keep resuming it.
  if (wasNativelyCompacted(sessionId, sessions.get(sessionId))) {
    disposePrewarm(sessionId, 'compaction changed the Claude session context', pool)
    return false
  }
  forgetNativeCompaction(sessionId)
  // A standing prewarmed process resumes the PRE-compaction Claude session, so
  // it dies with the mapping.
  disposePrewarm(sessionId, 'compaction invalidated the resume chain', pool)
  return sessions.delete(sessionId)
}

// /claude-fresh command definition (dsh-commands register contract: name must
// match /^[a-z][a-z0-9_-]*$/, non-empty description, handler receiving the
// frozen {commandId, agent, rawInput, signal} invocation and returning a
// CommandResult {kind:'success'|'error', text}).
export function createClaudeFreshCommand(sessions = resumeSessions, pool = prewarmPool) {
  return {
    name: 'claude-fresh',
    description: 'Start a fresh Claude Code session on the next turn (drop the resume chain)',
    handler(invocation) {
      const sessionId = invocation?.agent?.session?.id
      if (typeof sessionId !== 'string' || !sessionId) {
        return { kind: 'error', text: 'claude-fresh: no session is attached to this command invocation.' }
      }
      disposePrewarm(sessionId, 'user requested a fresh session', pool)
      const dropped = sessions.delete(sessionId)
      return {
        kind: 'success',
        text: dropped
          ? 'Claude Code resume chain cleared. The next turn starts a fresh Claude Code session and replays the (possibly compacted) conversation history.'
          : 'No Claude Code resume session recorded for this conversation; the next turn already starts fresh.',
      }
    },
  }
}

// Internal LLM calls that must not touch (or ride on) the user-facing chain.
const INTERNAL_PURPOSES = new Set(['compaction', 'session-title'])

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  // approveBuiltinTools relies on the CLI actually consulting canUseTool;
  // bypassPermissions (and the legacy dontAsk) skip the permission bridge
  // entirely, so the combination silently disables the DSH approval path.
  if (settings.approveBuiltinTools === true && ['bypassPermissions', 'dontAsk'].includes(settings.permissionMode)) {
    ctx.logger?.warn?.(
      `claude-driver: approveBuiltinTools is on but permissionMode "${settings.permissionMode}" never consults canUseTool — built-in tools will NOT reach DSH approval`,
    )
  }
  // Dependency check, once, in the background: look for the Claude Code CLI and
  // install it only if it is absent. Never blocks load and never throws.
  if (settings.checkCliOnLoad !== false) {
    void (async () => {
      try {
        const r = await (settings.ensureCli ?? ensureClaudeCli)(depsCheckOptions(settings))
        if (r.action === 'installed') {
          resetClaudeExecutableCache()
          ctx.logger?.info?.(`claude-driver: installed the Claude Code CLI ${r.version ?? ''} at ${r.path}`)
        } else if (r.action === 'failed') {
          ctx.logger?.warn?.(`claude-driver: the Claude Code CLI is missing and could not be installed: ${r.error}. Run /claude-doctor install.`)
        } else if (r.action === 'skipped' && r.reason !== 'recent-failure') {
          ctx.logger?.warn?.(`claude-driver: the Claude Code CLI is missing (${r.reason}). Run /claude-doctor install.`)
        }
      } catch (error) {
        ctx.logger?.warn?.(`claude-driver: dependency check failed: ${String(error?.message ?? error)}`)
      }
    })()
  }

  ctx.on('llm/stream', (options, next) => {
    if (options?.provider !== settings.provider) return next()
    return streamClaudeChunks(ctx, options, settings)
  }, { global: true })

  // Resume-chain hygiene: when DSH compaction lands on a session
  // (`compaction/summary`, the committed-summary record dsh-compaction-basic
  // appends; dsh-session lists it in the event vocabulary), the DSH surface
  // just shrank — but a resumed Claude Code session would still carry the full
  // pre-compaction context. Drop the resume mapping so the next turn boots a
  // fresh Claude session over the compacted derived history (renderPrompt
  // replays it in full). Listener args are (session, event), exactly what
  // dsh-session's append() publishes on the `session/event` firehose.
  ctx.on('session/event', (session, event) => {
    if (clearResumeOnCompaction(session, event)) {
      ctx.logger?.info?.(`claude-driver: compaction landed on session ${session.id}; the next turn starts a fresh Claude Code session over the compacted history`)
    }
  }, { global: true })

  // Manual escape valve: /claude-fresh drops the current session's resume
  // mapping on demand. Registered via a scoped inject fiber for the same
  // late-service reason as the subagent provider below; dsh-command-compact
  // (the shipped /compact) is the registration template.
  const registerCommands = (scopedCtx) => {
    try {
      const commands = scopedCtx.get('commands')
      if (!commands || typeof commands.register !== 'function') {
        ctx.logger?.warn?.('claude-driver: commands service unavailable; /claude-fresh not registered')
        return
      }
      commands.register(createClaudeFreshCommand())
      commands.register(createClaudeLoginCommand(loginManagerFor(settings)))
      commands.register(createClaudeDoctorCommand({ depsOptions: { ...(settings.depsOptions ?? {}), explicit: settings.pathToClaudeCodeExecutable, nice: settings.nice }, ensureCli: settings.ensureCli }))
      ctx.logger?.info?.('claude-driver: registered /claude-fresh, /claude-login and /claude-doctor commands')
    } catch (error) {
      ctx.logger?.warn?.('claude-driver: failed to register /claude-fresh', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], registerCommands)
  } else {
    registerCommands(ctx)
  }
  if (typeof ctx.inject === 'function') ctx.inject(['sessionProjections'], registerSessionStatsProjection)

  // Host-plane subagent backend filling the seam reserved by the shipped
  // `tool-subagent-claude-code` row (product providers are host singletons).
  //
  // Timing: this row may activate before the row providing the `subagents`
  // service. `ctx.get()` is strict (returns undefined unless the providing
  // fiber is active) and cordis only re-evaluates fibers that declare the
  // service in `inject` (reflect.notify skips everyone else), so a bare
  // `ctx.get()` at apply-time silently misses a late-arriving service forever.
  // Register inside a scoped `ctx.inject()` child fiber instead — it waits for
  // the service and re-runs if the service is ever re-provided. This mirrors
  // the shipped dsh-subagent-spawn-in-process host row (`inject: ['subagents']`).
  const registerSubagentProvider = (scopedCtx) => {
    try {
      const subagents = scopedCtx.get('subagents')
      if (!subagents) {
        ctx.logger?.warn('claude-driver: subagents service unavailable; claude-code subagent provider not registered')
        return
      }
      if (subagents.getProvider('claude-code') !== undefined) {
        ctx.logger?.info('claude-driver: a "claude-code" subagent provider is already registered; skipping')
        return
      }
      subagents.registerProvider(createClaudeCodeProvider(settings, ctx))
      ctx.logger?.info('claude-driver: registered "claude-code" subagent provider')
    } catch (error) {
      ctx.logger?.warn('claude-driver: failed to register "claude-code" subagent provider', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    if (ctx.get('subagents') === undefined) {
      ctx.logger?.warn('claude-driver: subagents service not yet available; deferring claude-code provider registration until it is provided')
    }
    ctx.inject(['subagents'], registerSubagentProvider)
  } else {
    // Standalone/mock contexts (tests) have no cordis registry mixin.
    registerSubagentProvider(ctx)
  }

  // Session model-picker visibility. The picker catalog (session.models RPC ->
  // buildModelCatalog) lists only routes with a registered llm adapter, and
  // session.selectModel / the turn-start routeServed() guard require one too.
  // Streaming is unaffected: llm.stream()/prepareCall().stream() run the
  // `llm/stream` waterfall first, where the listener above short-circuits into
  // the Claude Agent SDK — the catalog adapter's stream() never executes.
  const registerModelCatalog = (scopedCtx) => {
    if (settings.registerCatalog === false) return
    try {
      const llm = scopedCtx.get('llm')
      if (!llm || typeof llm.registerAdapter !== 'function') {
        ctx.logger?.warn('claude-driver: llm service unavailable; claude-code will not appear in the model selector')
        return
      }
      // Auto-discovery: build the catalog from Claude's own supportedModels()
      // (lazy + cached in the adapter), unless explicitly disabled.
      const discover =
        settings.autoDiscoverModels === false
          ? undefined
          : withDiscoveryWarning(() => discoverClaudeModels(ctx, settings), ctx.logger)
      if (llm.listProviders().some((entry) => entry.id === settings.provider)) {
        ctx.logger?.info(`claude-driver: an adapter already serves provider "${settings.provider}"; skipping catalog registration`)
      } else {
        llm.registerAdapter([settings.provider], createClaudeCodeAdapter(settings, discover))
        ctx.logger?.info(`claude-driver: registered "${settings.provider}" model catalog (autoDiscoverModels=${settings.autoDiscoverModels !== false})`)
      }
      if (typeof llm.registerModelDiscovery === 'function') {
        try {
          llm.registerModelDiscovery(settings.settingsNs, createModelDiscovery(settings, discover))
        } catch (error) {
          ctx.logger?.warn(`claude-driver: model discovery for "${settings.settingsNs}" not registered`, error)
        }
      }
    } catch (error) {
      ctx.logger?.warn('claude-driver: failed to register the claude-code model catalog', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], registerModelCatalog)
  } else {
    registerModelCatalog(ctx)
  }

  // Compaction after a usage stop needs the same session/event firehose the
  // resume-chain hygiene above uses, plus the compaction service.
  watchStopCompaction(ctx, settings)

  if (typeof ctx.inject === 'function') registerUsageRoute(ctx, claudeUsage, settings.provider)
}

function envWithProxy(proxy) {
  return claudeProcessEnv({ proxy })
}

function resolveCwd(ctx, settings) {
  if (settings.cwd) return settings.cwd
  try {
    const agents = ctx.get('agents')
    const agent = agents?.currentInitiator?.()
    const cwd = agent?.session?.meta?.cwd ?? agent?.options?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  } catch {
    // optional service missing or wrong shape — fall through
  }
  return process.cwd()
}

// Lazy model discovery: ask Claude for its supported model list via the SDK
// control method supportedModels(). No user prompt is consumed — it is a
// control request, so it never runs a model turn. Returns the SDK ModelInfo[]
// or throws (callers fall back to the configured/default catalog).
export async function discoverClaudeModels(ctx, settings) {
  const runQuery = typeof settings.queryImpl === 'function' ? settings.queryImpl : query
  const controller = new AbortController()
  const sdkOptions = {
    cwd: resolveCwd(ctx, settings),
    model: settings.model,
    permissionMode: 'bypassPermissions',
    maxTurns: 1,
    abortController: controller,
    env: envWithProxy(settings.proxy),
  }
  const executable = resolveClaudeExecutable(settings.pathToClaudeCodeExecutable, settings.depsOptions)
  if (executable) sdkOptions.pathToClaudeCodeExecutable = executable
  applyClaudePriority(sdkOptions, settings.nice)
  const q = runQuery({ prompt: '<list models>', options: sdkOptions })
  try {
    if (typeof q?.supportedModels !== 'function') {
      throw new Error('claude-agent-sdk query has no supportedModels()')
    }
    return await q.supportedModels()
  } finally {
    // The query spawned a CLI process; refreshes must not leak one each time.
    controller.abort()
  }
}

function renderToolResult(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => (block?.type === 'text' && block.text ? block.text : JSON.stringify(block))).join('\n')
  }
  return JSON.stringify(content)
}

// ---------------------------------------------------------------------------
// Prompt rendering. Prompts are built as SEGMENT lists — plain strings plus
// `{ image: <DSH ImageBlock> }` markers for top-level image blocks — so one
// renderer feeds both the text-only prompt string (markers → placeholders)
// and the multimodal SDK content array (markers → base64 image blocks, see
// buildSdkPrompt). Images nested inside tool-result content intentionally
// stay text (renderToolResult): tool results are replayed as transcript
// text, not re-sent pixels.
// ---------------------------------------------------------------------------

// Text stand-in when an image cannot (or should not) be sent as pixels.
// DSH image block shape: {type:'image', attachment: ImageAttachmentRef}
// where the ref is {attachmentId:'sha256:<hex>', mediaType, bytes, width,
// height, name?} (dsh-attachment-local saveImageFile).
export function imagePlaceholder(block) {
  const ref = block?.attachment
  const label =
    (typeof ref?.name === 'string' && ref.name) ||
    (ref?.attachmentId !== undefined && ref?.attachmentId !== null ? String(ref.attachmentId) : '') ||
    (typeof block?.id === 'string' && block.id) ||
    'unknown'
  return `[image: ${label}]`
}

// DSH replaces file blocks with a handle naming a readable path, but only
// after the llm/stream waterfall this driver intercepts, so the driver builds
// the same handle (dsh-llm fileHandleText) from the same services.
function fileReadPath(ctx, ref) {
  try {
    const hostPath = ctx?.get?.('attachments')?.fileHostPath?.(ref)
    if (hostPath === undefined) return undefined
    return ctx.get('fs')?.processPathFromHostPath?.(hostPath)
  } catch {
    return undefined
  }
}

function fileHandle(ref, readPath) {
  const digest = String(ref?.attachmentId ?? '').replace(/^sha256:/, '').slice(0, 8)
  const identity = `File ${JSON.stringify(ref?.name ?? 'attachment')} (${ref?.bytes ?? '?'} bytes, sha256:${digest})`
  if (readPath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${JSON.stringify(readPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

// Replace DSH file blocks with their path handles before any rendering.
export function withFileHandles(ctx, options) {
  const messages = options?.messages
  if (!Array.isArray(messages) || !messages.some((m) => (m?.content ?? []).some?.((b) => b?.type === 'file'))) return options
  return {
    ...options,
    messages: messages.map((m) => {
      if (!Array.isArray(m?.content) || !m.content.some((b) => b?.type === 'file')) return m
      return { ...m, content: m.content.map((b) => (b?.type === 'file' ? { type: 'text', text: fileHandle(b.attachment, fileReadPath(ctx, b.attachment)) } : b)) }
    }),
  }
}

export function renderPromptSegmentsFor(ctx, options) {
  return renderPromptSegments(withFileHandles(ctx, options))
}

// One message body as ordered parts: strings and {image} markers.
function renderMessageBodySegments(message) {
  const body = []
  if (message?.role === 'tool') {
    body.push(`[tool-result ${message.toolCallId ?? 'unknown'}${message.isError ? ' (error)' : ''}]: ${renderToolResult(message.content)}`)
    return body
  }
  for (const block of message?.content ?? []) {
    if (block.type === 'text' && block.text) body.push(block.text)
    else if (block.type === 'tool-call') body.push(`[tool-call ${block.name}(${block.arguments})]`)
    else if (block.type === 'tool-result') body.push(`[tool-result ${block.toolCallId}]: ${renderToolResult(block.content)}`)
    else if (block.type === 'image') body.push({ image: block })
    else if (block.type === 'file') body.push(fileHandle(block.attachment, undefined))
  }
  return body
}

// Append one part to a segment list, merging adjacent strings so a prompt
// without images collapses to exactly one string segment.
function appendSegment(segments, part) {
  if (typeof part === 'string') {
    const last = segments.length - 1
    if (last >= 0 && typeof segments[last] === 'string') segments[last] += part
    else segments.push(part)
  } else {
    segments.push(part)
  }
}

// `<Role>\n body[0] \n\n body[1] … \n</Role>` with image markers kept intact.
function appendWrapped(segments, label, body) {
  appendSegment(segments, `<${label}>\n`)
  body.forEach((part, index) => {
    if (index > 0) appendSegment(segments, '\n\n')
    appendSegment(segments, part)
  })
  appendSegment(segments, `\n</${label}>`)
}

export function segmentsHaveImage(segments) {
  return Array.isArray(segments) && segments.some((part) => typeof part !== 'string')
}

// Text-only projection: every image marker becomes its placeholder line.
export function segmentsToText(segments) {
  return (segments ?? []).map((part) => (typeof part === 'string' ? part : imagePlaceholder(part.image))).join('')
}

const USER_PROMPT_MAX_CHARS = 64 * 1024

function expandHome(file, home) {
  if (file === '~') return home
  if (file.startsWith('~/')) return join(home, file.slice(2))
  return file
}

/**
 * Files appended by systemPromptMode:'user'. Explicit paths win; otherwise the
 * operator's ~/.dsh/AGENTS.md plus AGENTS.md from the workspace directory and
 * its parents. Missing files are skipped by the reader, not here.
 */
export function userInstructionFiles({ files, cwd = process.cwd(), home = homedir() } = {}) {
  const wanted = []
  if (Array.isArray(files) && files.length) {
    for (const file of files) if (typeof file === 'string' && file.trim()) wanted.push(expandHome(file.trim(), home))
  } else {
    wanted.push(join(home, '.dsh', 'AGENTS.md'))
    let dir = cwd
    for (let depth = 0; depth < 5; depth += 1) {
      wanted.push(join(dir, 'AGENTS.md'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return [...new Set(wanted)]
}

/** The operator-only system prompt for systemPromptMode:'user' (64 KiB cap). */
export function userSystemPrompt({ files, cwd, home } = {}) {
  const parts = []
  let used = 0
  for (const file of userInstructionFiles({ files, cwd, home })) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const trimmed = text.trim()
    if (!trimmed) continue
    const block = `# Instructions from ${file}\n\n${trimmed}`
    if (used + block.length > USER_PROMPT_MAX_CHARS) break
    used += block.length
    parts.push(block)
  }
  return parts.join('\n\n---\n\n')
}

/** The append text for this turn's system prompt, by configured mode. */
function systemPromptText(options, settings = {}, ctx) {
  const mode = settings.systemPromptMode ?? 'full'
  if (mode === 'none') return ''
  if (mode === 'user') {
    const cwd = resolveCwd(ctx ?? { get: () => undefined }, settings)
    return userSystemPrompt({ files: settings.userPromptFiles, cwd })
  }
  return dshSystemPrompt(options)
}

// The DSH system prompt: `options.system` plus every system-role message, in
// order. It becomes Claude Code's system prompt (appended to its own preset).
export function dshSystemPrompt(options) {
  const parts = []
  if (typeof options?.system === 'string' && options.system.trim()) parts.push(options.system.trim())
  for (const message of options?.messages ?? []) {
    if (message?.role !== 'system') continue
    const text = (message.content ?? []).filter((block) => block?.type === 'text' && block.text).map((block) => block.text).join('\n').trim()
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

// Transcript label per DSH role. System messages are not transcript: they are
// delivered as Claude Code's system prompt.
function roleLabel(role) {
  if (role === 'assistant') return 'Assistant'
  if (role === 'developer') return 'Harness'
  if (role === 'tool') return 'Tool'
  return 'User'
}

// Full-history (fresh) prompt as segments.
export function renderPromptSegments(options) {
  const segments = []
  let any = false
  const separate = () => {
    if (any) appendSegment(segments, '\n\n')
    any = true
  }
  for (const message of options?.messages ?? []) {
    if (message?.role === 'system') continue
    const role = roleLabel(message.role)
    const body = renderMessageBodySegments(message)
    if (!body.length) continue
    separate()
    appendWrapped(segments, role, body)
  }
  if (!any) appendSegment(segments, '<User>\n(no conversation history)\n</User>')
  appendSegment(segments, '\n\n<Assistant>')
  return segments
}

function renderPrompt(options) {
  return segmentsToText(renderPromptSegments(options))
}

// Trailing messages after the last assistant turn: the new user message plus
// any steering tail. This is all a resumed Claude session still needs — it
// already remembers everything before it.
export function extractResumeTail(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = list.length
  while (start > 0 && list[start - 1]?.role !== 'assistant') start -= 1
  return list.slice(start)
}

// Resume-tail prompt as segments (single new user message unwrapped, larger
// steering tails role-wrapped) — the segment twin of the old renderResumePrompt.
export function renderResumeSegments(tail) {
  if (tail.length === 1 && tail[0]?.role !== 'assistant') {
    const body = renderMessageBodySegments(tail[0])
    if (body.length) {
      const segments = []
      body.forEach((part, index) => {
        if (index > 0) appendSegment(segments, '\n\n')
        appendSegment(segments, part)
      })
      return segments
    }
  }
  const segments = []
  let any = false
  for (const message of tail) {
    if (message?.role === 'system') continue
    const role = roleLabel(message.role)
    const body = renderMessageBodySegments(message)
    if (!body.length) continue
    if (any) appendSegment(segments, '\n\n')
    any = true
    appendWrapped(segments, role, body)
  }
  return segments
}

// Decide fresh-vs-resume for one llm/stream call. `sessions` is injectable for
// tests; production uses the module-level map. Fresh calls send the full
// rendered history (system included); resume calls send only the new tail —
// the system text was already delivered on the fresh boot and Claude keeps it.
export function planPrompt(options, settings, sessions = resumeSessions) {
  const key = typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : undefined
  const chainKey =
    settings?.resumeChain !== false && key !== undefined && !INTERNAL_PURPOSES.has(options?.purpose)
      ? key
      : undefined
  const resumeId = chainKey !== undefined ? sessions.get(chainKey) : undefined
  if (resumeId !== undefined) {
    const tail = extractResumeTail(options?.messages)
    if (tail.length) {
      const segments = renderResumeSegments(tail)
      const prompt = segmentsToText(segments)
      if (prompt.trim()) return { mode: 'resume', resumeId, chainKey, prompt, segments }
    }
  }
  const segments = renderPromptSegments(options)
  return { mode: 'fresh', chainKey, prompt: segmentsToText(segments), segments }
}

// ---------------------------------------------------------------------------
// Image resolution: DSH image block -> Anthropic Messages API image block
// {type:'image', source:{type:'base64', media_type, data}}. The SDK accepts
// multimodal input only via streaming input — query({prompt}) is
// `string | AsyncIterable<SDKUserMessage>` (sdk.d.ts :2689/:8103) and
// SDKUserMessage.message is an Anthropic MessageParam whose content may be an
// array of text/image blocks (sdk.d.ts :4932-4937). Images are an enhancement,
// never a hard dependency: any failure degrades that image to its text
// placeholder with a warn and the model call proceeds.
// ---------------------------------------------------------------------------

const DATA_URL_PATTERN = /^data:(image\/[\w.+-]+);base64,(.+)$/s

// One DSH image block -> SDK base64 image block, or undefined on any failure.
// Data source order: inline data URL on the block (cheap, no service), then
// the durable attachment service (`ctx.get('attachments')`, readImage(ref) ->
// {ref, data:Uint8Array}; media_type from the verified ref's mediaType).
export async function resolveImageBlock(block, attachments, logger, signal) {
  const label = imagePlaceholder(block)
  try {
    const dataUrl =
      typeof block?.dataUrl === 'string'
        ? block.dataUrl
        : typeof block?.attachment?.dataUrl === 'string'
          ? block.attachment.dataUrl
          : undefined
    if (dataUrl) {
      const match = DATA_URL_PATTERN.exec(dataUrl.trim())
      if (match) {
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2].replace(/\s+/g, '') } }
      }
      logger?.warn?.(`claude-driver: unparseable image data URL for ${label}; falling back to the attachment service`)
    }
    const ref = block?.attachment
    if (ref && attachments && typeof attachments.readImage === 'function') {
      const stored = await attachments.readImage(ref, signal)
      const data = Buffer.from(stored?.data ?? new Uint8Array()).toString('base64')
      const mediaType = stored?.ref?.mediaType ?? ref?.mediaType ?? 'image/png'
      if (data) return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
    }
    logger?.warn?.(`claude-driver: no image data available for ${label}; sending a text placeholder instead`)
  } catch (error) {
    logger?.warn?.(`claude-driver: failed to read image attachment for ${label}; sending a text placeholder instead`, error)
  }
  return undefined
}

// Segments -> Anthropic content-block array: strings become text blocks
// (adjacent ones merged), image markers resolve to base64 image blocks or
// degrade to placeholder text in place.
export async function resolvePromptContent(segments, attachments, logger, signal) {
  const content = []
  const pushText = (text) => {
    const last = content[content.length - 1]
    if (last?.type === 'text') last.text += text
    else content.push({ type: 'text', text })
  }
  for (const segment of segments ?? []) {
    if (typeof segment === 'string') {
      pushText(segment)
      continue
    }
    const image = await resolveImageBlock(segment.image, attachments, logger, signal)
    if (image) content.push(image)
    else pushText(imagePlaceholder(segment.image))
  }
  return content
}

// The value handed to query({prompt}). With `openInput` false (legacy) this is
// the plain prompt string when the plan carries no image, otherwise a one-shot
// AsyncIterable<SDKUserMessage> carrying the interleaved text/image blocks.
// With `openInput` true every shape becomes an open-ended AsyncIterable so the
// session stays interactive. When EVERY image degrades to a placeholder the
// text-only path is kept (identical to plan.prompt by construction).
export async function buildSdkPrompt(ctx, plan, signal, openInput = false) {
  const content = await buildPromptBlocks(ctx, plan, signal)
  if (openInput) return openEndedPrompt(content)
  // Text-only plans keep the plain-string form (identical to the pre-refactor
  // behaviour; a single text block here is plan.prompt / the flattened
  // placeholder text by construction).
  if (!content.some((block) => block.type === 'image')) {
    return content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  }
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
  })()
}

// The plan's user message as Anthropic content blocks — shared by
// buildSdkPrompt (spawn-time prompt) and prewarm adoption (the message PUSHED
// into a standing process's open input).
export async function buildPromptBlocks(ctx, plan, signal) {
  if (!segmentsHaveImage(plan?.segments)) {
    return [{ type: 'text', text: plan.prompt }]
  }
  let attachments
  try {
    attachments = ctx?.get?.('attachments')
  } catch {
    attachments = undefined
  }
  if (!attachments || typeof attachments.readImage !== 'function') {
    ctx?.logger?.warn?.(
      'claude-driver: prompt contains image blocks but the durable attachment service ("attachments") is unavailable; images without inline data degrade to text placeholders',
    )
  }
  const content = await resolvePromptContent(plan.segments, attachments, ctx?.logger, signal)
  if (!content.some((block) => block.type === 'image')) {
    return [{ type: 'text', text: content.map((block) => (block.type === 'text' ? block.text : '')).join('') }]
  }
  return content
}

// How much of a completed block still needs emitting after token-level partial
// deltas already streamed `streamed` of it. Prefix mismatch means the partials
// covered content this particular assistant message does not (e.g. the SDK
// split one API message across several assistant messages) — emit nothing
// rather than duplicate.
// Progress line for one internal Claude Code tool_use block. Plain text on the
// existing text block, so no new chunk/block types are involved.
export function renderToolProgress(toolName) {
  // MCP-bridged tools surface as mcp__<server>__<tool>; show the bare name.
  const bare = typeof toolName === 'string' ? toolName.replace(/^mcp__.+?__/, '') : ''
  return `\n[Claude Code] calling tool ${bare || '(unknown)'}…\n`
}

// Input keys worth showing, in priority order, for a built-in tool activity
// line. Deliberately ordered so the SUBJECT wins over the payload: `Write`
// carries both `file_path` and `content`, and only the path belongs on screen
// (dumping `content` would paste a whole file into the reply). Any key not
// listed is never rendered, so a new built-in degrades to a bare tool name
// rather than leaking an arbitrary blob.
const BUILTIN_ACTIVITY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
]

// One-line subject for a built-in tool call, collapsed to a single line and
// clipped: tool inputs are unbounded (a Bash heredoc, a long prompt) and this
// rides the visible text block.
export function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return ''
  for (const key of BUILTIN_ACTIVITY_KEYS) {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const flat = value.replace(/\s+/g, ' ').trim()
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
  }
  return ''
}

// Activity line for one built-in Claude Code tool_use (see
// DEFAULTS.narrateBuiltinTools). Emitted when the assistant message carrying
// the tool_use arrives — i.e. BEFORE the tool runs — so the silence that
// follows is attributable to a named tool instead of reading as a stall.
export function renderBuiltinToolActivity(toolName, input) {
  const bare = typeof toolName === 'string' ? toolName.replace(/^mcp__.+?__/, '') : ''
  const subject = summarizeToolInput(input)
  const head = `⚙ ${bare || '(unknown)'}`
  return `\n[Claude Code] ${subject ? `${head} · ${subject}` : head}\n`
}

// Sentinel the CLI returns when a host-rendered dialog (built-in
// AskUserQuestion) was parked for a host that never displayed it. Recognised so
// the note can say what actually happened instead of dumping a bare error.
const UNANSWERED_QUESTION_MARKER = 'did not answer the questions'

// Narration for a FAILED built-in Claude Code tool call. Built-ins never render
// a native card (only bridged DSH tools do) and the text fallback
// `showToolProgress` is off by default, so without this a failed built-in
// round-trip is completely invisible in the GUI — which is exactly how a
// swallowed AskUserQuestion looked indistinguishable from a hang. Returns ''
// when there is nothing worth narrating.
export function renderBuiltinToolErrorNote(toolName, resultText) {
  const bare = typeof toolName === 'string' ? toolName.replace(/^mcp__.+?__/, '') : ''
  const raw = typeof resultText === 'string' ? resultText.trim() : ''
  if (bare === BUILTIN_ASK_USER_QUESTION || raw.includes(UNANSWERED_QUESTION_MARKER)) {
    return `\n[Claude Code] the built-in question tool ${bare || BUILTIN_ASK_USER_QUESTION} cannot render its card in DSH; this question was not delivered (the model received "The user did not answer the questions.").\n`
  }
  if (!raw) return ''
  const short = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
  return `\n[Claude Code] built-in tool ${bare || '(unknown)'} failed: ${short}\n`
}

export function remainderAfterPartial(full, streamed) {
  if (!full) return ''
  if (!streamed) return full
  return full.startsWith(streamed) ? full.slice(streamed.length) : ''
}

function usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) {
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

// The SDK's snake_case per-request usage as DSH's TokenUsage, for settlements
// the driver writes mid-turn (the token meter's context projection reads it).
function usageSampleFor(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  return usageChunk(
    Number(raw.input_tokens ?? 0),
    Number(raw.output_tokens ?? 0),
    Number(raw.cache_read_input_tokens ?? 0),
    Number(raw.cache_creation_input_tokens ?? 0),
  )
}

// Claude's typed assistant errors -> DSH failure codes.
const CLAUDE_ERROR_CODES = {
  authentication_failed: 'AUTH',
  oauth_org_not_allowed: 'AUTH',
  account_on_hold: 'AUTH',
  verification_required: 'AUTH',
  billing_error: 'AUTH',
  cloud_credential_error: 'AUTH',
  rate_limit: 'RATE_LIMIT',
  overloaded: 'SERVER',
  server_error: 'SERVER',
  invalid_request: 'INVALID_REQUEST',
  model_not_found: 'INVALID_REQUEST',
  max_output_tokens: 'CLAUDE_CODE_ERROR',
  unknown: 'CLAUDE_CODE_ERROR',
}

function claudeErrorMessage(error, text) {
  const body = String(text ?? '').trim() || error
  return CLAUDE_ERROR_CODES[error] === 'AUTH' ? `${body} (run \`claude /login\` on the DSH host, then retry)` : body
}

export function classifyFailure(message, claudeError) {
  if (claudeError && CLAUDE_ERROR_CODES[claudeError]) return CLAUDE_ERROR_CODES[claudeError]
  const text = String(message)
  if (isAuthFailureMessage(text)) return 'AUTH'
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/\b400\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(text)) return 'SERVER'
  if (/time(?:d)?\s*out|timeout/i.test(text)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|ENOTFOUND|ECONN)\b/i.test(text)) return 'TRANSPORT'
  return 'CLAUDE_CODE_ERROR'
}

// One DSH tool result -> MCP CallToolResult content. Text passes through
// (adjacent blocks merged); an image block is resolved to base64 bytes, because
// MCP image content becomes an image block inside the tool_result — flattening
// it to JSON is what made a bridged read_image invisible to Claude. An image
// that cannot be resolved degrades to its text placeholder; a tool result never
// fails the turn over a picture.
export async function toSdkToolResultContent(result, attachments, logger, signal) {
  const content = []
  const pushText = (text) => {
    if (!text) return
    const last = content[content.length - 1]
    if (last?.type === 'text') last.text += `\n${text}`
    else content.push({ type: 'text', text })
  }
  const blocks = result?.content
  if (!Array.isArray(blocks)) pushText(typeof blocks === 'string' ? blocks : JSON.stringify(blocks ?? ''))
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      pushText(block.text)
      continue
    }
    if (block?.type === 'image') {
      const image = await resolveImageBlock(block, attachments, logger, signal)
      if (image) {
        content.push({ type: 'image', data: image.source.data, mimeType: image.source.media_type })
        continue
      }
      pushText(imagePlaceholder(block))
      continue
    }
    pushText(JSON.stringify(block))
  }
  if (!content.length) pushText('(no output)')
  if (result?.isError === true) {
    const first = content.find((entry) => entry.type === 'text')
    if (first) first.text = `Error: ${first.text}`
  }
  return content
}

// DSH tool schemas are a restricted JSON-Schema subset; the SDK's tool()
// helper wants a zod raw shape. Convert the subset DSH actually emits.
function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== 'object') return z.record(z.unknown())
  if (schema.oneOf || schema.anyOf || Array.isArray(schema.type)) {
    const variants = (schema.oneOf ?? schema.anyOf ?? schema.type.map((type) => ({ ...schema, type })))
      .map((variant) => jsonSchemaToZod(variant))
    return z.union(variants.length ? variants : [z.unknown()])
  }
  switch (schema.type) {
    case 'string':
      if (Array.isArray(schema.enum) && schema.enum.length) return z.enum(schema.enum)
      return z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array':
      return z.array(schema.items ? jsonSchemaToZod(schema.items) : z.unknown())
    case 'object': {
      const shape = {}
      const required = new Set(schema.required ?? [])
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        const child = jsonSchemaToZod(value)
        shape[key] = required.has(key) ? child : child.optional()
      }
      return z.object(shape)
    }
    default:
      return z.record(z.unknown())
  }
}

// ---------------------------------------------------------------------------
// Native tool cards (nativeToolCards): durable tool/call + tool/result events
// for bridged DSH tools, mirroring dsh-agent-loop's appendToolCall /
// appendToolResult exactly so the invariant machine, the surface projection,
// and the GUI card matcher treat them as first-class tool activity.
// ---------------------------------------------------------------------------

// The currently open turn/step, read from the committed log (the same state
// machine the session invariant tracks): the last `step/start` not yet closed
// by a `step/end`/`turn/end`. Returns undefined between steps — a card append
// there would violate the requireOpenStep invariant, so callers skip it.
export function openStepPosition(session) {
  const events = readSessionEvents(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'step/start') return { turn: event.data.turn, step: event.data.step }
    if (event?.type === 'step/end' || event?.type === 'turn/end') return undefined
  }
  return undefined
}

function mintMessageId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `claude-msg-${Math.random().toString(36).slice(2)}`
}

// dsh-llm createToolResultMessage: a first-class `tool`-role message whose
// content is the raw result blocks (dsh-session-format v4 rejects anything else
// with "requires a tool-role message"; the older user-role/tool-result-wrapper
// shape was silently refused by real DSH, leaving the card open).
export function buildToolResultMessage(callId, content, isError) {
  return {
    id: mintMessageId(),
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content: Array.isArray(content) ? content : [],
    isError: isError === true,
  }
}

// Paired assistant message carrying the tool-call block, mirroring dsh-llm's
// createAssistantMessage (role 'assistant', source {kind:'model',...}) with
// the exact block shape the agent loop assembles ({type:'tool-call', id, name,
// arguments:<raw JSON string>} — dsh-llm BlockAssembler). Without it the
// derived history contains only orphan tool-result user messages: after a
// model switch, dsh-llm-deepseek's serializeMessages expands each into a bare
// {role:'tool', tool_call_id} wire message with no pairing assistant
// tool_calls entry → the server 400s every turn with no self-healing.
export function buildAssistantToolCallMessage(callId, name, rawArguments, source) {
  return {
    id: mintMessageId(),
    role: 'assistant',
    source: { kind: 'model', ...(source ?? {}) },
    content: [{ type: 'tool-call', id: callId, name, arguments: rawArguments }],
  }
}

// Append the card-opening tool/call event. `arguments` must be the raw JSON
// string (the api-proxy presenter path JSON.parses it before presentCall).
// Returns the anchor {turn, step, seq} the result event must cite, or
// undefined when no step is open or the append was rejected (invariant/log
// error) — the tool still executes, only the card is skipped.
function appendToolCallCard(ctx, session, callId, name, args, source, usage) {
  const position = openStepPosition(session)
  if (!position || typeof session?.append !== 'function') return undefined
  const rawArguments = JSON.stringify(args ?? {})
  // The pairing assistant/message goes first and carries no sourceEventSeqs
  // (dsh-session rejects them on assistant/message, even empty). Load refuses a
  // tool/call that no earlier assistant/message advertised, so a card without
  // its pairing would make the whole session unloadable. On failure the tool
  // still runs, but no card and no result are written.
  // `stream` must be an array even for this synthetic settlement: the host's
  // assistant-settlement contract validates it on load, and the token-meter /
  // session-stats projections index it when replaying history.
  try {
    session.append(
      'assistant/message',
      {
        turn: position.turn,
        step: position.step,
        message: buildAssistantToolCallMessage(callId, name, rawArguments, source),
        // The request that produced this tool call. DSH's token meter updates
        // the context-occupancy projection from a settlement's usage, and a
        // Claude turn is ONE DSH step until it settles — without this the
        // context meter stays empty for the whole (possibly hours-long) turn.
        ...(usage === undefined ? {} : { usage }),
        stream: [],
      },
      { surfaceOp: 'append' },
    )
  } catch (error) {
    ctx?.logger?.warn?.(`claude-driver: assistant tool-call pairing event for ${name} not appended`, error)
    return undefined
  }
  try {
    const event = session.append('tool/call', {
      turn: position.turn,
      step: position.step,
      callId,
      name,
      arguments: rawArguments,
    })
    return { turn: position.turn, step: position.step, seq: event.seq }
  } catch (error) {
    ctx?.logger?.warn?.(`claude-driver: tool/call card for ${name} not appended`, error)
    return undefined
  }
}

// Close the card: tool/result in the same turn/step, surfaceOp append,
// sourceEventSeqs citing the call event (the loop's exact contract). Skipped
// when the step already closed (late tool settle after abort) — the UI then
// projects the dangling call as interrupted, matching native behavior.
function appendToolResultCard(ctx, session, card, callId, result) {
  const position = openStepPosition(session)
  if (!position || position.turn !== card.turn || position.step !== card.step) return false
  const message = buildToolResultMessage(callId, result?.content ?? [], result?.isError === true)
  try {
    session.append(
      'tool/result',
      {
        turn: card.turn,
        step: card.step,
        message,
        ...(result?.error?.info ? { error: result.error.info } : {}),
        ...(result?.meta !== undefined ? { meta: result.meta } : {}),
      },
      { surfaceOp: 'append', sourceEventSeqs: [card.seq] },
    )
    return true
  } catch (error) {
    ctx?.logger?.warn?.(`claude-driver: tool/result card for ${callId} not appended`, error)
    return false
  }
}

// Which schemas cross the MCP bridge. Kept pure so the filter is testable
// without a Cordis context: true/all bridges every schema, 'plugins' keeps
// everything outside DSH_CORE_TOOLS (plus bridgeToolNames exceptions), false
// bridges nothing.
export function selectBridgeSchemas(schemas, settings = {}) {
  const all = Array.isArray(schemas) ? schemas : []
  if (settings.bridgeTools === false) return []
  if (settings.bridgeTools !== 'plugins') return all
  const core = new Set(Array.isArray(settings.coreTools) ? settings.coreTools : DSH_CORE_TOOLS)
  const always = new Set(Array.isArray(settings.bridgeToolNames) ? settings.bridgeToolNames : DEFAULTS.bridgeToolNames)
  return all.filter((schema) => typeof schema?.name === 'string' && (!core.has(schema.name) || always.has(schema.name)))
}

// Bridge DSH tool schemas into Claude SDK custom tools via an in-process MCP
// server (SDK 0.3.x registers custom tools through mcpServers, not a raw
// `tools` array). Approval/guards for these tools stay inside DSH's own
// tools/pre-execute pipeline; permission decisions (including Claude
// built-ins) live in buildCanUseTool below, assembled separately so it works
// with or without a bridge. Exported for the mock card tests.
export function buildToolBridge(ctx, options, settings, controller) {
  if (settings.bridgeTools === false) return null
  if (INTERNAL_PURPOSES.has(options?.purpose)) return null
  const schemas = selectBridgeSchemas(options?.tools, settings)
  if (!schemas.length) return null
  const tools = ctx.get('tools')
  const agents = ctx.get('agents')
  if (!tools || !agents) return null
  const dsdNames = new Set(schemas.map((schema) => schema.name))
  // Build-time initiator: buildToolBridge runs inside the agent loop's model
  // step (llm/stream), so currentInitiator() is the calling agent. Captured as
  // the card-capability probe and per-call fallback (SDK transport callbacks
  // may run outside the initiator's async context).
  const cardAgent = agents.currentInitiator?.()
  const cardsEnabled = settings.nativeToolCards !== false && typeof cardAgent?.session?.append === 'function'
  // Model source for the assistant tool-call pairing message (dsh-llm
  // createAssistantMessage carries {kind:'model', provider, model}).
  const cardSource = {
    provider: settings.provider ?? 'claude-code',
    model: (typeof options?.model === 'string' && options.model) || settings.model || 'claude-code',
  }
  const handlers = new Map()
  const sdkTools = schemas.map((schema) => {
    const run = async (input) => {
      // Diagnostic (behavior-preserving): the SDK transport callback may fire
      // outside the DSH initiator async context, so currentInitiator() at call
      // time is not always the live root. Log which agent won so a
      // "card never shows" report can be tied to CALLER_NOT_LIVE /
      // DELEGATED_CALLER / ASK_MISSING_AGENT in userQuestions.ask.
      const currentInitiatorAgent = agents.currentInitiator?.()
      const agent = currentInitiatorAgent ?? cardAgent
      if (schema.name === 'ask_user_question') {
        ctx?.logger?.info?.(
          `claude-driver[ask_user_question] agent resolution -> currentInitiator(${currentInitiatorAgent?.id ?? 'none'}) ?? cardAgent(${cardAgent?.id ?? 'none'}) = ${agent?.id ?? 'none'}`,
        )
      }
      if (!agent) throw new Error(`DSH tool ${schema.name}: no initiating agent`)
      const callId = `claude-${Math.random().toString(36).slice(2)}`
      const session = settings.nativeToolCards !== false ? agent.session : undefined
      // Open the native card before execution so approval prompts and long
      // runs are visible under it, exactly like loop-scheduled calls.
      const card = session ? appendToolCallCard(ctx, session, callId, schema.name, input ?? {}, cardSource) : undefined
      let result
      try {
        // The executor takes a batch of raw calls and answers per callId.
        const batch = await tools.execute({
          calls: [{ type: 'tool-call', id: callId, name: schema.name, arguments: JSON.stringify(input ?? {}) }],
          agent,
          signal: controller.signal,
        })
        result = batch.results[0].result
      } catch (error) {
        // tools.execute materializes tool failures; a throw here is a harness
        // fault — still close the card so it never spins forever.
        if (card) {
          const message = String(error?.message ?? error)
          appendToolResultCard(ctx, session, card, callId, {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
            error: { message },
          })
        }
        throw error
      }
      if (card) appendToolResultCard(ctx, session, card, callId, result)
      // Diagnostic: an isError tool result usually carries the UserQuestionError
      // message when ask_user_question was rejected by the live-root guard,
      // which is the leading "card never shows" hypothesis. warn-level, truncated.
      if (result?.isError === true) {
        const errText = Array.isArray(result?.content)
          ? result.content.map((block) => (block?.type === 'text' && block.text ? block.text : JSON.stringify(block))).join('\n')
          : JSON.stringify(result?.content)
        const short = typeof errText === 'string' && errText.length > 600 ? `${errText.slice(0, 600)}…TRUNC` : errText
        ctx?.logger?.warn?.(`claude-driver[${schema.name}] tool returned isError=true; content=${short}`)
      }
      let attachments
      try {
        attachments = ctx?.get?.('attachments')
      } catch {
        attachments = undefined
      }
      return {
        content: await toSdkToolResultContent(result, attachments, ctx?.logger, controller.signal),
        isError: result?.isError === true,
      }
    }
    handlers.set(schema.name, run)
    return tool(schema.name, schema.description ?? '', jsonSchemaToZod(schema.parameters), run, { alwaysLoad: true })
  })
  const server = createSdkMcpServer({ name: 'dsh-tools', version: '1.0.0', tools: sdkTools, alwaysLoad: true })
  // Whether a Claude-side tool_use name (possibly mcp__<server>__-prefixed)
  // maps to a bridged DSH tool that will render a native card — the text
  // progress line is suppressed for exactly these.
  const rendersCard = (toolName) => {
    if (!cardsEnabled) return false
    if (typeof toolName !== 'string') return false
    return dsdNames.has(toolName) || dsdNames.has(toolName.replace(/^mcp__.+?__/, ''))
  }
  // Options.mcpServers is Record<name, config>; an array would register the
  // server as "0" and Claude would see mcp__0__<tool>.
  return { mcpServers: { 'dsh-tools': server }, bridgedNames: dsdNames, rendersCard, handlers }
}

// ---------------------------------------------------------------------------
// canUseTool: SDK permission callback, assembled independently of the tool
// bridge so Claude built-in tools reach DSH approval even when no DSH tools
// are bridged. The SDK contract is fail-closed on null (no control_response →
// the tool blocks forever with no deadline), so EVERY path here returns a
// concrete allow/deny — never null, never a thrown error.
// ---------------------------------------------------------------------------

// Human-readable reason for the approval card, preferring the SDK bridge's own
// prompt sentence (options.title) over anything we could reconstruct.
export function buildApprovalReason(toolName, info) {
  const parts = []
  if (typeof info?.title === 'string' && info.title.trim()) parts.push(info.title.trim())
  else if (typeof info?.displayName === 'string' && info.displayName.trim()) parts.push(info.displayName.trim())
  if (typeof info?.decisionReason === 'string' && info.decisionReason.trim()) parts.push(info.decisionReason.trim())
  if (!parts.length) return `Claude Code built-in tool: ${toolName}`
  return parts.join(' — ')
}

/**
 * Build the SDK canUseTool callback.
 * - Bridged DSH tools (bare or mcp__<server>__-prefixed): always allow — DSH's
 *   own tools/pre-execute → approval pipeline governs them (allowing here
 *   avoids a double prompt).
 * - Claude built-ins: allow when approveBuiltinTools is off or the tool is in
 *   builtinAllowlist; otherwise bridge to approval.request(). Only
 *   'allowed-once' grants; rejected/cancelled/unavailable (and a missing
 *   approval service or initiating agent) deny with the reason in `message`.
 */
export function buildCanUseTool(ctx, settings, controller, bridgedNames) {
  const names = bridgedNames instanceof Set ? bridgedNames : new Set(bridgedNames ?? [])
  const allowlist = new Set(
    Array.isArray(settings?.builtinAllowlist) ? settings.builtinAllowlist : DEFAULTS.builtinAllowlist,
  )
  // Build-time initiator fallback: this runs inside the agent loop's model
  // step, but SDK transport callbacks may later fire outside the initiator's
  // async context (same rationale as the bridge's cardAgent).
  let cardAgent
  try {
    cardAgent = ctx.get('agents')?.currentInitiator?.()
  } catch {
    cardAgent = undefined
  }
  const isBridged = (toolName) =>
    names.has(toolName) || [...names].some((name) => toolName.endsWith(`__${name}`))
  return async (toolName, input, info) => {
    const allow = { behavior: 'allow', updatedInput: input }
    try {
      if (typeof toolName !== 'string' || isBridged(toolName)) return allow
      if (settings?.approveBuiltinTools !== true || allowlist.has(toolName)) return allow
      let approval
      let agent
      try {
        approval = ctx.get('approval')
        agent = ctx.get('agents')?.currentInitiator?.() ?? cardAgent
      } catch {
        // strict/missing service lookups fall through to the fail-closed deny
      }
      if (agent === undefined) agent = cardAgent
      if (!approval || typeof approval.request !== 'function') {
        return { behavior: 'deny', message: `DSH approval service unavailable; built-in tool ${toolName} denied (fail closed).` }
      }
      if (!agent) {
        return { behavior: 'deny', message: `No initiating DSH agent for approval; built-in tool ${toolName} denied (fail closed).` }
      }
      const reason = buildApprovalReason(toolName, info)
      const outcome = await approval.request({
        agent,
        toolName,
        ...(typeof info?.toolUseID === 'string' && info.toolUseID ? { callId: info.toolUseID } : {}),
        reason,
        signal: info?.signal ?? controller?.signal,
      })
      if (outcome === 'allowed-once') return allow
      const detail =
        outcome === 'rejected'
          ? 'the user rejected this tool call'
          : outcome === 'cancelled'
            ? 'the approval request was cancelled'
            : 'no approval answerer was available (fail closed)'
      return { behavior: 'deny', message: `DSH approval: ${detail} (${toolName}).` }
    } catch (error) {
      // approval.request throws outside an open turn or on audit-append
      // failure — deny rather than hang the tool (null) or kill the stream.
      return { behavior: 'deny', message: `DSH approval bridge error for ${toolName}: ${String(error?.message ?? error)}` }
    }
  }
}

// One SDK options object, assembled identically for a live cold call and for
// a prewarmed spawn — a single assembly site is what guarantees an adopted
// process behaves byte-identically to the cold path it replaces.
export function buildSdkOptions(ctx, options, settings, { resumeId, controller, bridge, model, effort, waitForBackground }) {
  const permissions = resolvePermissions(ctx, settings, currentSession(ctx))
  const sdkOptions = {
    cwd: resolveCwd(ctx, settings),
    model,
    permissionMode: permissions.permissionMode,
    maxTurns: settings.maxTurns,
    effort,
    allowedTools: settings.allowedTools,
    abortController: controller,
    env: envWithProxy(settings.proxy),
  }
  if (permissions.allowDangerouslySkipPermissions) sdkOptions.allowDangerouslySkipPermissions = true
  const system = systemPromptText(options, settings, ctx)
  // snapshot:false re-renders every request: DSH rebuilds its system prompt per
  // step (plan mode, skills, instructions), and a resumed Claude session must see that.
  if (system) sdkOptions.systemPrompt = { type: 'preset', preset: 'claude_code', append: system, snapshot: false }
  if (resumeId !== undefined) sdkOptions.resume = resumeId
  if (settings.partialStream !== false) sdkOptions.includePartialMessages = true
  // See DEFAULTS.thinkingDisplay: without this the current models stream
  // redacted (empty-text) thinking and the reasoning block never opens.
  // Passed as a CLI flag on purpose — the `settings` query option was
  // measured NOT to carry it.
  const thinkingDisplay = settings.thinkingDisplay === undefined ? 'summarized' : settings.thinkingDisplay
  if (thinkingDisplay === 'summarized' || thinkingDisplay === 'omitted') {
    sdkOptions.extraArgs = { ...(sdkOptions.extraArgs ?? {}), 'thinking-display': thinkingDisplay }
  }
  // Declares a per-task stop affordance, which is what lets the CLI spare
  // running background tasks instead of failing closed on them. Only
  // meaningful together with the open-input prompt.
  if (waitForBackground) sdkOptions.perTaskStopAffordance = true
  const executable = resolveClaudeExecutable(settings.pathToClaudeCodeExecutable, settings.depsOptions)
  if (executable) sdkOptions.pathToClaudeCodeExecutable = executable
  applyClaudePriority(sdkOptions, settings.nice)
  if (bridge) sdkOptions.mcpServers = bridge.mcpServers
  // Internal one-shot calls (session title, one-shot summary) answer from text
  // alone. Giving them Claude's built-in tools lets the model start working
  // (real DSH: a title call ran the user's Bash tool a second time).
  if (INTERNAL_PURPOSES.has(options?.purpose)) sdkOptions.tools = []
  // canUseTool is assembled independently of the bridge: with bridged
  // DSH tools it must allow them through (DSH pipeline owns approval),
  // and with approveBuiltinTools on it must install even when NO DSH
  // tools are bridged. When neither applies, leave the SDK's default
  // permission handling (permissionMode) untouched.
  if (bridge || settings.approveBuiltinTools === true) {
    sdkOptions.canUseTool = buildCanUseTool(ctx, settings, controller, bridge?.bridgedNames)
  }
  // Installing canUseTool above is exactly what makes the CLI offer the
  // built-in AskUserQuestion (see DEFAULTS.disableBuiltinAskUserQuestion),
  // so the suppression has to be decided HERE, after the bridge is known.
  const disallowed = [...(Array.isArray(settings.disallowedTools) ? settings.disallowedTools : [])]
  if (
    settings.disableBuiltinAskUserQuestion !== false &&
    sdkOptions.canUseTool &&
    bridge?.bridgedNames?.has(ASK_USER_QUESTION_TOOL) &&
    !disallowed.includes(BUILTIN_ASK_USER_QUESTION)
  ) {
    disallowed.push(BUILTIN_ASK_USER_QUESTION)
  }
  if (settings.preferDshTools !== false) {
    for (const [dshTool, builtins] of Object.entries(DSH_OWNED_BUILTINS)) {
      if (!bridge?.bridgedNames?.has(dshTool)) continue
      for (const builtin of builtins) if (!disallowed.includes(builtin)) disallowed.push(builtin)
    }
  }
  if (disallowed.length) sdkOptions.disallowedTools = disallowed
  return sdkOptions
}

// Options for the CLI dependency check, from driver settings.
function depsCheckOptions(settings) {
  return {
    ...(settings.depsOptions ?? {}),
    explicit: settings.pathToClaudeCodeExecutable,
    autoInstall: settings.autoInstallCli !== false,
    nice: settings.nice,
  }
}

// Before a turn: make sure a CLI exists. Looks first; installs only when missing.
// Returns { note } to show the user, or { error } to end the turn with.
async function ensureCliForTurn(settings) {
  const ensure = settings.ensureCli ?? ensureClaudeCli
  const result = await ensure(depsCheckOptions(settings))
  if (result.action === 'installed') {
    resetClaudeExecutableCache()
    return { note: `\n· Claude Code CLI was missing; installed ${result.version ?? ''} (${result.path})\n` }
  }
  if (result.action === 'none') return {}
  if (result.action === 'busy') return { note: '\n· Claude Code CLI is being installed by another DSH process…\n' }
  const why = result.error ?? (result.reason === 'disabled' ? 'automatic install is off (autoInstallCli: false)' : result.reason === 'recent-failure' ? `an earlier install attempt failed${result.error ? `: ${result.error}` : ''}` : result.reason)
  return { error: `claude-driver: the Claude Code CLI is not installed (${why}). Run /claude-doctor install, install it yourself (npm i -g @anthropic-ai/claude-code), or set autoInstallCli: false and pathToClaudeCodeExecutable.` }
}

// DSH's compaction call (purpose 'compaction') on a session with a live Claude
// chain: run Claude's own /compact there and hand its summary back to DSH.
// Returns false when it does not apply or fails (caller does a one-shot summary).
async function* nativeCompactionTurn(ctx, options, settings) {
  if (options?.purpose !== 'compaction' || settings.nativeCompaction === false || settings.resumeChain === false) return false
  const dshSessionId = typeof options?.sessionId === 'string' ? options.sessionId : undefined
  const claudeSessionId = dshSessionId ? resumeSessions.get(dshSessionId) : undefined
  if (!claudeSessionId) return false
  disposePrewarm(dshSessionId, 'native compaction', prewarmPool)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options?.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const { model, effort } = resolveModelEffort(options, settings)
    const sdkOptions = buildSdkOptions(ctx, { ...options, tools: undefined }, settings, { controller, model, effort })
    const runQuery = typeof settings.queryImpl === 'function' ? settings.queryImpl : query
    const result = await runNativeCompaction({ runQuery, sdkOptions, settings, dshSessionId, claudeSessionId, logger: ctx?.logger })
    if (!result) {
      resumeSessions.delete(dshSessionId)
      return false
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: result.summary }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: result.summary } }
    yield { type: 'usage', usage: usageChunk(result.usage?.input_tokens ?? 0, result.usage?.output_tokens ?? 0, result.usage?.cache_read_input_tokens ?? 0, result.usage?.cache_creation_input_tokens ?? 0) }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return true
  } finally {
    options?.signal?.removeEventListener('abort', onAbort)
  }
}

let defaultLoginManager
function loginManagerFor(settings) {
  if (settings.loginImpl) return settings.loginImpl
  defaultLoginManager ??= createLoginManager({
    command: resolveClaudeExecutable(settings.pathToClaudeCodeExecutable, settings.depsOptions) ?? 'claude',
    env: claudeProcessEnv({}),
    spawn: (command, args, options) => spawnPrioritized(command, args, { ...options, level: settings.nice }),
  })
  return defaultLoginManager
}

const LOGIN_HINT = 'Run /claude-login to sign in again.'
const LOGIN_BLOCK_INDEX = 2 // beside the run's text (0) and reasoning (1) blocks

// An expired / missing Claude login ends a turn with an AUTH finish. Instead of
// a dead-end error: start `claude auth login`, show the URL in a reasoning
// block, wait for the login, then retry the turn ONCE. A failed login, an env
// credential (a login cannot override it), or a second AUTH keeps the original
// error with a hint; output already streamed is never retried.
export async function* streamClaudeChunks(ctx, options, settings, attempt = 0) {
  let streamed = false
  for await (const chunk of streamClaudeChunksOnce(ctx, options, settings)) {
    if (chunk.type === 'block-start') streamed = true
    const failure = chunk.type === 'finish' && chunk.reason?.kind === 'error' ? chunk.reason.failure : undefined
    if (failure?.code !== 'AUTH') {
      yield chunk
      continue
    }
    const envVar = credentialEnvVar()
    if (envVar) {
      yield withFailureNote(chunk, `${envVar} is set in the DSH host environment and overrides the Claude login; fix or unset it.`)
      return
    }
    if (attempt > 0 || streamed || settings.autoLogin === false) {
      yield withFailureNote(chunk, LOGIN_HINT)
      return
    }
    const manager = loginManagerFor(settings)
    const started = await manager.start()
    if (started.status === 'waiting') {
      yield* loginNotice(started.url)
      const outcome = await waitForLogin(manager, options?.signal, settings.loginWaitMs ?? 5 * 60_000)
      if (outcome?.status === 'success') {
        ctx.logger?.info?.('claude-driver: relogin succeeded; retrying the turn once')
        yield* streamClaudeChunks(ctx, options, settings, attempt + 1)
        return
      }
      manager.cancel()
    } else if (started.status === 'success') {
      yield* streamClaudeChunks(ctx, options, settings, attempt + 1)
      return
    }
    yield withFailureNote(chunk, LOGIN_HINT)
    return
  }
}

function withFailureNote(finishChunk, note) {
  const failure = finishChunk.reason.failure
  return { ...finishChunk, reason: { ...finishChunk.reason, failure: { ...failure, message: `${failure.message}\n${note}` } } }
}

function* loginNotice(url) {
  const body = `Claude login expired. Open ${url} and sign in. If the page shows a code, reply \`/claude-login <code>\`. This turn retries automatically once you are signed in.\n`
  yield { type: 'block-start', index: LOGIN_BLOCK_INDEX, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index: LOGIN_BLOCK_INDEX, text: body }
  yield { type: 'block-end', index: LOGIN_BLOCK_INDEX, block: { type: 'reasoning', text: body } }
}

function waitForLogin(manager, signal, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs, undefined)
    timer.unref?.()
    const finish = (value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(undefined)
    signal?.addEventListener('abort', onAbort, { once: true })
    manager.done().then(finish, () => finish(undefined))
  })
}

async function* streamClaudeChunksOnce(ctx, rawOptions, settings) {
  const options = withFileHandles(ctx, rawOptions)
  const controller = new AbortController()
  const signal = options?.signal
  const onAbort = () => controller.abort()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  // Five-hour plan-window guard (usage-guard.js). The quota is account-wide,
  // so one tripped latch refuses every ordinary Claude turn in this host until
  // the window resets; internal maintenance calls (title, compaction) still run.
  const dshSessionId = sessionIdFor(ctx, options)
  const stopPercent = normalizeStopPercent(settings?.usageStopPercent)
  const stopEnabled = stopPercent !== null && !INTERNAL_PURPOSES.has(options?.purpose)
  let usageStopped = false
  let usageStopNoted = false
  // A freshly loaded host has no latch, but the last snapshot may already be
  // over the line (e.g. the process restarted mid-window): evaluate it before
  // spending a request.
  if (stopEnabled) usageGuard.observe(claudeUsage.get(), { sessionId: dshSessionId, stopAtPercent: stopPercent })
  if (stopEnabled && usageGuard.stopped()) {
    pauseGoalForStop(ctx, dshSessionId, ctx?.logger)
    const notice = formatStopNotice(usageGuard.state(), { stopAtPercent: stopPercent, blocked: true })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: notice }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: notice } }
    yield { type: 'usage', usage: usageChunk(0, 0, 0, 0) }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  let openedText = false
  let openedReasoning = false
  let text = ''
  // Model-authored text only (excludes showToolProgress lines), so progress
  // chatter never masks an empty response nor suppresses the result fallback.
  let realText = ''
  let reasoning = ''
  // Redacted-thinking heartbeat state (see DEFAULTS.thinkingHeartbeat). Lives
  // beside `openedReasoning` — per RUN, not per attempt, because the reasoning
  // block it writes into is opened once for the whole run.
  let sawThinkingText = false
  let heartbeatOpen = false
  let heartbeatLastAt = 0
  let heartbeatTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheWrite = 0
  let failure
  let claudeError
  let maxTurnsHit = false
  // Claude Code background-task bookkeeping (see waitForBackgroundTasks).
  // `liveBackgroundTasks` mirrors the CLI's `background_tasks_changed` LEVEL
  // signal (REPLACE semantics, per sdk.d.ts), `backgroundOutcomes` collects the
  // `task_notification` edges. Both are reset per attempt.
  let liveBackgroundTasks = []
  let backgroundOutcomes = []
  let backgroundTimedOut = false
  const waitForBackground = settings.waitForBackgroundTasks !== false
  const backgroundTimeoutMs = Number(settings.backgroundTaskTimeoutMs ?? DEFAULTS.backgroundTaskTimeoutMs)
  // Hoisted out of the attempt loop: the marker bookkeeping below has to name
  // this run's Claude session after the loop has moved on or bailed out.
  let runSessionId
  let atRiskMarked = false

  // Driver-authored prose appended at the boundary where the guard stopped the
  // turn: counted in `text` (block-end must equal the deltas) but never in
  // `realText`, so it cannot pass for a model answer.
  function* usageStopNote(state) {
    const body = `\n\n${formatStopNotice(state, { stopAtPercent: stopPercent })}`
    if (!openedText) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      openedText = true
    }
    text += body
    yield { type: 'text-delta', index: 0, text: body }
    usageStopNoted = true
  }

  // Salvage from PREVIOUS runs, before this step's own query starts.
  //
  // `waitForBackgroundTasks` only spares subagents when a turn ends normally.
  // When the caller aborts (DSH disconnect/restart) or the process is killed,
  // they die mid-flight and their final reply is never produced. Their
  // transcripts survive on disk, so recovery is a read — and this is the moment
  // to deliver it, because the user is here now. See agent-harvest.js.
  if (waitForBackground && settings.harvestOrphanedSubagents !== false) {
    let harvestNote = ''
    try {
      // `harvestOptions` is a test seam (injectable fs / state roots); in
      // production it is absent and the real locations are used.
      harvestNote = harvestOrphanedRuns(settings.harvestOptions ?? {}).note
    } catch (error) {
      ctx?.logger?.warn?.(`claude-driver: orphaned-subagent harvest failed: ${String(error?.message ?? error)}`)
    }
    if (harvestNote) {
      // Driver narration: it opens block 0 and is counted in `text` (block-end
      // must equal the sum of the deltas) but never in `realText`, so it can
      // neither mask an empty model reply nor suppress the result fallback.
      const opening = `${harvestNote.replace(/^\s+/, '')}\n\n`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      openedText = true
      text += opening
      yield { type: 'text-delta', index: 0, text: opening }
    }
  }

  // DSH-visible mirror of Claude Code's own background tasks (see job-mirror.js).
  // `currentQuery` is whichever SDK query the run is draining, for stopTask.
  let currentQuery
  const jobMirror = createJobMirror({
    ctx,
    session: currentSession(ctx),
    stopTask: (taskId) => currentQuery?.stopTask?.(taskId),
    enabled: settings.mirrorBackgroundJobs !== false,
  })

  // Missing CLI? Install it (only if absent), tell the user, or fail clearly.
  // Test doubles (queryImpl) and an explicit opt-out skip the guard by default.
  if (settings.checkCliBeforeTurn === true || (settings.checkCliBeforeTurn !== false && typeof settings.queryImpl !== 'function' && !INTERNAL_PURPOSES.has(options?.purpose))) {
    if (!locateClaude({ explicit: settings.pathToClaudeCodeExecutable, ...(settings.depsOptions ?? {}) })) {
      const guard = await ensureCliForTurn(settings)
      if (guard.error) {
        yield { type: 'usage', usage: usageChunk(0, 0, 0, 0) }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: guard.error, code: 'CLAUDE_CODE_ERROR' } } }
        return
      }
      if (guard.note) {
        yield { type: 'block-start', index: 1, blockType: 'reasoning' }
        openedReasoning = true
        reasoning += guard.note
        yield { type: 'reasoning-delta', index: 1, text: guard.note }
      }
    }
  }

  let plan = planPrompt(options, settings)

  const native = yield* nativeCompactionTurn(ctx, options, settings)
  if (native) return
  if (plan.chainKey !== undefined) noteTurnRan(plan.chainKey)

  // The prewarmed process this run adopted, if any. Held at run scope so the
  // final `finally` can close it: breaking out of a `for await` over the
  // ADAPTER iterable does not close the underlying SDK transport the way
  // breaking over the SDK iterator itself would.
  let adoptedEntry
  let detachSteering = () => {}

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      failure = undefined
      claudeError = undefined
      maxTurnsHit = false
      liveBackgroundTasks = []
      backgroundOutcomes = []
      backgroundTimedOut = false
      inputTokens = 0
      outputTokens = 0
      cacheRead = 0
      cacheWrite = 0
      // Prompt-side usage source for the DSH usage chunk: the LAST top-level
      // (parent_tool_use_id == null) SDK assistant message's `message.usage`.
      // Each SDK assistant message mirrors one Anthropic Messages API response
      // (sdk.d.ts 0.3.234 :3049), so its usage covers exactly ONE API request
      // — messages arrive in order, so last-wins keeps the run's final API
      // request (equivalently the last request_id seen, :3057). Reset per
      // attempt so a fresh retry never reports the failed attempt's sample.
      let lastAssistantUsage
      let turnRequests = 0
      let sdkSessionId
      // Set once the run's `result` arrived; from then on the loop keeps
      // draining the stream only while background tasks are still live.
      let sawResult = false
      let stallGuard
      let backgroundDeadline = 0
      let backgroundTimer
      let drainDeadline = 0
      let drainTimer
      // Text/thinking already emitted via partial deltas for the in-flight API
      // message; used to dedupe against the complete assistant message.
      let pmText = ''
      let pmReasoning = ''
      // tool_use id -> tool name, so a tool_result (which carries only the id)
      // can be attributed when narrating built-in failures.
      const toolUseNames = new Map()
      const openBuiltinCards = new Map() // tool_use id -> { card, name, session }
      const cardedToolIds = new Set() // every built-in that got a card: its error is already on the card
      const runningTools = new Map() // tool_use id -> { name, subject } for the liveness pulse
      const taskLedger = createTaskLedger() // which task events are real background-task outcomes
      let driverStopping = false // the driver itself is tearing the session down (deadline / drain)
      // Internal calls (session title, compaction) are not the user's turn: they
      // must not write cards into the session they are about.
      const builtinCardSession = () => (settings.builtinToolCards === false || settings.nativeToolCards === false || INTERNAL_PURPOSES.has(options?.purpose) ? undefined : currentSession(ctx))
      // Open a DSH card for a Claude built-in. Returns false when no card can
      // be written (no open DSH step), so the caller narrates in text instead.
      const openBuiltinCard = (toolUse) => {
        if (cardedToolIds.has(toolUse.id)) return true // already carded: never open the same call twice
        const session = builtinCardSession()
        const mapped = session ? dshCardFor(toolUse.name, toolUse.input) : undefined
        if (!mapped || !toolUse.id) return false
        const card = appendToolCallCard(
          ctx,
          session,
          toolUse.id,
          mapped.name,
          mapped.args,
          {
            provider: settings.provider ?? 'claude-code',
            model: (typeof options?.model === 'string' && options.model) || settings.model || 'claude-code',
          },
          usageSampleFor(lastAssistantUsage),
        )
        if (!card) return false
        openBuiltinCards.set(toolUse.id, { card, name: mapped.name, session })
        cardedToolIds.add(toolUse.id)
        return true
      }
      const closeBuiltinCard = (id, content, isError) => {
        const open = openBuiltinCards.get(id)
        if (!open) return false
        openBuiltinCards.delete(id)
        appendToolResultCard(ctx, open.session, open.card, id, {
          content: resultContentFor(open.name, content, isError),
          isError,
        })
        return true
      }
      const closeStrandedBuiltinCards = () => {
        for (const id of [...openBuiltinCards.keys()]) closeBuiltinCard(id, 'Interrupted: the tool did not return before the turn ended.', true)
      }
      try {
        const { model: resolvedModel, effort: resolvedEffort } = resolveModelEffort(options, settings)
        // Loop-scope copy of the run's cwd: the at-risk marker below needs it,
        // and the full sdkOptions object only exists on the cold branch.
        const runCwd = resolveCwd(ctx, settings)
        // Prewarm adoption (attempt 0, resume mode only): a standing process
        // spawned at the END of the previous turn may already be booted for
        // exactly this turn. Adopt it only on an exact match — resume id,
        // model, effort, bridged tool set — and only while it is alive; any
        // other state falls through to the cold path below, which is the
        // pre-prewarm behaviour verbatim.
        if (attempt === 0 && adoptedEntry === undefined && plan.mode === 'resume' && settings.prewarm === true) {
          const candidate = takePrewarm(plan.chainKey)
          if (candidate) {
            const compatible = prewarmAdoptable(candidate, {
              resumeId: plan.resumeId,
              model: resolvedModel,
              effort: resolvedEffort,
              toolKey: toolSetKey(options),
              systemKey: systemPromptKey(options, settings, ctx),
              permissionMode: resolvePermissions(ctx, settings, currentSession(ctx)).permissionMode,
            })
            if (compatible) adoptedEntry = candidate
            else candidate.dispose('incompatible with the arriving turn')
          }
        }
        let bridge
        let q
        let steerInput
        if (adoptedEntry !== undefined && attempt === 0) {
          bridge = adoptedEntry.bridge
          // The run's own abort levers (caller signal, background deadline)
          // all fire `controller`; the adopted transport listens to the
          // entry's controller — chain them.
          controller.signal.addEventListener('abort', () => adoptedEntry.controller.abort(), { once: true })
          const content = await buildPromptBlocks(ctx, plan, adoptedEntry.controller.signal)
          adoptedEntry.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
          q = prewarmMessages(adoptedEntry)
          ctx?.logger?.info?.(`claude-driver: adopted the prewarmed Claude session (resume ${adoptedEntry.resumeId})`)
        } else {
          bridge = buildToolBridge(ctx, options, settings, controller)
          const sdkOptions = buildSdkOptions(ctx, options, settings, {
            resumeId: plan.mode === 'resume' ? plan.resumeId : undefined,
            controller,
            bridge,
            model: resolvedModel,
            effort: resolvedEffort,
            waitForBackground,
          })
          // Test seam: inject a fake SDK query (no network) via settings.queryImpl.
          const runQuery = typeof settings.queryImpl === 'function' ? settings.queryImpl : query
          // String prompt normally; a one-shot AsyncIterable<SDKUserMessage>
          // when the plan carries resolvable images (rebuilt per attempt — an
          // async iterable is single-use).
          const promptInput = await buildSdkPrompt(ctx, plan, controller.signal, waitForBackground)
          q = runQuery({
            prompt: promptInput,
            options: sdkOptions,
          })
          steerInput = promptInput
        }
        currentQuery = adoptedEntry !== undefined && attempt === 0 ? adoptedEntry.query : q
        detachSteering()
        const steerTarget = adoptedEntry !== undefined && attempt === 0 ? adoptedEntry.input : steerInput
        detachSteering = attachSteering(ctx, {
          push: typeof steerTarget?.push === 'function' ? (message) => steerTarget.push(message) : undefined,
          active: () => !sawResult && !signal?.aborted,
          toContent: (segments) => resolvePromptContent(segments, ctx?.get?.('attachments'), ctx?.logger, controller.signal),
        })
        stallGuard = createStallGuard(settings, () => controller.abort())
        for await (const msg of stallGuard.guard(q)) {
          if (typeof msg.session_id === 'string' && msg.session_id) {
            sdkSessionId = msg.session_id
            runSessionId = msg.session_id
          }
          if (msg.type === 'stream_event') {
            // Token-level streaming: one Anthropic Messages API stream event
            // per SDKPartialAssistantMessage. Only top-level output (subagent
            // partials carry parent_tool_use_id).
            if (msg.parent_tool_use_id) continue
            const event = msg.event
            if (event?.type === 'message_start') {
              pmText = ''
              pmReasoning = ''
              // message_start carries the request's prompt-side usage
              // (input/cache_read/cache_creation are stable from message_start;
              // only output accumulates later). Capture it here too so the
              // sample exists even if the whole-message path is skipped.
              // Subagent partials never reach this line (continue above).
              if (event.message?.usage) lastAssistantUsage = event.message.usage
            } else if (event?.type === 'content_block_delta') {
              const delta = event.delta
              if (delta?.type === 'text_delta' && delta.text) {
                if (!openedText) {
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                  openedText = true
                }
                text += delta.text
                realText += delta.text
                pmText += delta.text
                yield { type: 'text-delta', index: 0, text: delta.text }
              } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                if (!openedReasoning) {
                  yield { type: 'block-start', index: 1, blockType: 'reasoning' }
                  openedReasoning = true
                }
                // Real summary text won the race: retire the heartbeat line
                // (it stays in the block as history) and separate it from the
                // text that follows.
                if (heartbeatOpen && !sawThinkingText) {
                  reasoning += '\n\n'
                  yield { type: 'reasoning-delta', index: 1, text: '\n\n' }
                }
                sawThinkingText = true
                reasoning += delta.thinking
                pmReasoning += delta.thinking
                yield { type: 'reasoning-delta', index: 1, text: delta.thinking }
              }
            }
          } else if (msg.type === 'assistant' && msg.error && !msg.parent_tool_use_id) {
            // Claude reports API failures (auth, billing, rate limit, ...) as an
            // assistant message carrying `error`; it is not an answer.
            claudeError = msg.error
            const errText = (msg.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
            failure = claudeErrorMessage(msg.error, errText)
          } else if (msg.type === 'assistant' && !msg.error) {
            // Per-request usage capture — top-level messages only: subagent
            // traffic (parent_tool_use_id non-null) runs its own context and
            // must never masquerade as the main session's prompt pressure.
            // Tool progress text / thinking never carry usage; only the
            // API-response mirror `message.usage` is read here.
            if (!msg.parent_tool_use_id && msg.message?.usage) {
              lastAssistantUsage = msg.message.usage
              turnRequests += 1
              // Plan usage is read here, while the query is open: the SDK
              // rejects the usage control request once the result has arrived.
              void claudeUsage.refresh(currentQuery).then(() => {
                if (!stopEnabled || usageGuard.stopped()) return
                const decision = usageGuard.observe(claudeUsage.get(), { sessionId: dshSessionId, stopAtPercent: stopPercent })
                if (!decision.stop) return
                // The quota is account-wide: pause this session's goal so no
                // further round starts against the stopped guard.
                pauseGoalForStop(ctx, dshSessionId, ctx?.logger)
                ctx?.logger?.warn?.(
                  `claude-driver: 5-hour usage at ${Math.round(decision.percent)}% (stop threshold ${stopPercent}%); Claude turns stop until the window resets`,
                )
              })
            }
            // Halt at the first model-response boundary after the trip: the
            // request that produced this message was already made, so its
            // content is discarded rather than streamed as another answer.
            if (stopEnabled && !usageStopped && !msg.parent_tool_use_id && usageGuard.stopped()) {
              const state = usageGuard.state()
              if (!usageStopNoted) yield* usageStopNote(state)
              usageStopped = true
              controller.abort()
              break
            }
            // Subagent messages (Task/Agent tool) run their own conversation; their text
            // and thinking must never enter the main reply. usage above is already
            // top-level-gated; everything below this line is main-session output only.
            if (msg.parent_tool_use_id) continue
            // Whole-block fallback: with partial streaming active the complete
            // assistant message repeats what the deltas already carried, so
            // emit only the not-yet-streamed remainder (all of it when partial
            // streaming is off or produced nothing).
            let msgText = ''
            let msgReasoning = ''
            const toolUses = []
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'text' && block.text) msgText += block.text
              else if (block.type === 'thinking' && block.thinking) msgReasoning += block.thinking
              else if (block.type === 'tool_use') {
                toolUses.push(block)
                if (block.id) toolUseNames.set(block.id, block.name)
                if (block.id && !msg.parent_tool_use_id) runningTools.set(block.id, { name: String(block.name).replace(/^mcp__.+?__/, ''), subject: summarizeToolInput(block.input) })
              }
            }
            const tailText = remainderAfterPartial(msgText, pmText)
            if (tailText) {
              if (!openedText) {
                yield { type: 'block-start', index: 0, blockType: 'text' }
                openedText = true
              }
              text += tailText
              realText += tailText
              yield { type: 'text-delta', index: 0, text: tailText }
            }
            const tailReasoning = remainderAfterPartial(msgReasoning, pmReasoning)
            if (tailReasoning) {
              if (!openedReasoning) {
                yield { type: 'block-start', index: 1, blockType: 'reasoning' }
                openedReasoning = true
              }
              if (heartbeatOpen && !sawThinkingText) {
                reasoning += '\n\n'
                yield { type: 'reasoning-delta', index: 1, text: '\n\n' }
              }
              sawThinkingText = true
              reasoning += tailReasoning
              yield { type: 'reasoning-delta', index: 1, text: tailReasoning }
            }
            // Internal-activity visibility: Claude Code's tool loop is otherwise
            // silent on the DSH side. Emit one lightweight progress line per
            // tool_use on the same text block (index 0). Only here, in the
            // whole-message branch (partials never carry tool blocks, so the
            // pmText dedupe stays untouched), and only for top-level messages
            // (subagent traffic carries parent_tool_use_id). The main isolation
            // already happened above (subagent messages `continue` before
            // reaching here); this guard is kept as redundant defence so the
            // narration stays top-level-only even if that early skip moves.
            // Two narrators share this loop, never both: the legacy
            // showToolProgress line (bare tool name, every non-card tool) and
            // the built-in activity line (tool + subject). showToolProgress
            // wins when explicitly on, so opting into it keeps its exact
            // historical output.
            const legacyProgress = settings.showToolProgress === true
            const builtinActivity = settings.narrateBuiltinTools !== false
            if ((legacyProgress || builtinActivity) && !msg.parent_tool_use_id) {
              for (const toolUse of toolUses) {
                // Bridged DSH tools render a native tool/call+tool/result card
                // (nativeToolCards) — no text narration on top. Claude
                // built-in tools keep the text fallback.
                if (bridge?.rendersCard?.(toolUse.name)) continue
                // Built-ins render the same kind of card, mapped onto the DSH
                // twin (builtin-cards.js); text is only the fallback.
                if (!legacyProgress && openBuiltinCard(toolUse)) continue
                const progress = legacyProgress
                  ? renderToolProgress(toolUse.name)
                  : renderBuiltinToolActivity(toolUse.name, toolUse.input)
                // Channel routing (see DEFAULTS.toolNarrationChannel): the
                // built-in activity narrator defaults to the reasoning block so
                // tool chatter lives in the collapsible 思考 area instead of
                // being glued into the model's prose. showToolProgress keeps
                // its historical text placement byte-for-byte.
                if (!legacyProgress && settings.toolNarrationChannel !== 'text') {
                  if (!openedReasoning) {
                    yield { type: 'block-start', index: 1, blockType: 'reasoning' }
                    openedReasoning = true
                  }
                  reasoning += progress
                  yield { type: 'reasoning-delta', index: 1, text: progress }
                } else {
                  if (!openedText) {
                    yield { type: 'block-start', index: 0, blockType: 'text' }
                    openedText = true
                  }
                  text += progress
                  yield { type: 'text-delta', index: 0, text: progress }
                }
              }
            }
          } else if (msg.type === 'user' && !msg.parent_tool_use_id) {
            // Close the DSH card of every built-in tool that just answered,
            // whatever the narration settings say: an open card spins forever.
            for (const block of msg.message?.content ?? []) {
              if (block?.type === 'tool_result') {
                taskLedger.toolResult(block.tool_use_id, block.is_error === true)
                runningTools.delete(block.tool_use_id)
                closeBuiltinCard(block.tool_use_id, block.content, block.is_error === true)
              }
            }
            // No built-in tool round-trip may fail silently (see
            // renderBuiltinToolErrorNote). Bridged DSH tools already render a
            // native card carrying their own error, so they are skipped here.
            if (settings.narrateBuiltinToolErrors !== false) {
              for (const block of msg.message?.content ?? []) {
                if (block?.type !== 'tool_result') continue
                const toolName = toolUseNames.get(block.tool_use_id)
                if (bridge?.rendersCard?.(toolName)) continue
                if (cardedToolIds.has(block.tool_use_id)) continue
                const resultText = Array.isArray(block.content)
                  ? block.content.map((part) => (part?.type === 'text' ? part.text : '')).join('\n')
                  : typeof block.content === 'string'
                    ? block.content
                    : ''
                // Narrate on an explicit error OR on the unanswered-dialog
                // sentinel, which the CLI reports WITHOUT is_error.
                if (block.is_error !== true && !resultText.includes(UNANSWERED_QUESTION_MARKER)) continue
                const note = renderBuiltinToolErrorNote(toolName, resultText)
                if (!note) continue
                // Same channel as the activity lines (DEFAULTS.toolNarrationChannel):
                // an error note belongs next to the ⚙ line it answers. Driver
                // narration: counted in `reasoning`/`text` (block-end must equal
                // the sum of the deltas) but never in `realText`.
                if (settings.toolNarrationChannel !== 'text') {
                  if (!openedReasoning) {
                    yield { type: 'block-start', index: 1, blockType: 'reasoning' }
                    openedReasoning = true
                  }
                  reasoning += note
                  yield { type: 'reasoning-delta', index: 1, text: note }
                } else {
                  if (!openedText) {
                    yield { type: 'block-start', index: 0, blockType: 'text' }
                    openedText = true
                  }
                  text += note
                  yield { type: 'text-delta', index: 0, text: note }
                }
              }
            }
            // Safe stop boundary: the tool call from the crossing assistant
            // message has returned and its result card is recorded, so the
            // turn can end without cutting work in half.
            if (stopEnabled && !usageStopped && usageGuard.stopped()) {
              const state = usageGuard.state()
              if (state !== null) {
                if (!usageStopNoted) yield* usageStopNote(state)
                usageStopped = true
                controller.abort()
                break
              }
            }
          } else if (msg.type === 'system' && msg.subtype === 'thinking_tokens') {
            // Redacted-thinking liveness (see DEFAULTS.thinkingHeartbeat).
            // These frames are the ONLY signal the API emits while thinking is
            // encrypted; ignoring them is what made a 650-token think look
            // identical to a hang. Skip once real summary text exists — the
            // text itself is then the liveness signal.
            if (settings.thinkingHeartbeat !== false && !sawThinkingText) {
              const estimated = Number(msg.estimated_tokens ?? 0)
              // `estimated_tokens` is the running total for the CURRENT thinking
              // block and resets per block, so accumulate high-water marks
              // rather than trusting the last frame.
              if (estimated > heartbeatTokens) heartbeatTokens = estimated
              const now = Date.now()
              if (!heartbeatOpen) {
                if (!openedReasoning) {
                  yield { type: 'block-start', index: 1, blockType: 'reasoning' }
                  openedReasoning = true
                }
                heartbeatOpen = true
                heartbeatLastAt = now
                const opening = '🤔 Thinking (this turn\'s reasoning is encrypted; only progress is visible)'
                reasoning += opening
                yield { type: 'reasoning-delta', index: 1, text: opening }
              } else if (now - heartbeatLastAt >= 1200) {
                // Append-only stream: a growing dot line is the closest thing
                // to an in-place ticking counter, throttled so a fast think
                // does not spray dozens of marks.
                heartbeatLastAt = now
                reasoning += ' ·'
                yield { type: 'reasoning-delta', index: 1, text: ' ·' }
              }
            }
          } else if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
            // LEVEL signal: swap the whole set (sdk.d.ts documents REPLACE
            // semantics and warns against pairing the edge bookends). `ambient`
            // entries are CLI housekeeping, never user work, so they must not
            // hold a turn open.
            liveBackgroundTasks = (msg.tasks ?? []).filter((task) => task?.ambient !== true && !task?.parent_task_id)
            taskLedger.level(liveBackgroundTasks)
            jobMirror.sync(liveBackgroundTasks)
            // First sight of real background work in this run: drop a
            // write-ahead marker naming this Claude session. A run that ends on
            // its own terms deletes it below; anything left on disk therefore
            // marks a run that did NOT finish — including one killed outright,
            // which is the case no `finally` here would ever observe.
            if (waitForBackground && !atRiskMarked && liveBackgroundTasks.length > 0 && runSessionId) {
              atRiskMarked = true
              try {
                markRunAtRisk(
                  {
                    sessionId: runSessionId,
                    dshSessionId: options?.sessionId ?? null,
                    cwd: runCwd ?? null,
                    markedAt: new Date().toISOString(),
                    tasks: liveBackgroundTasks.map(
                      (task) => task?.description || task?.command || task?.task_id || 'task',
                    ),
                  },
                  settings.harvestOptions ?? {},
                )
              } catch (error) {
                ctx?.logger?.warn?.(
                  `claude-driver: could not mark run at risk: ${String(error?.message ?? error)}`,
                )
              }
            }
          } else if (msg.type === 'driver_pulse' || (msg.type === 'system' && renderClaudeEventNote(msg))) {
            const note = msg.type === 'driver_pulse'
              ? renderPulse(msg, [...runningTools.values()].at(-1))
              : renderClaudeEventNote(msg)
            if (settings.toolNarrationChannel !== 'text') {
              if (!openedReasoning) {
                yield { type: 'block-start', index: 1, blockType: 'reasoning' }
                openedReasoning = true
              }
              reasoning += note
              yield { type: 'reasoning-delta', index: 1, text: note }
            } else {
              if (!openedText) {
                yield { type: 'block-start', index: 0, blockType: 'text' }
                openedText = true
              }
              text += note
              yield { type: 'text-delta', index: 0, text: note }
            }
          } else if (msg.type === 'system' && msg.subtype === 'task_started') {
            taskLedger.started(msg)
            jobMirror.started(msg)
          } else if (msg.type === 'system' && msg.subtype === 'task_progress') {
            jobMirror.progress(msg)
          } else if (msg.type === 'system' && msg.subtype === 'task_notification') {
            jobMirror.notify(msg)
            const outcome = taskLedger.notification(msg, { driverStopping })
            if (outcome) backgroundOutcomes.push(outcome)
          } else if (msg.type === 'result') {
            // The guard tripped during this turn but no later boundary arrived
            // (text-only answer): the turn was already ending, so just leave
            // the same notice and let the result finish normally.
            if (stopEnabled && usageGuard.stopped() && !usageStopNoted) {
              const state = usageGuard.state()
              if (state !== null) yield* usageStopNote(state)
            }
            await persistTurnUsage(ctx, options, msg, turnRequests)
            // Terminal result.usage is CUMULATIVE over every Anthropic API
            // request of this run's internal tool loop (sdk.d.ts 0.3.234
            // :3044 "the turn's ... total usage arrive on the result
            // message", :4635 "per-turn"). Its prompt-side fields can exceed
            // the context window (observed cache_read 486,753 on a 200k
            // model), and DSH's token-meter reads input+cacheRead+cacheWrite
            // as ONE request's prompt occupancy (pressureFrom) — feeding the
            // cumulative values through made the UI clamp 257% to a fake
            // 100%. So prompt-side fields come from lastAssistantUsage (the
            // run's final API request), NEVER from result.usage.
            // outputTokens keeps the terminal cumulative value on purpose:
            // pressureFrom ignores output, and the tokenUsage/stats
            // projections should account for everything the run generated
            // (all of which the driver streamed into this DSH step).
            const usage = msg.usage ?? {}
            outputTokens = Number(usage.output_tokens ?? lastAssistantUsage?.output_tokens ?? 0)
            if (lastAssistantUsage) {
              inputTokens = Number(lastAssistantUsage.input_tokens ?? 0)
              cacheRead = Number(lastAssistantUsage.cache_read_input_tokens ?? 0)
              cacheWrite = Number(lastAssistantUsage.cache_creation_input_tokens ?? 0)
            } else {
              // No per-request sample observed (unexpected). Zeros keep the
              // context meter honest — never backfill the cumulative
              // result.usage prompt fields, which would resurrect the fake
              // 100% reading.
              inputTokens = 0
              cacheRead = 0
              cacheWrite = 0
              ctx?.logger?.warn?.(
                'claude-driver: no top-level assistant usage observed this run; reporting zero prompt-side tokens instead of cumulative result.usage (avoids fake 100% context pressure)',
              )
            }
            if (claudeError !== undefined) {
              // already failed from the typed assistant error above
            } else if (msg.subtype === 'success') {
              // Fallback on model text only: progress lines alone must not
              // suppress recovery of the final result text.
              if (!realText && typeof msg.result === 'string' && msg.result.trim()) {
                const fallback = msg.result.trim()
                realText = fallback
                // Always stream it on block 0. Assigning `text` without
                // opening the block (the previous else-branch) dropped the
                // answer outright: the final block-end at the bottom of this
                // function is guarded by `openedText`, so a turn that streamed
                // no text delta at all — a pure tool loop whose answer lives
                // only in `result` — ended with usage+finish and NO text
                // chunk. Opening here keeps block-end equal to the sum of the
                // deltas in both cases.
                if (!openedText) {
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                  openedText = true
                }
                text += fallback
                yield { type: 'text-delta', index: 0, text: fallback }
              }
            } else {
              const raw =
                typeof msg.result === 'string' && msg.result
                  ? msg.result
                  : typeof msg.error === 'string' && msg.error
                    ? msg.error
                    : Array.isArray(msg.errors) && msg.errors.length
                      ? msg.errors.join('; ')
                      : msg.subtype
              failure = raw
              // error_max_turns is a budget truncation, not a transport/auth
              // failure — track it so we can hand back the partial work below.
              if (msg.subtype === 'error_max_turns' || /max[ _-]?turns?/i.test(String(raw))) maxTurnsHit = true
            }
            sawResult = true
            // Nothing live to wait for (or waiting disabled / already failing /
            // caller aborted): finish the step exactly as the one-shot path did.
            if (!waitForBackground || failure !== undefined || liveBackgroundTasks.length === 0 || signal?.aborted) break
            // Otherwise hold the step open. Tearing the session down here is
            // precisely what kills the tasks, so keep draining the stream until
            // the live set empties, the deadline lapses, or the caller aborts.
            backgroundDeadline = Date.now() + backgroundTimeoutMs
            backgroundTimer = setTimeout(() => {
              backgroundTimedOut = true
              driverStopping = true
              controller.abort()
            }, backgroundTimeoutMs)
            if (typeof backgroundTimer?.unref === 'function') backgroundTimer.unref()
            ctx?.logger?.info?.(
              `claude-driver: holding the step for ${liveBackgroundTasks.length} Claude Code background task(s) (timeout ${backgroundTimeoutMs}ms)`,
            )
            continue
          }
          // Post-result drain: leave as soon as the background work settles, the
          // deadline lapses, or the caller aborts.
          if (sawResult) {
            if (backgroundDeadline > 0 && Date.now() >= backgroundDeadline) backgroundTimedOut = true
            if (backgroundTimedOut || signal?.aborted) break
            if (liveBackgroundTasks.length === 0) {
              // Level empty = the tasks settled, so the hold is over. Allow a
              // bounded window for the trailing `task_notification` edges that
              // name what finished; never block on an edge that may not come.
              if (backgroundOutcomes.length > 0) break
              if (drainDeadline === 0) {
                drainDeadline = Date.now() + BACKGROUND_DRAIN_MS
                drainTimer = setTimeout(() => { driverStopping = true; controller.abort() }, BACKGROUND_DRAIN_MS)
                if (typeof drainTimer?.unref === 'function') drainTimer.unref()
              } else if (Date.now() >= drainDeadline) break
            }
          }
        }
        if (backgroundTimer !== undefined) clearTimeout(backgroundTimer)
        if (drainTimer !== undefined) clearTimeout(drainTimer)
        // This run reached its own end with nothing left in flight, so no
        // subagent was orphaned: retire the marker. Deliberately NOT cleared
        // when we bailed out with work still live (deadline lapsed or caller
        // aborted) — that surviving marker is exactly what the next run
        // harvests.
        if (atRiskMarked && !backgroundTimedOut && !signal?.aborted && liveBackgroundTasks.length === 0) {
          clearRunAtRisk(runSessionId, settings.harvestOptions ?? {})
          atRiskMarked = false
        }
        if (stallGuard.reason() !== undefined && !sawResult && !usageStopped) failure = stallGuard.reason()
        if (failure === undefined && plan.chainKey !== undefined && typeof sdkSessionId === 'string' && sdkSessionId) {
          resumeSessions.set(plan.chainKey, sdkSessionId)
          // Boot the NEXT turn's process now, while the user reads this
          // answer — its ~4s local init happens entirely in their idle time.
          // Still inside the llm/stream call on purpose (the bridge captures
          // this conversation's initiator agent as its card fallback). A
          // usage stop must NOT prewarm: the next turn is refused, and a
          // standing CLI would just idle.
          if (!usageStopped) maybeCreatePrewarm(ctx, options, settings, plan.chainKey, sdkSessionId)
        }
      } catch (error) {
        if (backgroundTimer !== undefined) clearTimeout(backgroundTimer)
        if (drainTimer !== undefined) clearTimeout(drainTimer)
        // A throw AFTER the result was delivered — typically the background-task
        // wait hitting its deadline and aborting the transport — must not turn a
        // completed turn into an error. A usage stop also aborts on purpose: its
        // abort must never surface as a failure.
        if (!sawResult && !usageStopped) failure = stallGuard?.reason() ?? String(error?.message ?? error)
      }
      // Whatever ended the attempt, no built-in tool card may stay open.
      closeStrandedBuiltinCards()
      // Resume target expired/cleared: drop the mapping and retry fresh once —
      // but only if nothing streamed yet (no duplicated output) and the caller
      // did not abort.
      if (
        failure !== undefined &&
        stallGuard?.reason() === undefined &&
        // A typed account/API error is not a stale-resume problem; retrying
        // fresh would only throw away the Claude session.
        claudeError === undefined &&
        plan.mode === 'resume' &&
        attempt === 0 &&
        !openedText &&
        !openedReasoning &&
        !signal?.aborted
      ) {
        resumeSessions.delete(plan.chainKey)
        ctx?.logger?.warn?.(`claude-driver: resume ${plan.resumeId} failed (${failure}); retrying fresh`)
        const freshSegments = renderPromptSegments(options)
        plan = { mode: 'fresh', chainKey: plan.chainKey, prompt: segmentsToText(freshSegments), segments: freshSegments }
        continue
      }
      break
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    // Close the adopted transport explicitly: breaking out of `for await`
    // over the adapter iterable leaves the underlying SDK query (and its CLI
    // child) running. Ordering matters — this run's NEXT prewarm was already
    // spawned above with its own controller, so this abort touches only the
    // finished turn's process.
    detachSteering()
    adoptedEntry?.dispose('run finished')
    jobMirror.closeAll('Claude Code session ended before the task finished')
  }

  // Close the heartbeat line with the thinking volume it was tracking, so the
  // collapsed reasoning block reads as a finished measurement rather than a
  // trail of dots. Only when no summary text ever arrived (otherwise the
  // heartbeat is vestigial history above real content).
  if (heartbeatOpen && !sawThinkingText && heartbeatTokens > 0) {
    const tail = ` ~ ${heartbeatTokens} tokens`
    reasoning += tail
    yield { type: 'reasoning-delta', index: 1, text: tail }
  }

  // Background-task narration: what settled while the step was held open, plus
  // anything still running when the deadline lapsed. Driver-authored, so it is
  // appended to `text` (block-end must equal the sum of the deltas) but never to
  // `realText` — a note alone must not mask an empty model response.
  const backgroundNotes = waitForBackground
    ? renderBackgroundNotes(backgroundOutcomes, liveBackgroundTasks, backgroundTimedOut, backgroundTimeoutMs, { interrupted: signal?.aborted === true && !backgroundTimedOut })
    : { info: '', alert: '' }
  if (failure === undefined || maxTurnsHit) {
    // alert (failed / timed out / still running — output may be lost): always
    // prose. This is the one line the whole feature exists for.
    if (backgroundNotes.alert) {
      if (!openedText) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        openedText = true
      }
      text += backgroundNotes.alert
      yield { type: 'text-delta', index: 0, text: backgroundNotes.alert }
    }
    // info (all-completed settlement list): bookkeeping, not an answer — glued
    // into the prose it reads as noise (user feedback). Same channel routing
    // as the tool narrators (DEFAULTS.toolNarrationChannel): reasoning block
    // by default, prose when 'text' is chosen. Counted in `reasoning`/`text`
    // (block-end must equal the sum of the deltas) but never in `realText`.
    if (backgroundNotes.info) {
      if (settings.toolNarrationChannel !== 'text') {
        if (!openedReasoning) {
          yield { type: 'block-start', index: 1, blockType: 'reasoning' }
          openedReasoning = true
        }
        reasoning += backgroundNotes.info
        yield { type: 'reasoning-delta', index: 1, text: backgroundNotes.info }
      } else {
        if (!openedText) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          openedText = true
        }
        text += backgroundNotes.info
        yield { type: 'text-delta', index: 0, text: backgroundNotes.info }
      }
    }
  }

  // The guard ended this turn at a boundary. The notice is already in the
  // prose; report a normal stop (never an abort/error) so DSH does not mark
  // the conversation failed.
  if (usageStopped) {
    if (openedText) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (openedReasoning) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
    yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  // Truncation (error_max_turns) is not a hard failure: Claude Code already
  // produced partial output before running out of its internal turn budget.
  // Hand back that partial answer with a note instead of discarding it.
  if (maxTurnsHit && realText.trim()) {
    const note = `\n\n[Claude Code hit this step's ${settings.maxTurns ?? '?'}-turn internal limit; the answer above is what was completed and may be incomplete.]`
    if (!openedText) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      openedText = true
    }
    text += note
    yield { type: 'text-delta', index: 0, text: note }
    if (openedText) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (openedReasoning) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
    yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  if (failure !== undefined) {
    const aborted = signal?.aborted || /abort/i.test(String(failure))
    yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
    yield {
      type: 'finish',
      reason: aborted
        ? { kind: 'aborted', failure: { message: String(failure), code: 'ABORTED' } }
        : { kind: 'error', failure: { message: String(failure), code: classifyFailure(failure, claudeError) } },
    }
    return
  }

  // Judge emptiness on model text only: a progress-only body (tool loop ran but
  // produced no answer) is still an empty response, exactly as before.
  if (!realText.trim()) {
    yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'claude-code returned an empty response', code: 'EMPTY_RESPONSE' } },
    }
    return
  }

  if (openedText) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  if (openedReasoning) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
  yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
