// Pure unit tests (no network, no SDK spawn) for nativeToolCards: bridged
// DSH tool execution must append the durable tool/call + tool/result session
// event pair with the exact shape dsh-agent-loop writes (open turn/step
// numbers, raw-JSON-string arguments, tool-result user message citing the
// call seq via sourceEventSeqs, surfaceOp 'append'), and the text progress
// line must be suppressed for exactly those tools. Run: node test-native-tool-cards.mjs
import assert from 'node:assert/strict'
import {
  buildToolBridge,
  buildToolResultMessage,
  openStepPosition,
  renderToolProgress,
  streamClaudeChunks,
} from './lib/index.js'

// --- minimal session mock honoring the dsh-session append contract ---------
function mockSession(seed = []) {
  const events = []
  const session = {
    id: 'card-test',
    get events() {
      return events
    },
    append(type, data, opts) {
      const event = { type, seq: events.length, time: 1, data, ...(opts ?? {}) }
      events.push(event)
      return event
    },
  }
  for (const [type, data, opts] of seed) session.append(type, data, opts)
  return session
}

const openStepSeed = [
  ['turn/start', { turn: 1 }],
  ['step/start', { turn: 1, step: 1 }],
]

function mockCtx({ session, executeImpl }) {
  const agent = session ? { id: 'card-test', session } : undefined
  const calls = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get(name) {
      if (name === 'tools')
        return {
          execute: async (exec) => {
            calls.push(exec)
            return executeImpl(exec)
          },
        }
      if (name === 'agents') return { currentInitiator: () => agent }
      return undefined
    },
  }
  return { ctx, calls }
}

const toolSchemas = [
  {
    name: 'pwsh',
    description: 'Run PowerShell.',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  },
]
const bridgeOptions = { provider: 'claude-code', tools: toolSchemas }

// --- openStepPosition: log-derived open turn/step ---------------------------
{
  const session = mockSession(openStepSeed)
  assert.deepEqual(openStepPosition(session), { turn: 1, step: 1 }, 'open step found')
  session.append('step/end', { turn: 1, step: 1 })
  assert.equal(openStepPosition(session), undefined, 'closed step yields no position')
  assert.equal(openStepPosition({ id: 'no-events' }), undefined, 'sessions without a log are tolerated')
}

// --- buildToolResultMessage: dsh-llm createToolResultMessage shape ----------
{
  const message = buildToolResultMessage('c1', [{ type: 'text', text: 'ok' }], false)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'tool', callId: 'c1' })
  assert.equal(message.content[0].type, 'tool-result')
  assert.equal(message.content[0].toolCallId, 'c1')
  assert.equal(message.content[0].isError, false)
  assert.ok(typeof message.id === 'string' && message.id.length > 0, 'message carries an identity')
}

// --- success path: tool execution appends the tool/call + tool/result pair --
{
  const session = mockSession(openStepSeed)
  const { ctx, calls } = mockCtx({
    session,
    executeImpl: () => ({ content: [{ type: 'text', text: '7' }], isError: false, meta: { exitCode: 0 } }),
  })
  const bridge = buildToolBridge(ctx, bridgeOptions, { nativeToolCards: true }, new AbortController())
  assert.ok(bridge, 'bridge built')
  const reply = await bridge.handlers.get('pwsh')({ cmd: 'echo 7' })
  assert.deepEqual(reply, { content: [{ type: 'text', text: '7' }], isError: false })

  const call = session.events.find((e) => e.type === 'tool/call')
  const result = session.events.find((e) => e.type === 'tool/result')
  assert.ok(call, 'tool/call appended')
  assert.ok(result, 'tool/result appended')
  assert.ok(call.seq < result.seq, 'call precedes result')
  // tool/call payload: open turn/step, DSH bare name, raw JSON-string arguments
  assert.equal(call.data.turn, 1)
  assert.equal(call.data.step, 1)
  assert.equal(call.data.name, 'pwsh')
  assert.equal(typeof call.data.callId, 'string')
  assert.equal(call.data.arguments, JSON.stringify({ cmd: 'echo 7' }), 'arguments stored as raw JSON string')
  assert.equal(call.surfaceOp, undefined, 'tool/call carries no surfaceOp')
  // tool/result payload: same turn/step, message cites the callId, event cites the call seq
  assert.equal(result.data.turn, 1)
  assert.equal(result.data.step, 1)
  assert.equal(result.data.message.source.callId, call.data.callId)
  assert.equal(result.data.message.content[0].toolCallId, call.data.callId)
  assert.equal(result.data.message.content[0].isError, false)
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: '7' }])
  assert.deepEqual(result.data.meta, { exitCode: 0 }, 'meta passes through for presentResult')
  assert.equal(result.surfaceOp, 'append')
  assert.deepEqual(result.sourceEventSeqs, [call.seq], 'result cites its call event')
  assert.equal(calls[0].callId, call.data.callId, 'tools.execute shares the card callId')
  // name mapping helper: mcp__-prefixed and bare names both resolve
  assert.equal(bridge.rendersCard('mcp__dsh-tools__pwsh'), true)
  assert.equal(bridge.rendersCard('pwsh'), true)
  assert.equal(bridge.rendersCard('Bash'), false, 'Claude built-ins keep the text fallback')
}

// --- error result: event carries error info, isError true -------------------
{
  const session = mockSession(openStepSeed)
  const { ctx } = mockCtx({
    session,
    executeImpl: () => ({
      content: [{ type: 'text', text: 'Error: boom' }],
      isError: true,
      error: { message: 'boom', info: { name: 'ToolError', code: 'BOOM' } },
    }),
  })
  const bridge = buildToolBridge(ctx, bridgeOptions, { nativeToolCards: true }, new AbortController())
  const reply = await bridge.handlers.get('pwsh')({ cmd: 'bad' })
  assert.equal(reply.isError, true)
  const result = session.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].isError, true)
  assert.deepEqual(result.data.error, { name: 'ToolError', code: 'BOOM' }, 'error.info rides the event error field')
  assert.equal(result.data.meta, undefined, 'absent meta stays absent')
}

// --- tools.execute throw: card still closes with a synthetic error ----------
{
  const session = mockSession(openStepSeed)
  const { ctx } = mockCtx({
    session,
    executeImpl: () => {
      throw new Error('pipeline exploded')
    },
  })
  const bridge = buildToolBridge(ctx, bridgeOptions, { nativeToolCards: true }, new AbortController())
  await assert.rejects(() => bridge.handlers.get('pwsh')({ cmd: 'x' }), /pipeline exploded/)
  const result = session.events.find((e) => e.type === 'tool/result')
  assert.ok(result, 'card closed despite the throw')
  assert.equal(result.data.message.content[0].isError, true)
}

// --- nativeToolCards:false — execution unchanged, zero session events -------
{
  const session = mockSession(openStepSeed)
  const { ctx, calls } = mockCtx({
    session,
    executeImpl: () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  })
  const bridge = buildToolBridge(ctx, bridgeOptions, { nativeToolCards: false }, new AbortController())
  await bridge.handlers.get('pwsh')({ cmd: 'x' })
  assert.equal(calls.length, 1, 'tool still executes')
  assert.equal(session.events.filter((e) => e.type === 'tool/call' || e.type === 'tool/result').length, 0)
  assert.equal(bridge.rendersCard('pwsh'), false, 'disabled cards keep the text progress')
}

// --- no open step (invariant would reject): skip the card, keep executing ---
{
  const session = mockSession([...openStepSeed, ['step/end', { turn: 1, step: 1 }]])
  const { ctx, calls } = mockCtx({
    session,
    executeImpl: () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  })
  const bridge = buildToolBridge(ctx, bridgeOptions, { nativeToolCards: true }, new AbortController())
  await bridge.handlers.get('pwsh')({ cmd: 'x' })
  assert.equal(calls.length, 1)
  assert.equal(session.events.filter((e) => e.type === 'tool/call').length, 0, 'no card outside an open step')
}

// --- session without append (test-run-style mock): cards degrade silently ---
{
  const session = { id: 'bare' }
  const { ctx, calls } = mockCtx({
    session,
    executeImpl: () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  })
  const bridge = buildToolBridge(ctx, bridgeOptions, { nativeToolCards: true }, new AbortController())
  await bridge.handlers.get('pwsh')({ cmd: 'x' })
  assert.equal(calls.length, 1, 'execution unaffected')
  assert.equal(bridge.rendersCard('pwsh'), false, 'no appendable session -> text progress stays')
}

// --- streamClaudeChunks: progress narration suppressed for carded tools -----
{
  const session = mockSession(openStepSeed)
  const { ctx } = mockCtx({
    session,
    executeImpl: () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  })
  const messages = [
    {
      type: 'assistant',
      session_id: 's1',
      message: {
        content: [
          { type: 'text', text: '查一下。' },
          { type: 'tool_use', id: 't1', name: 'mcp__dsh-tools__pwsh', input: { cmd: 'ls' } },
          { type: 'tool_use', id: 't2', name: 'WebSearch', input: { query: 'x' } },
        ],
      },
    },
    { type: 'result', subtype: 'success', session_id: 's1', result: '答案。', usage: { input_tokens: 1, output_tokens: 1 } },
  ]
  const chunks = []
  const settings = {
    resumeChain: false,
    nativeToolCards: true,
    queryImpl: async function* () {
      for (const msg of messages) yield msg
    },
  }
  const options = { ...bridgeOptions, model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
  for await (const chunk of streamClaudeChunks(ctx, options, settings)) chunks.push(chunk)
  const texts = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)
  assert.ok(!texts.includes(renderToolProgress('mcp__dsh-tools__pwsh')), 'bridged tool narration suppressed')
  assert.ok(texts.includes(renderToolProgress('WebSearch')), 'built-in tool narration kept')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
}

console.log('test-native-tool-cards: all assertions passed')
