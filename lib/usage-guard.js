// Five-hour plan-window guard.
//
// The 5-hour window is account-wide, so one session can exhaust the quota for
// every other session. At the configured utilization (95% by default) a running
// turn stops at its next safe boundary (an in-flight tool still finishes and its
// result is kept), the live Claude session is compacted once, and no new Claude
// turn runs until the window resets. A goal paused by the stop stays paused.
import { currentSession } from './permission-sync.js'
import { armCompaction, runDueCompaction } from './compaction-cue.js'

export const DEFAULT_STOP_PERCENT = 95
export const DEFAULT_WEEKLY_STOP_PERCENT = 98
export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const WINDOW_LABELS = { fiveHour: '5-hour', weekly: 'weekly' }

/** A usable percentage, or null when the guard is disabled/misconfigured. */
export function normalizeStopPercent(value) {
  if (value === false || value === null || value === undefined) return null
  const percent = Number(value)
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : null
}

function windowOf(snapshot, key) {
  if (snapshot?.ok !== true) return undefined
  const window = snapshot.windows?.[key]
  return Number.isFinite(window?.percent) ? window : undefined
}

// A reading whose resets_at already passed describes the PREVIOUS window, so it
// must not re-trigger the stop. A missing resets_at expires one window later.
function resetAtMsOf(window, nowMs, windowMs = FIVE_HOUR_WINDOW_MS) {
  const raw = window?.resetsAt
  if (typeof raw === 'string' && raw) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed > nowMs ? parsed : null
  }
  return nowMs + windowMs
}

function windowDecision(snapshot, { key, threshold, windowMs, nowMs }) {
  if (threshold === null) return undefined
  const window = windowOf(snapshot, key)
  if (window === undefined || window.percent < threshold) return undefined
  const resetsAtMs = resetAtMsOf(window, nowMs, windowMs)
  if (resetsAtMs === null) return undefined
  return {
    stop: true,
    window: key,
    label: WINDOW_LABELS[key],
    percent: window.percent,
    stopAtPercent: threshold,
    resetsAtMs,
    resetsAt: window.resetsAt ?? null,
  }
}

/**
 * Whether one plan-usage snapshot is at or over a stop threshold. The 5-hour
 * window is checked first (it resets sooner), then the weekly window.
 * @param snapshot - the store's `{ ok, windows }` snapshot.
 * @param options - both thresholds, clock, and (optional) explicit "now".
 */
export function stopDecision(
  snapshot,
  { stopAtPercent = DEFAULT_STOP_PERCENT, weeklyStopPercent = DEFAULT_WEEKLY_STOP_PERCENT, nowMs = Date.now() } = {},
) {
  return (
    windowDecision(snapshot, { key: 'fiveHour', threshold: normalizeStopPercent(stopAtPercent), windowMs: FIVE_HOUR_WINDOW_MS, nowMs }) ??
    windowDecision(snapshot, { key: 'weekly', threshold: normalizeStopPercent(weeklyStopPercent), windowMs: SEVEN_DAY_WINDOW_MS, nowMs }) ?? { stop: false }
  )
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
  const threshold = Math.round(Number(decision?.stopAtPercent ?? stopAtPercent))
  const window = decision?.label ?? WINDOW_LABELS[decision?.window] ?? WINDOW_LABELS.fiveHour
  const wait = resetIn(Number(decision?.resetsAtMs ?? 0) - nowMs)
  const head = blocked ? 'Claude Code is paused' : 'Claude Code stopped this turn'
  return `${head}: the ${window} usage window is at ${reading}% (stop threshold ${threshold}%). ${
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
    observe(snapshot, { sessionId, stopAtPercent = DEFAULT_STOP_PERCENT, weeklyStopPercent = DEFAULT_WEEKLY_STOP_PERCENT } = {}) {
      if (live() !== null) return { stop: false, already: true }
      const decision = stopDecision(snapshot, { stopAtPercent, weeklyStopPercent, nowMs: now() })
      if (!decision.stop) return decision
      state = {
        percent: decision.percent,
        window: decision.window,
        label: decision.label,
        stopAtPercent: decision.stopAtPercent,
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
 * Compact the session that tripped the stop, once.
 *
 * The compaction runs as `/compact` at the agent's next idle phase: that is the
 * only path DSH renders as a transcript cue, and `turn/end` publishes while the
 * driver is still running, so a direct call at turn end used to be refused and
 * leave nothing behind. `endSession` drops the session's Claude resume chain
 * after a compaction that actually landed, so the next turn starts a fresh
 * Claude session over DSH's compacted history instead of resuming the one that
 * burned the window. A no-op or failed compaction never ends the session:
 * without a summary the next turn would replay the whole history.
 */
export async function compactStoppedSession(ctx, { sessionId, endSession } = {}, settings = {}, options = {}) {
  if (!usageGuard.takeCompaction(sessionId)) return false
  const logger = ctx?.logger
  if (settings.usageStopCompaction === false) {
    logger?.info?.(`claude-driver: usage stop on ${sessionId}; compaction disabled`)
    return false
  }
  if (settings.nativeCompaction === false || settings.resumeChain === false) {
    logger?.warn?.(
      `claude-driver: the plan-window stop compaction on ${sessionId} will not use Claude's native /compact (nativeCompaction=${settings.nativeCompaction}, resumeChain=${settings.resumeChain}); it falls back to a DSH one-shot summary`,
    )
  }
  armCompaction(sessionId, {
    kind: 'usage-stop',
    endSession: settings.usageStopEndSession === false ? undefined : endSession,
  })
  return runDueCompaction(ctx, { sessionId, ...options })
}
