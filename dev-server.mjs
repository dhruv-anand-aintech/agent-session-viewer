/**
 * Minimal local API for dev — Claude JSONL only (no Cursor/OpenCode/etc.).
 *
 * Run: node dev-server.mjs  OR  npm run dev:api
 * Then: vite — proxies /api → localhost:3001
 *
 * Must match pathname (not full req.url) so ?maxSessions=30 from the SPA is handled.
 */

import { readdirSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import http from "http"
import { trimProjectsByRecentSessionCount, countSessionsInProjects } from "./shared-utils.mjs"

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const PORT = 3001
const FIVE_MIN = 5 * 60 * 1000

function parseJsonl(fp) {
  return readFileSync(fp, "utf8").split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function loadProjects() {
  const projects = []
  for (const dir of readdirSync(CLAUDE_DIR)) {
    const dp = join(CLAUDE_DIR, dir)
    try { if (!statSync(dp).isDirectory()) continue } catch { continue }
    const sessions = []
    for (const f of readdirSync(dp).filter(f => f.endsWith(".jsonl"))) {
      const fp = join(dp, f)
      const stat = statSync(fp)
      const msgs = parseJsonl(fp)
      const first = msgs.find(m => m.sessionId)
      const last = [...msgs].reverse().find(m => m.timestamp)
      sessions.push({
        id: f.replace(".jsonl", ""),
        projectPath: dir,
        messages: msgs,
        lastActivity: last?.timestamp ?? stat.mtime.toISOString(),
        version: first?.version,
        gitBranch: first?.gitBranch,
        isActive: Date.now() - stat.mtimeMs < FIVE_MIN,
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

function projectsBundle(maxSessions) {
  const full = loadProjects()
  const total = countSessionsInProjects(full)
  const n = Number(maxSessions)
  if (!Number.isFinite(n) || n <= 0 || total <= n) return { projects: full, total }
  return { projects: trimProjectsByRecentSessionCount(full, n), total }
}

/** @type {Set<{ res: import('http').ServerResponse, maxSessions: number | null }>} */
const sseClients = new Set()

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Sessions")

  const url = new URL(req.url || "/", "http://127.0.0.1")
  const path = url.pathname

  if (path === "/api/capabilities") {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ openPath: false, debugStream: true, pinRequired: false }))
    return
  }

  if (path === "/api/projects") {
    const maxRaw = url.searchParams.get("maxSessions")
    const maxParsed = maxRaw != null && maxRaw !== "" ? Number(maxRaw) : null
    const { projects, total } = projectsBundle(maxParsed ?? 0)
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Total-Sessions": String(total),
    })
    res.end(JSON.stringify(projects))
    return
  }

  if (path === "/api/stream") {
    const maxRaw = url.searchParams.get("maxSessions")
    const maxParsed = maxRaw != null && maxRaw !== "" ? Number(maxRaw) : null
    const maxSessions = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : null
    const { projects, total } = projectsBundle(maxSessions ?? 0)

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Total-Sessions": String(total),
    })

    const client = { res, maxSessions }
    res.write(`event: projects\ndata: ${JSON.stringify(projects)}\n\n`)
    sseClients.add(client)
    req.on("close", () => sseClients.delete(client))
    return
  }

  res.writeHead(404)
  res.end()
}).listen(PORT, () => console.log(`Dev server on http://localhost:${PORT}`))

setInterval(() => {
  const full = loadProjects()
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
}, 3000)
