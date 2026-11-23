// The composer bar shows the session price next to the 5-hour and weekly plan
// windows, in one line like the DSH token-usage bar. The segment logic is pure, so
// it is pinned here against the client bundle, run in a sandbox with a stub React.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'

const source = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
const sandbox = {
  window: { __ModuleLoader__: { load: (reg) => (sandbox.registration = reg) } },
  document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} }, body: {}, addEventListener() {}, querySelectorAll: () => [] },
  Element: class {},
  WeakMap,
  MutationObserver: class {
    observe() {}
  },
  requestAnimationFrame: () => {},
}
vm.runInNewContext(source, sandbox, { filename: 'client/client.js' })
const fakeRequire = () => ({ createPortal: () => null, createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useRef: () => ({ current: null }) })
const { barSegments: barSegmentsInSandbox } = sandbox.registration.factory(fakeRequire)
// Results are built in the sandbox realm; copy them out so deepEqual compares plain data.
const barSegments = (input) => JSON.parse(JSON.stringify(barSegmentsInSandbox(input)))

const windows = (over = {}) => ({ fiveHour: { percent: 42, resetsAt: null }, weekly: { percent: 13.5, resetsAt: null }, ...over })

test('the bar leads with the Claude label, then the 5-hour and weekly windows, rounded', () => {
  const bar = barSegments({ stats: { costUsd: 0.00129 }, snapshot: { ok: true, windows: windows() } })
  assert.equal(bar.label, 'Claude')
  assert.equal(bar.cost, '$0.0013', 'the price stays in the detail card, not the line')
  assert.deepEqual(
    bar.windows.map(({ label, percent }) => [label, percent]),
    [
      ['5h', 42],
      ['Week', 14],
    ],
  )
})

test('no plan limits (API key) leaves only the price', () => {
  const bar = barSegments({ stats: { costUsd: 1 }, snapshot: { ok: false, code: 'unavailable' } })
  assert.equal(bar.cost, '$1.0000')
  assert.deepEqual(bar.windows, [])
})

test('an unpriced session shows n/a, not a guessed price', () => {
  assert.equal(barSegments({ stats: { costUsd: null }, snapshot: null }).cost, 'n/a')
})

test('no session stats yet means no price segment', () => {
  assert.equal(barSegments({ stats: null, snapshot: { ok: true, windows: windows() } }).cost, null)
})

test('a window that is nearly used up is flagged, a fresh one is not', () => {
  const bar = barSegments({ stats: null, snapshot: { ok: true, windows: windows({ fiveHour: { percent: 92, resetsAt: null }, weekly: { percent: 75, resetsAt: null } }) } })
  assert.deepEqual(
    bar.windows.map(({ label, tone }) => [label, tone]),
    [
      ['5h', 'danger'],
      ['Week', 'warn'],
    ],
  )
})

test('the bar shows before the first finished turn when the session route is Claude', () => {
  assert.equal(barSegments({ stats: { costUsd: 1 }, snapshot: { ok: true, windows: windows() } }).visible, true)
  assert.equal(
    barSegments({ stats: null, snapshot: { ok: true, windows: windows() }, provider: 'claude-code', route: 'claude-code' }).visible,
    true,
    'a goal-first session must get the meter before its first turn ends',
  )
  assert.equal(
    barSegments({ stats: null, snapshot: { ok: true, windows: windows() }, provider: 'claude-code', route: 'deepseek' }).visible,
    false,
    'another model\'s session must not carry a Claude bar',
  )
  assert.equal(barSegments({ stats: null, snapshot: { ok: true, windows: windows() }, provider: 'claude-code' }).visible, false, 'no route, no bar')
  assert.equal(barSegments({ stats: { costUsd: 1 }, snapshot: { ok: false } }).visible, false)
})

test('the bar sits inline beside other dock meters instead of taking a row of its own', () => {
  assert.doesNotMatch(source, /width:\s*"100%"/, 'a full-width block pushes the OpenCode Go meter out of line')
  assert.doesNotMatch(source, /position:\s*"absolute"/, 'the card must not be positioned inside the dock')
  assert.match(source, /createPortal/, 'the card is portalled to body like the OpenCode Go card')
  assert.match(source, /position:fixed/, 'the card is fixed-positioned and clamped to the viewport')
  assert.match(source, /data-composer-stat/, 'dock meters are marked like the shipped ones')
})

test('every colour comes from DSW tokens that exist, so the card is never transparent', () => {
  assert.doesNotMatch(source, /--dsw-alias-surface-elevated/, 'that token does not exist; the card rendered see-through')
  assert.match(source, /--dsw-specific-menu/)
  assert.doesNotMatch(source, /#[0-9a-f]{6}/i, 'no hard-coded hex colours, they break dark/light themes')
})

test('the dock id and order cannot collide with the OpenCode Go meter (order 2)', () => {
  const order = Number(/[{,\s]order:\s*(\d+)/.exec(source)?.[1])
  assert.ok(order > 2, `order ${order} must sort after the OpenCode Go meter`)
  assert.match(source, /id:\s*"claude-driver-bar"/)
})
