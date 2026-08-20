// Locate a Claude Code CLI binary for the Agent SDK.
//
// The SDK resolves its native binary from OPTIONAL dependencies installed next
// to @anthropic-ai/claude-agent-sdk (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]`).
// When the shared node_modules was installed with `--omit=optional` (or the
// platform package was pruned), `query()` throws "Native CLI binary ... not
// found" unless `options.pathToClaudeCodeExecutable` is provided. This helper
// keeps SDK default behavior whenever the SDK's own binary resolves, and only
// then falls back to a globally installed Claude Code binary.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const requireFromHere = createRequire(import.meta.url)

let cached // undefined = not probed; null = nothing to override; string = explicit path

function sdkNativeBinaryResolves() {
  let sdkRequire
  try {
    sdkRequire = createRequire(requireFromHere.resolve('@anthropic-ai/claude-agent-sdk'))
  } catch {
    return false
  }
  const exe = process.platform === 'win32' ? '.exe' : ''
  const suffixes = process.platform === 'linux'
    ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
    : [`${process.platform}-${process.arch}`]
  for (const suffix of suffixes) {
    try {
      const found = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/claude${exe}`)
      if (existsSync(found)) return true
    } catch {
      // keep probing
    }
  }
  return false
}

function globalCandidates() {
  const candidates = []
  if (process.platform === 'win32') {
    const npmGlobal = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined
    if (npmGlobal) {
      const pkg = join(npmGlobal, 'node_modules', '@anthropic-ai', 'claude-code')
      candidates.push(
        join(pkg, 'node_modules', '@anthropic-ai', `claude-code-win32-${process.arch}`, 'claude.exe'),
        join(pkg, 'bin', 'claude.exe'),
      )
    }
  } else if (process.env.HOME) {
    candidates.push(
      join(process.env.HOME, '.local', 'bin', 'claude'),
      join(process.env.HOME, '.claude', 'local', 'claude'),
    )
  }
  return candidates
}

/**
 * Resolve the `pathToClaudeCodeExecutable` SDK option.
 * @param explicit — configured override (wins unconditionally).
 * @returns an absolute path when a fallback binary is needed and found,
 *   otherwise `undefined` (SDK default resolution is left untouched).
 */
export function resolveClaudeExecutable(explicit) {
  if (explicit) return explicit
  if (cached !== undefined) return cached ?? undefined
  if (sdkNativeBinaryResolves()) {
    cached = null
    return undefined
  }
  for (const candidate of globalCandidates()) {
    if (existsSync(candidate)) {
      cached = candidate
      return candidate
    }
  }
  cached = null
  return undefined
}
