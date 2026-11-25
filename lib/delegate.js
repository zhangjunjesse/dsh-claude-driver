/**
 * The `delegate` tool: hand a fully specified task to a fresh DSH child
 * session on a model the caller picks, and block until that child answers.
 *
 * Why it exists: a claude-code session's own `subagent` tool inherits the
 * Claude route (another Claude turn), and DSH only exposes explicit child
 * models when the operator enables the model-selection allowlist. This tool is
 * a plain DSH tool that always routes the child through a selected DSH
 * provider/model, preferring DeepSeek so Claude can offload work cheaply.
 *
 * Transport: `subagents.startActivation` with `delivery: 'caller'`; the child's
 * final output settles the activation result instead of landing in the parent
 * inbox, so one tool call returns one answer. The child inherits the caller's
 * sandbox and approval policies through the subagent service.
 */

/** Registration-visible tool name. */
export const DELEGATE_TOOL_NAME = 'delegate'
/** Subagent backend that starts a fresh, model-selectable DSH child. */
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn'
/** The DeepSeek route preferred when the caller names no model. */
export const DEEPSEEK_PREFERRED_MODEL = 'deepseek-v4.1-flash'

const ROUTE_LIST_LIMIT = 40
const CATALOG_TIMEOUT_MS = 3_000
const ROUTE_HINT = 'Pass `provider/model` (for example `opencode-go/deepseek-v4.1-flash`) to pick an exact route.'

const DESCRIPTION = `Hand a self-contained task to a fresh DSH subagent and wait for its answer. Call this whenever you judge that delegating saves time, context or cost: scoped research, an independent edit, a test sweep, a second opinion, a long read. Do not ask permission first.

The subagent starts with no knowledge of this conversation, the user's request or the files it must touch, and it cannot ask you a follow-up question. Write \`prompt\` as a brief for a competent intern: name the exact files and paths, state the goal, say what to read first, what to change or produce, which commands to run, which constraints apply (what not to touch), what shape the answer must take, and how the finished work can be checked. Put the destination of any output in the prompt. Prefer "read summarize.js, change the loop at line 40 to skip empty rows, run node --test test/summarize.test.mjs, return the failing assertion text" over "look into summarize".

\`model\` selects the child's DSH model: \`provider/model\`, or a bare model id advertised by a DSH provider. Omit it to use the DeepSeek-first default route. \`reasoning_effort\` is optional and only accepted when that model advertises efforts.

The result is the child's final answer text; its intermediate steps stay in its own session.`

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: {
      type: 'string',
      description:
        'The complete brief for the subagent: files, paths, goal, steps, constraints, commands to run, required answer shape. It sees none of this conversation.',
    },
    description: {
      type: 'string',
      description: 'A short (3-5 word) label for the delegation list, in the language of the current request.',
    },
    name: {
      type: 'string',
      description: 'Optional short name, unique among your subagents: lower-case letters, digits and hyphens, at most 32 characters.',
    },
    model: {
      type: 'string',
      description: `Optional child model: \`provider/model\` or a bare model id. Omit for the DeepSeek-first default.`,
    },
    reasoning_effort: {
      type: 'string',
      description: 'Optional reasoning effort id advertised by the chosen model.',
    },
  },
  required: ['prompt', 'description'],
}

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      provider: { type: 'string' },
      model: { type: 'string' },
      reasoning_effort: { type: 'string' },
      name: { type: 'string' },
      stop_reason: { type: 'string' },
      output: { type: 'string' },
    },
    required: ['provider', 'model', 'name', 'stop_reason', 'output'],
  },
}

/**
 * Rank one route for the default selection: the fast DeepSeek model first,
 * then any other DeepSeek model or provider, then everything else.
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {0|1|2} lower ranks win.
 */
export function rankDelegateRoute(provider, model) {
  if (model === DEEPSEEK_PREFERRED_MODEL) return 0
  if (/deepseek/i.test(String(model)) || /deepseek/i.test(String(provider))) return 1
  return 2
}

/** Reject after `ms` unless the source promise settles first. */
function withTimeout(promise, ms, message) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Abortable wait on the activation result, with an optional deadline. */
function waitForRun(result, { signal, timeoutMs }) {
  const waits = []
  let release = () => {}
  if (signal !== undefined) {
    waits.push(
      new Promise((_, reject) => {
        const stop = () => reject(signal.reason ?? new Error('delegate: the call was cancelled'))
        if (signal.aborted) {
          stop()
          return
        }
        signal.addEventListener('abort', stop, { once: true })
        release = () => signal.removeEventListener('abort', stop)
      }),
    )
  }
  let deadline
  if (timeoutMs > 0) {
    waits.push(
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`delegate: the subagent timed out after ${timeoutMs}ms and was stopped`)),
          timeoutMs,
        )
        deadline.unref?.()
      }),
    )
  }
  if (waits.length === 0) return result
  const clear = () => {
    release()
    clearTimeout(deadline)
  }
  return Promise.race([result, ...waits]).finally(clear)
}

/** A provider/model pair for the model-facing error and the delegation list. */
function routeLine(route) {
  return `${route.provider}/${route.model}`
}

/** The model list shown when a requested route cannot be resolved. */
function routeHint(routes) {
  if (routes.length === 0) return 'no DSH model provider advertises a model right now.'
  const shown = routes.slice(0, ROUTE_LIST_LIMIT).map(routeLine).join(', ')
  const more = routes.length > ROUTE_LIST_LIMIT ? `, and ${routes.length - ROUTE_LIST_LIMIT} more` : ''
  return `available routes: ${shown}${more}. ${ROUTE_HINT}`
}

/**
 * Enumerate the routes DSH actually advertises. A provider whose catalog
 * throws or stalls is skipped: one broken vendor must not block delegation.
 * @param {object} llm - the DSH `llm` service.
 * @param {{signal?: AbortSignal, timeoutMs?: number}} options - cancellation and per-catalog deadline.
 * @returns {Promise<Array<{provider: string, model: string}>>} routes in provider order.
 */
export async function listDelegateRoutes(llm, { signal, timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  const routes = []
  for (const provider of providers) {
    signal?.throwIfAborted?.()
    let models
    try {
      models = await withTimeout(llm.listModels(provider.id), timeoutMs, `catalog for ${provider.id} timed out`)
    } catch {
      continue
    }
    for (const model of Array.isArray(models) ? models : []) {
      if (typeof model?.id === 'string' && model.id) routes.push({ provider: provider.id, model: model.id })
    }
  }
  return routes
}

/** First route whose configured preference entry matches, in preference order. */
function preferredRoute(routes, preference) {
  for (const entry of Array.isArray(preference) ? preference : []) {
    if (typeof entry !== 'string' || !entry) continue
    const match = entry.includes('/')
      ? routes.find((route) => routeLine(route) === entry)
      : routes.find((route) => route.model === entry)
    if (match !== undefined) return match
  }
  return undefined
}

/**
 * Pick the child route when the caller names no model: the configured
 * preference list first, then the DeepSeek-first ranking. Providers are read
 * lazily and the scan stops as soon as the best rank is found, so an expensive
 * catalog (Claude discovery) is only consulted when it can still win.
 * @param {object} llm - the DSH `llm` service.
 * @param {{preference?: string[], signal?: AbortSignal, timeoutMs?: number}} options - selection inputs.
 * @returns {Promise<{provider: string, model: string}>} the chosen route.
 */
export async function resolveDefaultDelegateRoute(llm, { preference, signal, timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  if (!Array.isArray(preference) || preference.length === 0) {
    let best
    for (const provider of providers) {
      signal?.throwIfAborted?.()
      let models
      try {
        models = await withTimeout(llm.listModels(provider.id), timeoutMs, `catalog for ${provider.id} timed out`)
      } catch {
        continue
      }
      for (const model of Array.isArray(models) ? models : []) {
        if (typeof model?.id !== 'string' || !model.id) continue
        const rank = rankDelegateRoute(provider.id, model.id)
        if (best === undefined || rank < best.rank) best = { provider: provider.id, model: model.id, rank }
        if (rank === 0) return { provider: best.provider, model: best.model }
      }
    }
    if (best !== undefined) return { provider: best.provider, model: best.model }
    throw new Error('delegate: no DSH model provider advertises a model right now; nothing was started.')
  }
  const routes = await listDelegateRoutes(llm, { signal, timeoutMs })
  const configured = preferredRoute(routes, preference)
  if (configured !== undefined) return configured
  const ranked = [...routes].sort(
    (left, right) => rankDelegateRoute(left.provider, left.model) - rankDelegateRoute(right.provider, right.model),
  )
  if (ranked[0] !== undefined) return ranked[0]
  throw new Error('delegate: no DSH model provider advertises a model right now; nothing was started.')
}

/**
 * Resolve the route the caller asked for: `provider/model`, a bare model id
 * advertised by a provider, or the DeepSeek-first default when omitted.
 * @param {object} llm - the DSH `llm` service.
 * @param {{model?: string, preference?: string[], signal?: AbortSignal, timeoutMs?: number}} request - caller request.
 * @returns {Promise<{provider: string, model: string}>} the chosen route.
 */
export async function resolveDelegateRoute(llm, { model, preference, signal, timeoutMs } = {}) {
  const wanted = typeof model === 'string' ? model.trim() : ''
  if (!wanted) return resolveDefaultDelegateRoute(llm, { preference, signal, timeoutMs })
  if (wanted.includes('/')) {
    const separator = wanted.indexOf('/')
    const provider = wanted.slice(0, separator)
    const id = wanted.slice(separator + 1)
    if (!provider || !id) throw new Error(`delegate: "${wanted}" is not a valid route; write it as provider/model.`)
    const known = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
    if (!known.some((entry) => entry.id === provider)) {
      const ids = known.map((entry) => entry.id).join(', ') || '(none)'
      throw new Error(`delegate: no DSH provider "${provider}" is registered; providers: ${ids}.`)
    }
    return { provider, model: id }
  }
  const routes = await listDelegateRoutes(llm, { signal, timeoutMs })
  const match = routes.find((route) => route.model === wanted)
  if (match === undefined) throw new Error(`delegate: no DSH model "${wanted}" is advertised; ${routeHint(routes)}`)
  return match
}

/**
 * Validate `reasoning_effort` against the chosen model's advertised efforts.
 * @param {object} llm - the DSH `llm` service.
 * @param {{provider: string, model: string}} route - the exact child route.
 * @param {string|undefined} effort - caller-supplied effort id.
 * @param {AbortSignal|undefined} signal - cancellation for model lookup.
 * @returns {Promise<string|undefined>} the effort to pass on, or undefined.
 */
export async function resolveDelegateEffort(llm, route, effort, signal) {
  if (effort === undefined || effort === '') return undefined
  const info = await llm.resolveModelInfo(route.provider, route.model, signal)
  const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
  if (efforts.length === 0) {
    throw new Error(`delegate: ${routeLine(route)} advertises no reasoning efforts; omit reasoning_effort.`)
  }
  if (!efforts.some((entry) => entry.id === effort)) {
    throw new Error(
      `delegate: unknown reasoning effort "${effort}" for ${routeLine(route)}; available: ${efforts.map((entry) => entry.id).join(', ')}.`,
    )
  }
  return effort
}

/** The text of a settled activation output, ignoring non-text blocks. */
function outputText(output) {
  const blocks = Array.isArray(output) ? output : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Build the `delegate` definition. Services are resolved at call time so a
 * late-provided `llm` or `subagents` still works.
 * @param {object} ctx - plugin context with `get()` and `logger`.
 * @param {object} settings - driver settings (`delegateProvider`, `delegateModels`, `delegateTimeoutMs`).
 * @returns {object} a registry-ready tool definition.
 */
export function createDelegateTool(ctx, settings = {}) {
  return {
    name: DELEGATE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      ...OUTPUT,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.stop_reason === 'completed'
              ? `${value.provider}/${value.model} (${value.name}) answered:\n\n${value.output}`
              : `${value.provider}/${value.model} (${value.name}) stopped: ${value.stop_reason}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const llm = ctx.get?.('llm')
      if (llm === undefined || typeof llm.listProviders !== 'function') {
        throw new Error('delegate: the DSH "llm" service is unavailable, so no child model can be resolved.')
      }
      const subagents = ctx.get?.('subagents')
      if (subagents === undefined || typeof subagents.startActivation !== 'function') {
        throw new Error('delegate: the DSH "subagents" service is unavailable, so nothing can be started.')
      }
      const agent = exec?.agent
      if (agent === undefined) throw new Error('delegate: requires a calling agent (exec.agent was undefined).')
      const signal = exec?.signal
      const route = await resolveDelegateRoute(llm, { model: args.model, preference: settings.delegateModels, signal })
      const reasoningEffort = await resolveDelegateEffort(llm, route, args.reasoning_effort, signal)
      const providerName = settings.delegateProvider ?? DEFAULT_SUBAGENT_PROVIDER
      const provider = subagents.getProvider(providerName)
      if (provider === undefined) {
        throw new Error(
          `delegate: no subagent provider "${providerName}" is registered; install/config the in-process spawn backend or set delegateProvider.`,
        )
      }
      if (provider.capabilities?.agentOptions !== true) {
        throw new Error(`delegate: subagent provider "${providerName}" does not support child model selection.`)
      }
      signal?.throwIfAborted?.()
      const run = await subagents.startActivation({
        provider: providerName,
        label: args.description,
        ...(args.name === undefined ? {} : { name: args.name }),
        delivery: 'caller',
        ...(signal === undefined ? {} : { signal }),
        prompt: [{ type: 'text', text: args.prompt }],
        parent: agent,
        agentOptions: { provider: route.provider, model: route.model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
      })
      let outcome
      try {
        outcome = await waitForRun(run.result, { signal, timeoutMs: settings.delegateTimeoutMs ?? 0 })
      } finally {
        try {
          await run.dispose?.()
        } catch (error) {
          ctx.logger?.warn?.(`claude-driver: delegate child ${run.name ?? run.childId} dispose failed`, error)
        }
      }
      const text = outputText(outcome?.output)
      if (outcome?.stopReason !== 'completed') {
        throw new Error(
          `delegate: subagent ${run.name ?? run.childId} on ${routeLine(route)} stopped without a completed result (${outcome?.stopReason ?? 'unknown'})${text ? `:\n${text}` : '.'}`,
        )
      }
      return {
        provider: route.provider,
        model: route.model,
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
        name: run.name ?? run.childId,
        stop_reason: 'completed',
        output: text,
      }
    },
  }
}

/**
 * Register the `delegate` tool in the calling agent's tool view.
 * @param {object} ctx - plugin context whose fiber owns the registration.
 * @param {object} settings - driver settings.
 * @returns {Function|undefined} the exact unregister disposer, or undefined when disabled/unavailable.
 */
export function registerDelegateTool(ctx, settings = {}) {
  if (settings.delegateTool === false) return undefined
  const tools = ctx?.get?.('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx?.logger?.warn?.('claude-driver: tools service unavailable; the delegate tool is not registered')
    return undefined
  }
  try {
    const dispose = tools.register(createDelegateTool(ctx, settings))
    ctx?.logger?.info?.(
      `claude-driver: registered the "${DELEGATE_TOOL_NAME}" tool (child backend "${settings.delegateProvider ?? DEFAULT_SUBAGENT_PROVIDER}", DeepSeek-first routes)`,
    )
    return dispose
  } catch (error) {
    ctx?.logger?.warn?.('claude-driver: failed to register the delegate tool', error)
    return undefined
  }
}
