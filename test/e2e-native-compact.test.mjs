// Real Claude CLI, local Anthropic API double: DSH's compaction call compacts the
// live Claude session natively and the session keeps working afterwards.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { clearResumeOnCompaction, endClaudeSession, getResumeSessions, streamClaudeChunks } from '../lib/index.js'
import { startMockAnthropic } from './support/mock-anthropic.mjs'

const require = createRequire(import.meta.url)
let hasCli = true
try { require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude') } catch { hasCli = false }
const opts = { skip: !hasCli && 'no claude binary', timeout: 120000 }

const saved = {}
const setEnv = (vars) => { for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v } }
let mock
let compactRequests = 0
before(async () => {
  // Route by the latest real user text in the request, ignoring the CLI's
  // injected system/reminder messages.
  const lastUserText = (messages) => {
    for (const m of [...(messages ?? [])].reverse()) {
      if (m.role !== 'user') continue
      const t = typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (t.trim() && !t.startsWith('<system-reminder>')) return t
    }
    return ''
  }
  mock = await startMockAnthropic((body) => {
    const all = JSON.stringify(body.messages ?? [])
    if (!all.includes('PELICAN') && !all.includes('codeword')) return [{ text: 'title' }]
    const last = lastUserText(body.messages)
    if (/What was the codeword\?/.test(all)) {
      // Answer only from what survived compaction: Claude's own summary.
      return [{ text: /continued from a previous conversation[\s\S]*PELICAN-42/.test(all) ? 'PELICAN-42' : 'unknown' }]
    }
    if (/Respond with TEXT ONLY/.test(last)) {
      compactRequests += 1
      return [{ text: '<analysis>a</analysis>\n<summary>\n1. Primary Request: remember the codeword PELICAN-42.\n</summary>' }]
    }
    return [{ text: 'ok' }]
  })
  setEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-e2e', CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'e2e-compact-')), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTPS_PROXY: undefined, HTTP_PROXY: undefined, ALL_PROXY: undefined })
})
after(async () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } await mock?.close() })

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const settings = { resumeChain: true, cwd: tmpdir(), model: 'sonnet' }
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const run = async (options) => {
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'sonnet', ...options }, settings)) chunks.push(c)
  return chunks
}
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

test('e2e: /compact compacts the live Claude session natively and it keeps working', opts, async () => {
  const sessionId = 'dsh-e2e-compact'
  const turn1 = [user('Remember the codeword PELICAN-42. Reply only: ok')]
  assert.equal((await run({ sessionId, messages: turn1 })).at(-1).reason.kind, 'stop')
  const claudeId = getResumeSessions().get(sessionId)
  assert.ok(claudeId, 'turn 1 opened a Claude session')

  const history = [...turn1, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]
  const compacted = await run({ sessionId, purpose: 'compaction', messages: [...history, user('Summarize the conversation.')] })
  assert.equal(compacted.at(-1).reason.kind, 'stop')
  assert.equal(compactRequests, 1, 'Claude ran its own compaction request')
  assert.match(textOf(compacted), /PELICAN-42/, 'DSH receives Claude\'s summary')

  assert.equal(clearResumeOnCompaction({ id: sessionId }, { type: 'compaction/summary', data: {} }), false)
  assert.equal(getResumeSessions().get(sessionId), claudeId, 'same Claude session id after compaction')

  const turn3 = await run({ sessionId, messages: [user('[compacted summary]'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user('What was the codeword?')] })
  assert.equal(textOf(turn3), 'PELICAN-42', 'compacted Claude session still knows the codeword')
  getResumeSessions().delete(sessionId)
})

test('e2e: ending the Claude session after a native compaction starts a fresh one that still works', opts, async () => {
  const sessionId = 'dsh-e2e-end-session'
  const turn1 = [user('Remember the codeword PELICAN-42. Reply only: ok')]
  assert.equal((await run({ sessionId, messages: turn1 })).at(-1).reason.kind, 'stop')
  const first = getResumeSessions().get(sessionId)
  assert.ok(first, 'turn 1 opened a Claude session')

  const history = [...turn1, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]
  const compacted = await run({ sessionId, purpose: 'compaction', messages: [...history, user('Summarize the conversation.')] })
  assert.equal(compacted.at(-1).reason.kind, 'stop')
  const summary = textOf(compacted)
  assert.match(summary, /PELICAN-42/, 'the compaction summary is Claude\'s own')
  assert.equal(getResumeSessions().get(sessionId), first, 'native compaction keeps the chain until the stop ends it')

  assert.equal(endClaudeSession(sessionId), true)
  assert.equal(getResumeSessions().get(sessionId), undefined, 'the resume chain is gone')

  // DSH replays the compacted history into the fresh Claude session.
  const replay = [user('This session is being continued from a previous conversation.\n' + summary), user('What was the codeword?')]
  const third = await run({ sessionId, messages: replay })
  assert.equal(textOf(third), 'PELICAN-42', 'the fresh session still knows the codeword')
  const second = getResumeSessions().get(sessionId)
  assert.ok(second, 'the next turn opened a Claude session')
  assert.notEqual(second, first, 'it is a different Claude session, not the ended one')
  getResumeSessions().delete(sessionId)
})
