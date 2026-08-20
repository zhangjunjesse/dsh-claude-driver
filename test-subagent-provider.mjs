// Standalone smoke test for the claude-code subagent provider (fable model):
//   node test-subagent-provider.mjs
import { createClaudeCodeProvider } from './lib/subagent-provider.js'

const provider = createClaudeCodeProvider({
  model: 'fable',
  maxTurns: 2,
  proxy: 'http://127.0.0.1:7897',
})

const signal = new AbortController().signal
const run = await provider.start({
  label: 'smoke',
  prompt: [{ type: 'text', text: '用一句话回答：2+3 等于几？不要使用任何工具。' }],
  parent: { session: { meta: { cwd: 'C:/Users/Administrator/Desktop/dsh-workspace/space-1' } } },
  signal,
})

console.log('run id:', run.id, '| localAgent:', run.localAgent)
const result = await run.result
console.log('stopReason:', result.stopReason)
console.log('output:', JSON.stringify(result.output, null, 2).slice(0, 500))
await run.dispose()
console.log('disposed ok')
