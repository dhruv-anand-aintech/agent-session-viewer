#!/usr/bin/env node
/**
 * Usage Limits Poller
 *
 * Polls live usage APIs for Claude, Codex, Cursor, and OpenCode.
 * Syncs results to the agent-usage-limits Cloudflare Worker (KV).
 * Fires webhook notifications when utilization crosses configured thresholds.
 *
 * Runs as a polling interval inside daemon/watch.mjs, or standalone:
 *   node daemon/usage-limits.mjs
 *
 * Env vars (add to .env or export before starting):
 *   USAGE_WORKER_URL   - agent-usage-limits worker URL (e.g. https://agent-usage-limits.dhruv-anand.workers.dev)
 *   USAGE_SYNC_SECRET  - X-Sync-Secret for that worker
 *   CLAUDE_SESSION_KEY - sessionKey cookie from claude.ai (for 5h/7d limits)
 *   WEBHOOK_URL        - URL to POST when a limit is hit (optional)
 *   LIMIT_THRESHOLD    - utilization % to trigger webhook (default: 80)
 *
 * Cursor auth is read from ~/.cursor/mcp.json or ~/.cursor-server/data/User/globalStorage/
 * Codex auth is read from ~/.codex/auth.json (same as sync.sh)
 * Claude stats are read from ~/.claude/stats-cache.json
 */

import fs from "node:fs"
import path from "node:path"
import { homedir, tmpdir } from "node:os"
import { execSync } from "node:child_process"

// ── Config (lazy — read at call time so .env loaded by watch.mjs takes effect) ─

function cfg() {
  return {
    workerUrl:     process.env.USAGE_WORKER_URL  ?? "https://agent-usage-limits.dhruv-anand.workers.dev",
    syncSecret:    process.env.USAGE_SYNC_SECRET ?? "814cd2dab3a6b103d5c841e348c00502a5704b7671ce2abfd4a87000fc22b52b",
    sessionKey:    process.env.CLAUDE_SESSION_KEY ?? "",
    webhookUrl:    process.env.WEBHOOK_URL ?? "",
    threshold:     Number(process.env.LIMIT_THRESHOLD ?? 80),
  }
}

const POLL_INTERVAL_MS = 5 * 60 * 1000  // 5 minutes

// Track last notification state to avoid repeat alerts
const _notified = new Map()

function log(...args) {
  console.log(`[usage-limits]`, ...args)
}

// ── Webhook ───────────────────────────────────────────────────────────────────

async function maybeNotify(service, label, pct) {
  const { webhookUrl, threshold } = cfg()
  if (!webhookUrl || pct < threshold) return
  const key = `${service}:${label}`
  if (_notified.get(key) === true) return  // already fired
  _notified.set(key, true)
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service,
        label,
        pct,
        threshold,
        message: `⚠️ ${service} ${label} is at ${pct.toFixed(0)}% (threshold: ${threshold}%)`,
        ts: Date.now(),
      }),
    })
    log(`Webhook fired: ${service} ${label} at ${pct.toFixed(0)}%`)
  } catch (e) {
    log(`Webhook error: ${e.message}`)
  }
}

// Reset notifications once a window rolls over (utilization drops below threshold)
function maybeResetNotify(service, label, pct) {
  if (pct < cfg().threshold) {
    _notified.delete(`${service}:${label}`)
  }
}

// ── KV sync ───────────────────────────────────────────────────────────────────

async function syncToWorker(service, data) {
  const { workerUrl, syncSecret } = cfg()
  try {
    const resp = await fetch(`${workerUrl}/api/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sync-Secret": syncSecret,
      },
      body: JSON.stringify({ service, data }),
    })
    if (!resp.ok) {
      log(`Sync ${service} failed: ${resp.status}`)
    }
  } catch (e) {
    log(`Sync ${service} error: ${e.message}`)
  }
}

// ── Claude ────────────────────────────────────────────────────────────────────

async function pollClaude() {
  const statsFile = path.join(homedir(), ".claude", "stats-cache.json")
  let stats = {}
  try { stats = JSON.parse(fs.readFileSync(statsFile, "utf8")) } catch { /* missing is fine */ }

  let usageData = {}

  const { sessionKey } = cfg()
  if (sessionKey) {
    try {
      const orgsResp = await fetch("https://claude.ai/api/organizations", {
        headers: {
          Cookie: `sessionKey=${sessionKey}`,
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      })
      if (orgsResp.ok) {
        const orgs = await orgsResp.json()
        const org = Array.isArray(orgs)
          ? (orgs.find(o => o.capabilities?.includes("chat")) ?? orgs[0])
          : null
        if (org?.uuid) {
          const usageResp = await fetch(`https://claude.ai/api/organizations/${org.uuid}/usage`, {
            headers: {
              Cookie: `sessionKey=${sessionKey}`,
              Accept: "application/json",
              "User-Agent": "Mozilla/5.0",
            },
          })
          if (usageResp.ok) {
            const usage = await usageResp.json()
            usageData = { org_id: org.uuid, usage }

            // Check limits and fire webhooks
            const fiveH = usage?.five_hour
            const sevenD = usage?.seven_day
            if (fiveH?.utilization != null) {
              const pct = fiveH.utilization * 100
              await maybeNotify("Claude", "5h limit", pct)
              maybeResetNotify("Claude", "5h limit", pct)
            }
            if (sevenD?.utilization != null) {
              const pct = sevenD.utilization * 100
              await maybeNotify("Claude", "7d limit", pct)
              maybeResetNotify("Claude", "7d limit", pct)
            }
          }
        }
      }
    } catch (e) {
      log(`Claude usage fetch error: ${e.message}`)
    }
  }

  await syncToWorker("claude_stats", { ...stats, ...usageData })
}

// ── Codex ─────────────────────────────────────────────────────────────────────

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1] + "==="
    return JSON.parse(Buffer.from(payload, "base64url").toString())
  } catch { return {} }
}

async function pollCodex() {
  const authFile = path.join(homedir(), ".codex", "auth.json")
  if (!fs.existsSync(authFile)) return

  let auth
  try { auth = JSON.parse(fs.readFileSync(authFile, "utf8")) } catch { return }

  const tokens = auth?.tokens ?? {}
  const accessToken = tokens.access_token ?? ""
  const accountId   = tokens.account_id   ?? ""
  const idToken     = tokens.id_token     ?? ""

  let plan = ""
  let activeUntil = ""
  if (idToken) {
    const decoded = decodeJwtPayload(idToken)
    const chatgptAuth = decoded["https://api.openai.com/auth"] ?? {}
    plan        = chatgptAuth.chatgpt_plan_type ?? ""
    activeUntil = chatgptAuth.chatgpt_subscription_active_until ?? ""
  }

  // Count local sessions
  const sessionFiles = fs.readdirSync(path.join(homedir(), ".codex"), { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".jsonl")).length
  let historyCount = 0
  try { historyCount = fs.readFileSync(path.join(homedir(), ".codex", "history.jsonl"), "utf8").split("\n").filter(Boolean).length } catch {}

  let wham = {}
  if (accessToken && accountId) {
    try {
      const whamResp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "ChatGPT-Account-Id": accountId,
          Origin: "https://chatgpt.com",
          Referer: "https://chatgpt.com/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      })
      if (whamResp.ok) {
        wham = await whamResp.json()

        // Check limits
        const primary   = wham?.rate_limit?.primary_window
        const secondary = wham?.rate_limit?.secondary_window
        if (primary?.used_percent != null) {
          await maybeNotify("Codex", "5h limit", primary.used_percent)
          maybeResetNotify("Codex", "5h limit", primary.used_percent)
        }
        if (secondary?.used_percent != null) {
          await maybeNotify("Codex", "weekly limit", secondary.used_percent)
          maybeResetNotify("Codex", "weekly limit", secondary.used_percent)
        }
      }
    } catch (e) {
      log(`Codex wham fetch error: ${e.message}`)
    }
  }

  await syncToWorker("codex_stats", {
    plan,
    active_until: activeUntil,
    sessionCount: sessionFiles,
    historyCount,
    wham,
  })
}

// ── Cursor ────────────────────────────────────────────────────────────────────

function readCursorAuth() {
  const vscdb = path.join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
  if (fs.existsSync(vscdb)) {
    try {
      const tmpScript = path.join(tmpdir(), "_cursor_auth.py")
      fs.writeFileSync(tmpScript, [
        "import sqlite3,base64,json",
        `con=sqlite3.connect(${JSON.stringify(vscdb)})`,
        `row=con.execute("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'").fetchone()`,
        "t=row[0] if row else ''",
        "parts=t.split('.')",
        "p=json.loads(base64.urlsafe_b64decode(parts[1]+'===')) if len(parts)>1 else {}",
        "print(json.dumps({'token':t,'userId':p.get('sub','')}))",
      ].join("\n"))
      const out = execSync(`python3 "${tmpScript}"`, { encoding: "utf8" }).trim()
      const { token, userId } = JSON.parse(out)
      if (token && userId) return { token, userId }
    } catch {}
  }
  const token  = process.env.CURSOR_ACCESS_TOKEN ?? ""
  const userId = process.env.CURSOR_USER_ID ?? ""
  if (token && userId) return { token, userId }
  return null
}

async function pollCursor() {
  const auth = readCursorAuth()
  if (!auth) {
    log("Cursor: no auth found, skipping")
    return
  }
  const { token, userId } = auth
  const sessionCookie = `WorkosCursorSessionToken=${userId}%3A%3A${token}`
  const cookieHeaders = {
    Cookie: sessionCookie,
    "User-Agent": "cursor-usage-tracker/1.1",
    Accept: "application/json",
  }

  let usage = null, stripe = null, currentPeriod = null
  try {
    const [uR, sR, cpR] = await Promise.allSettled([
      fetch(`https://cursor.com/api/usage?user=${userId}`, { headers: cookieHeaders }),
      fetch("https://cursor.com/api/auth/stripe", { headers: cookieHeaders }),
      fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Connect-Protocol-Version": "1",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ])
    if (uR.status === "fulfilled" && uR.value.ok) usage = await uR.value.json()
    if (sR.status === "fulfilled" && sR.value.ok) stripe = await sR.value.json()
    if (cpR.status === "fulfilled" && cpR.value.ok) currentPeriod = await cpR.value.json()
  } catch (e) {
    log(`Cursor fetch error: ${e.message}`)
  }

  // Cursor doesn't expose a simple utilization % — check fast request usage
  if (usage) {
    const fast = usage["gpt-4"]?.numRequestsTotal ?? usage["fast"]?.numRequests ?? 0
    const fastLimit = usage["gpt-4"]?.maxRequestUsage ?? usage["fast"]?.maxRequests ?? 0
    if (fastLimit > 0) {
      const pct = (fast / fastLimit) * 100
      await maybeNotify("Cursor", "fast requests", pct)
      maybeResetNotify("Cursor", "fast requests", pct)
    }
  }

  // Cursor is fetched live by the Worker — no need to sync to KV
  // (kept here only for webhook notifications)
}

// ── OpenCode ──────────────────────────────────────────────────────────────────

async function pollOpenCode() {
  const pkgFile = path.join(homedir(), ".opencode", "package.json")
  if (!fs.existsSync(pkgFile)) return

  const providers = []
  for (const cf of [
    path.join(homedir(), ".opencode", "config.json"),
    path.join(homedir(), ".opencode", "config.toml"),
  ]) {
    if (fs.existsSync(cf) && cf.endsWith(".json")) {
      try {
        const d = JSON.parse(fs.readFileSync(cf, "utf8"))
        for (const [k, v] of Object.entries(d.providers ?? {})) {
          providers.push({ name: k, model: typeof v === "object" ? (v.model ?? "") : "" })
        }
      } catch {}
    }
  }

  const sessions = []
  function walkDir(dir) {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walkDir(full)
      else if (e.isFile() && e.name.endsWith(".json")) {
        try {
          const d = JSON.parse(fs.readFileSync(full, "utf8"))
          if (typeof d === "object" && ("cost" in d || "tokens" in d || "usage" in d)) {
            sessions.push({
              cost: d.cost ?? (typeof d.usage === "object" ? d.usage?.cost : 0) ?? 0,
              tokens: d.tokens ?? (typeof d.usage === "object" ? d.usage?.total_tokens : 0) ?? 0,
            })
          }
        } catch {}
      }
    }
  }
  walkDir(path.join(homedir(), ".opencode", "sessions"))

  await syncToWorker("opencode_stats", { providers, recentSessions: sessions })
}

// ── Main poll loop ────────────────────────────────────────────────────────────

export async function pollUsageLimits() {
  log("Polling usage limits…")
  await Promise.allSettled([
    pollClaude(),
    pollCodex(),
    pollCursor(),
    pollOpenCode(),
  ])
  log("Poll complete.")
}

// Standalone execution
if (process.argv[1] === new URL(import.meta.url).pathname) {
  await pollUsageLimits()

  log(`Starting poll loop every ${POLL_INTERVAL_MS / 1000 / 60}m`)
  setInterval(() => pollUsageLimits().catch(e => log("Poll error:", e.message)), POLL_INTERVAL_MS)

  // Keep alive
  setInterval(() => {}, 60_000)
}
