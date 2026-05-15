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
  usage?: Record<string, { numRequests?: number; numRequestsTotal?: number; maxRequestUsage?: number }>
  stripe?: { membershipType?: string; daysRemainingOnTrial?: number }
  currentPeriod?: { completedRequests?: number; startOfCurrentPeriod?: string }
  error?: string
}

interface CodexData {
  plan?: string
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
  error?: string
}

interface AntigravityData {
  sessionCount?: number
  conversationCount?: number
  model?: string
  recentSessions?: { id: string; title: string; doneCount: number; totalCount: number }[]
  error?: string
}

interface OpenCodeData {
  providers?: { name: string; model: string }[]
  recentSessions?: { cost: number; tokens: number }[]
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
  const subtitle = data?.org_id ? "claude.ai" : undefined

  return (
    <CardShell id="claude" title="Claude Code" subtitle={subtitle} icon="✦" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {data?._hint && !usage && <div className="ul-hint">{data._hint}</div>}
      {fiveH && (
        <Bar pct={(fiveH.utilization ?? 0) * 100} label="5-hour limit"
          sublabel={`${((fiveH.utilization ?? 0) * 100).toFixed(0)}% · ${fmtDate(fiveH.resets_at)}`} />
      )}
      {sevenD && (
        <Bar pct={(sevenD.utilization ?? 0) * 100} label="7-day limit"
          sublabel={`${((sevenD.utilization ?? 0) * 100).toFixed(0)}% · resets ${fmtDate(sevenD.resets_at)}`} />
      )}
      {data?.numSessions != null && <StatRow label="Sessions" value={String(data.numSessions)} />}
      {!data && !loading && <div className="ul-error">No data</div>}
    </CardShell>
  )
}

function CursorCard({ data, loading }: { data?: CursorData; loading?: boolean }) {
  const stripe = data?.stripe
  const usage = data?.usage
  const cp = data?.currentPeriod
  const plan = stripe?.membershipType ?? "–"

  // Find fast/premium request entries
  const fastEntry  = usage?.["gpt-4"] ?? usage?.["fast"] ?? null
  const totalEntry = usage?.["gpt-3.5-turbo-unlimited"] ?? usage?.["slow"] ?? null
  const fastUsed  = fastEntry?.numRequestsTotal ?? fastEntry?.numRequests ?? 0
  const fastMax   = fastEntry?.maxRequestUsage ?? 0
  const fastPct   = fastMax > 0 ? (fastUsed / fastMax) * 100 : 0

  return (
    <CardShell id="cursor" title="Cursor" subtitle={plan !== "–" ? plan : undefined} icon="⬡" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {fastMax > 0 && <Bar pct={fastPct} label="Fast requests" sublabel={`${fastUsed} / ${fastMax}`} />}
      {cp?.completedRequests != null && (
        <StatRow label="Requests this period" value={String(cp.completedRequests)} />
      )}
      {cp?.startOfCurrentPeriod && (
        <StatRow label="Period start" value={fmtDate(cp.startOfCurrentPeriod)} />
      )}
      {stripe?.daysRemainingOnTrial != null && stripe.daysRemainingOnTrial > 0 && (
        <StatRow label="Trial days left" value={String(stripe.daysRemainingOnTrial)} />
      )}
      {totalEntry && (
        <StatRow label="Slow requests" value={String(totalEntry.numRequests ?? totalEntry.numRequestsTotal ?? 0)} />
      )}
      {!data && !loading && <div className="ul-error">No data</div>}
    </CardShell>
  )
}

function CodexCard({ data, loading }: { data?: CodexData; loading?: boolean }) {
  const wham = data?.wham
  const primary   = wham?.rate_limit?.primary_window
  const secondary = wham?.rate_limit?.secondary_window

  return (
    <CardShell id="codex" title="Codex" subtitle={data?.plan ?? undefined} icon="◈" loading={loading}>
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
  const sessions = data?.recentSessions ?? []
  const totalCost   = sessions.reduce((s, r) => s + (r.cost ?? 0), 0)
  const totalTokens = sessions.reduce((s, r) => s + (r.tokens ?? 0), 0)
  const providers   = data?.providers ?? []

  return (
    <CardShell id="opencode" title="OpenCode" subtitle={providers.map(p => p.name).join(", ") || undefined} icon="◇" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
      {totalCost > 0 && <StatRow label="Total cost" value={`$${totalCost.toFixed(4)}`} />}
      {totalTokens > 0 && <StatRow label="Total tokens" value={totalTokens.toLocaleString()} />}
      {sessions.length > 0 && <StatRow label="Sessions" value={String(sessions.length)} />}
      {providers.map(p => (
        <StatRow key={p.name} label={p.name} value={p.model || "–"} />
      ))}
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
  return (
    <CardShell id="antigravity" title="Antigravity" subtitle={data?.model || undefined} icon="⟡" loading={loading}>
      {data?.error && <div className="ul-error">{data.error}</div>}
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

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await fetch("/api/usage")
      if (r.ok) {
        setData(await r.json())
        setLastUpdated(new Date())
      }
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
