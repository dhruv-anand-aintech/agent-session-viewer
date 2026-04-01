/**
 * Local server — full replacement for the Cloudflare Worker.
 * Reads ~/.claude/projects/ directly; no Cloudflare account needed.
 *
 * Run via: npm run local
 * Config persisted to: ~/.claude/session-viewer-local.json
 */

import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, extname, join, sep } from "path"
import http from "http"
import { fileURLToPath } from "url"
import { exec } from "child_process"
import { stripXml, trimProjectsByRecentSessionCount, countSessionsInProjects } from "./shared-utils.mjs"
import {
  readCursorSessions,
  readCursorAgentSessions,
  CURSOR_PROJECTS_ROOT,
  readOpenCodeSession,
  iterOpenCodeSessions,
  OPENCODE_STORAGE,
  ANTIGRAVITY_BRAIN_DIR,
  parseAntigravitySessionIndex,
  readAntigravitySession,
  readAntigravityRpcSessions,
  HERMES_DB,
  readHermesSessions,
  normProjectDir,
} from "./platform-readers.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const CONFIG_FILE = join(homedir(), ".claude", "session-viewer-local.json")

const DIST_DIR = join(__dirname, "dist")
const PORT = parseInt(process.env.PORT ?? "3001")
const AUTH_PIN = process.env.AUTH_PIN ?? null

/** Max lines sent on initial debug load / SSE init (full file still tracked for append). */
const DEBUG_TAIL_LINES = 500

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

async function loadProjectsFull() {
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
        source: "claude",
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

  // Merge in external platform sessions
  const allProjects = [
    ...projects,
    ...loadCursorSessions(),
    ...loadCursorAgentSessions(),
    ...loadOpenCodeSessions(),
    ...await loadAntigravitySessions(),
    ...loadHermesSessions(),
  ]

  return allProjects.sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity ?? ""
    const bLast = b.sessions[0]?.lastActivity ?? ""
    return bLast.localeCompare(aLast)
  })
}

async function loadProjectsBundle(maxSessions) {
  const full = await loadProjectsFull()
  const total = countSessionsInProjects(full)
  const n = Number(maxSessions)
  if (!Number.isFinite(n) || n <= 0 || total <= n) return { projects: full, total }
  return { projects: trimProjectsByRecentSessionCount(full, n), total }
}

// ── In-memory message cache for non-JSONL platforms ───────────────────────────
const msgCache = new Map() // `projectPath/sessionId` → SessionMessage[]

function resultsToProjects(results, platformPrefix) {
  const projects = new Map()
  for (const { meta, msgs } of results) {
    const { id, projectPath, lastActivity } = meta
    msgCache.set(`${projectPath}/${id}`, msgs)
    if (!projects.has(projectPath)) {
      const dirPart = projectPath.replace(`${platformPrefix}:`, "")
      projects.set(projectPath, {
        path: projectPath,
        displayName: `${platformPrefix}: ${dirPart.replace(/^-Users-[^-]+-Code-/, "").replace(/-/g, "/")}`,
        sessions: [],
      })
    }
    projects.get(projectPath).sessions.push({ ...meta })
  }
  for (const proj of projects.values()) {
    proj.sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  }
  return Array.from(projects.values())
}

// ── Cursor sessions ────────────────────────────────────────────────────────────

function loadCursorSessions() {
  return resultsToProjects(readCursorSessions(), "cursor")
}

function loadCursorAgentSessions() {
  if (!existsSync(CURSOR_PROJECTS_ROOT)) return []
  return resultsToProjects(readCursorAgentSessions(null, null), "cursor-agent")
}

// ── OpenCode sessions ──────────────────────────────────────────────────────────

function loadOpenCodeSessions() {
  return resultsToProjects([...iterOpenCodeSessions(null, null)].map(x => x.result), "opencode")
}

// ── Antigravity sessions ───────────────────────────────────────────────────────

async function loadAntigravitySessions() {
  if (!existsSync(ANTIGRAVITY_BRAIN_DIR)) return []

  // Try live RPC first for full chat history
  const indexSessions = parseAntigravitySessionIndex()
  const indexMap = new Map(indexSessions.map(s => [s.id, s]))
  const rpcResults = await readAntigravityRpcSessions(indexMap).catch(() => [])
  if (rpcResults.length) return resultsToProjects(rpcResults, "antigravity")

  // Fall back to markdown artifacts
  for (const id of readdirSync(ANTIGRAVITY_BRAIN_DIR)) {
    if (!indexMap.has(id)) indexMap.set(id, { id, title: null, workspacePath: "" })
  }
  const results = []
  for (const session of indexMap.values()) {
    const r = readAntigravitySession(session, null, null)
    if (r) results.push(r)
  }
  return resultsToProjects(results, "antigravity")
}

// ── Hermes sessions ────────────────────────────────────────────────────────────

function loadHermesSessions() {
  if (!existsSync(HERMES_DB)) return []
  return resultsToProjects(readHermesSessions(null, null), "hermes")
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

/** @type {Set<{ res: import('http').ServerResponse, maxSessions: number | null }>} */
const sseClients = new Set()

async function broadcastProjects() {
  if (sseClients.size === 0) return
  const full = await loadProjectsFull()
  for (const c of sseClients) {
    const payload =
      c.maxSessions != null && c.maxSessions > 0
        ? trimProjectsByRecentSessionCount(full, c.maxSessions)
        : full
    try {
      c.res.write(`event: projects\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      sseClients.delete(c)
    }
  }
}

// Watch ~/.claude/projects for file changes
try {
  watch(CLAUDE_DIR, { recursive: true }, () => broadcastProjects())
} catch {
  // Fallback to polling if watch fails (e.g., too many files)
  setInterval(broadcastProjects, 3000)
}

if (existsSync(CURSOR_PROJECTS_ROOT)) {
  try {
    watch(CURSOR_PROJECTS_ROOT, { recursive: true }, () => broadcastProjects())
  } catch { /* ignore */ }
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
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Sessions")

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

  // GET /api/capabilities — public bootstrap for SPA (must stay before cookie gate)
  if (url.pathname === "/api/capabilities") {
    json({
      openPath: true,
      debugStream: true,
      pinRequired: Boolean(AUTH_PIN),
    })
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

  // GET /api/projects?maxSessions=30 — omit or maxSessions=0 for full list
  if (url.pathname === "/api/projects") {
    const maxRaw = url.searchParams.get("maxSessions")
    const maxParsed = maxRaw != null && maxRaw !== "" ? Number(maxRaw) : null
    const { projects, total } = await loadProjectsBundle(maxParsed ?? 0)
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Total-Sessions": String(total),
    })
    res.end(JSON.stringify(projects))
    return
  }

  // GET /api/stream  (SSE) — optional ?maxSessions=30 to match initial list
  if (url.pathname === "/api/stream") {
    const maxRaw = url.searchParams.get("maxSessions")
    const maxParsed = maxRaw != null && maxRaw !== "" ? Number(maxRaw) : null
    const maxSessions = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : null
    const { projects, total } = await loadProjectsBundle(maxSessions ?? 0)
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Total-Sessions": String(total),
    })
    const client = { res, maxSessions }
    res.write(`event: projects\ndata: ${JSON.stringify(projects)}\n\n`)
    sseClients.add(client)
    req.on("close", () => sseClients.delete(client))
    return
  }

  // GET /api/session/:project/:id
  const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/)
  if (sessionMatch) {
    const projectPath = decodeURIComponent(sessionMatch[1])
    const sessionId = sessionMatch[2]
    // Non-Claude platforms store messages in the msgCache (populated by loadProjects)
    const cacheKey = `${projectPath}/${sessionId}`
    if (msgCache.has(cacheKey)) { json(msgCache.get(cacheKey)); return }
    // Claude: read JSONL file directly
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

  // GET /api/debug
  if (url.pathname === "/api/debug") {
    const projects = await loadProjectsFull()
    json({ sessionCount: projects.flatMap(p => p.sessions).length, projectCount: projects.length })
    return
  }

  // GET /api/debug-tail — last N lines of ~/.claude/debug/latest (instant seed; same cap as SSE init)
  if (url.pathname === "/api/debug-tail") {
    const debugLink = join(homedir(), ".claude", "debug", "latest")
    let target = null
    try { target = realpathSync(debugLink) } catch { /* missing */ }
    if (!target) {
      json({ target: null, lines: ["[debug file not found]"] })
      return
    }
    try {
      const lines = readFileSync(target, "utf8").split("\n")
      const tail = lines.length > DEBUG_TAIL_LINES ? lines.slice(-DEBUG_TAIL_LINES) : lines
      json({ target, lines: tail })
    } catch {
      json({ target: null, lines: ["[debug file not found]"] })
    }
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
      if (!target) {
        lastLineCount = 0
        res.write(`data: ${JSON.stringify({ type: "init", target: null, lines: ["[debug file not found]"] })}\n\n`)
        return
      }
      try {
        const lines = readFileSync(target, "utf8").split("\n")
        lastLineCount = lines.length
        const initLines = lines.length > DEBUG_TAIL_LINES ? lines.slice(-DEBUG_TAIL_LINES) : lines
        res.write(`data: ${JSON.stringify({ type: "init", target, lines: initLines })}\n\n`)
      } catch {
        lastLineCount = 0
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
