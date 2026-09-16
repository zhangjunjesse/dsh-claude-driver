// Pure unit tests (no network, no SDK spawn) for narrateBuiltinTools: the
// compact "[Claude Code] ⚙ <tool> · <subject>" line emitted for Claude Code's
// BUILT-IN tools, which render no native card and were previously invisible in
// the GUI (showToolProgress, the only fallback, is off by default). Uses the
// settings.queryImpl test seam. Run: node test-builtin-tool-activity.mjs
import assert from 'node:assert/strict'
import {
  renderBuiltinToolActivity,
  renderToolProgress,
  streamClaudeChunks,
  summarizeToolInput,
} from './lib/index.js'

const ctx = { get: () => undefined, logger: { info: () => {}, warn: () => {} } }
const baseOptions = {
  provider: 'claude-code',
  model: 'sonnet',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
}

function mockQuery(messages) {
  return async function* () {
    for (const msg of messages) yield msg
  }
}

async function collect(settings, messages) {
  const chunks = []
  for await (const chunk of streamClaudeChunks(ctx, baseOptions, {
    resumeChain: false,
    queryImpl: mockQuery(messages),
    // Production merges DEFAULTS before calling; showToolProgress is false
    // there, so mirror that here or the legacy narrator would win every case.
    showToolProgress: false,
    ...settings,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

const delta = (text) => ({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const msgStart = () => ({ type: 'stream_event', session_id: 's1', event: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } })
const assistant = (content, extra = {}) => ({ type: 'assistant', session_id: 's1', message: { content }, ...extra })
const result = (text, usage = { input_tokens: 10, output_tokens: 5 }) =>
  ({ type: 'result', subtype: 'success', session_id: 's1', result: text, usage })
const textsOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)
const reasoningsOf = (chunks) => chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text)

// --- 1. summarizeToolInput picks the SUBJECT, never the payload ---
assert.equal(summarizeToolInput({ command: 'npm test' }), 'npm test')
assert.equal(summarizeToolInput({ file_path: 'lib/index.js' }), 'lib/index.js')
assert.equal(summarizeToolInput({ url: 'https://example.com' }), 'https://example.com')
assert.equal(
  summarizeToolInput({ file_path: 'a.txt', content: 'SECRET-FILE-BODY' }),
  'a.txt',
  'Write renders its path, never the file body',
)
assert.equal(summarizeToolInput({ content: 'only a payload' }), '', 'unlisted keys are never rendered')
assert.equal(summarizeToolInput({}), '')
assert.equal(summarizeToolInput(undefined), '')
assert.equal(summarizeToolInput({ command: '   ' }), '', 'blank values do not count as a subject')
assert.equal(summarizeToolInput({ command: 42 }), '', 'non-string values are ignored')
assert.equal(
  summarizeToolInput({ command: 'echo a\n  echo b\techo c' }),
  'echo a echo b echo c',
  'multi-line commands collapse to one line',
)
{
  const long = summarizeToolInput({ command: 'x'.repeat(500) })
  assert.ok(long.length <= 81, `clipped to a screen-sized subject, got ${long.length}`)
  assert.ok(long.endsWith('…'), 'clipping is marked')
}

// --- 2. renderBuiltinToolActivity shape ---
assert.equal(renderBuiltinToolActivity('Bash', { command: 'npm test' }), '\n[Claude Code] ⚙ Bash · npm test\n')
assert.equal(renderBuiltinToolActivity('TodoWrite', {}), '\n[Claude Code] ⚙ TodoWrite\n', 'subjectless tool renders bare')
assert.ok(renderBuiltinToolActivity('', {}).includes('(unknown)'), 'missing tool name still renders')
assert.equal(
  renderBuiltinToolActivity('mcp__srv__add', { query: 'q' }),
  renderBuiltinToolActivity('add', { query: 'q' }),
  'mcp server prefix stripped',
)

// --- 3. default: built-in tool_use becomes one index-0 activity line ---
{
  const chunks = await collect({}, [
    msgStart(),
    delta('我查一下。'),
    assistant([
      { type: 'text', text: '我查一下。' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'lib/index.js' } },
    ]),
    { type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    msgStart(),
    delta('好了。'),
    assistant([{ type: 'text', text: '好了。' }]),
    result('好了。'),
  ])
  // 0.7.0 (DEFAULTS.toolNarrationChannel): activity rides the REASONING block
  // by default, so the prose stays clean.
  const texts = textsOf(chunks)
  const reasonings = reasoningsOf(chunks)
  assert.ok(reasonings.includes(renderBuiltinToolActivity('Bash', { command: 'npm test' })), 'Bash activity emitted on reasoning')
  assert.ok(reasonings.includes(renderBuiltinToolActivity('Read', { file_path: 'lib/index.js' })), 'Read activity emitted on reasoning')
  assert.ok(!texts.some((t) => t.includes('⚙')), 'the prose carries no activity lines')
  assert.ok(
    chunks.every((c) => (c.type !== 'text-delta' && c.type !== 'reasoning-delta') || !c.text.includes('正在调用工具')),
    'legacy showToolProgress wording is NOT used',
  )
  assert.ok(
    chunks.filter((c) => c.type === 'reasoning-delta').every((c) => c.index === 1),
    'activity rides the reasoning block (index 1)',
  )
  assert.equal(chunks.filter((c) => c.type === 'block-start' && c.blockType === 'reasoning').length, 1, 'single reasoning block-start')
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.index === 0)
  assert.equal(blockEnd.block.text, texts.join(''), 'text block-end equals the concatenated text deltas')
  const reasoningEnd = chunks.find((c) => c.type === 'block-end' && c.index === 1)
  assert.equal(reasoningEnd.block.text, reasonings.join(''), 'reasoning block-end equals the concatenated reasoning deltas')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
}

// --- 3b. toolNarrationChannel:'text' restores the 0.5.0 placement ---
{
  const chunks = await collect({ toolNarrationChannel: 'text' }, [
    msgStart(),
    delta('我查一下。'),
    assistant([
      { type: 'text', text: '我查一下。' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
    ]),
    result('我查一下。'),
  ])
  const texts = textsOf(chunks)
  assert.ok(texts.includes(renderBuiltinToolActivity('Bash', { command: 'npm test' })), 'activity back on the text block')
  assert.ok(!reasoningsOf(chunks).some((t) => t.includes('⚙')), 'and off the reasoning block')
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.index === 0)
  assert.equal(blockEnd.block.text, texts.join(''), 'block-end text equals the concatenated deltas')
}

// --- 4. bridged DSH tools stay card-only (no duplicate narration) ---
{
  // A real bridge (not a stub): options.tools + a `tools` service is what
  // buildToolBridge needs, and rendersCard is what decides card-vs-text.
  // rendersCard is gated on cardsEnabled, which needs an APPENDABLE session —
  // an agent without one cannot show a card, and the bridged tool then
  // correctly falls through to text narration (asserted separately below).
  const cardAgent = { id: 'activity-test', session: { id: 'activity-test', append: () => ({}) } }
  const bridgeCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => {
      if (name === 'tools') return { execute: async () => ({ content: [] }) }
      // buildToolBridge requires BOTH services; without `agents` it returns
      // null and every tool would fall through to the built-in narrator.
      if (name === 'agents') return { currentInitiator: () => cardAgent }
      return undefined
    },
  }
  const bridgeOptions = {
    ...baseOptions,
    tools: [{ name: 'ask_user_question', description: 'ask', parameters: { type: 'object', properties: {} } }],
  }
  const chunks = []
  for await (const chunk of streamClaudeChunks(bridgeCtx, bridgeOptions, {
    resumeChain: false,
    showToolProgress: false,
    queryImpl: mockQuery([
      assistant([
        { type: 'tool_use', id: 't1', name: 'mcp__dsh-tools__ask_user_question', input: { question: 'pick' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
      ]),
      result('done'),
    ]),
  })) {
    chunks.push(chunk)
  }
  const narrated = [...textsOf(chunks), ...reasoningsOf(chunks)]
  assert.ok(!narrated.some((t) => t.includes('ask_user_question')), 'bridged tool is narrated by its card, not by narration')
  assert.ok(reasoningsOf(chunks).some((t) => t.includes('⚙ Bash · ls')), 'built-in alongside it is still narrated (reasoning)')
}

// --- 4b. no appendable session => no card => the bridged tool is narrated ---
// (rendersCard is false in that case, and narration is then the ONLY trace.)
{
  const bridgeCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => {
      if (name === 'tools') return { execute: async () => ({ content: [] }) }
      if (name === 'agents') return { currentInitiator: () => undefined }
      return undefined
    },
  }
  const bridgeOptions = {
    ...baseOptions,
    tools: [{ name: 'ask_user_question', description: 'ask', parameters: { type: 'object', properties: {} } }],
  }
  const chunks = []
  for await (const chunk of streamClaudeChunks(bridgeCtx, bridgeOptions, {
    resumeChain: false,
    showToolProgress: false,
    queryImpl: mockQuery([
      assistant([{ type: 'tool_use', id: 't1', name: 'mcp__dsh-tools__ask_user_question', input: { question: 'pick' } }]),
      result('done'),
    ]),
  })) {
    chunks.push(chunk)
  }
  assert.ok(
    reasoningsOf(chunks).some((t) => t.includes('⚙ ask_user_question')),
    'cardless bridged tool still leaves a trace',
  )
}

// --- 5. showToolProgress wins when explicitly on (legacy output byte-identical) ---
{
  const chunks = await collect({ showToolProgress: true }, [
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
    result('done'),
  ])
  const texts = textsOf(chunks)
  assert.deepEqual(texts, [renderToolProgress('Bash'), 'done'], 'legacy narrator owns the line, exactly once')
}

// --- 6. opt-out restores total silence ---
{
  const chunks = await collect({ narrateBuiltinTools: false }, [
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
    result('done'),
  ])
  assert.ok(
    chunks.every((c) => (c.type !== 'text-delta' && c.type !== 'reasoning-delta') || !c.text.includes('⚙')),
    'no narration at all when both narrators are off',
  )
  // Regression guard: with nothing narrated, no text delta precedes the
  // result fallback. That used to leave block 0 unopened, and the guarded
  // block-end then dropped the answer entirely.
  assert.deepEqual(textsOf(chunks), ['done'], 'the model answer still arrives')
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.index === 0)
  assert.equal(blockEnd.block.text, 'done', 'and block-end carries it')
}

// --- 7. subagent tool traffic never leaks into the main reply ---
{
  const chunks = await collect({}, [
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'secret-subagent-cmd' } }], { parent_tool_use_id: 'parent-1' }),
    msgStart(),
    delta('好的。'),
    assistant([{ type: 'text', text: '好的。' }]),
    result('好的。'),
  ])
  assert.deepEqual(textsOf(chunks), ['好的。'], 'subagent tool_use stays silent')
  assert.ok(!reasoningsOf(chunks).some((t) => t.includes('⚙')), 'and out of the reasoning block too')
}

// --- 8. narration alone never masks an empty response ---
{
  const chunks = await collect({}, [
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    result(''),
  ])
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(
    chunks.at(-1).reason.failure.code,
    'EMPTY_RESPONSE',
    'driver narration is not model output (realText untouched)',
  )
}

console.log('test-builtin-tool-activity: all assertions passed')
