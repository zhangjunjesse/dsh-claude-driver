// Plan usage for the Claude account a turn runs on. A finished turn refreshes the
// snapshot from its live query (SDK `usage` control request); the composer dock
// meter polls the same-origin route below, so the page never calls Anthropic.
export const USAGE_ROUTE = '/claude-usage.json'
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
const WINDOWS = { five_hour: 'fiveHour', seven_day: 'weekly', seven_day_opus: 'weeklyOpus', seven_day_sonnet: 'weeklySonnet' }

function windowOf(raw) {
  const percent = Number(raw?.utilization)
  if (raw == null || raw.utilization == null || !Number.isFinite(percent)) return undefined
  return { percent, resetsAt: raw.resets_at ?? null }
}

function extraOf(raw) {
  if (!raw) return undefined
  return { enabled: raw.is_enabled === true, percent: raw.utilization ?? null, usedCredits: raw.used_credits ?? null, monthlyLimit: raw.monthly_limit ?? null, currency: raw.currency ?? null }
}

export function usageFromRateLimits(rateLimits) {
  if (!rateLimits) return { ok: false, code: 'unavailable' }
  const windows = {}
  for (const [source, key] of Object.entries(WINDOWS)) {
    const window = windowOf(rateLimits[source])
    if (window) windows[key] = window
  }
  return { ok: true, windows, extra: extraOf(rateLimits.extra_usage) }
}

export function createUsageStore(now = () => Date.now()) {
  let snapshot = { ok: false, code: 'pending' }
  let inflight = Promise.resolve()
  return {
    get: () => snapshot,
    idle: () => inflight,
    reset() {
      snapshot = { ok: false, code: 'pending' }
      inflight = Promise.resolve()
    },
    refresh(query) {
      if (typeof query?.[USAGE_METHOD] !== 'function') return inflight
      inflight = Promise.resolve()
        .then(() => query[USAGE_METHOD]({ skipBehaviors: true }))
        .then((response) => {
          snapshot = { ...usageFromRateLimits(response?.rate_limits_available ? response.rate_limits : null), plan: response?.subscription_type ?? null, fetchedAtMs: now() }
        })
        .catch((error) => {
          snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) }
        })
      return inflight
    },
  }
}

export const claudeUsage = createUsageStore()

export function registerUsageRoute(ctx, store = claudeUsage, provider = 'claude-code') {
  ctx.inject(['webServer'], (webCtx) =>
    webCtx.effect(() =>
      webCtx.get('webServer').register({
        kind: 'exact',
        path: USAGE_ROUTE,
        handler: (req, res) => {
          // `provider` lets the dock show the meter before the first turn has
          // finished: the client matches it against the session's model route.
          const body = JSON.stringify({ now: Date.now(), provider, snapshot: store.get() })
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(body)
        },
      }),
    ),
  )
}
