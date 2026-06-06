import { chromium } from "playwright"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const BASE = process.env.TUNNEL_URL ?? "https://agent-session-viewer.ainorthstar.tech"
export const BUDGET_MS = Number(process.env.TUNNEL_LOAD_BUDGET_MS ?? "2000")
export const REFRESH_BUDGET_MS = Number(process.env.TUNNEL_REFRESH_BUDGET_MS ?? BUDGET_MS)
export const DOC_BUDGET_MS = Number(process.env.TUNNEL_DOC_BUDGET_MS ?? "5000")
export const DEEP_LINK = process.env.TUNNEL_DEEP_LINK ?? ""
export const OUT = join(ROOT, "tmp", "tunnel-playwright")

export function loadPin() {
  if (process.env.AUTH_PIN) return process.env.AUTH_PIN
  const envPath = join(ROOT, ".env")
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^AUTH_PIN=(.+)$/m)
    if (m) return m[1].trim()
  }
  return null
}

export const PIN = loadPin()

export function fail(msg) {
  console.error(`\n✗ REGRESSION: ${msg}\n`)
  process.exit(1)
}

export function isHeadless() {
  return process.env.HEADLESS === "1" || process.env.CI === "true"
}

export function launchOptions() {
  return { headless: isHeadless() }
}

export function apiPath(url) {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

export function trackApiTraffic(page) {
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

export async function readPerfMs(page, markName) {
  return page.evaluate(name => {
    const marks = performance.getEntriesByName(name, "mark")
    if (!marks.length) return null
    const init = performance.getEntriesByName("app:init", "mark")[0]
    if (!init) return marks[0].startTime
    return marks[0].startTime - init.startTime
  }, markName)
}

export async function readDocumentTiming(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0]
    if (!nav) return null
    return {
      domContentLoaded: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      responseStart: nav.responseStart,
      responseEnd: nav.responseEnd,
      transferSize: nav.transferSize,
      type: nav.type,
    }
  })
}

export async function waitSidebarReady(page, timeoutMs = 20000) {
  await page.waitForFunction(() => {
    const marks = performance.getEntriesByName("bootstrap:done", "mark")
    if (marks.length) return true
    return document.querySelectorAll(".sidebar-session").length > 0
      || document.querySelector(".sidebar-empty") !== null
  }, { timeout: timeoutMs })
}

export async function loginIfNeeded(api) {
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

export async function discoverDeepLink(page) {
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

export async function measureDeepLinkLoad(page, deepLinkUrl, apiLog, { reload = false } = {}) {
  apiLog.length = 0

  const navT0 = Date.now()
  if (reload) {
    await page.reload({ waitUntil: "domcontentloaded" })
  } else {
    await page.goto(deepLinkUrl, { waitUntil: "domcontentloaded" })
  }
  await page.waitForSelector("text=Connecting", { state: "hidden", timeout: 15000 }).catch(() => {})
  await waitSidebarReady(page)

  const wallMs = Date.now() - navT0
  const bootstrapMs = await readPerfMs(page, "bootstrap:done")
  const firstProjectsMs = await readPerfMs(page, "projects:first")
  const docTiming = await readDocumentTiming(page)
  const sessionCount = await page.locator(".sidebar-session").count()

  const streamEntry = apiLog.find(e => e.path.startsWith("/api/stream"))
  const streamMs = streamEntry?.endMs && streamEntry?.startMs
    ? streamEntry.endMs - streamEntry.startMs
    : null

  const usageCalls = apiLog.filter(e => e.path === "/api/usage" || e.path.startsWith("/api/usage?"))

  return {
    wallMs,
    bootstrapMs,
    firstProjectsMs,
    sessionCount,
    streamMs,
    docTiming,
    usageCalls: usageCalls.length,
    reload,
  }
}

export function printScenario(label, metrics) {
  console.log(`\n  [${label}]`)
  console.log(`    wall goto→sidebar ready: ${metrics.wallMs}ms`)
  if (metrics.docTiming) {
    console.log(`    nav responseStart: ${Math.round(metrics.docTiming.responseStart)}ms domContentLoaded: ${Math.round(metrics.docTiming.domContentLoaded)}ms type=${metrics.docTiming.type}`)
  }
  if (metrics.bootstrapMs != null) console.log(`    perf bootstrap:done: ${metrics.bootstrapMs.toFixed(0)}ms`)
  if (metrics.firstProjectsMs != null) console.log(`    perf projects:first: ${metrics.firstProjectsMs.toFixed(0)}ms`)
  if (metrics.streamMs != null) console.log(`    /api/stream (request duration): ${metrics.streamMs}ms`)
  console.log(`    sidebar sessions visible: ${metrics.sessionCount}`)
  console.log(`    /api/usage calls: ${metrics.usageCalls}`)
}

export function assertScenario(label, metrics, { budgetMs = BUDGET_MS, docBudgetMs = DOC_BUDGET_MS } = {}) {
  if (metrics.usageCalls > 0) {
    fail(`[${label}] /api/usage fired ${metrics.usageCalls} time(s) on sessions tab`)
  }
  if (metrics.sessionCount === 0) {
    fail(`[${label}] sidebar empty after load`)
  }
  const bootstrapBudget = metrics.bootstrapMs ?? metrics.wallMs
  if (bootstrapBudget > budgetMs) {
    fail(`[${label}] SSE bootstrap took ${bootstrapBudget.toFixed(0)}ms > ${budgetMs}ms`)
  }
  if (metrics.firstProjectsMs != null && metrics.firstProjectsMs > budgetMs) {
    fail(`[${label}] first SSE projects batch took ${metrics.firstProjectsMs.toFixed(0)}ms > ${budgetMs}ms`)
  }
  if (metrics.streamMs != null && metrics.streamMs > budgetMs) {
    fail(`[${label}] /api/stream request took ${metrics.streamMs}ms > ${budgetMs}ms`)
  }
  if (metrics.docTiming?.responseStart != null && metrics.docTiming.responseStart > docBudgetMs) {
    fail(`[${label}] document responseStart ${Math.round(metrics.docTiming.responseStart)}ms > ${docBudgetMs}ms (tunnel/browser stall)`)
  }
}

export async function createPersistentContext() {
  mkdirSync(OUT, { recursive: true })
  const userDataDir = join(OUT, "pw-profile")
  return chromium.launchPersistentContext(userDataDir, {
    ...launchOptions(),
    ignoreHTTPSErrors: true,
  })
}

export async function createFreshContext(browser) {
  return browser.newContext({ ignoreHTTPSErrors: true })
}
