// Frontend-mode guarantees: only plugin tools cross the MCP bridge, the DSH
// prompt can shrink to operator instruction files, and the built-in question
// dialog never reaches a host that cannot render it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSdkOptions, selectBridgeSchemas, systemPromptKey, userInstructionFiles, userSystemPrompt } from '../lib/index.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const schema = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
const system = (text) => ({ role: 'system', content: [{ type: 'text', text }] })
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

test("bridgeTools:'plugins' keeps plugin tools and drops DSH core twins", () => {
  const schemas = [schema('bash'), schema('read'), schema('plugin_manager'), schema('ask_user_question'), schema('notion_search'), schema('cu_status')]
  const selected = selectBridgeSchemas(schemas, { bridgeTools: 'plugins' })
  assert.deepEqual(selected.map((s) => s.name), ['ask_user_question', 'notion_search', 'cu_status'])
})

test("bridgeTools:'plugins' honours coreTools and bridgeToolNames overrides", () => {
  const schemas = [schema('bash'), schema('notion_search')]
  assert.deepEqual(selectBridgeSchemas(schemas, { bridgeTools: 'plugins', coreTools: ['notion_search'] }).map((s) => s.name), [])
  assert.deepEqual(selectBridgeSchemas(schemas, { bridgeTools: 'plugins', coreTools: ['bash'], bridgeToolNames: ['bash'] }).map((s) => s.name), ['bash', 'notion_search'])
})

test('bridgeTools:true/all and false keep their old meaning', () => {
  const schemas = [schema('bash'), schema('notion_search')]
  assert.equal(selectBridgeSchemas(schemas, {}).length, 2)
  assert.equal(selectBridgeSchemas(schemas, { bridgeTools: false }).length, 0)
})

test("systemPromptMode 'none' leaves Claude Code's own prompt untouched", () => {
  const sdk = buildSdkOptions(
    ctx,
    { provider: 'claude-code', model: 'sonnet', messages: [system('DSH BASE'), user('hi')] },
    { systemPromptMode: 'none' },
    { controller: new AbortController(), model: 'sonnet' },
  )
  assert.equal(sdk.systemPrompt, undefined)
})

test("systemPromptMode 'user' appends only the operator files", () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-driver-user-prompt-'))
  try {
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, 'Operator rule: be terse.')
    const sdk = buildSdkOptions(
      ctx,
      { provider: 'claude-code', model: 'sonnet', messages: [system('DSH BASE'), user('hi')] },
      { systemPromptMode: 'user', userPromptFiles: [file] },
      { controller: new AbortController(), model: 'sonnet' },
    )
    assert.equal(sdk.systemPrompt.preset, 'claude_code')
    assert.match(sdk.systemPrompt.append, /Operator rule: be terse\./)
    assert.ok(!sdk.systemPrompt.append.includes('DSH BASE'), 'the DSH prompt must not ride along')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("systemPromptMode 'user' finds ~/.dsh/AGENTS.md and the workspace AGENTS.md by default", () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-driver-home-'))
  try {
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'AGENTS.md'), 'Global rule.')
    const workspace = join(home, 'work', 'project')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), 'Project rule.')
    const files = userInstructionFiles({ cwd: workspace, home })
    assert.deepEqual(files.slice(0, 2), [join(home, '.dsh', 'AGENTS.md'), join(workspace, 'AGENTS.md')])
    const text = userSystemPrompt({ cwd: workspace, home })
    assert.match(text, /Global rule\./)
    assert.match(text, /Project rule\./)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the prewarm key changes when the prompt mode or the operator files change', () => {
  const options = { messages: [system('DSH BASE')] }
  assert.equal(systemPromptKey(options, {}), 'DSH BASE')
  assert.notEqual(systemPromptKey(options, { systemPromptMode: 'none' }), 'DSH BASE')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-driver-key-'))
  try {
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    writeFileSync(a, 'one')
    writeFileSync(b, 'two')
    assert.notEqual(
      systemPromptKey(options, { systemPromptMode: 'user', userPromptFiles: [a] }),
      systemPromptKey(options, { systemPromptMode: 'user', userPromptFiles: [b] }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('canUseTool suppresses the built-in question dialog even when no DSH ask tool is bridged', () => {
  const bridge = { mcpServers: {}, bridgedNames: new Set(['notion_search']) }
  const sdk = buildSdkOptions(
    ctx,
    { provider: 'claude-code', model: 'sonnet', messages: [user('hi')] },
    { systemPromptMode: 'none' },
    { controller: new AbortController(), model: 'sonnet', bridge },
  )
  assert.ok(sdk.disallowedTools.includes('AskUserQuestion'))
})
