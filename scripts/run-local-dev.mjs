#!/usr/bin/env node
/**
 * Runs local-server + vite with matching ports so /api proxies correctly.
 * If 3001 (or $PORT) is busy, probes upward until a port binds — avoids EADDRINUSE
 * without leaving the UI pointing at the wrong backend.
 */

import { existsSync } from "node:fs"
import net from "node:net"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const SERVER = path.join(ROOT, "local-server.mjs")

const preferred = Number.parseInt(process.env.PORT ?? "3001", 10)

function tryBindPort(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once("error", () => resolve(false))
    s.listen(port, () => {
      s.close(() => resolve(true))
    })
  })
}

async function pickPort(start, range = 50) {
  const s = Number.isFinite(start) ? start : 3001
  for (let i = 0; i <= range; i++) {
    const port = s + i
    // eslint-disable-next-line no-await-in-loop -- probes must run one at a time
    if (await tryBindPort(port)) {
      if (i > 0) {
        console.warn(`[npm run local] Port ${s} busy — using API on ${port}. Vite proxy is set automatically.\n`)
      }
      return port
    }
  }
  throw new Error(`[npm run local] Could not bind TCP ${s}–${s + range}`)
}

const apiPort = await pickPort(preferred)
const proxyTarget = `http://127.0.0.1:${apiPort}`

const viteJs = path.join(ROOT, "node_modules/vite/bin/vite.js")
if (!existsSync(viteJs)) {
  console.error("[npm run local] Missing node_modules/vite. Run: npm install")
  process.exit(1)
}

const api = spawn(process.execPath, ["--watch", SERVER], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, PORT: String(apiPort) },
})

const ui = spawn(process.execPath, [viteJs], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, VITE_API_PROXY_TARGET: proxyTarget },
})

function safeKill(proc, sig = "SIGTERM") {
  if (proc.pid == null) return
  try {
    proc.kill(sig)
  } catch {
    /* already gone */
  }
}

/** First child exit drives process.exit; skips duplicate teardown. */
let done = false
function exitOnce(code = 1) {
  if (done) return
  done = true
  safeKill(api)
  safeKill(ui)
  process.exit(Number.isFinite(code) ? Math.trunc(Number(code)) : 1)
}

function exitCodeFromNode(c /* number | null */) {
  if (typeof c !== "number" || !Number.isFinite(c)) return 1
  return Math.trunc(c)
}

api.once("exit", c => exitOnce(exitCodeFromNode(c)))
ui.once("exit", c => exitOnce(exitCodeFromNode(c)))

api.once("error", err => {
  console.error(err)
  exitOnce(1)
})
ui.once("error", err => {
  console.error(err)
  exitOnce(1)
})

process.once("SIGINT", () => {
  exitOnce(130)
})
process.once("SIGTERM", () => {
  exitOnce(143)
})
