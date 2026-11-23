// Plan usage (5-hour, weekly, per-model windows and extra usage) for the Claude
// account a turn runs on: read from the live query after each turn, served to the
// composer dock meter from the host. Real shape from SDKControlGetUsageResponse.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeUsage, createUsageStore, registerUsageRoute, usageFromRateLimits, USAGE_ROUTE } from '../lib/claude-usage.js'
import { streamClaudeChunks } from '../lib/index.js'

const USAGE = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
const RATE_LIMITS = {
  five_hour: { utilization: 42, resets_at: '2026-10-30T15:00:00Z' },
  seven_day: { utilization: 13.5, resets_at: '2026-11-03T00:00:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 5, resets_at: '2026-11-03T00:00:00Z' },
  extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 150, utilization: 7.5, currency: 'USD' },
}
const withUsage = (usage) => Object.assign(Object.create(null), { [USAGE]: usage })

test('maps the windows Claude reports and drops the ones it leaves null', () => {
  const snapshot = usageFromRateLimits(RATE_LIMITS)
  assert.equal(snapshot.ok, true)
  assert.deepEqual(snapshot.windows, {
    fiveHour: { percent: 42, resetsAt: '2026-10-30T15:00:00Z' },
    weekly: { percent: 13.5, resetsAt: '2026-11-03T00:00:00Z' },
    weeklySonnet: { percent: 5, resetsAt: '2026-11-03T00:00:00Z' },
  })
  assert.deepEqual(snapshot.extra, { enabled: true, percent: 7.5, usedCredits: 150, monthlyLimit: 2000, currency: 'USD' })
})

test('a window with no utilization reading is absent, not zero', () => {
  const snapshot = usageFromRateLimits({ five_hour: { utilization: null, resets_at: null } })
  assert.deepEqual(snapshot.windows, {})
})

test('no plan limits (API key, Bedrock, Vertex) yields an unavailable snapshot', () => {
  const snapshot = usageFromRateLimits(null)
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.code, 'unavailable')
})

test('refresh reads plan usage from the live query after a turn', async () => {
  const calls = []
  const store = createUsageStore(() => 1000)
  const query = withUsage(async (opts) => {
    calls.push(opts)
    return { subscription_type: 'max', rate_limits_available: true, rate_limits: RATE_LIMITS }
  })
  await store.refresh(query)
  assert.deepEqual(calls, [{ skipBehaviors: true }])
  assert.equal(store.get().ok, true)
  assert.equal(store.get().plan, 'max')
  assert.equal(store.get().fetchedAtMs, 1000)
  assert.equal(store.get().windows.fiveHour.percent, 42)
})

test('a failed refresh keeps the last good reading and records the error', async () => {
  let now = 1000
  const store = createUsageStore(() => now)
  await store.refresh(withUsage(async () => ({ rate_limits_available: true, rate_limits: RATE_LIMITS })))
  now = 2000
  await store.refresh(withUsage(async () => { throw new Error('network down') }))
  assert.equal(store.get().ok, true)
  assert.equal(store.get().windows.fiveHour.percent, 42)
  assert.equal(store.get().fetchedAtMs, 1000)
  assert.equal(store.get().error, 'network down')
})

test('a query without the usage method (older SDK, test double) leaves the store untouched', async () => {
  const store = createUsageStore(() => 1000)
  const before = store.get()
  await store.refresh({})
  assert.equal(store.get(), before)
})

test('the usage route serves the latest snapshot as JSON', async () => {
  const store = createUsageStore(() => 5)
  await store.refresh(withUsage(async () => ({ rate_limits_available: true, rate_limits: RATE_LIMITS })))
  let registered
  const webCtx = { effect: (fn) => fn(), get: (name) => (name === 'webServer' ? { register: (route) => (registered = route) } : undefined) }
  registerUsageRoute({ inject: (_names, fn) => fn(webCtx) }, store)
  assert.equal(registered.kind, 'exact')
  assert.equal(registered.path, USAGE_ROUTE)
  let body = ''
  const res = { statusCode: 0, setHeader() {}, end(text) { body = text } }
  await registered.handler({ method: 'GET', url: USAGE_ROUTE }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(body).snapshot.windows.fiveHour.percent, 42)
  assert.equal(JSON.parse(body).provider, 'claude-code', 'the client must know which route owns this meter')
})

test('the usage route names a custom provider so the bar can match the session route', async () => {
  const store = createUsageStore(() => 5)
  await store.refresh(withUsage(async () => ({ rate_limits_available: true, rate_limits: RATE_LIMITS })))
  let registered
  const webCtx = { effect: (fn) => fn(), get: (name) => (name === 'webServer' ? { register: (route) => (registered = route) } : undefined) }
  registerUsageRoute({ inject: (_names, fn) => fn(webCtx) }, store, 'claude-alt')
  let body = ''
  const res = { statusCode: 0, setHeader() {}, end(text) { body = text } }
  await registered.handler({ method: 'GET', url: USAGE_ROUTE }, res)
  assert.equal(JSON.parse(body).provider, 'claude-alt')
})

test('a turn refreshes plan usage from the query that ran it', async () => {
  const events = [
    { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { role: 'assistant', model: 'sonnet', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } },
  ]
  const generator = (async function* () { for (const e of events) yield e })()
  generator[USAGE] = async () => ({ rate_limits_available: true, rate_limits: RATE_LIMITS })
  const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
  const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
  for await (const _chunk of streamClaudeChunks(ctx, opts, { resumeChain: false, autoLogin: false, queryImpl: () => generator })) {
    // drain the turn
  }
  await claudeUsage.idle()
  assert.equal(claudeUsage.get().windows.fiveHour.percent, 42)
})

test('plan usage is read while the query is open, so the SDK does not reject it as closed', async () => {
  let closed = false
  const usage = async () => {
    if (closed) throw new Error('Query closed before response received')
    return { rate_limits_available: true, rate_limits: RATE_LIMITS }
  }
  const generator = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's', model: 'sonnet', tools: [], mcp_servers: [] }
    yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { role: 'assistant', model: 'sonnet', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }
    await new Promise((resolve) => setTimeout(resolve, 10))
    closed = true
    yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  generator[USAGE] = usage
  const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
  const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
  for await (const _chunk of streamClaudeChunks(ctx, opts, { resumeChain: false, autoLogin: false, queryImpl: () => generator })) {
    // drain the turn
  }
  await claudeUsage.idle()
  assert.equal(claudeUsage.get().error, undefined, 'usage request succeeded while the query was open')
  assert.equal(claudeUsage.get().windows.fiveHour.percent, 42)
})

test('the dock meter fetches the same route the host registers', () => {
  const client = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
  assert.ok(client.includes(`'${USAGE_ROUTE}'`) || client.includes(`"${USAGE_ROUTE}"`), 'client polls the host route')
  assert.ok(client.includes('conversation.composer.dock'), 'meter renders in the composer dock')
})
