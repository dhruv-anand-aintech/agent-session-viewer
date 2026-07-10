#!/usr/bin/env node
/**
 * Deploy the production Cloudflare Worker from this machine.
 *
 * The Worker configuration and its non-secret bindings live in wrangler.toml.
 * Cloudflare keeps dashboard-managed secrets during deploy via --keep-vars.
 *
 * Usage:
 *   npm run deploy
 *   npm run deploy -- --skip-checks
 */

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.dirname(fileURLToPath(import.meta.url))
const skipChecks = process.argv.slice(2).includes("--skip-checks")
const productionURL = process.env.AGENT_SESSION_VIEWER_PRODUCTION_URL ?? "https://agent-session-viewer.ainorthstar.tech"

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(" ")}`)
  execFileSync(command, args, { cwd: root, stdio: "inherit", env: process.env })
}

async function fetchWithRetry(url, expectedCommit, attempts = 10) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      const body = await response.json()
      if (response.ok && body?.ok === true && body.commit === expectedCommit) return body
      lastError = new Error(`Expected ${expectedCommit}; got HTTP ${response.status}, commit ${body?.commit ?? "unknown"}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw lastError ?? new Error(`Production health check failed for ${url}`)
}

if (!skipChecks) run("npm", ["run", "build"])

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
run("npx", ["wrangler", "deploy", "--keep-vars", "--var", `BUILD_COMMIT:${commit}`])

const health = await fetchWithRetry(`${productionURL.replace(/\/$/, "")}/api/health`, commit)
const landing = await fetch(`${productionURL.replace(/\/$/, "")}/`, { signal: AbortSignal.timeout(15_000) })
if (!landing.ok) throw new Error(`Production landing page returned HTTP ${landing.status}`)

console.log(`\nVerified production: ${productionURL}`)
console.log(`Health: runtime=${health.runtime}, auth=${health.auth}, commit=${health.commit}`)
console.log(`Landing page: HTTP ${landing.status}`)
