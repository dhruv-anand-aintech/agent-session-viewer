#!/usr/bin/env node
/**
 * Tunnel load-time regression — headful by default (HEADLESS=1 or CI=true for headless).
 *
 * Scenarios:
 *   1. fresh-deep-link     — clean navigation to deep link
 *   2. same-tab-refresh    — F5 on /sessions?s=... (SSE teardown + tunnel/browser stall probe)
 *   3. incognito-fresh     — isolated context (no stale profile connections)
 *   4. profile-fresh       — persistent context (normal browser profile behavior)
 *
 * Fails if:
 *   - /api/usage fires while on the sessions tab
 *   - SSE bootstrap exceeds TUNNEL_LOAD_BUDGET_MS (default 2000)
 *   - document responseStart exceeds TUNNEL_DOC_BUDGET_MS (default 5000)
 *
 * Usage:
 *   AUTH_PIN=xxxx node scripts/tunnel-load-regression.mjs
 *   TUNNEL_DEEP_LINK='/sessions?s=codex%3A.../uuid' node scripts/tunnel-load-regression.mjs
 */
import { chromium } from "playwright"
import {
  BASE,
  BUDGET_MS,
  REFRESH_BUDGET_MS,
  DOC_BUDGET_MS,
  OUT,
  discoverDeepLink,
  loginIfNeeded,
  measureDeepLinkLoad,
  printScenario,
  assertScenario,
  trackApiTraffic,
  createPersistentContext,
  launchOptions,
  isHeadless,
} from "./tunnel-test-lib.mjs"
import { mkdirSync } from "node:fs"

async function runScenario(page, deepLinkUrl, apiLog, label, opts = {}) {
  const metrics = await measureDeepLinkLoad(page, deepLinkUrl, apiLog, opts)
  printScenario(label, metrics)
  assertScenario(label, metrics, {
    budgetMs: opts.reload ? REFRESH_BUDGET_MS : BUDGET_MS,
    docBudgetMs: DOC_BUDGET_MS,
  })
  return metrics
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`\nTunnel load regression → ${BASE}`)
  console.log(`Browser: ${isHeadless() ? "headless" : "headful"}`)
  console.log(`Budgets: SSE ${BUDGET_MS}ms | refresh ${REFRESH_BUDGET_MS}ms | document ${DOC_BUDGET_MS}ms\n`)

  const browser = await chromium.launch(launchOptions())
  const freshContext = await browser.newContext({ ignoreHTTPSErrors: true })
  const freshApi = freshContext.request
  const freshPage = await freshContext.newPage()
  const apiLog = trackApiTraffic(freshPage)

  await loginIfNeeded(freshApi)

  const capsCheck = await freshApi.get(`${BASE}/api/capabilities`)
  const caps = await capsCheck.json()
  console.log(`  capabilities: pinRequired=${caps.pinRequired} authed=${caps.authed}`)

  const deepLinkUrl = await discoverDeepLink(freshPage)
  console.log(`  deep link: ${deepLinkUrl.replace(BASE, "")}`)

  await runScenario(freshPage, deepLinkUrl, apiLog, "fresh-deep-link")
  await freshPage.screenshot({ path: `${OUT}/regression-fresh.png`, fullPage: true })

  await runScenario(freshPage, deepLinkUrl, apiLog, "same-tab-refresh", { reload: true })
  await freshPage.screenshot({ path: `${OUT}/regression-refresh.png`, fullPage: true })

  await freshContext.close()

  const incognitoContext = await browser.newContext({ ignoreHTTPSErrors: true })
  const incognitoApi = incognitoContext.request
  await loginIfNeeded(incognitoApi)
  const incognitoPage = await incognitoContext.newPage()
  const incognitoLog = trackApiTraffic(incognitoPage)
  const incognitoMetrics = await runScenario(incognitoPage, deepLinkUrl, incognitoLog, "incognito-fresh")
  await incognitoPage.screenshot({ path: `${OUT}/regression-incognito.png`, fullPage: true })
  await incognitoContext.close()

  const profileContext = await createPersistentContext()
  const profileApi = profileContext.request
  await loginIfNeeded(profileApi)
  const profilePage = profileContext.pages()[0] ?? await profileContext.newPage()
  const profileLog = trackApiTraffic(profilePage)
  const profileMetrics = await runScenario(profilePage, deepLinkUrl, profileLog, "profile-fresh")
  await profilePage.screenshot({ path: `${OUT}/regression-profile.png`, fullPage: true })
  await profileContext.close()

  await browser.close()

  console.log("\n  Compare (document responseStart):")
  console.log(`    incognito: ${Math.round(incognitoMetrics.docTiming?.responseStart ?? 0)}ms`)
  console.log(`    profile:   ${Math.round(profileMetrics.docTiming?.responseStart ?? 0)}ms`)

  console.log(`\n✓ PASSED — fresh + refresh + incognito/profile within budgets`)
  console.log(`  Screenshots: ${OUT}/regression-*.png\n`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
