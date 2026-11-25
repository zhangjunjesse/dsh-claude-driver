// Claude Code -> DSH: an API error Claude reports as an assistant message
// (auth expired, billing, rate limit, ...) must end the DSH turn as an error
// with a DSH failure code, never as an ordinary answer. Real shape captured
// from an expired OAuth session.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, streamClaudeChunks } from '../lib/index.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
const apiError = (error, text) => [
  { type: 'assistant', session_id: 's', error, message: { content: [{ type: 'text', text }] } },
  { type: 'result', subtype: 'success', is_error: true, session_id: 's', result: text, usage: { input_tokens: 0, output_tokens: 0 } },
]
async function run(events) {
  const queryImpl = () => (async function* () { for (const e of events) yield e })()
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, opts, { resumeChain: false, autoLogin: false, queryImpl })) chunks.push(c)
  return chunks
}

for (const [error, code, text] of [
  ['authentication_failed', 'AUTH', 'Failed to authenticate: OAuth session expired and could not be refreshed'],
  ['billing_error', 'AUTH', 'Credit balance is too low'],
  ['rate_limit', 'RATE_LIMIT', 'You have hit your usage limit'],
  ['overloaded', 'SERVER', 'Overloaded'],
  ['invalid_request', 'INVALID_REQUEST', 'prompt is too long'],
]) {
  test(`Claude "${error}" ends the DSH turn as a ${code} error, not as an answer`, async () => {
    const chunks = await run(apiError(error, text))
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, code)
    assert.match(finish.reason.failure.message, new RegExp(text.slice(0, 12)))
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '', 'error text is not streamed as the answer')
  })
}

test('an auth error tells the user how to fix it', async () => {
  const finish = (await run(apiError('authentication_failed', 'Failed to authenticate: OAuth session expired'))).at(-1)
  assert.match(finish.reason.failure.message, /claude (\/)?login|log in/i)
})

test('a normal answer is unaffected', async () => {
  const chunks = await run([
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'fine' }] } },
    { type: 'result', subtype: 'success', session_id: 's', result: 'fine', usage: { input_tokens: 1, output_tokens: 1 } },
  ])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('an auth failure on a resumed chain is not retried as a fresh session', async () => {
  const { getResumeSessions } = await import('../lib/index.js')
  getResumeSessions().set('dsh-auth', 'claude-auth')
  let calls = 0
  const queryImpl = () => { calls += 1; return (async function* () { for (const e of apiError('authentication_failed', 'Failed to authenticate')) yield e })() }
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, { ...opts, sessionId: 'dsh-auth', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: [{ type: 'text', text: 'c' }] }] }, { resumeChain: true, autoLogin: false, queryImpl })) chunks.push(c)
  assert.equal(calls, 1, 'auth is not a resume problem')
  assert.equal(getResumeSessions().get('dsh-auth'), 'claude-auth', 'chain kept for after re-login')
  assert.equal(chunks.at(-1).reason.failure.code, 'AUTH')
  getResumeSessions().delete('dsh-auth')
})

test('a failed resume never retries fresh or discards the Claude session id', async () => {
  const { getResumeSessions } = await import('../lib/index.js')
  getResumeSessions().set('dsh-stale', 'claude-stale')
  const calls = []
  const queryImpl = ({ options }) => {
    calls.push(options)
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-stale' }
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['resume transport failed'], session_id: 'claude-stale', usage: { input_tokens: 0, output_tokens: 0 } }
    })()
  }
  const chunks = []
  const options = { ...opts, sessionId: 'dsh-stale', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: [{ type: 'text', text: 'c' }] }] }
  for await (const c of streamClaudeChunks(ctx, options, { resumeChain: true, autoLogin: false, queryImpl })) chunks.push(c)
  assert.equal(calls.length, 1, 'no silent fresh-session retry')
  assert.equal(calls[0].resume, 'claude-stale')
  assert.equal(getResumeSessions().get('dsh-stale'), 'claude-stale')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  getResumeSessions().delete('dsh-stale')
})

test('a resumed turn rejects a changed SDK session id instead of saving it', async () => {
  const { getResumeSessions } = await import('../lib/index.js')
  getResumeSessions().set('dsh-identity', 'claude-expected')
  const calls = []
  const queryImpl = ({ options }) => {
    calls.push(options)
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-unexpected' }
      yield { type: 'assistant', session_id: 'claude-unexpected', message: { content: [{ type: 'text', text: 'wrong session' }] } }
      yield { type: 'result', subtype: 'success', session_id: 'claude-unexpected', result: 'wrong session', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  }
  const chunks = []
  const options = { ...opts, sessionId: 'dsh-identity', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: [{ type: 'text', text: 'c' }] }] }
  for await (const c of streamClaudeChunks(ctx, options, { resumeChain: true, autoLogin: false, queryImpl })) chunks.push(c)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].resume, 'claude-expected')
  assert.equal(getResumeSessions().get('dsh-identity'), 'claude-expected')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /session id mismatch/i)
  getResumeSessions().delete('dsh-identity')
})

test('an empty resume tail fails before a query instead of replaying fresh history', async () => {
  const { getResumeSessions } = await import('../lib/index.js')
  getResumeSessions().set('dsh-empty-tail', 'claude-empty-tail')
  let calls = 0
  const queryImpl = () => { calls += 1; return (async function* () {})() }
  const chunks = []
  const options = { ...opts, sessionId: 'dsh-empty-tail', messages: [{ role: 'user', content: [{ type: 'text', text: 'old' }] }, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }] }
  for await (const c of streamClaudeChunks(ctx, options, { resumeChain: true, autoLogin: false, queryImpl })) chunks.push(c)
  assert.equal(calls, 0)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'CLAUDE_SESSION_RESUME')
  assert.equal(getResumeSessions().get('dsh-empty-tail'), 'claude-empty-tail')
  getResumeSessions().delete('dsh-empty-tail')
})

test('a provider round trip preserves the id but fails closed instead of skipping intervening history', async () => {
  const { getResumeSessions } = await import('../lib/index.js')
  const handlers = new Map()
  const host = { ...ctx, on: (event, fn) => { handlers.set(event, fn); return () => {} } }
  apply(host, { checkCliOnLoad: false, registerCatalog: false })
  getResumeSessions().set('dsh-switch', 'claude-before-switch')
  handlers.get('session/event')({ id: 'dsh-switch' }, { type: 'model/selection', data: { provider: 'deepseek' } })
  assert.equal(getResumeSessions().get('dsh-switch'), 'claude-before-switch')
  let calls = 0
  const queryImpl = () => { calls += 1; return (async function* () {})() }
  const chunks = []
  const options = { ...opts, sessionId: 'dsh-switch', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: [{ type: 'text', text: 'c' }] }] }
  for await (const c of streamClaudeChunks(host, options, { resumeChain: true, autoLogin: false, queryImpl })) chunks.push(c)
  assert.equal(calls, 0, 'never silently resume across missing provider history or start fresh')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'CLAUDE_SESSION_RESUME')
  assert.equal(getResumeSessions().get('dsh-switch'), 'claude-before-switch')
  getResumeSessions().delete('dsh-switch')
})
