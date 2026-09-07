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
| 后台任务保活 | `waitForBackgroundTasks`：持有本步直到 Claude Code 自己的后台任务跑完，否则它们会在回合结束后被杀 |
| 子代理抢救 | `harvestOrphanedSubagents`：随进程一起死掉的子代理，下一轮从磁盘 transcript 捞回它们的产出 |
| 可执行文件回退 | SDK 原生二进制缺失时回退到全局 `claude.exe` |

## 子代理抢救（harvestOrphanedSubagents）

`waitForBackgroundTasks` 只能让子代理熬过**正常结束**的一轮。另外两种退出它救不了：

1. **调用方 abort**——DSH 会话断开／重启／用户点停止：运行循环在 `signal.aborted` 上
   直接 break，transport 被拆掉；
2. **进程被硬杀**：连 `finally` 都不会执行。

两种情况下子代理都死在半路，**最终回复根本没生成**，从委派方看就是这次委派什么都没交付。

但回复没了不等于工作没了。Claude Code 边跑边把每个子代理写到磁盘：

```
<claudeHome>/projects/<项目>/<sessionId>/subagents/agent-<agentId>.jsonl
```

所以抢救是一次**读取**，不需要在「正在被杀死」这个最不可靠的时刻去 flush。

实现用的是**预写标记**而不是退出钩子：某次运行首次报出存活的后台工作时写一个标记，
正常收尾的运行删掉自己的标记；于是**任何残留标记都属于没能善终的运行**——包括被硬杀
的那种，而这正是 `finally` 方案看不见的情况。下一次运行开始时清扫残留标记，捞出每个
死掉子代理的最后一段 assistant 文本，按运行写一份报告：

```
$DSH_HOME/storages/claude-driver/recovered/<时间>-<sessionId>.md
```

并在本轮开头播报一行指向它。**抢救结果落在你回来的那一轮。**

```yaml
harvestOrphanedSubagents: true    # 默认；false 完全关闭
```

边界（诚实说明）：捞回来的是**过程**，不是那份没写出来的最终报告——子代理死前没生成的
内容不存在于任何地方。真要让长任务不受会话生死影响，让它**边跑边把结果写进文件**，
交付物落在磁盘上而不是攒在最后一条回复里（见 `deploy/长任务委派模板.md`）。

## 后台任务（waitForBackgroundTasks）

Claude Code 用 `run_in_background` 起的任务，活在本驱动为这一步拉起的 CLI 进程里。
一次性 run（`prompt` 传字符串）下，CLI 在放出 `result` 之后约 3–5 秒**就会把它们杀掉**，
输出再也回收不到——用户看到的现象是「模型说在后台跑，但其实没跑完 / 没执行」。

实测（SDK 0.3.252，15 秒的后台任务）表明豁免需要**同时**满足三条，缺一不可：

1. 流式输入（stdin 保持打开，不能用字符串 prompt 的一次性形态）；
2. 声明 `perTaskStopAffordance`；
3. 后台任务还活着时**不要拆掉会话**。

因此驱动默认（`waitForBackgroundTasks: true`）会持有本步，直到
`background_tasks_changed` 电平信号显示存活集合为空，然后在本轮追加一行旁白说明结果。

```yaml
# profile 的 cordis.patch.yml 里，claude-driver 行的 config
waitForBackgroundTasks: true      # 默认；false 可逐字回到旧的一次性行为
backgroundTaskTimeoutMs: 300000   # 持有上限（默认 5 分钟），超时则结束本轮并点名仍在运行的任务
```

代价与边界：**一个长后台任务会让这一轮聊天一直等到它结束**（上限由
`backgroundTaskTimeoutMs` 兜住），调用方 abort 也能立即释放。`ambient`（CLI 自己的
维护型任务）不计入等待。

**subagent（委派）路径同享此修复**：`claude-code` subagent provider
（`lib/subagent-provider.js`）复用同一份实现（`lib/background-tasks.js`），默认
同样 `waitForBackgroundTasks: true`，且读的是同一份 `settings`——profile 补丁里
给 claude-driver 行配的 `waitForBackgroundTasks`/`backgroundTaskTimeoutMs` 对委派
任务同样生效，无需单独配置。这修的是「委派任务经常失败」里的一类真实成因：被委派的
Claude Code 自己起的后台工作在旧实现下会被静默杀掉，看起来像是任务没做完。

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
| `waitForBackgroundTasks` | `true` | 持有本步直到后台任务跑完（否则它们被杀） |
| `backgroundTaskTimeoutMs` | `300000` | 上述持有的上限（5 分钟） |
| `harvestOrphanedSubagents` | `true` | 下一轮抢救随进程死掉的子代理产出 |
| `approveBuiltinTools` | `false` | 内置工具走 DSH 审批（开启后每个 Bash 弹一次"允许一次"） |
| `builtinAllowlist` | `['Read','Grep','Glob']` | 开启审批后仍直接放行的只读内置工具 |

## 架构边界（重要，先读）

主模型切成 Claude Code 后，**"模型记忆/上下文归 Claude Code，不归 DSH"**。因此：

- **仍生效**：会话持久化、GUI、工具卡片、工作区/附件、沙箱审批（桥接 DSH 工具）、子代理调度。
- **半生效**：会话历史/系统提示只在 **fresh 首次调用**传给 Claude；resume 后续轮不重发（Claude 保留自己的记忆）。
- **基本不生效**：所有靠 `systemPrompt` 注入模型上下文的 DSH 插件（记忆注入、会话级 context、prompt 变量、自动回忆）——DSH 组装的上下文到不了 Claude 眼前。
- **结论**：想要 DSH 的记忆/上下文生态完整生效 → 用「deepseek 主模型 + Claude Code 委派」；主模型用 Claude Code → 把记忆交给 Claude Code 自己（`CLAUDE.md`、项目记忆等原生能力）。

### 委派任务为什么不出现在 agent 追踪 UI（顶部标签页 / list_agents）里

`claude-code` subagent provider 是 `@deepseek-ai/dsh-subagent` 定义的**远程 provider**
（拉起一个进程外的 Claude Code CLI，不是 DSH 原生的进程内子会话）。该包 README 原文：

> 本地运行会在 `start()` 兑现前发布普通的子 agent／会话……以 `SubagentRun.localAgent`
> 公开准确的子 agent……**远程提供方则生成 parent 作用域的生命周期 id，并返回
> `localAgent: undefined`；由于没有本地 child 会话，其一次性运行不会进入基于追踪的
> 枚举结果。**

所以：

- 委派任务不会出现在按 `localAgent`/`list_agents`/`listChildren` 枚举的 agent 列表或
  UI 标签页里——这是框架对"远程 provider"的既定约定，不是本插件的疏漏。框架自带的另一个
  远程 provider（ACP）面对的是完全相同的限制（见该包 README「已知限制与暂缓事项」）。
- 委派没有独立的可追踪会话可以承接输出，因此结果只能作为这次委派工具调用本身的返回值，
  出现在发起委派的当前会话里——这也是为什么委派任务的输出内容会"刷"在当前会话，而不是
  单独收纳在一个专属面板里。
- 真要解决，需要在框架层给远程 provider 补一条可追踪的本地会话镜像（持久化远端 session id
  + 逐子 agent 的继续执行能力声明），工作量在 `@deepseek-ai/dsh-subagent`，不在本插件；
  详见该包 README「已知限制」里 ACP 那条的描述，两者需要的机制是同一件事。

## 合规与风险（如实）

官方 SDK 是 Anthropic 支持的构建方式，但"第三方 harness 驱动 Claude Code"处于官方生态边缘；异常用量可能触发审查。请保持个人用量、不伪装客户端。token 全程由 SDK 管理、不落盘。

## 测试

需代理 + Claude 登录。`npm i --no-save` 后：

```powershell
node test-run.mjs                 # 文本 + 工具桥接
node test-subagent-provider.mjs   # subagent provider（真实 SDK）
node test-resume-smoke.mjs        # resume 续接（真实 SDK 两连发）
node test-resume-plan.mjs         # 离线单测
node test-model-catalog.mjs       # 目录适配器
node test-tool-progress.mjs       # 进度旁白
node test-native-tool-cards.mjs   # 原生卡片事件
node test-cross-model-and-fresh.mjs # 跨模型配对 + 清链/命令
node test-background-tasks.mjs             # 主模型路径 waitForBackgroundTasks（离线单测）
node test-subagent-background-tasks.mjs    # subagent 路径 waitForBackgroundTasks（离线单测）
```

## 路线图（未做）

- 存量会话（已含孤儿 tool 消息）的跨模型自愈（需 adapter 侧容错）
- 审批的"会话级总是允许"记忆（wire schema 只支持 allow-once，见 `approveBuiltinTools`）
- subagent 的 continuable 续接（上游 dsh-subagent descriptor schema 未开放）
- subagent 路径的内置工具审批（当前只桥了主模型路径）

## 目录

```
lib/index.js              主模型接管 + 桥接 + 卡片 + resume 链 + 命令
lib/model-catalog.js      模型选择器目录适配器 + 模型发现
lib/subagent-provider.js  claude-code subagent provider
lib/background-tasks.js   waitForBackgroundTasks 共享实现（主模型路径 + subagent 路径都用）
lib/claude-executable.js  SDK 原生二进制回退
deploy/                   安装模板（cordis.patch.yml + preset 片段）
```
