#!/usr/bin/env node
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { firefox } from "playwright"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const base = process.env.TEST_BASE_URL ?? "https://agent-session-viewer.ainorthstar.tech"
const screenshot = join(root, "tmp", "production-firefox-smoke.png")
const browser = await firefox.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } })
const page = await context.newPage()

try {
  const response = await page.goto(base, { waitUntil: "networkidle", timeout: 30_000 })
  if (!response?.ok()) throw new Error(`Production page failed (${response?.status()})`)
  const scriptUrl = await page.locator("script[src]").first().getAttribute("src")
  if (!scriptUrl) throw new Error("Production script asset was not found")
  const scriptResponse = await context.request.get(new URL(scriptUrl, base).toString())
  const script = await scriptResponse.text()
  const health = await page.evaluate(async () => {
    const response = await fetch("/api/health")
    return { status: response.status, body: await response.json() }
  })
  const protectedContext = await page.evaluate(async () => {
    const response = await fetch("/api/agent/summary-context")
    return response.status
  })
  mkdirSync(dirname(screenshot), { recursive: true })
  await page.screenshot({ path: screenshot, fullPage: true })
  console.log(JSON.stringify({
    pageStatus: response.status(),
    health,
    scriptUrl,
    hasSummaryContext: script.includes("/api/agent/summary-context"),
    hasSummaryStream: script.includes("/api/agent/summary-stream"),
    protectedContextStatus: protectedContext,
    screenshot,
  }, null, 2))
} finally {
  await browser.close()
}
