// Live check: does the driver now emit reasoning chunks for a thinking turn?
//   node test-thinking-stream.mjs
// Requires proxy + Claude login. Prints the reasoning block the GUI would render.
import { streamClaudeChunks } from './lib/index.js'

const settings = {
  model: 'sonnet',
  effort: 'high',
  maxTurns: 4,
  proxy: 'http://127.0.0.1:7897',
  cwd: 'C:/Users/Administrator/Desktop/dsh-workspace/space-1',
  harvestOrphanedSubagents: false,
  ...(process.env.NO_SUMMARY === '1' ? { thinkingDisplay: null } : {}),
}

const ctx = { get: () => undefined }
let reasoningDeltas = 0
let reasoningText = ''
let sawReasoningStart = false
let textChars = 0

for await (const chunk of streamClaudeChunks(ctx, {
  provider: 'claude-code',
  model: 'sonnet',
  system: '你是测试助手。',
  messages: [{
    role: 'user',
    content: [{ type: 'text', text: '仔细推理：一个三位数，各位数字之和为 12，且是 7 的倍数，个位比百位大 3。请推导出所有可能的数。不要使用任何工具。' }],
  }],
  signal: undefined,
}, settings)) {
  if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') sawReasoningStart = true
  if (chunk.type === 'reasoning-delta') {
    reasoningDeltas += 1
    reasoningText += chunk.text
  }
  if (chunk.type === 'text-delta') textChars += chunk.text.length
  if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning') {
    if (chunk.block.text !== reasoningText) throw new Error('block-end reasoning text != sum of deltas')
  }
  if (chunk.type === 'finish') console.log('finish:', JSON.stringify(chunk.reason))
}

console.log('--- RESULT ---')
console.log('reasoning block opened:', sawReasoningStart)
console.log('reasoning-delta chunks:', reasoningDeltas, '| chars:', reasoningText.length)
console.log('answer text chars:', textChars)
console.log('--- reasoning as the GUI would show it ---')
console.log(reasoningText.slice(0, 1200))
