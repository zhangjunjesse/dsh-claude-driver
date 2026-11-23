// Task notes across turns: a queued user message, a model switch (DSH aborts the
// running step and starts a new one) and a resumed chain must never leak one
// turn's task outcomes into the next, nor report an aborted turn's task as failed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getResumeSessions, streamClaudeChunks } from '../lib/index.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const user = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] })
const level = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', session_id: 'c1', tasks: ids.map((id) => ({ task_id: id, description: `job ${id}` })) })
const started = (id) => ({ type: 'system', subtype: 'task_started', session_id: 'c1', task_id: id, tool_use_id: `t-${id}`, description: `job ${id}`, is_backgrounded: true })
const note = (id, status) => ({ type: 'system', subtype: 'task_notification', session_id: 'c1', task_id: id, tool_use_id: `t-${id}`, status, summary: `job ${id}` })
const answer = (t) => [{ type: 'assistant', session_id: 'c1', message: { content: [{ type: 'text', text: t }] } }, { type: 'result', subtype: 'success', session_id: 'c1', result: t, usage: { input_tokens: 1, output_tokens: 1 } }]

async function turn(events, options, settings = {}) {
  const queryImpl = () => (async function* () { for (const e of events) yield e })()
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'sonnet', ...options }, { resumeChain: true, queryImpl, pulseMs: 0, ...settings })) chunks.push(c)
  return { chunks, text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') }
}

test('turn 2 (a queued message on the same chain) does not repeat turn 1\'s task outcome', async () => {
  const sid = 'dsh-q'
  const t1 = await turn([level('b1'), started('b1'), note('b1', 'failed'), level(), ...answer('one')], { sessionId: sid, messages: [user('a')] })
  assert.match(t1.text, /background tasks failed: job b1/i)
  const t2 = await turn(answer('two'), { sessionId: sid, messages: [user('a'), { role: 'assistant', content: [{ type: 'text', text: 'one' }] }, user('b')] })
  assert.ok(!/job b1|background tasks/i.test(t2.text), t2.text)
  getResumeSessions().delete(sid)
})

test('a model switch aborts the running step: its live task is "ended with the turn", never failed', async () => {
  const ac = new AbortController()
  const queryImpl = () => (async function* () {
    yield level('b1'); yield started('b1')
    ac.abort() // DSH aborts the step when the user switches model
    for (const e of answer('partial')) yield e
  })()
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'sonnet', signal: ac.signal, messages: [user('a')] }, { resumeChain: false, queryImpl, pulseMs: 0 })) chunks.push(c)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!/background tasks failed/i.test(text), text)
  assert.match(text, /interrupted.*job b1/i)
})

test('a task outcome that arrived BEFORE the abort is still reported as what it was', async () => {
  const ac = new AbortController()
  const queryImpl = () => (async function* () {
    yield level('b1'); yield started('b1'); yield note('b1', 'completed'); yield level()
    ac.abort()
    for (const e of answer('x')) yield e
  })()
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'sonnet', signal: ac.signal, messages: [user('a')] }, { resumeChain: false, queryImpl, pulseMs: 0 })) chunks.push(c)
  const all = chunks.filter((c) => c.type === 'text-delta' || c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.match(all, /background tasks finished: job b1 \(completed\)/i)
  assert.ok(!/interrupted/i.test(all), all)
})

test('two different tasks with the same description are both reported (dedupe is by task id, not text)', async () => {
  const { text } = await turn([level('b1', 'b2'), started('b1'), started('b2'), note('b1', 'failed'), note('b2', 'failed'), level(), ...answer('x')], { sessionId: 'dsh-d', messages: [user('a')] })
  assert.equal((text.match(/job b/g) ?? []).length, 2, text)
  getResumeSessions().delete('dsh-d')
})

test('a repeated notification for the SAME task id is reported once even if the CLI replays it', async () => {
  const { text } = await turn([level('b1'), started('b1'), note('b1', 'failed'), note('b1', 'failed'), note('b1', 'failed'), level(), ...answer('x')], { sessionId: 'dsh-r', messages: [user('a')] })
  assert.equal((text.match(/job b1/g) ?? []).length, 1, text)
  getResumeSessions().delete('dsh-r')
})
