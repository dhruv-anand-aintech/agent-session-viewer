import { useState, useEffect, useCallback } from "react"
import "./UsageLimits.css"

interface UsageData {
  cursor?: CursorData
  codex?: CodexData
  claude?: ClaudeData
  opencode?: OpenCodeData
  gemini?: GeminiData
  antigravity?: AntigravityData
  fetchedAt?: number
  error?: string
}

interface CursorData {
  // New /api/usage-summary shape
  usageSummary?: {
    membershipType?: string
    limitType?: string
    isUnlimited?: boolean
    billingCycleStart?: string
    billingCycleEnd?: string
    plan?: { autoPercentUsed?: number; apiPercentUsed?: number; totalPercentUsed?: number; used?: number; limit?: number; remaining?: number } | null
    onDemand?: { enabled?: boolean; used?: number; limit?: number; remaining?: number } | null
  }
  me?: { email?: string; name?: string; sub?: string }
  // Legacy shape (fallback)
  usage?: Record<string, { numRequests?: number; numRequestsTotal?: number; maxRequestUsage?: number }>
  stripe?: { membershipType?: string; daysRemainingOnTrial?: number }
  currentPeriod?: { completedRequests?: number; startOfCurrentPeriod?: string }
  error?: string
}

interface CodexData {
  plan?: string
  email?: string
  active_until?: string
  sessionCount?: number
  historyCount?: number
  wham?: {
    rate_limit?: {
      primary_window?: { used_percent?: number; reset_after_seconds?: number }
      secondary_window?: { used_percent?: number; reset_after_seconds?: number }
    }
    credits?: { balance?: number }
    plan_type?: string
  }
  error?: string
}

interface ClaudeData {
  org_id?: string
  usage?: {
    five_hour?: { utilization?: number; resets_at?: string }
    seven_day?: { utilization?: number; resets_at?: string }
    seven_day_opus?: { utilization?: number; resets_at?: string }
  }
  cliUsage?: {
    sessionPct?: number
    weeklyPct?: number
    sessionResetsAt?: string
    weeklyResetsAt?: string
  }
  numSessions?: number
  _hint?: string
  error?: string
}

interface GeminiData {
  email?: string
  sessionCount?: number
  totalTokens?: { input: number; output: number; cached: number; thoughts: number }
  topModel?: string
  recentSessions?: { startTime?: string; input: number; output: number; model: string }[]
  quotaStatus?: string
  error?: string
}

interface AntigravityData {
  sessionCount?: number
  conversationCount?: number
  model?: string
  quota?: {
    source?: string
    email?: string
    planType?: string
    promptCredits?: {
      available: number
      monthly: number
      used: number
      remainingPercentage?: number | null
      usedPercentage?: number | null
    } | null
    models?: {
      modelId: string
      label: string
      remainingPercentage?: number | null
      usedPercentage?: number | null
      isExhausted?: boolean
      resetTime?: string | null
    }[]
  } | null
  quotaError?: string
  recentSessions?: { id: string; title: string; doneCount: number; totalCount: number }[]
  error?: string
}

interface OpenCodeData {
  sessionCount?: number
  totalCost?: number
  totalTokensIn?: number
  totalTokensOut?: number
  providers?: string[]
  topModel?: string
  error?: string
}

function Bar({ pct, label, sublabel }: { pct: number; label: string; sublabel?: string }) {
  const cls = pct >= 90 ? "danger" : pct >= 70 ? "warn" : ""
  return (
    <div className="ul-bar-wrap">
      <div className="ul-bar-label">
        <span>{label}</span>
        <span>{sublabel ?? `${pct.toFixed(0)}%`}</span>
      </div>
      <div className="ul-bar-track">
        <div className={`ul-bar-fill ${cls}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ul-stat-row">
      <span className="ul-stat-label">{label}</span>
      <span className="ul-stat-value">{value}</span>
    </div>
  )
}

function fmtReset(seconds?: number) {
  if (!seconds) return ""
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `resets in ${h}h ${m}m`
  return `resets in ${m}m`
}

function fmtDate(iso?: string) {
  if (!iso) return "–"
  try { return new Date(iso).toLocaleDateString() } catch { return iso }
}

function CardShell({ id, title, subtitle, icon, children, loading }: {
  id: string; title: string; subtitle?: string; icon: string; children: React.ReactNode; loading?: boolean
}) {
  return (
    <div className={`ul-card ul-card-${id}${loading ? " ul-refreshing" : ""}`}>
      <div className="ul-card-header">
        <div className="ul-card-icon">{icon}</div>
        <div>
          <div className="ul-card-title">{title}</div>
          {subtitle && <div className="ul-card-subtitle">{subtitle}</div>}
        </div>
      </div>
      {children}
    </div>
  )
}

function ClaudeCard({ data, loading }: { data?: ClaudeData; loading?: boolean }) {
  const usage = data?.usage
  const fiveH = usage?.five_hour
  const sevenD = usage?.seven_day
  const cli = data?.cliUsage
  const subtitle = data?.org_id ? "claude.ai" : undefined

  return (
    <CardShell id="claude" title="Claude Code" subtitle={subtitle} icon="✦" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {data?._hint && !usage && !cli && <div className="ul-hint">{data._hint}</div>}
      {/* API limits (5h/7d from claude.ai) */}
      {fiveH && (
        <Bar pct={(fiveH.utilization ?? 0) * 100} label="5-hour limit"
          sublabel={`${((fiveH.utilization ?? 0) * 100).toFixed(0)}% · ${fmtDate(fiveH.resets_at)}`} />
      )}
      {sevenD && (
        <Bar pct={(sevenD.utilization ?? 0) * 100} label="7-day limit"
          sublabel={`${((sevenD.utilization ?? 0) * 100).toFixed(0)}% · resets ${fmtDate(sevenD.resets_at)}`} />
      )}
      {/* CLI limits (from `claude /usage` TUI) */}
      {!fiveH && cli?.sessionPct != null && (
        <Bar pct={cli.sessionPct} label="Session limit"
          sublabel={`${cli.sessionPct}%${cli.sessionResetsAt ? ` · resets ${cli.sessionResetsAt}` : ""}`} />
      )}
      {!sevenD && cli?.weeklyPct != null && (
        <Bar pct={cli.weeklyPct} label="Weekly limit"
          sublabel={`${cli.weeklyPct}%${cli.weeklyResetsAt ? ` · resets ${cli.weeklyResetsAt}` : ""}`} />
      )}
      {data?.numSessions != null && <StatRow label="Sessions" value={String(data.numSessions)} />}
      {!data && !loading && <div className="ul-error">No data</div>}
    </CardShell>
  )
}

function CursorCard({ data, loading }: { data?: CursorData; loading?: boolean }) {
  const summary = data?.usageSummary
  const plan = summary?.plan
  const onDemand = summary?.onDemand
  const membershipType = summary?.membershipType ?? data?.stripe?.membershipType
  const subtitle = data?.me?.email ?? (membershipType ?? undefined)

  // Legacy fallback
  const legacyUsage = data?.usage
  const cp = data?.currentPeriod
  const fastEntry  = legacyUsage?.["gpt-4"] ?? legacyUsage?.["fast"] ?? null
  const fastUsed  = fastEntry?.numRequestsTotal ?? fastEntry?.numRequests ?? 0
  const fastMax   = fastEntry?.maxRequestUsage ?? 0
  const fastPct   = fastMax > 0 ? (fastUsed / fastMax) * 100 : 0

  return (
    <CardShell id="cursor" title="Cursor" subtitle={subtitle} icon="⬡" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {plan?.totalPercentUsed != null && (
        <Bar pct={plan.totalPercentUsed} label="Plan usage"
          sublabel={`${plan.totalPercentUsed.toFixed(0)}%${summary?.billingCycleEnd ? ` · resets ${fmtDate(summary.billingCycleEnd)}` : ""}`} />
      )}
      {plan?.autoPercentUsed != null && plan.autoPercentUsed !== plan.totalPercentUsed && (
        <Bar pct={plan.autoPercentUsed} label="Auto (composer)" sublabel={`${plan.autoPercentUsed.toFixed(0)}%`} />
      )}
      {plan?.apiPercentUsed != null && (
        <Bar pct={plan.apiPercentUsed} label="API (named model)" sublabel={`${plan.apiPercentUsed.toFixed(0)}%`} />
      )}
      {onDemand?.enabled && onDemand.used != null && (
        <StatRow label="On-demand spend" value={`$${(onDemand.used / 100).toFixed(2)}${onDemand.limit != null ? ` / $${(onDemand.limit / 100).toFixed(2)}` : ""}`} />
      )}
      {membershipType && <StatRow label="Plan" value={membershipType} />}
      {/* Legacy fallback rows */}
      {!summary && fastMax > 0 && <Bar pct={fastPct} label="Fast requests" sublabel={`${fastUsed} / ${fastMax}`} />}
      {!summary && cp?.completedRequests != null && (
        <StatRow label="Requests this period" value={String(cp.completedRequests)} />
      )}
      {!data && !loading && <div className="ul-error">No data</div>}
    </CardShell>
  )
}

function CodexCard({ data, loading }: { data?: CodexData; loading?: boolean }) {
  const wham = data?.wham
  const primary   = wham?.rate_limit?.primary_window
  const secondary = wham?.rate_limit?.secondary_window

  const subtitle = [data?.email, data?.plan].filter(Boolean).join(" · ") || undefined
  return (
    <CardShell id="codex" title="Codex" subtitle={subtitle} icon="◈" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {primary?.used_percent != null && (
        <Bar pct={primary.used_percent} label="5-hour limit" sublabel={`${primary.used_percent.toFixed(0)}% · ${fmtReset(primary.reset_after_seconds)}`} />
      )}
      {secondary?.used_percent != null && (
        <Bar pct={secondary.used_percent} label="Weekly limit" sublabel={`${secondary.used_percent.toFixed(0)}% · ${fmtReset(secondary.reset_after_seconds)}`} />
      )}
      {wham?.credits?.balance != null && (
        <StatRow label="Credits" value={`$${wham.credits.balance.toFixed(2)}`} />
      )}
      {data?.sessionCount != null && <StatRow label="Local sessions" value={String(data.sessionCount)} />}
      {data?.active_until && <StatRow label="Active until" value={fmtDate(data.active_until)} />}
      {!data && !loading && <div className="ul-error">No data</div>}
    </CardShell>
  )
}

function OpenCodeCard({ data, loading }: { data?: OpenCodeData; loading?: boolean }) {
  const subtitle = data?.providers?.join(", ") || data?.topModel || undefined
  return (
    <CardShell id="opencode" title="OpenCode" subtitle={subtitle} icon="◇" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {data?.sessionCount != null && <StatRow label="Sessions" value={String(data.sessionCount)} />}
      {data?.totalCost != null && data.totalCost > 0 && <StatRow label="Total cost" value={`$${data.totalCost.toFixed(4)}`} />}
      {data?.totalTokensIn != null && <StatRow label="Input tokens" value={fmtTokens(data.totalTokensIn)} />}
      {data?.totalTokensOut != null && <StatRow label="Output tokens" value={fmtTokens(data.totalTokensOut)} />}
      {data?.topModel && <StatRow label="Top model" value={data.topModel} />}
      {!data && !loading && <div className="ul-error">No data</div>}
    </CardShell>
  )
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function GeminiCard({ data, loading }: { data?: GeminiData; loading?: boolean }) {
  const t = data?.totalTokens
  return (
    <CardShell id="gemini" title="Gemini CLI" subtitle={data?.email ?? undefined} icon="◆" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {data?.quotaStatus && <div className="ul-hint">{data.quotaStatus}</div>}
      {data?.sessionCount != null && <StatRow label="Sessions" value={String(data.sessionCount)} />}
      {t && t.input + t.output > 0 && <>
        <StatRow label="Input tokens"    value={fmtTokens(t.input)} />
        <StatRow label="Output tokens"   value={fmtTokens(t.output)} />
        {t.cached > 0 && <StatRow label="Cached tokens"  value={fmtTokens(t.cached)} />}
        {t.thoughts > 0 && <StatRow label="Thought tokens" value={fmtTokens(t.thoughts)} />}
      </>}
      {data?.topModel && <StatRow label="Model" value={data.topModel} />}
      {!data && !loading && <div className="ul-error">No data</div>}
    </CardShell>
  )
}

function AntigravityCard({ data, loading }: { data?: AntigravityData; loading?: boolean }) {
  const sessions = data?.recentSessions ?? []
  const quota = data?.quota
  const credits = quota?.promptCredits
  const models = (quota?.models ?? []).filter(m => m.remainingPercentage != null).slice(0, 6)
  return (
    <CardShell id="antigravity" title="Antigravity" subtitle={quota?.email || data?.model || undefined} icon="⟡" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {data?.quotaError && <div className="ul-hint">Quota unavailable: {data.quotaError}</div>}
      {credits?.usedPercentage != null && (
        <Bar
          pct={credits.usedPercentage * 100}
          label="Prompt credits"
          sublabel={`${credits.used.toLocaleString()} / ${credits.monthly.toLocaleString()}`}
        />
      )}
      {models.map(m => (
        <Bar
          key={m.modelId}
          pct={(m.usedPercentage ?? 0) * 100}
          label={m.label}
          sublabel={m.isExhausted ? "exhausted" : `${Math.round((m.remainingPercentage ?? 0) * 100)}% left`}
        />
      ))}
      {quota?.source && <StatRow label="Quota source" value={quota.source} />}
      {data?.sessionCount != null && <StatRow label="Brain sessions" value={String(data.sessionCount)} />}
      {data?.conversationCount != null && <StatRow label="Conversations" value={String(data.conversationCount)} />}
      {sessions.length > 0 && <>
        <div className="ul-section-label">Recent tasks</div>
        {sessions.map(s => (
          <div key={s.id} className="ul-ag-task">
            <span className="ul-ag-task-title">{s.title}</span>
            {s.totalCount > 0 && (
              <span className="ul-ag-task-prog">{s.doneCount}/{s.totalCount}</span>
            )}
          </div>
        ))}
      </>}
      {!data && !loading && <div className="ul-error">No data</div>}
    </CardShell>
  )
}

export function UsageLimits() {
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await fetch("/api/usage")
      if (!r.ok) throw new Error(`/api/usage returned HTTP ${r.status}`)
      setData(await r.json())
      setLastUpdated(new Date())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(() => refresh(true), 60_000)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <div className="ul-root">
      <div className="ul-toolbar">
        <span className="ul-toolbar-label">
          {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : "Loading…"}
        </span>
        <button className={`ul-refresh-btn${loading ? " ul-loading" : ""}`} onClick={() => refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>
      {error && <div className="ul-page-error">Usage data failed to load: {error}</div>}
      <div className="ul-grid">
        <ClaudeCard   data={data?.claude}   loading={loading && !data?.claude} />
        <CursorCard   data={data?.cursor}   loading={loading && !data?.cursor} />
        <CodexCard    data={data?.codex}    loading={loading && !data?.codex} />
        <OpenCodeCard data={data?.opencode} loading={loading && !data?.opencode} />
        <GeminiCard      data={data?.gemini}      loading={loading && !data?.gemini} />
        <AntigravityCard data={data?.antigravity} loading={loading && !data?.antigravity} />
      </div>
    </div>
  )
}
