#!/usr/bin/env node
/**
 * Deploy helper — patches wrangler.toml with real KV IDs from env, deploys,
 * then restores the placeholders so the repo stays clean.
 *
 * Required env vars:
 *   SESSIONS_KV_ID          — KV namespace ID
 *   SESSIONS_KV_PREVIEW_ID  — KV preview namespace ID
 *
 * Usage:
 *   SESSIONS_KV_ID=abc123 SESSIONS_KV_PREVIEW_ID=def456 node deploy.mjs
 */

import { readFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"

const kvId = process.env.SESSIONS_KV_ID
const kvPreviewId = process.env.SESSIONS_KV_PREVIEW_ID

if (!kvId || !kvPreviewId) {
  console.error("❌  Set SESSIONS_KV_ID and SESSIONS_KV_PREVIEW_ID before deploying.")
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
