// Pure unit tests (no network, no SDK spawn) for the resume-chain decision
// logic in lib/index.js: tail extraction, fresh-vs-resume planning, and
// partial-delta dedupe. Run: node test-resume-plan.mjs
import assert from 'node:assert/strict'
import { extractResumeTail, planPrompt, remainderAfterPartial } from './lib/index.js'

const u = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const a = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

// --- extractResumeTail ---
assert.deepEqual(extractResumeTail([]), [])
assert.deepEqual(extractResumeTail(undefined), [])
assert.deepEqual(extractResumeTail([u('q1')]), [u('q1')])
assert.deepEqual(extractResumeTail([u('q1'), a('r1'), u('q2')]), [u('q2')])
// steering tail: several trailing non-assistant messages all survive
assert.deepEqual(extractResumeTail([u('q1'), a('r1'), u('q2'), u('steer')]), [u('q2'), u('steer')])
// last message is assistant -> empty tail
assert.deepEqual(extractResumeTail([u('q1'), a('r1')]), [])

// --- planPrompt: fresh on first call (no mapping) ---
const settings = { resumeChain: true }
const sessions = new Map()
const baseOptions = {
  sessionId: 'dsh-1',
  system: 'SYS-PROMPT',
  messages: [u('q1'), a('r1'), u('q2')],
}
{
  const plan = planPrompt(baseOptions, settings, sessions)
  assert.equal(plan.mode, 'fresh')
  assert.equal(plan.chainKey, 'dsh-1')
  assert.ok(plan.prompt.includes('<dsystem>\nSYS-PROMPT\n</dsystem>'), 'fresh carries system')
  assert.ok(plan.prompt.includes('q1') && plan.prompt.includes('r1') && plan.prompt.includes('q2'), 'fresh carries full history')
}

// --- planPrompt: resume once a mapping exists ---
sessions.set('dsh-1', 'sdk-session-abc')
{
  const plan = planPrompt(baseOptions, settings, sessions)
  assert.equal(plan.mode, 'resume')
  assert.equal(plan.resumeId, 'sdk-session-abc')
  assert.equal(plan.chainKey, 'dsh-1')
  assert.equal(plan.prompt, 'q2', 'resume sends only the new tail, unwrapped single user message')
  assert.ok(!plan.prompt.includes('SYS-PROMPT'), 'resume omits system')
  assert.ok(!plan.prompt.includes('q1'), 'resume omits prior history')
}

// --- planPrompt: steering tail keeps role tags ---
{
  const plan = planPrompt({ ...baseOptions, messages: [u('q1'), a('r1'), u('q2'), u('steer')] }, settings, sessions)
  assert.equal(plan.mode, 'resume')
  assert.ok(plan.prompt.includes('<User>\nq2\n</User>') && plan.prompt.includes('<User>\nsteer\n</User>'))
  assert.ok(!plan.prompt.includes('q1'))
}

// --- planPrompt: empty tail (last message assistant) falls back to fresh ---
{
  const plan = planPrompt({ ...baseOptions, messages: [u('q1'), a('r1')] }, settings, sessions)
  assert.equal(plan.mode, 'fresh')
  assert.ok(plan.prompt.includes('SYS-PROMPT'))
}

// --- planPrompt: internal purposes never resume nor join the chain ---
for (const purpose of ['compaction', 'session-title']) {
  const plan = planPrompt({ ...baseOptions, purpose }, settings, sessions)
  assert.equal(plan.mode, 'fresh', `${purpose} stays fresh`)
  assert.equal(plan.chainKey, undefined, `${purpose} never updates the chain`)
  assert.ok(plan.prompt.includes('q1'), `${purpose} carries full history`)
}

// --- planPrompt: resumeChain=false disables everything ---
{
  const plan = planPrompt(baseOptions, { resumeChain: false }, sessions)
  assert.equal(plan.mode, 'fresh')
  assert.equal(plan.chainKey, undefined)
}

// --- planPrompt: missing sessionId -> fresh, no chain ---
{
  const plan = planPrompt({ ...baseOptions, sessionId: undefined }, settings, sessions)
  assert.equal(plan.mode, 'fresh')
  assert.equal(plan.chainKey, undefined)
}

// --- remainderAfterPartial (partial-delta dedupe) ---
assert.equal(remainderAfterPartial('hello world', ''), 'hello world', 'no partials -> whole block')
assert.equal(remainderAfterPartial('hello world', 'hello world'), '', 'fully streamed -> nothing')
assert.equal(remainderAfterPartial('hello world', 'hello'), ' world', 'prefix streamed -> tail only')
assert.equal(remainderAfterPartial('block2', 'block1block2'), '', 'mismatch (split messages) -> no duplicate')
assert.equal(remainderAfterPartial('', 'x'), '', 'empty block -> nothing')

console.log('test-resume-plan: all assertions passed')
