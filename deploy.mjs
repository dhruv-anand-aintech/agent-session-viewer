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

const tomlPath = new URL("wrangler.toml", import.meta.url).pathname
const original = readFileSync(tomlPath, "utf8")

const patched = original
  .replace("PLACEHOLDER_KV_ID", kvId)
  .replace("PLACEHOLDER_KV_PREVIEW_ID", kvPreviewId)

writeFileSync(tomlPath, patched)

try {
  execSync("npm run build && npx wrangler deploy", { stdio: "inherit" })
} finally {
  writeFileSync(tomlPath, original)
}
