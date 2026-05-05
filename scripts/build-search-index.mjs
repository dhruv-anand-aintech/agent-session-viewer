#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, totalmem } from "node:os"
import { join } from "node:path"
import { indexSessionMessages, removeSessionFromIndex } from "../lib/lancedb-search.mjs"
import { flattenMessageForThread } from "../lib/session-search-core.mjs"
import { loadSessionMessages } from "../lib/session-message-loader.mjs"

const APP_CONFIG_DIR = join(homedir(), ".config", "agent-session-viewer")
const SIDEBAR_CACHE_FILE = join(APP_CONFIG_DIR, "sidebar-cache.json")
const MANIFEST_FILE = join(APP_CONFIG_DIR, "lancedb-index-manifest.json")
const REBUILD = process.argv.includes("--rebuild")
const RESET = process.argv.includes("--reset")

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23)
}

function fmtMB(n) {
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function fmtPct(n) {
  return `${n.toFixed(1)}%`
}

function memoryLine() {
  const mu = process.memoryUsage()
  const rssPct = (mu.rss / totalmem()) * 100
  return `rss ${fmtMB(mu.rss)} (${fmtPct(rssPct)}) heap ${fmtMB(mu.heapUsed)}/${fmtMB(mu.heapTotal)} ext ${fmtMB(mu.external)}`
}

function loadSidebarSessions() {
  if (!existsSync(SIDEBAR_CACHE_FILE)) {
    throw new Error(`Missing sidebar cache: ${SIDEBAR_CACHE_FILE}. Run npm run build-cache first.`)
  }
  const raw = JSON.parse(readFileSync(SIDEBAR_CACHE_FILE, "utf8"))
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : []
  return sessions.filter(s => s && typeof s.id === "string" && typeof s.projectPath === "string")
}

function loadManifest() {
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"))
    const sessions = raw?.sessions && typeof raw.sessions === "object" ? raw.sessions : {}
    return { v: 1, sessions }
  } catch {
    return { v: 1, sessions: {} }
  }
}

function saveManifest(map) {
  mkdirSync(APP_CONFIG_DIR, { recursive: true })
  writeFileSync(MANIFEST_FILE, JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), sessions: map }, null, 2))
}

function keyOf(entry) {
  return `${entry.projectPath}\x1f${entry.id}`
}

function parseKey(key) {
  const idx = key.indexOf("\x1f")
  if (idx === -1) return null
  return { projectPath: key.slice(0, idx), sessionId: key.slice(idx + 1) }
}

async function main() {
  const sessions = loadSidebarSessions()
  const manifest = RESET ? { v: 1, sessions: {} } : loadManifest()
  const currentKeys = new Map(sessions.map(s => [keyOf(s), s]))
  const staleKeys = Object.keys(manifest.sessions).filter(key => !currentKeys.has(key))

  console.log(`${ts()} [build-search-index] sessions=${sessions.length} rebuild=${REBUILD} reset=${RESET}`)
  if (staleKeys.length) {
    console.log(`${ts()} [build-search-index] removing ${staleKeys.length} stale sessions`)
    for (const key of staleKeys) {
      const parsed = parseKey(key)
      if (!parsed) continue
      await removeSessionFromIndex(parsed.projectPath, parsed.sessionId)
    }
  }

  const toIndex = sessions.filter(s => {
    const key = keyOf(s)
    if (REBUILD) return true
    const prev = manifest.sessions[key]
    return !prev || String(prev.mtime ?? "") !== String(s.mtime ?? "")
  })

  console.log(`${ts()} [build-search-index] indexing ${toIndex.length} sessions`)
  const start = Date.now()
  let done = 0
  let skipped = sessions.length - toIndex.length
  let indexedRows = 0
  let maxRss = 0

  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss
    maxRss = Math.max(maxRss, rss)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    process.stdout.write(
      `\r${ts()} [build-search-index] ${done}/${toIndex.length} done, ${skipped} skipped, ${fmtMB(rss)} rss, ${elapsed}s elapsed   `
    )
  }, 1000)
  timer.unref()

  try {
    for (const entry of toIndex) {
      const msgs = loadSessionMessages(entry.projectPath, entry.id)
      if (!Array.isArray(msgs) || !msgs.length) {
        await removeSessionFromIndex(entry.projectPath, entry.id)
        done++
        manifest.sessions[keyOf(entry)] = { mtime: String(entry.mtime ?? "") }
        continue
      }
      const rows = await indexSessionMessages(entry.projectPath, entry.id, msgs, flattenMessageForThread)
      indexedRows += rows
      done++
      manifest.sessions[keyOf(entry)] = { mtime: String(entry.mtime ?? ""), rows, lastIndexedAt: new Date().toISOString() }
    }
  } finally {
    clearInterval(timer)
  }

  for (const key of staleKeys) delete manifest.sessions[key]
  if (!REBUILD && !RESET) {
    for (const key of Object.keys(manifest.sessions)) {
      if (!currentKeys.has(key)) delete manifest.sessions[key]
    }
  }
  saveManifest(manifest.sessions)

  const totalElapsed = ((Date.now() - start) / 1000).toFixed(1)
  const rss = process.memoryUsage().rss
  maxRss = Math.max(maxRss, rss)
  process.stdout.write(`\r${ts()} [build-search-index] ${done}/${toIndex.length} done, ${skipped} skipped, ${fmtMB(rss)} rss, ${totalElapsed}s elapsed   \n`)
  console.log(`${ts()} [build-search-index] rows indexed=${indexedRows} peak-rss=${fmtMB(maxRss)} ${memoryLine()}`)
}

main().catch(err => {
  console.error(`${ts()} [build-search-index] fatal:`, err.stack || err.message)
  process.exitCode = 1
})
