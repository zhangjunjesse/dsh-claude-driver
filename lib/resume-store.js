/**
 * Persisted DSH-session → Claude-Code-session mapping for the resume chain.
 *
 * A restart restores the existing Claude session and sends only the new tail,
 * avoiding a fresh full-history replay as a cold cache prefix. Current Claude
 * Code resumes by session id across working directories, so only a provider
 * change makes an entry unusable. Established ids are never silently pruned.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const RESUME_STORE_FILE = 'resume.json'
/** Legacy export used by compatibility tests; it is not an eviction limit. */
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

/** Current Claude Code resumes an id across working directories on the same machine. */
export function isResumeEntryUsable(entry, { provider, cwd } = {}) {
  return isResumeEntryShape(entry) && entry.provider === provider && typeof cwd === 'string' && cwd.length > 0
}

/**
 * Read/write the mapping file. `failure()` distinguishes a corrupt/unreadable
 * store from a missing one so the driver can fail closed instead of replacing
 * an established Claude session after a restart.
 */
export function createResumeStore({ file = resumeStorePath(), fs = { readFileSync, writeFileSync, renameSync, mkdirSync }, now = Date.now } = {}) {
  let entries
  let loadFailure
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
      loadFailure = undefined
    } catch (error) {
      loadFailure = error?.code === 'ENOENT' ? undefined : error
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
      loadFailure = undefined
      return true
    } catch (error) {
      loadFailure = error
      return false
    }
  }
  return {
    file,
    all() {
      return { ...load() }
    },
    get(sessionId) {
      return typeof sessionId === 'string' && sessionId ? load()[sessionId] : undefined
    },
    failure() {
      load()
      return loadFailure
    },
    set(sessionId, entry) {
      if (typeof sessionId !== 'string' || !sessionId || !isResumeEntryShape(entry)) return false
      return persist({ ...load(), [sessionId]: entry })
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

/** Restore one session's Claude id into an in-memory map after a host restart. */
export function hydrateResume({ sessionId, sessions, store, provider, cwd } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (!(sessions instanceof Map) || sessions.has(sessionId)) return false
  if (store === undefined || typeof store.get !== 'function') return false
  const entry = store.get(sessionId)
  if (!isResumeEntryUsable(entry, { provider, cwd })) return false
  sessions.set(sessionId, entry.claudeSessionId)
  return true
}
