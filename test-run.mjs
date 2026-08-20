// Smoke tests for dsh-claude-driver's chunk translation, run standalone:
//   node test-run.mjs
// Expects the SDK (with proxy) to stream answers; scenario 2 exercises the
// DSH-tool bridge with a mock tools service.
import { streamClaudeChunks } from './lib/index.js'

const settings = {
  model: 'fable',
  maxTurns: 4,
  proxy: 'http://127.0.0.1:7897',
  cwd: 'C:/Users/Administrator/Desktop/dsh-workspace/space-1',
}

async function run(label, ctx, options, settings) {
  console.log(`\n===== ${label} =====`)
  let count = 0
  for await (const chunk of streamClaudeChunks(ctx, options, settings)) {
    count += 1
    const preview = JSON.stringify(chunk)
    console.log(preview.length > 280 ? preview.slice(0, 280) + '…' : preview)
  }
  console.log(`chunks: ${count}`)
}

// Scenario 1: plain text answer, no tools.
const emptyCtx = { get: () => undefined }
await run('scenario 1: text-only', emptyCtx, {
  provider: 'claude-code',
  model: 'sonnet',
  system: '你是测试助手。',
  messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话回答：1+1 等于几？不要使用任何工具。' }] }],
  signal: undefined,
}, settings)

// Scenario 2: DSH-tool bridge — mock `add` tool via a fake tools/agents service.
const mockAgent = { id: 'test-session', session: { id: 'test-session' } }
const mockCtx = {
  get(name) {
    if (name === 'tools') {
      return {
        execute: async ({ name, arguments: args }) => {
          console.log(`    [mock tools.execute] ${name}(${JSON.stringify(args)})`)
          return { content: [{ type: 'text', text: String(args.a + args.b) }], isError: false }
        },
      }
    }
    if (name === 'agents') return { currentInitiator: () => mockAgent }
    return undefined
  },
}
await run('scenario 2: DSH tool bridge (add)', mockCtx, {
  provider: 'claude-code',
  model: 'sonnet',
  system: '你是测试助手。',
  messages: [{ role: 'user', content: [{ type: 'text', text: '请调用 add 工具计算 3+4，然后告诉我结果。不要使用任何其他工具。' }] }],
  tools: [{ name: 'add', description: 'Add two integers.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }],
  signal: undefined,
}, settings)
