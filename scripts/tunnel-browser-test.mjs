#!/usr/bin/env node
/**
 * Playwright browser test against the Cloudflare tunnel deployment.
 * Usage:
 *   AUTH_PIN=xxxx node scripts/tunnel-browser-test.mjs
 *   # or relies on .env AUTH_PIN in repo root
 */
import { chromium } from "playwright"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE = process.env.TUNNEL_URL ?? "https://agent-session-viewer.ainorthstar.tech"
const OUT = join(ROOT, "tmp", "tunnel-playwright")
mkdirSync(OUT, { recursive: true })

function loadPin() {
  if (process.env.AUTH_PIN) return process.env.AUTH_PIN
  const envPath = join(ROOT, ".env")
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^AUTH_PIN=(.+)$/m)
    if (m) return m[1].trim()
  }
  return null
}

const PIN = loadPin()

function row(label, ms, ok, detail = "") {
  return { label, ms: Math.round(ms), ok, detail }
}

async function timedFetch(page, url, init = {}) {
  const t0 = Date.now()
  const result = await page.evaluate(async ({ url, init }) => {
    const t0 = performance.now()
    try {
      const r = await fetch(url, { credentials: "include", ...init })
      const body = await r.text()
      return {
        ok: r.ok,
        status: r.status,
        ms: performance.now() - t0,
        size: body.length,
        body: body.slice(0, 500),
      }
    } catch (err) {
      return { ok: false, status: 0, ms: performance.now() - t0, error: String(err) }
    }
  }, { url, init })
  return { ...result, wallMs: Date.now() - t0 }
}

async function main() {
  const results = []
  const networkLog = []

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const api = context.request
  const page = await context.newPage()

  page.on("response", async res => {
    const url = res.url()
    if (!url.includes("/api/")) return
    try {
      const timing = res.request().timing()
      networkLog.push({
        url: url.replace(BASE, ""),
        status: res.status(),
        durationMs: timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null,
      })
    } catch { /* ignore */ }
  })

  console.log(`\nTunnel browser test → ${BASE}\n`)

  // ── 1. Public endpoints (no cookie) ───────────────────────────────────────
  await page.goto(`${BASE}/api/capabilities`, { waitUntil: "domcontentloaded" })
  const capsText = await page.locator("body").innerText()
  const caps = JSON.parse(capsText)
  results.push(row("/api/capabilities (public)", 0, caps.pinRequired === true, `pinRequired=${caps.pinRequired}`))

  const health = await timedFetch(page, `${BASE}/api/health`)
  results.push(row("/api/health", health.ms, health.ok, health.body?.slice(0, 120)))

  // ── 2. Login + app shell ───────────────────────────────────────────────────
  const appT0 = Date.now()
  if (caps.pinRequired && !caps.authed) {
    if (!PIN) throw new Error("PIN required but AUTH_PIN not set (env or .env)")
    const loginT0 = Date.now()
    const loginRes = await api.post(`${BASE}/api/login`, { data: { pin: PIN } })
    const loginBody = await loginRes.json().catch(() => ({}))
    if (!loginRes.ok() || !loginBody.ok) {
      throw new Error(`PIN login failed: HTTP ${loginRes.status()}`)
    }
    results.push(row("POST /api/login", Date.now() - loginT0, true))
  }

  await page.goto(`${BASE}/sessions`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("text=Connecting", { state: "hidden", timeout: 15000 }).catch(() => {})
  results.push(row("App shell /sessions", Date.now() - appT0, true))

  await page.screenshot({ path: join(OUT, "02-after-auth.png"), fullPage: true })

  // ── 3. Authenticated API via browser fetch ────────────────────────────────
  const authedCaps = await timedFetch(page, `${BASE}/api/capabilities`)
  results.push(row("/api/capabilities (authed)", authedCaps.ms, authedCaps.ok && authedCaps.body.includes('"authed":true')))

  // ── 4. Sidebar SSE + session list ─────────────────────────────────────────
  const sidebarT0 = Date.now()
  await page.waitForFunction(() => {
    const marks = performance.getEntriesByName("bootstrap:done", "mark")
    if (marks.length) return true
    return document.querySelectorAll(".sidebar-session").length > 0
      || document.querySelector(".sidebar-empty") !== null
  }, { timeout: 45000 })
  const sessionCount = await page.locator(".sidebar-session").count()
  const emptyText = await page.locator(".sidebar-empty").first().innerText().catch(() => "")
  results.push(row(
    "Sidebar sessions visible",
    Date.now() - sidebarT0,
    sessionCount > 0,
    sessionCount > 0 ? `${sessionCount} items` : emptyText || "empty",
  ))
  await page.screenshot({ path: join(OUT, "03-sidebar-loaded.png"), fullPage: true })

  // ── 5. Click first session → message pane ───────────────────────────────
  const clickT0 = Date.now()
  const firstSession = page.locator(".sidebar-session").first()
  const sessionName = (await firstSession.locator(".ss-name").innerText().catch(() => "")).trim()
  await firstSession.click()

  await page.waitForFunction(() => {
    const pane = document.querySelector(
      ".pp-text, .message-block, .block-body, .pp-tool-card, .empty-state",
    )
    return !!pane
  }, { timeout: 45000 }).catch(() => {})

  const hasMessages = await page.locator(".pp-text, .message-block, .block-body, .pp-tool-card").count() > 0
  const emptyState = await page.locator(".empty-state").isVisible().catch(() => false)
  results.push(row("Open first session", Date.now() - clickT0, hasMessages || !emptyState, sessionName || "unknown"))
  await page.screenshot({ path: join(OUT, "04-session-open.png"), fullPage: true })

  // ── 6. Session API for selected URL ─────────────────────────────────────
  const href = await page.evaluate(() => window.location.href)
  const deepLink = new URL(href)
  const sParam = deepLink.searchParams.get("s")
  if (sParam) {
    const slash = sParam.lastIndexOf("/")
    const project = encodeURIComponent(sParam.slice(0, slash))
    const sessionId = sParam.slice(slash + 1)
    const sessionApi = await timedFetch(page, `${BASE}/api/session/${project}/${sessionId}?tail=5`)
    results.push(row("/api/session?tail=5", sessionApi.ms, sessionApi.ok, `status=${sessionApi.status}`))
  }

  // ── 7. Search interaction ─────────────────────────────────────────────────
  const searchInput = page.locator(".sidebar-search-input")
  if (await searchInput.isVisible()) {
    const searchT0 = Date.now()
    await searchInput.fill("tunnel")
    await page.waitForTimeout(400)
    const searchApi = networkLog.filter(n => n.url.includes("/api/search"))
    results.push(row("Sidebar search typing", Date.now() - searchT0, true, `${searchApi.length} search API calls`))
    await page.screenshot({ path: join(OUT, "05-search.png"), fullPage: true })
    await searchInput.fill("")
  }

  // ── 8. Usage tab ──────────────────────────────────────────────────────────
  const usageTab = page.locator(".topbar-tab", { hasText: "Usage" }).first()
  if (await usageTab.isVisible().catch(() => false)) {
    const usageT0 = Date.now()
    await usageTab.click()
    await page.waitForURL("**/usage**", { timeout: 10000 }).catch(() => {})
    const usageFetch = await timedFetch(page, `${BASE}/api/usage`).catch(() => null)
    results.push(row("/usage tab + /api/usage", Date.now() - usageT0, usageFetch?.ok ?? true))
    await page.screenshot({ path: join(OUT, "06-usage.png"), fullPage: true })
    await page.goto(`${BASE}/sessions`, { waitUntil: "domcontentloaded" })
  }

  await browser.close()

  // ── Report ────────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok)
  console.log("Results:")
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗"
    const detail = r.detail ? ` — ${r.detail}` : ""
    console.log(`  ${mark} ${r.label}: ${r.ms}ms${detail}`)
  }

  if (networkLog.length) {
    console.log("\nAPI network (browser):")
    for (const n of networkLog.slice(0, 20)) {
      console.log(`  ${n.status} ${n.durationMs ?? "?"}ms ${n.url}`)
    }
  }

  console.log(`\nScreenshots: ${OUT}/`)
  console.log(failed.length ? `\nFAILED: ${failed.length}/${results.length}` : `\nPASSED: ${results.length}/${results.length}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
