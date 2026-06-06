#!/usr/bin/env node
/**
 * Headful Playwright browser test against the Cloudflare tunnel deployment.
 * Usage:
 *   AUTH_PIN=xxxx node scripts/tunnel-browser-test.mjs
 *   HEADLESS=1 node scripts/tunnel-browser-test.mjs
 */
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  BASE,
  OUT,
  discoverDeepLink,
  loginIfNeeded,
  measureDeepLinkLoad,
  printScenario,
  trackApiTraffic,
  createPersistentContext,
  launchOptions,
  isHeadless,
} from "./tunnel-test-lib.mjs"

function row(label, ms, ok, detail = "") {
  return { label, ms: Math.round(ms), ok, detail }
}

async function timedFetch(page, url, init = {}) {
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
  return result
}

async function exerciseSessionUi(page, results) {
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
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const results = []
  const networkLog = []

  console.log(`\nTunnel browser test → ${BASE}`)
  console.log(`Browser: ${isHeadless() ? "headless" : "headful"}\n`)

  const browser = await chromium.launch(launchOptions())
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

  await page.goto(`${BASE}/api/capabilities`, { waitUntil: "domcontentloaded" })
  const capsText = await page.locator("body").innerText()
  const caps = JSON.parse(capsText)
  results.push(row("/api/capabilities (public)", 0, caps.pinRequired === true, `pinRequired=${caps.pinRequired}`))

  const health = await timedFetch(page, `${BASE}/api/health`)
  results.push(row("/api/health", health.ms, health.ok, health.body?.slice(0, 120)))

  await loginIfNeeded(api)

  const apiLog = trackApiTraffic(page)
  const deepLinkUrl = await discoverDeepLink(page)
  const freshMetrics = await measureDeepLinkLoad(page, deepLinkUrl, apiLog)
  printScenario("browser-fresh-deep-link", freshMetrics)
  results.push(row("Deep-link load", freshMetrics.wallMs, freshMetrics.sessionCount > 0, `${freshMetrics.sessionCount} sessions`))
  await page.screenshot({ path: join(OUT, "02-deep-link.png"), fullPage: true })

  const refreshMetrics = await measureDeepLinkLoad(page, deepLinkUrl, apiLog, { reload: true })
  printScenario("browser-same-tab-refresh", refreshMetrics)
  results.push(row("Same-tab refresh", refreshMetrics.wallMs, refreshMetrics.sessionCount > 0, `usage=${refreshMetrics.usageCalls}`))
  await page.screenshot({ path: join(OUT, "03-refresh.png"), fullPage: true })

  await exerciseSessionUi(page, results)

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

  const usageTab = page.locator(".topbar-tab", { hasText: "Usage" }).first()
  if (await usageTab.isVisible().catch(() => false)) {
    const usageT0 = Date.now()
    await usageTab.click()
    await page.waitForURL("**/usage**", { timeout: 10000 }).catch(() => {})
    const usageFetch = await timedFetch(page, `${BASE}/api/usage`).catch(() => null)
    results.push(row("/usage tab + /api/usage", Date.now() - usageT0, usageFetch?.ok ?? true))
    await page.screenshot({ path: join(OUT, "06-usage.png"), fullPage: true })
  }

  await context.close()

  const profileContext = await createPersistentContext()
  const profileApi = profileContext.request
  await loginIfNeeded(profileApi)
  const profilePage = profileContext.pages()[0] ?? await profileContext.newPage()
  const profileLog = trackApiTraffic(profilePage)
  const profileMetrics = await measureDeepLinkLoad(profilePage, deepLinkUrl, profileLog)
  printScenario("browser-profile-fresh", profileMetrics)
  results.push(row("Profile context load", profileMetrics.wallMs, profileMetrics.sessionCount > 0))
  await profilePage.screenshot({ path: join(OUT, "07-profile.png"), fullPage: true })
  await profileContext.close()

  await browser.close()

  const failed = results.filter(r => !r.ok)
  console.log("\nResults:")
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
