import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createClaudeCodeProvider } from './subagent-provider.js'
import { resolveClaudeExecutable } from './claude-executable.js'
import { createClaudeCodeAdapter, createModelDiscovery } from './model-catalog.js'

export const name = 'claude-driver'

const CLIENT_APP = 'dsh-claude-driver/0.1.0'

const DEFAULTS = {
  provider: 'claude-code',
  model: 'sonnet',
  permissionMode: 'acceptEdits',
  // Interactive-session ceiling for Claude Code's internal tool loop. 12 keeps
  // chat turns responsive; raise per-route via config for heavy agentic work.
  maxTurns: 12,
  // 'medium' keeps extended thinking short for chat responsiveness; users can
  // still pick 'high'/'max' in the session UI or via patch config.
  effort: 'medium',
  proxy: 'http://127.0.0.1:7897',
  allowedTools: undefined,
  cwd: undefined,
  pathToClaudeCodeExecutable: undefined,
  // Session model-picker catalog (advisory; strings or {id,name,description,contextWindow,maxTokens}).
  // contextWindow is REQUIRED for DSH automatic compaction to work on this
  // route: dsh-compaction-basic's pressure path reads
  // resolveModelInfo().context.contextWindow and throws
  // TargetPressureConfigError (degraded to a warn, i.e. compaction silently
  // off) when it is absent. All current Claude Code aliases are 200k-context
  // models; override per-model via config when that changes.
  models: [
    { id: 'fable', contextWindow: 200000 },
    { id: 'sonnet', contextWindow: 200000 },
    { id: 'opus', contextWindow: 200000 },
    { id: 'haiku', contextWindow: 200000 },
  ],
  // Reasoning-effort vocabulary offered in the picker; `effort` above is the default level.
  efforts: ['low', 'medium', 'high', 'max'],
  displayName: 'Claude Code',
  // Set false to skip the catalog-adapter registration (picker visibility off).
  registerCatalog: true,
  // Namespace key for llm.registerModelDiscovery (settings Models page discovery).
  settingsNs: 'claude-driver',
  // Reuse the Claude Code session across steps of the same DSH session
  // (query({options:{resume}})) so follow-up turns skip the cold boot and only
  // send the new user tail. Mapping lives in-process; a DSH restart clears it
  // and the next turn pays one fresh boot (expected).
  resumeChain: true,
  // Token-level streaming (includePartialMessages) so text/thinking render as
  // they are generated instead of per completed block.
  partialStream: true,
  // Emit a lightweight text-delta progress line for every internal tool_use
  // Claude Code performs (SDK does not stream those otherwise). Bridged DSH
  // tools already render native cards and Claude Code narrates in its own text,
  // so this narration is redundant noise by default — disable with
  // showToolProgress:false (it is already off by default).
  showToolProgress: false,
  // Native DSH tool cards for bridged tools: around every bridged
  // tools.execute, append the same durable `tool/call` + `tool/result`
  // session-event pair the DSH agent loop writes for its own scheduled calls
  // (dsh-agent-loop appendToolCall/appendToolResult, lib/index.js:292-317), so
  // the GUI renders native tool cards instead of the text progress line.
  // Research verdict: safe to write mid-model-step — the session invariant
  // (dsh-session invariant.js:58-79) only requires the named turn/step to be
  // the open one and the result to cite a pending callId via
  // sourceEventSeqs; the conversation UI keys cards purely on callId; no
  // consumer anchors tool events to the assistant message. Text progress
  // (showToolProgress) remains the fallback for Claude built-in tools and for
  // contexts without an appendable session. Disable with nativeToolCards:false.
  nativeToolCards: true,
  // Bridge Claude built-in tools (Bash/Edit/Write/WebFetch/…) into DSH's
  // approval service (approval.request → the "拒绝/允许一次" card). Default
  // false: the DSH approval wire schema only supports one-shot grants, so
  // every Bash call would raise a fresh prompt — opt in per deployment.
  approveBuiltinTools: false,
  // Read-only built-ins that skip the approval prompt even when
  // approveBuiltinTools is on (prompt-fatigue control). Override via config.
  builtinAllowlist: ['Read', 'Grep', 'Glob'],
}

// DSH sessionId -> Claude Code session_id, for the resume chain. Module-level
// on purpose: survives across llm/stream calls, cleared on process restart.
const resumeSessions = new Map()

// Test/diagnostic access to the resume chain (do not mutate in production).
export function getResumeSessions() {
  return resumeSessions
}

// One session/event observation: a committed compaction summary invalidates
// the session's resume mapping (the Claude-side context predates the
// compaction). Returns whether a mapping was actually dropped. `sessions` is
// injectable for tests; production uses the module-level map.
export function clearResumeOnCompaction(session, event, sessions = resumeSessions) {
  if (event?.type !== 'compaction/summary') return false
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || !sessionId) return false
  return sessions.delete(sessionId)
}

// /claude-fresh command definition (dsh-commands register contract: name must
// match /^[a-z][a-z0-9_-]*$/, non-empty description, handler receiving the
// frozen {commandId, agent, rawInput, signal} invocation and returning a
// CommandResult {kind:'success'|'error', text}).
export function createClaudeFreshCommand(sessions = resumeSessions) {
  return {
    name: 'claude-fresh',
    description: 'Start a fresh Claude Code session on the next turn (drop the resume chain)',
    handler(invocation) {
      const sessionId = invocation?.agent?.session?.id
      if (typeof sessionId !== 'string' || !sessionId) {
        return { kind: 'error', text: 'claude-fresh: no session is attached to this command invocation.' }
      }
      const dropped = sessions.delete(sessionId)
      return {
        kind: 'success',
        text: dropped
          ? 'Claude Code resume chain cleared. The next turn starts a fresh Claude Code session and replays the (possibly compacted) conversation history.'
          : 'No Claude Code resume session recorded for this conversation; the next turn already starts fresh.',
      }
    },
  }
}

// Internal LLM calls that must not touch (or ride on) the user-facing chain.
const INTERNAL_PURPOSES = new Set(['compaction', 'session-title'])

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  // approveBuiltinTools relies on the CLI actually consulting canUseTool;
  // bypassPermissions (and the legacy dontAsk) skip the permission bridge
  // entirely, so the combination silently disables the DSH approval path.
  if (settings.approveBuiltinTools === true && ['bypassPermissions', 'dontAsk'].includes(settings.permissionMode)) {
    ctx.logger?.warn?.(
      `claude-driver: approveBuiltinTools is on but permissionMode "${settings.permissionMode}" never consults canUseTool — built-in tools will NOT reach DSH approval`,
    )
  }
  ctx.on('llm/stream', (options, next) => {
    if (options?.provider !== settings.provider) return next()
    return streamClaudeChunks(ctx, options, settings)
  }, { global: true })

  // Resume-chain hygiene: when DSH compaction lands on a session
  // (`compaction/summary`, the committed-summary record dsh-compaction-basic
  // appends; dsh-session lists it in the event vocabulary), the DSH surface
  // just shrank — but a resumed Claude Code session would still carry the full
  // pre-compaction context. Drop the resume mapping so the next turn boots a
  // fresh Claude session over the compacted derived history (renderPrompt
  // replays it in full). Listener args are (session, event), exactly what
  // dsh-session's append() publishes on the `session/event` firehose.
  ctx.on('session/event', (session, event) => {
    if (clearResumeOnCompaction(session, event)) {
      ctx.logger?.info?.(`claude-driver: compaction landed on session ${session.id}; the next turn starts a fresh Claude Code session over the compacted history`)
    }
  }, { global: true })

  // Manual escape valve: /claude-fresh drops the current session's resume
  // mapping on demand. Registered via a scoped inject fiber for the same
  // late-service reason as the subagent provider below; dsh-command-compact
  // (the shipped /compact) is the registration template.
  const registerCommands = (scopedCtx) => {
    try {
      const commands = scopedCtx.get('commands')
      if (!commands || typeof commands.register !== 'function') {
        ctx.logger?.warn?.('claude-driver: commands service unavailable; /claude-fresh not registered')
        return
      }
      commands.register(createClaudeFreshCommand())
      ctx.logger?.info?.('claude-driver: registered /claude-fresh command')
    } catch (error) {
      ctx.logger?.warn?.('claude-driver: failed to register /claude-fresh', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], registerCommands)
  } else {
    registerCommands(ctx)
  }

  // Host-plane subagent backend filling the seam reserved by the shipped
  // `tool-subagent-claude-code` row (product providers are host singletons).
  //
  // Timing: this row may activate before the row providing the `subagents`
  // service. `ctx.get()` is strict (returns undefined unless the providing
  // fiber is active) and cordis only re-evaluates fibers that declare the
  // service in `inject` (reflect.notify skips everyone else), so a bare
  // `ctx.get()` at apply-time silently misses a late-arriving service forever.
  // Register inside a scoped `ctx.inject()` child fiber instead — it waits for
  // the service and re-runs if the service is ever re-provided. This mirrors
  // the shipped dsh-subagent-spawn-in-process host row (`inject: ['subagents']`).
  const registerSubagentProvider = (scopedCtx) => {
    try {
      const subagents = scopedCtx.get('subagents')
      if (!subagents) {
        ctx.logger?.warn('claude-driver: subagents service unavailable; claude-code subagent provider not registered')
        return
      }
      if (subagents.getProvider('claude-code') !== undefined) {
        ctx.logger?.info('claude-driver: a "claude-code" subagent provider is already registered; skipping')
        return
      }
      subagents.registerProvider(createClaudeCodeProvider(settings))
      ctx.logger?.info('claude-driver: registered "claude-code" subagent provider')
    } catch (error) {
      ctx.logger?.warn('claude-driver: failed to register "claude-code" subagent provider', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    if (ctx.get('subagents') === undefined) {
      ctx.logger?.warn('claude-driver: subagents service not yet available; deferring claude-code provider registration until it is provided')
    }
    ctx.inject(['subagents'], registerSubagentProvider)
  } else {
    // Standalone/mock contexts (tests) have no cordis registry mixin.
    registerSubagentProvider(ctx)
  }

  // Session model-picker visibility. The picker catalog (session.models RPC ->
  // buildModelCatalog) lists only routes with a registered llm adapter, and
  // session.selectModel / the turn-start routeServed() guard require one too.
  // Streaming is unaffected: llm.stream()/prepareCall().stream() run the
  // `llm/stream` waterfall first, where the listener above short-circuits into
  // the Claude Agent SDK — the catalog adapter's stream() never executes.
  const registerModelCatalog = (scopedCtx) => {
    if (settings.registerCatalog === false) return
    try {
      const llm = scopedCtx.get('llm')
      if (!llm || typeof llm.registerAdapter !== 'function') {
        ctx.logger?.warn('claude-driver: llm service unavailable; claude-code will not appear in the model selector')
        return
      }
      if (llm.listProviders().some((entry) => entry.id === settings.provider)) {
        ctx.logger?.info(`claude-driver: an adapter already serves provider "${settings.provider}"; skipping catalog registration`)
      } else {
        llm.registerAdapter([settings.provider], createClaudeCodeAdapter(settings))
        ctx.logger?.info(`claude-driver: registered "${settings.provider}" model catalog (${(settings.models ?? []).length} models)`)
      }
      if (typeof llm.registerModelDiscovery === 'function') {
        try {
          llm.registerModelDiscovery(settings.settingsNs, createModelDiscovery(settings))
        } catch (error) {
          ctx.logger?.warn(`claude-driver: model discovery for "${settings.settingsNs}" not registered`, error)
        }
      }
    } catch (error) {
      ctx.logger?.warn('claude-driver: failed to register the claude-code model catalog', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], registerModelCatalog)
  } else {
    registerModelCatalog(ctx)
  }
}

function envWithProxy(proxy) {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP }
  if (proxy) {
    env.HTTPS_PROXY = proxy
    env.HTTP_PROXY = proxy
    env.ALL_PROXY = proxy
    env.NO_PROXY = 'localhost,127.0.0.1,::1'
  }
  return env
}

function resolveCwd(ctx, settings) {
  if (settings.cwd) return settings.cwd
  try {
    const agents = ctx.get('agents')
    const agent = agents?.currentInitiator?.()
    const cwd = agent?.session?.meta?.cwd ?? agent?.options?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  } catch {
    // optional service missing or wrong shape — fall through
  }
  return process.cwd()
}

function renderToolResult(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => (block?.type === 'text' && block.text ? block.text : JSON.stringify(block))).join('\n')
  }
  return JSON.stringify(content)
}

function renderMessageBody(message) {
  const body = []
  for (const block of message?.content ?? []) {
    if (block.type === 'text' && block.text) body.push(block.text)
    else if (block.type === 'tool-call') body.push(`[tool-call ${block.name}(${block.arguments})]`)
    else if (block.type === 'tool-result') body.push(`[tool-result ${block.toolCallId}]: ${renderToolResult(block.content)}`)
  }
  return body
}

function renderPrompt(options) {
  const parts = []
  const system = typeof options?.system === 'string' ? options.system.trim() : ''
  if (system) parts.push(`<dsystem>\n${system}\n</dsystem>`)
  for (const message of options?.messages ?? []) {
    const role = message.role === 'assistant' ? 'Assistant' : 'User'
    const body = renderMessageBody(message)
    if (body.length) parts.push(`<${role}>\n${body.join('\n\n')}\n</${role}>`)
  }
  if (!parts.length) parts.push('<User>\n(no conversation history)\n</User>')
  parts.push('<Assistant>')
  return parts.join('\n\n')
}

// Trailing messages after the last assistant turn: the new user message plus
// any steering tail. This is all a resumed Claude session still needs — it
// already remembers everything before it.
export function extractResumeTail(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = list.length
  while (start > 0 && list[start - 1]?.role !== 'assistant') start -= 1
  return list.slice(start)
}

function renderResumePrompt(tail) {
  if (tail.length === 1 && tail[0]?.role !== 'assistant') {
    const body = renderMessageBody(tail[0])
    if (body.length) return body.join('\n\n')
  }
  const parts = []
  for (const message of tail) {
    const role = message.role === 'assistant' ? 'Assistant' : 'User'
    const body = renderMessageBody(message)
    if (body.length) parts.push(`<${role}>\n${body.join('\n\n')}\n</${role}>`)
  }
  return parts.join('\n\n')
}

// Decide fresh-vs-resume for one llm/stream call. `sessions` is injectable for
// tests; production uses the module-level map. Fresh calls send the full
// rendered history (system included); resume calls send only the new tail —
// the system text was already delivered on the fresh boot and Claude keeps it.
export function planPrompt(options, settings, sessions = resumeSessions) {
  const key = typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : undefined
  const chainKey =
    settings?.resumeChain !== false && key !== undefined && !INTERNAL_PURPOSES.has(options?.purpose)
      ? key
      : undefined
  const resumeId = chainKey !== undefined ? sessions.get(chainKey) : undefined
  if (resumeId !== undefined) {
    const tail = extractResumeTail(options?.messages)
    const prompt = tail.length ? renderResumePrompt(tail) : ''
    if (prompt.trim()) return { mode: 'resume', resumeId, chainKey, prompt }
  }
  return { mode: 'fresh', chainKey, prompt: renderPrompt(options) }
}

// How much of a completed block still needs emitting after token-level partial
// deltas already streamed `streamed` of it. Prefix mismatch means the partials
// covered content this particular assistant message does not (e.g. the SDK
// split one API message across several assistant messages) — emit nothing
// rather than duplicate.
// Progress line for one internal Claude Code tool_use block. Plain text on the
// existing text block, so no new chunk/block types are involved.
export function renderToolProgress(toolName) {
  // MCP-bridged tools surface as mcp__<server>__<tool>; show the bare name.
  const bare = typeof toolName === 'string' ? toolName.replace(/^mcp__.+?__/, '') : ''
  return `\n[Claude Code] 正在调用工具 ${bare || '(unknown)'}…\n`
}

export function remainderAfterPartial(full, streamed) {
  if (!full) return ''
  if (!streamed) return full
  return full.startsWith(streamed) ? full.slice(streamed.length) : ''
}

function usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) {
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

function classifyFailure(message) {
  const text = String(message)
  if (/\b(?:401|403)\b/.test(text)) return 'AUTH'
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/\b400\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(text)) return 'SERVER'
  if (/time(?:d)?\s*out|timeout/i.test(text)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|ENOTFOUND|ECONN)\b/i.test(text)) return 'TRANSPORT'
  return 'CLAUDE_CODE_ERROR'
}

function toSdkToolResult(result) {
  const content = result?.content ?? []
  const text = Array.isArray(content)
    ? content.map((block) => (block?.type === 'text' && block.text ? block.text : JSON.stringify(block))).join('\n')
    : JSON.stringify(content)
  return result?.isError ? `Error: ${text}` : text
}

// DSH tool schemas are a restricted JSON-Schema subset; the SDK's tool()
// helper wants a zod raw shape. Convert the subset DSH actually emits.
function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== 'object') return z.record(z.unknown())
  if (schema.oneOf || schema.anyOf || Array.isArray(schema.type)) {
    const variants = (schema.oneOf ?? schema.anyOf ?? schema.type.map((type) => ({ ...schema, type })))
      .map((variant) => jsonSchemaToZod(variant))
    return z.union(variants.length ? variants : [z.unknown()])
  }
  switch (schema.type) {
    case 'string':
      if (Array.isArray(schema.enum) && schema.enum.length) return z.enum(schema.enum)
      return z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array':
      return z.array(schema.items ? jsonSchemaToZod(schema.items) : z.unknown())
    case 'object': {
      const shape = {}
      const required = new Set(schema.required ?? [])
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        const child = jsonSchemaToZod(value)
        shape[key] = required.has(key) ? child : child.optional()
      }
      return z.object(shape)
    }
    default:
      return z.record(z.unknown())
  }
}

// ---------------------------------------------------------------------------
// Native tool cards (nativeToolCards): durable tool/call + tool/result events
// for bridged DSH tools, mirroring dsh-agent-loop's appendToolCall /
// appendToolResult exactly so the invariant machine, the surface projection,
// and the GUI card matcher treat them as first-class tool activity.
// ---------------------------------------------------------------------------

// The currently open turn/step, read from the committed log (the same state
// machine the session invariant tracks): the last `step/start` not yet closed
// by a `step/end`/`turn/end`. Returns undefined between steps — a card append
// there would violate the requireOpenStep invariant, so callers skip it.
export function openStepPosition(session) {
  const events = session?.events
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'step/start') return { turn: event.data.turn, step: event.data.step }
    if (event?.type === 'step/end' || event?.type === 'turn/end') return undefined
  }
  return undefined
}

function mintMessageId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `claude-msg-${Math.random().toString(36).slice(2)}`
}

// Same shape as dsh-llm's createToolResultMessage (user-role message with a
// `tool` source and one tool-result block) — the invariant reads
// message.source.callId and message.content[0].isError; the UI card reads the
// block's content/isError; deriveMessages serves the whole message.
export function buildToolResultMessage(callId, content, isError) {
  const id = mintMessageId()
  return {
    id,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
  }
}

// Paired assistant message carrying the tool-call block, mirroring dsh-llm's
// createAssistantMessage (role 'assistant', source {kind:'model',...}) with
// the exact block shape the agent loop assembles ({type:'tool-call', id, name,
// arguments:<raw JSON string>} — dsh-llm BlockAssembler). Without it the
// derived history contains only orphan tool-result user messages: after a
// model switch, dsh-llm-deepseek's serializeMessages expands each into a bare
// {role:'tool', tool_call_id} wire message with no pairing assistant
// tool_calls entry → the server 400s every turn with no self-healing.
export function buildAssistantToolCallMessage(callId, name, rawArguments, source) {
  return {
    id: mintMessageId(),
    role: 'assistant',
    source: { kind: 'model', ...(source ?? {}) },
    content: [{ type: 'tool-call', id: callId, name, arguments: rawArguments }],
  }
}

// Append the card-opening tool/call event. `arguments` must be the raw JSON
// string (the api-proxy presenter path JSON.parses it before presentCall).
// Returns the anchor {turn, step, seq} the result event must cite, or
// undefined when no step is open or the append was rejected (invariant/log
// error) — the tool still executes, only the card is skipped.
function appendToolCallCard(ctx, session, callId, name, args, source) {
  const position = openStepPosition(session)
  if (!position || typeof session?.append !== 'function') return undefined
  const rawArguments = JSON.stringify(args ?? {})
  let anchor
  try {
    const event = session.append('tool/call', {
      turn: position.turn,
      step: position.step,
      callId,
      name,
      arguments: rawArguments,
    })
    anchor = { turn: position.turn, step: position.step, seq: event.seq }
  } catch (error) {
    ctx?.logger?.warn?.(`claude-driver: tool/call card for ${name} not appended`, error)
    return undefined
  }
  // Cross-model pairing event: an assistant/message whose sole content is the
  // tool-call block. Mid-step assistant/message appends are legal (the session
  // invariant only requires the named turn/step to be the open one) and empty
  // sourceEventSeqs is explicitly allowed for assistant/message
  // (dsh-session assertProvenance). It enters the derived surface, so the
  // upcoming tool-result is no longer an orphan when another provider
  // serializes the history; on the Claude route the driver's own
  // renderMessageBody renders it as a `[tool-call ...]` line (accepted).
  // Failure here degrades to a warn — the card and the tool run regardless.
  try {
    session.append(
      'assistant/message',
      {
        turn: position.turn,
        step: position.step,
        message: buildAssistantToolCallMessage(callId, name, rawArguments, source),
      },
      { surfaceOp: 'append', sourceEventSeqs: [] },
    )
  } catch (error) {
    ctx?.logger?.warn?.(`claude-driver: assistant tool-call pairing event for ${name} not appended`, error)
  }
  return anchor
}

// Close the card: tool/result in the same turn/step, surfaceOp append,
// sourceEventSeqs citing the call event (the loop's exact contract). Skipped
// when the step already closed (late tool settle after abort) — the UI then
// projects the dangling call as interrupted, matching native behavior.
function appendToolResultCard(ctx, session, card, callId, result) {
  const position = openStepPosition(session)
  if (!position || position.turn !== card.turn || position.step !== card.step) return false
  const message = buildToolResultMessage(callId, result?.content ?? [], result?.isError === true)
  try {
    session.append(
      'tool/result',
      {
        turn: card.turn,
        step: card.step,
        message,
        ...(result?.error?.info ? { error: result.error.info } : {}),
        ...(result?.meta !== undefined ? { meta: result.meta } : {}),
      },
      { surfaceOp: 'append', sourceEventSeqs: [card.seq] },
    )
    return true
  } catch (error) {
    ctx?.logger?.warn?.(`claude-driver: tool/result card for ${callId} not appended`, error)
    return false
  }
}

// Bridge DSH tool schemas into Claude SDK custom tools via an in-process MCP
// server (SDK 0.3.x registers custom tools through mcpServers, not a raw
// `tools` array). Approval/guards for these tools stay inside DSH's own
// tools/pre-execute pipeline; permission decisions (including Claude
// built-ins) live in buildCanUseTool below, assembled separately so it works
// with or without a bridge. Exported for the mock card tests.
export function buildToolBridge(ctx, options, settings, controller) {
  if (settings.bridgeTools === false) return null
  const schemas = Array.isArray(options?.tools) ? options.tools : []
  if (!schemas.length) return null
  const tools = ctx.get('tools')
  const agents = ctx.get('agents')
  if (!tools || !agents) return null
  const dsdNames = new Set(schemas.map((schema) => schema.name))
  // Build-time initiator: buildToolBridge runs inside the agent loop's model
  // step (llm/stream), so currentInitiator() is the calling agent. Captured as
  // the card-capability probe and per-call fallback (SDK transport callbacks
  // may run outside the initiator's async context).
  const cardAgent = agents.currentInitiator?.()
  const cardsEnabled = settings.nativeToolCards !== false && typeof cardAgent?.session?.append === 'function'
  // Model source for the assistant tool-call pairing message (dsh-llm
  // createAssistantMessage carries {kind:'model', provider, model}).
  const cardSource = {
    provider: settings.provider ?? 'claude-code',
    model: (typeof options?.model === 'string' && options.model) || settings.model || 'claude-code',
  }
  const handlers = new Map()
  const sdkTools = schemas.map((schema) => {
    const run = async (input) => {
      const agent = agents.currentInitiator?.() ?? cardAgent
      if (!agent) throw new Error(`DSH tool ${schema.name}: no initiating agent`)
      const callId = `claude-${Math.random().toString(36).slice(2)}`
      const session = settings.nativeToolCards !== false ? agent.session : undefined
      // Open the native card before execution so approval prompts and long
      // runs are visible under it, exactly like loop-scheduled calls.
      const card = session ? appendToolCallCard(ctx, session, callId, schema.name, input ?? {}, cardSource) : undefined
      let result
      try {
        result = await tools.execute({
          callId,
          name: schema.name,
          arguments: input ?? {},
          agent,
          signal: controller.signal,
        })
      } catch (error) {
        // tools.execute materializes tool failures; a throw here is a harness
        // fault — still close the card so it never spins forever.
        if (card) {
          const message = String(error?.message ?? error)
          appendToolResultCard(ctx, session, card, callId, {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
            error: { message },
          })
        }
        throw error
      }
      if (card) appendToolResultCard(ctx, session, card, callId, result)
      const text = toSdkToolResult(result)
      return {
        content: [{ type: 'text', text }],
        isError: result?.isError === true,
      }
    }
    handlers.set(schema.name, run)
    return tool(schema.name, schema.description ?? '', jsonSchemaToZod(schema.parameters), run, { alwaysLoad: true })
  })
  const server = createSdkMcpServer({ name: 'dsh-tools', version: '1.0.0', tools: sdkTools, alwaysLoad: true })
  // Whether a Claude-side tool_use name (possibly mcp__<server>__-prefixed)
  // maps to a bridged DSH tool that will render a native card — the text
  // progress line is suppressed for exactly these.
  const rendersCard = (toolName) => {
    if (!cardsEnabled) return false
    if (typeof toolName !== 'string') return false
    return dsdNames.has(toolName) || dsdNames.has(toolName.replace(/^mcp__.+?__/, ''))
  }
  return { mcpServers: [server], bridgedNames: dsdNames, rendersCard, handlers }
}

// ---------------------------------------------------------------------------
// canUseTool: SDK permission callback, assembled independently of the tool
// bridge so Claude built-in tools reach DSH approval even when no DSH tools
// are bridged. The SDK contract is fail-closed on null (no control_response →
// the tool blocks forever with no deadline), so EVERY path here returns a
// concrete allow/deny — never null, never a thrown error.
// ---------------------------------------------------------------------------

// Human-readable reason for the approval card, preferring the SDK bridge's own
// prompt sentence (options.title) over anything we could reconstruct.
export function buildApprovalReason(toolName, info) {
  const parts = []
  if (typeof info?.title === 'string' && info.title.trim()) parts.push(info.title.trim())
  else if (typeof info?.displayName === 'string' && info.displayName.trim()) parts.push(info.displayName.trim())
  if (typeof info?.decisionReason === 'string' && info.decisionReason.trim()) parts.push(info.decisionReason.trim())
  if (!parts.length) return `Claude Code built-in tool: ${toolName}`
  return parts.join(' — ')
}

/**
 * Build the SDK canUseTool callback.
 * - Bridged DSH tools (bare or mcp__<server>__-prefixed): always allow — DSH's
 *   own tools/pre-execute → approval pipeline governs them (allowing here
 *   avoids a double prompt).
 * - Claude built-ins: allow when approveBuiltinTools is off or the tool is in
 *   builtinAllowlist; otherwise bridge to approval.request(). Only
 *   'allowed-once' grants; rejected/cancelled/unavailable (and a missing
 *   approval service or initiating agent) deny with the reason in `message`.
 */
export function buildCanUseTool(ctx, settings, controller, bridgedNames) {
  const names = bridgedNames instanceof Set ? bridgedNames : new Set(bridgedNames ?? [])
  const allowlist = new Set(
    Array.isArray(settings?.builtinAllowlist) ? settings.builtinAllowlist : DEFAULTS.builtinAllowlist,
  )
  // Build-time initiator fallback: this runs inside the agent loop's model
  // step, but SDK transport callbacks may later fire outside the initiator's
  // async context (same rationale as the bridge's cardAgent).
  let cardAgent
  try {
    cardAgent = ctx.get('agents')?.currentInitiator?.()
  } catch {
    cardAgent = undefined
  }
  const isBridged = (toolName) =>
    names.has(toolName) || [...names].some((name) => toolName.endsWith(`__${name}`))
  return async (toolName, input, info) => {
    const allow = { behavior: 'allow', updatedInput: input }
    try {
      if (typeof toolName !== 'string' || isBridged(toolName)) return allow
      if (settings?.approveBuiltinTools !== true || allowlist.has(toolName)) return allow
      let approval
      let agent
      try {
        approval = ctx.get('approval')
        agent = ctx.get('agents')?.currentInitiator?.() ?? cardAgent
      } catch {
        // strict/missing service lookups fall through to the fail-closed deny
      }
      if (agent === undefined) agent = cardAgent
      if (!approval || typeof approval.request !== 'function') {
        return { behavior: 'deny', message: `DSH approval service unavailable; built-in tool ${toolName} denied (fail closed).` }
      }
      if (!agent) {
        return { behavior: 'deny', message: `No initiating DSH agent for approval; built-in tool ${toolName} denied (fail closed).` }
      }
      const reason = buildApprovalReason(toolName, info)
      const outcome = await approval.request({
        agent,
        toolName,
        ...(typeof info?.toolUseID === 'string' && info.toolUseID ? { callId: info.toolUseID } : {}),
        reason,
        signal: info?.signal ?? controller?.signal,
      })
      if (outcome === 'allowed-once') return allow
      const detail =
        outcome === 'rejected'
          ? 'the user rejected this tool call'
          : outcome === 'cancelled'
            ? 'the approval request was cancelled'
            : 'no approval answerer was available (fail closed)'
      return { behavior: 'deny', message: `DSH approval: ${detail} (${toolName}).` }
    } catch (error) {
      // approval.request throws outside an open turn or on audit-append
      // failure — deny rather than hang the tool (null) or kill the stream.
      return { behavior: 'deny', message: `DSH approval bridge error for ${toolName}: ${String(error?.message ?? error)}` }
    }
  }
}

export async function* streamClaudeChunks(ctx, options, settings) {
  const controller = new AbortController()
  const signal = options?.signal
  const onAbort = () => controller.abort()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  let openedText = false
  let openedReasoning = false
  let text = ''
  // Model-authored text only (excludes showToolProgress lines), so progress
  // chatter never masks an empty response nor suppresses the result fallback.
  let realText = ''
  let reasoning = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheWrite = 0
  let failure
  let maxTurnsHit = false

  let plan = planPrompt(options, settings)

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      failure = undefined
      maxTurnsHit = false
      let sdkSessionId
      // Text/thinking already emitted via partial deltas for the in-flight API
      // message; used to dedupe against the complete assistant message.
      let pmText = ''
      let pmReasoning = ''
      try {
        const sdkOptions = {
          cwd: resolveCwd(ctx, settings),
          // The session's current selection (set via the model picker) rides on the
          // call options; settings only provide the fallback default.
          model: (typeof options?.model === 'string' && options.model) || settings.model,
          permissionMode: settings.permissionMode,
          maxTurns: settings.maxTurns,
          effort: (typeof options?.reasoningEffort === 'string' && options.reasoningEffort) || settings.effort,
          allowedTools: settings.allowedTools,
          abortController: controller,
          env: envWithProxy(settings.proxy),
        }
        if (plan.mode === 'resume') sdkOptions.resume = plan.resumeId
        if (settings.partialStream !== false) sdkOptions.includePartialMessages = true
        const executable = resolveClaudeExecutable(settings.pathToClaudeCodeExecutable)
        if (executable) sdkOptions.pathToClaudeCodeExecutable = executable
        const bridge = buildToolBridge(ctx, options, settings, controller)
        if (bridge) sdkOptions.mcpServers = bridge.mcpServers
        // canUseTool is assembled independently of the bridge: with bridged
        // DSH tools it must allow them through (DSH pipeline owns approval),
        // and with approveBuiltinTools on it must install even when NO DSH
        // tools are bridged. When neither applies, leave the SDK's default
        // permission handling (permissionMode) untouched.
        if (bridge || settings.approveBuiltinTools === true) {
          sdkOptions.canUseTool = buildCanUseTool(ctx, settings, controller, bridge?.bridgedNames)
        }
        // Test seam: inject a fake SDK query (no network) via settings.queryImpl.
        const runQuery = typeof settings.queryImpl === 'function' ? settings.queryImpl : query
        const q = runQuery({
          prompt: plan.prompt,
          options: sdkOptions,
        })
        for await (const msg of q) {
          if (typeof msg.session_id === 'string' && msg.session_id) sdkSessionId = msg.session_id
          if (msg.type === 'stream_event') {
            // Token-level streaming: one Anthropic Messages API stream event
            // per SDKPartialAssistantMessage. Only top-level output (subagent
            // partials carry parent_tool_use_id).
            if (msg.parent_tool_use_id) continue
            const event = msg.event
            if (event?.type === 'message_start') {
              pmText = ''
              pmReasoning = ''
            } else if (event?.type === 'content_block_delta') {
              const delta = event.delta
              if (delta?.type === 'text_delta' && delta.text) {
                if (!openedText) {
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                  openedText = true
                }
                text += delta.text
                realText += delta.text
                pmText += delta.text
                yield { type: 'text-delta', index: 0, text: delta.text }
              } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                if (!openedReasoning) {
                  yield { type: 'block-start', index: 1, blockType: 'reasoning' }
                  openedReasoning = true
                }
                reasoning += delta.thinking
                pmReasoning += delta.thinking
                yield { type: 'reasoning-delta', index: 1, text: delta.thinking }
              }
            }
          } else if (msg.type === 'assistant' && !msg.error) {
            // Whole-block fallback: with partial streaming active the complete
            // assistant message repeats what the deltas already carried, so
            // emit only the not-yet-streamed remainder (all of it when partial
            // streaming is off or produced nothing).
            let msgText = ''
            let msgReasoning = ''
            const toolUses = []
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'text' && block.text) msgText += block.text
              else if (block.type === 'thinking' && block.thinking) msgReasoning += block.thinking
              else if (block.type === 'tool_use') toolUses.push(block)
            }
            const tailText = remainderAfterPartial(msgText, pmText)
            if (tailText) {
              if (!openedText) {
                yield { type: 'block-start', index: 0, blockType: 'text' }
                openedText = true
              }
              text += tailText
              realText += tailText
              yield { type: 'text-delta', index: 0, text: tailText }
            }
            const tailReasoning = remainderAfterPartial(msgReasoning, pmReasoning)
            if (tailReasoning) {
              if (!openedReasoning) {
                yield { type: 'block-start', index: 1, blockType: 'reasoning' }
                openedReasoning = true
              }
              reasoning += tailReasoning
              yield { type: 'reasoning-delta', index: 1, text: tailReasoning }
            }
            // Internal-activity visibility: Claude Code's tool loop is otherwise
            // silent on the DSH side. Emit one lightweight progress line per
            // tool_use on the same text block (index 0). Only here, in the
            // whole-message branch (partials never carry tool blocks, so the
            // pmText dedupe stays untouched), and only for top-level messages
            // (subagent traffic carries parent_tool_use_id).
            if (settings.showToolProgress !== false && !msg.parent_tool_use_id) {
              for (const toolUse of toolUses) {
                // Bridged DSH tools render a native tool/call+tool/result card
                // (nativeToolCards) — no text narration on top. Claude
                // built-in tools keep the text fallback.
                if (bridge?.rendersCard?.(toolUse.name)) continue
                const progress = renderToolProgress(toolUse.name)
                if (!openedText) {
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                  openedText = true
                }
                text += progress
                yield { type: 'text-delta', index: 0, text: progress }
              }
            }
          } else if (msg.type === 'result') {
            const usage = msg.usage ?? {}
            inputTokens = Number(usage.input_tokens ?? 0)
            outputTokens = Number(usage.output_tokens ?? 0)
            cacheRead = Number(usage.cache_read_input_tokens ?? 0)
            cacheWrite = Number(usage.cache_creation_input_tokens ?? 0)
            if (msg.subtype === 'success') {
              // Fallback on model text only: progress lines alone must not
              // suppress recovery of the final result text.
              if (!realText && typeof msg.result === 'string' && msg.result.trim()) {
                const fallback = msg.result.trim()
                realText = fallback
                if (openedText) {
                  // Progress lines already opened block 0 — stream the result
                  // as a delta so block-end stays the sum of deltas.
                  text += fallback
                  yield { type: 'text-delta', index: 0, text: fallback }
                } else {
                  text = fallback
                }
              }
            } else {
              const raw =
                typeof msg.result === 'string' && msg.result
                  ? msg.result
                  : typeof msg.error === 'string' && msg.error
                    ? msg.error
                    : msg.subtype
              failure = raw
              // error_max_turns is a budget truncation, not a transport/auth
              // failure — track it so we can hand back the partial work below.
              if (msg.subtype === 'error_max_turns' || /max[ _-]?turns?/i.test(String(raw))) maxTurnsHit = true
            }
            break
          }
        }
        if (failure === undefined && plan.chainKey !== undefined && typeof sdkSessionId === 'string' && sdkSessionId) {
          resumeSessions.set(plan.chainKey, sdkSessionId)
        }
      } catch (error) {
        failure = String(error?.message ?? error)
      }
      // Resume target expired/cleared: drop the mapping and retry fresh once —
      // but only if nothing streamed yet (no duplicated output) and the caller
      // did not abort.
      if (
        failure !== undefined &&
        plan.mode === 'resume' &&
        attempt === 0 &&
        !openedText &&
        !openedReasoning &&
        !signal?.aborted
      ) {
        resumeSessions.delete(plan.chainKey)
        ctx?.logger?.warn?.(`claude-driver: resume ${plan.resumeId} failed (${failure}); retrying fresh`)
        plan = { mode: 'fresh', chainKey: plan.chainKey, prompt: renderPrompt(options) }
        continue
      }
      break
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  // Truncation (error_max_turns) is not a hard failure: Claude Code already
  // produced partial output before running out of its internal turn budget.
  // Hand back that partial answer with a note instead of discarding it.
  if (maxTurnsHit && realText.trim()) {
    const note = `\n\n[Claude Code 达到本轮内部轮数上限（${settings.maxTurns ?? '?'}），以上为已完成的部分，回答可能不完整。]`
    if (!openedText) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      openedText = true
    }
    text += note
    yield { type: 'text-delta', index: 0, text: note }
    if (openedText) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (openedReasoning) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
    yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  if (failure !== undefined) {
    const aborted = signal?.aborted || /abort/i.test(String(failure))
    yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
    yield {
      type: 'finish',
      reason: aborted
        ? { kind: 'aborted', failure: { message: String(failure), code: 'ABORTED' } }
        : { kind: 'error', failure: { message: String(failure), code: classifyFailure(failure) } },
    }
    return
  }

  // Judge emptiness on model text only: a progress-only body (tool loop ran but
  // produced no answer) is still an empty response, exactly as before.
  if (!realText.trim()) {
    yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'claude-code returned an empty response', code: 'EMPTY_RESPONSE' } },
    }
    return
  }

  if (openedText) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  if (openedReasoning) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
  yield { type: 'usage', usage: usageChunk(inputTokens, outputTokens, cacheRead, cacheWrite) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
