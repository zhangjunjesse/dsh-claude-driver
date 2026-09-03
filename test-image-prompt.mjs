// Pure unit tests (no network, no SDK spawn) for image-attachment support in
// the prompt pipeline: segment rendering, placeholder degradation without the
// attachment service, and base64 SDK image blocks with a mock service.
// Run: node test-image-prompt.mjs
import assert from 'node:assert/strict'
import {
  planPrompt,
  buildSdkPrompt,
  resolveImageBlock,
  resolvePromptContent,
  renderResumeSegments,
  segmentsHaveImage,
  segmentsToText,
  imagePlaceholder,
  extractResumeTail,
} from './lib/index.js'

const u = (...blocks) => ({ role: 'user', content: blocks })
const a = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const t = (text) => ({ type: 'text', text })

// DSH image block: {type:'image', attachment: ImageAttachmentRef} where ref =
// {attachmentId:'sha256:<hex>', mediaType, bytes, width, height, name?}.
const SHA = 'a'.repeat(64)
const ref = { attachmentId: `sha256:${SHA}`, mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1, name: 'cat.jpg' }
const img = { type: 'image', attachment: ref }
const PNG_BYTES = new Uint8Array([137, 80, 78, 71])
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64')

const warns = []
const logger = { warn: (...args) => warns.push(args.map(String).join(' ')) }
const noService = { get: () => undefined, logger }
const mockAttachments = {
  readImage: async (attachment) => {
    assert.deepEqual(attachment, ref, 'readImage receives the block.attachment ref verbatim')
    return { ref: { ...ref, mediaType: 'image/png' }, data: PNG_BYTES }
  },
}
const withService = { get: (name) => (name === 'attachments' ? mockAttachments : undefined), logger }

// Bounded on purpose: with waitForBackgroundTasks on (the default) the prompt is
// an OPEN-ENDED AsyncIterable — it yields the one user message and then stays
// pending so the CLI keeps stdin open. Draining it would never return.
async function collectPrompt(promptInput, max = 1) {
  if (typeof promptInput === 'string') return { kind: 'string', value: promptInput }
  const messages = []
  const iterator = promptInput[Symbol.asyncIterator]()
  while (messages.length < max) {
    const next = await iterator.next()
    if (next.done) break
    messages.push(next.value)
  }
  return { kind: 'stream', messages }
}

// --- imagePlaceholder label preference: name > attachmentId > id ------------
assert.equal(imagePlaceholder(img), '[image: cat.jpg]')
assert.equal(imagePlaceholder({ type: 'image', attachment: { attachmentId: 'sha256:ff' } }), '[image: sha256:ff]')
assert.equal(imagePlaceholder({ type: 'image', id: 'blk-1' }), '[image: blk-1]')
assert.equal(imagePlaceholder({ type: 'image' }), '[image: unknown]')

// --- fresh plan: image marker survives rendering; prompt string degrades ----
const settings = { resumeChain: true }
const sessions = new Map()
const options = {
  sessionId: 'dsh-img',
  system: 'SYS',
  messages: [u(t('look at this:'), img, t('what is it?'))],
}
const freshPlan = planPrompt(options, settings, sessions)
assert.equal(freshPlan.mode, 'fresh')
assert.ok(segmentsHaveImage(freshPlan.segments), 'fresh segments keep the image marker')
assert.equal(segmentsToText(freshPlan.segments), freshPlan.prompt, 'prompt string is the text projection of the segments')
assert.ok(freshPlan.prompt.includes('look at this:\n\n[image: cat.jpg]\n\nwhat is it?'), 'placeholder sits at the image position')

// --- text-only messages produce a single string segment (zero-overhead path)
{
  const plan = planPrompt({ ...options, messages: [u(t('q1')), a('r1'), u(t('q2'))] }, settings, sessions)
  assert.equal(plan.segments.length, 1, 'no images -> one merged string segment')
  assert.ok(!segmentsHaveImage(plan.segments))
}

// --- buildSdkPrompt without attachment service: placeholder string + warn ---
{
  warns.length = 0
  const promptInput = await buildSdkPrompt(noService, freshPlan)
  const result = await collectPrompt(promptInput)
  assert.equal(result.kind, 'string', 'all images degraded -> plain string prompt')
  assert.equal(result.value, freshPlan.prompt, 'degraded prompt is byte-identical to the text plan')
  assert.ok(result.value.includes('[image: cat.jpg]'))
  assert.ok(warns.some((w) => w.includes('attachment service')), 'missing service is warned, never thrown')
}

// --- buildSdkPrompt with mock service: streaming SDKUserMessage with blocks --
{
  warns.length = 0
  const promptInput = await buildSdkPrompt(withService, freshPlan)
  const result = await collectPrompt(promptInput)
  assert.equal(result.kind, 'stream', 'resolvable image -> AsyncIterable prompt')
  assert.equal(result.messages.length, 1, 'exactly one SDKUserMessage')
  const message = result.messages[0]
  assert.equal(message.type, 'user')
  assert.equal(message.parent_tool_use_id, null)
  assert.equal(message.message.role, 'user')
  const content = message.message.content
  assert.equal(content.length, 3, 'text before / image / text after')
  assert.equal(content[0].type, 'text')
  assert.ok(content[0].text.includes('look at this:'), 'leading text kept (with role wrapper)')
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } })
  assert.ok(content[2].type === 'text' && content[2].text.includes('what is it?'), 'trailing text kept')
  assert.ok(content[2].text.includes('<Assistant>'), 'fresh prompt scaffold preserved')
  assert.equal(warns.length, 0, 'happy path emits no warnings')
}

// --- resume tail with an image resolves too ---------------------------------
{
  sessions.set('dsh-img', 'sdk-session-xyz')
  const resumeOptions = { ...options, messages: [u(t('q1')), a('r1'), u(t('new question'), img)] }
  const plan = planPrompt(resumeOptions, settings, sessions)
  assert.equal(plan.mode, 'resume')
  assert.ok(segmentsHaveImage(plan.segments), 'resume tail keeps the image marker')
  assert.equal(plan.prompt, 'new question\n\n[image: cat.jpg]', 'unwrapped single-message tail, placeholder in text plan')
  const result = await collectPrompt(await buildSdkPrompt(withService, plan))
  assert.equal(result.kind, 'stream')
  const content = result.messages[0].message.content
  assert.deepEqual(content, [
    { type: 'text', text: 'new question\n\n' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
  ])
  // renderResumeSegments/extractResumeTail agree with the plan
  assert.deepEqual(renderResumeSegments(extractResumeTail(resumeOptions.messages)), plan.segments)
  sessions.delete('dsh-img')
}

// --- inline data URL wins without any service --------------------------------
{
  const dataUrlBlock = { type: 'image', dataUrl: `data:image/webp;base64,${PNG_B64}` }
  const block = await resolveImageBlock(dataUrlBlock, undefined, logger)
  assert.deepEqual(block, { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: PNG_B64 } })
}

// --- readImage failure degrades in place, never throws -----------------------
{
  warns.length = 0
  const broken = { readImage: async () => { throw new Error('ATTACHMENT_NOT_FOUND') } }
  const content = await resolvePromptContent(['before ', { image: img }, ' after'], broken, logger)
  assert.deepEqual(content, [{ type: 'text', text: 'before [image: cat.jpg] after' }], 'failed image merges back into text')
  assert.ok(warns.some((w) => w.includes('failed to read image attachment')), 'failure is warned')
}

// --- images inside tool-result content stay text (no marker) -----------------
{
  const plan = planPrompt(
    {
      ...options,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [t('done'), { type: 'image', attachment: ref }] }],
        },
      ],
    },
    settings,
    sessions,
  )
  assert.ok(!segmentsHaveImage(plan.segments), 'tool-result images are rendered as text, not resolved to pixels')
}

// --- end-to-end plumbing: streamClaudeChunks hands the SDK the stream -------
{
  const { streamClaudeChunks } = await import('./lib/index.js')
  let seenPrompt
  const queryImpl = ({ prompt }) => {
    seenPrompt = prompt
    return (async function* () {
      yield {
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: '一只猫' }] },
      }
      yield { type: 'result', subtype: 'success', session_id: 's1', usage: { output_tokens: 2 } }
    })()
  }
  const chunks = []
  for await (const chunk of streamClaudeChunks(withService, { provider: 'claude-code', ...options }, { queryImpl, bridgeTools: false })) {
    chunks.push(chunk)
  }
  const result = await collectPrompt(seenPrompt)
  assert.equal(result.kind, 'stream', 'streamClaudeChunks passes an AsyncIterable prompt when images resolve')
  assert.equal(result.messages[0].message.content[1].source.data, PNG_B64)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text.includes('一只猫')))
}

console.log('test-image-prompt: all assertions passed')
