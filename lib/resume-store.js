/**
 * Persisted DSH-session → Claude-Code-session mapping for the resume chain.
 *
 * The in-memory map dies with the host process, and then the next turn boots a
 * NEW Claude session and replays the whole rendered DSH history as one prompt:
 * a cold cache prefix, so every prompt token is billed as a cache write (1.25×)
 * instead of a cache read. Measured on session-25fc87b6: 355,389 cache-write
 * tokens in one request after a restart. Keeping the mapping on disk means a
 * restart resumes the same Claude session and sends only the new tail.
 *
 * An entry is only used when the session still routes to the same provider and
 * the same working directory; compaction and `/claude-fresh` drop it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const RESUME_STORE_FILE = 'resume.json'
/** Newest entries kept; older sessions are pruned on write. */
export const MAX_RESUME_ENTRIES = 100
const STORE_VERSION = 1

/** `$DSH_HOME/storages/claude-driver` — the same state directory deps/harvest use. */
export function resumeStoreDir({ dshHome = process.env.DSH_HOME, homeDir = homedir() } = {}) {
  return join(dshHome ?? join(homeDir, '.dsh'), 'storages', 'claude-driver')
}

/** Absolute path of the resume mapping file. */
export function resumeStorePath(opts = {}) {
  return join(resumeStoreDir(opts), RESUME_STORE_FILE)
}

/** Shape check for one stored entry (no route comparison). */
export function isResumeEntryShape(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (typeof entry.claudeSessionId !== 'string' || entry.claudeSessionId.length === 0) return false
  if (typeof entry.provider !== 'string' || entry.provider.length === 0) return false
  if (typeof entry.cwd !== 'string' || entry.cwd.length === 0) return false
  if (typeof entry.savedAt !== 'number' || !Number.isFinite(entry.savedAt)) return false
  return true
}

/**
 * Whether a stored entry may resume the session now: same provider route and
 * same working directory (Claude's session is bound to both).
 * @param entry - stored mapping, possibly absent.
 * @param route - `{ provider, cwd }` of the run about to start.
 * @returns whether the entry is safe to resume.
 */
export function isResumeEntryUsable(entry, { provider, cwd } = {}) {
  return isResumeEntryShape(entry) && entry.provider === provider && entry.cwd === cwd && typeof cwd === 'string' && cwd.length > 0
}

/**
 * Read/write the mapping file. Every failure is reported, never thrown: a
 * broken store may cost one cold replay, but it must not damage a turn.
 * @param options - file path, fs seam, clock.
 * @returns `{ file, all, get, set, remove, clear }`.
 */
export function createResumeStore({ file = resumeStorePath(), fs = { readFileSync, writeFileSync, renameSync, mkdirSync }, now = Date.now } = {}) {
  let entries
  const load = () => {
    if (entries !== undefined) return entries
    entries = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const sessions = parsed?.sessions
      if (sessions !== undefined && sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions)) {
        for (const [sessionId, entry] of Object.entries(sessions)) {
          if (typeof sessionId === 'string' && sessionId.length > 0 && isResumeEntryShape(entry)) entries[sessionId] = entry
        }
      }
    } catch {
      // absent, unreadable or corrupt reads as empty
    }
    return entries
  }
  const persist = (next) => {
    try {
      fs.mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${now()}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify({ version: STORE_VERSION, sessions: next }, null, 2)}\n`, 'utf8')
      fs.renameSync(temporary, file)
      entries = next
      return true
    } catch {
      return false
    }
  }
  // Bound the file: an unbounded history of abandoned sessions would grow with
  // every session the user ever ran.
  const prune = (next) => {
    const ids = Object.keys(next)
    if (ids.length <= MAX_RESUME_ENTRIES) return next
    ids.sort((left, right) => next[right].savedAt - next[left].savedAt)
    const kept = {}
    for (const id of ids.slice(0, MAX_RESUME_ENTRIES)) kept[id] = next[id]
    return kept
  }
  return {
    file,
    all() {
      return { ...load() }
    },
    get(sessionId) {
      return typeof sessionId === 'string' && sessionId ? load()[sessionId] : undefined
    },
    set(sessionId, entry) {
      if (typeof sessionId !== 'string' || !sessionId || !isResumeEntryShape(entry)) return false
      return persist(prune({ ...load(), [sessionId]: entry }))
    },
    remove(sessionId) {
      const current = load()
      if (typeof sessionId !== 'string' || !(sessionId in current)) return false
      const next = { ...current }
      delete next[sessionId]
      return persist(next)
    },
    clear() {
      return persist({})
    },
  }
}

/**
 * Restore one session's Claude id into an in-memory map (a restarted host).
 * @param options - session id, target map, store, current route.
 * @returns whether a mapping was restored.
 */
export function hydrateResume({ sessionId, sessions, store, provider, cwd } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (!(sessions instanceof Map) || sessions.has(sessionId)) return false
  if (store === undefined || typeof store.get !== 'function') return false
  const entry = store.get(sessionId)
  if (!isResumeEntryUsable(entry, { provider, cwd })) return false
  sessions.set(sessionId, entry.claudeSessionId)
  return true
}
