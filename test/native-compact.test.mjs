// DSH compaction on a claude-code session compacts the LIVE Claude session with
// Claude's own /compact (same session id), and DSH's summary is Claude's.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clearResumeOnCompaction, getResumeSessions, streamClaudeChunks } from '../lib/index.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const user = (text) => ({ role: 'user', content: [{ type: 'text', text: text }] })
const SUMMARY = 'Summary:\n1. User asked to remember PELICAN-42.'
const compactionCall = (sessionId) => ({
  provider: 'claude-code', model: 'sonnet', sessionId, purpose: 'compaction',
  messages: [user('remember PELICAN-42'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user('Summarize the conversation so far ...')],
})
async function drain(options, settings) {
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, options, { resumeChain: true, ...settings })) chunks.push(c)
  return chunks
}
const text = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

// Fake Claude that honours /compact on a resumed session like the real CLI:
// compact_boundary, PostCompact hook with the summary, result, same session id.
function fakeClaude(calls, { compactFails = false, sessionIdOverride } = {}) {
  return ({ prompt, options }) => {
    calls.push({ prompt, options })
    return (async function* () {
      const sid = sessionIdOverride ?? options.resume ?? 'claude-new'
      yield { type: 'system', subtype: 'init', session_id: sid }
      if (prompt === '/compact') {
        if (compactFails) {
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Not enough messages to compact'], session_id: sid }
          return
        }
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 15000, post_tokens: 5000 }, session_id: sid }
        for (const h of options.hooks?.PostCompact ?? []) for (const fn of h.hooks) await fn({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: SUMMARY, session_id: sid }, undefined, { signal: new AbortController().signal })
        yield { type: 'result', subtype: 'success', result: '', session_id: sid, usage: { input_tokens: 15000, output_tokens: 900 } }
        return
      }
      yield { type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'one-shot summary' }] } }
      yield { type: 'result', subtype: 'success', result: 'one-shot summary', session_id: sid, usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  }
}

test('compaction on a live chain runs Claude /compact on that same session and returns its summary', async () => {
  const sessions = getResumeSessions()
  sessions.set('dsh-1', 'claude-abc')
  const calls = []
  const chunks = await drain(compactionCall('dsh-1'), { queryImpl: fakeClaude(calls) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, '/compact')
  assert.equal(calls[0].options.resume, 'claude-abc')
  assert.equal(text(chunks), SUMMARY)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(sessions.get('dsh-1'), 'claude-abc', 'chain kept: same Claude session continues')
  sessions.delete('dsh-1')
})

test('the committed compaction/summary keeps a natively compacted chain', async () => {
  const sessions = getResumeSessions()
  sessions.set('dsh-2', 'claude-def')
  await drain(compactionCall('dsh-2'), { queryImpl: fakeClaude([]) })
  const dropped = clearResumeOnCompaction({ id: 'dsh-2' }, { type: 'compaction/summary', data: { summary: [{ type: 'text', text: SUMMARY }], provider: 'claude-code', model: 'sonnet' } })
  assert.equal(dropped, false)
  assert.equal(sessions.get('dsh-2'), 'claude-def')
  sessions.delete('dsh-2')
})

test('a compaction/summary event never resets the Claude session chain', () => {
  const sessions = getResumeSessions()
  sessions.set('dsh-3', 'claude-ghi')
  assert.equal(clearResumeOnCompaction({ id: 'dsh-3' }, { type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'unexpected external summary' }], provider: 'deepseek', model: 'x' } }), false)
  assert.equal(sessions.get('dsh-3'), 'claude-ghi')
  sessions.delete('dsh-3')
})

test('no live chain: compaction fails closed without a one-shot request', async () => {
  const calls = []
  const chunks = await drain(compactionCall('dsh-none'), { queryImpl: fakeClaude(calls) })
  assert.equal(calls.length, 0, 'no fresh Claude session and no one-shot summary')
  assert.equal(text(chunks), '')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'NATIVE_COMPACTION')
  assert.equal(getResumeSessions().has('dsh-none'), false)
})

test('native /compact failure preserves the chain and never falls back to a one-shot summary', async () => {
  const sessions = getResumeSessions()
  sessions.set('dsh-4', 'claude-jkl')
  const calls = []
  const chunks = await drain(compactionCall('dsh-4'), { queryImpl: fakeClaude(calls, { compactFails: true }) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, '/compact')
  assert.equal(calls[0].options.resume, 'claude-jkl')
  assert.equal(text(chunks), '')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'NATIVE_COMPACTION')
  assert.equal(sessions.get('dsh-4'), 'claude-jkl')
  sessions.delete('dsh-4')
})

test('nativeCompaction:false cannot select the removed one-shot fallback', async () => {
  const sessions = getResumeSessions()
  sessions.set('dsh-5', 'claude-mno')
  const calls = []
  const chunks = await drain(compactionCall('dsh-5'), { queryImpl: fakeClaude(calls), nativeCompaction: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, '/compact')
  assert.equal(calls[0].options.resume, 'claude-mno')
  assert.equal(text(chunks), SUMMARY)
  sessions.delete('dsh-5')
})

test('resumeChain:false cannot disable native compaction', async () => {
  const sessions = getResumeSessions()
  sessions.set('dsh-legacy-chain', 'claude-legacy-chain')
  const calls = []
  const chunks = await drain(compactionCall('dsh-legacy-chain'), { queryImpl: fakeClaude(calls), resumeChain: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, '/compact')
  assert.equal(calls[0].options.resume, 'claude-legacy-chain')
  assert.equal(text(chunks), SUMMARY)
  sessions.delete('dsh-legacy-chain')
})

test('native compaction rejects a changed SDK session id without overwriting the chain', async () => {
  const sessions = getResumeSessions()
  sessions.set('dsh-mismatch', 'claude-expected')
  const calls = []
  const chunks = await drain(compactionCall('dsh-mismatch'), { queryImpl: fakeClaude(calls, { sessionIdOverride: 'claude-unexpected' }) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.resume, 'claude-expected')
  assert.equal(text(chunks), '')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'NATIVE_COMPACTION')
  assert.equal(sessions.get('dsh-mismatch'), 'claude-expected')
  sessions.delete('dsh-mismatch')
})

test('a host restart hydrates the persisted Claude id before compacting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-restart-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = dir
    const { createResumeStore, resumeStorePath } = await import('../lib/resume-store.js')
    createResumeStore({ file: resumeStorePath() }).set('dsh-restart', {
      claudeSessionId: 'claude-persisted', provider: 'claude-code', cwd: process.cwd(), savedAt: Date.now(),
    })
    const isolated = await import(`../lib/index.js?native-restart=${Date.now()}`)
    const calls = []
    const chunks = []
    for await (const chunk of isolated.streamClaudeChunks(ctx, compactionCall('dsh-restart'), { resumeChain: true, queryImpl: fakeClaude(calls) })) chunks.push(chunk)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].prompt, '/compact')
    assert.equal(calls[0].options.resume, 'claude-persisted')
    assert.equal(text(chunks), SUMMARY)
    assert.equal(isolated.getResumeSessions().get('dsh-restart'), 'claude-persisted')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('the next goal round after native compaction resumes the compacted Claude session', async () => {
  const sessions = getResumeSessions()
  sessions.set('dsh-6', 'claude-pqr')
  await drain(compactionCall('dsh-6'), { queryImpl: fakeClaude([]) })
  clearResumeOnCompaction({ id: 'dsh-6' }, { type: 'compaction/summary', data: { summary: [{ type: 'text', text: SUMMARY }] } })
  const calls = []
  await drain({ provider: 'claude-code', model: 'sonnet', sessionId: 'dsh-6', messages: [user('a'), { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, user('<goal_round>what was the codeword?</goal_round>')] }, { queryImpl: fakeClaude(calls) })
  assert.equal(calls[0].options.resume, 'claude-pqr')
  const prompt = calls[0].prompt
  const first = typeof prompt === 'string' ? prompt : JSON.stringify((await prompt[Symbol.asyncIterator]().next()).value)
  assert.match(first, /codeword/)
  sessions.delete('dsh-6')
})
