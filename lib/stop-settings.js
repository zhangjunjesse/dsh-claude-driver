// Settings for the 5-hour usage stop, persisted outside the profile patch so the
// Plugins page can change them at runtime: the threshold, whether the live Claude
// session is compacted with Claude's own `/compact`, and whether that Claude
// session is ended afterwards (the next turn then starts a fresh one over DSH's
// compacted history).
//
// Precedence: this file (edited on the Plugins page) > the YAML config > defaults.
// The file is only written when something is saved; a deployment that never opens
// the page keeps using its YAML values.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_CONTEXT_COMPACT_TOKENS, MIN_CONTEXT_COMPACT_TOKENS } from './context-autocompact.js'

export const STOP_SETTINGS_ROUTE = '/claude-usage-stop.json'
export const STOP_SETTINGS_FILE = 'usage-stop.json'
const MAX_BODY_BYTES = 8 * 1024

export const STOP_DEFAULTS = Object.freeze({
  usageStopPercent: 95,
  weeklyStopPercent: 98,
  usageStopCompaction: true,
  usageStopEndSession: true,
  compactAtTokens: 0,
})

/** `$DSH_HOME/storages/claude-driver` — the same state directory deps/harvest use. */
export function stopSettingsDir({ dshHome = process.env.DSH_HOME, homeDir = homedir() } = {}) {
  return join(dshHome ?? join(homeDir, '.dsh'), 'storages', 'claude-driver')
}

/** Absolute path of the usage-stop settings file. */
export function stopSettingsPath(opts = {}) {
  return join(stopSettingsDir(opts), STOP_SETTINGS_FILE)
}

/**
 * Keep only the fields the stop understands: a 1-100 threshold (or false to
 * disable it), and two booleans. Anything else is dropped, never coerced.
 */
export function normalizeStopSettings(raw) {
  const value = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return value
  for (const key of ['usageStopPercent', 'weeklyStopPercent']) {
    const percent = raw[key]
    if (percent === false) value[key] = false
    else if (typeof percent === 'number' && Number.isFinite(percent) && percent > 0 && percent <= 100) value[key] = percent
  }
  if (typeof raw.usageStopCompaction === 'boolean') value.usageStopCompaction = raw.usageStopCompaction
  if (typeof raw.usageStopEndSession === 'boolean') value.usageStopEndSession = raw.usageStopEndSession
  const tokens = raw.compactAtTokens
  // 0 turns the option off; any other value must be a usable threshold.
  if (typeof tokens === 'number' && Number.isFinite(tokens) && (tokens === 0 || (tokens >= MIN_CONTEXT_COMPACT_TOKENS && tokens <= MAX_CONTEXT_COMPACT_TOKENS))) {
    value.compactAtTokens = Math.floor(tokens)
  }
  return value
}

/**
 * Validate one wire patch before it is stored. Unlike normalize, a bad field is
 * reported: the Plugins page must not silently save something different.
 * @param patch - parsed JSON body.
 * @returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function validateStopPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'expected a JSON object with usage-stop settings' }
  }
  const value = {}
  for (const key of ['usageStopPercent', 'weeklyStopPercent']) {
    if (!(key in patch)) continue
    const percent = patch[key]
    if (percent === false) value[key] = false
    else if (typeof percent === 'number' && Number.isFinite(percent) && percent > 0 && percent <= 100) value[key] = percent
    else return { ok: false, error: `${key} must be a number from 1 to 100, or false to disable that window` }
  }
  if ('compactAtTokens' in patch) {
    const tokens = patch.compactAtTokens
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens === 0) value.compactAtTokens = 0
    else if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= MIN_CONTEXT_COMPACT_TOKENS && tokens <= MAX_CONTEXT_COMPACT_TOKENS) {
      value.compactAtTokens = Math.floor(tokens)
    } else {
      return { ok: false, error: `compactAtTokens must be 0 (off) or ${MIN_CONTEXT_COMPACT_TOKENS} to ${MAX_CONTEXT_COMPACT_TOKENS}` }
    }
  }
  for (const key of ['usageStopCompaction', 'usageStopEndSession']) {
    if (!(key in patch)) continue
    if (typeof patch[key] !== 'boolean') return { ok: false, error: `${key} must be true or false` }
    value[key] = patch[key]
  }
  if (Object.keys(value).length === 0) return { ok: false, error: 'no usage-stop setting was supplied' }
  return { ok: true, value }
}

/**
 * The stored override plus the values it falls back to.
 * @param file - settings file path.
 * @param fs - node:fs-compatible seam for tests.
 * @param logger - optional host logger for a corrupt file.
 */
export function createStopSettingsStore({ file = stopSettingsPath(), fs = { readFileSync, writeFileSync, renameSync, mkdirSync }, logger } = {}) {
  let overrides = {}
  const load = () => {
    try {
      overrides = normalizeStopSettings(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.(`claude-driver: ignoring the unreadable usage-stop settings at ${file}: ${String(error?.message ?? error)}`)
      overrides = {}
    }
    return overrides
  }
  load()
  return {
    path: file,
    /** The saved overrides only. */
    get: () => ({ ...overrides }),
    reload: load,
    /** Defaults < YAML config < saved overrides. */
    effective: (base = {}) => ({ ...STOP_DEFAULTS, ...normalizeStopSettings(base), ...overrides }),
    /** Merge one validated patch, persist it atomically, and return the overrides. */
    update(patch) {
      const next = { ...overrides, ...normalizeStopSettings(patch) }
      fs.mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      fs.renameSync(temporary, file)
      overrides = next
      return { ...overrides }
    },
  }
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('the request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function handleStopSettings(req, res, { store, effective, capabilities, sync }) {
  try {
    if (req.method === 'GET') {
      return json(res, 200, { now: Date.now(), settings: effective(), capabilities: capabilities() })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    let patch
    try {
      const text = await readBody(req)
      patch = text.trim() ? JSON.parse(text) : {}
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    const result = validateStopPatch(patch)
    if (!result.ok) return json(res, 400, { error: result.error })
    store.update(result.value)
    const settings = effective()
    sync?.(settings)
    return json(res, 200, { settings, capabilities: capabilities() })
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Serve the usage-stop settings to the Plugins page. `capabilities` says whether
 * Claude's native compaction path is actually available in this deployment.
 */
export function registerStopSettingsRoute(ctx, options) {
  ctx.inject(['webServer'], (webCtx) =>
    webCtx.effect(() =>
      webCtx.get('webServer').register({
        kind: 'exact',
        path: STOP_SETTINGS_ROUTE,
        handler: (req, res) => handleStopSettings(req, res, options),
      }),
    ),
  )
}
