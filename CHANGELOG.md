# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。变动记录于此。

## [Unreleased]

### Added
- **子代理随进程一起死掉时，产出可以捞回来了**（`harvestOrphanedSubagents`，默认开，
  新增 `lib/agent-harvest.js`）。`waitForBackgroundTasks` 只能让子代理熬过**正常结束**的
  一轮；调用方 abort（DSH 会话断开／重启／用户停止）会让运行循环在 `signal.aborted`
  上直接 break 并拆掉 transport，而进程被硬杀时**连 `finally` 都不会执行**。两种情况下
  子代理都死在半路，最终回复根本没生成——从委派方看就是「零交付」。

  但**回复没了，过程还在**：Claude Code 会边跑边把每个子代理写到
  `<claudeHome>/projects/<项目>/<sessionId>/subagents/agent-<id>.jsonl`。所以抢救是一次
  **读取**，不需要在「正在被杀死」这个最不可靠的时刻去 flush。

  机制是**预写标记**而不是退出钩子：某次运行首次报出存活的后台工作时，写一个标记记下
  它的 Claude 会话 id；正常收尾的运行删掉自己的标记；因此**任何残留标记都属于没能善终
  的运行**——包括被硬杀的那种，而这正是 `finally` 方案看不见的情况。下一次运行开始时
  清扫残留标记，把每个死掉子代理的最后一段 assistant 文本捞出来，按运行写一份报告到
  `$DSH_HOME/storages/claude-driver/recovered/`，并在本轮开头播报一行指向它。
  **抢救结果落在用户回来的那一轮**，也正是他们需要它的时刻。

  该旁白与后台任务旁白同规则：计入 `text`、不计入 `realText`，所以既不会掩盖空回复，也
  不会顶掉 result 兜底。新增 `test-agent-harvest.mjs`（内存 fs + `queryImpl` 缝，全离线）
  覆盖定位、解析、标记生命周期、抢救、自我豁免、TTL 清扫，以及驱动确实播报这六件事。

### Fixed
- **子代理（Task/Agent 工具）的正文与思考不再混进主模型回复**（`lib/index.js` 的整条
  assistant 消息分支）。Claude Code 内部起的子代理会产生自己的 `assistant` 消息，它们带
  `parent_tool_use_id`；驱动在**四处**里已有三处正确隔离了这类流量——token 级流式分支
  （`stream_event`）、per-request usage 采样、工具进度播报——唯独**整条消息的
  text/thinking 兜底路径**漏掉了这道判断。于是子代理的每一段回答正文和思考过程都被当成
  主模型输出，直接 yield 成 `text-delta` / `reasoning-delta` 灌进 DSH 的对话流：用户看到
  的是主模型突然开始复述一份根本不属于本轮对话的报告，思考栏里也混入了别人的推理。更隐蔽
  的是这些文本还被计入 `realText`，因此主模型即使**真的什么都没回答**，也会被子代理的文本
  顶掉空响应保护（`EMPTY_RESPONSE`）和 `result` 兜底，让一次实际失败的回合看上去「有输出」。
  现在在 usage 采样之后、文本累积之前提前 `continue`（写法与 `stream_event` 分支对称），
  子代理消息一律不进入主回复；工具进度那处原有的 `!msg.parent_tool_use_id` 守卫保留为冗余
  防御。`test-tool-progress.mjs` 新增三条离线断言：带 `parent_tool_use_id` 的
  text+thinking 消息不产生任何 delta、也不再掩盖空响应，而同样的消息去掉
  `parent_tool_use_id` 后仍正常流出。

- **后台任务播报不再把子代理的整篇报告塞进对话正文**（`lib/background-tasks.js` 新增
  `briefTaskSummary` / `MAX_TASK_SUMMARY_CHARS`）。CLI 的 `task_notification.summary`
  对 shell 后台任务是一句短状态，但对 Task/Agent 类任务**是子代理的完整报告全文**（动辄数
  千字）。`renderBackgroundNote` 此前把这个字段当短标题原样拼接，于是
  `[Claude Code 后台任务已结束：…]` 这行本该是一句旁白的方括号里被塞进整篇报告，把用户的
  对话正文彻底冲垮，方括号也被撑得毫无可读性。现在**只在渲染层**收敛：取首个非空行、按
  80 字符硬截断、被丢弃的内容统一收敛成**一个**省略号（不会出现「……」）；采集层
  （`index.js` 的 `task_notification` 分支）**刻意保持原样**，完整 summary 仍然留在
  `backgroundOutcomes` 里，供将来的 UI 面板展开使用。`test-background-tasks.mjs` 覆盖了短单
  行、多行、超长单行、空/`undefined`/`null` 回退到 `taskId`、首行为空白等全部分支，外加一条
  集成断言：多行长报告经 `renderBackgroundNote` 后仍是单行、长度受控、方括号正确闭合。

- **`claude-code` subagent provider（委派任务）现在也不会杀掉 Claude Code 自己的后台任务**。
  [0.3.0] 只把 `waitForBackgroundTasks` 三件套（开放式 stdin、`perTaskStopAffordance`、
  result 后继续持有）修到了主模型接管路径（`lib/index.js`），委派路径
  （`lib/subagent-provider.js`）当时仍是旧的一次性 `prompt` 字符串——被委派的
  Claude Code 若自己用 `run_in_background` 起活，会在这条委派 `result` 后
  ~3–5 秒被杀掉，产出永远收不回来，从委派方视角就是「经常失败 / 结果不完整」。
  现在两条路径共享同一份实现（新增 `lib/background-tasks.js`：
  `openEndedPrompt` + `renderBackgroundNote` + `BACKGROUND_DRAIN_MS`），
  `subagent-provider.js` 默认同样开启 `waitForBackgroundTasks: true`
  （沿用调用方已经配置的 `waitForBackgroundTasks`/`backgroundTaskTimeoutMs`，
  因为两条路径读的是同一份 `settings`）。新增 `test-subagent-background-tasks.mjs`
  离线单测（镜像 `test-background-tasks.mjs` 的 mock-query 手法）。

### Notes
- **委派任务不出现在"顶部 ClaudeCode 标签页"是设计使然，不是这次修的 bug**：本
  provider 通过官方 SDK 拉起一个进程外的 Claude Code CLI，属于
  `@deepseek-ai/dsh-subagent` 定义的"远程 provider"，因此 `start()` 按约定
  返回 `localAgent: undefined`（该包 README 原文：「远程提供方...返回
  `localAgent: undefined`；由于没有本地 child 会话，其一次性运行不会进入基于
  追踪的枚举结果」）。这与该框架另一个远程 provider（ACP）面对的限制完全一样
  （见 `@deepseek-ai/dsh-subagent` README「已知限制与暂缓事项」）。因此委派输出
  只能落回发起委派的当前会话里，而不会单独出现在按 `localAgent` 枚举的 agent
  列表/标签页中——要改变这一点需要框架层面为远程 provider 补一条可追踪的本地
  会话镜像，超出本插件范围。

## [0.3.0] - yyyy-mm-dd

### Fixed
- **Claude Code 的后台任务不再随回合被杀**（`waitForBackgroundTasks`，默认开）。
  此前模型用 `run_in_background` 起的任务，会在本步 `result` 之后约 3–5 秒被 CLI 终止，
  任务输出永远不会被回收——从用户视角就是「安排了后台任务，但它没有执行」。
  实测（SDK 0.3.252，15 秒的后台任务）：

  | 配置 | 结果 |
  |---|---|
  | string prompt + 收到 result 即结束（旧行为） | 7/15 被杀 |
  | 流式输入 + `perTaskStopAffordance` + 仍立即结束 | 7/15 被杀 |
  | string prompt + 不结束 | result 后 ~5s 被 `stopped` |
  | 流式输入 + `perTaskStopAffordance` + 保持会话 | **15/15 `completed`** |

  三个条件缺一不可，因此驱动现在：把 prompt 换成**开放式** `AsyncIterable`（stdin 保持打开，
  不再是 one-shot run）、声明 `perTaskStopAffordance`、并在 `result` 之后**继续持有本步**，
  直到后台任务的存活集合（`background_tasks_changed` 电平信号）清空为止。
  端到端复验：后台任务 15/15 完成，回合耗时 24.8s，`finish=stop`。

### Added
- 后台任务结束后，本轮追加一行旁白（`[Claude Code 后台任务已结束：… （completed）]`）。
  该旁白与工具进度行一样**不计入模型文本**，不会掩盖空回复。
- `backgroundTaskTimeoutMs`（默认 300000 = 5 分钟）：持有本步的上限，超时后正常结束并在
  旁白中点名仍在运行的任务；调用方的 abort 同样可以释放等待。
- `waitForBackgroundTasks: false` 可逐字回到旧的一次性行为。

### Notes
- 该修复改变了 prompt 的传递形态（字符串 → 开放式 AsyncIterable）。已验证：无后台任务时进程
  仍会在 break 后立即干净退出（无句柄泄漏），resume 链与工具桥无回归。

## [0.2.0] - yyyy-mm-dd

### Added
- **模型目录自动发现**（`autoDiscoverModels`，默认开）：目录由 Claude Agent SDK 的
  `query.supportedModels()` 构建，新模型（含新家族/版本）升级 SDK 并重启 DSH 后自动出现在
  会话模型选择器，无需改插件或配置。为惰性加载 + 缓存；失败时回退到内置别名/配置文件素。
  - 懒加载用于 `listModels`/`resolveModel`/`discoverModels`；
  - 保留 `settings.models` 作为覆盖/兜底，`autoDiscoverModels: false` 可全局关闭；
  - `contextWindow` 解析自 `resolvedModel` 的 `[…]` 后缀（如 `claude-opus-5[1m]`），
    否则回退到已知模型表。

## [0.1.0] - 2026-08-19

### Added
- 主模型接管：`llm/stream` 短路路由 `claude-code`，由官方 Claude Agent SDK 驱动。
- 模型选择器集成（目录 adapter，UI 出现 "Claude Code" 分组）。
- resume 续接链、token 级流式、DSH 工具桥接（MCP）、原生工具卡片、内置工具进度文本。
- `claude-code` subagent provider、跨模型历史兼容、压缩后清链 + `/claude-fresh`。
- 可执行文件回退（SDK 原生二进制缺失时回退全局 `claude`）。
- 适配 DSH 2.0.2 `LlmAdapter` 契约（`prepareCall`）；声明 `dsh.bundle` 清单。
