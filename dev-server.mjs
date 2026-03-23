/**
 * Local Express server for dev — reads ~/.claude/projects/ directly
 * and serves /api/projects + /api/stream SSE.
 *
 * Run: node dev-server.mjs
 * Then: vite (in another terminal) — proxies /api → localhost:3001
 */

import { createReadStream, readdirSync, readFileSync, statSync, watchFile } from "fs"
import { homedir } from "os"
import { join } from "path"
import http from "http"

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

const sseClients = new Set()

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")

  if (req.url === "/api/projects") {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(loadProjects()))
    return
  }

  if (req.url === "/api/stream") {
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    send("projects", loadProjects())
    sseClients.add(res)
    req.on("close", () => sseClients.delete(res))
    return
  }

  res.writeHead(404)
  res.end()
}).listen(PORT, () => console.log(`Dev server on http://localhost:${PORT}`))

// Watch ~/.claude/projects for changes and push SSE updates
setInterval(() => {
  const projects = loadProjects()
  for (const client of sseClients) {
    try {
      client.write(`event: projects\ndata: ${JSON.stringify(projects)}\n\n`)
    } catch {
      sseClients.delete(client)
    }
  }
}, 3000)
