import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeExecutable } from './claude-executable.js'

const CLIENT_APP = 'dsh-claude-driver/0.1.0'

const NO_START_CAPABILITIES = Object.freeze({
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

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

function isEnterableDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Mirror of dsh-subagent's resolveChildCwd semantics: configured override, else
// the delegating parent session's workspace cwd; fail loud instead of silently
// binding the child to the harness launch directory.
function resolveChildCwd(configured, parentCwd) {
  if (configured !== undefined) {
    if (!isAbsolute(configured) || !isEnterableDirectory(configured)) {
      throw new Error(`claude-code provider: config cwd is not an accessible absolute directory: ${configured}`)
    }
    return configured
  }
  if (typeof parentCwd !== 'string' || !isEnterableDirectory(parentCwd)) {
    throw new Error('claude-code provider: no working directory — configure `cwd` or delegate from a parent session that has one')
  }
  return parentCwd
}

function promptText(request) {
  const blocks = Array.isArray(request?.prompt) ? request.prompt : []
  return blocks
    .map((block) => (block?.type === 'text' && block.text ? block.text : JSON.stringify(block)))
    .join('\n\n')
}

/**
 * The `claude-code` SubagentProvider (fills the seam reserved by the shipped
 * `tool-subagent-claude-code` preset row). One delegation = one official Claude
 * Agent SDK query. The result promise never rejects: cancellation settles as
 * `stopReason: 'aborted'`, failures as `'error'`, success as `'completed'`.
 */
export function createClaudeCodeProvider(settings = {}) {
  const config = {
    model: 'fable',
    permissionMode: 'acceptEdits',
    maxTurns: 100,
    effort: 'high',
    proxy: 'http://127.0.0.1:7897',
    cwd: undefined,
    pathToClaudeCodeExecutable: undefined,
    ...settings,
  }
  return {
    name: 'claude-code',
    inheritsParentContext: false,
    capabilities: NO_START_CAPABILITIES,
    async start(request) {
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      request?.signal?.addEventListener('abort', onAbort, { once: true })

      const cwd = resolveChildCwd(config.cwd, request?.parent?.session?.meta?.cwd)
      let disposal
      const runId = `claude-code-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

      const result = (async () => {
        let output = ''
        try {
          const sdkOptions = {
            cwd,
            model: config.model,
            permissionMode: config.permissionMode,
            maxTurns: config.maxTurns,
            effort: config.effort,
            abortController: controller,
            env: envWithProxy(config.proxy),
          }
          const executable = resolveClaudeExecutable(config.pathToClaudeCodeExecutable)
          if (executable) sdkOptions.pathToClaudeCodeExecutable = executable
          const q = query({
            prompt: promptText(request),
            options: sdkOptions,
          })
          for await (const msg of q) {
            if (msg.type === 'assistant' && !msg.error) {
              for (const block of msg.message?.content ?? []) {
                if (block.type === 'text' && block.text) output += block.text
              }
            } else if (msg.type === 'result') {
              if (msg.subtype === 'success') {
                if (!output && typeof msg.result === 'string' && msg.result.trim()) output = msg.result
                return { output: [{ type: 'text', text: output.trim() }], stopReason: 'completed' }
              }
              const detail = typeof msg.result === 'string' && msg.result ? msg.result : msg.error ?? msg.subtype
              return {
                output: output.trim() ? [{ type: 'text', text: output.trim() }] : [],
                stopReason: controller.signal.aborted ? 'aborted' : 'error',
                ...(detail !== undefined ? { detail: String(detail) } : {}),
              }
            }
          }
          return { output: [{ type: 'text', text: output.trim() }], stopReason: 'completed' }
        } catch (error) {
          return {
            output: output.trim() ? [{ type: 'text', text: output.trim() }] : [],
            stopReason: controller.signal.aborted ? 'aborted' : 'error',
            detail: String(error?.message ?? error),
          }
        } finally {
          request?.signal?.removeEventListener('abort', onAbort)
        }
      })()

      return {
        id: runId,
        localAgent: undefined,
        result,
        dispose() {
          if (disposal !== undefined) return disposal
          request?.signal?.removeEventListener('abort', onAbort)
          controller.abort()
          disposal = Promise.resolve()
          return disposal
        },
      }
    },
  }
}
