# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。变动记录于此。

## [0.9.0] - 2026-09-16

> 安装注意事项同 0.4.0 三条，不再重复。

### Changed
- **后台任务清单按严重度分流**（用户反馈：全成功的
  `[Claude Code 后台任务已结束：…（completed）]` 拼在回答末尾没有作用）。
  `renderBackgroundNotes` 把结算拆成两档：
  - **info**（全部 completed 的结算）→ 走 `toolNarrationChannel`（默认思考块，
    可折叠、不打扰；设 `'text'` 回到旧的正文放置）
  - **alert**（failed / 超时 / 回合结束仍在运行——产出可能已丢失）→ **始终正文**。
    这一行才是整个功能存在的理由，绝不允许折叠掉。
  子代理路径（`subagent-provider`）保持旧的单通道 `renderBackgroundNote`
  逐字节不变：那里的清单是上级代理要读的**数据**（需要完整结算画面），不是 UI。

## [0.8.0] - 2026-09-16

> 安装注意事项同 0.4.0 三条，不再重复。前端改动需**刷新页面 / 重启 DSH Desktop**
> 才会加载新 client bundle。

### Added
- **插件长出客户端半边**：`package.json` 新增 `dsh.client`（platform web、
  immediately）与 `exports["./client"]`，宿主 `dsh-client-modules` 扫描 loader
  条目时会把 `client/client.js` 送进浏览器执行。注意 `exports` 字段一旦引入即
  接管全部子路径解析，必须同时补 `./cordis.patch.yml` 与 `./package.json`
  子路径，否则 bundle patch 解析会断（照抄 dshmarket 的结构）。
- **思考框限高**（用户诉求：思考内容一长就把对话撑爆）。注入一条 CSS：
  展开的 reasoning 正文 `max-height: var(--claude-driver-think-max-height, 320px)`
  + `overflow-y: auto`。选择器匹配稳定的 `_thinkBody` 类名后缀而非构建哈希
  （`wM8ffq_` 这类前缀每个 ui-chat 版本都会变）；ui-chat 若整个改名则退化为
  无操作（回到原生无限高），不可能弄坏聊天页。改高度不用重装：在任意上层容器
  设 `--claude-driver-think-max-height` 即可。
- **流式跟随**：限高后若不跟随，流式期间只能看见思考的开头、最新内容藏在滚动
  条下面——等于白改。MutationObserver + rAF 节流把有溢出的思考框钉在底部；
  用户向上滚动即解除跟随（从「是否接近底部」自洽推导 pinned 态，无需区分
  程序滚动与用户滚动），滚回底部自动恢复。
- `test-client-style.mjs`：钉住宿主真正执行的契约（entry.id = 包名、factory
  返回 cordis plugin 形状、样式注入在 factory 作用域且不重复注入、exports
  子路径不回退）。

## [0.7.0] - 2026-09-16

> 安装注意事项同 0.4.0 三条，不再重复。

### Changed
- **工具旁白搬进思考块**（`toolNarrationChannel: 'reasoning'`，默认）。0.5.0 把
  `narrateBuiltinTools` 活动行和内置工具错误旁白发在正文 text 块上，实际效果是
  `[Claude Code] ⚙ Bash · …` 黏在模型句子中间（用户截图实证）。现在两类旁白都
  追加进可折叠的 reasoning 块：可见性不丢（展开思考即见），正文恢复干净。
  设 `toolNarrationChannel: 'text'` 回到旧放置；`showToolProgress` 显式开启时
  仍走正文且逐字节不变（历史承诺不动）。
  - 附带语义：resume 失败重试 fresh 的守卫本来就同时检查 `openedText` 与
    `openedReasoning`，旁白换通道后行为等价（narration 一旦流出就不再重试，
    不会重复输出）。

## [0.6.0] - 2026-09-16

> 安装注意事项同 0.4.0 三条（版本号推进、确认 profile、`dsh plugin` 静默失败用
> `dsh.cmd` shim），不再重复。

### Added
- **回合预热**（`prewarm`，默认关；`prewarmTtlMs` 默认 15 分钟）。定位「每条消息
  固定等十几秒」时拆出的耗时结构：进程启动 0.2s + **CLI 本地初始化 3.5–4s**（API
  指黑洞地址 init 帧照样出现 ⇒ 纯本地；fresh/resume 一样；CLI 2.1.234/2.1.260 一样）
  + API 首字 4–6s（每轮 ~4 万 token 固定系统开销）。本地那 4s 是唯一能拿掉的：回合
  收尾即用 `resume` + 开放式流式输入预启动下一轮进程，下一条消息到达时若完全匹配
  （resume id / 模型 / 思考档 / 桥接工具集）则直接推入其输入流。实测端到端：
  冷 9.7s → 领养 4.5s；resume 记忆完好。
  - 任何不匹配 / 进程死亡 / TTL 过期 / 压缩 / `/claude-fresh` → 废弃预热进程、
    原样走冷路径，最坏情况等于旧行为。全局最多 2 个空闲进程，跨会话 LRU。
  - 领养的进程由运行级 `finally` 显式处置：对开放输入的 SDK query 调
    `iterator.return()` 会**永久挂起**（实测——return 排在一个永不兑现的 next()
    之后），处置必须走「关输入流（stdin EOF）+ controller.abort()」双保险。
  - 依赖 `waitForBackgroundTasks`（开放输入传输层）；关闭它则预热静默不生效。

### Changed
- SDK options 装配抽成 `buildSdkOptions()`，冷路径与预热 spawn 共用同一份，杜绝
  两处漂移；`buildSdkPrompt` 拆出 `buildPromptBlocks()` 供领养时构造推入消息复用。

### Fixed
- **重构引入后当场抓回的回归**：at-risk 标记写入引用了缩进 else 分支的
  `sdkOptions.cwd`，消息循环里成为 ReferenceError 被 try/catch 吞掉 —— 后台任务
  超时的回合将不再留下抢救标记（`test-agent-harvest` 确定性失败）。提升为循环作用
  域的 `runCwd` 修复；这正是「每步重构必须全套回归」的又一例证。

### Tests
- 新增 `test-prewarm.mjs`（8 组）：默认关不产生任何 spawn；开启后回合收尾出现带
  resume id 的常驻 spawn；兼容轮领养（用户消息推入常驻输入、无冷 spawn、收尾处置）；
  切模型拒养走冷路径；空闲期死亡的进程拒养；压缩 / `/claude-fresh` 同步废弃；
  池容量 LRU 淘汰；TTL 到期回收。全套 17/17（含真网络 `test-thinking-stream`）。

## [0.5.0] - 2026-09-16

> 安装注意事项与 0.4.0 条目下的三条完全相同（版本号必须推进、先确认 profile、
> `dsh plugin` 静默失败要改用 `dsh.cmd` shim），此处不重复。

### Added
- **内置工具活动旁白**（`narrateBuiltinTools`，默认开）。思考可见性修好后，剩下的
  黑盒是工具阶段：原生卡片只发给桥接的 DSH 工具，Claude 内置工具（Bash / Read /
  WebFetch / Task…）没有卡片，唯一兜底 `showToolProgress` 默认关 —— 一轮花一分钟
  在 Bash 里的回合，在 GUI 上和卡死一模一样。现在在工具**开跑之前**补一行
  `[Claude Code] ⚙ Bash · npm test`，把随后的沉默归因到具名工具。
  - 主语按固定键序取（`command`/`file_path`/`path`/`pattern`/`url`/`query`/
    `description`/`prompt`），**不在表里的键永远不渲染** —— `Write` 显示路径而非
    文件正文，新增内置工具最差退化成裸工具名，不会漏出任意 blob。压成单行、截 80 字符。
  - 与 `showToolProgress` 互斥：后者显式打开时优先，旧输出逐字节不变，绝不叠加。
  - 卡片不可用时（`rendersCard` 因无可 append 的 session 返回 false），桥接工具也
    走这行旁白 —— 否则它同样零痕迹。

### Fixed
- **纯工具回合的最终答案被整个丢掉**（`result` 兜底路径）。当一轮从未流出任何 text
  delta（assistant 消息只有 `tool_use`，答案只存在于 `result.result`）时，兜底分支
  只做了 `text = fallback` 而没有开 block 0；而函数末尾的 block-end 由 `openedText`
  把门 —— 于是这一轮以 usage+finish 收场，**一个 text chunk 都没发**，答案静默消失。
  改为始终开块并以 delta 流出，block-end 仍等于各 delta 之和。测试里有回归断言。

### Tests
- 新增 `test-builtin-tool-activity.mjs`（14 组断言）：主语取值与 payload 隔离、
  单行化与截断、桥接工具走卡片不重复旁白、无卡片时的回退、`showToolProgress` 优先级、
  opt-out 静默、子代理隔离、旁白不得掩盖 `EMPTY_RESPONSE`、以及上面那条答案丢失的回归。
  离线全套 10/10 通过。

## [0.4.0] - 2026-09-16

> 版本号必须随代码一起推进：profile 用 pnpm `file:` 依赖安装本仓库，**版本号不变
> 时 pnpm 直接复用 store 里的旧内容、不重新打包**，改了代码也装不进去（表现为
> 重启 DSH 后行为毫无变化，`node_modules` 里的文件时间戳还停在上次安装那天）。

> **安装前必须先确认装进哪个 profile。** 本机装了 `web` 和 `desktop` 两个 profile，
> 而 DSH Desktop 实际加载的是 **`web`**（`resources/app` 的包名是 `dsh-plugin-desktop`
> 这一事实**不能**用来推断 profile 名）。唯一可靠的判定方法：在有活跃回合时抓正在
> 运行的 CLI 命令行 ——
> `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*claude*' }`，
> 它打印的 `claude.exe` 绝对路径里就写着 profile 名，argv 里还能直接看到这一轮到底
> 传了哪些 flag。2026-09-16 因为把 0.4.0 装进了没人用的 `desktop`，思考流「修完仍
> 无效」白查了一整轮。
>
> **`dsh plugin` 在本机会静默失败。** 它内部 `spawnSync("pnpm", …)` 不带 `shell`，
> 而 Windows 上 pnpm 只有 `.cmd` / shell 脚本，Node 直接 ENOENT；表现是**零输出、
> exit 0、什么都没装**。必须改用 DSH 自己生成的 shim：
> `AppData/Roaming/DSH Desktop/host-commands/<profile>/generations/*/bin/dsh.cmd`，
> 它能真正跑起 pnpm 并打印完整日志。
>
> 另注：替换 `@anthropic-ai/claude-agent-sdk-*/claude.exe` 时若 DSH 正在运行会
> `ERR_PNPM_EPERM`（exe 被活着的 CLI 进程占用）。此时 SDK 留在旧版、其余包照常装上，
> 不影响启动 —— 但要升 SDK 必须先完全退出 DSH。
>
> 实测：`--thinking-display summarized` 在 web profile 自带的 CLI 2.1.234 上**同样
> 生效**（`--help` 没列出它，但二进制里有该 flag，实测 634 字符思考文本），所以这条
> 修复不依赖 SDK 升级。

### Fixed
- **模型弹出的选择题在 DSH 里什么都不显示**（新增 `disableBuiltinAskUserQuestion`、
  `narrateBuiltinToolErrors`、`disallowedTools`，前两者默认开）。模型调用的是 Claude Code
  的**内置** `AskUserQuestion`（参数 `multiSelect` 驼峰），不是 DSH 那个真能弹卡片的
  `ask_user_question`（参数 `multi_select`），结果模型收到
  `The user did not answer the questions.`，而用户屏幕上零痕迹。

  两环因果：

  1. **内置版是被 `canUseTool` 顺带放出来的。** CLI 用「宿主是否注册 `canUseTool`」
     判断「宿主有没有交互界面」。实测（CLI 2.1.258 / SDK 0.3.260，只改一个变量）：
     裸 query = 29 个工具、无 `AskUserQuestion`；`+ canUseTool` = **32 个、有**；
     再加 `disallowedTools:['AskUserQuestion']` = 31、没了。本驱动只要桥接任何 DSH
     工具就必装 `canUseTool`，于是每轮都被塞进一个假的交互能力声明——可
     `canUseTool` 只能答允许/拒绝，**渲染不了选择题**。
  2. **过程完全静默。** 原生卡片只发给桥接的 DSH 工具（`rendersCard` 只匹配
     `bridgedNames`），内置工具的文本兜底 `showToolProgress` 默认关。两条路都断，
     一次完整的「提问→park→超时」在 GUI 上零痕迹，与卡死不可区分。

  修法：`disableBuiltinAskUserQuestion` 摘掉内置版，逼模型回落到有卡片的 DSH 工具
  （**护栏**：仅当这一轮确实桥接了 `ask_user_question` 时才屏蔽，否则会把模型唯一的
  提问途径一起掐掉）；`narrateBuiltinToolErrors` 给内置工具的失败/「未作答」哨兵补一行
  旁白，杜绝静默失败。新增 `test-ask-user-question.mjs`（8 组离线断言，覆盖护栏、
  opt-out、桥接工具不重复播报、子代理隔离、block-end 文本守恒）。

- **思考过程完全不显示（只剩「深度求索中…」转圈）**（新增 `thinkingDisplay`、
  `thinkingHeartbeat`，默认都开）。当代模型（Sonnet 4.6 / Fable 一代）默认走
  **redacted thinking（加密思考）**：`thinking_delta` 帧照常到达，但 `delta.thinking`
  是**空串**，API 只流 ping 和一个 `estimated_tokens` running total（见 sdk.d.ts
  `SDKThinkingTokensMessage`："during the redacted-thinking phase (where the API
  otherwise streams only pings)"）。驱动的两处思考提取都要求文本非空
  （`lib/index.js` 的 `thinking_delta` 分支与整条消息兜底），于是恒被短路——
  一轮烧掉 650 个思考 token 的回合，**一个 `reasoning-delta` 都没发出去**，
  GUI 没有思考块可渲染，只剩通用等待动画，用户无法区分「在想」和「卡死」。

  实测对照（2026-09-16，CLI 2.1.258 / SDK 0.3.260 / sonnet，effort=high，同一 prompt）：

  | 配置 | thinking_delta 帧 | 思考文本字符 |
  |---|---|---|
  | 默认 | 6 | **0** |
  | `settings: { showThinkingSummaries: true }`（query 内联） | 4 | **0**（无效，勿用） |
  | `extraArgs: { 'thinking-display': 'summarized' }` | 39 | **357** |

  两层修复：
  1. `thinkingDisplay: 'summarized'`（默认）→ 以 CLI flag 请求 API 侧思考摘要，
     把可读文本要回来。注意 query 的内联 `settings` 传法实测**不生效**，只有 flag 管用。
  2. `thinkingHeartbeat: true`（默认）→ 消费此前被完全忽略的
     `system/thinking_tokens` 帧，在加密思考阶段于思考块里写一条会生长的点线
     （`🤔 思考中（本轮思考内容已加密，仅可见进度） · · 约 550 tokens`），
     摘要不可用时也保证有活体信号；真实摘要一出现即自动让位。

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
