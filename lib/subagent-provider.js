import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeExecutable } from './claude-executable.js'
import { BACKGROUND_DRAIN_MS, openEndedPrompt, renderBackgroundNote } from './background-tasks.js'

const CLIENT_APP = 'dsh-claude-driver/0.1.0'

const NO_START_CAPABILITIES = Object.freeze({
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

function envWithProxy(proxy) {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP }
  if (proxy) {
    env.HTTPS_PROXY = proxy
    env.HTTP_PROXY = proxy
    env.ALL_PROXY = proxy
    env.NO_PROXY = 'localhost,127.0.0.1,::1'
  }
  return env
}

function isEnterableDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Mirror of dsh-subagent's resolveChildCwd semantics: configured override, else
// the delegating parent session's workspace cwd; fail loud instead of silently
// binding the child to the harness launch directory.
function resolveChildCwd(configured, parentCwd) {
  if (configured !== undefined) {
    if (!isAbsolute(configured) || !isEnterableDirectory(configured)) {
      throw new Error(`claude-code provider: config cwd is not an accessible absolute directory: ${configured}`)
    }
    return configured
  }
  if (typeof parentCwd !== 'string' || !isEnterableDirectory(parentCwd)) {
    throw new Error('claude-code provider: no working directory — configure `cwd` or delegate from a parent session that has one')
  }
  return parentCwd
}

function promptText(request) {
  const blocks = Array.isArray(request?.prompt) ? request.prompt : []
  return blocks
    .map((block) => (block?.type === 'text' && block.text ? block.text : JSON.stringify(block)))
    .join('\n\n')
}

/**
 * The `claude-code` SubagentProvider (fills the seam reserved by the shipped
 * `tool-subagent-claude-code` preset row). One delegation = one official Claude
 * Agent SDK query. The result promise never rejects: cancellation settles as
 * `stopReason: 'aborted'`, failures as `'error'`, success as `'completed'`.
 *
 * `localAgent` is always `undefined` here by design, not a gap: this provider
 * spawns an out-of-process Claude Code CLI (a "remote" provider in
 * @deepseek-ai/dsh-subagent's terms), so there is no local DSH child
 * session/Agent to expose. Per that package's README ("远程提供方...返回
 * localAgent: undefined；由于没有本地 child 会话，其一次性运行不会进入基于
 * 追踪的枚举结果"), remote runs are therefore never enumerated by
 * list_agents/listChildren — the same documented limitation the framework
 * calls out for its other remote (ACP) provider. That is why a claude-code
 * delegation does not show up in a live agent-tracking UI and instead
 * surfaces only as this tool call's own result in the delegating session.
 */
export function createClaudeCodeProvider(settings = {}) {
  const config = {
    model: 'fable',
    permissionMode: 'acceptEdits',
    maxTurns: 100,
    effort: 'high',
    proxy: 'http://127.0.0.1:7897',
    cwd: undefined,
    pathToClaudeCodeExecutable: undefined,
    // Same fix as the main-model takeover's `waitForBackgroundTasks` (see
    // background-tasks.js and CHANGELOG.md [0.3.0]): left at the SDK's
    // one-shot default, Claude Code kills its own `run_in_background` work
    // ~3-5s after this call's `result`, so a delegated run that kicked off
    // background work silently comes back incomplete — indistinguishable
    // from "delegation failed" from the caller's side. Sharing settings with
    // the main plugin config means a profile that already set these for the
    // main route gets the same behavior here for free.
    waitForBackgroundTasks: true,
    backgroundTaskTimeoutMs: 300000,
    // Test seam: inject a fake SDK query (no network) via settings.queryImpl.
    queryImpl: undefined,
    ...settings,
  }
  const runQuery = typeof config.queryImpl === 'function' ? config.queryImpl : query
  return {
    name: 'claude-code',
    inheritsParentContext: false,
    capabilities: NO_START_CAPABILITIES,
    async start(request) {
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      request?.signal?.addEventListener('abort', onAbort, { once: true })

      const cwd = resolveChildCwd(config.cwd, request?.parent?.session?.meta?.cwd)
      let disposal
      const runId = `claude-code-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
      const waitForBackground = config.waitForBackgroundTasks !== false
      const backgroundTimeoutMs = Number(config.backgroundTaskTimeoutMs ?? 300000)

      const result = (async () => {
        let output = ''
        // Background-task bookkeeping — same contract as the main-model loop
        // (see background-tasks.js): `liveBackgroundTasks` mirrors the CLI's
        // `background_tasks_changed` LEVEL signal (REPLACE semantics),
        // `backgroundOutcomes` collects `task_notification` edges.
        let liveBackgroundTasks = []
        let backgroundOutcomes = []
        let backgroundTimedOut = false
        let sawResult = false
        let settled // {stopReason, detail?} captured at `result`, returned once background work settles
        let backgroundDeadline = 0
        let backgroundTimer
        let drainDeadline = 0
        let drainTimer
        try {
          try {
            const sdkOptions = {
              cwd,
              model: config.model,
              permissionMode: config.permissionMode,
              maxTurns: config.maxTurns,
              effort: config.effort,
              abortController: controller,
              env: envWithProxy(config.proxy),
            }
            // Declares a per-task stop affordance, which is what lets the CLI
            // spare running background tasks instead of failing closed on
            // them. Only meaningful together with the open-input prompt below.
            if (waitForBackground) sdkOptions.perTaskStopAffordance = true
            const executable = resolveClaudeExecutable(config.pathToClaudeCodeExecutable)
            if (executable) sdkOptions.pathToClaudeCodeExecutable = executable
            const promptInput = waitForBackground
              ? openEndedPrompt([{ type: 'text', text: promptText(request) }])
              : promptText(request)
            const q = runQuery({
              prompt: promptInput,
              options: sdkOptions,
            })
            for await (const msg of q) {
              if (msg.type === 'assistant' && !msg.error) {
                for (const block of msg.message?.content ?? []) {
                  if (block.type === 'text' && block.text) output += block.text
                }
              } else if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
                // LEVEL signal: swap the whole set (REPLACE semantics).
                // `ambient` entries are CLI housekeeping, never delegated
                // work, so they must not hold the run open.
                liveBackgroundTasks = (msg.tasks ?? []).filter((task) => task?.ambient !== true)
              } else if (msg.type === 'system' && msg.subtype === 'task_notification') {
                if (msg.ambient !== true) {
                  backgroundOutcomes.push({
                    taskId: msg.task_id,
                    status: msg.status,
                    summary: typeof msg.summary === 'string' ? msg.summary : '',
                  })
                }
              } else if (msg.type === 'result') {
                if (msg.subtype === 'success') {
                  if (!output && typeof msg.result === 'string' && msg.result.trim()) output = msg.result
                  settled = { stopReason: 'completed' }
                } else {
                  const detail = typeof msg.result === 'string' && msg.result ? msg.result : msg.error ?? msg.subtype
                  settled = {
                    stopReason: controller.signal.aborted ? 'aborted' : 'error',
                    ...(detail !== undefined ? { detail: String(detail) } : {}),
                  }
                }
                sawResult = true
                // Nothing live to wait for (or waiting disabled / already
                // failing / caller aborted): finish exactly as the one-shot
                // path did.
                if (
                  !waitForBackground ||
                  settled.stopReason !== 'completed' ||
                  liveBackgroundTasks.length === 0 ||
                  controller.signal.aborted
                ) {
                  break
                }
                // Otherwise hold the run open. Tearing it down here is
                // precisely what kills the tasks, so keep draining the
                // stream until the live set empties, the deadline lapses, or
                // the caller aborts.
                backgroundDeadline = Date.now() + backgroundTimeoutMs
                backgroundTimer = setTimeout(() => {
                  backgroundTimedOut = true
                  controller.abort()
                }, backgroundTimeoutMs)
                if (typeof backgroundTimer?.unref === 'function') backgroundTimer.unref()
                continue
              }
              // Post-result drain: leave as soon as the background work
              // settles, the deadline lapses, or the caller aborts.
              if (sawResult) {
                if (backgroundDeadline > 0 && Date.now() >= backgroundDeadline) backgroundTimedOut = true
                if (backgroundTimedOut || controller.signal.aborted) break
                if (liveBackgroundTasks.length === 0) {
                  // Level empty = the tasks settled. Allow a bounded window
                  // for the trailing `task_notification` edges that name
                  // what finished; never block on an edge that may not come.
                  if (backgroundOutcomes.length > 0) break
                  if (drainDeadline === 0) {
                    drainDeadline = Date.now() + BACKGROUND_DRAIN_MS
                    drainTimer = setTimeout(() => controller.abort(), BACKGROUND_DRAIN_MS)
                    if (typeof drainTimer?.unref === 'function') drainTimer.unref()
                  } else if (Date.now() >= drainDeadline) {
                    break
                  }
                }
              }
            }
          } catch (error) {
            // A throw AFTER `result` arrived is typically the background-task
            // wait hitting its deadline/abort — must not turn a completed run
            // into a failure.
            if (!sawResult) throw error
          } finally {
            if (backgroundTimer !== undefined) clearTimeout(backgroundTimer)
            if (drainTimer !== undefined) clearTimeout(drainTimer)
          }
          if (!sawResult) {
            return { output: output.trim() ? [{ type: 'text', text: output.trim() }] : [], stopReason: 'completed' }
          }
          // Background-task narration, success only — a note must never
          // paper over (or be attached to) a failed run.
          const note =
            waitForBackground && settled.stopReason === 'completed'
              ? renderBackgroundNote(backgroundOutcomes, liveBackgroundTasks, backgroundTimedOut, backgroundTimeoutMs)
              : ''
          const finalText = `${output.trim()}${note}`.trim()
          return {
            output: finalText ? [{ type: 'text', text: finalText }] : [],
            stopReason: settled.stopReason,
            ...(settled.detail !== undefined ? { detail: settled.detail } : {}),
          }
        } catch (error) {
          return {
            output: output.trim() ? [{ type: 'text', text: output.trim() }] : [],
            stopReason: controller.signal.aborted ? 'aborted' : 'error',
            detail: String(error?.message ?? error),
          }
        } finally {
          request?.signal?.removeEventListener('abort', onAbort)
        }
      })()

      return {
        id: runId,
        localAgent: undefined,
        result,
        dispose() {
          if (disposal !== undefined) return disposal
          request?.signal?.removeEventListener('abort', onAbort)
          controller.abort()
          disposal = Promise.resolve()
          return disposal
        },
      }
    },
  }
}
