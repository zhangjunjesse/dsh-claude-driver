// User-visible compaction: a due compaction runs at the agent's idle phase and
// as the `/compact` command, which is what puts a cue in the transcript.
//
// DSH renders a compaction as a transcript cue only when it runs through the
// command registry: `commands.execute(agent, '/compact')` appends `command/run`
// and `command/done` around the same `compaction.compactNow` call, so the chat
// shows the /compact card followed by the compaction marker carrying Claude's
// own summary. The compaction itself needs the agent's true idle phase, and
// `turn/end` publishes while the driver is still `running`, so a due request
// waits for idleness instead of spending short blind busy retries that compacted
// nothing and left no trace of having been asked.

export const COMPACTION_COMMAND = '/compact'

/** How long a due request waits for the agent to leave `running`. */
const IDLE_TIMEOUT_MS = 120_000

/** Capability refusals that are worth another attempt; anything else is final. */
const RETRYABLE = /busy|not idle|active compaction/i

// One slot per session: either kind of cue can be owed, and two concurrent
// compactions of the same session would only fight over the idle phase.
const due = new Map()
// A run in progress, so a second caller (the idle transition and the arming
// turn hook can both arrive) awaits it instead of starting a rival compaction.
const inflight = new Map()
// The last settled outcome, so a caller that arrives after the run finished
// reports the truth instead of re-arming a compaction that already landed.
const settled = new Map()

/**
 * Record the compaction this session owes.
 *
 * @param sessionId - the DSH session that must be compacted.
 * @param options - `kind` names the trigger in the log; `endSession` runs only
 *   after a compaction that actually landed, so a no-op or a failure never
 *   drops the cheap Claude resume point.
 */
export function armCompaction(sessionId, { kind = 'context', endSession } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return false
  const previous = due.get(sessionId)
  settled.delete(sessionId)
  due.set(sessionId, {
    kind,
    endSession: typeof endSession === 'function' ? endSession : previous?.endSession,
  })
  return true
}

/** The armed request for one session, if any. */
export function pendingCompaction(sessionId) {
  const entry = due.get(sessionId)
  return entry === undefined ? undefined : { ...entry }
}

/** Drop the armed request for one session, or all of them. */
export function clearCompaction(sessionId) {
  if (sessionId === undefined) {
    due.clear()
    inflight.clear()
    settled.clear()
    return
  }
  due.delete(sessionId)
  settled.delete(sessionId)
}

/**
 * Resolve true once the agent left `running`. A host without `whenIdle` reports
 * true: the run's busy retry is the fallback there.
 *
 * @param agent - the agent whose idle phase the compaction needs.
 * @param options - `timeoutMs` bounds the wait for a stuck driver.
 */
export async function waitForIdle(agent, { timeoutMs = IDLE_TIMEOUT_MS } = {}) {
  if (agent?.status !== 'running') return true
  if (typeof agent?.whenIdle !== 'function') return true
  let idle
  try {
    idle = Promise.resolve(agent.whenIdle())
  } catch {
    return true
  }
  let timer
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([idle.then(() => true, () => true), expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run the armed compaction for this agent, if any. Safe to call from every idle
 * transition: the first caller claims the slot, later ones await or no-op.
 *
 * @param ctx - driver context (commands + compaction services).
 * @param agent - the agent that just reached idle.
 * @param options - session id override plus the retry bounds.
 * @returns whether a compaction actually landed.
 */
export async function flushCompaction(ctx, agent, { sessionId = agent?.session?.id, retryDelayMs = 250, attempts = 5 } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return false
  const running = inflight.get(sessionId)
  if (running !== undefined) return running
  const entry = due.get(sessionId)
  if (entry === undefined || agent?.status === 'running') return false
  due.delete(sessionId)
  const run = runCompaction(ctx, agent, sessionId, entry, { retryDelayMs, attempts })
    .then((outcome) => {
      settled.set(sessionId, outcome)
      return outcome.compacted
    })
  inflight.set(sessionId, run)
  try {
    return await run
  } finally {
    if (inflight.get(sessionId) === run) inflight.delete(sessionId)
  }
}

/**
 * Wait for the agent's idle phase, then run the compaction armed for its session.
 * A request that never sees an idle phase stays armed for the next transition.
 *
 * @param ctx - driver context.
 * @param options - the session id plus the retry/idle bounds.
 * @returns whether a compaction actually landed.
 */
export async function runDueCompaction(ctx, { sessionId, retryDelayMs = 250, attempts = 5, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return false
  const settledOutcome = settled.get(sessionId)
  if (settledOutcome !== undefined && !due.has(sessionId) && !inflight.has(sessionId)) return settledOutcome.compacted
  if (!due.has(sessionId) && !inflight.has(sessionId)) return false
  const logger = ctx?.logger
  const agent = safeGet(ctx, 'agents')?.get?.(sessionId)
  if (agent === undefined) {
    logger?.warn?.(`claude-driver: a compaction is due for ${sessionId} but its agent is gone; dropping it`)
    clearCompaction(sessionId)
    return false
  }
  if (!(await waitForIdle(agent, { timeoutMs: idleTimeoutMs }))) {
    logger?.warn?.(`claude-driver: ${sessionId} did not reach idle; the due compaction stays armed for its next idle phase`)
    return false
  }
  return flushCompaction(ctx, agent, { sessionId, retryDelayMs, attempts })
}

/**
 * One compaction attempt. The command path is the visible one; a direct
 * service call is the fallback for a host without a command registry.
 * @returns `{ visible, ok, compacted, text }` plus `missing` when nothing can
 *   compact at all.
 */
async function executeCompaction(ctx, agent) {
  const signal = new AbortController().signal
  const commands = safeGet(ctx, 'commands')
  if (typeof commands?.execute === 'function') {
    try {
      const execution = await commands.execute(agent, COMPACTION_COMMAND, [], signal)
      // No /compact registered for this agent: fall through to the service one.
      if (execution !== undefined) {
        const { kind, text, sourceEventSeq } = execution.result ?? {}
        return {
          visible: true,
          ok: kind === 'success',
          compacted: kind === 'success' && sourceEventSeq !== undefined,
          text: typeof text === 'string' ? text : '',
        }
      }
    } catch (error) {
      return { visible: true, ok: false, compacted: false, text: String(error?.message ?? error) }
    }
  }
  const compaction = safeGet(ctx, 'compaction')
  if (typeof compaction?.compactNow !== 'function') return { visible: false, missing: true }
  try {
    const result = await compaction.compactNow(agent, signal)
    return {
      visible: false,
      ok: true,
      compacted: result !== null,
      text: result === null ? 'No compactable history yet.' : 'Compacted history.',
    }
  } catch (error) {
    return { visible: false, ok: false, compacted: false, text: String(error?.message ?? error) }
  }
}

/** The attempt loop: busy refusals are retried, everything else is final. */
async function runCompaction(ctx, agent, sessionId, entry, { retryDelayMs, attempts }) {
  const logger = ctx?.logger
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const outcome = await executeCompaction(ctx, agent)
    if (outcome.ok) {
      logger?.info?.(
        outcome.compacted
          ? `claude-driver: compacted ${sessionId} ${entry.kind === 'usage-stop' ? 'after the plan-window stop' : 'at the context threshold'}: ${outcome.text}`
          : `claude-driver: ${sessionId} has no compactable history right now (${entry.kind})`,
      )
      if (!outcome.visible) {
        logger?.warn?.(`claude-driver: no /compact command is registered, so the compaction on ${sessionId} has no transcript cue`)
      }
      if (outcome.compacted) runEndSession(entry, sessionId, logger)
      return outcome
    }
    if (outcome.missing) {
      logger?.warn?.(`claude-driver: no compaction service is mounted; the due compaction on ${sessionId} was dropped`)
      return outcome
    }
    if (!RETRYABLE.test(outcome.text ?? '')) {
      logger?.warn?.(`claude-driver: the due compaction on ${sessionId} failed: ${outcome.text}`)
      return outcome
    }
    if (attempt === attempts - 1) {
      logger?.warn?.(`claude-driver: the due compaction on ${sessionId} stayed busy: ${outcome.text}`)
      // Still owed: the next idle transition gets another chance instead of
      // leaving the session uncompacted (a stop compaction is not re-armed by
      // its turn hook, so dropping it here would drop it for good).
      due.set(sessionId, entry)
      return outcome
    }
    await sleep(retryDelayMs * 2 ** attempt)
  }
  return { visible: false, ok: false, compacted: false, text: 'compaction attempts exhausted' }
}

function runEndSession(entry, sessionId, logger) {
  if (entry.endSession === undefined) return
  try {
    const ended = entry.endSession()
    logger?.info?.(
      ended === false
        ? `claude-driver: no Claude session to end for ${sessionId} after the stop compaction`
        : `claude-driver: ended the Claude session for ${sessionId} after the stop compaction; the next turn starts fresh`,
    )
  } catch (error) {
    logger?.warn?.(`claude-driver: could not end the Claude session for ${sessionId}: ${String(error?.message ?? error)}`)
  }
}

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
