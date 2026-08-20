// Unit test for the model-picker catalog (no network, no SDK):
//   node test-model-catalog.mjs
// Checks the adapter/discovery output against the invariants dsh-llm enforces
// in listModels/resolveModelInfo/discoverModels (id echo, non-empty names,
// no duplicates, defaultEffort within the effort list).
import assert from 'node:assert/strict'
import { createClaudeCodeAdapter, createModelDiscovery, normalizeModels, normalizeEfforts } from './lib/model-catalog.js'

const settings = {
  provider: 'claude-code',
  model: 'fable',
  effort: 'high',
  models: ['fable', 'sonnet', 'opus', 'haiku'],
  efforts: ['low', 'medium', 'high', 'max'],
  displayName: 'Claude Code',
}

// --- normalizeModels ---
assert.deepEqual(normalizeModels(undefined).map((m) => m.id), ['fable', 'sonnet', 'opus', 'haiku'], 'fallback list')
assert.deepEqual(normalizeModels(['a', 'a', '', 'b']).map((m) => m.id), ['a', 'b'], 'dedupe + drop empties')
const rich = normalizeModels([{ id: 'fable', name: 'Claude Fable', contextWindow: 200000, maxTokens: 64000, description: 'flagship' }])
assert.deepEqual(rich, [{ id: 'fable', name: 'Claude Fable', description: 'flagship', contextWindow: 200000, maxTokens: 64000 }])

// --- normalizeEfforts ---
assert.equal(normalizeEfforts(false, 'high'), undefined, 'efforts:false disables reasoning')
const efforts = normalizeEfforts(['low', 'high'], 'high')
assert.deepEqual(efforts.efforts.map((e) => e.id), ['low', 'high'])
assert.equal(efforts.defaultEffort, 'high')
const forced = normalizeEfforts(['low'], 'max')
assert.ok(forced.efforts.some((e) => e.id === 'max'), 'defaultEffort is force-included')
assert.equal(forced.defaultEffort, 'max')

// --- adapter: providerInfo (dsh-llm requires id echo + non-empty name) ---
const adapter = createClaudeCodeAdapter(settings)
const info = adapter.providerInfo('claude-code')
assert.equal(info.id, 'claude-code')
assert.equal(info.name, 'Claude Code')
assert.equal(adapter.providerRetryPolicy('claude-code'), undefined)

// --- adapter: listModels (provider echo, unique non-empty ids/names) ---
const models = await adapter.listModels('claude-code')
assert.deepEqual(models.map((m) => m.id), ['fable', 'sonnet', 'opus', 'haiku'])
const seen = new Set()
for (const m of models) {
  assert.equal(m.provider, 'claude-code')
  assert.ok(typeof m.id === 'string' && m.id.length > 0 && typeof m.name === 'string' && m.name.length > 0)
  assert.ok(!seen.has(m.id))
  seen.add(m.id)
}

// --- adapter: resolveModel for a listed model ---
const fable = await adapter.resolveModel('claude-code', 'fable')
assert.equal(fable.provider, 'claude-code')
assert.equal(fable.id, 'fable')
assert.ok(fable.name.length > 0)
assert.ok(fable.reasoning !== undefined, 'reasoning metadata present')
assert.ok(fable.reasoning.efforts.length > 0)
assert.ok(fable.reasoning.efforts.some((e) => e.id === fable.reasoning.defaultEffort), 'defaultEffort within efforts')

// --- adapter: resolveModel stays advisory for unlisted ids, with reasoning ---
const unlisted = await adapter.resolveModel('claude-code', 'claude-sonnet-4-5')
assert.equal(unlisted.id, 'claude-sonnet-4-5')
assert.equal(unlisted.name, 'claude-sonnet-4-5')
assert.ok(unlisted.reasoning !== undefined, 'unlisted model still supports reasoningEffort (prepareCall must not throw)')

// --- adapter: context/maxTokens surfacing from rich config ---
const richAdapter = createClaudeCodeAdapter({ ...settings, models: [{ id: 'fable', contextWindow: 200000, maxTokens: 64000 }] })
const richFable = await richAdapter.resolveModel('claude-code', 'fable')
assert.deepEqual(richFable.context, { contextWindow: 200000 })
assert.equal(richFable.defaultMaxTokens, 64000)

// --- adapter: per-model effort overrides (③⑤ 2026-08-20) ---
{
  const perModel = createClaudeCodeAdapter({
    ...settings,
    effort: 'medium',
    efforts: ['low', 'medium', 'high', 'max'],
    models: [
      { id: 'fable', efforts: ['medium', 'high', 'max'], defaultEffort: 'max' }, // full override
      { id: 'opus', effort: 'high' },                                            // default level only
      { id: 'haiku', efforts: false },                                           // reasoning off for this model
      'sonnet',                                                                   // no per-model config
    ],
  })
  // normalizeModels passes the fields through
  const norm = normalizeModels([{ id: 'fable', efforts: ['high'], effort: 'high', defaultEffort: 'max' }])
  assert.deepEqual(norm[0].efforts, ['high'], 'efforts passed through')
  assert.equal(norm[0].effort, 'high', 'effort passed through')
  assert.equal(norm[0].defaultEffort, 'max', 'defaultEffort passed through')

  const pmFable = await perModel.resolveModel('claude-code', 'fable')
  assert.deepEqual(pmFable.reasoning.efforts.map((e) => e.id), ['medium', 'high', 'max'], 'per-model efforts vocabulary')
  assert.equal(pmFable.reasoning.defaultEffort, 'max', 'per-model defaultEffort wins')

  const pmOpus = await perModel.resolveModel('claude-code', 'opus')
  assert.equal(pmOpus.reasoning.defaultEffort, 'high', 'effort field sets the per-model default')
  assert.ok(pmOpus.reasoning.efforts.some((e) => e.id === 'high'), 'defaultEffort within efforts (dsh-llm invariant)')

  const pmHaiku = await perModel.resolveModel('claude-code', 'haiku')
  assert.equal(pmHaiku.reasoning, undefined, 'efforts:false disables reasoning per model')

  const pmSonnet = await perModel.resolveModel('claude-code', 'sonnet')
  assert.equal(pmSonnet.reasoning.defaultEffort, 'medium', 'unconfigured model falls back to global effort')
  assert.deepEqual(pmSonnet.reasoning.efforts.map((e) => e.id), ['low', 'medium', 'high', 'max'], 'global efforts fallback')

  const pmUnlisted = await perModel.resolveModel('claude-code', 'claude-x')
  assert.equal(pmUnlisted.reasoning.defaultEffort, 'medium', 'unlisted model uses global reasoning')

  // force-include invariant survives a per-model default outside its list
  const forcedPm = createClaudeCodeAdapter({ ...settings, models: [{ id: 'fable', efforts: ['low'], defaultEffort: 'max' }] })
  const pmForced = await forcedPm.resolveModel('claude-code', 'fable')
  assert.ok(pmForced.reasoning.efforts.some((e) => e.id === 'max'), 'per-model defaultEffort force-included')
  assert.equal(pmForced.reasoning.defaultEffort, 'max')

  // discovery output stays in the LlmDiscoveredModel shape (no effort leakage)
  const pmDiscovered = await createModelDiscovery({ models: [{ id: 'fable', effort: 'max', efforts: ['max'] }] })({})
  for (const key of Object.keys(pmDiscovered[0])) assert.ok(['id', 'name', 'contextWindow', 'maxTokens'].includes(key), `discovery key ${key}`)
}

// --- adapter: dead-man stream yields exactly one terminal error chunk ---
const chunks = []
for await (const chunk of adapter.stream({ provider: 'claude-code', model: 'fable' })) chunks.push(chunk)
assert.equal(chunks.length, 1)
assert.equal(chunks[0].type, 'finish')
assert.equal(chunks[0].reason.kind, 'error')

// --- discovery: LlmDiscoveredModel shape, endpoint-free ---
const discover = createModelDiscovery(settings)
const discovered = await discover({ provider: 'claude-code' })
assert.deepEqual(discovered.map((m) => m.id), ['fable', 'sonnet', 'opus', 'haiku'])
for (const m of discovered) {
  assert.ok(typeof m.id === 'string' && m.id.length > 0)
  for (const key of Object.keys(m)) assert.ok(['id', 'name', 'contextWindow', 'maxTokens'].includes(key), `unexpected key ${key}`)
}

// --- apply() wiring: adapter + discovery land on the llm service (mock host) ---
const { apply } = await import('./lib/index.js')
const registered = { adapters: [], discoveries: [], listeners: [] }
const mockLlm = {
  listProviders: () => [],
  registerAdapter: (providers, a) => registered.adapters.push({ providers, adapter: a }),
  registerModelDiscovery: (ns, d) => registered.discoveries.push({ ns, discover: d }),
}
const mockCtx = {
  on: (event, fn) => registered.listeners.push(event),
  get: (name) => (name === 'llm' ? mockLlm : undefined),
  logger: { info: () => {}, warn: () => {} },
}
apply(mockCtx, { model: 'fable' })
assert.ok(registered.listeners.includes('llm/stream'), 'llm/stream takeover listener installed')
assert.equal(registered.adapters.length, 1)
assert.deepEqual(registered.adapters[0].providers, ['claude-code'])
assert.equal((await registered.adapters[0].adapter.listModels('claude-code')).length, 4)
assert.equal(registered.discoveries[0].ns, 'claude-driver')
assert.equal((await registered.discoveries[0].discover({ provider: 'claude-code' })).length, 4)

// registerCatalog:false keeps the route stream-only (no picker registration)
const off = { adapters: [], discoveries: [] }
apply({
  on: () => {},
  get: (name) => (name === 'llm' ? { listProviders: () => [], registerAdapter: (p, a) => off.adapters.push(p), registerModelDiscovery: (ns) => off.discoveries.push(ns) } : undefined),
  logger: { info: () => {}, warn: () => {} },
}, { registerCatalog: false })
assert.equal(off.adapters.length, 0)
assert.equal(off.discoveries.length, 0)

console.log('test-model-catalog: all assertions passed')
