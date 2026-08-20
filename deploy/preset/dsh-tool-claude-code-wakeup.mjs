// claude-code-wakeup — 确保 claude-code subagent 工具行在会话挂载时一定能见到 provider。
//
// 背景：dsh-subagent 的 provider-added 事件在根 ctx 发射，而 preset 内
// tool-subagent-claude-code 行的监听器注册在 delegation 组 ctx（Cordis 事件只向上
// 冒泡），因此当宿主侧 provider（dsh-claude-driver 注入注册）晚于本会话挂载时，
// 工具行会错过事件并永久停在"等待 provider"。本插件与工具行同组、排在其后，
// 在组组合完成后（0ms 定时器）于本组 ctx 重发一次 provider-added：
//  - 工具行已挂载 → disposeTool 非空，重发被忽略（幂等）；
//  - 工具行因竞态错过 → 监听器已注册，收到后立即挂载工具。
export const name = 'claude-code-wakeup'
export const inject = ['timer']

export function apply(ctx) {
  ctx.timer.setTimeout(() => {
    const subagents = ctx.get('subagents')
    const provider = subagents?.getProvider?.('claude-code')
    if (provider) ctx.emit('subagent/provider-added', provider)
  }, 0)
}
