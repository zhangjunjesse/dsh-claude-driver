// Native context autocompaction for claude-code sessions.
//
// A finished turn reports the prompt occupancy of its final Claude request
// (input + cache read + cache write) as its usage chunk. Once that number
// reaches the configured `compactAtTokens` threshold, the next turn end runs
// DSH's compaction service, which drives Claude's own `/compact` on the live
// session (the same native path a manual /compact takes). The watch fires once
// per crossing and re-arms only after a turn reports a context below the
// threshold, so a compaction that leaves the summary plus a tail above the line
// cannot loop.
import { usageGuard } from './usage-guard.js'

export const MIN_CONTEXT_COMPACT_TOKENS = 10_000
export const MAX_CONTEXT_COMPACT_TOKENS = 2_000_000

/**
 * A usable token threshold, or null when the option is off/misconfigured.
 * 0 and false disable it explicitly; values are floored to whole tokens.
 */
export function normalizeCompactAtTokens(value) {
  if (value === false || value === null || value === undefined) return null
  const tokens = Number(value)
  if (!Number.isFinite(tokens) || tokens < MIN_CONTEXT_COMPACT_TOKENS || tokens > MAX_CONTEXT_COMPACT_TOKENS) return null
  return Math.floor(tokens)
}

/**
 * Per-session crossing state: the last reported context and whether a crossing
 * is still owed a compaction.
 */
export function createContextWatch() {
  const sessions = new Map()
  return {
    /**
     * Fold one finished turn's context occupancy.
     * A first observation over the line counts as a crossing; after a
     * compaction (armed=false) a later over-the-line reading does not re-arm.
     */
    note(sessionId, tokens, threshold) {
      if (typeof sessionId !== 'string' || !sessionId || threshold === null) return
      const value = Number(tokens)
      if (!Number.isFinite(value) || value < 0) return
      const previous = sessions.get(sessionId)
      const armed = value < threshold ? true : (previous?.armed ?? true)
      sessions.set(sessionId, { tokens: Math.floor(value), armed })
    },
    /** Claim the compaction owed for this crossing. */
    take(sessionId, threshold) {
      const state = sessions.get(sessionId)
      if (!state || threshold === null || !state.armed || state.tokens < threshold) return false
      state.armed = false
      return true
    },
    /** Owe the crossing again (a failed compaction is retried on a later turn). */
    rearm(sessionId) {
      const state = sessions.get(sessionId)
      if (state) state.armed = true
    },
    /** A compaction succeeded: record what the live context shrank to. */
    markCompacted(sessionId, postTokens = 0) {
      const value = Number(postTokens)
      sessions.set(sessionId, { tokens: Number.isFinite(value) && value > 0 ? Math.floor(value) : 0, armed: false })
    },
    /** A fresh Claude session (non-native compaction dropped the chain). */
    reset(sessionId) {
      sessions.delete(sessionId)
    },
    /** Test/diagnostic access. */
    get(sessionId) {
      const state = sessions.get(sessionId)
      return state ? { ...state } : undefined
    },
    clear() {
      sessions.clear()
    },
  }
}

export const contextWatch = createContextWatch()

/**
 * Compact the session at its token threshold, once, using the same compaction
 * service a manual /compact uses (Claude's native /compact on the live session).
 * Requires the native path; without it the option warns once per crossing and
 * spends nothing, leaving automatic compaction to DSH.
 *
 * @param ctx - driver context (agents + compaction services).
 * @param sessionId - the DSH session whose turn just ended.
 * @param settings - merged driver settings (compactAtTokens, nativeCompaction, resumeChain).
 */
export async function compactContextIfDue(ctx, { sessionId } = {}, settings = {}, { retryDelayMs = 250, attempts = 3 } = {}) {
  const threshold = normalizeCompactAtTokens(settings.compactAtTokens)
  if (threshold === null || typeof sessionId !== 'string' || !sessionId) return false
  // The plan-window stop has its own compaction; never spend two here.
  if (usageGuard.stopped()) return false
  const nativeUnavailable = settings.nativeCompaction === false || settings.resumeChain === false
  if (nativeUnavailable) {
    if (!contextWatch.take(sessionId, threshold)) return false
    ctx?.logger?.warn?.(
      `claude-driver: compactAtTokens is set for ${sessionId} but Claude native compaction is unavailable (nativeCompaction=${settings.nativeCompaction}, resumeChain=${settings.resumeChain}); not spending a summary request`,
    )
    return false
  }
  const agent = ctx?.get?.('agents')?.get?.(sessionId)
  const compaction = ctx?.get?.('compaction')
  if (!agent || !compaction || typeof compaction.compactNow !== 'function') return false
  // Only compact a session that is actually on this route: a stale watch from
  // before a model switch must not drive another provider's compaction.
  const route = agent.session?.requestHeader?.()?.config ?? agent.options
  if (route?.provider !== undefined && route.provider !== settings.provider) return false
  if (!contextWatch.take(sessionId, threshold)) return false
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await compaction.compactNow(agent, new AbortController().signal)
      ctx?.logger?.info?.(`claude-driver: compacted ${sessionId} natively at the ${threshold}-token context threshold`)
      return true
    } catch (error) {
      const busy = error?.code === 'busy'
      if (!busy || attempt === attempts - 1) {
        // Leave the crossing owed so a later turn retries instead of silently
        // dropping the threshold.
        contextWatch.rearm(sessionId)
        ctx?.logger?.warn?.(`claude-driver: context compaction for ${sessionId} failed: ${String(error?.message ?? error)}`)
        return false
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, retryDelayMs * 2 ** attempt)
        timer.unref?.()
      })
    }
  }
  return false
}
