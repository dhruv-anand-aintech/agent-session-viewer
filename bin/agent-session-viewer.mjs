#!/usr/bin/env node
/**
 * CLI entry point for `npx agent-session-viewer` or global install.
 *
 * Usage:
 *   npx agent-session-viewer           # start on port 3001
 *   npx agent-session-viewer --port 4000
 *   npx agent-session-viewer --host    # bind to 0.0.0.0 (LAN access)
 *   npx agent-session-viewer --open    # auto-open browser
 *   npx agent-session-viewer --skip-cache  # skip sidebar cache build
 */

import { existsSync } from "node:fs"
import net from "node:net"
import { spawn, execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SERVER = join(PKG_ROOT, "local-server.mjs")
const BUILD_CACHE = join(PKG_ROOT, "build-cache.mjs")

const args = process.argv.slice(2)
const hasFlag = f => args.includes(f)
const flagValue = f => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : null }

const preferredPort = Number(flagValue("--port") ?? process.env.PORT ?? "3001")
const bindHost = hasFlag("--host")
const openBrowser = hasFlag("--open")
const skipCache = hasFlag("--skip-cache")

function tryBindPort(port) {
  return new Promise(resolve => {
    const s = net.createServer()
    s.once("error", () => resolve(false))
    s.listen(port, () => s.close(() => resolve(true)))
  })
}

async function pickPort(start) {
  for (let i = 0; i <= 50; i++) {
    if (await tryBindPort(start + i)) {
      if (i > 0) console.warn(`Port ${start} busy — using ${start + i}`)
      return start + i
    }
  }
  throw new Error(`Could not bind to ports ${start}–${start + 50}`)
}

// ── Build sidebar cache ────────────────────────────────────────────────────────
if (!skipCache && existsSync(BUILD_CACHE)) {
  console.log("Building sidebar cache…")
  try {
    execFileSync(process.execPath, [BUILD_CACHE], { stdio: "inherit", cwd: PKG_ROOT })
  } catch {
    console.warn("Cache build failed — sidebar will populate after first load.")
  }
}

// ── Start local server ─────────────────────────────────────────────────────────
const port = await pickPort(Number.isFinite(preferredPort) ? preferredPort : 3001)
const url = `http://localhost:${port}`

const server = spawn(process.execPath, [SERVER], {
  cwd: PKG_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: String(port),
    HOST: bindHost ? "0.0.0.0" : "127.0.0.1",
  },
})

server.once("error", err => { console.error(err); process.exit(1) })
server.once("exit", code => process.exit(code ?? 0))
process.once("SIGINT", () => { server.kill(); process.exit(130) })
process.once("SIGTERM", () => { server.kill(); process.exit(143) })

// Give server a moment to bind before printing / opening
await new Promise(r => setTimeout(r, 600))
console.log(`\n  Agent Session Viewer → ${url}\n`)

if (openBrowser) {
  const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  spawn(open, [url], { detached: true, stdio: "ignore" }).unref()
}
