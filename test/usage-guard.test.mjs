// The 5-hour plan window is account-wide: when it reaches the configured
// utilization (95% by default) every Claude turn stops at a safe boundary, the
// live session is compacted once, and no new turn runs until the window resets.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { claudeUsage } from '../lib/claude-usage.js'
import { getResumeSessions, streamClaudeChunks } from '../lib/index.js'
import { createClaudeCodeProvider } from '../lib/subagent-provider.js'
import {
  compactStoppedSession,
  createUsageGuard,
  DEFAULT_STOP_PERCENT,
  FIVE_HOUR_WINDOW_MS,
  formatStopNotice,
  normalizeStopPercent,
  stopDecision,
  usageGuard,
} from '../lib/usage-guard.js'

const USAGE = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
// One global store and one global latch: never leak a 96% reading into the
// other test files that run Claude turns.
beforeEach(() => {
  usageGuard.reset()
  claudeUsage.reset()
})
afterEach(() => {
  usageGuard.reset()
  claudeUsage.reset()
})
const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
const resetAt = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString()
const snapshot = (percent, resetsAt = resetAt()) => ({ ok: true, windows: { fiveHour: { percent, resetsAt } } })
const text = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

async function drain(ctx, options, settings = {}) {
  const chunks = []
  for await (const chunk of streamClaudeChunks(ctx, options, { resumeChain: false, ...settings })) chunks.push(chunk)
  return chunks
}

test('stops at the configurable threshold, defaults to 95%', () => {
  assert.equal(DEFAULT_STOP_PERCENT, 95)
  const future = resetAt()
  assert.equal(stopDecision(snapshot(95, future), { stopAtPercent: 95 }).stop, true)
  assert.equal(stopDecision(snapshot(94.9, future), { stopAtPercent: 95 }).stop, false)
  assert.equal(stopDecision(snapshot(90, future), { stopAtPercent: 90 }).stop, true)
})

test('a disabled or out-of-range threshold never stops', () => {
  for (const value of [false, null, undefined, 0, -1, 101, Number.NaN]) assert.equal(normalizeStopPercent(value), null)
  assert.equal(stopDecision(snapshot(99), { stopAtPercent: false }).stop, false)
})

test('the weekly window stops at its own threshold, default 98', () => {
  const weekly = (percent) => ({ ok: true, windows: { weekly: { percent, resetsAt: resetAt(2 * 24 * 3_600_000) } } })
  const trip = stopDecision(weekly(98), {})
  assert.equal(trip.stop, true)
  assert.equal(trip.window, 'weekly')
  assert.equal(trip.stopAtPercent, 98)
  assert.equal(stopDecision(weekly(97.9), {}).stop, false)
  assert.equal(stopDecision(weekly(99), { weeklyStopPercent: 99.5 }).stop, false, 'a higher configured weekly threshold is honored')
  assert.equal(stopDecision(weekly(99), { weeklyStopPercent: false }).stop, false, 'false disables the weekly guard')
})

test('the five-hour window is reported before the weekly one when both are over', () => {
  const both = { ok: true, windows: { fiveHour: { percent: 96, resetsAt: resetAt() }, weekly: { percent: 99, resetsAt: resetAt(2 * 24 * 3_600_000) } } }
  const trip = stopDecision(both, {})
  assert.equal(trip.window, 'fiveHour')
  assert.equal(trip.percent, 96)
})

test('the weekly notice names the window, the reading, the threshold and the reset', () => {
  const decision = stopDecision({ ok: true, windows: { weekly: { percent: 99, resetsAt: resetAt(2 * 24 * 3_600_000) } } }, {})
  const notice = formatStopNotice(decision)
  assert.match(notice, /weekly/i)
  assert.match(notice, /99%/)
  assert.match(notice, /98%/)
  assert.match(notice, /resets in 2d/i)
})

test('a stale reading (the window already reset) does not stop the next turn', () => {
  const past = new Date(Date.now() - 1000).toISOString()
  assert.equal(stopDecision(snapshot(99, past), {}).stop, false)
})

test('a reading without resets_at expires one full five-hour window later', () => {
  const now = 1_000_000
  const decision = stopDecision(snapshot(96, null), { nowMs: now })
  assert.equal(decision.stop, true)
  assert.equal(decision.resetsAtMs, now + FIVE_HOUR_WINDOW_MS)
})

test('the guard latches once, reports stopped, and clears when the window resets', () => {
  let now = 1_000_000
  const guard = createUsageGuard({ now: () => now })
  const first = guard.observe(snapshot(96, new Date(now + 60_000).toISOString()), { sessionId: 's1' })
  assert.equal(first.stop, true)
  assert.equal(guard.stopped(), true)
  assert.equal(guard.observe(snapshot(97, new Date(now + 60_000).toISOString()), { sessionId: 's2' }).stop, false, 'no second trip')
  now += 60_001
  assert.equal(guard.stopped(), false)
  assert.equal(guard.state(), null)
  assert.equal(guard.observe(snapshot(96, new Date(now + 60_000).toISOString()), { sessionId: 's1' }).stop, true, 'a later window can trip again')
})

test('the compaction request is consumed once, for the session that tripped', () => {
  const guard = createUsageGuard({ now: () => 1_000_000 })
  guard.observe(snapshot(96, new Date(1_060_000).toISOString()), { sessionId: 's1' })
  assert.equal(guard.takeCompaction('s2'), false)
  assert.equal(guard.takeCompaction('s1'), true)
  assert.equal(guard.takeCompaction('s1'), false)
})

test('the notice names the reading, the threshold and the reset', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const notice = formatStopNotice({ percent: 96.4, resetsAtMs: now + 3_600_000 }, { nowMs: now, stopAtPercent: 95 })
  assert.match(notice, /96%/)
  assert.match(notice, /95%/)
  assert.match(notice, /resets in 1h/i)
})

// --- turn integration -------------------------------------------------------

function mockSession() {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  return {
    id: 's1',
    events,
    append(type, data, opts) {
      const event = { type, seq: events.length, data, ...(opts ?? {}) }
      events.push(event)
      return event
    },
  }
}

function ctxFor(session, extra = {}) {
  const agent = { id: 'a', session }
  return {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'agents' ? { currentInitiator: () => agent, get: () => agent } : undefined),
    on: () => () => {},
    ...extra,
  }
}

// One tool round-trip, then (only if the guard failed to stop it) a second
// model response. The usage control request reports 96% of the 5-hour window.
function tripQuery(seen = {}, rateLimits = { five_hour: { utilization: 96, resets_at: resetAt() } }) {
  return ({ options }) => {
    const generator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' }
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'claude-1',
        message: {
          role: 'assistant',
          model: 'sonnet',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
          usage: { input_tokens: 1200, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }
      // Let the usage control request resolve before the tool result boundary.
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: 'user', parent_tool_use_id: null, session_id: 'claude-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'claude-1', message: { role: 'assistant', content: [{ type: 'text', text: 'should not stream after the stop' }], usage: { input_tokens: 1300, output_tokens: 5 } } }
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-1', result: 'after', usage: { input_tokens: 1300, output_tokens: 5 } }
    })()
    generator[USAGE] = async () => ({ rate_limits_available: true, rate_limits: rateLimits })
    options.abortController?.signal.addEventListener('abort', () => { seen.aborted = true })
    return generator
  }
}

test('a turn at 96% stops after its current tool result and leaves a notice', async () => {
  usageGuard.reset()
  const session = mockSession()
  const seen = {}
  const chunks = await drain(ctxFor(session), opts, { queryImpl: tripQuery(seen), usageStopPercent: 95 })
  const prose = text(chunks)
  assert.equal(seen.aborted, true, 'the SDK query was aborted at the boundary')
  assert.match(prose, /5-hour/)
  assert.match(prose, /96%/)
  assert.equal(chunks.at(-1).reason.kind, 'stop', 'a stop, not an error')
  assert.ok(session.events.some((event) => event.type === 'tool/result'), 'the in-flight tool result was kept')
  assert.ok(!prose.includes('should not stream after the stop'), 'no further model response was streamed')
  assert.equal(usageGuard.stopped(), true)
  usageGuard.reset()
})

test('after the stop, every new Claude turn is refused and never reaches the SDK', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 's1', stopAtPercent: 95 })
  let called = false
  const queryImpl = () => {
    called = true
    return (async function* () {})()
  }
  const chunks = await drain(ctxFor(mockSession()), opts, { queryImpl, usageStopPercent: 95 })
  assert.equal(called, false)
  assert.match(text(chunks), /(paused|blocked|resets)/i)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  usageGuard.reset()
})

test('usageStopPercent:false disables the stop entirely', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 's1', stopAtPercent: 95 })
  let called = false
  const queryImpl = () => {
    called = true
    return (async function* () {
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'ran' }] } }
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'ran', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  }
  const chunks = await drain(ctxFor(mockSession()), opts, { queryImpl, usageStopPercent: false })
  assert.equal(called, true)
  assert.match(text(chunks), /ran/)
  usageGuard.reset()
})

test('tripping the guard pauses the active goal', async () => {
  usageGuard.reset()
  const session = mockSession()
  const paused = []
  const agent = { id: 'a', session }
  const goal = { id: 'goal-1', revision: 3, phase: 'active' }
  const goals = { get: () => goal, pause: (_agent, ref) => paused.push(ref) }
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'agents') return { currentInitiator: () => agent, get: () => agent }
      if (name === 'goals') return goals
      return undefined
    },
    on: () => () => {},
  }
  await drain(ctx, opts, { queryImpl: tripQuery(), usageStopPercent: 95 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(paused, [{ id: 'goal-1', revision: 3 }])
  usageGuard.reset()
})

test('stop compaction runs once on the tripped session and retries a busy agent', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 's1', stopAtPercent: 95 })
  const agent = { id: 'a', session: { id: 's1' } }
  let attempts = 0
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'compaction') {
        return {
          compactNow: async (target) => {
            attempts += 1
            if (attempts === 1) throw Object.assign(new Error('agent busy'), { code: 'busy' })
            assert.equal(target, agent)
            return { summary: 'condensed' }
          },
        }
      }
      return undefined
    },
  }
  await compactStoppedSession(ctx, { sessionId: 's1' }, {}, { retryDelayMs: 1 })
  assert.equal(attempts, 2)
  await compactStoppedSession(ctx, { sessionId: 's1' }, {}, { retryDelayMs: 1 })
  assert.equal(attempts, 2, 'one compaction per trip')
  usageGuard.reset()
})

test('a turn at 99% of the weekly window stops and the next turn is refused until it resets', async () => {
  usageGuard.reset()
  const session = mockSession()
  const weeklyLimits = { seven_day: { utilization: 99, resets_at: resetAt(2 * 24 * 3_600_000) } }
  const chunks = await drain(ctxFor(session), opts, { queryImpl: tripQuery({}, weeklyLimits), usageStopPercent: 95, weeklyStopPercent: 98 })
  assert.match(text(chunks), /weekly/i)
  assert.equal(usageGuard.stopped(), true)
  const refused = await drain(ctxFor(session), opts, { queryImpl: tripQuery({}, weeklyLimits), usageStopPercent: 95, weeklyStopPercent: 98 })
  assert.match(text(refused), /weekly/i)
  usageGuard.reset()
})

test('usageStopCompaction:false consumes the request without compacting', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 's1', stopAtPercent: 95 })
  let attempts = 0
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'agents') return { get: () => ({ id: 'a', session: { id: 's1' } }) }
      if (name === 'compaction') return { compactNow: async () => { attempts += 1 } }
      return undefined
    },
  }
  await compactStoppedSession(ctx, { sessionId: 's1' }, { usageStopCompaction: false }, { retryDelayMs: 1 })
  assert.equal(attempts, 0)
  usageGuard.reset()
})

test('a successful stop compaction ends the Claude session afterwards', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 's1', stopAtPercent: 95 })
  const calls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'agents') return { get: () => ({ id: 'a', session: { id: 's1' } }) }
      if (name === 'compaction') return { compactNow: async () => calls.push('compact') }
      return undefined
    },
  }
  await compactStoppedSession(ctx, { sessionId: 's1', endSession: () => calls.push('end') }, {}, { retryDelayMs: 1 })
  assert.deepEqual(calls, ['compact', 'end'], 'the session ends only after its compaction settled')
  usageGuard.reset()
})

test('usageStopEndSession:false keeps the compacted Claude session', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 's1', stopAtPercent: 95 })
  const calls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'agents') return { get: () => ({ id: 'a', session: { id: 's1' } }) }
      if (name === 'compaction') return { compactNow: async () => calls.push('compact') }
      return undefined
    },
  }
  await compactStoppedSession(ctx, { sessionId: 's1', endSession: () => calls.push('end') }, { usageStopEndSession: false }, { retryDelayMs: 1 })
  assert.deepEqual(calls, ['compact'])
  usageGuard.reset()
})

test('a failed compaction does not end the Claude session', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 's1', stopAtPercent: 95 })
  const calls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'agents') return { get: () => ({ id: 'a', session: { id: 's1' } }) }
      if (name === 'compaction') return { compactNow: async () => { throw new Error('compaction refused') } }
      return undefined
    },
  }
  const compacted = await compactStoppedSession(ctx, { sessionId: 's1', endSession: () => calls.push('end') }, {}, { retryDelayMs: 1 })
  assert.equal(compacted, false)
  assert.deepEqual(calls, [], 'ending the session without a summary would lose the cheap resume point')
  usageGuard.reset()
})

test('the stop warns when its compaction cannot use Claude native /compact', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 's1', stopAtPercent: 95 })
  const warns = []
  const ctx = {
    logger: { info() {}, warn: (message) => warns.push(String(message)) },
    get: (name) => {
      if (name === 'agents') return { get: () => ({ id: 'a', session: { id: 's1' } }) }
      if (name === 'compaction') return { compactNow: async () => {} }
      return undefined
    },
  }
  await compactStoppedSession(ctx, { sessionId: 's1' }, { nativeCompaction: false }, { retryDelayMs: 1 })
  assert.match(warns.join('\n'), /native \/compact/, 'the fallback is named, not silently used')
  usageGuard.reset()
})

test('a subagent run is refused while the stop is in effect', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 'parent', stopAtPercent: 95 })
  const provider = createClaudeCodeProvider({ usageStopPercent: 95, cwd: process.cwd() })
  const run = await provider.start({
    label: 'blocked',
    prompt: [{ type: 'text', text: 'do work' }],
    parent: { session: { meta: { cwd: process.cwd() } } },
    signal: new AbortController().signal,
  })
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.match(result.output[0].text, /paused/i)
  await run.dispose()
  usageGuard.reset()
})

test('the stop gate still allows the compaction request itself (native /compact)', async () => {
  usageGuard.reset()
  usageGuard.observe(snapshot(96), { sessionId: 'dsh-c', stopAtPercent: 95 })
  getResumeSessions().set('dsh-c', 'claude-c')
  const calls = []
  const queryImpl = ({ prompt, options }) => {
    calls.push({ prompt, options })
    return (async function* () {
      const sid = options.resume ?? 'claude-c'
      yield { type: 'system', subtype: 'init', session_id: sid }
      yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 90, post_tokens: 40 }, session_id: sid }
      for (const hook of options.hooks?.PostCompact ?? []) for (const fn of hook.hooks) await fn({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'condensed', session_id: sid }, undefined, { signal: new AbortController().signal })
      yield { type: 'result', subtype: 'success', result: '', session_id: sid, usage: { input_tokens: 90, output_tokens: 10 } }
    })()
  }
  const chunks = await drain(ctxFor(mockSession()), { ...opts, sessionId: 'dsh-c', purpose: 'compaction' }, { queryImpl, usageStopPercent: 95, resumeChain: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, '/compact')
  assert.match(text(chunks), /condensed/)
  getResumeSessions().delete('dsh-c')
  usageGuard.reset()
})
