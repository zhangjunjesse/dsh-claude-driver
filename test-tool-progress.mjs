// Pure unit tests (no network, no SDK spawn) for showToolProgress: the
// lightweight "[Claude Code] 正在调用工具 …" text-deltas emitted when whole
// assistant messages carry tool_use blocks. Uses the settings.queryImpl test
// seam to feed a scripted SDK message stream. Run: node test-tool-progress.mjs
import assert from 'node:assert/strict'
import { renderToolProgress, streamClaudeChunks } from './lib/index.js'

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

async function collect(settings, messages, options = baseOptions) {
  const chunks = []
  for await (const chunk of streamClaudeChunks(ctx, options, { resumeChain: false, queryImpl: mockQuery(messages), ...settings })) {
    chunks.push(chunk)
  }
  return chunks
}

const delta = (text) => ({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const msgStart = () => ({ type: 'stream_event', session_id: 's1', event: { type: 'message_start' } })
const assistant = (content, extra = {}) => ({ type: 'assistant', session_id: 's1', message: { content }, ...extra })
const result = (text, usage = { input_tokens: 10, output_tokens: 5 }) =>
  ({ type: 'result', subtype: 'success', session_id: 's1', result: text, usage })

// --- renderToolProgress shape ---
assert.equal(renderToolProgress('read_file'), '\n[Claude Code] 正在调用工具 read_file…\n')
assert.ok(renderToolProgress('').includes('(unknown)'), 'missing tool name still renders')
assert.equal(renderToolProgress('mcp__dsh-tools__add'), renderToolProgress('add'), 'mcp server prefix stripped')

// --- default (showToolProgress on): tool_use blocks become index-0 text-deltas ---
{
  const chunks = await collect({}, [
    msgStart(),
    delta('让我查一下。'),
    assistant([
      { type: 'text', text: '让我查一下。' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x' } },
    ]),
    { type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] } },
    msgStart(),
    delta('答案是 42。'),
    assistant([{ type: 'text', text: '答案是 42。' }]),
    result('答案是 42。'),
  ])
  const textDeltas = chunks.filter((c) => c.type === 'text-delta')
  assert.ok(textDeltas.every((c) => c.index === 0), 'progress rides the existing text block (index 0)')
  assert.equal(chunks.filter((c) => c.type === 'block-start' && c.blockType === 'text').length, 1, 'single text block-start')
  const texts = textDeltas.map((c) => c.text)
  assert.ok(texts.includes(renderToolProgress('read_file')), 'read_file progress emitted')
  assert.ok(texts.includes(renderToolProgress('Grep')), 'Grep progress emitted')
  assert.ok(texts.indexOf(renderToolProgress('read_file')) > texts.indexOf('让我查一下。'), 'progress after the turn text')
  assert.ok(texts.indexOf(renderToolProgress('Grep')) < texts.indexOf('答案是 42。'), 'progress before the next turn text')
  assert.equal(texts.filter((t) => t.includes('tool_result') || t.includes('完成')).length, 0, 'no tool_result completion spam')
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.index === 0)
  assert.equal(blockEnd.block.text, texts.join(''), 'block-end text equals the concatenated deltas (chunk validity)')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  const usage = chunks.find((c) => c.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 10, outputTokens: 5 })
}

// --- showToolProgress:false suppresses progress, everything else unchanged ---
{
  const chunks = await collect({ showToolProgress: false }, [
    msgStart(),
    delta('答案是 42。'),
    assistant([
      { type: 'text', text: '答案是 42。' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
    ]),
    result('答案是 42。'),
  ])
  assert.ok(chunks.every((c) => c.type !== 'text-delta' || !c.text.includes('正在调用工具')), 'no progress when disabled')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
}

// --- subagent assistant messages (parent_tool_use_id) emit no progress ---
{
  const chunks = await collect({}, [
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], { parent_tool_use_id: 'parent-1' }),
    msgStart(),
    delta('好的。'),
    assistant([{ type: 'text', text: '好的。' }]),
    result('好的。'),
  ])
  assert.ok(chunks.every((c) => c.type !== 'text-delta' || !c.text.includes('正在调用工具')), 'subagent tool_use stays silent')
}

// --- progress-only turn recovers the final answer from msg.result as a delta ---
{
  const chunks = await collect({}, [
    assistant([{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }]),
    result('最终答案'),
  ])
  const texts = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)
  assert.deepEqual(texts, [renderToolProgress('read_file'), '最终答案'], 'result fallback streams after progress')
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.index === 0)
  assert.equal(blockEnd.block.text, texts.join(''))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
}

// --- progress alone never masks an empty response ---
{
  const chunks = await collect({}, [
    assistant([{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }]),
    result(''),
  ])
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE', 'progress-only body still reports EMPTY_RESPONSE')
}

console.log('test-tool-progress: all assertions passed')
