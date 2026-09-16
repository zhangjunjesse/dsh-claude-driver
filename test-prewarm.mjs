// Unit tests (no network, no SDK spawn) for the prewarm pool (2026-09-16):
// pre-booting the NEXT turn's CLI process while the user reads this turn's
// answer, so the follow-up message skips the ~4s local CLI init.
//   1. prewarm off (default)        -> no standing process, pool untouched
//   2. prewarm on                   -> a standing spawn appears after the turn,
//                                      with resume id + open-input prompt
//   3. compatible next turn         -> ADOPTED: no cold spawn for the turn, the
//                                      user message is PUSHED into the standing
//                                      input, output flows, entry disposed after
//   4. model switch                 -> adoption declined, entry disposed, cold
//                                      path used (with resume)
//   5. dead standing process        -> declined, cold path used
//   6. compaction / claude-fresh    -> standing process disposed with the chain
//   7. pool capacity                -> oldest conversation evicted
//   8. idle TTL                     -> standing process disposed on expiry
// Run: node test-prewarm.mjs
import assert from 'node:assert/strict'
import {
  clearResumeOnCompaction,
  createClaudeFreshCommand,
  getPrewarmPool,
  getResumeSessions,
  streamClaudeChunks,
} from './lib/index.js'

const ctx = { logger: { info: () => {}, warn: () => {} }, get: () => undefined }

// Fake SDK query. Both call shapes reach it with an AsyncIterable prompt
// (waitForBackgroundTasks on): the TURN call gets openEndedPrompt (first
// message immediately available), the PREWARM spawn gets the pushable input
// (first message arrives only at adoption; input.close() ends it unfed).
function fakeQuery(calls, { sessionId = 's1', resultText = 'done', dieUnfed = false } = {}) {
  return ({ prompt, options }) => {
    const call = { options, fed: [], kind: options.resume === undefined ? 'fresh' : 'resume' }
    calls.push(call)
    return (async function* () {
      if (dieUnfed) return // child crashed during idle boot
      if (typeof prompt === 'string') {
        call.fed.push(prompt)
      } else {
        for await (const message of prompt) {
          call.fed.push(message)
          break // first user message starts the turn, exactly like the CLI
        }
        if (call.fed.length === 0) return // input closed unfed => stdin EOF exit
      }
      yield { type: 'system', subtype: 'init', session_id: sessionId }
      yield { type: 'result', subtype: 'success', session_id: sessionId, result: resultText, usage: { output_tokens: 1 } }
    })()
  }
}

async function runTurn(sessionId, messages, settings) {
  const chunks = []
  for await (const chunk of streamClaudeChunks(
    ctx,
    { provider: 'claude-code', model: 'sonnet', sessionId, messages },
    { harvestOrphanedSubagents: false, ...settings },
  )) chunks.push(chunk)
  return chunks
}

const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')
const textOf = (chunks) =>
  chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

function drainPool() {
  for (const key of [...getPrewarmPool().keys()]) {
    const entry = getPrewarmPool().get(key)
    getPrewarmPool().delete(key)
    entry.dispose('test drain')
  }
}

const TURN1 = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
const TURN2 = [
  ...TURN1,
  { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  { role: 'user', content: [{ type: 'text', text: 'next question' }] },
]

// --- 1. prewarm off (default): no standing spawn ----------------------------
{
  const calls = []
  await runTurn('conv-off', TURN1, { queryImpl: fakeQuery(calls), waitForBackgroundTasks: true })
  assert.equal(calls.length, 1, 'exactly one spawn for the turn itself')
  assert.equal(getPrewarmPool().size, 0, 'pool untouched when prewarm is off')
  getResumeSessions().delete('conv-off')
}

// --- 2. prewarm on: standing spawn appears after the turn --------------------
{
  const calls = []
  const settings = { queryImpl: fakeQuery(calls), waitForBackgroundTasks: true, prewarm: true }
  await runTurn('conv-a', TURN1, settings)
  assert.equal(calls.length, 2, 'turn spawn + standing prewarm spawn')
  assert.equal(calls[1].options.resume, 's1', 'standing process resumes the session the turn just produced')
  assert.equal(calls[1].fed.length, 0, 'standing process has received no input yet')
  const entry = getPrewarmPool().get('conv-a')
  assert.ok(entry, 'pool holds the standing entry under the DSH session key')
  assert.equal(entry.resumeId, 's1')
  assert.equal(entry.model, 'sonnet')

  // --- 3. compatible next turn adopts it -------------------------------------
  await runTurn('conv-a', TURN2, settings)
  // call #3 is the NEW standing spawn created at the END of turn 2 — the turn
  // itself must NOT have cold-spawned (that would be a 4th call).
  assert.equal(calls.length, 3, 'adopted turn spawns nothing for itself, only its own next prewarm')
  assert.equal(calls[1].fed.length, 1, 'the user message was pushed into the standing input')
  assert.equal(calls[1].fed[0].message.content[0].text, 'next question')
  assert.ok(entry.disposed, 'adopted entry is closed once the run finishes')
  assert.equal(calls[2].options.resume, 's1', 'the follow-up standing spawn resumes the newest session id')
  drainPool()
  getResumeSessions().delete('conv-a')
}

// --- 4. model switch declines adoption, cold path used -----------------------
{
  const calls = []
  const settings = { queryImpl: fakeQuery(calls), waitForBackgroundTasks: true, prewarm: true }
  await runTurn('conv-b', TURN1, settings)
  const entry = getPrewarmPool().get('conv-b')
  const chunks = []
  for await (const chunk of streamClaudeChunks(
    ctx,
    { provider: 'claude-code', model: 'opus', sessionId: 'conv-b', messages: TURN2 },
    settings,
  )) chunks.push(chunk)
  assert.ok(entry.disposed, 'incompatible entry disposed')
  assert.equal(calls.length, 4, 'turn1 + prewarm1 + COLD turn2 + prewarm2')
  assert.equal(calls[2].options.model, 'opus', 'cold spawn carries the new model')
  assert.equal(calls[2].options.resume, 's1', 'cold spawn still resumes the chain')
  assert.equal(calls[2].fed.length, 1, 'cold spawn was fed the turn prompt itself')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  drainPool()
  getResumeSessions().delete('conv-b')
}

// --- 5. standing process died while idling => cold path ----------------------
{
  const calls = []
  const live = fakeQuery(calls)
  const dead = fakeQuery(calls, { dieUnfed: true })
  let spawnCount = 0
  const settings = {
    waitForBackgroundTasks: true,
    prewarm: true,
    queryImpl: (params) => (spawnCount++ === 1 ? dead(params) : live(params)),
  }
  await runTurn('conv-c', TURN1, settings)
  const entry = getPrewarmPool().get('conv-c')
  await new Promise((resolve) => setTimeout(resolve, 10)) // let the pump observe the death
  assert.equal(entry.ended, true, 'pump detected the idle death')
  const chunks = await runTurn('conv-c', TURN2, settings)
  assert.equal(finishOf(chunks).reason.kind, 'stop', 'turn still succeeds via the cold path')
  assert.equal(textOf(chunks), 'done')
  assert.ok(entry.disposed, 'dead entry disposed at adoption attempt')
  drainPool()
  getResumeSessions().delete('conv-c')
}

// --- 6. compaction and /claude-fresh dispose the standing process ------------
{
  const calls = []
  const settings = { queryImpl: fakeQuery(calls), waitForBackgroundTasks: true, prewarm: true }
  await runTurn('conv-d', TURN1, settings)
  const entry = getPrewarmPool().get('conv-d')
  const dropped = clearResumeOnCompaction({ id: 'conv-d' }, { type: 'compaction/summary' })
  assert.equal(dropped, true)
  assert.ok(entry.disposed, 'compaction disposes the standing process')
  assert.equal(getPrewarmPool().has('conv-d'), false)

  await runTurn('conv-e', TURN1, settings)
  const entryE = getPrewarmPool().get('conv-e')
  const command = createClaudeFreshCommand()
  const result = command.handler({ agent: { session: { id: 'conv-e' } } })
  assert.equal(result.kind, 'success')
  assert.ok(entryE.disposed, '/claude-fresh disposes the standing process')
  assert.equal(getPrewarmPool().has('conv-e'), false)
  drainPool()
  getResumeSessions().delete('conv-d')
  getResumeSessions().delete('conv-e')
}

// --- 7. pool capacity: oldest conversation evicted ---------------------------
{
  const calls = []
  const settings = { queryImpl: fakeQuery(calls), waitForBackgroundTasks: true, prewarm: true }
  await runTurn('conv-1', TURN1, settings)
  await runTurn('conv-2', TURN1, settings)
  const first = getPrewarmPool().get('conv-1')
  await runTurn('conv-3', TURN1, settings)
  assert.equal(getPrewarmPool().size, 2, 'pool capped')
  assert.ok(first.disposed, 'oldest standing process evicted')
  assert.equal(getPrewarmPool().has('conv-1'), false)
  assert.ok(getPrewarmPool().has('conv-3'))
  drainPool()
  for (const key of ['conv-1', 'conv-2', 'conv-3']) getResumeSessions().delete(key)
}

// --- 8. idle TTL disposes the standing process -------------------------------
{
  const calls = []
  const settings = { queryImpl: fakeQuery(calls), waitForBackgroundTasks: true, prewarm: true, prewarmTtlMs: 20 }
  await runTurn('conv-ttl', TURN1, settings)
  const entry = getPrewarmPool().get('conv-ttl')
  assert.ok(entry, 'standing entry present before expiry')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(entry.disposed, 'TTL disposed the idle standing process')
  assert.equal(getPrewarmPool().has('conv-ttl'), false, 'pool slot released on expiry')
  getResumeSessions().delete('conv-ttl')
}

console.log('test-prewarm: all assertions passed')
