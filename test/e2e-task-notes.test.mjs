// Real Claude CLI against a local Anthropic API double. These are the exact ways
// a task can end that used to produce a wrong "background tasks failed" note.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { startMockAnthropic } from './support/mock-anthropic.mjs'

const require = createRequire(import.meta.url)
let hasCli = true
try { require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude') } catch { hasCli = false }
const opts = { skip: !hasCli && 'no claude binary', timeout: 120000 }

const saved = {}
const setEnv = (vars) => { for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v } }
let mock
let scenario
before(async () => {
  mock = await startMockAnthropic((body) => {
    if (!body.tools?.length) return [{ text: 'title' }]
    if (JSON.stringify(body.messages).includes('tool_result')) return [{ text: 'Done.' }]
    return [{ tool_use: { id: 'toolu_e2e', name: 'Bash', input: scenario } }]
  })
  setEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-e2e', CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'e2e-tasks-')), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTPS_PROXY: undefined, HTTP_PROXY: undefined, ALL_PROXY: undefined })
})
after(async () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } await mock?.close() })

async function turn(input, config = {}, { abortAfterMs } = {}) {
  scenario = input
  let handler
  apply({ logger: { info() {}, warn() {} }, on: (e, fn) => { if (e === 'llm/stream') handler = fn }, get: () => undefined },
    { resumeChain: false, cwd: tmpdir(), permissionMode: 'bypassPermissions', pulseMs: 0, ...config })
  const ac = new AbortController()
  if (abortAfterMs) setTimeout(() => ac.abort(), abortAfterMs)
  const chunks = []
  for await (const c of handler({ provider: 'claude-code', model: 'sonnet', signal: ac.signal, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }, () => { throw new Error('not claimed') })) chunks.push(c)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  return { chunks, text, reasoning, all: text + reasoning }
}

test('e2e: a long foreground command that fails (exit 143) is NOT a "background task failed" note', opts, async () => {
  const { all, chunks } = await turn({ command: 'sleep 6; exit 143', description: 'Write failing tests first' })
  assert.ok(!/background tasks/i.test(all), all)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('e2e: a background command that fails is reported as failed with its description', opts, async () => {
  const { text } = await turn({ command: 'sleep 1; exit 3', description: 'Failing job', run_in_background: true })
  assert.match(text, /background tasks failed:.*Failing job/i)
})

test('e2e: a background command that succeeds is reported once, as finished', opts, async () => {
  const { all } = await turn({ command: 'sleep 1; echo ok', description: 'Short job', run_in_background: true })
  assert.equal((all.match(/Short job/g) ?? []).length, 1, all)
  assert.ok(!/background tasks failed/i.test(all))
})

test('e2e: a background task still running at the turn deadline is "possibly terminated", never "failed"', opts, async () => {
  const { text } = await turn({ command: 'sleep 60', description: 'Long job', run_in_background: true }, { backgroundTaskTimeoutMs: 3000 })
  assert.match(text, /exceeded the 3s hold.*Long job/)
  assert.ok(!/background tasks failed/i.test(text))
})

test('e2e: interrupting the turn ends the task and says so; it does not claim it is still running', opts, async () => {
  const marker = join(tmpdir(), `bg-marker-${process.pid}`)
  rmSync(marker, { force: true })
  const { text } = await turn({ command: `sleep 8; touch ${marker}`, description: 'Marker job', run_in_background: true }, {}, { abortAfterMs: 4000 })
  assert.ok(!/still running/i.test(text), text)
  assert.match(text, /interrupted.*Marker job/i)
  await new Promise((r) => setTimeout(r, 7000))
  assert.equal(existsSync(marker), false, 'the interrupted task really died')
})
