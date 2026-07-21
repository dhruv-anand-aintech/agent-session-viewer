#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { firefox } from "playwright"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const base = process.env.TEST_BASE_URL ?? "https://agent-session-viewer.ainorthstar.tech"
const output = process.env.TEST_SCREENSHOT ?? join(root, "tmp", "live-summary-firefox.png")

function loadPin() {
  if (process.env.AUTH_PIN) return process.env.AUTH_PIN
  for (const file of [join(root, ".env"), join(dirname(root), ".env")]) {
    if (!existsSync(file)) continue
    const match = readFileSync(file, "utf8").match(/^(?:AUTH_PIN|LOCAL_AGENT_AUTH_PIN)=(.+)$/m)
    if (match) return match[1].trim().replace(/^["']|["']$/g, "")
  }
  return null
}

const browser = await firefox.launch({
  headless: true,
})
const context = await browser.newContext({
  viewport: { width: Number(process.env.TEST_WIDTH ?? 1365), height: Number(process.env.TEST_HEIGHT ?? 900) },
  ignoreHTTPSErrors: true,
})
const page = await context.newPage()

try {
  const capabilities = await context.request.get(`${base}/api/capabilities`)
  const caps = await capabilities.json()
  if (caps.pinRequired && !caps.authed) {
    const pin = loadPin()
    if (!pin) throw new Error("Authentication PIN is unavailable")
    const login = await context.request.post(`${base}/api/login`, { data: { pin } })
    if (!login.ok()) throw new Error(`Login failed (${login.status()})`)
  }

  await page.goto(`${base}/sessions`, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.locator(".sidebar-session").first().waitFor({ timeout: 30_000 })
  if (Number(process.env.TEST_WIDTH ?? 1365) <= 700) {
    await page.locator(".topbar-menu-btn").click()
  }
  await page.locator(".sidebar-session").first().click()
  await page.locator(".agent-toggle-btn").waitFor({ timeout: 30_000 })
  await page.locator(".agent-toggle-btn").click()
  await page.getByRole("button", { name: "Live update" }).waitFor({ timeout: 10_000 })

  const started = performance.now()
  await page.getByRole("button", { name: "Live update" }).click()
  await page.locator(".agent-live-session").first().waitFor({ timeout: 15_000 })
  const deterministicMs = Math.round(performance.now() - started)
  await page.locator(".agentic-stage-timeline").waitFor({ timeout: 15_000 })
  const spinnerAfterEvidence = await page.locator("[data-summary-phase='summarizing']").isVisible()
  await page.locator(".agent-chat-turn--assistant .agent-chat-text").waitFor({ timeout: 45_000 })
  const firstTokenMs = Math.round(performance.now() - started)
  await page.locator(".agent-live-summary-btn .spin-icon").waitFor({ state: "hidden", timeout: 90_000 })
  const completeMs = Math.round(performance.now() - started)
  const summary = (await page.locator(".agent-chat-turn--assistant .agent-chat-text").innerText()).trim()
  const assistantHighlights = await page.locator(".agent-live-snippet--assistant").count()
  const evidenceStatus = (await page.locator(".agent-live-evidence-heading span").innerText()).trim()
  mkdirSync(dirname(output), { recursive: true })
  await page.screenshot({ path: output, fullPage: true })

  console.log(JSON.stringify({
    base,
    deterministicMs,
    firstTokenMs,
    completeMs,
    spinnerAfterEvidence,
    activeSessions: await page.locator(".agent-live-session").count(),
    assistantHighlights,
    evidenceStatus,
    summary,
    screenshot: output,
  }, null, 2))
} catch (error) {
  mkdirSync(dirname(output), { recursive: true })
  await page.screenshot({ path: output.replace(/\.png$/, "-error.png"), fullPage: true }).catch(() => undefined)
  const uiError = await page.locator(".agent-console-error").innerText().catch(() => "")
  console.error(JSON.stringify({ base, uiError, pageUrl: page.url() }, null, 2))
  throw error
} finally {
  await browser.close()
}
