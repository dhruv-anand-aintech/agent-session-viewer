/**
 * Local server — full replacement for the Cloudflare Worker.
 * Reads ~/.claude/projects/ directly; no Cloudflare account needed.
 *
 * Run via: npm run local
 * Config persisted to: ~/.claude/agent-session-viewer-local.json
 */

import { createReadStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "fs"
import { homedir } from "os"
import { basename, dirname, extname, join, sep } from "path"
import http from "http"
import { fileURLToPath } from "url"
import { exec } from "child_process"
import { stripXml, trimProjectsByRecentSessionCount, countSessionsInProjects } from "./shared-utils.mjs"
import { loadSessionMessages } from "./lib/session-message-loader.mjs"
import {
  readCodexSessions,
  CODEX_SESSIONS_ROOT,
  readCursorSessions,
  readCursorSessionMsgs,
  readCursorAgentSessions,
  readCursorAgentSessionFile,
  listCursorAgentTranscriptFiles,
  CURSOR_PROJECTS_ROOT,
  readOpenCodeSession,
  readOpenCodeSessionFromSqlite,
  iterOpenCodeSessions,
  OPENCODE_DIR,
  OPENCODE_DB,
  OPENCODE_STORAGE,
  ANTIGRAVITY_BRAIN_DIR,
  parseAntigravitySessionIndex,
  readAntigravitySession,
  readAntigravityRpcSessions,
  HERMES_DB,
  readHermesSessions,
  readCodexSessionById,
  normProjectDir,
  readOpenclawSessions,
  OPENCLAW_ROOT,
  findOpenclawSessionFile,
  findCodexSessionFile,
} from "./platform-readers.mjs"
import { buildSidebarSearchDoc, runSidebarSessionSearch, runThreadKeywordSearch } from "./lib/session-search-core.mjs"
import { indexSession, removeSession, getSearchRows } from "./lib/search-index.mjs"
import { searchSessions } from "./lib/lancedb-search.mjs"
import { startBackgroundIndexer, indexOneSession as lanceIndexOne, removeOne as lanceRemoveOne, getIndexerStatus } from "./lib/lancedb-indexer.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const APP_CONFIG_DIR = join(homedir(), ".config", "agent-session-viewer")
const CONFIG_FILE = join(APP_CONFIG_DIR, "config.json")
const SIDEBAR_CACHE_FILE = join(APP_CONFIG_DIR, "sidebar-cache.json")

/**
 * Turn an encoded project dir (e.g. "-Users-dhruv-Code-my-cool-project") into a
 * human-readable display name. Reconstructs the absolute path and checks if it
 * exists on disk — if so, shows path relative to home. Falls back to stripping
 * the common ~/Code prefix without replacing remaining dashes (avoids turning
 * "my-cool-project" into "my/cool/project").
 */
function encodedDirToDisplayName(encodedDir) {
  // Reconstruct absolute path and verify on disk — preserves actual dashes in folder names
  const abs = "/" + encodedDir.replace(/-/g, "/")
  if (existsSync(abs)) return abs.replace(homedir() + "/", "")
  // Disk check failed (path has ambiguous dashes): strip the common ~/Code/ prefix and show remainder as-is
  return encodedDir.replace(/^-?Users-[^-]+-Code-/, "")
}

/**
 * Decode a Claude-style dash-encoded dir name to the best-guess absolute path.
 *
 * Claude encodes workspace paths by replacing every "/" with "-" and stripping the
 * leading "/". So "/Users/alice/Code/my-project" becomes "-Users-alice-Code-my-project".
 * This is ambiguous when directory names themselves contain dashes.
 *
 * Strategy: strip the "-Users-<username>-" prefix, then greedily match the longest
 * run of dash-separated segments that names a real directory on disk, descending one
 * level at a time. This correctly resolves both:
 *   - flat names with dashes:  "Code-agent-session-viewer" → ~/Code/agent-session-viewer
 *   - nested paths:            "Code-home-debug-CloudSweeper" → ~/Code/home-debug/CloudSweeper
 */
function decodeClaudeEncodedDir(encodedDir) {
  const withoutUser = encodedDir.replace(/^-?Users-[^-]+-/, "")
  const segments = withoutUser.split("-").filter(Boolean)

  let current = homedir()
  let i = 0
  while (i < segments.length) {
    let matched = false
    for (let j = segments.length; j > i; j--) {
      const name = segments.slice(i, j).join("-")
      if (existsSync(join(current, name))) {
        current = join(current, name)
        i = j
        matched = true
        break
      }
    }
    if (!matched) {
      current = join(current, segments.slice(i).join("-"))
      break
    }
  }
  return current
}

/**
 * Resolve any projectPath variant to the best-guess absolute real directory.
 * Used as the canonical merge key in mergeProjectsInto and for display.
 */
function resolveProjectDir(projectPath) {
  // Cursor "no workspace" variants — both map to the same virtual canonical dir
  if (projectPath === "cursor:cursor-unknown") return join(homedir(), ".cursor", "no-workspace")
  if (projectPath === "cursor-agent:/empty/window") return join(homedir(), ".cursor", "no-workspace")
  if (projectPath === "cursor-agent:empty-window") return join(homedir(), ".cursor", "no-workspace")

  // Modern platform-prefixed with absolute path: "prefix:/actual/path"
  const absMatch = projectPath.match(/^[a-z-]+:(\/.+)$/)
  if (absMatch) return absMatch[1]

  // Claude absolute path under CLAUDE_DIR (always dash-encoded by Claude itself)
  if (projectPath.startsWith(CLAUDE_DIR + "/")) {
    return decodeClaudeEncodedDir(projectPath.slice(CLAUDE_DIR.length + 1))
  }

  // Legacy platform-prefixed with encoded path (old normProjectDir / cursor-agent slug)
  // e.g. "cursor-agent:Users-dhruvanand-Code-myproject" or "codex:Code-myproject"
  const encodedMatch = projectPath.match(/^[a-z-]+:([^/].+)$/)
  if (encodedMatch) {
    const encoded = encodedMatch[1]
    return decodeClaudeEncodedDir(encoded.startsWith("Users-") ? `-${encoded}` : encoded)
  }

  if (projectPath.startsWith("/")) return projectPath
  return join(homedir(), projectPath)
}

const DIST_DIR = join(__dirname, "dist")
const PORT = parseInt(process.env.PORT ?? "3001")
const AUTH_PIN = process.env.AUTH_PIN ?? null
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 23)
const ENABLE_BACKGROUND_INDEXER = process.env.ENABLE_LANCEDB_BACKGROUND_INDEXER !== "0"

/** Max lines sent on initial debug load / SSE init (full file still tracked for append). */
const DEBUG_TAIL_LINES = 500

const FIVE_MIN = 5 * 60 * 1000

// --- Config persistence (names + settings) ---

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) } catch { return {} }
}

function saveConfig(data) {
  mkdirSync(APP_CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2))
}

// --- Sidebar cache (persists messageCount/userMessageCount/firstName keyed by sessionId + mtime) ---
// Shape: { [sessionId]: { messageCount, userMessageCount, firstName, mtime } }

let _sidebarCache = null

// Cache shape v2: { v: 2, sessions: CacheEntry[] } sorted by lastActivity desc.
// CacheEntry: { id, projectPath, projectDisplayName, source, messageCount, userMessageCount,
//               firstName, lastActivity, mtime, customName? }
// Loaded once into memory; a Map index is built for O(1) lookup by sessionId.

function loadSidebarCache() {
  if (_sidebarCache) return _sidebarCache
  try {
    const raw = JSON.parse(readFileSync(SIDEBAR_CACHE_FILE, "utf8"))
    _sidebarCache = raw
    _sidebarCache._map = new Map(_sidebarCache.sessions.map(e => [e.id, e]))
  } catch {
    _sidebarCache = { v: 2, sessions: [], _map: new Map() }
  }
  return _sidebarCache
}

function saveSidebarCache() {
  if (!_sidebarCache) return
  // Sort by lastActivity desc before writing; omit _map (non-serialisable)
  _sidebarCache.sessions.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
  const { _map, ...toWrite } = _sidebarCache
  try { writeFileSync(SIDEBAR_CACHE_FILE, JSON.stringify(toWrite)) } catch { /* ignore */ }
}

/**
 * Convert the cache into ProjectData[] groups, applying stored customNames.
 * Returns null if cache is empty.
 */
function loadCachedSidebarState() {
  const cache = loadSidebarCache()
  if (!cache.sessions.length) return null
  const names = loadConfig().names ?? {}
  const projectMap = new Map()
  for (const e of cache.sessions) {
    if (!projectMap.has(e.projectPath)) {
      projectMap.set(e.projectPath, {
        path: e.projectPath,
        displayName: e.projectDisplayName,
        sessions: [],
      })
    }
    projectMap.get(e.projectPath).sessions.push({
      id: e.id,
      projectPath: e.projectPath,
      lastActivity: e.lastActivity,
      messageCount: e.messageCount ?? 0,
      userMessageCount: e.userMessageCount ?? null,
      firstName: e.firstName ?? null,
      customName: names[`${e.projectPath}/${e.id}`] ?? e.customName ?? null,
      source: e.source ?? "claude",
      isActive: false,
    })
  }
  return Array.from(projectMap.values())
}

/** Apply cached counts/names to sessions that are missing them (cheap-scan results). */
function applySidebarCache(sessions) {
  const { _map } = loadSidebarCache()
  for (const s of sessions) {
    const entry = _map.get(s.id)
    if (!entry) continue
    // Use cached value whenever the live value is 0/null (cheap-scan placeholder)
    if (!s.messageCount && entry.messageCount) s.messageCount = entry.messageCount
    if (!s.userMessageCount && entry.userMessageCount) s.userMessageCount = entry.userMessageCount
    if (!s.firstName && entry.firstName) s.firstName = entry.firstName
  }
}

/** Upsert a cache entry. Returns true if anything changed. */
function updateSidebarCacheEntry(sessionId, { projectPath, projectDisplayName, source, messageCount, userMessageCount, firstName, lastActivity, mtime, customName }) {
  const cache = loadSidebarCache()
  const mtimeStr = typeof mtime === "number" ? String(mtime) : String(mtime)
  const existing = cache._map.get(sessionId)
  if (existing &&
      existing.mtime === mtimeStr &&
      existing.messageCount === messageCount &&
      existing.userMessageCount === userMessageCount &&
      existing.firstName === firstName) return false
  const entry = {
    id: sessionId,
    projectPath: projectPath ?? existing?.projectPath ?? "",
    projectDisplayName: projectDisplayName ?? existing?.projectDisplayName ?? "",
    source: source ?? existing?.source ?? "claude",
    messageCount: messageCount ?? 0,
    userMessageCount: userMessageCount ?? null,
    firstName: firstName ?? null,
    lastActivity: lastActivity ?? existing?.lastActivity ?? new Date(Number(mtimeStr)).toISOString(),
    mtime: mtimeStr,
    customName: customName ?? existing?.customName ?? null,
  }
  if (existing) {
    Object.assign(existing, entry)
  } else {
    cache.sessions.push(entry)
    cache._map.set(sessionId, entry)
  }
  return true
}

/** Flush updated cache entries from a hydrated projects array. */
function flushSidebarCacheFromProjects(projects, fileBySessKey) {
  let dirty = false
  for (const p of projects) {
    for (const s of p.sessions) {
      const mtimeMs = fileBySessKey
        ? fileBySessKey.get(SESS_PATH_KEY(p.path, s.id))?.stat?.mtimeMs
        : null
      if (updateSidebarCacheEntry(s.id, {
        projectPath: p.path,
        projectDisplayName: p.displayName,
        source: s.source ?? "claude",
        messageCount: s.messageCount ?? 0,
        userMessageCount: s.userMessageCount ?? null,
        firstName: s.firstName ?? null,
        lastActivity: s.lastActivity,
        mtime: mtimeMs ?? s.lastActivity,
        customName: s.customName ?? null,
      })) dirty = true
    }
  }
  if (dirty) saveSidebarCache()
}

// --- Session reading ---

function parseJsonl(fp) {
  const t0 = performance.now()
  try {
    const raw = readFileSync(fp, "utf8")
    const lines = raw.split("\n").filter(Boolean)
    const result = lines.flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    const ms = (performance.now() - t0).toFixed(1)
    if (parseFloat(ms) > 50) console.warn(`[perf] parseJsonl ${ms}ms — ${result.length} msgs — ${fp.split("/").pop()}`)
    return result
  } catch { return [] }
}

/**
 * Count non-empty lines in a JSONL file with a fast byte scan (no JSON parsing).
 * Reads the whole file in 256KB chunks, counts newlines.
 */
function countJsonlLines(fp) {
  try {
    const { size } = statSync(fp)
    if (size === 0) return 0
    const CHUNK = 262144
    const buf = Buffer.alloc(CHUNK)
    const fd = openSync(fp, "r")
    let count = 0
    let offset = 0
    let prevWasNewline = true  // so a leading non-empty first line counts
    try {
      while (offset < size) {
        const n = readSync(fd, buf, 0, CHUNK, offset)
        if (n === 0) break
        for (let i = 0; i < n; i++) {
          const b = buf[i]
          if (b === 10 /* \n */) {
            prevWasNewline = true
          } else if (prevWasNewline) {
            prevWasNewline = false
            count++
          }
        }
        offset += n
      }
    } finally { closeSync(fd) }
    return count
  } catch { return 0 }
}

/**
 * Parse the last `n` valid JSON lines from a JSONL file without reading the whole file.
 * Reads backward in 64KB chunks until `n` parsed objects are collected.
 */
function readJsonlTail(fp, n) {
  try {
    const { size } = statSync(fp)
    if (size === 0) return []
    const CHUNK = 65536
    let offset = size
    let partial = ""
    const lines = []
    const fd = openSync(fp, "r")
    try {
      while (offset > 0 && lines.length < n) {
        const readSize = Math.min(CHUNK, offset)
        offset -= readSize
        const buf = Buffer.alloc(readSize)
        readSync(fd, buf, 0, readSize, offset)
        const chunk = buf.toString("utf8") + partial
        const parts = chunk.split("\n")
        partial = parts[0]  // possibly incomplete first line
        for (let i = parts.length - 1; i >= 1 && lines.length < n; i--) {
          const line = parts[i].trim()
          if (!line) continue
          try { lines.push(JSON.parse(line)) } catch { /* skip malformed */ }
        }
      }
    } finally { closeSync(fd) }
    lines.reverse()
    return lines
  } catch { return [] }
}

/** Read just the first ~4KB of a JSONL to cheaply extract the first user message text. */
function cheapReadFirstUserMsg(fp, maxLines = 30) {
  try {
    const fd = openSync(fp, "r")
    const buf = Buffer.alloc(65536)
    const n = readSync(fd, buf, 0, 65536, 0)
    closeSync(fd)
    const raw = buf.toString("utf8", 0, n)
    const lines = raw.split("\n")
    for (let i = 0; i < Math.min(maxLines, lines.length); i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type !== "user") continue
        const c = msg.message?.content
        if (!c) continue
        if (typeof c === "string" && c.trim()) return stripXml(c).slice(0, 100)
        if (Array.isArray(c)) {
          const tb = c.find(b => b.type === "text" && b.text?.trim() && !c.some(x => x.type === "tool_result"))
          if (tb) return stripXml(tb.text).slice(0, 100)
          // fallback: any text block that isn't only tool results
          const anyTb = c.find(b => b.type === "text" && b.text?.trim())
          if (anyTb) return stripXml(anyTb.text).slice(0, 100)
        }
      } catch { continue }
    }
    return null
  } catch { return null }
}

/** Roots: ~/.claude/projects plus config extraProjectRoots */
function getClaudeScanRoots() {
  const config = loadConfig()
  const roots = [{ path: CLAUDE_DIR, label: null }]
  for (const extra of config.extraProjectRoots ?? []) {
    const p = typeof extra === "string" ? extra : extra.path
    const label = typeof extra === "object" ? (extra.label ?? null) : null
    roots.push({ path: p.replace(/^~/, homedir()), label })
  }
  return roots
}

function claudeSessionMetaFromMsgs(msgs, sessionId, projectKey, names, stat) {
  const first = msgs.find(m => m.sessionId)
  const last = [...msgs].reverse().find(m => m.timestamp)

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
      if (textBlock?.text) text = textBlock.text
    }
    if (text) firstName = stripXml(text).slice(0, 100)
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

  return {
    id: sessionId,
    projectPath: projectKey,  // projectKey = full CLAUDE_DIR path passed by caller
    lastActivity: last?.timestamp ?? stat.mtime.toISOString(),
    version: first?.version,
    gitBranch: first?.gitBranch,
    isActive: Date.now() - stat.mtimeMs < FIVE_MIN,
    userMessageCount,
    messageCount,
    firstName,
    customName: names[`${projectKey}/${sessionId}`] ?? null,
    source: "claude",
  }
}

/** Full parse of every Claude JSONL — search, SSE refresh, “load all” sidebar. */
async function loadProjectsFull() {
  const names = loadConfig().names ?? {}
  const projects = []
  const roots = getClaudeScanRoots()

  for (const { path: root, label } of roots) {
    let dirs
    try { dirs = readdirSync(root) } catch { continue }

    for (const dir of dirs) {
      const dp = join(root, dir)
      try { if (!statSync(dp).isDirectory()) continue } catch { continue }

      const sessions = []
      let files
      try { files = readdirSync(dp).filter(f => f.endsWith(".jsonl")) } catch { continue }

      for (const f of files) {
        const fp = join(dp, f)
        let stat
        try { stat = statSync(fp) } catch { continue }
        const sessionId = f.replace(".jsonl", "")
        const projectKey = root === CLAUDE_DIR ? dir : `${root}/${dir}`
        const ck = `${root}/${dir}/${sessionId}`
        const msgs = msgCache.has(ck) ? msgCache.get(ck) : parseJsonl(fp)
        if (!msgCache.has(ck)) msgCache.set(ck, msgs)
        sessions.push(claudeSessionMetaFromMsgs(msgs, sessionId, `${root}/${dir}`, names, stat))
      }

      if (sessions.length > 0) {
        const baseName = encodedDirToDisplayName(dir)
        projects.push({
          path: `${root}/${dir}`,
          displayName: label ? `[${label}] ${baseName}` : baseName,
          sessions: sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
        })
      }
    }
  }

  const { fileBySessKey } = scanClaudeProjectsCheap(names)
  scheduleClaudeJsonlIndexing(fileBySessKey, names)

  const allProjects = [
    ...projects,
    ...loadCodexSessions(),
    ...loadCursorSessions(),
    ...loadCursorAgentSessions(),
    ...loadOpenCodeSessions(),
    ...await loadAntigravitySessions(),
    ...loadHermesSessions(),
    ...loadOpenclawSessions(),
  ]

  return allProjects.sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity ?? ""
    const bLast = b.sessions[0]?.lastActivity ?? ""
    return bLast.localeCompare(aLast)
  })
}

const SESS_PATH_KEY = (projectPath, sessionId) => `${projectPath}\x1f${sessionId}`

/**
 * One Claude project directory under a scan root. Fills `fileBySessKey`; returns a project row or null.
 */
function scanOneClaudeFolder(root, label, dir, names, fileBySessKey) {
  const dp = join(root, dir)
  try { if (!statSync(dp).isDirectory()) return null } catch { return null }
  let files
  try { files = readdirSync(dp).filter(f => f.endsWith(".jsonl")) } catch { return null }
  if (!files.length) return null
  const projectPath = `${root}/${dir}`
  const projectKey = root === CLAUDE_DIR ? dir : `${root}/${dir}`
  const cacheMap = loadSidebarCache()._map
  const sessions = []
  for (const f of files) {
    const fp = join(dp, f)
    let stat
    try { stat = statSync(fp) } catch { continue }
    const sessionId = f.replace(".jsonl", "")
    fileBySessKey.set(SESS_PATH_KEY(projectPath, sessionId), { fp, stat })
    // Use cached firstName if available — avoids 64KB file read per session during scan
    const cachedEntry = cacheMap.get(sessionId)
    const firstName = cachedEntry?.firstName ?? cheapReadFirstUserMsg(fp)
    sessions.push({
      id: sessionId,
      projectPath: projectPath,  // full CLAUDE_DIR path, consistent with project.path
      lastActivity: stat.mtime.toISOString(),
      version: undefined,
      gitBranch: undefined,
      isActive: Date.now() - stat.mtimeMs < FIVE_MIN,
      userMessageCount: cachedEntry?.userMessageCount ?? null,
      messageCount: cachedEntry?.messageCount ?? 0,
      firstName,
      customName: names[`${projectPath}/${sessionId}`] ?? null,
      source: "claude",
    })
  }
  applySidebarCache(sessions)
  const baseName = encodedDirToDisplayName(dir)
  return {
    path: projectPath,
    displayName: label ? `[${label}] ${baseName}` : baseName,
    sessions: sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
  }
}

/**
 * Stat-only Claude scan. `fileBySessKey`: `${root}/${dir}\\x1f${id}` → file for JSONL hydration.
 */
function scanClaudeProjectsCheap(names) {
  const projects = []
  /** @type {Map<string, { fp: string, stat: import('fs').Stats }>} */
  const fileBySessKey = new Map()
  for (const { path: root, label } of getClaudeScanRoots()) {
    let dirs
    try { dirs = readdirSync(root) } catch { continue }
    for (const dir of dirs) {
      const one = scanOneClaudeFolder(root, label, dir, names, fileBySessKey)
      if (one) projects.push(one)
    }
  }
  return { projects, fileBySessKey }
}

function sortProjectGroups(projects) {
  return [...projects].sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity ?? ""
    const bLast = b.sessions[0]?.lastActivity ?? ""
    return String(bLast).localeCompare(String(aLast))
  })
}

/** Merge incoming project rows into acc (by resolved absolute directory). */
function mergeProjectsInto(acc, incoming) {
  const map = new Map(acc.map(p => [resolveProjectDir(p.path), { ...p, sessions: [...p.sessions] }]))
  for (const inc of incoming) {
    const absDir = resolveProjectDir(inc.path)
    const isCursorNoWorkspace = absDir === join(homedir(), ".cursor", "no-workspace")
    const folderName = isCursorNoWorkspace ? "Cursor (no workspace)" : basename(absDir)
    const groupPath = isCursorNoWorkspace ? "Cursor sessions without a workspace" : absDir.startsWith(homedir() + "/") ? "~" + absDir.slice(homedir().length) : absDir
    if (!map.has(absDir)) {
      map.set(absDir, { ...inc, sessions: [...inc.sessions], displayName: folderName, groupPath })
    } else {
      const cur = map.get(absDir)
      cur.displayName = folderName
      cur.groupPath = groupPath
      const byId = new Map(cur.sessions.map(s => [s.id, s]))
      for (const s of inc.sessions) byId.set(s.id, s)
      cur.sessions = Array.from(byId.values()).sort((a, b) =>
        String(b.lastActivity).localeCompare(String(a.lastActivity)),
      )
    }
  }
  return sortProjectGroups(Array.from(map.values()))
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function yieldEventLoopTick() {
  return new Promise(r => setImmediate(r))
}

/** Parse and index every Claude JSONL under `fileBySessKey` (yields so the event loop stays responsive). */
async function backgroundIndexAllClaudeJsonl(fileBySessKey, names) {
  let i = 0
  let cacheDirty = false
  const cache = loadSidebarCache()
  for (const [sessKey, { fp, stat }] of fileBySessKey) {
    const sep = sessKey.indexOf("\x1f")
    if (sep === -1) continue
    const projectPath = sessKey.slice(0, sep)
    const sessionId = sessKey.slice(sep + 1)
    try {
      const msgs = parseJsonl(fp)
      const projKey =
        projectPath.startsWith(CLAUDE_DIR) ? projectPath.slice(CLAUDE_DIR.length + 1) : projectPath
      const meta = claudeSessionMetaFromMsgs(msgs, sessionId, projKey, names, stat)
      indexSession(projectPath, sessionId, msgs, meta)
      if (updateSidebarCacheEntry(sessionId, {
        messageCount: meta.messageCount,
        userMessageCount: meta.userMessageCount,
        firstName: meta.firstName ?? null,
        mtime: stat.mtimeMs,
      })) cacheDirty = true
    } catch { /* ignore bad files */ }
    if (++i % 20 === 0) {
      if (cacheDirty) { saveSidebarCache(); cacheDirty = false }
      await yieldEventLoopTick()
    }
  }
  if (cacheDirty) saveSidebarCache()
}

function scheduleClaudeJsonlIndexing(fileBySessKey, names) {
  setImmediate(async () => {
    await backgroundIndexAllClaudeJsonl(fileBySessKey, names)
  })
}

/** Progressive recent sidebar: emit cached state + bootstrap_done immediately, then fill in background. */
async function streamRecentSidebarInitial(res, maxSessions) {
  // Emit cached sidebar state and signal bootstrap done immediately — UI is interactive from the start.
  const cachedState = loadCachedSidebarState()
  if (cachedState?.length) {
    sseWrite(res, "projects", mergeProjectsInto([], cachedState))
    const cachedTotal = cachedState.reduce((s, p) => s + p.sessions.length, 0)
    sseWrite(res, "projects_meta", { total: cachedTotal })
  }
  sseWrite(res, "bootstrap_done", {})

  // Everything after this runs in background — doesn't block HTTP request processing.
  setImmediate(async () => {
    const names = loadConfig().names ?? {}
    /** @type {Map<string, { fp: string, stat: import('fs').Stats }>} */
    const fileBySessKey = new Map()
    let acc = []

    for (const { path: root, label } of getClaudeScanRoots()) {
      if (res.destroyed) return
      let dirs
      try { dirs = readdirSync(root) } catch { continue }
      for (const dir of dirs) {
        if (res.destroyed) return
        const chunk = scanOneClaudeFolder(root, label, dir, names, fileBySessKey)
        if (!chunk) continue
        acc = mergeProjectsInto(acc, [chunk])
        sseWrite(res, "projects", sortProjectGroups(acc))
        await yieldEventLoopTick()
      }
    }

    const fastPlatformLoads = [
      loadCodexSessions,
      loadOpenCodeSessions,
      loadHermesSessions,
      loadOpenclawSessions,
    ]
    for (const loadFn of fastPlatformLoads) {
      if (res.destroyed) return
      const part = await loadFn()
      if (!part.length) continue
      flushSidebarCacheFromProjects(part, null)
      acc = mergeProjectsInto(acc, part)
      sseWrite(res, "projects", sortProjectGroups(acc))
      await yieldEventLoopTick()
    }

    const total = countSessionsInProjects(acc)
    sseWrite(res, "projects_meta", { total })
    sseWrite(res, "projects", sortProjectGroups(acc))

    // Hydrate full metadata (message counts, accurate firstName) for the most recent sessions.
    const hydrateN = maxSessions ?? 50
    const allSorted = sortProjectGroups(acc)
    const forHydration = hydrateN > 0
      ? trimProjectsByRecentSessionCount(acc, hydrateN)
      : allSorted
    await hydrateClaudeSessionsInProjects(forHydration, fileBySessKey, names)
    flushSidebarCacheFromProjects(forHydration, fileBySessKey)
    // Push corrected message counts + firstName back via SSE
    for (const p of forHydration) {
      const ap = acc.find(a => a.path === p.path)
      if (!ap) continue
      const byId = new Map(ap.sessions.map(s => [s.id, s]))
      for (const s of p.sessions) {
        const as = byId.get(s.id)
        if (as && s.firstName) as.firstName = s.firstName
        if (as && s.messageCount != null) as.messageCount = s.messageCount
      }
    }
    if (!res.destroyed) sseWrite(res, "projects", sortProjectGroups(acc))

    scheduleClaudeJsonlIndexing(fileBySessKey, names)

    setTimeout(async () => {
      const slowPlatformLoads = [
        loadCursorSessions,
        loadCursorAgentSessions,
        async () => loadAntigravitySessions(),
      ]
      for (const loadFn of slowPlatformLoads) {
        if (res.destroyed) return
        const part = await loadFn()
        if (!part.length) continue
        flushSidebarCacheFromProjects(part, null)
        acc = mergeProjectsInto(acc, part)
        const nextTotal = countSessionsInProjects(acc)
        sseWrite(res, "projects_meta", { total: nextTotal })
        sseWrite(res, "projects", sortProjectGroups(acc))
        await yieldEventLoopTick()
      }
    }, 1500)
  }) // end setImmediate
}

async function hydrateClaudeSessionsInProjects(projects, fileBySessKey, names) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i]
      if (s.source !== "claude") continue
      const rec = fileBySessKey.get(SESS_PATH_KEY(p.path, s.id))
      if (!rec) continue
      // Use msgCache if already populated (e.g. by a concurrent /api/session request)
      const cacheKey = `${p.path}/${s.id}`
      const msgs = msgCache.has(cacheKey) ? msgCache.get(cacheKey) : parseJsonl(rec.fp)
      // Populate msgCache so concurrent/future /api/session requests are served instantly
      if (!msgCache.has(cacheKey)) msgCache.set(cacheKey, msgs)
      p.sessions[i] = claudeSessionMetaFromMsgs(msgs, s.id, s.projectPath, names, rec.stat)
      await yieldEventLoopTick()
    }
    if (p.sessions.length) {
      p.sessions.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
    }
  }
}

/** Sidebar “recent N” — trim using file mtime, then parse JSONL only for sessions kept. */
async function loadProjectsBundleRecent(maxSessions) {
  const names = loadConfig().names ?? {}
  const { projects: claudeProjects, fileBySessKey } = scanClaudeProjectsCheap(names)
  const allProjects = [
    ...claudeProjects,
    ...loadCodexSessions(),
    ...loadCursorSessions(),
    ...loadCursorAgentSessions(),
    ...loadOpenCodeSessions(),
    ...await loadAntigravitySessions(),
    ...loadHermesSessions(),
    ...loadOpenclawSessions(),
  ].sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity ?? ""
    const bLast = b.sessions[0]?.lastActivity ?? ""
    return String(bLast).localeCompare(String(aLast))
  })

  const total = countSessionsInProjects(allProjects)
  const trimmed =
    total > maxSessions ? trimProjectsByRecentSessionCount(allProjects, maxSessions) : allProjects
  await hydrateClaudeSessionsInProjects(trimmed, fileBySessKey, names)
  flushSidebarCacheFromProjects(trimmed, fileBySessKey)
  trimmed.sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity ?? ""
    const bLast = b.sessions[0]?.lastActivity ?? ""
    return String(bLast).localeCompare(String(aLast))
  })
  scheduleClaudeJsonlIndexing(fileBySessKey, names)
  return { projects: trimmed, total }
}

async function loadProjectsBundle(maxSessions) {
  const n = Number(maxSessions)
  if (!Number.isFinite(n) || n <= 0) {
    const full = await loadProjectsFull()
    return { projects: full, total: countSessionsInProjects(full) }
  }
  return loadProjectsBundleRecent(n)
}

// ── In-memory message cache for non-JSONL platforms ───────────────────────────
const msgCache = new Map() // `projectPath/sessionId` → SessionMessage[]

/**
 * If msgCache is cold (e.g. /api/session before /api/projects finished), load on demand.
 */
function loadSessionMessagesOndemand(projectPath, sessionId) {
  if (projectPath.startsWith("cursor:")) {
    try {
      const { msgs } = readCursorSessionMsgs(sessionId)
      return msgs.length ? msgs : null
    } catch { return null }
  }
  if (projectPath.startsWith("cursor-agent:")) {
    const slug = projectPath.slice("cursor-agent:".length)
    for (const { filePath, slug: s, sessionId: sid } of listCursorAgentTranscriptFiles()) {
      if (s === slug && sid === sessionId) {
        const r = readCursorAgentSessionFile(filePath, s, sid, null, null)
        return r?.msgs?.length ? r.msgs : null
      }
    }
    return null
  }
  if (projectPath.startsWith("opencode:")) {
    if (existsSync(OPENCODE_DB)) {
      const r = readOpenCodeSessionFromSqlite(OPENCODE_DB, sessionId, null, null)
      if (r && Array.isArray(r.msgs)) return r.msgs
    }
    if (!existsSync(join(OPENCODE_STORAGE, "session"))) return null
    for (const h of readdirSync(join(OPENCODE_STORAGE, "session"))) {
      const fp = join(OPENCODE_STORAGE, "session", h, `${sessionId}.json`)
      if (existsSync(fp)) {
        const r = readOpenCodeSession(fp, null, null)
        if (r && Array.isArray(r.msgs)) return r.msgs
        break
      }
    }
    return null
  }
  if (projectPath.startsWith("codex:")) {
    const result = readCodexSessionById(sessionId, null, null)
    if (result?.meta?.projectPath === projectPath && Array.isArray(result.msgs)) return result.msgs
    return null
  }
  if (projectPath.startsWith("hermes:")) {
    for (const { meta, msgs } of readHermesSessions(null, null)) {
      if (meta.id === sessionId && meta.projectPath === projectPath) return msgs
    }
    return null
  }
  if (projectPath.startsWith("antigravity:")) {
    const entry = parseAntigravitySessionIndex().find(s => s.id === sessionId)
    if (!entry) return null
    const r = readAntigravitySession(entry, null, null)
    if (r && Array.isArray(r.msgs) && r.meta.id === sessionId) return r.msgs
    return null
  }
  if (projectPath.startsWith("openclaw:")) {
    for (const { meta, msgs } of readOpenclawSessions(null, null)) {
      if (meta.id === sessionId) return msgs
    }
    return null
  }
  return null
}

/** Full message array for a session (no tail windowing). */
function getSessionMessagesAll(projectPath, sessionId) {
  if (projectPath.startsWith("cursor:")) {
    return readCursorSessionMsgs(sessionId).msgs
  }
  const cacheKey = `${projectPath}/${sessionId}`
  if (msgCache.has(cacheKey)) return msgCache.get(cacheKey)
  const ondemand = loadSessionMessagesOndemand(projectPath, sessionId)
  if (ondemand != null) {
    msgCache.set(cacheKey, ondemand)
    return ondemand
  }
  if (
    /^(opencode|codex|hermes|antigravity|cursor-agent|openclaw):/.test(projectPath) &&
    !/^[A-Za-z]:[\\/]/.test(projectPath)
  ) {
    return null
  }
  const fp = projectPath.startsWith("/")
    ? join(projectPath, `${sessionId}.jsonl`)
    : join(CLAUDE_DIR, projectPath, `${sessionId}.jsonl`)
  if (!existsSync(fp)) return null
  return parseJsonl(fp)
}

function resultsToProjects(results, platformPrefix) {
  const projects = new Map()
  for (const { meta, msgs } of results) {
    const { id, projectPath, lastActivity } = meta
    msgCache.set(`${projectPath}/${id}`, msgs)
    indexSession(projectPath, id, msgs, meta)
    if (!projects.has(projectPath)) {
      projects.set(projectPath, {
        path: projectPath,
        displayName: projectPath,  // overwritten by mergeProjectsInto with canonical folder name
        sessions: [],
      })
    }
    projects.get(projectPath).sessions.push({ ...meta })
  }
  for (const proj of projects.values()) {
    applySidebarCache(proj.sessions)
    proj.sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  }
  return Array.from(projects.values())
}

// ── Cursor sessions ────────────────────────────────────────────────────────────

function loadCursorSessions() {
  return resultsToProjects(readCursorSessions(), "cursor")
}

function loadCodexSessions() {
  if (!existsSync(CODEX_SESSIONS_ROOT)) return []
  return resultsToProjects(readCodexSessions(null, null), "codex")
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

// ── Openclaw sessions ──────────────────────────────────────────────────────────

function loadOpenclawSessions() {
  if (!existsSync(OPENCLAW_ROOT)) return []
  return resultsToProjects(readOpenclawSessions(null, null), "openclaw")
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

/** Fast broadcast from sidebar cache — avoids full JSONL scan on every file change. */
function broadcastProjectsFromCache() {
  if (sseClients.size === 0) return
  const projects = loadCachedSidebarState()
  if (!projects) return
  const sorted = mergeProjectsInto([], projects)
  for (const c of sseClients) {
    const payload =
      c.maxSessions != null && c.maxSessions > 0
        ? trimProjectsByRecentSessionCount(sorted, c.maxSessions)
        : sorted
    try {
      c.res.write(`event: projects\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      sseClients.delete(c)
    }
  }
}

async function broadcastProjects() {
  broadcastProjectsFromCache()
}

// Watch ~/.claude/projects for file changes; update search index for changed JSONL files.
function handleClaudeFileChange(filename) {
  if (!filename || !filename.endsWith(".jsonl")) { broadcastProjects(); return }
  // filename is relative: "<projectDir>/<sessionId>.jsonl"
  const parts = filename.split(/[\\/]/)
  if (parts.length < 2) { broadcastProjects(); return }
  const sessionId = parts[parts.length - 1].replace(".jsonl", "")
  const projectDir = parts.slice(0, -1).join("/")
  const projectPath = join(CLAUDE_DIR, projectDir)
  const fp = join(projectPath, `${sessionId}.jsonl`)
  if (!existsSync(fp)) {
    removeSession(projectPath, sessionId)
    lanceRemoveOne(projectPath, sessionId).catch(() => {})
    broadcastProjectsFromCache()
    return
  }
  try {
    const stat = statSync(fp)
    const names = loadConfig().names ?? {}
    const projectKey = projectDir
    const msgs = parseJsonl(fp)
    msgCache.set(`${projectPath}/${sessionId}`, msgs)
    const meta = claudeSessionMetaFromMsgs(msgs, sessionId, projectKey, names, stat)
    indexSession(projectPath, sessionId, msgs, meta)
    lanceIndexOne(projectPath, sessionId, msgs).catch(() => {})
    // Update sidebar cache so the next broadcast reflects new mtime + message count
    const projectDisplayName = encodedDirToDisplayName(projectDir)
    updateSidebarCacheEntry(sessionId, {
      projectPath,  // absolute path — matches what scanOneClaudeFolder uses
      projectDisplayName,
      source: "claude",
      messageCount: meta.messageCount,
      userMessageCount: meta.userMessageCount ?? null,
      firstName: meta.firstName ?? null,
      lastActivity: stat.mtime.toISOString(),
      mtime: stat.mtimeMs,
    })
    saveSidebarCache()
  } catch { /* ignore */ }
  broadcastProjectsFromCache()
}

try {
  watch(CLAUDE_DIR, { recursive: true }, (_evt, filename) => handleClaudeFileChange(filename))
} catch {
  setInterval(broadcastProjectsFromCache, 3000)
}

if (existsSync(CURSOR_PROJECTS_ROOT)) {
  try {
    watch(CURSOR_PROJECTS_ROOT, { recursive: true }, () => broadcastProjects())
  } catch { /* ignore */ }
}

if (existsSync(OPENCODE_DIR)) {
  try {
    watch(OPENCODE_DIR, { recursive: true }, () => broadcastProjects())
  } catch {
    try {
      watch(OPENCODE_DIR, () => broadcastProjects())
    } catch { /* ignore */ }
  }
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

// --- LanceDB background indexer ---
// Kick off after a short delay so the server is accepting requests first
if (ENABLE_BACKGROUND_INDEXER) {
  setTimeout(() => {
    console.log(`${ts()} [lancedb-indexer] startup timer fired`)
    const getCacheRows = () => loadSidebarCache().sessions.map(e => ({ projectPath: e.projectPath, sessionId: e.id }))
    console.log(`${ts()} [lancedb-indexer] cache rows:`, getCacheRows().length)
    startBackgroundIndexer(
      getCacheRows,
      (projectPath, sessionId) => getSessionMessagesAll(projectPath, sessionId)
    ).catch(err => console.warn(`${ts()} [lancedb-indexer] startup error:`, err.message))
  }, 3000)
} else {
  console.log(`${ts()} [lancedb-indexer] background indexing disabled; run 'npm run build-search-index' in a separate terminal`)
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
        "Set-Cookie": `auth_pin=${cookieVal}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
      })
      res.end(JSON.stringify({ ok: true }))
    } else {
      json({ ok: false }, 401)
    }
    return
  }

  // GET /api/capabilities — public bootstrap for SPA (must stay before cookie gate)
  if (url.pathname === "/api/capabilities") {
    const pinRequired = Boolean(AUTH_PIN)
    json({
      openPath: true,
      debugStream: true,
      pinRequired,
      // Include auth result so SPA can skip the /api/projects probe round-trip
      authed: pinRequired ? checkCookieAuth(req) : true,
      homeDir: homedir(),
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

  // GET /api/search/sessions?q= — hybrid LanceDB search, fallback to Fuse.js
  if (url.pathname === "/api/search/sessions") {
    const q = url.searchParams.get("q")?.trim() ?? ""
    if (!q) { json({ results: [] }); return }

    console.log(`${ts()} [search] q="${q}"`)
    const lanceResults = await searchSessions(q, 60).catch(e => { console.warn(`${ts()} [search] lancedb error:`, e.message); return null })
    if (lanceResults && lanceResults.length) {
      // Enrich with meta from the in-memory Fuse index
      const rowMap = new Map(getSearchRows().map(r => [`${r.projectPath}\x1f${r.sessionId}`, r]))
      const results = lanceResults.map(r => {
        const row = rowMap.get(`${r.projectPath}\x1f${r.sessionId}`)
        return {
          projectPath: r.projectPath,
          sessionId: r.sessionId,
          displayTitle: row?.displayTitle ?? r.sessionId.slice(0, 8),
          score: r.score,
          bestKey: "content",
          snippet: r.snippet,
          meta: row?.meta ?? {},
        }
      })
      console.log(`${ts()} [search] lancedb returned ${results.length} results`)
      json({ results, source: "lancedb" })
      return
    }

    // Fall back to Fuse.js
    const rows = getSearchRows()
    const results = runSidebarSessionSearch(q, rows)
    console.log(`${ts()} [search] fuse returned ${results.length} results (lanceResults=${lanceResults?.length ?? "null"})`)
    json({ results, source: "fuse" })
    return
  }

  // GET /api/search/thread?project=...&session=...&q= — in-thread LanceDB search
  if (url.pathname === "/api/search/thread") {
    const project = decodeURIComponent(url.searchParams.get("project") ?? "")
    const session = url.searchParams.get("session") ?? ""
    const q = url.searchParams.get("q")?.trim() ?? ""
    if (!q || !project || !session) { json({ hits: null }); return }
    const msgs = loadSessionMessages(project, session)
    if (!Array.isArray(msgs) || !msgs.length) { json({ hits: [] }); return }
    const hits = runThreadKeywordSearch(q, msgs, 60)
    json({ hits })
    return
  }

  // GET /api/search/status — index health
  if (url.pathname === "/api/search/status") {
    json({ indexer: getIndexerStatus(), backgroundIndexerEnabled: ENABLE_BACKGROUND_INDEXER })
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
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write(": connected\n\n")  // flush headers immediately so EventSource.onopen fires now
    if (maxSessions != null) {
      await streamRecentSidebarInitial(res, maxSessions)
    } else {
      const { projects, total } = await loadProjectsBundle(0)
      res.write(`event: projects_meta\ndata: ${JSON.stringify({ total })}\n\n`)
      res.write(`event: projects\ndata: ${JSON.stringify(projects)}\n\n`)
      res.write(`event: bootstrap_done\ndata: {}\n\n`)
    }
    const client = { res, maxSessions }
    sseClients.add(client)
    req.on("close", () => sseClients.delete(client))
    return
  }

  // GET /api/session-watch — SSE push for active session updates
  // Watches the underlying file for changes; pushes session_update events with new tail.
  if (url.pathname === "/api/session-watch") {
    if (!checkCookieAuth(req) && !checkHeaderAuth(req)) { res.writeHead(401); res.end(); return }
    const projectPath = url.searchParams.get("project") ?? ""
    const sessionId = url.searchParams.get("session") ?? ""
    const tailN = Math.min(parseInt(url.searchParams.get("tail") ?? "5") || 5, 100)
    if (!projectPath || !sessionId) { res.writeHead(400); res.end("Missing project/session"); return }

    // Resolve the watchable file path
    let watchFile = null
    if (projectPath.startsWith("openclaw:")) {
      watchFile = findOpenclawSessionFile(sessionId)
    } else if (projectPath.startsWith("codex:")) {
      watchFile = findCodexSessionFile(sessionId)
    } else if (!projectPath.startsWith("cursor:") && !projectPath.startsWith("cursor-agent:") &&
               !projectPath.startsWith("opencode:") && !projectPath.startsWith("hermes:") &&
               !projectPath.startsWith("antigravity:")) {
      // Claude JSONL
      const fp = projectPath.startsWith("/")
        ? join(projectPath, `${sessionId}.jsonl`)
        : join(CLAUDE_DIR, projectPath, `${sessionId}.jsonl`)
      if (existsSync(fp)) watchFile = fp
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write(": connected\n\n")

    if (!watchFile) {
      // Platform doesn't support file watching; client should fall back to polling
      res.write(`event: no_watch\ndata: {}\n\n`)
      req.on("close", () => {})
      return
    }

    let lastSize = 0
    try { lastSize = statSync(watchFile).size } catch { /* file may not exist yet */ }

    function pushUpdate() {
      try {
        const msgs = getSessionMessagesAll(projectPath, sessionId)
        if (!msgs) return
        // Invalidate cache so next read is fresh
        msgCache.delete(`${projectPath}/${sessionId}`)
        const fresh = getSessionMessagesAll(projectPath, sessionId)
        if (!fresh) return
        const tail = fresh.slice(-tailN)
        const payload = JSON.stringify({ msgs: tail, total: fresh.length })
        res.write(`event: session_update\ndata: ${payload}\n\n`)
      } catch { /* ignore */ }
    }

    // Send an initial snapshot immediately
    pushUpdate()

    let watcher = null
    let debounceTimer = null
    try {
      watcher = watch(watchFile, () => {
        clearTimeout(debounceTimer)
        // Small debounce: JSONL appends may fire multiple events per write
        debounceTimer = setTimeout(() => {
          try {
            const newSize = statSync(watchFile).size
            if (newSize === lastSize) return
            lastSize = newSize
            // Invalidate mem-cache so fresh parse picks up new lines
            msgCache.delete(`${projectPath}/${sessionId}`)
            pushUpdate()
          } catch { /* ignore */ }
        }, 50)
      })
    } catch {
      res.write(`event: no_watch\ndata: {}\n\n`)
    }

    req.on("close", () => {
      clearTimeout(debounceTimer)
      try { watcher?.close() } catch { /* ignore */ }
    })
    return
  }

  // GET /api/suggestions/:project/:id — KV-only feature; return empty list in local mode
  const suggestionsMatch = url.pathname.match(/^\/api\/suggestions\/([^/]+)\/([^/]+)$/)
  if (suggestionsMatch) { json([]); return }

  // GET /api/session/:project/:id[?tail=N&skip=M]
  // tail=N  → return last N messages (default: all)
  // skip=M  → skip M messages from the end before taking tail (for pagination)
  const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/)
  if (sessionMatch) {
    const reqT0 = performance.now()
    const projectPath = decodeURIComponent(sessionMatch[1])
    const sessionId = sessionMatch[2]
    const tailParam = url.searchParams.get("tail")
    const skipParam = url.searchParams.get("skip")
    const tail = tailParam ? Math.max(1, parseInt(tailParam) || 0) : 0
    const skip = skipParam ? Math.max(0, parseInt(skipParam) || 0) : 0
    const shortId = sessionId.slice(0, 8)
    const source = projectPath.split(":")[0] || "claude"

    function sliceMsgs(all) {
      const total = all.length
      if (!tail) return { msgs: all, total }
      const end = total - skip
      const start = Math.max(0, end - tail)
      return { msgs: all.slice(start, end > 0 ? end : 0), total }
    }

    function jsonPaged(all, loadLabel) {
      const { msgs, total } = sliceMsgs(all)
      const jsonStr = JSON.stringify(msgs)
      const totalMs = (performance.now() - reqT0).toFixed(1)
      console.log(`[perf] /api/session ${source}:${shortId} tail=${tail} skip=${skip} → ${msgs.length}/${total} msgs | load:${loadLabel} | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(total) })
      res.end(jsonStr)
    }

    // Cursor: push tail/skip into SQLite — avoids reading all bubbles for a tail fetch
    if (projectPath.startsWith("cursor:")) {
      const t0 = performance.now()
      const { msgs, total } = readCursorSessionMsgs(sessionId, { tail, skip })
      const ms = (performance.now() - t0).toFixed(1)
      const jsonStr = JSON.stringify(msgs)
      const totalMs = (performance.now() - reqT0).toFixed(1)
      console.log(`[perf] /api/session cursor:${shortId} tail=${tail} skip=${skip} → ${msgs.length}/${total} msgs | load:sqlite ${ms}ms | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(total) })
      res.end(jsonStr)
      return
    }
    // All platforms: check msgCache first (includes Claude sessions cached after first parse)
    const cacheKey = `${projectPath}/${sessionId}`
    if (msgCache.has(cacheKey)) { jsonPaged(msgCache.get(cacheKey), "mem-cache"); return }

    // Non-Claude platforms: on-demand read via platform-readers
    const isNonClaude = /^(opencode|codex|hermes|antigravity|cursor-agent|openclaw):/.test(projectPath)
    if (isNonClaude) {
      const t0ondemand = performance.now()
      const ondemand = loadSessionMessagesOndemand(projectPath, sessionId)
      const ondemandMs = (performance.now() - t0ondemand).toFixed(1)
      if (ondemand != null) {
        msgCache.set(cacheKey, ondemand)
        jsonPaged(ondemand, `ondemand ${ondemandMs}ms`)
        return
      }
      res.writeHead(404); res.end("Not Found"); return
    }

    // Claude Code: serve tail instantly from file end; background-parse full session into cache
    const fp = projectPath.startsWith("/")
      ? join(projectPath, `${sessionId}.jsonl`)
      : join(CLAUDE_DIR, projectPath, `${sessionId}.jsonl`)
    if (!existsSync(fp)) { res.writeHead(404); res.end("Not Found"); return }

    if (tail > 0 && skip === 0) {
      // Fast path: read tail from end + count lines without full JSON parse
      const tailMsgs = readJsonlTail(fp, tail)
      const lineTotal = countJsonlLines(fp)
      const jsonStr = JSON.stringify(tailMsgs)
      const totalMs = (performance.now() - reqT0).toFixed(1)
      console.log(`[perf] /api/session claude:${shortId} tail=${tail} → ${tailMsgs.length}/${lineTotal} msgs | load:jsonl-tail | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(lineTotal) })
      res.end(jsonStr)
      // Warm the full cache in the background so subsequent load-more requests are instant
      setImmediate(() => {
        if (!msgCache.has(cacheKey)) {
          const full = parseJsonl(fp)
          msgCache.set(cacheKey, full)
        }
      })
      return
    }

    // skip > 0 or tail=0: need full parse (load-earlier pagination)
    console.log(`[perf] /api/session claude:${shortId} — parsing JSONL (cold cache, skip=${skip})…`)
    const parsed = parseJsonl(fp)
    msgCache.set(cacheKey, parsed)
    jsonPaged(parsed, "jsonl-parse")
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

  // GET /api/raw-jsonl — serve raw JSONL file as text for in-browser viewing
  if (url.pathname.startsWith("/api/raw-jsonl")) {
    const project = url.searchParams.get("project")
    const session = url.searchParams.get("session")
    if (!project || !session) { json({ error: "Missing project or session" }, 400); return }
    const filePath = project.startsWith("/")
      ? join(project, `${session}.jsonl`)
      : join(CLAUDE_DIR, project, `${session}.jsonl`)
    try {
      const content = readFileSync(filePath, "utf8")
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      res.end(content)
    } catch (err) {
      json({ error: err.message }, 404)
    }
    return
  }

  // POST /api/open — open any local file/path in the OS default viewer
  if (url.pathname === "/api/open" && req.method === "POST") {
    const filePath = url.searchParams.get("path")
    if (!filePath) { json({ error: "Missing path" }, 400); return }
    exec(`open "${filePath.replace(/"/g, '\\"')}"`, (err) => {
      if (err) json({ error: err.message }, 500)
      else json({ ok: true })
    })
    return
  }

  // GET /api/open-path
  if (url.pathname.startsWith("/api/open-path")) {
    const project = url.searchParams.get("project")
    const session = url.searchParams.get("session")
    if (!project || !session) { json({ error: "Missing project or session" }, 400); return }
    const filePath = project.startsWith("/")
      ? join(project, `${session}.jsonl`)
      : join(CLAUDE_DIR, project, `${session}.jsonl`)
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

function shutdown() {
  for (const client of sseClients) { try { client.res.destroy() } catch { /* ignore */ } }
  sseClients.clear()
  server.close(() => process.exit(0))
  // Force exit if graceful close stalls (open keep-alive connections)
  setTimeout(() => process.exit(0), 1000).unref()
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)

const BIND_HOST = process.env.HOST ?? "127.0.0.1"
server.listen(PORT, BIND_HOST, () => {
  const displayHost = BIND_HOST === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : "localhost"
  console.log(`${ts()} \n  Agent Session Viewer (local mode)`)
  console.log(`${ts()}   API:      http://localhost:${PORT} (bound to ${displayHost})`)
  if (existsSync(DIST_DIR)) {
    console.log(`${ts()}   App:      http://localhost:${PORT}`)
  } else {
    console.log(`${ts()}   Frontend: run 'npm run dev' in another terminal (Vite proxies to this port)`)
  }
  if (!AUTH_PIN) {
    console.log(`${ts()}   Auth:     disabled (set AUTH_PIN=1234 to enable)\n`)
  } else {
    console.log(`${ts()}   Auth:     PIN protected\n`)
  }
})
