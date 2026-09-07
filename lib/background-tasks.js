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
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
    await new Promise(() => {})
  })()
}

// Driver-authored narration for background tasks that outlived the run's
// reply. Never counted as model text (same rule as tool-progress lines), so
// it can neither mask an empty response nor suppress the result fallback.
export function renderBackgroundNote(outcomes, stillRunning, timedOut, timeoutMs) {
  const parts = []
  if (outcomes.length) {
    const settled = outcomes
      .map((entry) => `${entry.summary || entry.taskId || 'task'}（${entry.status}）`)
      .join('；')
    parts.push(`后台任务已结束：${settled}`)
  }
  if (stillRunning.length) {
    const names = stillRunning.map((task) => task?.description || task?.command || task?.task_id || 'task').join('；')
    parts.push(
      timedOut
        ? `后台任务超过 ${Math.round((timeoutMs ?? 0) / 1000)}s 上限，本轮先结束（可能已被终止）：${names}`
        : `后台任务仍在运行：${names}`,
    )
  }
  if (!parts.length) return ''
  return `\n\n[Claude Code ${parts.join('；')}]`
}
