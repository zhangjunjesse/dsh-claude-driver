// Claude Code's built-in tools render as native DSH tool cards (tool/call +
// tool/result session events), mapped onto DSH's own tool vocabulary so the UI
// shows its Bash/Read/Edit/... cards, instead of text lines in the thinking block.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dshCardFor, getResumeSessions, streamClaudeChunks } from '../lib/index.js'

function mockSession() {
  const events = []
  events.push({ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } })
  return {
    id: 's',
    get events() { return events },
    append(type, data, opts) { const e = { type, seq: events.length, data, ...(opts ?? {}) }; events.push(e); return e },
  }
}
const ctxFor = (session) => ({ logger: { info() {}, warn() {} }, get: (n) => (n === 'agents' ? { currentInitiator: () => ({ id: 'a', session }) } : undefined) })
const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
const toolUse = (id, name, input, extra = {}) => ({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id, name, input }] }, ...extra })
const toolResult = (id, content, isError = false) => ({ type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
const done = [{ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'answer' }] } }, { type: 'result', subtype: 'success', session_id: 's1', result: 'answer', usage: { input_tokens: 1, output_tokens: 1 } }]

async function run(events, settings = {}) {
  const session = mockSession()
  const queryImpl = () => (async function* () { for (const e of [...events, ...done]) yield e })()
  const chunks = []
  for await (const c of streamClaudeChunks(ctxFor(session), opts, { resumeChain: false, queryImpl, showToolProgress: false, narrateBuiltinTools: true, ...settings })) chunks.push(c)
  const calls = session.events.filter((e) => e.type === 'tool/call')
  const results = session.events.filter((e) => e.type === 'tool/result')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  return { chunks, calls, results, reasoning, session }
}

test('dshCardFor maps Claude built-ins onto DSH tool names and argument shapes', () => {
  assert.deepEqual(dshCardFor('Bash', { command: 'ls', description: 'List' }), { name: 'bash', args: { command: 'ls', description: 'List' } })
  assert.deepEqual(dshCardFor('Bash', { command: 'ls' }), { name: 'bash', args: { command: 'ls', description: 'ls' } })
  assert.deepEqual(dshCardFor('Bash', { command: 'sleep 9', run_in_background: true }).args.run_in_background, true)
  assert.deepEqual(dshCardFor('Read', { file_path: '/a', offset: 1, limit: 5 }), { name: 'read', args: { file_path: '/a', offset: 1, limit: 5 } })
  assert.deepEqual(dshCardFor('Write', { file_path: '/a', content: 'x' }), { name: 'write', args: { file_path: '/a', content: 'x' } })
  assert.deepEqual(dshCardFor('Edit', { file_path: '/a', old_string: 'o', new_string: 'n', replace_all: true }), { name: 'edit', args: { file_path: '/a', old_string: 'o', new_string: 'n', replace_all: true } })
  assert.deepEqual(dshCardFor('Grep', { pattern: 'p', path: '/d', glob: '*.js' }), { name: 'grep', args: { pattern: 'p', path: '/d', include: '*.js' } })
  assert.deepEqual(dshCardFor('Glob', { pattern: '**/*.js', path: '/d' }), { name: 'glob', args: { pattern: '**/*.js', path: '/d' } })
  assert.deepEqual(dshCardFor('WebFetch', { url: 'https://x.test', prompt: 'p' }), { name: 'web_fetch', args: { url: 'https://x.test' } })
  assert.deepEqual(dshCardFor('WebSearch', { query: 'q' }), { name: 'web_search', args: { queries: ['q'] } })
})

test('a Claude tool with no DSH twin gets a generic card under its own name', () => {
  assert.deepEqual(dshCardFor('NotebookEdit', { notebook_path: '/n.ipynb' }), { name: 'NotebookEdit', args: { notebook_path: '/n.ipynb' } })
})

test('MCP-prefixed names are not built-ins (they are the DSH bridge or Claude\'s own servers)', () => {
  assert.equal(dshCardFor('mcp__dsh-tools__bash', {}), undefined)
})

test('a built-in call opens a DSH tool/call card and its result closes it with the real output', async () => {
  const { calls, results } = await run([toolUse('t1', 'Bash', { command: 'echo hi', description: 'Say hi' }), toolResult('t1', 'hi\n')])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.name, 'bash')
  assert.deepEqual(JSON.parse(calls[0].data.arguments), { command: 'echo hi', description: 'Say hi' })
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.match(JSON.stringify(results[0].data.message.content), /hi/)
  assert.equal(results[0].data.message.isError, false)
})

test('a bash card result ends with the [exit code: N] marker DSH\'s terminal card reads', async () => {
  const ok = await run([toolUse('t1', 'Bash', { command: 'true' }), toolResult('t1', 'fine')])
  assert.match(ok.results[0].data.message.content[0].text, /\n\[exit code: 0\]$/)
  const bad = await run([toolUse('t1', 'Bash', { command: 'false' }), toolResult('t1', 'boom', true)])
  assert.match(bad.results[0].data.message.content[0].text, /\n\[exit code: 1\]$/)
})

test('a failed built-in closes its card as an error', async () => {
  const { results } = await run([toolUse('t1', 'Read', { file_path: '/nope' }), toolResult('t1', 'ENOENT: no such file', true)])
  assert.equal(results[0].data.message.isError, true)
})

test('tool chatter no longer goes into the thinking block', async () => {
  const { reasoning } = await run([toolUse('t1', 'Bash', { command: 'ls' }), toolResult('t1', 'x', true)])
  assert.ok(!reasoning.includes('⚙'), 'no activity lines')
  assert.ok(!reasoning.includes('Bash'), 'no tool narration')
  assert.ok(!/\[Claude Code\]/.test(reasoning), 'no [Claude Code] chatter')
})

test('subagent tool traffic gets no card (it belongs to the delegated run)', async () => {
  const { calls } = await run([toolUse('t9', 'Bash', { command: 'ls' }, { parent_tool_use_id: 'agent-1' })])
  assert.equal(calls.length, 0)
})

test('several tools in one assistant message each get a card, in order', async () => {
  const events = [{ type: 'assistant', session_id: 's1', message: { content: [
    { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/1' } },
    { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'x' } },
  ] } }, toolResult('a', 'one'), toolResult('b', 'two')]
  const { calls, results } = await run(events)
  assert.deepEqual(calls.map((c) => c.data.name), ['read', 'grep'])
  assert.equal(results.length, 2)
})

// DSH's assistant/message settlement requires `stream` to be an array; the
// token-meter and session-stats projections index it on every snapshot, so a
// pairing message without one breaks history loading with
// "Cannot read properties of undefined (reading 'length')".
test('a card settlement carries the request usage so the context meter moves mid-turn', async () => {
  const usage = { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 }
  const events = [
    { type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage } },
    toolResult('t1', 'x'),
  ]
  const { session } = await run(events)
  const settlement = session.events.find((event) => event.type === 'assistant/message')
  assert.deepEqual(settlement.data.usage, {
    inputTokens: 1200,
    outputTokens: 30,
    cacheReadTokens: 800,
    cacheWriteTokens: 100,
  })
})

test('every assistant/message settlement carries a stream array', async () => {
  const { session } = await run([toolUse('t1', 'Bash', { command: 'ls' }), toolResult('t1', 'x')])
  const settlements = session.events.filter((e) => e.type === 'assistant/message')
  assert.ok(settlements.length > 0)
  for (const event of settlements) {
    assert.ok(Array.isArray(event.data.stream), `assistant/message at seq ${event.seq} must carry a stream array`)
  }
})

test('a tool that never returns is closed as interrupted when the turn ends, so no card spins forever', async () => {
  const { calls, results } = await run([toolUse('t1', 'Bash', { command: 'sleep 999' })])
  assert.equal(calls.length, 1)
  assert.equal(results.length, 1)
  assert.equal(results[0].data.message.isError, true)
})

test('without a DSH session the driver falls back to a compact note, never silence', async () => {
  const queryImpl = () => (async function* () { for (const e of [toolUse('t1', 'Bash', { command: 'ls' }), toolResult('t1', 'x'), ...done]) yield e })()
  const chunks = []
  for await (const c of streamClaudeChunks({ get: () => undefined, logger: { info() {}, warn() {} } }, opts, { resumeChain: false, queryImpl, showToolProgress: false, narrateBuiltinTools: true })) chunks.push(c)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.match(reasoning, /Bash/)
})

test('builtinToolCards:false restores the old narration', async () => {
  const { calls, reasoning } = await run([toolUse('t1', 'Bash', { command: 'ls' }), toolResult('t1', 'x')], { builtinToolCards: false })
  assert.equal(calls.length, 0)
  assert.match(reasoning, /Bash/)
})

test('the answer text is unaffected by cards', async () => {
  const { chunks } = await run([toolUse('t1', 'Bash', { command: 'ls' }), toolResult('t1', 'x')])
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'answer')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

for (const purpose of ['session-title', 'compaction']) {
  test(`an internal "${purpose}" call never writes cards or pulses into the user's session`, async () => {
    const session = mockSession()
    const queryImpl = () => (async function* () { for (const e of [toolUse('t1', 'Bash', { command: 'ls' }), toolResult('t1', 'x'), ...done]) yield e })()
    for await (const _ of streamClaudeChunks(ctxFor(session), { ...opts, purpose, sessionId: 'dsh-x' }, { resumeChain: false, queryImpl, nativeCompaction: false, pulseMs: 5 })) void _
    assert.equal(session.events.filter((e) => e.type === 'tool/call' || e.type === 'tool/result').length, 0)
  })
}

for (const purpose of ['session-title', 'compaction']) {
  test(`an internal "${purpose}" call gets no tools at all: no DSH bridge, no Claude built-ins`, async () => {
    let seen
    const queryImpl = ({ options }) => { seen = options; return (async function* () { for (const e of done) yield e })() }
    const agent = { id: 'a', session: mockSession() }
    const ctx = { logger: { info() {}, warn() {} }, get: (n) => (n === 'tools' ? { execute: async () => ({ content: [] }) } : n === 'agents' ? { currentInitiator: () => agent } : undefined) }
    const tools = [{ name: 'bash', description: 'b', parameters: { type: 'object', properties: {} } }]
    // A compaction call is native-only: it needs an established Claude session
    // to /compact; without one it fails closed and never reaches the CLI.
    if (purpose === 'compaction') getResumeSessions().set('dsh-y', 'c-internal')
    try {
      for await (const _ of streamClaudeChunks(ctx, { ...opts, tools, purpose, sessionId: 'dsh-y' }, { resumeChain: false, queryImpl, nativeCompaction: false })) void _
    } finally {
      if (purpose === 'compaction') getResumeSessions().delete('dsh-y')
    }
    assert.equal(seen.mcpServers, undefined, 'no DSH tool bridge')
    assert.deepEqual(seen.tools, [], 'no Claude built-in tools')
    assert.equal(seen.canUseTool, undefined)
  })
}

test('a normal user turn keeps its tools', async () => {
  let seen
  const queryImpl = ({ options }) => { seen = options; return (async function* () { for (const e of done) yield e })() }
  const agent = { id: 'a', session: mockSession() }
  const ctx = { logger: { info() {}, warn() {} }, get: (n) => (n === 'tools' ? { execute: async () => ({ content: [] }) } : n === 'agents' ? { currentInitiator: () => agent } : undefined) }
  const tools = [{ name: 'bash', description: 'b', parameters: { type: 'object', properties: {} } }]
  for await (const _ of streamClaudeChunks(ctx, { ...opts, tools }, { resumeChain: false, queryImpl })) void _
  assert.ok(seen.mcpServers?.['dsh-tools'])
  assert.equal(seen.tools, undefined)
})

test('a foreground command is not reported as a background task', async () => {
  const taskEvents = [
    { type: 'system', subtype: 'task_started', session_id: 's1', task_id: 'k1', tool_use_id: 't1', description: 'A slow command', is_backgrounded: false },
    { type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 'k1', tool_use_id: 't1', status: 'completed', summary: 'A slow command' },
  ]
  const { reasoning, chunks } = await run([toolUse('t1', 'Bash', { command: 'sleep 2' }), ...taskEvents, toolResult('t1', 'x')])
  assert.ok(!/background task/i.test(reasoning), reasoning)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a real background task is still reported', async () => {
  const taskEvents = [
    { type: 'system', subtype: 'task_started', session_id: 's1', task_id: 'k1', tool_use_id: 't1', description: 'Dev server', is_backgrounded: true },
    { type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 'k1', tool_use_id: 't1', status: 'completed', summary: 'Dev server' },
  ]
  const { reasoning } = await run([toolUse('t1', 'Bash', { command: 'serve', run_in_background: true }), ...taskEvents, toolResult('t1', 'started')])
  assert.match(reasoning, /background task/i)
})
