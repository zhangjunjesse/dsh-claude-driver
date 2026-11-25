// Native context autocompaction for claude-code sessions: once the live
// session's context reaches Nk tokens, the next turn end compacts it with
// Claude's own /compact (same session, DSH summary), and the watch re-arms only
// after a turn reports a context below the threshold again.
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  compactContextIfDue,
  contextWatch,
  createContextWatch,
  MAX_CONTEXT_COMPACT_TOKENS,
  MIN_CONTEXT_COMPACT_TOKENS,
  normalizeCompactAtTokens,
} from '../lib/context-autocompact.js'
import { streamClaudeChunks } from '../lib/index.js'
import { runNativeCompaction } from '../lib/native-compact.js'
import { usageGuard } from '../lib/usage-guard.js'

afterEach(() => {
  contextWatch.clear()
  usageGuard.reset()
})

const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
const agent = { id: 'a', session: { id: 's1' } }

function ctxFor({ compactNow, hasAgent = true } = {}) {
  return {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'agents') return { get: () => (hasAgent ? agent : undefined) }
      if (name === 'compaction') return compactNow ? { compactNow } : undefined
      return undefined
    },
  }
}

test('a threshold is an absolute token count; 0/off and nonsense disable it', () => {
  assert.equal(MIN_CONTEXT_COMPACT_TOKENS, 10_000)
  assert.equal(MAX_CONTEXT_COMPACT_TOKENS, 2_000_000)
  assert.equal(normalizeCompactAtTokens(400_000), 400_000)
  assert.equal(normalizeCompactAtTokens(10_000.9), 10_000)
  for (const value of [0, false, null, undefined, -1, 9_999, 2_000_001, Number.NaN, '400k']) {
    assert.equal(normalizeCompactAtTokens(value), null, `${String(value)} must not arm a threshold`)
  }
})

test('the watch arms on a crossing, consumes once, and re-arms only after the context drops', () => {
  const watch = createContextWatch()
  watch.note('s1', 500_000, 400_000)
  assert.deepEqual(watch.get('s1'), { tokens: 500_000, armed: true }, 'a first observation over the line is a crossing')
  assert.equal(watch.take('s1', 400_000), true)
  assert.equal(watch.take('s1', 400_000), false, 'one compaction per crossing')
  watch.note('s1', 520_000, 400_000)
  assert.equal(watch.take('s1', 400_000), false, 'still over the line after a compaction: no loop')
  watch.note('s1', 120_000, 400_000)
  assert.equal(watch.take('s1', 400_000), false, 'below the line arms but does not fire')
  watch.note('s1', 450_000, 400_000)
  assert.equal(watch.take('s1', 400_000), true, 'a new crossing fires again')
})

test('a native compaction records the post-compaction context as disarmed', () => {
  const watch = createContextWatch()
  watch.note('s1', 900_000, 400_000)
  watch.markCompacted('s1', 12_000)
  assert.deepEqual(watch.get('s1'), { tokens: 12_000, armed: false })
  assert.equal(watch.take('s1', 400_000), false)
  watch.markCompacted('s1', 0)
  assert.deepEqual(watch.get('s1'), { tokens: 0, armed: false })
})

test('a due threshold compacts natively once and keeps the session', async () => {
  const calls = []
  contextWatch.note('s1', 500_000, 400_000)
  const compacted = await compactContextIfDue(ctxFor({ compactNow: async (target) => calls.push(target) }), { sessionId: 's1' }, { compactAtTokens: 400_000 })
  assert.equal(compacted, true)
  assert.deepEqual(calls, [agent])
  assert.equal(await compactContextIfDue(ctxFor({ compactNow: async () => calls.push('again') }), { sessionId: 's1' }, { compactAtTokens: 400_000 }), false)
  assert.equal(calls.length, 1)
})

test('a busy agent is retried with backoff', async () => {
  let attempts = 0
  contextWatch.note('s1', 500_000, 400_000)
  const compacted = await compactContextIfDue(
    ctxFor({
      compactNow: async () => {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('agent busy'), { code: 'busy' })
      },
    }),
    { sessionId: 's1' },
    { compactAtTokens: 400_000 },
    { retryDelayMs: 1 },
  )
  assert.equal(compacted, true)
  assert.equal(attempts, 2)
})

test('a failed compaction re-arms so a later turn retries', async () => {
  contextWatch.note('s1', 500_000, 400_000)
  const compacted = await compactContextIfDue(
    ctxFor({ compactNow: async () => { throw new Error('refused') } }),
    { sessionId: 's1' },
    { compactAtTokens: 400_000 },
    { retryDelayMs: 1 },
  )
  assert.equal(compacted, false)
  assert.equal(contextWatch.get('s1').armed, true)
})

test('nothing fires while off, below the threshold, or stopped by the plan guard', async () => {
  let calls = 0
  const compactNow = async () => {
    calls += 1
  }
  contextWatch.note('s1', 500_000, 400_000)
  assert.equal(await compactContextIfDue(ctxFor({ compactNow }), { sessionId: 's1' }, { compactAtTokens: 0 }), false)
  assert.equal(await compactContextIfDue(ctxFor({ compactNow }), { sessionId: 's1' }, { compactAtTokens: 600_000 }), false)
  usageGuard.observe({ ok: true, windows: { fiveHour: { percent: 99, resetsAt: new Date(Date.now() + 60_000).toISOString() } } }, { sessionId: 's1' })
  assert.equal(await compactContextIfDue(ctxFor({ compactNow }), { sessionId: 's1' }, { compactAtTokens: 400_000 }), false)
  assert.equal(calls, 0)
})

test('a session that switched away from this route is not compacted by a stale watch', async () => {
  let calls = 0
  const otherRoute = {
    id: 'a',
    session: { id: 's1', requestHeader: () => ({ config: { provider: 'deepseek' } }) },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'agents' ? { get: () => otherRoute } : name === 'compaction' ? { compactNow: async () => { calls += 1 } } : undefined),
  }
  contextWatch.note('s1', 500_000, 400_000)
  assert.equal(await compactContextIfDue(ctx, { sessionId: 's1' }, { compactAtTokens: 400_000, provider: 'claude-code' }), false)
  assert.equal(calls, 0)
  assert.equal(contextWatch.get('s1').armed, true, 'the crossing is still owed if the session returns to Claude')
})

test('legacy flags cannot disable native autocompaction or select a fallback', async () => {
  const warnings = []
  let calls = 0
  const ctx = {
    logger: { info() {}, warn: (message) => warnings.push(String(message)) },
    get: (name) => (name === 'agents' ? { get: () => agent } : name === 'compaction' ? { compactNow: async () => { calls += 1 } } : undefined),
  }
  contextWatch.note('s1', 500_000, 400_000)
  assert.equal(await compactContextIfDue(ctx, { sessionId: 's1' }, { compactAtTokens: 400_000, nativeCompaction: false, resumeChain: false }), true)
  assert.equal(await compactContextIfDue(ctx, { sessionId: 's1' }, { compactAtTokens: 400_000, nativeCompaction: false, resumeChain: false }), false)
  assert.equal(calls, 1)
  assert.doesNotMatch(warnings.join('\n'), /falls? back|one-shot/i)
})

test('a finished turn records the real last-request context', async () => {
  const queryImpl = () =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-1' }
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'claude-1',
        message: {
          role: 'assistant',
          model: 'sonnet',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1200, output_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 1000 },
        },
      }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-1',
        result: 'ok',
        usage: { input_tokens: 321200, output_tokens: 10 },
        modelUsage: { sonnet: { inputTokens: 1200, outputTokens: 10, cacheReadInputTokens: 300000, cacheCreationInputTokens: 1000 } },
      }
    })()
  for await (const _chunk of streamClaudeChunks(
    { get: () => undefined, logger: { info() {}, warn() {} } },
    { ...opts, sessionId: 'ctx-session' },
    { resumeChain: false, queryImpl, compactAtTokens: 400000 },
  )) {
    // drain
  }
  assert.deepEqual(contextWatch.get('ctx-session'), { tokens: 302200, armed: true })
})

test('internal calls (the compaction itself) never move the watch', async () => {
  const queryImpl = () =>
    (async function* () {
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'claude-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 500000, output_tokens: 1 } },
      }
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-1', result: 'ok', usage: { input_tokens: 500000, output_tokens: 1 } }
    })()
  for await (const _chunk of streamClaudeChunks(
    { get: () => undefined, logger: { info() {}, warn() {} } },
    { ...opts, sessionId: 'ctx-internal', purpose: 'compaction' },
    { resumeChain: false, queryImpl, compactAtTokens: 400000 },
  )) {
    // drain
  }
  assert.equal(contextWatch.get('ctx-internal'), undefined)
})

test('native compaction hands its post-compaction token count back to the watch', async () => {
  const runQuery = ({ options }) =>
    (async function* () {
      for (const group of options.hooks.PostCompact) for (const hook of group.hooks) await hook({ compact_summary: 'condensed' })
      yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 900000, post_tokens: 12000 } }
      yield { type: 'result', subtype: 'success', is_error: false, usage: {} }
    })()
  const result = await runNativeCompaction({
    runQuery,
    sdkOptions: {},
    settings: {},
    dshSessionId: 'native-s1',
    claudeSessionId: 'claude-native-1',
    logger: { info() {}, warn() {} },
  })
  assert.equal(result.summary, 'condensed')
  assert.deepEqual(contextWatch.get('native-s1'), { tokens: 12000, armed: false })
})
