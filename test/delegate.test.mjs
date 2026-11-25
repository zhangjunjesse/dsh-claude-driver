// The `delegate` DSH tool: Claude (or any DSH agent) hands a fully specified
// task to a fresh DSH child session on a model it picks, and the tool call
// blocks until that child answers. The default route prefers DeepSeek models.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEEPSEEK_PREFERRED_MODEL,
  DELEGATE_TOOL_NAME,
  DEFAULT_SUBAGENT_PROVIDER,
  createDelegateTool,
  listDelegateRoutes,
  rankDelegateRoute,
  registerDelegateTool,
  resolveDefaultDelegateRoute,
  resolveDelegateEffort,
  resolveDelegateRoute,
} from '../lib/delegate.js'

const signal = () => new AbortController().signal

/** The `llm` service as the driver sees it: providers, catalogs, exact models. */
function fakeLlm(catalog, { broken = [], efforts } = {}) {
  const providers = Object.keys(catalog).map((id) => ({ id, name: id }))
  return {
    listProviders: () => providers,
    async listModels(provider) {
      if (broken.includes(provider)) throw new Error(`${provider} catalog is down`)
      return (catalog[provider] ?? []).map((id) => ({ provider, id, name: id }))
    },
    async resolveModelInfo(provider, model) {
      const known = (catalog[provider] ?? []).includes(model)
      if (!known) throw new Error(`model "${model}" is not served by "${provider}"`)
      const table = efforts ?? { [DEEPSEEK_PREFERRED_MODEL]: ['low', 'high'] }
      const list = table[model]
      return {
        provider,
        id: model,
        name: model,
        ...(list === undefined
          ? {}
          : { reasoning: { efforts: list.map((id) => ({ id, name: id })), defaultEffort: list[0] } }),
      }
    },
  }
}

const catalog = {
  'opencode-go': [DEEPSEEK_PREFERRED_MODEL, 'deepseek-v4', 'hy4'],
  'claude-code': ['sonnet', 'opus'],
}

function fakeSubagents({ provider = DEFAULT_SUBAGENT_PROVIDER, capabilities = { agentOptions: true }, start } = {}) {
  return {
    getProvider: (name) => (name === provider ? { name, capabilities } : undefined),
    startActivation: start,
  }
}

/** A tool ctx with late-bound services, like the cordis host at call time. */
function fakeCtx(services = {}) {
  return {
    logger: { info() {}, warn() {} },
    get: (name) => services[name],
  }
}

function fakeRun({ text = 'done', stopReason = 'completed', settle } = {}) {
  const calls = { dispose: 0 }
  const run = {
    childId: 'child-1',
    name: 'agent-1',
    result: settle ?? Promise.resolve({ output: [{ type: 'text', text }], stopReason }),
    async dispose() {
      calls.dispose += 1
    },
  }
  return { run, calls }
}

test('route ranking: the fast DeepSeek model first, then other DeepSeek models, then anything', () => {
  assert.equal(rankDelegateRoute('opencode-go', DEEPSEEK_PREFERRED_MODEL), 0)
  assert.equal(rankDelegateRoute('anything', DEEPSEEK_PREFERRED_MODEL), 0)
  assert.equal(rankDelegateRoute('opencode-go', 'deepseek-v4'), 1)
  assert.equal(rankDelegateRoute('deepseek-direct', 'chat'), 1, 'a DeepSeek provider counts even when the model id does not')
  assert.equal(rankDelegateRoute('opencode-go', 'hy4'), 2)
  assert.equal(rankDelegateRoute('claude-code', 'sonnet'), 2)
})

test('the default route is the fast DeepSeek model, not the parent Claude route', async () => {
  const llm = fakeLlm(catalog)
  assert.deepEqual(await resolveDefaultDelegateRoute(llm, { signal: signal() }), {
    provider: 'opencode-go',
    model: DEEPSEEK_PREFERRED_MODEL,
  })
})

test('a catalog without the fast model still picks another DeepSeek model over everything else', async () => {
  const llm = fakeLlm({ 'opencode-go': ['hy4', 'deepseek-v4'], 'claude-code': ['sonnet'] })
  assert.deepEqual(await resolveDefaultDelegateRoute(llm, { signal: signal() }), {
    provider: 'opencode-go',
    model: 'deepseek-v4',
  })
})

test('a configured preference list wins over the built-in DeepSeek chain', async () => {
  const llm = fakeLlm(catalog)
  assert.deepEqual(await resolveDefaultDelegateRoute(llm, { preference: ['opencode-go/hy4'], signal: signal() }), {
    provider: 'opencode-go',
    model: 'hy4',
  })
  assert.deepEqual(await resolveDefaultDelegateRoute(llm, { preference: ['sonnet', 'nope'], signal: signal() }), {
    provider: 'claude-code',
    model: 'sonnet',
  })
})

test('one broken provider catalog does not block the default route', async () => {
  const llm = fakeLlm(catalog, { broken: ['claude-code'] })
  const routes = await listDelegateRoutes(llm, { signal: signal() })
  assert.deepEqual(routes.map((route) => `${route.provider}/${route.model}`), [
    `opencode-go/${DEEPSEEK_PREFERRED_MODEL}`,
    'opencode-go/deepseek-v4',
    'opencode-go/hy4',
  ])
})

test('no advertised model is a clear failure, not a silent Claude child', async () => {
  await assert.rejects(resolveDefaultDelegateRoute(fakeLlm({}), { signal: signal() }), /no DSH model provider advertises a model/)
})

test('an explicit "provider/model" route is used exactly as given', async () => {
  const llm = fakeLlm(catalog)
  assert.deepEqual(await resolveDelegateRoute(llm, { model: 'opencode-go/hy4', signal: signal() }), {
    provider: 'opencode-go',
    model: 'hy4',
  })
})

test('a bare model id is resolved against the catalog', async () => {
  const llm = fakeLlm(catalog)
  assert.deepEqual(await resolveDelegateRoute(llm, { model: 'opus', signal: signal() }), {
    provider: 'claude-code',
    model: 'opus',
  })
})

test('an unknown model fails with the available routes', async () => {
  const llm = fakeLlm(catalog)
  await assert.rejects(resolveDelegateRoute(llm, { model: 'gpt-9', signal: signal() }), (error) => {
    assert.match(error.message, /gpt-9/)
    assert.match(error.message, /opencode-go\/hy4/)
    assert.match(error.message, /provider\/model/)
    return true
  })
})

test('reasoning_effort is validated against the chosen model', async () => {
  const llm = fakeLlm(catalog)
  const route = { provider: 'opencode-go', model: DEEPSEEK_PREFERRED_MODEL }
  assert.equal(await resolveDelegateEffort(llm, route, 'high', signal()), 'high')
  assert.equal(await resolveDelegateEffort(llm, route, undefined, signal()), undefined, 'omitted effort is omitted, not defaulted')
  await assert.rejects(resolveDelegateEffort(llm, route, 'max', signal()), /available: low, high/)
  await assert.rejects(resolveDelegateEffort(llm, { provider: 'opencode-go', model: 'hy4' }, 'high', signal()), /no reasoning efforts/)
})

test('the tool tells the model to brief the child like an intern and to delegate freely', () => {
  const definition = createDelegateTool(fakeCtx({}), {})
  assert.equal(definition.name, DELEGATE_TOOL_NAME)
  assert.match(definition.description, /intern/)
  assert.match(definition.description, /Do not ask permission|whenever|judge/i)
  assert.match(definition.description, /provider\/model/)
  assert.deepEqual(definition.parameters.required, ['prompt', 'description'])
  assert.equal(definition.output.schema.type, 'object')
})

test('execute blocks on a fresh DSH child on the chosen model and returns its answer', async () => {
  const agent = { id: 'a', session: { id: 's1' } }
  let spec
  const { run } = fakeRun({ text: 'report written' })
  const tool = createDelegateTool(fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ start: async (request) => { spec = request; return run } }) }), {})

  const value = await tool.execute({ prompt: 'Read a.js and report the bug.', description: 'bug report' }, { agent, signal: signal() })

  assert.equal(value.provider, 'opencode-go')
  assert.equal(value.model, DEEPSEEK_PREFERRED_MODEL)
  assert.equal(value.name, 'agent-1')
  assert.equal(value.stop_reason, 'completed')
  assert.equal(value.output, 'report written')
  assert.equal(spec.delivery, 'caller', 'the answer comes back to this tool call, not the parent inbox')
  assert.equal(spec.parent, agent)
  assert.equal(spec.provider, DEFAULT_SUBAGENT_PROVIDER)
  assert.equal(spec.label, 'bug report')
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'Read a.js and report the bug.' }])
  assert.deepEqual(spec.agentOptions, { provider: 'opencode-go', model: DEEPSEEK_PREFERRED_MODEL })
})

test('an explicit model and effort reach the child options', async () => {
  let spec
  const { run } = fakeRun()
  const tool = createDelegateTool(
    fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ start: async (request) => { spec = request; return run } }) }),
    {},
  )
  await tool.execute({ prompt: 'p', description: 'd', model: 'opencode-go/hy4', reasoning_effort: 'low' }, { agent: { id: 'a' }, signal: signal() })
  assert.deepEqual(spec.agentOptions, { provider: 'opencode-go', model: 'hy4', reasoningEffort: 'low' })
})

test('the child is disposed exactly once after it settles', async () => {
  const { run, calls } = fakeRun()
  const tool = createDelegateTool(fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ start: async () => run }) }), {})
  await tool.execute({ prompt: 'p', description: 'd' }, { agent: { id: 'a' }, signal: signal() })
  assert.equal(calls.dispose, 1)
})

test('a child that stops without a result fails the call with its text', async () => {
  const { run, calls } = fakeRun({ text: 'hit a wall', stopReason: 'error' })
  const tool = createDelegateTool(fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ start: async () => run }) }), {})
  await assert.rejects(tool.execute({ prompt: 'p', description: 'd' }, { agent: { id: 'a' }, signal: signal() }), /hit a wall/)
  assert.equal(calls.dispose, 1)
})

test('cancelling the call cancels the child', async () => {
  const controller = new AbortController()
  const { run, calls } = fakeRun({ settle: new Promise(() => {}) })
  const tool = createDelegateTool(fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ start: async () => run }) }), {})
  const pending = tool.execute({ prompt: 'p', description: 'd' }, { agent: { id: 'a' }, signal: controller.signal })
  const timer = setTimeout(() => controller.abort(new Error('user stopped it')), 5)
  try {
    await assert.rejects(pending, /user stopped it/)
  } finally {
    clearTimeout(timer)
  }
  assert.equal(calls.dispose, 1)
})

test('delegateTimeoutMs stops a child that overruns its deadline', async () => {
  const { run, calls } = fakeRun({ settle: new Promise(() => {}) })
  const tool = createDelegateTool(fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ start: async () => run }) }), { delegateTimeoutMs: 10 })
  await assert.rejects(tool.execute({ prompt: 'p', description: 'd' }, { agent: { id: 'a' }, signal: signal() }), /timed out after 10ms/)
  assert.equal(calls.dispose, 1)
})

test('a missing calling agent, llm service or subagent provider fails loud', async () => {
  const tool = createDelegateTool(fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ start: async () => fakeRun().run }) }), {})
  await assert.rejects(tool.execute({ prompt: 'p', description: 'd' }, { signal: signal() }), /calling agent/)
  const noLlm = createDelegateTool(fakeCtx({ subagents: fakeSubagents() }), {})
  await assert.rejects(noLlm.execute({ prompt: 'p', description: 'd' }, { agent: { id: 'a' }, signal: signal() }), /llm/)
  const noProvider = createDelegateTool(fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ provider: 'other' }) }), {})
  await assert.rejects(noProvider.execute({ prompt: 'p', description: 'd' }, { agent: { id: 'a' }, signal: signal() }), /spawn/)
})

test('a provider without child model selection is refused before starting work', async () => {
  const tool = createDelegateTool(
    fakeCtx({ llm: fakeLlm(catalog), subagents: fakeSubagents({ capabilities: {}, start: async () => fakeRun().run }) }),
    {},
  )
  await assert.rejects(tool.execute({ prompt: 'p', description: 'd' }, { agent: { id: 'a' }, signal: signal() }), /agentOptions|model selection/)
})

test('registerDelegateTool registers one tool and honors delegateTool:false', () => {
  const registered = []
  const ctx = fakeCtx({ tools: { register: (definition) => { registered.push(definition); return () => {} } } })
  const dispose = registerDelegateTool(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, DELEGATE_TOOL_NAME)
  assert.equal(typeof dispose, 'function')
  assert.equal(registerDelegateTool(ctx, { delegateTool: false }), undefined)
  assert.equal(registered.length, 1, 'a disabled tool is never registered')
})

test('registerDelegateTool without a tools service warns instead of throwing', () => {
  const warns = []
  const ctx = { logger: { info() {}, warn: (...args) => warns.push(args.join(' ')) }, get: () => undefined }
  assert.equal(registerDelegateTool(ctx, {}), undefined)
  assert.ok(warns.some((line) => /tools service/.test(line)), warns.join('|'))
})
