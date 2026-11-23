// Five-hour plan-window guard.
//
// The 5-hour window is account-wide, so one session can exhaust the quota for
// every other session. At the configured utilization (95% by default) a running
// turn stops at its next safe boundary (an in-flight tool still finishes and its
// result is kept), the live Claude session is compacted once, and no new Claude
// turn runs until the window resets. A goal paused by the stop stays paused.
import { currentSession } from './permission-sync.js'

export const DEFAULT_STOP_PERCENT = 95
export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000

/** A usable percentage, or null when the guard is disabled/misconfigured. */
export function normalizeStopPercent(value) {
  if (value === false || value === null || value === undefined) return null
  const percent = Number(value)
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : null
}

function fiveHourOf(snapshot) {
  if (snapshot?.ok !== true) return undefined
  const window = snapshot.windows?.fiveHour
  return Number.isFinite(window?.percent) ? window : undefined
}

// A reading whose resets_at already passed describes the PREVIOUS window, so it
// must not re-trigger the stop. A missing resets_at expires one window later.
function resetAtMsOf(window, nowMs) {
  const raw = window?.resetsAt
  if (typeof raw === 'string' && raw) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed > nowMs ? parsed : null
  }
  return nowMs + FIVE_HOUR_WINDOW_MS
}

/**
 * Whether one plan-usage snapshot is at or over the stop threshold.
 * @param snapshot - the store's `{ ok, windows }` snapshot.
 * @param options - threshold, clock, and (optional) explicit "now".
 */
export function stopDecision(snapshot, { stopAtPercent = DEFAULT_STOP_PERCENT, nowMs = Date.now() } = {}) {
  const threshold = normalizeStopPercent(stopAtPercent)
  if (threshold === null) return { stop: false }
  const window = fiveHourOf(snapshot)
  if (window === undefined || window.percent < threshold) return { stop: false }
  const resetsAtMs = resetAtMsOf(window, nowMs)
  if (resetsAtMs === null) return { stop: false, stale: true }
  return { stop: true, percent: window.percent, resetsAtMs, resetsAt: window.resetsAt ?? null }
}

function resetIn(ms) {
  const minutes = Math.round(ms / 60_000)
  if (!Number.isFinite(minutes) || minutes <= 0) return ''
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * The user-facing stop notice. `blocked` is the whole-turn refusal, the other
 * form is appended to a turn the guard ended.
 * @param decision - a tripped stop decision/state.
 * @param options - threshold, clock, and blocked-vs-ended wording.
 */
export function formatStopNotice(decision, { stopAtPercent = DEFAULT_STOP_PERCENT, nowMs = Date.now(), blocked = false } = {}) {
  const reading = Math.round(Number(decision?.percent ?? 0))
  const threshold = Math.round(Number(stopAtPercent))
  const wait = resetIn(Number(decision?.resetsAtMs ?? 0) - nowMs)
  const head = blocked ? 'Claude Code is paused' : 'Claude Code stopped this turn'
  return `${head}: the 5-hour usage window is at ${reading}% (stop threshold ${threshold}%). ${
    wait ? `It resets in ${wait}; t` : 'T'
  }urns resume after the window resets.`
}

/**
 * Process-local stop latch. One instance covers every session in the host
 * because the quota is account-wide.
 * @param options - test seam for the clock.
 */
export function createUsageGuard({ now = Date.now } = {}) {
  let state = null
  const live = () => {
    if (state !== null && now() >= state.resetsAtMs) state = null
    return state
  }
  return {
    /**
     * Fold one usage snapshot. Returns `{ stop: true }` only on the transition
     * into the stopped state, so callers side-effect once (goal pause, log).
     */
    observe(snapshot, { sessionId, stopAtPercent = DEFAULT_STOP_PERCENT } = {}) {
      if (live() !== null) return { stop: false, already: true }
      const decision = stopDecision(snapshot, { stopAtPercent, nowMs: now() })
      if (!decision.stop) return decision
      state = {
        percent: decision.percent,
        resetsAtMs: decision.resetsAtMs,
        resetsAt: decision.resetsAt,
        sessionId,
        stoppedAtMs: now(),
        compactionPending: true,
      }
      return decision
    },
    stopped() {
      return live() !== null
    },
    state() {
      return live() === null ? null : { ...state }
    },
    /**
     * Claim the one compaction owed for this trip. Only the session whose turn
     * tripped is eligible, so an unrelated turn/end cannot spend it.
     */
    takeCompaction(sessionId) {
      const stopped = live()
      if (stopped === null || !stopped.compactionPending) return false
      if (sessionId !== undefined && stopped.sessionId !== undefined && sessionId !== stopped.sessionId) return false
      stopped.compactionPending = false
      return true
    },
    reset() {
      state = null
    },
  }
}

export const usageGuard = createUsageGuard()

/** Session id for the turn the driver is serving, if any. */
export function sessionIdFor(ctx, options) {
  return currentSession(ctx)?.id ?? (typeof options?.sessionId === 'string' ? options.sessionId : undefined)
}

/**
 * Pause the session's active goal when the guard trips: an armed goal would
 * otherwise start another round against a stopped guard.
 */
export function pauseGoalForStop(ctx, sessionId, logger = ctx?.logger) {
  try {
    const agents = ctx?.get?.('agents')
    const agent = (sessionId === undefined ? undefined : agents?.get?.(sessionId)) ?? agents?.currentInitiator?.()
    if (!agent) return false
    const goal = ctx?.get?.('goals')?.get?.(agent)
    if (!goal || goal.phase !== 'active') return false
    ctx.get('goals').pause(agent, { id: goal.id, revision: goal.revision })
    logger?.info?.(`claude-driver: paused goal ${goal.id} at the 5-hour usage stop`)
    return true
  } catch (error) {
    logger?.warn?.(`claude-driver: could not pause the goal at the usage stop: ${String(error?.message ?? error)}`)
    return false
  }
}

/**
 * Compact the session that tripped the stop, once. `compactNow` needs an idle
 * agent, and `turn/end` publishes before the agent leaves its running phase, so
 * a busy attempt is retried with backoff.
 */
export async function compactStoppedSession(ctx, { sessionId } = {}, settings = {}, { retryDelayMs = 250, attempts = 5 } = {}) {
  if (!usageGuard.takeCompaction(sessionId)) return false
  const logger = ctx?.logger
  if (settings.usageStopCompaction === false) {
    logger?.info?.(`claude-driver: usage stop on ${sessionId}; compaction disabled`)
    return false
  }
  const compaction = ctx?.get?.('compaction')
  const agent = ctx?.get?.('agents')?.get?.(sessionId)
  if (!compaction || typeof compaction.compactNow !== 'function') {
    logger?.warn?.(`claude-driver: usage stop on ${sessionId}; no compaction service is mounted`)
    return false
  }
  if (!agent) {
    logger?.warn?.(`claude-driver: usage stop on ${sessionId}; no live agent to compact`)
    return false
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await compaction.compactNow(agent, new AbortController().signal)
      logger?.info?.(`claude-driver: compacted ${sessionId} after the 5-hour usage stop`)
      return true
    } catch (error) {
      const busy = error?.code === 'busy'
      if (!busy || attempt === attempts - 1) {
        logger?.warn?.(`claude-driver: stop compaction for ${sessionId} failed: ${String(error?.message ?? error)}`)
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
