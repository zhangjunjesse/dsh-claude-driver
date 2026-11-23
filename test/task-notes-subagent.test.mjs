// The claude-code subagent provider reports task outcomes to the PARENT agent as
// data, so a wrong "failed" there makes the parent re-do or abandon good work.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClaudeCodeProvider } from '../lib/subagent-provider.js'

const started = (id, over = {}) => ({ type: 'system', subtype: 'task_started', session_id: 's', task_id: id, tool_use_id: `t-${id}`, description: `task ${id}`, is_backgrounded: true, ...over })
const note = (id, status, summary = `task ${id}`, over = {}) => ({ type: 'system', subtype: 'task_notification', session_id: 's', task_id: id, status, summary, ...over })
const level = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', session_id: 's', tasks: ids.map((id) => ({ task_id: id, description: `task ${id}` })) })
const done = [{ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'delegated result' }] } }, { type: 'result', subtype: 'success', session_id: 's', result: 'delegated result', usage: { input_tokens: 1, output_tokens: 1 } }]

async function out(events) {
  const queryImpl = () => (async function* () { for (const e of [...events, ...done]) yield e })()
  const handle = await createClaudeCodeProvider({ queryImpl, waitForBackgroundTasks: true }).start({
    prompt: [{ type: 'text', text: 'q' }], parent: { session: { meta: { cwd: '/tmp' } } }, signal: new AbortController().signal,
  })
  const result = await handle.result
  await handle.dispose()
  return result.output.map((b) => b.text).join('')
}

test('a failed FOREGROUND command inside the delegated run is not reported as a failed background task', async () => {
  const text = await out([started('f1', { is_backgrounded: false }), note('f1', 'failed', 'Write failing tests first')])
  assert.ok(!/background tasks/i.test(text), text)
})

test('a real background task that failed is reported to the parent', async () => {
  const text = await out([level('b1'), started('b1'), note('b1', 'failed', 'Server crashed'), level()])
  assert.match(text, /background tasks failed: Server crashed \(failed\)/i)
})

test('a stopped task is reported as stopped, not failed', async () => {
  const text = await out([level('b1'), started('b1'), note('b1', 'stopped', 'Server'), level()])
  assert.ok(!/background tasks failed/i.test(text), text)
})
