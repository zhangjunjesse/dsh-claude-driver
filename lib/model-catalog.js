// Model-selector visibility for the `claude-code` route.
//
// The session model picker (dsh-client-ui-model-selection -> session.models RPC
// -> dsh-host-apiproxy buildModelCatalog) is built from ctx.llm.listProviders(),
// i.e. ONLY provider routes with a registered adapter. The configurable-provider
// directory (registerConfigurableProviders) feeds the Models settings page and
// the exposed-settings allowlist, not the session picker. So to make the
// claude-code route selectable we register a minimal *catalog* adapter:
//   - providerInfo/listModels/resolveModel serve the catalog;
//   - stream() is a dead-man fallback that never runs in practice, because
//     llm.stream()/prepareCall().stream() always route through the `llm/stream`
//     waterfall FIRST, where this plugin's listener short-circuits the call
//     into the Claude Agent SDK before the adapter is consulted.
//
// Auto-discovery: when `autoDiscoverModels` is on (default), the catalog is a
// UNION of the configured/stable model list and Claude's own `supportedModels()`
// list. Stable aliases (fable/sonnet/opus/haiku) come first so the driver's
// default model selection keeps resolving (and carries contextWindow for
// compaction); discovery only ADD models not already represented, so new
// families/versions appear without editing the plugin or config. On any
// discovery failure it falls back to the configured `settings.models`. Set
// `autoDiscoverModels: false` (or provide a `settings.models` override) to keep
// a hand-curated list. contextWindow is parsed from the resolvedModel's `[...]`
// marker, else looked up in a known map, else omitted (compaction stays off for
// that model; the model is still usable).

const DEFAULT_MODELS = ['fable', 'sonnet', 'opus', 'haiku']
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'max']

const EFFORT_NAMES = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

// Known canonical model -> context window, used to supplement discovery when the
// resolvedModel id carries no explicit `[...]` marker (e.g. `claude-fable-5`).
const KNOWN_CONTEXT_WINDOW = {
  'claude-fable-5': 1_000_000,
  'claude-sonnet-5': 967_000,
  'claude-opus-5': 1_000_000,
  'claude-haiku-5': 200_000,
}

// Parse a context-window suffix like `claude-opus-5[1m]`/`[...200k]` -> tokens.
export function parseContextWindow(resolvedModel) {
  const m = /\[(\d+)(k|m)\]/.exec(String(resolvedModel ?? ''))
  if (!m) return undefined
  const n = Number(m[1]) * (m[2] === 'm' ? 1_000_000 : 1_000)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// Map one SDK `ModelInfo` -> a catalog entry. `value` is the model id to pass to
// the SDK; displayName has priority for the picker label.
export function modelInfoToEntry(info) {
  const value = typeof info?.value === 'string' && info.value ? info.value : null
  if (!value) return undefined
  const resolved = typeof info?.resolvedModel === 'string' && info.resolvedModel ? info.resolvedModel : value
  const contextWindow =
    parseContextWindow(resolved) ?? KNOWN_CONTEXT_WINDOW[resolved] ?? KNOWN_CONTEXT_WINDOW[value]
  return {
    id: value,
    name: typeof info?.displayName === 'string' && info.displayName ? info.displayName : value,
    ...(typeof info?.description === 'string' && info.description ? { description: info.description } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(Array.isArray(info?.supportedEffortLevels) && info.supportedEffortLevels.length
      ? { efforts: info.supportedEffortLevels }
      : {}),
  }
}

// The effective catalog: a UNION of the configured/stable model list and the
// SDK's discovered list. Stable aliases (fable/sonnet/opus/haiku) come first —
// they are the driver's default model ids and carry the contextWindow (compaction)
// — and discovery only ADDS models not already represented. This keeps the
// default `model: fable` selection resolvable even when supportedModels() returns
// versioned variant ids (e.g. `claude-fable-5[1m]`), while still surfacing new
// models automatically. Discovered list is cached externally by callers.
export async function resolveModelList(settings, discover) {
  const configList = normalizeModels(settings.models)
  let discovered = []
  if (typeof discover === 'function') {
    try {
      const infos = await discover()
      discovered = (infos ?? []).map(modelInfoToEntry).filter(Boolean)
    } catch {
      // discovery unavailable/failed — keep the configured list
    }
  }
  if (discovered.length === 0) return configList
  const seen = new Set()
  const union = []
  const push = (entry) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) return
    seen.add(entry.id)
    union.push(entry)
  }
  for (const entry of configList) push(entry)
  for (const entry of discovered) push(entry)
  return union
}

/**
 * Normalize the configured model list. Entries may be plain id strings or
 * objects { id, name?, description?, contextWindow?, maxTokens?, effort?,
 * efforts?, defaultEffort? }. The per-model effort fields pass through
 * verbatim (resolveModel normalizes them later, same as the global pair).
 * Invalid or duplicate entries are dropped; an empty/absent config falls back
 * to the default Claude Code aliases.
 */
export function normalizeModels(models, fallback = DEFAULT_MODELS) {
  const source = Array.isArray(models) && models.length > 0 ? models : fallback
  const seen = new Set()
  const out = []
  for (const entry of source) {
    const raw = typeof entry === 'string' ? { id: entry } : entry
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0 || seen.has(raw.id)) continue
    seen.add(raw.id)
    out.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.id,
      ...(typeof raw.description === 'string' && raw.description.length > 0 ? { description: raw.description } : {}),
      ...(Number.isInteger(raw.contextWindow) && raw.contextWindow > 0 ? { contextWindow: raw.contextWindow } : {}),
      ...(Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0 ? { maxTokens: raw.maxTokens } : {}),
      // Per-model reasoning-effort config: efforts may be an array (vocabulary)
      // or false (reasoning off for this model); effort/defaultEffort pick the
      // model's default level (defaultEffort wins when both are set).
      ...(Array.isArray(raw.efforts) || raw.efforts === false ? { efforts: raw.efforts } : {}),
      ...(typeof raw.effort === 'string' && raw.effort.length > 0 ? { effort: raw.effort } : {}),
      ...(typeof raw.defaultEffort === 'string' && raw.defaultEffort.length > 0 ? { defaultEffort: raw.defaultEffort } : {}),
    })
  }
  return out
}

/**
 * Normalize the reasoning-effort vocabulary. The default effort (the driver's
 * `effort` setting, forwarded to the SDK) is force-included so resolveModel
 * never advertises a defaultEffort outside its own effort list — dsh-llm
 * validates exactly that and would fail the whole provider group otherwise.
 * Returns undefined when reasoning superficially disabled (efforts: false).
 */
export function normalizeEfforts(efforts, defaultEffort) {
  if (efforts === false) return undefined
  const source = Array.isArray(efforts) && efforts.length > 0 ? efforts : DEFAULT_EFFORTS
  const seen = new Set()
  const list = []
  const push = (raw) => {
    const entry = typeof raw === 'string' ? { id: raw } : raw
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id)) return
    seen.add(entry.id)
    list.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : EFFORT_NAMES[entry.id] ?? entry.id,
      ...(typeof entry.description === 'string' && entry.description.length > 0 ? { description: entry.description } : {}),
    })
  }
  for (const raw of source) push(raw)
  if (typeof defaultEffort === 'string' && defaultEffort.length > 0 && !seen.has(defaultEffort)) push(defaultEffort)
  if (list.length === 0) return undefined
  return {
    efforts: list,
    ...(typeof defaultEffort === 'string' && defaultEffort.length > 0 ? { defaultEffort } : {}),
  }
}

/**
 * The catalog adapter registered for the claude-code route. `discover` is an
 * optional async () => ModelInfo[] injected by the driver (query.supportedModels),
 * used to auto-populate the catalog. It is advisory metadata from the SDK; its
 * stream() is unreachable while the plugin's `llm/stream` listener is installed.
 *
 * DSH 2.0.2 (dsh-llm LlmAdapter) additionally requires
 * `prepareCall(provider, model, signal)` — llm.prepareCall (index.js:1498) and
 * llm.adapterStream (:1568) call it instead of resolveModel, and feed the
 * returned `adapterCall.model` to normalizeModelInfo (:1499) and dispatch
 * through `adapterCall.stream(options)` (:1522/:1571). We mirror the base-class
 * default (:1126-1131): { model: resolveModel(...), stream: () => stream(...) }.
 */
export function createClaudeCodeAdapter(settings, discover) {
  const reasoning = () => normalizeEfforts(settings.efforts, settings.effort)
  // Lazy, memoized catalog: discovery runs once (first picker/resolve), cached.
  let catalogPromise
  const catalog = () => {
    if (!catalogPromise) catalogPromise = resolveModelList(settings, discover)
    return catalogPromise
  }
  // Dead-man fallback shared by stream() and prepareCall().stream: yields one
  // terminal error chunk if the takeover listener is ever missing.
  async function* deadManStream(options) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `dsh-claude-driver: the llm/stream takeover listener is not active for provider "${options?.provider ?? settings.provider}" — the catalog adapter cannot stream; reload the claude-driver plugin`,
          code: 'CLAUDE_CODE_ERROR',
        },
      },
    }
  }
  // Advisory exact-model lookup shared by resolveModel and prepareCall.
  const resolveModelInfo = async (provider, model) => {
    const list = await catalog()
    const hit = list.find((entry) => entry.id === model)
    const hasPerModelEffort =
      hit !== undefined && (hit.efforts !== undefined || hit.effort !== undefined || hit.defaultEffort !== undefined)
    const efforts = hasPerModelEffort
      ? normalizeEfforts(hit.efforts, hit.defaultEffort ?? hit.effort ?? settings.effort)
      : reasoning()
    return Promise.resolve({
      provider,
      id: model,
      name: hit?.name ?? model,
      ...(hit?.description !== undefined ? { description: hit.description } : {}),
      ...(hit?.contextWindow !== undefined ? { context: { contextWindow: hit.contextWindow } } : {}),
      ...(hit?.maxTokens !== undefined ? { defaultMaxTokens: hit.maxTokens } : {}),
      ...(efforts !== undefined ? { reasoning: efforts } : {}),
    })
  }
  return {
    providerInfo(provider) {
      return {
        id: provider,
        name: typeof settings.displayName === 'string' && settings.displayName.length > 0 ? settings.displayName : 'Claude Code',
      }
    },
    providerRetryPolicy() {
      return undefined
    },
    async listModels(provider) {
      const list = await catalog()
      return list.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description !== undefined ? { description: model.description } : {}),
      }))
    },
    // Advisory catalog: unlisted ids stay resolvable (dsh-llm requires that
    // absence never rejects a request), and reasoning metadata is ALWAYS
    // attached — a stored selection carrying reasoningEffort would otherwise
    // make prepareCall throw UNSUPPORTED_REASONING_EFFORT and kill the turn.
    resolveModel(provider, model) {
      return resolveModelInfo(provider, model)
    },
    stream(options) {
      return deadManStream(options)
    },
    async prepareCall(provider, model, _signal) {
      return {
        model: await resolveModelInfo(provider, model),
        stream: (options) => deadManStream(options),
      }
    },
  }
}

/**
 * Model discovery for llm.discoverModels(settingsNs, ...) (Models settings
 * page "fetch models" flow). Builds the same auto-discovered/configured list in
 * the LlmDiscoveredModel shape ({ id, name?, contextWindow?, maxTokens? }).
 */
export function createModelDiscovery(settings, discover) {
  return (_request) =>
    resolveModelList(settings, discover).then((list) =>
      list.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      })),
    )
}
