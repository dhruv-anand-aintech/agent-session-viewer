#!/usr/bin/env node
/**
 * Agent Session Viewer — local setup (no Cloudflare account needed)
 *
 * Usage: npm run setup   (or: node setup-local.mjs)
 *
 * What it does:
 *   1. Detects all session directories (Claude Code, Cursor, Codex, etc.)
 *   2. Builds the sidebar cache so first load shows real session counts
 *   3. Prints the command to start the viewer
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const ROOT = dirname(fileURLToPath(import.meta.url))

const PLATFORMS = [
  { label: "Claude Code",  path: join(homedir(), ".claude", "projects") },
  { label: "Codex",        path: join(homedir(), ".codex", "sessions") },
  { label: "OpenCode",     path: join(homedir(), ".local", "share", "opencode") },
  { label: "Hermes",       path: join(homedir(), ".hermes", "state.db") },
  { label: "Antigravity",  path: join(homedir(), ".gemini", "antigravity", "brain") },
  { label: "Cursor",       path: join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb") },
]

const CLAW_TOOLS = ["nanoclaw", "openclaw", "picoclaw", "femtoclaw", "attoclaw", "kiloclaw", "megaclaw", "zeroclaw", "microclaw", "rawclaw"]

console.log("Agent Session Viewer — local setup\n")

// ── Detect platforms ───────────────────────────────────────────────────────────
console.log("Detected session sources:")
let found = 0
for (const { label, path } of PLATFORMS) {
  if (existsSync(path)) {
    console.log(`  ✓ ${label}`)
    found++
  }
}
for (const tool of CLAW_TOOLS) {
  const p = join(homedir(), tool)
  const pd = join(homedir(), `.${tool}`)
  if (existsSync(p) || existsSync(pd)) {
    console.log(`  ✓ ${tool} (claw bot)`)
    found++
  }
}
if (found === 0) {
  console.log("  (none detected — viewer will show an empty sidebar until sessions exist)")
} else {
  console.log()
}

// ── Build sidebar cache ────────────────────────────────────────────────────────
console.log("Building sidebar cache…")
try {
  execFileSync(process.execPath, [join(ROOT, "build-cache.mjs")], {
    stdio: "inherit",
    cwd: ROOT,
  })
} catch {
  console.warn("  Warning: cache build failed — sidebar will populate after first load.")
}

// ── Done ───────────────────────────────────────────────────────────────────────
console.log(`
Setup complete!

Start the viewer:

  npm run local

Then open http://localhost:5173 in your browser.

To access from other devices on your network (e.g. phone):

  npm run local -- --host

For Cloudflare Worker deployment (remote access, daemon sync):

  npm run setup:cloudflare
`)
