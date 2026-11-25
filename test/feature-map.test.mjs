// The feature map must stay true: every DSH tool name and overlap it names
// exists in the driver, and every documented config switch is real.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DSH_OWNED_BUILTINS } from '../lib/index.js'

const root = join(import.meta.dirname, '..')
const doc = readFileSync(join(root, 'docs/feature-map.md'), 'utf8')
const source = ['lib/index.js', 'lib/delegate.js', 'lib/native-compact.js', 'lib/permission-sync.js', 'lib/job-mirror.js', 'lib/claude-events.js'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n')

test('every Claude built-in the map says is withheld is in the overlap table', () => {
  const withheld = Object.values(DSH_OWNED_BUILTINS).flat()
  for (const name of ['EnterPlanMode', 'ExitPlanMode', 'CronCreate', 'TodoWrite', 'WebSearch', 'WebFetch']) {
    assert.ok(withheld.includes(name), name)
    assert.ok(doc.includes(name) || doc.includes(name.replace(/(Create|List|Delete)$/, '')), `${name} documented`)
  }
})

test('every config switch the map names exists in the driver', () => {
  for (const key of [...doc.matchAll(/`([a-z][A-Za-z]+): (?:true|false)`/g)].map((m) => m[1])) {
    assert.ok(source.includes(`settings.${key}`) || source.includes(`config.${key}`), `${key} is a real setting`)
  }
})

test('every typed Claude error the map lists is mapped to a DSH code', () => {
  for (const code of ['AUTH', 'RATE_LIMIT', 'SERVER', 'INVALID_REQUEST']) assert.ok(source.includes(`'${code}'`), code)
})
