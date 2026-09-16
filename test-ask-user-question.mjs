// Offline unit test (no network): the built-in AskUserQuestion suppression and
// the built-in-tool-failure narration.
//
// Background: the CLI offers the built-in AskUserQuestion only when the host
// installs a `canUseTool` callback (measured: bare 29 tools -> +canUseTool 32
// tools). This driver installs canUseTool on every turn that bridges a DSH
// tool, so the model was handed a question tool DSH cannot render; the parked
// dialog expired into "The user did not answer the questions." and, because
// built-ins render no native card and showToolProgress is off, nothing at all
// reached the GUI.
import assert from 'node:assert'
import { streamClaudeChunks, BUILTIN_ASK_USER_QUESTION, renderBuiltinToolErrorNote } from './lib/index.js'

// An APPENDABLE session: buildToolBridge only promises native cards when
// session.append exists, and `rendersCard` (which decides whether a bridged
// tool's failure is already visible) keys on exactly that.
const mockAgent = { id: 'test-session', session: { id: 'test-session', append: () => ({ seq: 1 }) } }
const ctxWithTools = {
  get(name) {
    if (name === 'tools') return { execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }) }
    if (name === 'agents') return { currentInitiator: () => mockAgent }
    return undefined
  },
}
const bareCtx = { get: () => undefined }

const ASK_SCHEMA = {
  name: 'ask_user_question',
  description: 'Ask the user a question.',
  parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object' } } }, required: ['questions'] },
}
const OTHER_SCHEMA = {
  name: 'add',
  description: 'Add two integers.',
  parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
}

// Fake SDK: records the options it was handed, then replays `script` messages.
function fakeQuery(captured, script = []) {
  return ({ options }) => {
    captured.push(options)
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      for (const msg of script) yield { ...msg, session_id: 's1' }
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'done', usage: { output_tokens: 1 } }
    })()
  }
}

async function run(ctx, tools, settings) {
  const chunks = []
  for await (const chunk of streamClaudeChunks(
    ctx,
    { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools },
    { resumeChain: false, harvestOrphanedSubagents: false, waitForBackgroundTasks: false, ...settings },
  )) chunks.push(chunk)
  return chunks
}

// --- 1. bridged ask_user_question => built-in withheld -----------------------
{
  const captured = []
  await run(ctxWithTools, [ASK_SCHEMA, OTHER_SCHEMA], { queryImpl: fakeQuery(captured) })
  const opts = captured[0]
  assert.ok(opts.canUseTool, 'canUseTool must be installed when DSH tools are bridged')
  assert.deepStrictEqual(
    opts.disallowedTools,
    [BUILTIN_ASK_USER_QUESTION],
    'built-in AskUserQuestion must be withheld once the DSH tool is bridged',
  )
}

// --- 2. DSH ask tool NOT bridged => built-in left alone ----------------------
// Withholding it here would leave the model with no way to ask at all.
{
  const captured = []
  await run(ctxWithTools, [OTHER_SCHEMA], { queryImpl: fakeQuery(captured) })
  assert.strictEqual(
    captured[0].disallowedTools,
    undefined,
    'without a bridged ask_user_question the built-in must stay available',
  )
}

// --- 3. no bridge at all (no canUseTool) => nothing withheld -----------------
{
  const captured = []
  await run(bareCtx, [ASK_SCHEMA], { queryImpl: fakeQuery(captured) })
  assert.strictEqual(captured[0].canUseTool, undefined, 'no bridge => no canUseTool')
  assert.strictEqual(captured[0].disallowedTools, undefined, 'no canUseTool => built-in was never offered')
}

// --- 4. opt-out honoured, and explicit disallowedTools preserved -------------
{
  const captured = []
  await run(ctxWithTools, [ASK_SCHEMA], {
    queryImpl: fakeQuery(captured),
    disableBuiltinAskUserQuestion: false,
    disallowedTools: ['WebFetch'],
  })
  assert.deepStrictEqual(captured[0].disallowedTools, ['WebFetch'], 'opt-out must not add the built-in')
}

// --- 5. a swallowed question is narrated instead of vanishing ----------------
{
  const captured = []
  const chunks = await run(ctxWithTools, [ASK_SCHEMA], {
    queryImpl: fakeQuery(captured, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: BUILTIN_ASK_USER_QUESTION, input: {} }], usage: {} },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'The user did not answer the questions.' }] },
          ],
        },
      },
    ]),
  })
  // 0.7.0: driver narration rides the reasoning block by default
  // (DEFAULTS.toolNarrationChannel), keeping the prose clean.
  const narrated = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(narrated.includes('无法在 DSH 中显示'), `swallowed question must be narrated, got: ${narrated}`)
  // block-end text must still equal the sum of the deltas.
  const end = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'reasoning')
  assert.strictEqual(end.block.text, narrated, 'block-end text must equal the sum of reasoning deltas')
  const prose = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!prose.includes('无法在 DSH 中显示'), 'the note must NOT be glued into the prose')
}

// --- 6. bridged-tool errors are NOT double-narrated (card owns them) --------
{
  const captured = []
  const chunks = await run(ctxWithTools, [OTHER_SCHEMA], {
    queryImpl: fakeQuery(captured, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'add', input: {} }], usage: {} } },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'boom' }] }] },
      },
    ]),
  })
  const narrated = chunks.filter((c) => c.type === 'text-delta' || c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!narrated.includes('boom'), 'bridged tool errors belong to the native card, not a narration line')
}

// --- 7. subagent tool results never narrate into the main reply -------------
{
  const captured = []
  const chunks = await run(ctxWithTools, [ASK_SCHEMA], {
    queryImpl: fakeQuery(captured, [
      {
        type: 'user',
        parent_tool_use_id: 'parent',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tuX', is_error: true, content: [{ type: 'text', text: 'subagent boom' }] }],
        },
      },
    ]),
  })
  const narrated = chunks.filter((c) => c.type === 'text-delta' || c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!narrated.includes('subagent boom'), 'subagent traffic must stay out of the main reply')
}

// --- 8. note renderer shapes ------------------------------------------------
assert.ok(renderBuiltinToolErrorNote(BUILTIN_ASK_USER_QUESTION, '').includes('无法在 DSH 中显示'))
assert.ok(renderBuiltinToolErrorNote('Bash', 'exit 1').includes('Bash'))
assert.strictEqual(renderBuiltinToolErrorNote('Bash', ''), '', 'empty non-ask failure narrates nothing')

console.log('test-ask-user-question: all assertions passed')
