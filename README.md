# dsh-claude-driver

DSH（DeepSeek Harness）宿主插件：让 DSH 会话把**本地 Claude Code 订阅**（官方 Claude Agent SDK）当主模型用，工具活动以 DSH 原生卡片呈现。

- 合规：全程走官方 `@anthropic-ai/claude-agent-sdk`，**不提取任何 OAuth token**、不冒充客户端。
- 无内核改动：经 `llm/stream` 官方接管缝接管 provider 路由 `claude-code`。

## 功能

| 能力 | 说明 |
|---|---|
| 主模型接管（B1） | `llm/stream` 短路路由 `claude-code`，每步驱动 Claude Code |
| 模型选择器集成 | 注册目录 adapter，UI 里出现 "Claude Code" 分组；默认**自动发现** SDK 的真实模型（懒加载 + 缓存） |
| 模型目录自动发现 | `autoDiscoverModels`（默认开）：新模型升 SDK + 重启即自动进入 picker，零插件/配置改动 |
| resume 续接链 | 同一 DSH 会话复用同一个 Claude Code 会话，第 2 轮起免冷启动 |
| token 级流式 | `includePartialMessages`，文字逐 token 实时呈现 |
| DSH 工具桥接（B2） | DSH 工具经 MCP 桥进 Claude Code，走 DSH 沙箱/审批 |
| 原生工具卡片 | 桥接的 DSH 工具写 `tool/call`+`tool/result` 事件，前端渲染原生卡片 |
| 内置工具进度 | Claude 内置工具（Bash/Edit…）以文本进度旁白兜底 |
| subagent provider | 填上官方预留的 `claude-code` subagent 占位缝（`subagent_claude_code` 工具） |
| 跨模型历史兼容 | 补写配对 assistant tool-call 事件，切回 deepseek 不报 400 |
| resume 链治理 | 模型带 contextWindow（启用 DSH 自动压缩）+ 压缩后清链 + `/claude-fresh` 命令 |
| 可执行文件回退 | SDK 原生二进制缺失时回退到全局 `claude.exe` |

## 模型适配（新模型如何处理）

模型目录默认由 Claude 的 `query.supportedModels()` **自动发现**（`autoDiscoverModels: true`）。
Claude 的模型别名（`fable`/`sonnet`/`opus`/`haiku`）指向各自家族**最新版**，因此：

- **版本升级（如 Fable 5.1）**：`fable` 别名自动跟随，**无需任何改动**。
- **全新模型家族**：升级 SDK 并重启 DSH 即自动出现在选择器——
  ```powershell
  dsh plugin --profile desktop up @anthropic-ai/claude-agent-sdk
  # 然后重启 DSH
  ```

可选配置：在插件的 profile 补丁里给 claude-driver 行加 `autoDiscoverModels: false`（改用
手动 `models` 清单），或用 `models` 显式给出你想要的目录/标签。`contextWindow` 解析自
`resolvedModel` 的 `[…]` 后缀（如 `claude-opus-5[1m]`），否则回退到内置已知模型表。

## 依赖要求

- DSH（DeepSeek Harness），`web` / `desktop` profile 目录布局（`~/.dsh/profiles/`）
- Node ≥ 22
- Claude 订阅 + `claude` CLI 可用（或 SDK 的平台二进制包）
- **出网 IP 是数据中心 IP 时需要代理**（Anthropic 会 403），如 `http://127.0.0.1:7897`

## 安装（其他电脑）

### 1. 放置插件并装依赖

```powershell
# 克隆到任意目录
git clone <你的仓库地址> dsh-claude-driver

# 放进共享 profile 的 node_modules
# 重要：绝不要在 profiles/node_modules/ 根目录跑 npm i ——
#       会把 dsh 自管理的 junction 当"多余包"剪掉导致 dsh 无法启动。
Copy-Item -Recurse dsh-claude-driver "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-claude-driver"

# 在插件自己的目录里装依赖（SDK + zod 落到 dsh-claude-driver/node_modules，不动共享根）
cd "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-claude-driver"
npm i --no-save
```

### 2. 写入宿主补丁

把 `deploy/cordis.patch.yml` 的内容合并进 `~/.dsh/profiles/<profile>/cordis.patch.yml`
（DSH Desktop 应用用 `desktop` profile；`dsh web` CLI 用 `web`）。**把 `proxy` 改成你本机的代理地址**。

### 3. 启用 subagent 工具 + 唤醒插件（可选但推荐）

按 `deploy/preset/` 里的两样，编辑你使用的 agent preset（`~/.dsh/.agent-presets/<preset>/agent.cordis.yml`）：
- 去掉 `tool-subagent-claude-code` 行的 `disabled`（并在 `plugins/` 放 `dsh-tool-claude-code-wakeup.mjs`）——详见 `deploy/preset/agent.cordis.yml.snippet`。

### 4. 重启 DSH

## 切换主模型

- **界面**：会话模型选择器 → "Claude Code" 分组 → 选模型（默认 fable，重活用 opus）
- **或 settings.yaml**：`agent-default-model` 改为 `provider: claude-code` / `model: fable`

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `claude-code` | 接管的路由名 |
| `model` | `fable` | 默认模型 |
| `models` | 四个带 contextWindow 的条目 | 选择器目录 |
| `effort` | `medium` | 思考强度 |
| `maxTurns` | `100` | 单步内部工具循环上限 |
| `permissionMode` | `acceptEdits` | Claude Code 权限模式 |
| `proxy` | `http://127.0.0.1:7897` | 代理（按机器改） |
| `resumeChain` | `true` | 复用 Claude 会话 |
| `partialStream` | `true` | token 级流式 |
| `showToolProgress` | `false` | 内置工具进度旁白（桥接工具已有卡片，默认关） |
| `nativeToolCards` | `true` | 桥接工具原生卡片 |
| `bridgeTools` | `true` | DSH 工具桥接 |
| `registerCatalog` | `true` | 进模型选择器 |
| `approveBuiltinTools` | `false` | 内置工具走 DSH 审批（开启后每个 Bash 弹一次"允许一次"） |
| `builtinAllowlist` | `['Read','Grep','Glob']` | 开启审批后仍直接放行的只读内置工具 |

## 架构边界（重要，先读）

主模型切成 Claude Code 后，**"模型记忆/上下文归 Claude Code，不归 DSH"**。因此：

- **仍生效**：会话持久化、GUI、工具卡片、工作区/附件、沙箱审批（桥接 DSH 工具）、子代理调度。
- **半生效**：会话历史/系统提示只在 **fresh 首次调用**传给 Claude；resume 后续轮不重发（Claude 保留自己的记忆）。
- **基本不生效**：所有靠 `systemPrompt` 注入模型上下文的 DSH 插件（记忆注入、会话级 context、prompt 变量、自动回忆）——DSH 组装的上下文到不了 Claude 眼前。
- **结论**：想要 DSH 的记忆/上下文生态完整生效 → 用「deepseek 主模型 + Claude Code 委派」；主模型用 Claude Code → 把记忆交给 Claude Code 自己（`CLAUDE.md`、项目记忆等原生能力）。

## 合规与风险（如实）

官方 SDK 是 Anthropic 支持的构建方式，但"第三方 harness 驱动 Claude Code"处于官方生态边缘；异常用量可能触发审查。请保持个人用量、不伪装客户端。token 全程由 SDK 管理、不落盘。

## 测试

需代理 + Claude 登录。`npm i --no-save` 后：

```powershell
node test-run.mjs                 # 文本 + 工具桥接
node test-subagent-provider.mjs   # subagent provider
node test-resume-smoke.mjs        # resume 续接（真实 SDK 两连发）
node test-resume-plan.mjs         # 离线单测
node test-model-catalog.mjs       # 目录适配器
node test-tool-progress.mjs       # 进度旁白
node test-native-tool-cards.mjs   # 原生卡片事件
node test-cross-model-and-fresh.mjs # 跨模型配对 + 清链/命令
```

## 路线图（未做）

- 存量会话（已含孤儿 tool 消息）的跨模型自愈（需 adapter 侧容错）
- 审批的"会话级总是允许"记忆（wire schema 只支持 allow-once，见 `approveBuiltinTools`）
- subagent 的 continuable 续接（上游 dsh-subagent descriptor schema 未开放）
- subagent 路径的内置工具审批（当前只桥了主模型路径）

## 目录

```
lib/index.js           主模型接管 + 桥接 + 卡片 + resume 链 + 命令
lib/model-catalog.js   模型选择器目录适配器 + 模型发现
lib/subagent-provider.js  claude-code subagent provider
lib/claude-executable.js  SDK 原生二进制回退
deploy/                安装模板（cordis.patch.yml + preset 片段）
```
