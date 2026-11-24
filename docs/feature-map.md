# DSH ↔ Claude Code feature map

How each DSH feature reaches Claude Code on a `claude-code` session, and how
each Claude Code capability reaches DSH. Checked against DSH 0.2.x (latest,
next, alpha) and Claude Agent SDK 0.3.x. "Direct" means the DSH feature drives
Claude Code's own native equivalent.

Status: **direct** · **bridged** (DSH runs it; Claude calls it) · **limited** · **n/a**

## DSH → Claude Code

| DSH feature | Status | How |
|---|---|---|
| Model picker, reasoning effort | direct | Picker lists Claude Code's own `supportedModels()`; the selection is Claude's `model`/`effort`. |
| `/compact`, automatic compaction | direct | Claude's own `/compact` on the live session (same id); its summary is DSH's summary. |
| Plan-window stop (5-hour, weekly) | direct | At `usageStopPercent` (95% default) or `weeklyStopPercent` (98% default) the active turn ends at its next safe tool boundary, the goal pauses, the live session is compacted once, that Claude session is ended (`usageStopEndSession`, default on), and new Claude turns are refused until that window resets. |
| Native context autocompaction | direct | `compactAtTokens` (off by default): once a turn reports a context at least that large, the next turn end compacts the live session with Claude's own `/compact`, keeps the session, and re-arms only after the context drops below the threshold. |
| Permission mode / sandbox (`/permission`, presets) | direct | `danger-full-access`→`bypassPermissions`, `workspace-write`→`acceptEdits`, `read-only`→`plan`. |
| Approval (ask/never) | bridged | Bridged DSH tools run through DSH approval; `approveBuiltinTools` routes Claude built-ins through it too. |
| System prompt, persona, plan-mode policy, skills index, tool guidance | direct | DSH's system prompt becomes Claude's system prompt (appended to the `claude_code` preset), re-rendered every request so changes reach a resumed session. |
| AGENTS.md / workspace instructions, runtime context | direct | Delivered as conversation context exactly as DSH builds it. |
| Every DSH tool (bash, fs, search, web, jobs, goal, schedule, todo, skill, subagent, workflow, MCP-client tools, plugin tools) | bridged | One in-process MCP server `dsh-tools`; calls execute in DSH and render as native DSH tool cards. |
| Plan mode (`/plan`, `exit_plan_mode` review) | direct | DSH's plan policy is in Claude's system prompt and DSH's `exit_plan_mode` is bridged; Claude's own `EnterPlanMode`/`ExitPlanMode` are withheld so DSH's review UI is used. |
| Scheduling, todo list, web search/fetch | bridged | DSH tools are used; Claude's duplicates (`Cron*`, `TodoWrite`, `WebSearch`, `WebFetch`) are withheld while the DSH tool is offered (`preferDshTools: false` keeps both). |
| Goals (`/goal`, goal rounds) | bridged | Goal rounds start ordinary DSH turns, which run on Claude; goal tools are bridged. |
| Subagents (DSH `subagent`, delegation) | direct | A `claude-code` subagent provider runs DSH subagents on Claude Code. |
| Background jobs (`job_list`/`job_output`/`job_kill`, jobs panel) | direct | Claude's own background tasks are mirrored as DSH `claude-task` jobs; `job_kill` stops the real task. Only real top-level background tasks are reported in the reply (not foreground commands, a call's own error, or a subagent's inner tasks); stopped, failed, deadline and interrupted endings each have their own wording. |
| File attachments | direct | DSH file blocks become the same readable-path handle DSH gives every model; Claude reads them with its file tools. |
| Image attachments | direct | Sent to Claude as native image blocks. |
| `read_image` | bridged | DSH `read_image` is bridged like any other tool, and its image block crosses the MCP boundary as image content: the model sees pixels, and the read renders as a DSH tool card. Claude's own `Read` stays as a second path. |
| Ask-user questions | bridged | DSH `ask_user_question` card; Claude's own `AskUserQuestion` is withheld while it is offered. |
| Setup (`dsh plugin add`, `/claude-doctor`) | direct | The CLI is installed automatically only when missing (see README); `/claude-doctor` reports every dependency and the login state. |
| Session resume / fork | direct | One Claude session per DSH session (resume chain); `/claude-fresh` resets it. |
| Session title | bridged | DSH's title request runs on Claude as a one-shot (not on the user's chain). |
| Token meter / context % | direct | Real per-request usage from Claude; context windows from Claude's model info. |
| `/export`, `/feedback`, session log, telemetry, settings UI, sidebar, terminal, file browser | n/a | DSH-side features over the DSH session log; they work unchanged because every Claude turn is recorded as DSH events. |

## Claude Code → DSH

| Claude Code capability | Status | How |
|---|---|---|
| Streamed text and thinking | direct | Token-level text and reasoning blocks; redacted thinking shows a live heartbeat. |
| Built-in tools (Bash, Read, Edit, Write, Grep, Glob, WebFetch, WebSearch, ...) | direct | Rendered as DSH's own tool cards (`bash`, `read`, `edit`, `write`, `grep`, `glob`, `web_fetch`, `web_search`; others as a generic card), opened when the tool starts and closed with its output (Bash results end with DSH's `[exit code: N]` marker). A card still open when the turn ends is closed as interrupted. Optional DSH approval. |
| Liveness (no silent gaps) | direct | While Claude or a tool is quiet, a throttled "still working Ns — <tool: subject>" pulse appears in the thinking block (`pulseMs`); Claude's API retries (from the second) and its own compaction are announced as they happen. |
| Background tasks | direct | DSH jobs (see above). |
| Native compaction (`compact_boundary`) | direct | Driven by DSH compaction; Claude's own automatic compaction is reported as a note. |
| API errors (auth expired, billing, rate limit, overloaded, invalid request) | direct | End the DSH turn as a typed DSH error (`AUTH`, `RATE_LIMIT`, `SERVER`, `INVALID_REQUEST`) instead of an answer; auth errors say to run `claude /login`. |
| Permission denials, model refusal fallback, notifications | direct | Shown as notes in the reasoning block. |
| Network stalls / unreachable API | direct | Turn ends with a clear error (stall guard) instead of spinning. |
| Usage / context usage | direct | DSH usage chunk from Claude's per-request usage. |
| Claude slash commands (`/review`, `/init`, `/simplify`, ...) | limited | Not exposed as DSH commands. Claude Code skills still load inside Claude. |
| Claude MCP servers configured in `~/.claude` | limited | Usable by Claude inside its own turn; not registered as DSH tools. |
| Claude hooks, output styles, `CLAUDE.md` | limited | Apply inside Claude as usual; DSH does not see or edit them. |
| Claude file checkpoints / rewind | n/a | DSH's own workspace changes and checkpoints are the source of truth. |

## Verification

Every row marked direct or bridged has a test. Real-CLI end-to-end tests run
the real Claude Code CLI against a local Anthropic API double in CI; the
compaction, system-prompt, tool-list and file-attachment rows were also
verified on a real DSH host (headless profile) driving the real Claude CLI.
