# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。变动记录于此。

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
