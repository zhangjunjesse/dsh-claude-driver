// What the user reads about Claude Code's tasks. Every case below comes from real
// CLI event sequences (see test/e2e-task-notes.test.mjs for the live ones).
//   * A failed FOREGROUND command already shows as its own card (exit code); it
//     must not also appear as a "background task failed" note.
//   * A real background task that failed, timed out or was stopped must be reported,
//     with wording that says what actually happened.
//   * A task the driver itself stopped is not a failure.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderBackgroundNotes } from '../lib/background-tasks.js'
import { streamClaudeChunks } from '../lib/index.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
const answer = [{ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'done' }] } }, { type: 'result', subtype: 'success', session_id: 's', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }]
const started = (id, over = {}) => ({ type: 'system', subtype: 'task_started', session_id: 's', task_id: id, tool_use_id: `t-${id}`, description: `task ${id}`, is_backgrounded: true, ...over })
const note = (id, status, summary = `task ${id}`, over = {}) => ({ type: 'system', subtype: 'task_notification', session_id: 's', task_id: id, tool_use_id: `t-${id}`, status, summary, ...over })
const level = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', session_id: 's', tasks: ids.map((id) => ({ task_id: id, description: id === 'b1' ? 'Dev server' : `task ${id}` })) })

async function run(events, settings = {}) {
  const queryImpl = () => (async function* () { for (const e of [...events, ...answer]) yield e })()
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, opts, { resumeChain: false, queryImpl, pulseMs: 0, ...settings })) chunks.push(c)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  return { chunks, text, reasoning, all: text + reasoning }
}

test('a failed FOREGROUND task (CLI says is_backgrounded:false) is never a "background task failed" note', async () => {
  const { all } = await run([started('f1', { is_backgrounded: false }), note('f1', 'failed')])
  assert.ok(!/background tasks/i.test(all), all)
})

test('a foreground task whose task_started was never seen is not reported either (it never appeared in the live set)', async () => {
  const { all } = await run([note('ghost', 'failed', 'Write failing tests first')])
  assert.ok(!/background tasks/i.test(all), all)
})

test('a task that was in the live background set and failed IS reported as failed', async () => {
  const { text } = await run([level('b1'), started('b1'), note('b1', 'failed', 'Dev server crashed'), level()])
  assert.match(text, /background tasks failed.*Dev server crashed/i)
})

test('a task the user/CLI STOPPED is reported as stopped, not as failed', async () => {
  const { text, all } = await run([level('b1'), started('b1'), note('b1', 'stopped', 'Dev server'), level()])
  assert.match(all, /stopped/i)
  assert.ok(!/background tasks failed/i.test(all), all)
  assert.ok(!/background tasks failed/i.test(text))
})

test('a task the DRIVER stopped at the end of the turn is not reported as a failure', async () => {
  const bad = renderBackgroundNotes([{ taskId: 'b1', status: 'stopped', summary: 'Dev server', byDriver: true }], [], false, 0)
  assert.ok(!bad.alert, bad.alert)
})

test('a task still running at the deadline is reported as possibly terminated, not failed', () => {
  const n = renderBackgroundNotes([], [{ task_id: 'b1', description: 'Long job' }], true, 3000)
  assert.match(n.alert, /exceeded the 3s hold/)
  assert.ok(!/background tasks failed/i.test(n.alert))
})

test('mixed outcomes: completed ones are info, stopped/failed are separate, nothing is double counted', () => {
  const n = renderBackgroundNotes([
    { taskId: 'a', status: 'completed', summary: 'Build' },
    { taskId: 'b', status: 'failed', summary: 'Tests' },
    { taskId: 'c', status: 'stopped', summary: 'Server' },
  ], [], false, 0)
  assert.match(n.info, /Build/)
  assert.match(n.alert, /background tasks failed: Tests/i)
  assert.match(n.alert, /background tasks stopped: Server/i)
  assert.ok(!/background tasks failed:[^;\]]*Server/i.test(n.alert), 'Server is listed as stopped, not failed')
})

test('the same task notified twice (resume, replay) is reported once', async () => {
  const { text } = await run([level('b1'), started('b1'), note('b1', 'failed', 'Crash'), note('b1', 'failed', 'Crash'), level()])
  assert.equal((text.match(/Crash/g) ?? []).length, 1, text)
})

test('a subagent (parent_task_id) failing inside the turn is not reported as a top-level background task', async () => {
  const { all } = await run([started('s1', { parent_task_id: 'b0', is_backgrounded: true }), note('s1', 'failed', 'Inner step', { parent_task_id: 'b0' })])
  assert.ok(!/Inner step/.test(all), all)
})

test('a failure note never changes how the turn ends', async () => {
  const { chunks } = await run([level('b1'), started('b1'), note('b1', 'failed', 'Crash'), level()])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

// ---- interrupts: the driver tears Claude's process down, so tasks do not survive ----
async function runAborted(events, settings = {}) {
  const ac = new AbortController()
  const queryImpl = () => (async function* () {
    for (const e of events) yield e
    ac.abort()
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'Started it.' }] } }
    yield { type: 'result', subtype: 'success', session_id: 's', result: 'Started it.', usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, { ...opts, signal: ac.signal }, { resumeChain: false, queryImpl, pulseMs: 0, ...settings })) chunks.push(c)
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}

test('a user interrupt does not claim the background task is "still running": it was ended with the turn', async () => {
  const text = await runAborted([level('b1'), started('b1', { description: 'Dev server' })])
  assert.ok(!/still running/i.test(text), text)
  assert.match(text, /Dev server/)
  assert.match(text, /interrupted.*background tasks ended with it/i)
})

test('renderBackgroundNotes says a task was ended with the turn when the run was interrupted', () => {
  const n = renderBackgroundNotes([], [{ task_id: 'b1', description: 'Dev server' }], false, 0, { interrupted: true })
  assert.ok(!/still running/i.test(n.alert))
  assert.match(n.alert, /Dev server/)
})

test('with no interrupt and no deadline, an unfinished task is still reported as running (unchanged)', () => {
  const n = renderBackgroundNotes([], [{ task_id: 'b1', description: 'Dev server' }], false, 0)
  assert.match(n.alert, /still running/i)
})

// ---- the failure was already reported by the tool call itself ----
const toolUse = (id, input) => ({ type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] } })
const toolResult = (id, content, isError) => ({ type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })

test('a task whose own tool call already returned an error is not reported a second time as a background failure', async () => {
  // Real transcript: Bash returned "Exit code 143 Terminated" (is_error) and the CLI
  // still raised a failed task_notification for the same tool_use.
  const { all } = await run([
    toolUse('t-x1', { command: 'timeout 60 node --test x', description: 'Write failing tests first' }),
    level('x1'), started('x1', { tool_use_id: 't-x1', description: 'Write failing tests first' }),
    toolResult('t-x1', 'Exit code 143\nTerminated', true),
    note('x1', 'failed', 'Write failing tests first', { tool_use_id: 't-x1' }), level(),
  ])
  assert.ok(!/background tasks failed/i.test(all), all)
})

test('a real background launch (tool call returned OK) that later fails is still reported', async () => {
  const { text } = await run([
    toolUse('t-b1', { command: 'serve', run_in_background: true }),
    level('b1'), started('b1', { tool_use_id: 't-b1' }),
    toolResult('t-b1', 'Command running in background', false),
    note('b1', 'failed', 'Dev server crashed', { tool_use_id: 't-b1' }), level(),
  ])
  assert.match(text, /background tasks failed.*Dev server crashed/i)
})

test('a subagent\'s inner task is not listed or reported as its own background task', async () => {
  const live = { type: 'system', subtype: 'background_tasks_changed', session_id: 's', tasks: [{ task_id: 'b0', description: 'Subagent' }, { task_id: 'in1', description: 'Inner step', parent_task_id: 'b0' }] }
  const { all } = await run([
    live,
    started('in1', { parent_task_id: 'b0', description: 'Inner step' }),
    note('in1', 'failed', 'Inner step', { parent_task_id: 'b0' }),
    { type: 'system', subtype: 'background_tasks_changed', session_id: 's', tasks: [] },
  ])
  assert.ok(!/Inner step/.test(all), all)
})

test('only top-level tasks count as "still running" at the end of the turn', async () => {
  const live = { type: 'system', subtype: 'background_tasks_changed', session_id: 's', tasks: [{ task_id: 'b0', description: 'Subagent' }, { task_id: 'in1', description: 'Inner step', parent_task_id: 'b0' }] }
  const { text } = await run([live], { backgroundTaskTimeoutMs: 400 })
  assert.match(text, /Subagent/)
  assert.ok(!/Inner step/.test(text), text)
})
