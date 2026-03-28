/**
 * Local server — full replacement for the Cloudflare Worker.
 * Reads ~/.claude/projects/ directly; no Cloudflare account needed.
 *
 * Run via: npm run local
 * Config persisted to: ~/.claude/session-viewer-local.json
 */

import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, extname, join } from "path"
import http from "http"
import { fileURLToPath } from "url"
import { exec } from "child_process"
import { stripXml } from "./shared-utils.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const CONFIG_FILE = join(homedir(), ".claude", "session-viewer-local.json")
const DIST_DIR = join(__dirname, "dist")
const PORT = parseInt(process.env.PORT ?? "3001")
const AUTH_PIN = process.env.AUTH_PIN ?? null

const FIVE_MIN = 5 * 60 * 1000

// --- Config persistence (names + settings) ---

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) } catch { return {} }
}

function saveConfig(data) {
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2))
}

// --- Session reading ---

function parseJsonl(fp) {
  try {
    return readFileSync(fp, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch { return [] }
}

function loadProjects() {
  const config = loadConfig()
  const names = config.names ?? {}
  const projects = []

  let dirs
  try { dirs = readdirSync(CLAUDE_DIR) } catch { return [] }

  for (const dir of dirs) {
    const dp = join(CLAUDE_DIR, dir)
    try { if (!statSync(dp).isDirectory()) continue } catch { continue }

    const sessions = []
    let files
    try { files = readdirSync(dp).filter(f => f.endsWith(".jsonl")) } catch { continue }

    for (const f of files) {
      const fp = join(dp, f)
      let stat
      try { stat = statSync(fp) } catch { continue }

      const msgs = parseJsonl(fp)
      const first = msgs.find(m => m.sessionId)
      const last = [...msgs].reverse().find(m => m.timestamp)
      const sessionId = f.replace(".jsonl", "")

      // Extract first user message text
      const firstUserMsg = msgs.find(m => {
        if (m.type !== "user") return false
        const c = m.message?.content
        if (!c) return false
        if (typeof c === "string") return c.trim().length > 0
        if (!Array.isArray(c)) return false
        return c.some(b => b.type !== "tool_result")
      })

      let firstName = null
      if (firstUserMsg?.message?.content) {
        const content = firstUserMsg.message.content
        let text = null
        if (typeof content === "string") {
          text = content
        } else if (Array.isArray(content)) {
          const textBlock = content.find(b => b.type === "text")
          if (textBlock?.text) {
            text = textBlock.text
          }
        }
        if (text) {
          firstName = stripXml(text).slice(0, 100)
        }
      }

      const userMessageCount = msgs.filter(m => {
        if (m.type !== "user") return false
        const c = m.message?.content
        if (!c) return false
        if (typeof c === "string") return c.trim().length > 0
        if (!Array.isArray(c)) return false
        return c.some(b => b.type !== "tool_result")
      }).length

      const messageCount = msgs.filter(m => m.type !== "file-history-snapshot").length

      sessions.push({
        id: sessionId,
        projectPath: dir,
        lastActivity: last?.timestamp ?? stat.mtime.toISOString(),
        version: first?.version,
        gitBranch: first?.gitBranch,
        isActive: Date.now() - stat.mtimeMs < FIVE_MIN,
        userMessageCount,
        messageCount,
        firstName,
        customName: names[`${dir}/${sessionId}`] ?? null,
      })
    }

    if (sessions.length > 0) {
      projects.push({
        path: dir,
        displayName: dir.replace(/^-Users-[^-]+-Code-/, "").replace(/-/g, "/"),
        sessions: sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
      })
    }
  }

  return projects.sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity ?? ""
    const bLast = b.sessions[0]?.lastActivity ?? ""
    return bLast.localeCompare(aLast)
  })
}

// --- Auth ---

function checkCookieAuth(req) {
  if (!AUTH_PIN) return true
  const cookie = req.headers.cookie ?? ""
  const match = cookie.match(/(?:^|;\s*)auth_pin=([^;]+)/)
  return match?.[1] === AUTH_PIN
}

function checkHeaderAuth(req) {
  if (!AUTH_PIN) return true
  return (req.headers["x-auth-pin"] ?? "") === AUTH_PIN
}

// --- SSE ---

const sseClients = new Set()

function broadcastProjects() {
  if (sseClients.size === 0) return
  const data = JSON.stringify(loadProjects())
  for (const res of sseClients) {
    try { res.write(`event: projects\ndata: ${data}\n\n`) }
    catch { sseClients.delete(res) }
  }
}

// Watch ~/.claude/projects for file changes
try {
  watch(CLAUDE_DIR, { recursive: true }, () => broadcastProjects())
} catch {
  // Fallback to polling if watch fails (e.g., too many files)
  setInterval(broadcastProjects, 3000)
}

// --- Static file serving ---

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function serveStatic(req, res) {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(503, { "Content-Type": "text/plain" })
    res.end("Frontend not built. Run: npm run build")
    return
  }
  let filePath = join(DIST_DIR, req.url.split("?")[0])
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST_DIR, "index.html")
  }
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" })
  createReadStream(filePath).pipe(res)
}

// --- HTTP server ---

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-Pin")

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  const readBody = () => new Promise(resolve => {
    let body = ""
    req.on("data", d => body += d)
    req.on("end", () => { try { resolve(JSON.parse(body)) } catch { resolve({}) } })
  })

  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(data))
  }

  // POST /api/login
  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await readBody()
    if (!AUTH_PIN || body.pin === AUTH_PIN) {
      const cookieVal = AUTH_PIN ?? "local"
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `auth_pin=${cookieVal}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      })
      res.end(JSON.stringify({ ok: true }))
    } else {
      json({ ok: false }, 401)
    }
    return
  }

  // GET|PUT /api/settings — allow both cookie + header auth (daemon uses header)
  if (url.pathname === "/api/settings") {
    if (!checkCookieAuth(req) && !checkHeaderAuth(req)) { json({ error: "Unauthorized" }, 401); return }
    if (req.method === "GET") {
      json(loadConfig().settings ?? {})
      return
    }
    if (req.method === "PUT") {
      if (!checkCookieAuth(req)) { json({ error: "Unauthorized" }, 401); return }
      const body = await readBody()
      const config = loadConfig()
      config.settings = body
      saveConfig(config)
      json({ ok: true })
      return
    }
  }

  // PUT /api/sync — daemon compat; local mode reads files directly so just ack + push
  if (url.pathname === "/api/sync" && req.method === "PUT") {
    if (!checkHeaderAuth(req)) { json({ error: "Unauthorized" }, 401); return }
    broadcastProjects()
    json({ ok: true })
    return
  }

  // All remaining /api/* require cookie auth
  if (url.pathname.startsWith("/api/") && !checkCookieAuth(req)) {
    json({ error: "Unauthorized" }, 401)
    return
  }

  // GET /api/projects
  if (url.pathname === "/api/projects") {
    json(loadProjects())
    return
  }

  // GET /api/stream  (SSE)
  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    })
    res.write(`event: projects\ndata: ${JSON.stringify(loadProjects())}\n\n`)
    sseClients.add(res)
    req.on("close", () => sseClients.delete(res))
    return
  }

  // GET /api/session/:project/:id
  const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/)
  if (sessionMatch) {
    const projectPath = decodeURIComponent(sessionMatch[1])
    const sessionId = sessionMatch[2]
    const fp = join(CLAUDE_DIR, projectPath, `${sessionId}.jsonl`)
    if (!existsSync(fp)) { res.writeHead(404); res.end("Not Found"); return }
    json(parseJsonl(fp))
    return
  }

  // PUT /api/names/:project/:id
  const renameMatch = url.pathname.match(/^\/api\/names\/([^/]+)\/([^/]+)$/)
  if (renameMatch && req.method === "PUT") {
    const projectPath = decodeURIComponent(renameMatch[1])
    const sessionId = renameMatch[2]
    const body = await readBody()
    const config = loadConfig()
    if (!config.names) config.names = {}
    const key = `${projectPath}/${sessionId}`
    const trimmed = body.name?.trim()
    if (trimmed) config.names[key] = trimmed
    else delete config.names[key]
    saveConfig(config)
    json({ ok: true })
    return
  }

  // GET /api/capabilities
  if (url.pathname === "/api/capabilities") {
    json({ openPath: true })
    return
  }

  // GET /api/debug
  if (url.pathname === "/api/debug") {
    const projects = loadProjects()
    json({ sessionCount: projects.flatMap(p => p.sessions).length, projectCount: projects.length })
    return
  }

  // GET /api/facets/:sessionId
  const facetsMatch = url.pathname.match(/^\/api\/facets\/([^/]+)$/)
  if (facetsMatch) {
    const sessionId = facetsMatch[1]
    const fp = join(homedir(), ".claude", "usage-data", "facets", `${sessionId}.json`)
    if (!existsSync(fp)) { json(null); return }
    try { json(JSON.parse(readFileSync(fp, "utf8"))) } catch { json(null) }
    return
  }

  // GET /api/todos
  if (url.pathname === "/api/todos") {
    const todosDir = join(homedir(), ".claude", "todos")
    const result = []
    try {
      const files = readdirSync(todosDir).filter(f => f.endsWith(".json"))
      for (const f of files) {
        const fp = join(todosDir, f)
        try {
          const data = JSON.parse(readFileSync(fp, "utf8"))
          const st = statSync(fp)
          result.push({ id: f.replace(".json", ""), items: data, mtime: st.mtime.toISOString() })
        } catch { /* skip malformed */ }
      }
    } catch { /* dir not found */ }
    result.sort((a, b) => b.mtime.localeCompare(a.mtime))
    json(result)
    return
  }

  // GET /api/debug-stream (SSE — tails ~/.claude/debug/latest)
  if (url.pathname === "/api/debug-stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    })

    const debugLink = join(homedir(), ".claude", "debug", "latest")
    let lastTarget = null
    let lastLineCount = 0

    function readTarget() {
      try { return realpathSync(debugLink) } catch { return null }
    }

    function sendInit(target) {
      try {
        const lines = readFileSync(target, "utf8").split("\n")
        lastLineCount = lines.length
        res.write(`data: ${JSON.stringify({ type: "init", target, lines })}\n\n`)
      } catch {
        res.write(`data: ${JSON.stringify({ type: "init", target: null, lines: ["[debug file not found]"] })}\n\n`)
      }
    }

    const target = readTarget()
    lastTarget = target
    sendInit(target)

    const timer = setInterval(() => {
      try {
        const currentTarget = readTarget()
        if (currentTarget !== lastTarget) {
          // Symlink changed — new session
          lastTarget = currentTarget
          lastLineCount = 0
          sendInit(currentTarget)
          return
        }
        if (!currentTarget) return
        const lines = readFileSync(currentTarget, "utf8").split("\n")
        if (lines.length > lastLineCount) {
          const newLines = lines.slice(lastLineCount)
          lastLineCount = lines.length
          res.write(`data: ${JSON.stringify({ type: "append", lines: newLines })}\n\n`)
        }
      } catch { /* ignore read errors */ }
    }, 500)

    req.on("close", () => clearInterval(timer))
    return
  }

  // GET /api/open-path
  if (url.pathname.startsWith("/api/open-path")) {
    const project = url.searchParams.get("project")
    const session = url.searchParams.get("session")
    if (!project || !session) { json({ error: "Missing project or session" }, 400); return }
    const filePath = join(CLAUDE_DIR, project, `${session}.jsonl`)
    exec(`open "${filePath.replace(/"/g, '\\"')}"`, (err) => {
      if (err) json({ error: err.message }, 500)
      else json({ ok: true })
    })
    return
  }

  // Static files (dist/)
  if (!url.pathname.startsWith("/api/")) {
    serveStatic(req, res)
    return
  }

  res.writeHead(404); res.end("Not Found")
})

server.listen(PORT, () => {
  console.log(`\n  Claude Session Viewer (local mode)`)
  console.log(`  API:      http://localhost:${PORT}`)
  if (existsSync(DIST_DIR)) {
    console.log(`  App:      http://localhost:${PORT}`)
  } else {
    console.log(`  Frontend: run 'npm run dev' in another terminal (Vite proxies to this port)`)
  }
  if (!AUTH_PIN) {
    console.log(`  Auth:     disabled (set AUTH_PIN=1234 to enable)\n`)
  } else {
    console.log(`  Auth:     PIN protected\n`)
  }
})
