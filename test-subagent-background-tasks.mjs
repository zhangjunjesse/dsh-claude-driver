// Pure unit tests (no network, no SDK spawn) for the `claude-code` subagent
// provider's waitForBackgroundTasks support — the same fix as
// test-background-tasks.mjs, ported to lib/subagent-provider.js so a
// delegated run does not silently lose Claude Code's own `run_in_background`
// work. Uses the settings.queryImpl seam. Run: node test-subagent-background-tasks.mjs
import assert from 'node:assert/strict'
import { createClaudeCodeProvider } from './lib/subagent-provider.js'

// Numbers in the message list act as delays (ms) so deadline behaviour is
// testable, exactly like test-background-tasks.mjs's mockQuery.
function mockQuery(messages, captured) {
  return (params) => {
    captured.push(params)
    return (async function* () {
      for (const message of messages) {
        if (typeof message === 'number') {
          await new Promise((resolve) => setTimeout(resolve, message))
          continue
        }
        yield message
      }
    })()
  }
}

const bg = (tasks) => ({ type: 'system', subtype: 'background_tasks_changed', session_id: 's1', tasks })
const notif = (status, summary, extra = {}) => ({
  type: 'system',
  subtype: 'task_notification',
  session_id: 's1',
  task_id: 't1',
  status,
  summary,
  ...extra,
})
const assistant = (text) => ({
  type: 'assistant',
  session_id: 's1',
  message: { content: [{ type: 'text', text }] },
})
const result = (text) => ({ type: 'result', subtype: 'success', session_id: 's1', result: text })

async function run(settings, messages) {
  const captured = []
  const provider = createClaudeCodeProvider({
    cwd: process.cwd(), // bypass parent.session.meta.cwd lookup — not under test here
    queryImpl: mockQuery(messages, captured),
    ...settings,
  })
  const signal = new AbortController().signal
  const handle = await provider.start({ prompt: [{ type: 'text', text: 'q' }], signal })
  assert.equal(handle.localAgent, undefined, 'remote provider never exposes a localAgent (see module doc comment)')
  const outcome = await handle.result
  await handle.dispose()
  const text = outcome.output.map((b) => b.text).join('')
  return { outcome, text, captured }
}

// --- waits for a live background task, then reports its outcome ----------------
{
  const { outcome, text, captured } = await run(
    {},
    [
      bg([{ task_id: 't1', type: 'shell', description: 'build' }]),
      assistant('ok'),
      result('ok'),
      bg([]),
      notif('completed', 'build'),
    ],
  )
  assert.equal(outcome.stopReason, 'completed', 'successful finish')
  assert.ok(text.startsWith('ok'), 'model text preserved')
  assert.ok(text.includes('build（completed）'), 'settled background task reported')
  // The open-input + affordance pair is what lets the CLI spare the task.
  assert.equal(captured[0].options.perTaskStopAffordance, true, 'perTaskStopAffordance declared')
  assert.equal(typeof captured[0].prompt[Symbol.asyncIterator], 'function', 'streaming input used')
}

// --- waitForBackgroundTasks:false restores the one-shot behaviour --------------
{
  const { outcome, text, captured } = await run(
    { waitForBackgroundTasks: false },
    [
      bg([{ task_id: 't1', type: 'shell', description: 'build' }]),
      assistant('ok'),
      result('ok'),
      bg([]),
      notif('completed', 'build'),
    ],
  )
  assert.equal(text, 'ok', 'no narration, and messages after result are not consumed')
  assert.equal(outcome.stopReason, 'completed')
  assert.equal(captured[0].options.perTaskStopAffordance, undefined, 'affordance not declared')
  assert.equal(typeof captured[0].prompt, 'string', 'legacy one-shot string prompt')
}

// --- ambient (housekeeping) tasks never hold the run open ----------------------
{
  const { outcome, text } = await run({}, [
    bg([{ task_id: 'a1', type: 'monitor', description: 'watcher', ambient: true }]),
    assistant('ok'),
    result('ok'),
  ])
  assert.equal(text, 'ok', 'ambient task neither waits nor narrates')
  assert.equal(outcome.stopReason, 'completed')
}

// --- stream ends while a task is still live: report it, do not fail -----------
{
  const { outcome, text } = await run({}, [
    bg([{ task_id: 't1', type: 'shell', description: 'long job' }]),
    assistant('ok'),
    result('ok'),
  ])
  assert.ok(text.includes('仍在运行'), 'still-running task named')
  assert.ok(text.includes('long job'))
  assert.equal(outcome.stopReason, 'completed', 'still a successful run')
}

// --- deadline lapses: finish and say so -----------------------------------------
{
  const { outcome, text } = await run({ backgroundTaskTimeoutMs: 1 }, [
    bg([{ task_id: 't1', type: 'shell', description: 'long job' }]),
    assistant('ok'),
    result('ok'),
    20, // sleep past the 1ms deadline
    bg([{ task_id: 't1', type: 'shell', description: 'long job' }]),
    notif('completed', 'never observed'),
  ])
  assert.ok(text.includes('上限'), 'timeout narrated')
  assert.ok(!text.includes('never observed'), 'stopped draining at the deadline')
  assert.equal(outcome.stopReason, 'completed', 'timeout is not a run failure')
}

// --- a failing run is unaffected by the background bookkeeping -----------------
{
  const { outcome, text } = await run({}, [
    bg([{ task_id: 't1', type: 'shell', description: 'build' }]),
    { type: 'result', subtype: 'error_during_execution', session_id: 's1', result: 'boom' },
  ])
  assert.equal(outcome.stopReason, 'error', 'failures still surface as errors')
  assert.equal(outcome.detail, 'boom')
  assert.ok(!text.includes('仍在运行'), 'no background narration attached to a failed run')
}

console.log('test-subagent-background-tasks: all assertions passed')
