#!/usr/bin/env node
/**
 * CLI entry point for `npx agent-session-viewer`.
 *
 * Sharing options (TUI menu or flags):
 *
 *   [local]       http://localhost:PORT          — default, no sharing
 *   [lan]         http://192.168.x.x:PORT        — same WiFi/network, no account
 *   [cloudflare]  https://xxx.trycloudflare.com  — internet, no account (Cloudflare Tunnel)
 *   [tunnel]      https://xxx.loca.lt            — internet, no account (URL changes on restart)
 *   [ngrok]       https://you.ngrok-free.app     — internet, permanent URL (free ngrok account)
 *
 * Flags:
 *   --port 4000      listen on specific port
 *   --open           auto-open browser
 *   --skip-cache     skip sidebar cache pre-build
 *   --lan            bind to 0.0.0.0 and print LAN URL, skip menu
 *   --cf             start cloudflare tunnel immediately, skip menu
 *   --tunnel         start localtunnel immediately, skip menu
 *   --ngrok          start ngrok tunnel, skip menu
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs"
import { randomInt } from "node:crypto"
import { homedir, networkInterfaces } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import net from "node:net"
import readline from "node:readline"
import { spawn, execFileSync } from "node:child_process"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SERVER   = join(PKG_ROOT, "local-server.mjs")
const BUILD_CACHE = join(PKG_ROOT, "build-cache.mjs")
const CONFIG_DIR  = join(homedir(), ".config", "agent-session-viewer")
const REMOTE_CONFIG = join(CONFIG_DIR, "remote.json")

const args     = process.argv.slice(2)
const hasFlag  = f => args.includes(f)
const flagValue = f => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : null }

const preferredPortInput = Number(flagValue("--port") ?? process.env.PORT ?? "3001")
const skipCache  = hasFlag("--skip-cache")
const openBrowser = hasFlag("--open")
const modeLan    = hasFlag("--lan")
const modeCf     = hasFlag("--cf") || hasFlag("--cloudflare")
const modeTunnel = hasFlag("--tunnel")
const modeNgrok  = hasFlag("--ngrok")

// ── Config ────────────────────────────────────────────────────────────────────

function loadRemoteConfig() {
  try { return JSON.parse(readFileSync(REMOTE_CONFIG, "utf8")) } catch { return {} }
}
function saveRemoteConfig(data) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(REMOTE_CONFIG, JSON.stringify(data, null, 2))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLanIp() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address
    }
  }
  return null
}

function tryPort(p, host = "127.0.0.1") {
  return new Promise(r => {
    const s = net.createServer()
    s.once("error", () => r(false))
    s.listen(p, host, () => s.close(() => r(true)))
  })
}
async function pickPort(start, host = "127.0.0.1") {
  for (let i = 0; i <= 100; i++) {
    if (await tryPort(start + i, host)) {
      if (i > 0) console.warn(`Port ${start} busy — using ${start + i}`)
      return start + i
    }
  }
  throw new Error(`No free port found in range ${start}–${start + 100}`)
}

function ask(question, defaultVal = "") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(`  ${question}${defaultVal ? ` [${defaultVal}]` : ""}: `, ans => {
      rl.close()
      resolve(ans.trim() || defaultVal)
    })
  })
}

// ── Tunnel: Cloudflare (untun) ───────────────────────────────────────────────

async function startCloudflare(localPort) {
  const untun = await import("untun")
  const startTunnel = untun.startTunnel ?? untun.default?.startTunnel
  if (!startTunnel) throw new Error("Could not find startTunnel export in untun. Exports: " + Object.keys(untun))
  process.stdout.write("  Starting Cloudflare Tunnel… ")
  const tunnel = await startTunnel({ port: localPort })
  const url = await tunnel.getURL()
  console.log("ready.\n")
  return { url, close: () => tunnel.close() }
}

// ── Tunnel: localtunnel (no account, random URL) ──────────────────────────────

async function startLocaltunnel(localPort) {
  const { default: localtunnel } = await import("localtunnel")
  process.stdout.write("  Starting localtunnel… ")
  const tunnel = await localtunnel({ port: localPort })
  console.log("ready.\n")

  tunnel.on("error", err => console.error(`\n  localtunnel error: ${err.message}`))
  tunnel.on("close", () => console.log("\n  localtunnel closed."))

  return { url: tunnel.url, close: () => tunnel.close() }
}

// ── Tunnel: ngrok (account needed, permanent static domain) ───────────────────

async function startNgrok(localPort) {
  const saved = loadRemoteConfig()
  let { ngrokToken, ngrokDomain } = saved

  if (!ngrokToken) {
    console.log("\n  ngrok requires a free account (one-time setup):")
    console.log("  1. Sign up at https://ngrok.com")
    console.log("  2. Get your authtoken from https://dashboard.ngrok.com/authtokens")
    console.log("  3. (Optional) Claim a free static domain for a permanent URL:")
    console.log("     https://dashboard.ngrok.com/domains\n")
    ngrokToken = await ask("ngrok authtoken")
    if (!ngrokToken) { console.error("  ✗ Authtoken required."); process.exit(1) }
    ngrokDomain = (await ask("Static domain for permanent URL (leave blank for random)", "")) || null
    saveRemoteConfig({ ...saved, ngrokToken, ngrokDomain })
  }

  const { default: ngrok } = await import("@ngrok/ngrok")
  process.stdout.write("  Connecting to ngrok… ")
  const listener = await ngrok.connect({
    addr: localPort,
    authtoken: ngrokToken,
    ...(ngrokDomain ? { domain: ngrokDomain } : {}),
  })
  const url = listener.url()
  console.log("ready.\n")

  return {
    url,
    permanent: Boolean(ngrokDomain),
    close: () => listener.close(),
  }
}

// ── PIN generation ────────────────────────────────────────────────────────────

function generatePin() {
  return String(randomInt(100000, 1000000)) // 6-digit PIN
}

// ── Share URL printer ─────────────────────────────────────────────────────────

function printShareBox(url, notes = [], pin = null) {
  const padded = url.padEnd(38)
  console.log("  ┌──────────────────────────────────────────────────────┐")
  console.log(`  │  Share URL:  ${padded} │`)
  if (pin) console.log(`  │  PIN:        ${pin.padEnd(38)} │`)
  for (const note of notes) console.log(`  │  ${note.padEnd(52)} │`)
  console.log("  └──────────────────────────────────────────────────────┘\n")
}

// ── TUI menu ──────────────────────────────────────────────────────────────────

async function showMenu(localPort) {
  const localUrl = `http://localhost:${localPort}`
  const lanIp = getLanIp()
  const lanUrl = lanIp ? `http://${lanIp}:${localPort}` : null
  const saved = loadRemoteConfig()

  console.log("\n  ┌──────────────────────────────────────────────────────┐")
  console.log("  │  Agent Session Viewer                                │")
  console.log(`  │  ${localUrl.padEnd(52)} │`)
  console.log("  └──────────────────────────────────────────────────────┘\n")
  console.log("  [1]  Open in browser (this machine only)")
  if (lanUrl) {
    console.log(`  [2]  Share on local network — ${lanUrl}`)
    console.log("       (same WiFi/Ethernet, no account needed)")
  }
  console.log("  [3]  Internet tunnel — Cloudflare (Highly Reliable)")
  console.log("  [4]  Internet tunnel — localtunnel")
  if (saved.ngrokToken) {
    const domain = saved.ngrokDomain ?? "random URL"
    console.log(`  [5]  ngrok — ${domain}`)
  } else {
    console.log("  [5]  ngrok — permanent URL (free account, one-time setup)")
  }
  console.log("  [6]  Just run (no sharing)\n")

  const choice = await ask("Choice", "1")
  return choice.trim()
}

// ── Build sidebar cache ───────────────────────────────────────────────────────

if (!skipCache && existsSync(BUILD_CACHE)) {
  console.log("Building sidebar cache…")
  try { execFileSync(process.execPath, [BUILD_CACHE], { stdio: "inherit", cwd: PKG_ROOT }) }
  catch { console.warn("Cache build failed — sidebar will populate after first load.") }
}

// ── Logic: Determine Mode and Configuration ──────────────────────────────────

let choice = null
let needsExternalBind = modeLan || modeCf || modeTunnel || modeNgrok
let useCf = modeCf
let useTunnel = modeTunnel
let useNgrok = modeNgrok

// If no mode flags provided, show interactive TUI
if (!needsExternalBind && !hasFlag("--host")) {
  // Probing port on localhost first to show in menu
  const tempPort = await pickPort(preferredPortInput, "127.0.0.1")
  choice = await showMenu(tempPort)

  if (choice === "2" || choice === "3" || choice === "4" || choice === "5") {
    needsExternalBind = true
    if (choice === "3") useCf = true
    if (choice === "4") useTunnel = true
    if (choice === "5") useNgrok = true
    
    // Ask for PIN if not already set in env
    if (!process.env.AUTH_PIN) {
      const suggestedPin = generatePin()
      const userPin = await ask(`Enter PIN for remote access (leave blank for ${suggestedPin})`, "")
      process.env.AUTH_PIN = userPin || suggestedPin
    }
  }
}

const targetHost = (needsExternalBind || hasFlag("--host")) ? "0.0.0.0" : "127.0.0.1"
const port = await pickPort(preferredPortInput, targetHost)
const activePin = process.env.AUTH_PIN ?? (needsExternalBind ? generatePin() : null)

if (activePin) {
  console.log(`\n  🔐 Security: PIN protection enabled.`)
  console.log(`     PIN: ${activePin}\n`)
}

// ── Start local server ────────────────────────────────────────────────────────

const LOG_FILE = join(CONFIG_DIR, "server.log")
mkdirSync(CONFIG_DIR, { recursive: true })
const logStream = openSync(LOG_FILE, "a")

// ... inside spawn options:
const server = spawn(process.execPath, [SERVER], {
  cwd: PKG_ROOT,
  stdio: ["inherit", logStream, logStream],
  env: {
    ...process.env,
    PORT: String(port),
    HOST: targetHost,
    ...(activePin ? { AUTH_PIN: activePin } : {}),
  },
})
console.log(`\n  Logs: tail -f ${LOG_FILE}\n`)
server.once("error", err => { console.error(err); process.exit(1) })
server.once("exit", code => process.exit(code ?? 0))
process.once("SIGINT", () => { server.kill(); process.exit(130) })
process.once("SIGTERM", () => { server.kill(); process.exit(143) })

// Give the server a moment to bind before printing/opening
await new Promise(r => setTimeout(r, 600))

async function triggerServerIndexer() {
  try {
    await fetch(`http://127.0.0.1:${port}/api/indexer/start`, { method: "POST" })
  } catch { /* ignore */ }
}

// ── Post-spawn: Handle Browser / Tunnels ─────────────────────────────────────

let cleanup = null

if (useCf) {
  const t = await startCloudflare(port)
  printShareBox(t.url, ["Powered by Cloudflare Tunnel", "No account needed"], activePin)
  triggerServerIndexer()
  cleanup = t.close
} else if (useTunnel) {
  const t = await startLocaltunnel(port)
  printShareBox(t.url, ["URL changes on each restart (no account needed)"], activePin)
  triggerServerIndexer()
  cleanup = t.close
} else if (useNgrok) {
  const t = await startNgrok(port)
  const notes = t.permanent
    ? ["✓ Permanent — same URL every time"]
    : ["URL changes on restart — add a static domain for permanent URL"]
  printShareBox(t.url, notes, activePin)
  triggerServerIndexer()
  cleanup = t.close
} else if (needsExternalBind || modeLan) {
  const ip = getLanIp()
  const url = ip ? `http://${ip}:${port}` : `http://localhost:${port} (LAN IP not found)`
  printShareBox(url, ["Open this on any device on the same WiFi/Ethernet."], activePin)
  triggerServerIndexer()
  if (openBrowser && ip) {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
  }
} else {
  // Choice 1, 6, or default local
  const url = `http://localhost:${port}`
  console.log("\n  ┌──────────────────────────────────────────────────────┐")
  console.log("  │  Agent Session Viewer (local)                        │")
  console.log(`  │  ${url.padEnd(52)} │`)
  if (activePin) {
    console.log(`  │  PIN: ${activePin.padEnd(47)} │`)
  }
  console.log("  └──────────────────────────────────────────────────────┘\n")
  triggerServerIndexer()
  
  if (choice === "1" || choice === "" || (openBrowser && !hasFlag("--host"))) {
    const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawn(open, [url], { detached: true, stdio: "ignore" }).unref()
  }
}

if (cleanup) {
  process.once("SIGINT", () => { cleanup(); process.exit(130) })
  process.once("SIGTERM", () => { cleanup(); process.exit(143) })
}
