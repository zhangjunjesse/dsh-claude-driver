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

**长任务规范**（`deploy/长任务规范.md`）：凡超过 1 分钟的任务禁止用当前会话 shell 起
后台任务（会话/进程重启即丢失且无完成记录），必须用 `claude_code` 委派
（`run_in_background`）或 `Start-Process` 独立进程 + 日志落盘。规则同时落在
`~/.dsh/.agent-presets/<preset>/agent.cordis.yml` persona 与 `~/.claude/CLAUDE.md`，
对 DSH 主模型与被委派的 Claude Code 双侧强制。

## 模型提问却弹不出选择卡片（disableBuiltinAskUserQuestion）

症状：模型说"我问了你一个问题"，但你屏幕上**什么都没出现**，模型那边收到的是
`The user did not answer the questions.`

原因链有两环：

**① 内置 `AskUserQuestion` 是被 `canUseTool` 顺带放出来的。** CLI 用「宿主有没有注册
`canUseTool`」来判断「这个宿主有没有交互界面」。实测（CLI 2.1.258 / SDK 0.3.260，
只改一个变量）：

| 配置 | 工具总数 | 是否提供 `AskUserQuestion` |
|---|---|---|
| 裸 query | 29 | 否 |
| `+ canUseTool` | **32** | **是** |
| `+ canUseTool + disallowedTools:['AskUserQuestion']` | 31 | 否 |

而本驱动**只要桥接了任何 DSH 工具就必装 `canUseTool`**，于是每个正常会话都被塞进一个
假的交互能力声明。但 `canUseTool` 只能回答「允许/拒绝」，**它不会渲染选择题**——
CLI 把对话框 park 给一个永远不会显示它的宿主，到期返回「用户未作答」。

**② 整个过程在 GUI 里完全静默。** 原生卡片只发给**桥接的 DSH 工具**
（`rendersCard` 只匹配 `bridgedNames`），内置工具的兜底是 `showToolProgress`，
而它默认关。两条路都断 ⇒ 一次完整的「提问→等待→超时」零痕迹。

修法（默认开）：

- `disableBuiltinAskUserQuestion: true` → 把内置版摘掉，模型回落到 DSH 自己的
  `ask_user_question`（它是桥接工具，有真卡片）。**有护栏**：只在这一轮确实桥接了
  `ask_user_question` 时才屏蔽，否则会把模型唯一的提问途径也掐掉，让它闷头猜。
- `narrateBuiltinToolErrors: true` → 内置工具返回 `is_error`，或返回「未作答」哨兵时，
  补一行旁白。**静默失败比报错难查十倍**，这条是兜底。

两个工具长得像但不是一个：内置版参数是 `multiSelect`（驼峰），DSH 版是
`multi_select`（下划线）——看到驼峰就说明模型用错了工具。

## 思考过程可见性（thinkingDisplay / thinkingHeartbeat）

当代模型（Sonnet 4.6 / Fable 一代）默认走 **redacted thinking（加密思考）**：
`thinking_delta` 帧照常到达，但 `delta.thinking` 是**空串**，API 只流 ping 和一个
`estimated_tokens` running total。驱动早期版本的两处思考提取都要求文本非空，于是恒被
短路——一轮烧掉 650 个思考 token 的回合**一个 `reasoning-delta` 都没发出去**，GUI 里
没有思考块，只剩通用等待动画，无法区分「在想」和「卡死」。

两层修复，默认都开：

| 键 | 默认 | 作用 |
|---|---|---|
| `thinkingDisplay` | `'summarized'` | 以 CLI flag `--thinking-display` 请求 API 侧思考摘要，把可读文本要回来 |
| `thinkingHeartbeat` | `true` | 消费 `system/thinking_tokens` 帧，在加密阶段写一条会生长的点线作为活体信号 |

摘要可用时，思考块是正常的可读文本；摘要不可用（或 `thinkingDisplay: null`）时退化成：

```
🤔 思考中（本轮思考内容已加密，仅可见进度） · · 约 550 tokens
```

真实摘要一旦出现，心跳自动让位（保留为块内历史，不再追加点）。

### 思考框限高（客户端半边，0.8.0）

思考内容一长会把整个对话撑爆。本插件从 0.8.0 起带一个**客户端半边**
（`dsh.client` + `client/client.js`，宿主自动送进浏览器执行）：

- 展开的思考正文限高 **320px**、内部滚动；改高度不用重装——在任意上层容器设
  CSS 变量 `--claude-driver-think-max-height` 即可
- **流式跟随**：思考还在流式输出时自动钉在底部，最新内容始终可见；向上滚动即
  暂停跟随，滚回底部自动恢复
- 选择器匹配稳定的 `_thinkBody` 类名后缀（不依赖 ui-chat 的构建哈希）；ui-chat
  未来改名则整体退化为原生无限高行为，不会弄坏页面

注意：这是前端样式，影响**所有模型**的思考框（包括原生 deepseek），不只 claude。
生效需要刷新页面或重启 DSH Desktop。

**坑**：query 的内联 `settings: { showThinkingSummaries: true }` 实测**不生效**
（0 字符），只有 CLI flag 管用——所以驱动走 `extraArgs`。

## 内置工具可见性（narrateBuiltinTools）

思考可见性修好之后，剩下的黑盒是**工具阶段**：原生卡片（`nativeToolCards`）只发给
**桥接的 DSH 工具**，Claude 自己的内置工具（Bash / Read / WebFetch / Task…）没有卡片，
唯一的兜底 `showToolProgress` 默认关——于是一轮花一分钟在 Bash 里的回合，在 GUI 上和
卡死长得一模一样。

`narrateBuiltinTools: true`（默认开）在承载 `tool_use` 的 assistant 消息到达时——也就是
**工具真正开跑之前**——补一行紧凑旁白，把随后的沉默归因到一个具名工具：

```
[Claude Code] ⚙ Bash · npm test
[Claude Code] ⚙ Read · lib/index.js
```

和旧的 `showToolProgress`（只有裸工具名 `正在调用工具 Bash…`）的区别是**带主语**，这也是
这行字值得占屏幕的原因。主语按固定键序取（`command` / `file_path` / `path` / `pattern` /
`url` / `query` / `description` / `prompt`），**不在表里的键永远不渲染**——所以 `Write`
显示的是路径而不是整个文件正文，新增内置工具最差只退化成裸工具名，不会漏出任意 blob。
主语压成单行并截到 80 字符。

两个旁白器互斥：`showToolProgress` 显式打开时它优先，旧输出逐字节不变，两者不会叠加。
桥接工具默认跳过（卡片已经说过了）；但当卡片不可用时（`rendersCard` 因为没有可 append 的
session 返回 false），桥接工具也会走这行旁白——否则它同样会零痕迹。

**放在哪（`toolNarrationChannel`，0.7.0）**：默认 `'reasoning'`——活动旁白和内置工具
错误旁白都追加进可折叠的「思考」块，而不是插进正文。实测把它们放正文时，`[Claude Code] ⚙`
行会直接黏在模型的句子中间，读起来是噪音。设 `'text'` 恢复 0.5.0 的正文放置。
`showToolProgress` 不受此开关影响（它承诺历史输出逐字节不变，永远走正文）。

## 后台任务（waitForBackgroundTasks）

Claude Code 用 `run_in_background` 起的任务，活在本驱动为这一步拉起的 CLI 进程里。
一次性 run（`prompt` 传字符串）下，CLI 在放出 `result` 之后约 3–5 秒**就会把它们杀掉**，
输出再也回收不到——用户看到的现象是「模型说在后台跑，但其实没跑完 / 没执行」。

实测（SDK 0.3.252，15 秒的后台任务）表明豁免需要**同时**满足三条，缺一不可：

1. 流式输入（stdin 保持打开，不能用字符串 prompt 的一次性形态）；
2. 声明 `perTaskStopAffordance`；
3. 后台任务还活着时**不要拆掉会话**。

因此驱动默认（`waitForBackgroundTasks: true`）会持有本步，直到
`background_tasks_changed` 电平信号显示存活集合为空，然后在本轮追加旁白说明结果。

**旁白的去向按严重度分流（0.9.0）**：全部 completed 的结算清单是记账不是回答，
走 `toolNarrationChannel`（默认进可折叠的思考块；设 `'text'` 回到旧的正文放置）；
**failed / 超时 / 回合结束仍在运行**意味着产出可能已丢失，**始终写在正文**，
不允许被折叠掉。子代理路径的清单保持单通道不变——那是上级代理要读的数据。

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

## 回合首字延迟与预热（prewarm）

每一轮对话驱动都要拉起一个全新的 Claude Code CLI 进程，其**本地** bootstrap 约需
3.5–4s（2026-09-16 实测：API 指到黑洞地址 init 帧照样 3.56s 出现，纯本地零网络；
fresh 与 resume 完全一样；CLI 2.1.234 与 2.1.260 一样——升级救不了）。再叠加 API
首字 4–6s（每轮约 4 万 token 的固定系统开销），用户体感就是「每条消息固定等十秒起」。

`prewarm: true` 后，回合一收尾驱动就用 `resume` + 开放式流式输入把**下一轮**的
CLI 进程先拉起来晾着——4s 初始化全部发生在用户阅读上一条回答的空闲期。下一条消息
到达时若与预热进程完全匹配（同 resume id / 模型 / 思考档 / 桥接工具集）则直接**推入**
其输入流（实测端到端：冷 9.7s → 领养 4.5s）；任何不匹配、进程死亡、TTL 过期都原样
走冷路径，最坏情况等于现状。注意事项：

- 依赖 `waitForBackgroundTasks`（开放输入传输层）；关闭它则预热不生效。
- 每回合结束会挂一个空闲 CLI 进程（全局上限 2 个，跨会话 LRU 淘汰；
  `prewarmTtlMs` 到期自动回收；压缩/`/claude-fresh`/切模型都会废弃它）。
- 只加速「同一会话的下一轮」；新会话第一条消息仍是冷启动。
- 切模型的第一轮除了冷启动还要付一次 prompt cache 重建（缓存按模型隔离，约 20s 级），
  与本功能无关，属 API 侧行为。
- 处置预热进程**必须**走「关输入流 + abort」——对开放输入的 SDK query 调
  `iterator.return()` 会永久挂起（实测），这是实现内注释反复强调的坑。

## 与 dsh-claude-code 配合：prompt 缓存 TTL（ENABLE_PROMPT_CACHING_1H）

> 背景（本机实测踩坑记录，2026-09）：claude-driver 与 dsh-claude-code 两个插件
> 配合使用（主模型切到 claude-code + 用 `claude_code` 工具委派），主模型委派出去
> 的子任务**经常跑超过 5 分钟**。Claude 的 prompt caching 默认 TTL 是 **5 分钟**，
> 对话间隔一旦超过 5 分钟，上一轮写入的缓存全部失效，下一轮要**重新写缓存**
> （`cache_creation` 计费），长对话反复失效会白烧大量 token。
>
> 解法：给 Claude Code 设置环境变量 **`ENABLE_PROMPT_CACHING_1H=1`**，把 prompt
> cache TTL 从默认 5 分钟提到 **1 小时**（Claude Code ≥ 2.1.108 起支持，API key /
> Bedrock / Vertex / Foundry 通用；旧的 `ENABLE_PROMPT_CACHING_1H_BEDROCK` 已弃用
> 但作为别名仍被兼容）。1 小时 TTL 的缓存写入费率高于 5 分钟，但对
> 「委派/后台任务经常跨 5 分钟」的用法整体是省 token 的——这正是本机设成 1h 的原因。

设置方式（任选其一，都会透传给本插件拉起的 Claude Code 子进程）：

```powershell
# 1) Windows 用户级环境变量（推荐，重启 DSH 生效）
setx ENABLE_PROMPT_CACHING_1H 1

# 2) 当前 shell 一次性（仅本次会话）
$env:ENABLE_PROMPT_CACHING_1H = "1"

# 3) 或在 ~/.claude/settings.json 的 "env" 块里：
#    { "env": { "ENABLE_PROMPT_CACHING_1H": "1" } }
```

相关的控制变量：

| 变量 | 作用 |
|---|---|
| `ENABLE_PROMPT_CACHING_1H=1` | 请求 1 小时 prompt cache TTL（默认 5 分钟） |
| `FORCE_PROMPT_CACHING_5M=1` | 强制回到默认 5 分钟 TTL |
| `DISABLE_PROMPT_CACHING=1` | 完全禁用 prompt caching（优先于上面的开关） |

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
| `prewarm` | `false` | 回合一结束就预启动下一轮的 CLI 进程，下一条消息跳过约 4s 本地初始化（见下节） |
| `prewarmTtlMs` | `900000` | 预热进程空闲多久未被领养即回收（15 分钟） |
| `partialStream` | `true` | token 级流式 |
| `thinkingDisplay` | `'summarized'` | 请求 API 侧思考摘要（`'omitted'` 关闭摘要，`null` 用 CLI 默认） |
| `thinkingHeartbeat` | `true` | 加密思考阶段的活体心跳（见下节） |
| `showToolProgress` | `false` | 旧版裸工具名进度旁白（默认关；开启后优先于下一行） |
| `narrateBuiltinTools` | `true` | 内置工具带主语的活动旁白（`⚙ Bash · npm test`，见下节） |
| `toolNarrationChannel` | `'reasoning'` | 工具旁白放思考块（默认）还是正文（`'text'`，0.5.0 行为） |
| `nativeToolCards` | `true` | 桥接工具原生卡片 |
| `bridgeTools` | `true` | DSH 工具桥接 |
| `registerCatalog` | `true` | 进模型选择器 |
| `waitForBackgroundTasks` | `true` | 持有本步直到后台任务跑完（否则它们被杀） |
| `backgroundTaskTimeoutMs` | `300000` | 上述持有的上限（5 分钟） |
| `harvestOrphanedSubagents` | `true` | 下一轮抢救随进程死掉的子代理产出 |
| `disableBuiltinAskUserQuestion` | `true` | 屏蔽 Claude 内置 `AskUserQuestion`（DSH 无法渲染，见下节） |
| `narrateBuiltinToolErrors` | `true` | 内置工具调用失败时补一行旁白，杜绝静默失败 |
| `disallowedTools` | `undefined` | 额外不提供给 Claude Code 的工具名 |
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
node test-thinking-stream.mjs              # 思考块可见性（真实 SDK；NO_SUMMARY=1 验心跳兜底）
node test-ask-user-question.mjs            # 内置 AskUserQuestion 屏蔽 + 静默失败旁白（离线单测）
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
