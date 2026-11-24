// The Plugins page's claude-driver row gets one Configure page for the 5-hour
// usage stop: threshold, native compaction, and whether the Claude session is
// ended after that compaction. The page talks to the same host route the driver
// serves, so the edits apply without a restart.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const sandbox = {
  window: { __ModuleLoader__: { load: (reg) => (sandbox.registration = reg) } },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {} }),
    head: { appendChild() {} },
    body: {},
    addEventListener() {},
    querySelectorAll: () => [],
  },
  Element: class {},
  WeakMap,
  MutationObserver: class {
    observe() {}
  },
  requestAnimationFrame: () => {},
}
vm.runInNewContext(source, sandbox, { filename: 'client/client.js' })

const registration = sandbox.registration
const fakeRequire = (id) => {
  assert.ok(id === 'react' || id === 'react-dom', `client bundle may only require react and react-dom, asked for ${id}`)
  return {
    createPortal: () => null,
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect() {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
}
const exported = registration.factory(fakeRequire)
const plain = (value) => JSON.parse(JSON.stringify(value))

assert.equal(exported.STOP_PAGE_KEY, 'dsh-claude-driver#claude-driver')

test('the draft mirrors the served settings, keeping the last threshold when disabled', () => {
  const { stopDraftFrom } = exported
  assert.deepEqual(plain(stopDraftFrom({ usageStopPercent: 95, usageStopCompaction: true, usageStopEndSession: true })), {
    enabled: true,
    percent: '95',
    compaction: true,
    endSession: true,
  })
  assert.deepEqual(plain(stopDraftFrom({ usageStopPercent: false })), { enabled: false, percent: '95', compaction: true, endSession: true })
  assert.deepEqual(plain(stopDraftFrom({ usageStopPercent: 80, usageStopCompaction: false, usageStopEndSession: false })), {
    enabled: true,
    percent: '80',
    compaction: false,
    endSession: false,
  })
})

test('saving turns the draft into the exact patch the route validates', () => {
  const { stopPatchFrom } = exported
  assert.deepEqual(plain(stopPatchFrom({ enabled: true, percent: ' 85.5 ', compaction: true, endSession: false })), {
    ok: true,
    value: { usageStopPercent: 85.5, usageStopCompaction: true, usageStopEndSession: false },
  })
  assert.deepEqual(plain(stopPatchFrom({ enabled: false, percent: '85', compaction: true, endSession: true })), {
    ok: true,
    value: { usageStopPercent: false, usageStopCompaction: true, usageStopEndSession: true },
  })
  for (const percent of ['', '0', '101', 'abc']) {
    const result = stopPatchFrom({ enabled: true, percent, compaction: true, endSession: true })
    assert.equal(result.ok, false, `${JSON.stringify(percent)} must not save`)
    assert.match(result.error, /percent/i)
  }
})

test('the driver row registers a keyed Configure page after the dock meter', () => {
  const calls = []
  const ctx = {
    slots: {
      inject: (name, build) => calls.push({ name, build }),
      register: (registration, Component) => ({ registration, Component }),
    },
  }
  exported.apply(ctx)
  assert.deepEqual(calls.map((call) => call.name), ['conversation.composer.dock', 'plugins.row.config'])
  const page = calls[1].build()
  assert.equal(page.registration.key, exported.STOP_PAGE_KEY, 'the page must attach to the claude-driver row')
  assert.equal(typeof page.Component, 'function')
  assert.match(source, /claude-usage-stop\.json/, 'the page reads and writes the usage-stop route')
})
