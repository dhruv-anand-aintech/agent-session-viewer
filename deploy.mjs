#!/usr/bin/env node
/**
 * Deploy helper — patches wrangler.toml with real KV IDs from env, deploys,
 * then restores the placeholders so the repo stays clean.
 *
 * KV IDs are loaded from (in priority order):
 *   1. Environment variables: SESSIONS_KV_ID, SESSIONS_KV_PREVIEW_ID
 *   2. .env file in the project root
 *
 * Usage:
 *   node deploy.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

function argValue(...names) {
  for (const name of names) {
    const eq = args.find(arg => arg.startsWith(`${name}=`))
    if (eq) return eq.slice(name.length + 1).trim()
    const index = args.indexOf(name)
    if (index !== -1 && args[index + 1]) return args[index + 1].trim()
  }
  return ""
}

function customDomainFromEnvOrArgs() {
  return (
    argValue("--domain", "--custom-domain") ||
    process.env.CUSTOM_DOMAIN ||
    process.env.AGENT_SESSION_VIEWER_DOMAIN ||
    ""
  ).trim()
}

function validateHostname(hostname) {
  if (!hostname) return ""
  if (hostname.includes("://") || hostname.includes("/") || hostname.includes("*")) {
    throw new Error(`CUSTOM_DOMAIN must be a hostname like sessions.example.com, got: ${hostname}`)
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(hostname)) {
    throw new Error(`CUSTOM_DOMAIN is not a valid hostname: ${hostname}`)
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

function withBuildCommit(toml, commit) {
  if (!commit) return toml
  if (/^BUILD_COMMIT\s*=/m.test(toml)) return toml.replace(/^BUILD_COMMIT\s*=.*$/m, `BUILD_COMMIT = "${commit}"`)
  if (toml.includes("[vars]")) return toml.replace("[vars]\n", `[vars]\nBUILD_COMMIT = "${commit}"\n`)
  return `${toml.trimEnd()}\n\n[vars]\nBUILD_COMMIT = "${commit}"\n`
}

// Load .env file if present (simple KEY=VALUE parser, no dependencies needed)
const envPath = path.join(root, ".env")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const kvId = process.env.SESSIONS_KV_ID
const kvPreviewId = process.env.SESSIONS_KV_PREVIEW_ID

if (!kvId || !kvPreviewId) {
  console.error("❌  Set SESSIONS_KV_ID and SESSIONS_KV_PREVIEW_ID in .env or as environment variables.")
  console.error("    Run `node setup.mjs` once to create the namespaces and get these values.")
  process.exit(1)
}

const checks = [
  "node test/test-resolve-project-dir.mjs",
  "node test/test-codex-session-file-cache.mjs",
  "npx tsx test/test-session-pane-state.ts",
  "npx tsx test/test-sidebar-search-state.ts",
  "npm run build",
  "npm run mobile:updates:stage",
]

for (const cmd of checks) {
  console.log(`\nRunning predeploy check: ${cmd}`)
  execSync(cmd, { stdio: "inherit", cwd: root })
}

const tomlPath = new URL("wrangler.toml", import.meta.url).pathname
const original = readFileSync(tomlPath, "utf8")

const headCommit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim()
const patched = withBuildCommit(original, headCommit)
  .replace("PLACEHOLDER_KV_ID", kvId)
  .replace("PLACEHOLDER_KV_PREVIEW_ID", kvPreviewId)
const domain = validateHostname(customDomainFromEnvOrArgs())
const deployConfig = withCustomDomainRoute(patched, domain)

writeFileSync(tomlPath, deployConfig)

try {
  if (domain) console.log(`\nDeploying with Cloudflare custom domain: https://${domain}`)
  execSync("npx wrangler deploy", { stdio: "inherit", cwd: root })
} finally {
  writeFileSync(tomlPath, original)
}
