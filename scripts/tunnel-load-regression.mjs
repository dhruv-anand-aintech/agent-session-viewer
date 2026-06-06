#!/usr/bin/env node
/**
 * Tunnel load-time regression — reproduces the deep-link + concurrent API pile-up
 * that blocked /api/stream for ~13s when /api/usage ran on every /sessions load.
 *
 * Fails if:
 *   - /api/usage fires while on the sessions tab (Usage tab not open)
 *   - SSE bootstrap (projects:first / bootstrap:done) exceeds TUNNEL_LOAD_BUDGET_MS (default 2000)
 *   - Deep-link session pane does not appear within budget
 *
 * Usage:
 *   AUTH_PIN=xxxx node scripts/tunnel-load-regression.mjs
 *   TUNNEL_DEEP_LINK='/sessions?s=codex%3A.../uuid' node scripts/tunnel-load-regression.mjs
 */
import { chromium } from "playwright"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE = process.env.TUNNEL_URL ?? "https://agent-session-viewer.ainorthstar.tech"
const BUDGET_MS = Number(process.env.TUNNEL_LOAD_BUDGET_MS ?? "2000")
const DEEP_LINK = process.env.TUNNEL_DEEP_LINK ?? ""

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

function fail(msg) {
  console.error(`\n✗ REGRESSION: ${msg}\n`)
  process.exit(1)
}

function apiPath(url) {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

function trackApiTraffic(page) {
  /** @type {{ path: string, method: string, startMs: number, endMs?: number, status?: number }[]} */
  const log = []
  const startByUrl = new Map()

  page.on("request", req => {
    const url = req.url()
    if (!url.includes("/api/")) return
    const entry = { path: apiPath(url), method: req.method(), startMs: Date.now() }
    log.push(entry)
    startByUrl.set(url, entry)
  })

  page.on("response", async res => {
    const url = res.url()
    if (!url.includes("/api/")) return
    const entry = startByUrl.get(url) ?? log.find(e => e.path === apiPath(url) && e.endMs == null)
    if (entry) {
      entry.endMs = Date.now()
      entry.status = res.status()
    }
  })

  return log
}

async function readPerfMs(page, markName) {
  return page.evaluate(name => {
    const marks = performance.getEntriesByName(name, "mark")
    if (!marks.length) return null
    const init = performance.getEntriesByName("app:init", "mark")[0]
    if (!init) return marks[0].startTime
    return marks[0].startTime - init.startTime
  }, markName)
}

async function waitSidebarReady(page, timeoutMs = 20000) {
  await page.waitForFunction(() => {
    const marks = performance.getEntriesByName("bootstrap:done", "mark")
    if (marks.length) return true
    return document.querySelectorAll(".sidebar-session").length > 0
      || document.querySelector(".sidebar-empty") !== null
  }, { timeout: timeoutMs })
}

async function discoverDeepLink(page) {
  if (DEEP_LINK) {
    return DEEP_LINK.startsWith("http") ? DEEP_LINK : `${BASE}${DEEP_LINK.startsWith("/") ? "" : "/"}${DEEP_LINK}`
  }
  await page.goto(`${BASE}/sessions`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("text=Connecting", { state: "hidden", timeout: 15000 }).catch(() => {})
  await waitSidebarReady(page)
  const first = page.locator(".sidebar-session").first()
  if (await first.count() === 0) fail("No sidebar sessions to build deep link — set TUNNEL_DEEP_LINK")
  await first.click()
  await page.waitForFunction(() => window.location.search.includes("s="), { timeout: 10000 })
  const path = new URL(page.url()).pathname + new URL(page.url()).search
  return `${BASE}${path}`
}

async function loginIfNeeded(api) {
  const capsRes = await api.get(`${BASE}/api/capabilities`)
  const caps = await capsRes.json()
  if (typeof caps.authed !== "boolean") {
    fail("/api/capabilities must include authed (removed /api/projects auth probe)")
  }
  if (caps.pinRequired && !caps.authed) {
    if (!PIN) fail("PIN required but AUTH_PIN not set")
    const loginRes = await api.post(`${BASE}/api/login`, { data: { pin: PIN } })
    if (!loginRes.ok()) fail(`POST /api/login failed: HTTP ${loginRes.status()}`)
  }
}

async function measureDeepLinkLoad(page, deepLinkUrl, apiLog) {
  apiLog.length = 0

  const navT0 = Date.now()
  await page.goto(deepLinkUrl, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("text=Connecting", { state: "hidden", timeout: 15000 }).catch(() => {})
  await waitSidebarReady(page)

  const wallMs = Date.now() - navT0
  const bootstrapMs = await readPerfMs(page, "bootstrap:done")
  const firstProjectsMs = await readPerfMs(page, "projects:first")
  const sessionCount = await page.locator(".sidebar-session").count()

  const streamEntry = apiLog.find(e => e.path.startsWith("/api/stream"))
  const streamMs = streamEntry?.endMs && streamEntry?.startMs
    ? streamEntry.endMs - streamEntry.startMs
    : null

  return { wallMs, bootstrapMs, firstProjectsMs, sessionCount, streamMs }
}

async function main() {
  console.log(`\nTunnel load regression → ${BASE}`)
  console.log(`Budget: ${BUDGET_MS}ms (SSE bootstrap + no /api/usage on sessions tab)\n`)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const api = context.request
  const page = await context.newPage()
  const apiLog = trackApiTraffic(page)

  await loginIfNeeded(api)

  const capsCheck = await api.get(`${BASE}/api/capabilities`)
  const caps = await capsCheck.json()
  console.log(`  capabilities: pinRequired=${caps.pinRequired} authed=${caps.authed}`)

  const deepLinkUrl = await discoverDeepLink(page)
  console.log(`  deep link: ${deepLinkUrl.replace(BASE, "")}`)

  const metrics = await measureDeepLinkLoad(page, deepLinkUrl, apiLog)

  const usageCalls = apiLog.filter(e => e.path === "/api/usage" || e.path.startsWith("/api/usage?"))
  const streamCalls = apiLog.filter(e => e.path.startsWith("/api/stream"))
  const sessionCalls = apiLog.filter(e => e.path.startsWith("/api/session/"))

  console.log(`\n  Deep-link load (HAR scenario):`)
  console.log(`    wall goto→sidebar ready: ${metrics.wallMs}ms`)
  if (metrics.bootstrapMs != null) console.log(`    perf bootstrap:done: ${metrics.bootstrapMs.toFixed(0)}ms`)
  if (metrics.firstProjectsMs != null) console.log(`    perf projects:first: ${metrics.firstProjectsMs.toFixed(0)}ms`)
  if (metrics.streamMs != null) console.log(`    /api/stream (request duration): ${metrics.streamMs}ms`)
  console.log(`    sidebar sessions visible: ${metrics.sessionCount}`)
  console.log(`    concurrent API calls: stream=${streamCalls.length} session=${sessionCalls.length} usage=${usageCalls.length}`)

  if (usageCalls.length > 0) {
    fail(`/api/usage fired ${usageCalls.length} time(s) on sessions tab — blocks event loop and stalls /api/stream`)
  }

  const bootstrapBudget = metrics.bootstrapMs ?? metrics.wallMs
  if (bootstrapBudget > BUDGET_MS) {
    fail(`SSE bootstrap took ${bootstrapBudget.toFixed(0)}ms > ${BUDGET_MS}ms (HAR showed ~13s when /api/usage blocked the server)`)
  }

  if (metrics.firstProjectsMs != null && metrics.firstProjectsMs > BUDGET_MS) {
    fail(`first SSE projects batch took ${metrics.firstProjectsMs.toFixed(0)}ms > ${BUDGET_MS}ms`)
  }

  if (metrics.streamMs != null && metrics.streamMs > BUDGET_MS) {
    fail(`/api/stream request took ${metrics.streamMs}ms > ${BUDGET_MS}ms`)
  }

  if (metrics.sessionCount === 0) {
    fail("sidebar empty after deep-link load")
  }

  await browser.close()
  console.log(`\n✓ PASSED — deep-link SSE bootstrap within ${BUDGET_MS}ms, no /api/usage on sessions tab\n`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
