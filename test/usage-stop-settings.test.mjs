// The 5-hour usage stop keeps its three knobs outside the profile patch so the
// Plugins page can change them without editing YAML: stop threshold, compact the
// live Claude session, and end that Claude session afterwards. The store is a
// small JSON file; the route is what the Plugins page talks to.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createStopSettingsStore,
  normalizeStopSettings,
  registerStopSettingsRoute,
  STOP_DEFAULTS,
  STOP_SETTINGS_ROUTE,
  stopSettingsPath,
  validateStopPatch,
} from '../lib/stop-settings.js'

/** In-memory stand-in for the four node:fs calls the store uses. */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const dirs = []
  const fs = {
    files,
    dirs,
    readFileSync(path) {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return files.get(path)
    },
    writeFileSync(path, text) {
      files.set(path, text)
    },
    renameSync(from, to) {
      files.set(to, files.get(from))
      files.delete(from)
    },
    mkdirSync(path) {
      dirs.push(path)
    },
  }
  return fs
}

const warnings = () => {
  const lines = []
  return { lines, warn: (message) => lines.push(message) }
}

test('the store starts with no overrides so the YAML config still decides', () => {
  const store = createStopSettingsStore({ file: '/store/usage-stop.json', fs: memoryFs() })
  assert.deepEqual(store.get(), {})
  assert.deepEqual(store.effective({}), { ...STOP_DEFAULTS })
  assert.deepEqual(store.effective({ usageStopPercent: 80, usageStopCompaction: false }), {
    usageStopPercent: 80,
    usageStopCompaction: false,
    usageStopEndSession: true,
  })
})

test('a saved override wins over the YAML value, and it survives a reload', () => {
  const fs = memoryFs()
  const file = '/store/usage-stop.json'
  const store = createStopSettingsStore({ file, fs })
  store.update({ usageStopPercent: 60, usageStopEndSession: false })
  assert.deepEqual(store.get(), { usageStopPercent: 60, usageStopEndSession: false })
  assert.deepEqual(JSON.parse(fs.files.get(file)), { usageStopPercent: 60, usageStopEndSession: false })
  assert.deepEqual(fs.dirs, ['/store'], 'the storage directory is created before the write')
  assert.deepEqual(store.effective({ usageStopPercent: 80 }), { usageStopPercent: 60, usageStopCompaction: true, usageStopEndSession: false })
  const reloaded = createStopSettingsStore({ file, fs })
  assert.deepEqual(reloaded.get(), { usageStopPercent: 60, usageStopEndSession: false })
})

test('a corrupt settings file is ignored and reported, never fatal', () => {
  const logger = warnings()
  const store = createStopSettingsStore({ file: '/store/usage-stop.json', fs: memoryFs({ '/store/usage-stop.json': '{not json' }), logger })
  assert.deepEqual(store.get(), {})
  assert.equal(logger.lines.length, 1)
  assert.match(logger.lines[0], /usage-stop\.json/)
})

test('only usable values are stored: false disables the stop, junk is dropped', () => {
  assert.deepEqual(normalizeStopSettings({ usageStopPercent: 95, usageStopCompaction: false, usageStopEndSession: true }), {
    usageStopPercent: 95,
    usageStopCompaction: false,
    usageStopEndSession: true,
  })
  assert.deepEqual(normalizeStopSettings({ usageStopPercent: false }), { usageStopPercent: false })
  for (const percent of [0, -1, 101, Number.NaN, '95', null, undefined]) {
    assert.deepEqual(normalizeStopSettings({ usageStopPercent: percent }), {}, `${String(percent)} is not a threshold`)
  }
  assert.deepEqual(normalizeStopSettings({ usageStopEndSession: 'yes' }), {})
  assert.deepEqual(normalizeStopSettings(null), {})
})

test('the route patch accepts a full settings object and rejects anything unusable', () => {
  assert.deepEqual(validateStopPatch({ usageStopPercent: 90, usageStopCompaction: true, usageStopEndSession: false }), {
    ok: true,
    value: { usageStopPercent: 90, usageStopCompaction: true, usageStopEndSession: false },
  })
  assert.deepEqual(validateStopPatch({ usageStopPercent: false }).value, { usageStopPercent: false })
  for (const bad of [0, 101, '95', null]) {
    const result = validateStopPatch({ usageStopPercent: bad })
    assert.equal(result.ok, false, `${String(bad)} must be refused`)
    assert.match(result.error, /usageStopPercent/)
  }
  assert.equal(validateStopPatch({ usageStopEndSession: 'off' }).ok, false)
  assert.equal(validateStopPatch({}).ok, false, 'an empty patch is not a save')
  assert.equal(validateStopPatch(null).ok, false)
  assert.equal(validateStopPatch([]).ok, false)
})

/** Register the route through a minimal host shaped like webServer's. */
function register(options) {
  let route
  const ctx = {
    inject: (_names, fn) => fn({ effect: (body) => body(), get: () => ({ register: (value) => (route = value) }) }),
  }
  registerStopSettingsRoute(ctx, options)
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, STOP_SETTINGS_ROUTE)
  return route
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name] = value
    },
    end(text) {
      res.body = text
    },
  }
  return res
}

async function call(route, method, body) {
  const req = { method, url: STOP_SETTINGS_ROUTE }
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    }
  }
  const res = fakeRes()
  await route.handler(req, res)
  return { res, json: res.body ? JSON.parse(res.body) : null }
}

test('GET serves the effective settings and the native-compaction capability', async () => {
  const store = createStopSettingsStore({ file: '/store/usage-stop.json', fs: memoryFs() })
  const route = register({
    store,
    effective: () => store.effective({ usageStopPercent: 80 }),
    capabilities: () => ({ nativeCompaction: true, resumeChain: true }),
  })
  const { res, json } = await call(route, 'GET')
  assert.equal(res.statusCode, 200)
  assert.equal(json.settings.usageStopPercent, 80)
  assert.equal(json.settings.usageStopCompaction, true)
  assert.equal(json.settings.usageStopEndSession, true)
  assert.deepEqual(json.capabilities, { nativeCompaction: true, resumeChain: true })
})

test('POST validates, persists, applies, and answers the new effective settings', async () => {
  const store = createStopSettingsStore({ file: '/store/usage-stop.json', fs: memoryFs() })
  const synced = []
  const route = register({
    store,
    effective: () => store.effective({}),
    capabilities: () => ({ nativeCompaction: true, resumeChain: true }),
    sync: (settings) => synced.push(settings),
  })
  const { res, json } = await call(route, 'POST', { usageStopPercent: 90, usageStopCompaction: true, usageStopEndSession: true })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(store.get(), { usageStopPercent: 90, usageStopCompaction: true, usageStopEndSession: true })
  assert.deepEqual(json.settings, { usageStopPercent: 90, usageStopCompaction: true, usageStopEndSession: true })
  assert.deepEqual(synced, [json.settings], 'the live driver settings are updated with the saved value')
})

test('POST refuses bad input without touching the store', async () => {
  const fs = memoryFs()
  const store = createStopSettingsStore({ file: '/store/usage-stop.json', fs })
  const route = register({ store, effective: () => store.effective({}), capabilities: () => ({}) })
  for (const body of [{ usageStopPercent: 101 }, { usageStopEndSession: 'no' }, { oops: 1 }, '{bad json']) {
    const { res, json } = await call(route, 'POST', body)
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be refused`)
    assert.ok(json.error)
  }
  assert.equal(fs.files.size, 0, 'nothing was persisted')
})

test('the route answers 405 for other methods', async () => {
  const store = createStopSettingsStore({ file: '/store/usage-stop.json', fs: memoryFs() })
  const route = register({ store, effective: () => store.effective({}), capabilities: () => ({}) })
  const { res } = await call(route, 'DELETE')
  assert.equal(res.statusCode, 405)
})

test('the path lives under the plugin storage directory', () => {
  assert.equal(stopSettingsPath({ dshHome: '/home/u/.dsh' }), '/home/u/.dsh/storages/claude-driver/usage-stop.json')
})
