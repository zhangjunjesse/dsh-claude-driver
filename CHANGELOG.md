# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。变动记录于此。

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
