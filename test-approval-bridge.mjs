// Pure unit tests (no network, no SDK spawn) for the Claude built-in-tool
// approval bridge (buildCanUseTool + independent assembly in
// streamClaudeChunks). SDK contract under test: canUseTool must NEVER return
// null (fail-closed: no control_response → the tool blocks forever), bridged
// DSH tools always pass (DSH's own tools/pre-execute → approval pipeline owns
// them), and Claude built-ins map approval outcomes allowed-once→allow /
// rejected|cancelled|unavailable|missing-service→deny.
// Run: node test-approval-bridge.mjs
import assert from 'node:assert/strict'
import { buildApprovalReason, buildCanUseTool, streamClaudeChunks } from './lib/index.js'

const agent = { id: 'approval-test', session: { id: 's-approval' } }

function mockCtx({ approvalImpl, withAgents = true } = {}) {
  const requests = []
  return {
    requests,
    logger: { info: () => {}, warn: () => {} },
    get(name) {
      if (name === 'agents' && withAgents) return { currentInitiator: () => agent }
      if (name === 'approval' && approvalImpl)
        return {
          request: async (req) => {
            requests.push(req)
            return approvalImpl(req)
          },
        }
      return undefined
    },
  }
}

const input = { command: 'echo hi' }
const controller = new AbortController()

// --- default off: built-ins pass straight through, approval never consulted --
{
  const ctx = mockCtx({ approvalImpl: () => 'rejected' })
  const canUseTool = buildCanUseTool(ctx, { approveBuiltinTools: false }, controller, new Set())
  const decision = await canUseTool('Bash', input, { toolUseID: 'tu1', signal: controller.signal })
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: input }, 'approveBuiltinTools=false allows directly')
  assert.equal(ctx.requests.length, 0, 'approval service untouched when disabled')
}

// --- allowlist: read-only built-ins skip the prompt even when enabled --------
{
  const ctx = mockCtx({ approvalImpl: () => 'rejected' })
  const settings = { approveBuiltinTools: true, builtinAllowlist: ['Read', 'Grep', 'Glob'] }
  const canUseTool = buildCanUseTool(ctx, settings, controller, new Set())
  for (const name of ['Read', 'Grep', 'Glob']) {
    const decision = await canUseTool(name, input, {})
    assert.equal(decision.behavior, 'allow', `${name} allowlisted`)
    assert.equal(decision.updatedInput, input)
  }
  assert.equal(ctx.requests.length, 0, 'allowlisted tools never reach approval')
}

// --- bridged DSH tools always allow (DSH pipeline owns approval; no double prompt)
{
  const ctx = mockCtx({ approvalImpl: () => 'rejected' })
  const canUseTool = buildCanUseTool(ctx, { approveBuiltinTools: true }, controller, new Set(['pwsh']))
  for (const wire of ['pwsh', 'mcp__dsh-tools__pwsh']) {
    const decision = await canUseTool(wire, input, {})
    assert.equal(decision.behavior, 'allow', `bridged tool ${wire} allowed`)
  }
  assert.equal(ctx.requests.length, 0, 'bridged tools bypass the built-in approval path')
}

// --- enabled + allowed-once → allow, request carries agent/toolName/callId/reason/signal
{
  const ctx = mockCtx({ approvalImpl: () => 'allowed-once' })
  const canUseTool = buildCanUseTool(ctx, { approveBuiltinTools: true }, controller, new Set())
  const info = { toolUseID: 'toolu_01', signal: controller.signal, title: 'Claude wants to run: echo hi', decisionReason: 'permissionMode ask' }
  const decision = await canUseTool('Bash', input, info)
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: input }, 'allowed-once maps to allow')
  assert.equal(ctx.requests.length, 1)
  const req = ctx.requests[0]
  assert.equal(req.agent, agent, 'agent = currentInitiator()')
  assert.equal(req.toolName, 'Bash')
  assert.equal(req.callId, 'toolu_01', 'toolUseID rides as callId')
  assert.equal(req.signal, controller.signal)
  assert.ok(req.reason.includes('Claude wants to run: echo hi'), 'SDK title feeds the reason')
}

// --- rejected / cancelled / unavailable → deny (never allow, never null) -----
for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
  const ctx = mockCtx({ approvalImpl: () => outcome })
  const canUseTool = buildCanUseTool(ctx, { approveBuiltinTools: true }, controller, new Set())
  const decision = await canUseTool('Bash', input, {})
  assert.ok(decision !== null && decision !== undefined, `${outcome}: decision is never null`)
  assert.equal(decision.behavior, 'deny', `${outcome} maps to deny`)
  assert.ok(typeof decision.message === 'string' && decision.message.length > 0, `${outcome} deny carries a message`)
}

// --- no approval service → deny (fail closed), not allow, not null -----------
{
  const ctx = mockCtx({ approvalImpl: undefined })
  const canUseTool = buildCanUseTool(ctx, { approveBuiltinTools: true }, controller, new Set())
  const decision = await canUseTool('Bash', input, {})
  assert.equal(decision.behavior, 'deny', 'missing approval service denies')
  assert.ok(decision.message.includes('unavailable'), 'message names the cause')
}

// --- no agents service either → deny, still not null -------------------------
{
  const ctx = mockCtx({ approvalImpl: () => 'allowed-once', withAgents: false })
  const canUseTool = buildCanUseTool(ctx, { approveBuiltinTools: true }, controller, new Set())
  const decision = await canUseTool('Bash', input, {})
  assert.equal(decision.behavior, 'deny', 'no initiating agent denies (fail closed)')
}

// --- approval.request throwing (e.g. no open turn) → deny, never a throw/null
{
  const ctx = mockCtx({ approvalImpl: () => { throw new Error('approval.request() outside an open turn') } })
  const canUseTool = buildCanUseTool(ctx, { approveBuiltinTools: true }, controller, new Set())
  const decision = await canUseTool('Bash', input, {})
  assert.equal(decision.behavior, 'deny', 'thrown approval error maps to deny')
  assert.ok(decision.message.includes('open turn'), 'deny message carries the error')
}

// --- reason assembly: title > displayName, decisionReason appended, fallback --
assert.equal(
  buildApprovalReason('Bash', { title: 'Claude wants to run: rm -rf', decisionReason: 'ask rule' }),
  'Claude wants to run: rm -rf — ask rule',
)
assert.equal(buildApprovalReason('Bash', { displayName: 'Run command' }), 'Run command')
assert.equal(buildApprovalReason('WebFetch', {}), 'Claude Code built-in tool: WebFetch')

// --- streamClaudeChunks assembly: canUseTool installs WITHOUT any DSH tools --
async function captureSdkOptions(settings, options) {
  let captured
  const queryImpl = ({ options: sdkOptions }) => {
    captured = sdkOptions
    return (async function* () {
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  }
  const chunks = []
  for await (const chunk of streamClaudeChunks(
    mockCtx({ approvalImpl: () => 'allowed-once' }),
    { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], ...options },
    { resumeChain: false, queryImpl, ...settings },
  )) chunks.push(chunk)
  return captured
}

{
  // approveBuiltinTools on, zero DSH tools bridged → canUseTool still installed
  const sdkOptions = await captureSdkOptions({ approveBuiltinTools: true }, {})
  assert.equal(typeof sdkOptions.canUseTool, 'function', 'canUseTool assembled without a tool bridge')
  assert.equal(sdkOptions.mcpServers, undefined, 'no bridge, no MCP servers')
  const bash = await sdkOptions.canUseTool('Bash', input, {})
  assert.equal(bash.behavior, 'allow', 'wired callback reaches the mock approval (allowed-once → allow)')
  const read = await sdkOptions.canUseTool('Read', input, {})
  assert.equal(read.behavior, 'allow', 'default allowlist active through the wiring')
}

{
  // default settings (approveBuiltinTools off), no DSH tools → SDK default handling preserved
  const sdkOptions = await captureSdkOptions({}, {})
  assert.equal(sdkOptions.canUseTool, undefined, 'no canUseTool when disabled and unbridged')
}

{
  // bridge present, approveBuiltinTools off → canUseTool installed and allows
  // both bridged names and built-ins (legacy behavior, minus the null hazard)
  let captured
  const queryImpl = ({ options: sdkOptions }) => {
    captured = sdkOptions
    return (async function* () {
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  }
  const bridgeCtx = {
    logger: { info: () => {}, warn: () => {} },
    get(name) {
      if (name === 'tools') return { execute: async () => ({ content: [], isError: false }) }
      if (name === 'agents') return { currentInitiator: () => agent }
      return undefined
    },
  }
  const chunks = []
  for await (const chunk of streamClaudeChunks(
    bridgeCtx,
    {
      provider: 'claude-code',
      model: 'sonnet',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: [{ name: 'pwsh', description: 'Run PowerShell.', parameters: { type: 'object', properties: {} } }],
    },
    { resumeChain: false, nativeToolCards: false, queryImpl },
  )) chunks.push(chunk)
  assert.equal(typeof captured.canUseTool, 'function', 'bridge alone still installs canUseTool')
  assert.ok(Array.isArray(captured.mcpServers) && captured.mcpServers.length === 1, 'bridge MCP server installed')
  const bridged = await captured.canUseTool('mcp__dsh-tools__pwsh', input, {})
  assert.equal(bridged.behavior, 'allow', 'bridged tool allowed (DSH pipeline owns approval)')
  const builtin = await captured.canUseTool('Bash', input, {})
  assert.deepEqual(builtin, { behavior: 'allow', updatedInput: input }, 'built-ins still pass with the flag off')
}

console.log('test-approval-bridge: all assertions passed')
