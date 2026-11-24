// A compaction the driver owes (plan-window stop, context threshold) must show
// up in the transcript. DSH only renders one when it runs as the `/compact`
// command, and `compactNow` needs the agent's true idle phase — `turn/end`
// publishes while the driver is still running, which is why the old short busy
// retries silently compacted nothing.
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  armCompaction,
  clearCompaction,
  COMPACTION_COMMAND,
  flushCompaction,
  pendingCompaction,
  runDueCompaction,
  waitForIdle,
} from '../lib/compaction-cue.js'
import { apply } from '../lib/index.js'

afterEach(() => {
  clearCompaction()
})

const idleAgent = (sessionId = 's1') => ({ id: 'a', status: 'idle', session: { id: sessionId } })

const success = (text = 'Compacted 3 history items (~10 tokens).', sourceEventSeq = 9) => ({
  result: { kind: 'success', text, sourceEventSeq },
})

function ctxFor({ agent, commands, compaction } = {}) {
  return {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'commands') return commands
      if (name === 'compaction') return compaction
      return undefined
    },
  }
}

test('a due compaction waits for the idle phase instead of running into a closing turn', async () => {
  const calls = []
  let release
  const agent = { status: 'running', session: { id: 's1' }, whenIdle: () => new Promise((resolve) => { release = resolve }) }
  const ctx = ctxFor({ agent, commands: { execute: async (target, line) => { calls.push([target, line]); return success() } } })
  armCompaction('s1', { kind: 'usage-stop' })
  const running = runDueCompaction(ctx, { sessionId: 's1' })
  await Promise.resolve()
  assert.deepEqual(calls, [], 'a running agent is never compacted mid-turn')
  agent.status = 'idle'
  release()
  assert.equal(await running, true)
  assert.deepEqual(calls, [[agent, COMPACTION_COMMAND]])
  assert.equal(pendingCompaction('s1'), undefined, 'the cue is spent once')
})

test('the compaction runs as /compact, the command DSH renders as a transcript cue', async () => {
  const calls = []
  const agent = idleAgent()
  const ctx = ctxFor({ agent, commands: { execute: async (target, line, attachments, signal) => { calls.push({ target, line, attachments, signal }); return success() } } })
  armCompaction('s1', { kind: 'usage-stop', endSession: () => calls.push('end') })
  assert.equal(await runDueCompaction(ctx, { sessionId: 's1' }), true)
  assert.equal(calls[0].line, '/compact', 'the command path appends command/run + command/done')
  assert.deepEqual(calls[0].attachments, [])
  assert.equal(calls[0].target, agent)
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.equal(calls.at(-1), 'end', 'the stop ends the Claude session after the cue landed')
})

test('a stop that finds nothing to compact keeps the cheap Claude resume point', async () => {
  const events = []
  const ctx = ctxFor({ agent: idleAgent(), commands: { execute: async () => ({ result: { kind: 'success', text: 'No compactable history yet.' } }) } })
  armCompaction('s1', { kind: 'usage-stop', endSession: () => events.push('end') })
  assert.equal(await runDueCompaction(ctx, { sessionId: 's1' }), false)
  assert.deepEqual(events, [], 'a no-op compaction must not drop the session')
})

test('a refused compaction is reported and never ends the session', async () => {
  const events = []
  const ctx = ctxFor({ agent: idleAgent(), commands: { execute: async () => ({ result: { kind: 'error', text: 'Compaction could not produce a useful summary.' } }) } })
  armCompaction('s1', { kind: 'usage-stop', endSession: () => events.push('end') })
  assert.equal(await runDueCompaction(ctx, { sessionId: 's1' }), false)
  assert.deepEqual(events, [])
  assert.equal(pendingCompaction('s1'), undefined, 'a hard failure is not retried forever')
})

test('a busy compaction is retried with backoff', async () => {
  let attempts = 0
  const ctx = ctxFor({
    agent: idleAgent(),
    commands: {
      execute: async () => {
        attempts += 1
        return attempts === 1
          ? { result: { kind: 'error', text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.' } }
          : success('Compacted 2 history items (~5 tokens).', 4)
      },
    },
  })
  armCompaction('s1', { kind: 'context' })
  assert.equal(await runDueCompaction(ctx, { sessionId: 's1', retryDelayMs: 1 }), true)
  assert.equal(attempts, 2)
})

test('a compaction that stays busy re-arms for the next idle transition', async () => {
  const ctx = ctxFor({ agent: idleAgent(), commands: { execute: async () => ({ result: { kind: 'error', text: 'the agent is not idle' } }) } })
  armCompaction('s1', { kind: 'usage-stop' })
  assert.equal(await runDueCompaction(ctx, { sessionId: 's1', retryDelayMs: 1, attempts: 2 }), false)
  assert.notEqual(pendingCompaction('s1'), undefined, 'still owed: the stop hook never asks again')
})

test('without a command registry it still compacts, and says the transcript cue is missing', async () => {
  const warnings = []
  const ctx = {
    logger: { info() {}, warn: (message) => warnings.push(String(message)) },
    get: (name) => (name === 'agents' ? { get: () => idleAgent() } : name === 'compaction' ? { compactNow: async () => ({ summary: 'condensed' }) } : undefined),
  }
  armCompaction('s1', { kind: 'context' })
  assert.equal(await runDueCompaction(ctx, { sessionId: 's1' }), true)
  assert.match(warnings.join('\n'), /\/compact/, 'the missing cue is named, not silent')
})

test('the idle hook flushes the armed request once and leaves a running agent alone', async () => {
  let executions = 0
  const agent = idleAgent()
  const ctx = ctxFor({ agent, commands: { execute: async () => { executions += 1; return success() } } })
  assert.equal(await flushCompaction(ctx, agent), false, 'nothing armed, nothing runs')
  armCompaction('s1', { kind: 'context' })
  agent.status = 'running'
  assert.equal(await flushCompaction(ctx, agent), false, 'a running agent keeps the request armed')
  assert.notEqual(pendingCompaction('s1'), undefined)
  agent.status = 'idle'
  assert.equal(await flushCompaction(ctx, agent), true)
  assert.equal(await flushCompaction(ctx, agent), false, 'one cue per crossing')
  assert.equal(executions, 1)
})

test('a second caller joins the run in progress instead of compacting twice', async () => {
  let executions = 0
  let release
  const agent = idleAgent()
  const ctx = ctxFor({
    agent,
    commands: {
      execute: async () => {
        executions += 1
        await new Promise((resolve) => { release = resolve })
        return success()
      },
    },
  })
  armCompaction('s1', { kind: 'context' })
  const first = flushCompaction(ctx, agent)
  await Promise.resolve()
  const second = flushCompaction(ctx, agent)
  await Promise.resolve()
  release()
  assert.equal(await first, true)
  assert.equal(await second, true, 'the second caller awaits the same run')
  assert.equal(executions, 1)
})

test('a caller that arrives after the cue already ran reports it instead of re-arming', async () => {
  const agent = idleAgent()
  const ctx = ctxFor({ agent, commands: { execute: async () => success() } })
  armCompaction('s1', { kind: 'context' })
  assert.equal(await flushCompaction(ctx, agent), true)
  assert.equal(await runDueCompaction(ctx, { sessionId: 's1' }), true, 'the late caller sees the landed compaction')
})

test('waitForIdle resolves from either side and falls back to the busy retry', async () => {
  assert.equal(await waitForIdle({ status: 'idle' }), true)
  assert.equal(await waitForIdle({ status: 'running' }), true, 'no whenIdle: compacts now, the busy retry covers the phase')
  assert.equal(await waitForIdle({ status: 'running', whenIdle: async () => {} }), true)
  assert.equal(await waitForIdle({ status: 'running', whenIdle: () => { throw new Error('gone') } }), true)
  let release
  const slow = waitForIdle({ status: 'running', whenIdle: () => new Promise((resolve) => { release = resolve }) }, { timeoutMs: 20 })
  assert.equal(await slow, false, 'a driver that never idles gives up instead of hanging')
  release()
})

test('apply() flushes a due compaction on the agent/status idle transition', async () => {
  const handlers = new Map()
  let executions = 0
  const agent = idleAgent()
  const ctx = {
    logger: { info() {}, warn() {} },
    on: (event, fn) => { handlers.set(event, fn); return () => {} },
    get: (name) => {
      if (name === 'agents') return { get: () => agent, currentInitiator: () => agent }
      if (name === 'commands') return { execute: async () => { executions += 1; return success() }, register: () => {} }
      if (name === 'compaction') return { compactNow: async () => ({ summary: 'condensed' }) }
      return undefined
    },
  }
  apply(ctx, { provider: 'claude-code', checkCliOnLoad: false })
  armCompaction('s1', { kind: 'context' })
  handlers.get('agent/status')({ agent, status: 'idle' })
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(executions, 1, 'the idle transition is the moment the cue runs')
})

test('apply() drops a due request when its agent is disposed', async () => {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    on: (event, fn) => { handlers.set(event, fn); return () => {} },
    get: () => undefined,
  }
  apply(ctx, { provider: 'claude-code', checkCliOnLoad: false })
  armCompaction('s1', { kind: 'context' })
  handlers.get('agent/disposed')({ agent: idleAgent() })
  assert.equal(pendingCompaction('s1'), undefined)
})
