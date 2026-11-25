// A DSH host restart clears the in-memory session → Claude session map, so the
// next turn boots a NEW Claude session and replays the whole rendered history
// as one cold prompt: ~355k prompt tokens became cache writes instead of cache
// reads in session-25fc87b6. The mapping is therefore persisted per DSH
// session and restored after a restart, with a strict usability check.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MAX_RESUME_ENTRIES,
  RESUME_STORE_FILE,
  createResumeStore,
  hydrateResume,
  isResumeEntryUsable,
  resumeStorePath,
} from '../lib/resume-store.js'
import {
  clearResumeOnCompaction,
  createClaudeFreshCommand,
  endClaudeSession,
  getResumeSessions,
  planPrompt,
  rememberClaudeSession,
} from '../lib/index.js'

const tempStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-resume-'))
  return { dir, file: join(dir, RESUME_STORE_FILE) }
}
const entry = (overrides = {}) => ({ claudeSessionId: 'claude-1', provider: 'claude-code', cwd: '/work', savedAt: 1_000, ...overrides })
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

test('the store lives under $DSH_HOME/storages/claude-driver', () => {
  assert.equal(resumeStorePath({ dshHome: '/dsh', homeDir: '/home/x' }), join('/dsh/storages/claude-driver', RESUME_STORE_FILE))
  assert.equal(resumeStorePath({ dshHome: undefined, homeDir: '/home/x' }), join('/home/x/.dsh/storages/claude-driver', RESUME_STORE_FILE))
})

test('entries survive a new store instance (a process restart)', () => {
  const { file } = tempStore()
  const first = createResumeStore({ file })
  assert.equal(first.get('s1'), undefined)
  assert.equal(first.set('s1', entry()), true)
  const restarted = createResumeStore({ file })
  assert.deepEqual(restarted.get('s1'), entry())
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sessions.s1.claudeSessionId, 'claude-1')
  restarted.remove('s1')
  assert.equal(createResumeStore({ file }).get('s1'), undefined)
  first.set('s2', entry({ claudeSessionId: 'claude-2' }))
  first.clear()
  assert.deepEqual(createResumeStore({ file }).all(), {})
})

test('a corrupt store is distinguishable from a missing store and never causes an implicit fresh start', () => {
  const { dir, file } = tempStore()
  const store = createResumeStore({ file })
  assert.deepEqual(store.all(), {}, 'missing file')
  assert.equal(store.failure(), undefined)
  writeFileSync(join(dir, 'garbage.json'), 'not json')
  const garbage = createResumeStore({ file: join(dir, 'garbage.json') })
  assert.deepEqual(garbage.all(), {})
  assert.match(String(garbage.failure()), /SyntaxError/)
  assert.equal(garbage.set('s1', entry()), true, 'an explicit write can replace the corrupt file')
  assert.equal(garbage.failure(), undefined)
  assert.deepEqual(createResumeStore({ file: join(dir, 'garbage.json') }).get('s1'), entry())
})

test('an unwritable store reports failure instead of throwing into the turn', () => {
  // A regular file where the store needs a directory: mkdir fails with ENOTDIR
  // for any uid, on any filesystem. (A /proc path hung CI for 100s+ instead of
  // failing, so the proof must not depend on a pseudo-filesystem.)
  const { dir } = tempStore()
  const blocker = join(dir, 'blocked')
  writeFileSync(blocker, 'not a directory')
  const store = createResumeStore({ file: join(blocker, RESUME_STORE_FILE) })
  assert.equal(store.set('s1', entry()), false)
  assert.equal(store.remove('s1'), false)
})

test('the store never silently prunes an established session id', () => {
  const { file } = tempStore()
  const store = createResumeStore({ file })
  for (let index = 0; index < MAX_RESUME_ENTRIES + 5; index += 1) store.set(`s${index}`, entry({ savedAt: index }))
  const kept = createResumeStore({ file }).all()
  assert.equal(Object.keys(kept).length, MAX_RESUME_ENTRIES + 5)
  assert.equal(kept.s0?.claudeSessionId, 'claude-1')
  assert.equal(kept[`s${MAX_RESUME_ENTRIES + 4}`]?.claudeSessionId, 'claude-1')
})

test('an entry is usable for the same provider across current Claude Code working directories', () => {
  assert.equal(isResumeEntryUsable(entry(), { provider: 'claude-code', cwd: '/work' }), true)
  assert.equal(isResumeEntryUsable(entry(), { provider: 'deepseek', cwd: '/work' }), false, 'route changed')
  assert.equal(isResumeEntryUsable(entry(), { provider: 'claude-code', cwd: '/elsewhere' }), true, 'current Claude Code resumes across directories by session id')
  for (const broken of [
    undefined,
    null,
    'claude-1',
    entry({ claudeSessionId: '' }),
    entry({ provider: undefined }),
    entry({ cwd: undefined }),
    entry({ savedAt: 'yesterday' }),
  ]) {
    assert.equal(isResumeEntryUsable(broken, { provider: 'claude-code', cwd: '/work' }), false, JSON.stringify(broken))
  }
})

test('hydration restores the mapping into a fresh in-memory session map', () => {
  const { file } = tempStore()
  const store = createResumeStore({ file })
  store.set('s1', entry())
  const sessions = new Map()
  assert.equal(hydrateResume({ sessionId: 's1', sessions, store, provider: 'claude-code', cwd: '/work' }), true)
  assert.equal(sessions.get('s1'), 'claude-1')
  assert.equal(hydrateResume({ sessionId: 's1', sessions, store, provider: 'claude-code', cwd: '/work' }), false, 'already hydrated')
  assert.equal(hydrateResume({ sessionId: 's1', sessions: new Map(), store, provider: 'claude-code', cwd: '/elsewhere' }), true, 'cwd moves preserve the same Claude session')
  assert.equal(hydrateResume({ sessionId: 's2', sessions, store, provider: 'claude-code', cwd: '/work' }), false, 'unknown session')
  assert.equal(hydrateResume({ sessionId: 's1', sessions: new Map(), store, provider: 'deepseek', cwd: '/work' }), false, 'route changed')
  assert.equal(hydrateResume({ sessionId: 's1', sessions: new Map() }), false, 'no store')
})

test('after hydration the prompt is the new tail only, not the replayed history', () => {
  const { file } = tempStore()
  const store = createResumeStore({ file })
  store.set('s1', entry())
  const sessions = new Map()
  hydrateResume({ sessionId: 's1', sessions, store, provider: 'claude-code', cwd: '/work' })
  const plan = planPrompt(
    { sessionId: 's1', messages: [user('old task'), assistant('old answer'), user('new question')] },
    { resumeChain: true },
    sessions,
  )
  assert.equal(plan.mode, 'resume')
  assert.equal(plan.resumeId, 'claude-1')
  assert.match(plan.prompt, /new question/)
  assert.ok(!plan.prompt.includes('old task'), 'the history is not resent')
})

test('remembering a session persists it; forgetting it drops the file entry', () => {
  const { file } = tempStore()
  const store = createResumeStore({ file })
  const sessions = new Map()
  assert.equal(rememberClaudeSession({ sessionId: 's1', claudeSessionId: 'claude-1', provider: 'claude-code', cwd: '/work', sessions, store }), true)
  assert.equal(sessions.get('s1'), 'claude-1')
  assert.equal(store.get('s1').cwd, '/work')
  assert.equal(rememberClaudeSession({ sessionId: '', claudeSessionId: 'x', sessions, store }), false)
  assert.equal(rememberClaudeSession({ sessionId: 's2', claudeSessionId: '', sessions, store }), false)
})

test('remembering never overwrites an established id or hides a persistence failure', () => {
  const { dir, file } = tempStore()
  const store = createResumeStore({ file })
  const sessions = new Map([['s1', 'claude-original']])
  store.set('s1', entry({ claudeSessionId: 'claude-original' }))
  assert.equal(rememberClaudeSession({ sessionId: 's1', claudeSessionId: 'claude-changed', provider: 'claude-code', cwd: '/work', sessions, store }), false)
  assert.equal(sessions.get('s1'), 'claude-original')
  assert.equal(store.get('s1')?.claudeSessionId, 'claude-original')

  const blocker = join(dir, 'blocked')
  writeFileSync(blocker, 'not a directory')
  const unwritable = createResumeStore({ file: join(blocker, RESUME_STORE_FILE) })
  assert.equal(rememberClaudeSession({ sessionId: 's1', claudeSessionId: 'claude-original', provider: 'claude-code', cwd: '/work', sessions, store: unwritable }), false)
  assert.equal(sessions.get('s1'), 'claude-original')
})

test('a compaction event preserves the persisted Claude session entry', () => {
  const { file } = tempStore()
  const store = createResumeStore({ file })
  store.set('s1', entry())
  const sessions = new Map([['s1', 'claude-1']])
  const dropped = clearResumeOnCompaction(
    { id: 's1' },
    { type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'a compaction summary' }] } },
    sessions,
    new Map(),
    store,
  )
  assert.equal(dropped, false)
  assert.equal(sessions.get('s1'), 'claude-1')
  assert.equal(store.get('s1')?.claudeSessionId, 'claude-1')
})

test('a non-compaction event and a nameless session never touch the store', () => {
  const { file } = tempStore()
  const store = createResumeStore({ file })
  store.set('s1', entry())
  const sessions = new Map([['s1', 'claude-1']])
  assert.equal(clearResumeOnCompaction({ id: 's1' }, { type: 'turn/end', data: {} }, sessions, new Map(), store), false)
  assert.equal(clearResumeOnCompaction({}, { type: 'compaction/summary', data: {} }, sessions, new Map(), store), false)
  assert.equal(store.get('s1')?.claudeSessionId, 'claude-1')
})

test('ending the Claude session and /claude-fresh clear the persisted entry', () => {
  const { file } = tempStore()
  const store = createResumeStore({ file })
  store.set('s1', entry())
  store.set('s2', entry({ claudeSessionId: 'claude-2' }))
  // endClaudeSession and the command both drive the live session map.
  const live = getResumeSessions()
  live.set('s1', 'claude-1')
  live.set('s2', 'claude-2')
  try {
    assert.equal(endClaudeSession('s1', store), true)
    assert.equal(store.get('s1'), undefined)
    assert.equal(live.has('s1'), false)
    const command = createClaudeFreshCommand(live, new Map(), store)
    const result = command.handler({ agent: { session: { id: 's2' } } })
    assert.equal(result.kind, 'success')
    assert.equal(store.get('s2'), undefined)
    assert.equal(live.has('s2'), false)
  } finally {
    live.delete('s1')
    live.delete('s2')
  }
})
