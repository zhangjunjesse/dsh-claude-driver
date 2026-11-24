// The Plugins page's claude-driver row gets one Configure page: the 5-hour and
// weekly plan-window stops, native compaction, ending the Claude session after a
// stop, and the context-token threshold for native autocompaction. The page
// talks to the same host route the driver serves, so edits apply without a
// restart.
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

test('the draft mirrors the served settings, keeping the last value when a guard is off', () => {
  const { stopDraftFrom } = exported
  assert.deepEqual(
    plain(
      stopDraftFrom({
        usageStopPercent: 95,
        weeklyStopPercent: 98,
        usageStopCompaction: true,
        usageStopEndSession: false,
        compactAtTokens: 400000,
      }),
    ),
    {
      fiveHourEnabled: true,
      fiveHourPercent: '95',
      weeklyEnabled: true,
      weeklyPercent: '98',
      compaction: true,
      endSession: false,
      contextEnabled: true,
      contextK: '400',
    },
  )
  assert.deepEqual(plain(stopDraftFrom({ usageStopPercent: false, weeklyStopPercent: false })), {
    fiveHourEnabled: false,
    fiveHourPercent: '95',
    weeklyEnabled: false,
    weeklyPercent: '98',
    compaction: true,
    endSession: true,
    contextEnabled: false,
    contextK: '400',
  })
  assert.deepEqual(plain(stopDraftFrom({ usageStopPercent: 80, compactAtTokens: 250000 })), {
    fiveHourEnabled: true,
    fiveHourPercent: '80',
    weeklyEnabled: true,
    weeklyPercent: '98',
    compaction: true,
    endSession: true,
    contextEnabled: true,
    contextK: '250',
  })
})

test('saving turns the draft into the exact patch the route validates', () => {
  const { stopPatchFrom } = exported
  assert.deepEqual(
    plain(
      stopPatchFrom({
        fiveHourEnabled: true,
        fiveHourPercent: ' 85.5 ',
        weeklyEnabled: true,
        weeklyPercent: '97',
        compaction: true,
        endSession: false,
        contextEnabled: true,
        contextK: ' 400 ',
      }),
    ),
    {
      ok: true,
      value: {
        usageStopPercent: 85.5,
        weeklyStopPercent: 97,
        usageStopCompaction: true,
        usageStopEndSession: false,
        compactAtTokens: 400000,
      },
    },
  )
  assert.deepEqual(
    plain(stopPatchFrom({ fiveHourEnabled: false, weeklyEnabled: false, compaction: true, endSession: true, contextEnabled: false })),
    {
      ok: true,
      value: { usageStopPercent: false, weeklyStopPercent: false, usageStopCompaction: true, usageStopEndSession: true, compactAtTokens: 0 },
    },
  )
  for (const percent of ['', '0', '101', 'abc']) {
    const result = stopPatchFrom({ fiveHourEnabled: true, fiveHourPercent: percent, weeklyEnabled: true, weeklyPercent: '98', compaction: true, endSession: true, contextEnabled: false })
    assert.equal(result.ok, false, `${JSON.stringify(percent)} must not save`)
    assert.match(result.error, /5-hour/i)
    const weekly = stopPatchFrom({ fiveHourEnabled: true, fiveHourPercent: '95', weeklyEnabled: true, weeklyPercent: percent, compaction: true, endSession: true, contextEnabled: false })
    assert.equal(weekly.ok, false)
    assert.match(weekly.error, /weekly/i)
  }
  for (const k of ['', '0', '9', '2001', 'abc']) {
    const result = stopPatchFrom({ fiveHourEnabled: true, fiveHourPercent: '95', weeklyEnabled: true, weeklyPercent: '98', compaction: true, endSession: true, contextEnabled: true, contextK: k })
    assert.equal(result.ok, false, `${JSON.stringify(k)}k must not save`)
    assert.match(result.error, /context/i)
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
