// Model-selector visibility for the `claude-code` route.
//
// The session model picker (dsh-client-ui-model-selection -> session.models RPC
// -> dsh-host-apiproxy buildModelCatalog) is built from ctx.llm.listProviders(),
// i.e. ONLY provider routes with a registered adapter. The configurable-provider
// directory (registerConfigurableProviders) feeds the Models settings page and
// the exposed-settings allowlist, not the session picker. So to make the
// claude-code route selectable we register a minimal *catalog* adapter:
//   - providerInfo/listModels/resolveModel serve the advisory catalog from the
//     plugin's own config (no remote endpoint is ever queried);
//   - stream() is a dead-man fallback that never runs in practice, because
//     llm.stream()/prepareCall().stream() always route through the `llm/stream`
//     waterfall FIRST, where this plugin's listener short-circuits the call
//     into the Claude Agent SDK before the adapter is consulted.
// Registering the adapter also makes prepareCall()/resolveCallConfig() succeed,
// which is what session.selectModel and the turn-start routeServed() guard
// require, and what persists the choice via agentDefaultModel.saveSelection.

const DEFAULT_MODELS = ['fable', 'sonnet', 'opus', 'haiku']
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'max']

const EFFORT_NAMES = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
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
 * The catalog adapter registered for the claude-code route. Purely advisory
 * metadata from plugin config; its stream() is unreachable while the plugin's
 * `llm/stream` listener is installed (the waterfall short-circuits before the
 * adapter), and yields a terminal error chunk if it ever does run.
 */
export function createClaudeCodeAdapter(settings) {
  const models = () => normalizeModels(settings.models)
  const reasoning = () => normalizeEfforts(settings.efforts, settings.effort)
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
    listModels(provider) {
      return Promise.resolve(models().map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description !== undefined ? { description: model.description } : {}),
      })))
    },
    // Advisory catalog: unlisted ids stay resolvable (dsh-llm requires that
    // absence never rejects a request), and reasoning metadata is ALWAYS
    // attached — a stored selection carrying reasoningEffort would otherwise
    // make prepareCall throw UNSUPPORTED_REASONING_EFFORT and kill the turn.
    // Per-model effort: a hit carrying any of efforts/effort/defaultEffort
    // gets its own reasoning block (normalizeEfforts keeps the
    // defaultEffort∈efforts force-include invariant); otherwise the global
    // reasoning() applies unchanged. hit.efforts === false disables reasoning
    // for that model alone.
    resolveModel(provider, model) {
      const hit = models().find((entry) => entry.id === model)
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
    },
    async *stream(options) {
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
    },
  }
}

/**
 * Model discovery for llm.discoverModels(settingsNs, ...) (Models settings
 * page "fetch models" flow). Claude Code has no listable remote endpoint from
 * here, so discovery returns the configured list verbatim in the
 * LlmDiscoveredModel shape ({ id, name?, contextWindow?, maxTokens? }).
 */
export function createModelDiscovery(settings) {
  return (_request) =>
    Promise.resolve(normalizeModels(settings.models).map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    })))
}
