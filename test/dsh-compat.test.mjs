// Contract test: the driver must match the DSH release it is installed into.
// Static checks always run; the release check runs when DSH_VERSION is set
// (CI sets it per release) and fails if that release pins an incompatible cordis.
// Run: node --test test/dsh-compat.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'lib/index.js'), 'utf8')

const major = (range) => Number(range.replace(/^[^\d]*/, '').split('.')[0])

test('manifest declares the bundle layer and web client entry', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(manifest.files.includes('lib') && manifest.files.includes('cordis.patch.yml'))
})

test('shipped payload mounts by package name and includes what it needs', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(`name: ${manifest.name}`))
  for (const shipped of ['lib', 'client', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(shipped), `files must ship ${shipped}`)
  }
  assert.ok(manifest.engines?.node)
})

test('cordis peer range stays on the v4 line DSH ships', () => {
  const range = manifest.peerDependencies['@deepseek-ai/cordis']
  assert.ok(range, 'cordis must be a peer dependency')
  assert.equal(major(range), 4)
})

test('driver hooks the llm/stream waterfall and session/event firehose', () => {
  assert.match(source, /ctx\.on\('llm\/stream'/)
  assert.match(source, /ctx\.on\('session\/event'/)
})

test('driver only injects services the DSH runtime provides', () => {
  const provided = new Set(['llm', 'commands', 'subagents', 'sessionProjections', 'webServer', 'tools'])
  const injected = [...source.matchAll(/ctx\.inject\(\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((n) => n[1]),
  )
  assert.ok(injected.length > 0)
  for (const service of injected) assert.ok(provided.has(service), `unknown service "${service}"`)
})

test('the DSH release under test pins a compatible cordis', { skip: !process.env.DSH_VERSION }, async () => {
  const version = process.env.DSH_VERSION
  const res = await fetch(`https://registry.npmjs.org/@deepseek-ai%2fdsh/${version}`)
  assert.equal(res.status, 200, `DSH ${version} must exist on npm`)
  const pinned = (await res.json()).dependencies?.['@deepseek-ai/cordis']
  assert.ok(pinned, `DSH ${version} must depend on cordis`)
  assert.equal(major(pinned), major(manifest.peerDependencies['@deepseek-ai/cordis']), `DSH ${version} pins cordis ${pinned}`)
})
