// DSH compaction on a claude-code session = Claude's own /compact on the LIVE
// Claude session (same session id). Claude's summary becomes DSH's summary, so
// both sides hold the same condensed context and the next turn simply resumes.
// Any failure returns undefined and the caller falls back to a one-shot summary.
import { contextWatch } from './context-autocompact.js'
import { createStallGuard } from './stall-guard.js'

// Claude sessions that are compacted and have not run a turn since:
// dshSessionId -> { claudeSessionId, summary, usage }. DSH may ask again before a
// turn (a retry of a rejected attempt, or another pass right after committing);
// Claude's context is already condensed, so the same summary is the answer.
const compactedSessions = new Map()

export function wasNativelyCompacted(dshSessionId, claudeSessionId) {
  return compactedSessions.get(dshSessionId)?.claudeSessionId === claudeSessionId
}

export function forgetNativeCompaction(dshSessionId) {
  compactedSessions.delete(dshSessionId)
}

// A real turn ran on this session: its context grew again.
export function noteTurnRan(dshSessionId) {
  compactedSessions.delete(dshSessionId)
}

export async function runNativeCompaction({ runQuery, sdkOptions, settings, dshSessionId, claudeSessionId, logger }) {
  const pending = compactedSessions.get(dshSessionId)
  if (pending?.claudeSessionId === claudeSessionId) return { summary: pending.summary, usage: pending.usage }
  let summary
  let boundary
  let failure
  const controller = sdkOptions.abortController ?? new AbortController()
  const postCompact = async (input) => {
    if (typeof input?.compact_summary === 'string') summary = input.compact_summary
    return {}
  }
  const options = {
    ...sdkOptions,
    abortController: controller,
    resume: claudeSessionId,
    maxTurns: 1,
    hooks: { ...(sdkOptions.hooks ?? {}), PostCompact: [...(sdkOptions.hooks?.PostCompact ?? []), { hooks: [postCompact] }] },
  }
  const guard = createStallGuard(settings, () => controller.abort())
  let usage
  try {
    for await (const msg of guard.guard(runQuery({ prompt: '/compact', options }))) {
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') boundary = msg.compact_metadata
      if (msg.type === 'result') {
        usage = msg.usage
        if (msg.is_error || msg.subtype !== 'success') failure = (msg.errors ?? []).join('; ') || msg.subtype
      }
    }
  } catch (error) {
    failure = String(error?.message ?? error)
  } finally {
    controller.abort()
  }
  failure ??= guard.reason()
  if (failure === undefined && !boundary) failure = 'Claude Code did not compact (no compact_boundary)'
  if (failure === undefined && !summary?.trim()) failure = 'Claude Code compacted but reported no summary'
  if (failure !== undefined) {
    logger?.warn?.(`claude-driver: native /compact on ${claudeSessionId} failed (${failure}); falling back to a one-shot summary`)
    compactedSessions.delete(dshSessionId)
    return undefined
  }
  compactedSessions.set(dshSessionId, { claudeSessionId, summary: summary.trim(), usage })
  // The live context just shrank: keep the token autocompaction watch in sync
  // and disarmed until a later turn reports a context below its threshold.
  contextWatch.markCompacted(dshSessionId, boundary.post_tokens)
  logger?.info?.(`claude-driver: Claude Code session ${claudeSessionId} compacted natively (${boundary.pre_tokens} -> ${boundary.post_tokens ?? '?'} tokens)`)
  return { summary: summary.trim(), usage }
}
