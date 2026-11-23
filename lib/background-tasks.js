// Shared helpers for sparing Claude Code's OWN background tasks (Bash
// `run_in_background`, backgrounded subagents/workflows) from being killed
// when a driven run ends.
//
// Measured on SDK 0.3.252: a 15s background task started by the model is
// killed ~3-5s after the run's `result`, so a task Claude Code reported as
// "running in the background" silently dies and its output is never
// collected. Sparing it requires ALL THREE, simultaneously:
//   1. streaming input (stdin stays open — the string `prompt` form is a
//      one-shot run the CLI fails closed on);
//   2. `perTaskStopAffordance` declared in the SDK query options;
//   3. not tearing the run's session down while tasks are still live.
// See CHANGELOG.md [0.3.0] for the experiment that pinned these three down.
//
// Used by both the main-model takeover (index.js's `waitForBackgroundTasks`
// step-holding loop) and the `claude-code` subagent provider
// (subagent-provider.js) — the same CLI-process lifetime hazard applies to
// every `query()` call this driver makes, not just the main-session route.

// Grace window (ms) for trailing `task_notification` edges after the
// background level signal goes empty. The CLI emits the notification right
// behind the level change (observed same-tick), but the level is the
// authoritative "nothing is live" signal, so a wait must not depend on an
// edge that may never come.
export const BACKGROUND_DRAIN_MS = 1500

// One user message as an OPEN-ENDED AsyncIterable: after yielding it the
// iterable stays pending, so the CLI keeps stdin open (interactive stream-json)
// instead of treating the run as one-shot. Required for Claude Code's own
// background tasks to survive the turn — with stdin closed the CLI fails closed
// and kills them when the result is released (sdk.d.ts perTaskStopAffordance).
// The pending tail is released when the consumer stops iterating the query.
export function openEndedPrompt(content) {
  const pending = []
  let wake
  const iterable = (async function* () {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
    while (true) {
      while (pending.length) yield pending.shift()
      await new Promise((resolve) => {
        wake = resolve
      })
    }
  })()
  // Mid-turn input (steering); see steering.js.
  iterable.push = (message) => {
    pending.push(message)
    wake?.()
    wake = undefined
  }
  return iterable
}

export const MAX_TASK_SUMMARY_CHARS = 80

// CLI task_notification.summary is a one-line status for shell tasks but the
// FULL agent report for Task/Agent tasks. This narration is a status line, so
// keep only the first non-empty line, hard-capped — never the whole payload.
export function briefTaskSummary(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const first = (s.split(/\r?\n/).find((line) => line.trim() !== '') ?? '').trim()
  const capped = first.length > MAX_TASK_SUMMARY_CHARS
    ? `${first.slice(0, MAX_TASK_SUMMARY_CHARS)}…`
    : first
  // Anything dropped — later lines, or a cut first line — gets one ellipsis.
  return capped.length < s.length && !capped.endsWith('…') ? `${capped}…` : capped
}

const settledLine = (entries) =>
  entries.map((entry) => `${briefTaskSummary(entry.summary) || entry.taskId || 'task'} (${entry.status})`).join('; ')

const stillRunningPart = (stillRunning, timedOut, timeoutMs, interrupted = false) => {
  const names = stillRunning.map((task) => task?.description || task?.command || task?.task_id || 'task').join('; ')
  // Interrupting the turn tears Claude's process down, so its tasks die with it.
  if (interrupted) return `Turn interrupted; background tasks ended with it: ${names}`
  return timedOut
    ? `Background tasks exceeded the ${Math.round((timeoutMs ?? 0) / 1000)}s hold; the turn ended first (they may have been terminated): ${names}`
    : `Background tasks still running: ${names}`
}

// Driver-authored narration for background tasks that outlived the run's
// reply. Never counted as model text (same rule as tool-progress lines), so
// it can neither mask an empty response nor suppress the result fallback.
//
// Legacy single-channel form: everything in one bracket. Kept byte-for-byte
// for the subagent provider, where the note is DATA read by the parent agent
// (it needs the full settlement picture in the collected text), not UI.
export function renderBackgroundNote(outcomes, stillRunning, timedOut, timeoutMs) {
  const parts = []
  const shown = outcomes.filter((entry) => entry.byDriver !== true)
  const failed = shown.filter((entry) => entry.status !== 'completed' && entry.status !== 'stopped')
  const stopped = shown.filter((entry) => entry.status === 'stopped')
  const ok = shown.filter((entry) => entry.status === 'completed')
  // Byte-for-byte legacy wording when everything completed.
  if (ok.length && !failed.length && !stopped.length) parts.push(`Background tasks finished: ${settledLine(ok)}`)
  else {
    if (ok.length) parts.push(`Background tasks finished: ${settledLine(ok)}`)
    if (failed.length) parts.push(`Background tasks failed: ${settledLine(failed)}`)
    if (stopped.length) parts.push(`Background tasks stopped: ${settledLine(stopped)}`)
  }
  if (stillRunning.length) parts.push(stillRunningPart(stillRunning, timedOut, timeoutMs))
  if (!parts.length) return ''
  return `\n\n[Claude Code ${parts.join('; ')}]`
}

// Severity-split form for the MAIN session, where the note is UI: an
// all-completed settlement list is bookkeeping the user asked us to stop
// gluing into the reply, but a failure / timeout / still-running task means
// output may have been lost and MUST stay visible in the prose.
//   info  — completed outcomes only (routed to the collapsible reasoning
//           block by default; see index.js toolNarrationChannel)
//   alert — non-completed outcomes + anything still running at the deadline
//           (always prose)
export function renderBackgroundNotes(outcomes, stillRunning, timedOut, timeoutMs, { interrupted = false } = {}) {
  // A task the driver itself stopped (turn deadline / drain) was not a failure
  // and the user did not ask for it; the still-running line already says so.
  const shown = outcomes.filter((entry) => entry.byDriver !== true)
  const ok = shown.filter((entry) => entry.status === 'completed')
  const stopped = shown.filter((entry) => entry.status === 'stopped')
  const failed = shown.filter((entry) => entry.status !== 'completed' && entry.status !== 'stopped')
  const alertParts = []
  if (failed.length) alertParts.push(`Background tasks failed: ${settledLine(failed)}`)
  if (stopped.length) alertParts.push(`Background tasks stopped: ${settledLine(stopped)}`)
  if (stillRunning.length) alertParts.push(stillRunningPart(stillRunning, timedOut, timeoutMs, interrupted))
  return {
    info: ok.length ? `\n\n[Claude Code background tasks finished: ${settledLine(ok)}]` : '',
    alert: alertParts.length ? `\n\n[Claude Code ${alertParts.join('; ')}]` : '',
  }
}
