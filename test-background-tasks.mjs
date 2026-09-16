// Pure unit tests (no network, no SDK spawn) for waitForBackgroundTasks: the
// driver must hold the DSH step open while Claude Code's own background tasks
// are live, because tearing the session down at `result` is exactly what kills
// them. Uses the settings.queryImpl seam. Run: node test-background-tasks.mjs
import assert from 'node:assert/strict'
import {
  briefTaskSummary,
  buildSdkPrompt,
  MAX_TASK_SUMMARY_CHARS,
  renderBackgroundNote,
  renderBackgroundNotes,
  streamClaudeChunks,
} from './lib/index.js'

const ctx = { get: () => undefined, logger: { info: () => {}, warn: () => {} } }
const baseOptions = {
  provider: 'claude-code',
  model: 'fable',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
}

// Numbers in the script act as delays (ms) so deadline behaviour is testable.
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

async function collect(settings, messages, captured = []) {
  const chunks = []
  const merged = { resumeChain: false, queryImpl: mockQuery(messages, captured), ...settings }
  for await (const chunk of streamClaudeChunks(ctx, baseOptions, merged)) chunks.push(chunk)
  return chunks
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
  message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } },
})
const result = (text) => ({
  type: 'result',
  subtype: 'success',
  session_id: 's1',
  result: text,
  usage: { input_tokens: 10, output_tokens: 5 },
})

const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const reasoningOf = (chunks) => chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')

// --- renderBackgroundNote shape ------------------------------------------------
assert.equal(renderBackgroundNote([], [], false, 1000), '', 'nothing to report → no note')
assert.ok(
  renderBackgroundNote([{ status: 'completed', summary: 'build' }], [], false, 1000).includes('build（completed）'),
  'settled task named with its status',
)
assert.ok(
  renderBackgroundNote([], [{ task_id: 'x', description: 'long job' }], true, 60000).includes('60s'),
  'timeout note carries the cap in seconds',
)
assert.ok(
  renderBackgroundNote([], [{ task_id: 'x', description: 'long job' }], false, 60000).includes('仍在运行'),
  'still-running note when the stream ended early',
)

// --- renderBackgroundNotes: severity split for the main session ----------------
{
  const notes = renderBackgroundNotes([{ status: 'completed', summary: 'build' }], [], false, 1000)
  assert.ok(notes.info.includes('build（completed）'), 'completed settlement goes to info')
  assert.equal(notes.alert, '', 'all-completed → no alert')
}
{
  const notes = renderBackgroundNotes([{ status: 'failed', summary: 'deploy' }], [], false, 1000)
  assert.equal(notes.info, '', 'no completed entries → no info')
  assert.ok(notes.alert.includes('后台任务失败：deploy（failed）'), 'failure goes to alert, named as such')
}
{
  const notes = renderBackgroundNotes(
    [{ status: 'completed', summary: 'build' }, { status: 'failed', summary: 'deploy' }],
    [{ task_id: 'x', description: 'long job' }],
    true,
    60000,
  )
  assert.ok(notes.info.includes('build（completed）'), 'mixed: completed stays info')
  assert.ok(!notes.info.includes('deploy'), 'mixed: failure never leaks into info')
  assert.ok(notes.alert.includes('deploy（failed）'), 'mixed: failure in alert')
  assert.ok(notes.alert.includes('60s') && notes.alert.includes('long job'), 'mixed: timeout part joins the alert')
  assert.ok(!notes.alert.includes('build'), 'mixed: completed never leaks into alert')
}
assert.deepEqual(renderBackgroundNotes([], [], false, 1000), { info: '', alert: '' }, 'nothing to report → both empty')

// --- briefTaskSummary: a status line, never a whole agent report ---------------
assert.equal(briefTaskSummary('done'), 'done', 'short single line kept verbatim, no ellipsis')
assert.equal(briefTaskSummary('line1\nline2'), 'line1…', 'later lines dropped, marked with one ellipsis')
assert.equal(briefTaskSummary('line1\r\nline2'), 'line1…', 'CRLF split too')
{
  const long = 'x'.repeat(200)
  const brief = briefTaskSummary(long)
  assert.equal(brief, `${'x'.repeat(MAX_TASK_SUMMARY_CHARS)}…`, 'long line capped at MAX_TASK_SUMMARY_CHARS')
  assert.equal(brief.length, MAX_TASK_SUMMARY_CHARS + 1, 'exactly one ellipsis appended')
  assert.ok(!brief.includes('……'), 'never two ellipses')
}
{
  // Cut first line AND dropped later lines: still exactly one ellipsis.
  const brief = briefTaskSummary(`${'y'.repeat(120)}\n更多内容\n还有更多`)
  assert.equal(brief, `${'y'.repeat(MAX_TASK_SUMMARY_CHARS)}…`)
  assert.ok(!brief.includes('……'), 'never two ellipses when both cut and truncated')
}
assert.equal(briefTaskSummary('a'.repeat(MAX_TASK_SUMMARY_CHARS)), 'a'.repeat(MAX_TASK_SUMMARY_CHARS), 'exactly at the cap is untouched')
assert.equal(briefTaskSummary(''), '', 'empty string → empty')
assert.equal(briefTaskSummary('   \n  '), '', 'whitespace-only → empty')
assert.equal(briefTaskSummary(undefined), '', 'undefined → empty')
assert.equal(briefTaskSummary(null), '', 'null → empty')
assert.equal(briefTaskSummary('\n\n  真正的内容\n后面还有'), '真正的内容…', 'blank leading lines skipped')
assert.ok(
  renderBackgroundNote([{ status: 'completed', taskId: 'task-7', summary: '' }], [], false, 1000).includes('task-7（completed）'),
  'empty summary falls back to the taskId',
)
assert.ok(
  renderBackgroundNote([{ status: 'completed', taskId: 'task-7' }], [], false, 1000).includes('task-7（completed）'),
  'missing summary falls back to the taskId',
)

// --- integration: a multi-line agent report stays a one-line note --------------
{
  const report = `已完成对仓库的审计，发现 3 处问题。\n${'详细说明。'.repeat(200)}\n结论：建议立即修复。`
  const note = renderBackgroundNote([{ status: 'completed', taskId: 't9', summary: report }], [], false, 1000)
  assert.ok(!note.slice(2).includes('\n'), 'note body is a single line (only the leading blank lines)')
  assert.ok(note.endsWith(']'), 'bracket properly closed')
  assert.ok(note.length < 200, `note stays short, got ${note.length}`)
  assert.ok(note.includes('已完成对仓库的审计，发现 3 处问题。'), 'first line survives')
  assert.ok(!note.includes('结论：建议立即修复。'), 'trailing report body dropped')
  assert.ok(note.includes('（completed）'), 'status still rendered')
}

// --- buildSdkPrompt: open-input only when asked --------------------------------
{
  const plan = { prompt: 'hi', segments: ['hi'] }
  const legacy = await buildSdkPrompt(ctx, plan, undefined, false)
  assert.equal(legacy, 'hi', 'legacy path stays a one-shot string prompt')
  const open = await buildSdkPrompt(ctx, plan, undefined, true)
  assert.equal(typeof open[Symbol.asyncIterator], 'function', 'open-input path is an AsyncIterable')
  const first = await open[Symbol.asyncIterator]().next()
  assert.equal(first.value.message.content[0].text, 'hi', 'first message carries the prompt')
  assert.equal(first.value.type, 'user')
  // The tail intentionally never resolves (keeps stdin open) — not awaited here.
}

// --- waits for a live background task, then reports its outcome ----------------
{
  const captured = []
  const chunks = await collect(
    {},
    [
      bg([{ task_id: 't1', type: 'shell', description: 'build' }]),
      assistant('ok'),
      result('ok'),
      bg([]),
      notif('completed', 'build'),
    ],
    captured,
  )
  const body = textOf(chunks)
  assert.ok(body.includes('ok'), 'model text preserved')
  assert.ok(!body.includes('build（completed）'), 'all-completed settlement no longer glued into the prose')
  const thought = reasoningOf(chunks)
  assert.ok(thought.includes('build（completed）'), 'settled background task reported in the reasoning block instead')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' }, 'successful finish')
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.index === 0)
  assert.equal(blockEnd.block.text, body, 'block-end text equals the concatenated deltas')
  const reasoningEnd = chunks.find((c) => c.type === 'block-end' && c.index === 1)
  assert.equal(reasoningEnd.block.text, thought, 'reasoning block-end equals the concatenated reasoning deltas')
  // The open-input + affordance pair is what lets the CLI spare the task.
  assert.equal(captured[0].options.perTaskStopAffordance, true, 'perTaskStopAffordance declared')
  assert.equal(typeof captured[0].prompt[Symbol.asyncIterator], 'function', 'streaming input used')
}

// --- toolNarrationChannel:'text' keeps the settlement list in the prose --------
{
  const chunks = await collect(
    { toolNarrationChannel: 'text' },
    [
      bg([{ task_id: 't1', type: 'shell', description: 'build' }]),
      assistant('ok'),
      result('ok'),
      bg([]),
      notif('completed', 'build'),
    ],
  )
  const body = textOf(chunks)
  assert.ok(body.includes('build（completed）'), "channel 'text' opts back into the prose placement")
  assert.equal(reasoningOf(chunks), '', 'and nothing goes to reasoning')
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.index === 0)
  assert.equal(blockEnd.block.text, body, 'block-end text equals the concatenated deltas')
}

// --- a failed background task stays in the prose (severity split) --------------
{
  const chunks = await collect({}, [
    bg([{ task_id: 't1', type: 'shell', description: 'deploy' }]),
    assistant('ok'),
    result('ok'),
    bg([]),
    notif('failed', 'deploy'),
  ])
  const body = textOf(chunks)
  assert.ok(body.includes('后台任务失败：deploy（failed）'), 'failure surfaces in the prose, not buried in reasoning')
  assert.ok(!reasoningOf(chunks).includes('deploy'), 'failure not duplicated into reasoning')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' }, 'a failed background task is not a turn failure')
}

// --- waitForBackgroundTasks:false restores the one-shot behaviour --------------
{
  const captured = []
  const chunks = await collect(
    { waitForBackgroundTasks: false },
    [
      bg([{ task_id: 't1', type: 'shell', description: 'build' }]),
      assistant('ok'),
      result('ok'),
      bg([]),
      notif('completed', 'build'),
    ],
    captured,
  )
  const body = textOf(chunks)
  assert.equal(body, 'ok', 'no narration, and messages after result are not consumed')
  assert.equal(captured[0].options.perTaskStopAffordance, undefined, 'affordance not declared')
  assert.equal(typeof captured[0].prompt, 'string', 'legacy one-shot string prompt')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
}

// --- ambient (housekeeping) tasks never hold the step open ---------------------
{
  const chunks = await collect({}, [
    bg([{ task_id: 'a1', type: 'monitor', description: 'watcher', ambient: true }]),
    assistant('ok'),
    result('ok'),
  ])
  assert.equal(textOf(chunks), 'ok', 'ambient task neither waits nor narrates')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
}

// --- stream ends while a task is still live: report it, do not error -----------
{
  const chunks = await collect({}, [
    bg([{ task_id: 't1', type: 'shell', description: 'long job' }]),
    assistant('ok'),
    result('ok'),
  ])
  const body = textOf(chunks)
  assert.ok(body.includes('仍在运行'), 'still-running task named')
  assert.ok(body.includes('long job'))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' }, 'still a successful turn')
}

// --- deadline lapses: finish the step and say so -------------------------------
{
  const chunks = await collect({ backgroundTaskTimeoutMs: 1 }, [
    bg([{ task_id: 't1', type: 'shell', description: 'long job' }]),
    assistant('ok'),
    result('ok'),
    20, // sleep past the 1ms deadline
    bg([{ task_id: 't1', type: 'shell', description: 'long job' }]),
    notif('completed', 'never observed'),
  ])
  const body = textOf(chunks)
  assert.ok(body.includes('上限'), 'timeout narrated')
  assert.ok(!body.includes('never observed'), 'stopped draining at the deadline')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' }, 'timeout is not a turn failure')
}

// --- a failing run is unaffected by the background bookkeeping -----------------
{
  const chunks = await collect({}, [
    bg([{ task_id: 't1', type: 'shell', description: 'build' }]),
    { type: 'result', subtype: 'error_during_execution', session_id: 's1', result: 'boom' },
  ])
  assert.equal(chunks.at(-1).reason.kind, 'error', 'failures still surface as errors')
}

console.log('test-background-tasks: all assertions passed')
