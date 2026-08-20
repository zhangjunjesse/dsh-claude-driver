// Real-SDK resume smoke test: two consecutive streamClaudeChunks calls sharing
// one DSH sessionId. Call 1 boots fresh and plants a code word; call 2 must
// resume (only the new user tail is sent) and still recall the code word —
// proving Claude's own session memory carried it, not the prompt.
// Run: node test-resume-smoke.mjs   (needs proxy + Claude Code login)
import assert from 'node:assert/strict'
import { streamClaudeChunks, getResumeSessions } from './lib/index.js'

const settings = {
  model: 'haiku',
  maxTurns: 2,
  proxy: 'http://127.0.0.1:7897',
  cwd: 'C:/Users/Administrator/Desktop/dsh-workspace/space-1',
}
const ctx = { get: () => undefined, logger: console }
const dshSessionId = `resume-smoke-${process.pid}-${Date.now()}`
const CODE = '73921'

async function collect(label, options) {
  const chunks = []
  let text = ''
  let textDeltas = 0
  for await (const chunk of streamClaudeChunks(ctx, options, settings)) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') {
      text += chunk.text
      textDeltas += 1
    }
    if (chunk.type === 'finish') {
      assert.equal(chunk.reason.kind, 'stop', `${label} must finish cleanly: ${JSON.stringify(chunk.reason)}`)
    }
  }
  console.log(`[${label}] text-deltas=${textDeltas} text=${JSON.stringify(text.slice(0, 200))}`)
  return { text, textDeltas }
}

const t0 = Date.now()
const turn1User = { role: 'user', content: [{ type: 'text', text: `请记住这个数字：${CODE}。只回复"OK"，不要调用任何工具。` }] }
const r1 = await collect('turn1-fresh', {
  provider: 'claude-code',
  sessionId: dshSessionId,
  system: '你是测试助手。',
  messages: [turn1User],
})
const sdkId1 = getResumeSessions().get(dshSessionId)
console.log(`[turn1] took ${Date.now() - t0}ms, mapped sdk session: ${sdkId1}`)
assert.ok(typeof sdkId1 === 'string' && sdkId1, 'turn 1 must record a Claude session_id')
assert.ok(r1.text.trim(), 'turn 1 must return text')

const t1 = Date.now()
const r2 = await collect('turn2-resume', {
  provider: 'claude-code',
  sessionId: dshSessionId,
  system: '你是测试助手。',
  messages: [
    turn1User,
    { role: 'assistant', content: [{ type: 'text', text: r1.text }] },
    { role: 'user', content: [{ type: 'text', text: '我之前让你记住的数字是多少？只回答数字本身，不要调用任何工具。' }] },
  ],
})
const sdkId2 = getResumeSessions().get(dshSessionId)
console.log(`[turn2] took ${Date.now() - t1}ms, mapped sdk session: ${sdkId2}`)
assert.ok(r2.text.trim(), 'turn 2 must return text')
assert.ok(r2.text.toUpperCase().includes(CODE), `turn 2 must recall the code word via resumed session memory (got: ${r2.text})`)
assert.ok(typeof sdkId2 === 'string' && sdkId2, 'turn 2 must keep a session mapping')
console.log(`session chain: ${sdkId1} -> ${sdkId2} (${sdkId1 === sdkId2 ? 'same id' : 'continued under new id'})`)
console.log('test-resume-smoke: all assertions passed')
