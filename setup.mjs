#!/usr/bin/env node
/**
 * Agent Session Viewer — one-command Cloudflare setup
 *
 * Usage: node setup.mjs
 *
 * What it does:
 *   1. Creates a KV namespace called SESSIONS_KV
 *   2. Patches wrangler.toml with the real namespace IDs
 *   3. Prompts for an AUTH_PIN and sets it as a Worker secret
 *   4. Builds and deploys the Worker
 */

import { execFileSync, execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], ...opts })
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()) }))
}

function argValue(...names) {
  for (const name of names) {
    const eq = args.find(arg => arg.startsWith(`${name}=`))
    if (eq) return eq.slice(name.length + 1).trim()
    const index = args.indexOf(name)
    if (index !== -1 && args[index + 1]) return args[index + 1].trim()
  }
  return ""
}

function validateHostname(hostname) {
  if (!hostname) return ""
  if (hostname.includes("://") || hostname.includes("/") || hostname.includes("*")) {
    throw new Error(`Custom domain must be a hostname like sessions.example.com, got: ${hostname}`)
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(hostname)) {
    throw new Error(`Custom domain is not a valid hostname: ${hostname}`)
  }
  return hostname.toLowerCase()
}

function withCustomDomainRoute(toml, hostname) {
  if (!hostname) return toml
  const routeBlock = [
    "",
    "# Cloudflare custom domain for Agent Session Viewer.",
    "# The zone must already be active on Cloudflare nameservers.",
    "[[routes]]",
    `pattern = "${hostname}"`,
    "custom_domain = true",
    "",
  ].join("\n")
  const withoutExistingCustomDomain = toml
    .replace(/\n# Cloudflare custom domain for Agent Session Viewer\.[\s\S]*?(?=\n(?:\[\[|\[|# Remote access|name\s*=)|\s*$)/, "\n")
    .trimEnd()
  return `${withoutExistingCustomDomain}${routeBlock}`
}

console.log("🚀  Agent Session Viewer — Cloudflare setup\n")

// ── Step 1: Create KV namespace ────────────────────────────────────────────────
console.log("Creating KV namespace SESSIONS_KV…")
const kvOut = run("npx", ["wrangler", "kv", "namespace", "create", "SESSIONS_KV"])
const kvIdMatch = kvOut.match(/id\s*=\s*"([a-f0-9]{32})"/)
if (!kvIdMatch) {
  console.error("Failed to parse KV namespace ID from wrangler output:\n" + kvOut)
  process.exit(1)
}
const kvId = kvIdMatch[1]
console.log(`  ✓ KV namespace created: ${kvId}`)

console.log("Creating KV preview namespace SESSIONS_KV (preview)…")
const kvPrevOut = run("npx", ["wrangler", "kv", "namespace", "create", "SESSIONS_KV", "--preview"])
const kvPrevMatch = kvPrevOut.match(/id\s*=\s*"([a-f0-9]{32})"/)
if (!kvPrevMatch) {
  console.error("Failed to parse preview KV namespace ID:\n" + kvPrevOut)
  process.exit(1)
}
const kvPrevId = kvPrevMatch[1]
console.log(`  ✓ Preview KV namespace created: ${kvPrevId}`)

// ── Step 2: Patch wrangler.toml ────────────────────────────────────────────────
let toml = readFileSync("wrangler.toml", "utf8")
toml = toml
  .replace(/id\s*=\s*"PLACEHOLDER_KV_ID"/, `id = "${kvId}"`)
  .replace(/preview_id\s*=\s*"PLACEHOLDER_KV_PREVIEW_ID"/, `preview_id = "${kvPrevId}"`)
const promptedDomain = argValue("--domain", "--custom-domain") || await prompt("\nCustom domain/subdomain (optional, must already be an active Cloudflare zone): ")
const customDomain = validateHostname(promptedDomain)
toml = withCustomDomainRoute(toml, customDomain)
writeFileSync("wrangler.toml", toml)
console.log("  ✓ wrangler.toml updated")

// ── Step 3: Set AUTH_PIN secret ────────────────────────────────────────────────
const pin = await prompt("\nChoose an AUTH_PIN (a numeric PIN to protect your viewer): ")
if (!pin) {
  console.error("AUTH_PIN cannot be empty.")
  process.exit(1)
}

// Pass pin via stdin to `wrangler secret put`
execSync(
  `echo '${pin.replace(/'/g, "'\\''")}' | npx wrangler secret put AUTH_PIN`,
  { encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] }
)
console.log("  ✓ AUTH_PIN secret set")

// ── Step 4: Build and deploy ───────────────────────────────────────────────────
console.log("\nBuilding and deploying…")
execSync("npm run build && npx wrangler deploy", { stdio: "inherit" })

// ── Done ───────────────────────────────────────────────────────────────────────
const workerName = readFileSync("wrangler.toml", "utf8").match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1]
  || "agent-session-viewer"
const publicUrl = customDomain
  ? `https://${customDomain}`
  : `https://${workerName}.<your-subdomain>.workers.dev`

console.log(`
✅  Setup complete!

Your viewer is live at: ${publicUrl}

To start syncing your sessions to the Worker, run:

  WORKER_URL=${publicUrl} AUTH_PIN=${pin} npm run daemon

Or pass them as flags:

  node daemon/watch.mjs --worker <url> --pin <pin>

Optional: to also sync nanoclaw (WhatsApp/Telegram) agent sessions:

  WORKER_URL=... AUTH_PIN=... NANOCLAW_DIR=/path/to/nanoclaw npm run daemon
`)
