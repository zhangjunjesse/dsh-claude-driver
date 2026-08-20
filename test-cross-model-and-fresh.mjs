// Unit tests (no network, no SDK spawn) for the two 2026-08-20 improvements:
//   A. cross-model history compatibility — every bridged tool/call card is
//      paired with an assistant/message carrying the tool-call block
//      (surfaceOp 'append', empty sourceEventSeqs), so the derived history
//      never contains orphan tool-results after a provider switch;
//   B. resume-chain hygiene — compaction/summary drops the session's resume
//      mapping, and the /claude-fresh command drops it on demand.
// Run: node test-cross-model-and-fresh.mjs
import assert from 'node:assert/strict'
import {
  apply,
  buildAssistantToolCallMessage,
  buildToolBridge,
  clearResumeOnCompaction,
  createClaudeFreshCommand,
  getResumeSessions,
} from './lib/index.js'

// --- minimal session mock honoring the dsh-session append contract ---------
function mockSession(seed = []) {
  const events = []
  const session = {
    id: 'pair-test',
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

function mockBridgeCtx({ session, executeImpl }) {
  const agent = session ? { id: 'pair-test', session } : undefined
  return {
    logger: { info: () => {}, warn: () => {} },
    get(name) {
      if (name === 'tools') return { execute: async (exec) => executeImpl(exec) }
      if (name === 'agents') return { currentInitiator: () => agent }
      return undefined
    },
  }
}

const toolSchemas = [
  {
    name: 'pwsh',
    description: 'Run PowerShell.',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  },
]

// --- A0: buildAssistantToolCallMessage shape (dsh-llm createAssistantMessage) ---
{
  const message = buildAssistantToolCallMessage('c9', 'pwsh', '{"cmd":"ls"}', { provider: 'claude-code', model: 'sonnet' })
  assert.equal(message.role, 'assistant')
  assert.deepEqual(message.source, { kind: 'model', provider: 'claude-code', model: 'sonnet' })
  assert.deepEqual(message.content, [{ type: 'tool-call', id: 'c9', name: 'pwsh', arguments: '{"cmd":"ls"}' }])
  assert.ok(typeof message.id === 'string' && message.id.length > 0, 'message carries an identity')
}

// --- A1: tool/call is immediately followed by the pairing assistant/message ---
{
  const session = mockSession(openStepSeed)
  const ctx = mockBridgeCtx({
    session,
    executeImpl: () => ({ content: [{ type: 'text', text: '7' }], isError: false }),
  })
  const bridge = buildToolBridge(
    ctx,
    { provider: 'claude-code', model: 'sonnet', tools: toolSchemas },
    { provider: 'claude-code', model: 'fable', nativeToolCards: true },
    new AbortController(),
  )
  await bridge.handlers.get('pwsh')({ cmd: 'echo 7' })

  const call = session.events.find((e) => e.type === 'tool/call')
  const pairing = session.events.find((e) => e.type === 'assistant/message')
  const result = session.events.find((e) => e.type === 'tool/result')
  assert.ok(call && pairing && result, 'tool/call + assistant/message + tool/result all appended')
  assert.equal(pairing.seq, call.seq + 1, 'pairing message directly follows the tool/call')
  assert.ok(pairing.seq < result.seq, 'pairing message precedes the tool/result')
  // invariant fields: same open turn/step as the card
  assert.equal(pairing.data.turn, 1)
  assert.equal(pairing.data.step, 1)
  // surface marker: append + EMPTY sourceEventSeqs (explicitly legal only for
  // assistant/message — dsh-session assertProvenance)
  assert.equal(pairing.surfaceOp, 'append')
  assert.deepEqual(pairing.sourceEventSeqs, [], 'empty provenance rides the assistant/message')
  // message body: one tool-call block whose id/name/arguments mirror the
  // tool/call event exactly (raw JSON string arguments)
  const message = pairing.data.message
  assert.equal(message.role, 'assistant')
  assert.equal(message.source.kind, 'model')
  assert.equal(message.source.model, 'sonnet', 'per-call model wins over the settings default')
  assert.equal(message.content.length, 1)
  const block = message.content[0]
  assert.equal(block.type, 'tool-call')
  assert.equal(block.id, call.data.callId, 'block id is the shared callId')
  assert.equal(block.name, call.data.name)
  assert.equal(block.arguments, call.data.arguments, 'raw JSON-string arguments identical to the tool/call event')
  assert.equal(block.arguments, JSON.stringify({ cmd: 'echo 7' }))
  // downstream pairing: the tool-result user message cites the same callId,
  // so deepseek's serializeMessages emits assistant.tool_calls + role:'tool'
  assert.equal(result.data.message.content[0].toolCallId, block.id)
  // the tool/result still cites the tool/call event, not the pairing message
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
}

// --- A2: pairing append failure degrades to warn; card + tool still work -----
{
  const warns = []
  const events = []
  const session = {
    id: 'pair-fail',
    get events() {
      return events
    },
    append(type, data, opts) {
      if (type === 'assistant/message') throw new Error('surface rejected')
      const event = { type, seq: events.length, time: 1, data, ...(opts ?? {}) }
      events.push(event)
      return event
    },
  }
  for (const [type, data] of openStepSeed) session.append(type, data)
  const ctx = {
    logger: { info: () => {}, warn: (msg) => warns.push(msg) },
    get(name) {
      if (name === 'tools') return { execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }) }
      if (name === 'agents') return { currentInitiator: () => ({ id: 'pair-fail', session }) }
      return undefined
    },
  }
  const bridge = buildToolBridge(ctx, { provider: 'claude-code', tools: toolSchemas }, { nativeToolCards: true }, new AbortController())
  const reply = await bridge.handlers.get('pwsh')({ cmd: 'x' })
  assert.equal(reply.isError, false, 'tool execution unaffected')
  assert.ok(session.events.some((e) => e.type === 'tool/call'), 'card still opened')
  assert.ok(session.events.some((e) => e.type === 'tool/result'), 'card still closed')
  assert.ok(warns.some((w) => String(w).includes('pairing')), 'pairing failure logged as a warn')
}

// --- B1: clearResumeOnCompaction (injected map) ------------------------------
{
  const sessions = new Map([['s1', 'sdk-1'], ['s2', 'sdk-2']])
  assert.equal(clearResumeOnCompaction({ id: 's1' }, { type: 'compaction/summary', data: {} }, sessions), true)
  assert.equal(sessions.has('s1'), false, 'mapping dropped on compaction/summary')
  assert.equal(sessions.get('s2'), 'sdk-2', 'other sessions untouched')
  assert.equal(clearResumeOnCompaction({ id: 's2' }, { type: 'compaction/start', data: {} }, sessions), false, 'other event types ignored')
  assert.equal(clearResumeOnCompaction(undefined, { type: 'compaction/summary' }, sessions), false, 'missing session tolerated')
  assert.equal(clearResumeOnCompaction({ id: 's3' }, { type: 'compaction/summary' }, sessions), false, 'unknown session is a no-op')
  assert.equal(sessions.size, 1)
}

// --- B2: apply() wires the session/event listener + command registration -----
{
  const listeners = new Map()
  const registered = []
  const mockCtx = {
    on: (event, fn) => {
      listeners.set(event, fn)
    },
    get: (name) => {
      if (name === 'commands') return { register: (definition) => registered.push(definition) }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(mockCtx, { registerCatalog: false })
  assert.ok(listeners.has('llm/stream'), 'llm/stream takeover still installed')
  assert.ok(listeners.has('session/event'), 'session/event compaction listener installed')

  // fire the listener against the module-level resume chain
  const chain = getResumeSessions()
  chain.set('dsh-sess-A', 'sdk-A')
  chain.set('dsh-sess-B', 'sdk-B')
  const fire = listeners.get('session/event')
  fire({ id: 'dsh-sess-A' }, { type: 'compaction/summary', seq: 9, data: { compactionId: 'c1' } })
  assert.equal(chain.has('dsh-sess-A'), false, 'compaction/summary evicts the resume mapping')
  fire({ id: 'dsh-sess-B' }, { type: 'assistant/message', seq: 10, data: {} })
  assert.equal(chain.get('dsh-sess-B'), 'sdk-B', 'unrelated events leave the chain alone')
  chain.delete('dsh-sess-B')

  // /claude-fresh registered through the commands service (no inject on mocks)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'claude-fresh')
  assert.match(registered[0].name, /^[a-z][a-z0-9_-]*$/, 'dsh-commands COMMAND_NAME contract')
  assert.ok(typeof registered[0].description === 'string' && registered[0].description.trim().length > 0)
  assert.equal(typeof registered[0].handler, 'function')
}

// --- B3: /claude-fresh handler semantics -------------------------------------
{
  const sessions = new Map([['sess-9', 'sdk-9']])
  const command = createClaudeFreshCommand(sessions)
  const hit = command.handler({ commandId: 'cmd-1', agent: { session: { id: 'sess-9' } }, rawInput: '', signal: undefined })
  assert.equal(hit.kind, 'success')
  assert.ok(hit.text.length > 0)
  assert.equal(sessions.size, 0, 'resume mapping dropped')
  const miss = command.handler({ commandId: 'cmd-2', agent: { session: { id: 'sess-9' } }, rawInput: '', signal: undefined })
  assert.equal(miss.kind, 'success', 'idempotent: second run still succeeds')
  assert.notEqual(miss.text, hit.text, 'distinct message when nothing was dropped')
  const noAgent = command.handler({ commandId: 'cmd-3', rawInput: '', signal: undefined })
  assert.equal(noAgent.kind, 'error', 'missing agent/session reports an error result')
}

// --- B4: DEFAULTS carry contextWindow so DSH compaction can resolve capacity --
{
  const captured = []
  const mockLlm = {
    listProviders: () => [],
    registerAdapter: (providers, adapter) => captured.push(adapter),
    registerModelDiscovery: () => {},
  }
  apply(
    {
      on: () => {},
      get: (name) => (name === 'llm' ? mockLlm : undefined),
      logger: { info: () => {}, warn: () => {} },
    },
    {},
  )
  assert.equal(captured.length, 1)
  const expectedWindows = { fable: 1000000, sonnet: 967000, opus: 1000000, haiku: 200000 }
  for (const id of ['fable', 'sonnet', 'opus', 'haiku']) {
    const resolved = await captured[0].resolveModel('claude-code', id)
    assert.deepEqual(resolved.context, { contextWindow: expectedWindows[id] }, `${id} exposes the real context.contextWindow (probed via getContextUsage)`)
  }
}

console.log('test-cross-model-and-fresh: all assertions passed')
