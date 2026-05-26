/**
 * Local server — full replacement for the Cloudflare Worker.
 * Reads ~/.claude/projects/ directly; no Cloudflare account needed.
 *
 * Run via: npm run local
 * Config persisted to: ~/.claude/agent-session-viewer-local.json
 */

import { createReadStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { basename, dirname, extname, join, sep } from "path"
import http from "http"
import https from "https"
import { fileURLToPath } from "url"
import { Worker } from "worker_threads"
import { exec, execFileSync, execSync, spawnSync } from "child_process"
import { stripXml, trimProjectsByRecentSessionCount, countSessionsInProjects } from "./shared-utils.mjs"
import { loadSessionMessages } from "./lib/session-message-loader.mjs"
import { isOnDemandSessionPlatform } from "./lib/session-platform-routing.mjs"
import { normalizeCodexRateLimit, normalizeResetTime, resetDescription } from "./lib/usage-window-normalizer.mjs"
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
  readGeminiSessions,
  readGeminiSessionMsgs,
  GEMINI_TMP_ROOT,
} from "./platform-readers.mjs"
import { buildSidebarSearchDoc, runSidebarSessionSearch, runThreadKeywordSearch } from "./lib/session-search-core.mjs"
import { indexSession, removeSession, getSearchRows } from "./lib/search-index.mjs"
import { rgGlobalSearch } from "./lib/rg-search.mjs"
import { contentSearch } from "./lib/content-search.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env file from project root (if not already set in environment)
try {
  const envFile = join(__dirname, ".env")
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
    }
  }
} catch {}

const PLATFORM_LOADER_WORKER = join(__dirname, "lib", "platform-loader-worker.mjs")

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const APP_CONFIG_DIR = join(homedir(), ".config", "agent-session-viewer")
const CONFIG_FILE = join(APP_CONFIG_DIR, "config.json")
const SIDEBAR_CACHE_FILE = join(APP_CONFIG_DIR, "sidebar-cache.json")

function wallClock() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  })
}

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

  // gemini: absolute path
  if (projectPath.startsWith("gemini:")) {
    const p = projectPath.slice(7)
    if (p.startsWith("/")) return p
    // fall through to legacy encoded path handling
  }

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
const ENABLE_BACKGROUND_INDEXER = false // LanceDB removed; rg handles global search

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
let _sidebarCacheMtime = null

function seedSearchIndexFromSidebarCache(cache) {
  if (!cache?.sessions?.length) return
  for (const entry of cache.sessions) {
    indexSession(entry.projectPath, entry.id, [], {
      id: entry.id,
      customName: entry.customName ?? null,
      firstName: entry.firstName ?? null,
      source: entry.source ?? "claude",
    })
  }
}

// Cache shape v2: { v: 2, sessions: CacheEntry[] } sorted by lastActivity desc.
// CacheEntry: { id, projectPath, projectDisplayName, source, messageCount, userMessageCount,
//               firstName, lastActivity, mtime, customName? }
// Loaded once into memory; a Map index is built for O(1) lookup by sessionId.

function loadSidebarCache() {
  let fileMtime = null
  try {
    fileMtime = statSync(SIDEBAR_CACHE_FILE).mtimeMs
  } catch {
    fileMtime = null
  }
  if (_sidebarCache && _sidebarCacheMtime === fileMtime) return _sidebarCache
  try {
    const raw = JSON.parse(readFileSync(SIDEBAR_CACHE_FILE, "utf8"))
    _sidebarCache = raw
    _sidebarCache._map = new Map(_sidebarCache.sessions.map(e => [e.id, e]))
    _sidebarCacheMtime = fileMtime
    seedSearchIndexFromSidebarCache(_sidebarCache)
    console.log(`${ts()} [sidebar-cache] loaded ${_sidebarCache.sessions.length} sessions`)
  } catch {
    _sidebarCache = { v: 2, sessions: [], _map: new Map() }
    _sidebarCacheMtime = fileMtime
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
      ...(e.isSidechain ? { isSidechain: true, parentSessionId: e.parentSessionId, agentType: e.agentType } : {}),
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
function updateSidebarCacheEntry(sessionId, { projectPath, projectDisplayName, source, messageCount, userMessageCount, firstName, lastActivity, mtime, customName, isSidechain, parentSessionId, agentType }) {
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
    ...(isSidechain ? { isSidechain: true, parentSessionId, agentType } : {}),
  }
  if (existing) {
    Object.assign(existing, entry)
  } else {
    cache.sessions.push(entry)
    cache._map.set(sessionId, entry)
  }
  indexSession(entry.projectPath, entry.id, [], {
    id: entry.id,
    customName: entry.customName ?? null,
    firstName: entry.firstName ?? null,
    source: entry.source ?? "claude",
  })
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
    ...loadGeminiSessions(),
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
  return new Promise(r => setTimeout(r, 0))
}

/** Parse and index every Claude JSONL under `fileBySessKey` (yields so the event loop stays responsive). */
async function backgroundIndexAllClaudeJsonl(fileBySessKey, names) {
  let i = 0
  let cacheDirty = false
  const cache = loadSidebarCache()
  const _tBatch0 = performance.now()
  let _batchParseMs = 0
  for (const [sessKey, { fp, stat }] of fileBySessKey) {
    const sep = sessKey.indexOf("\x1f")
    if (sep === -1) continue
    const projectPath = sessKey.slice(0, sep)
    const sessionId = sessKey.slice(sep + 1)
    try {
      const _tp = performance.now()
      const msgs = parseJsonl(fp)
      _batchParseMs += performance.now() - _tp
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
      console.log(`[perf ${wallClock()}] backgroundIndex batch i=${i} batchParseMs=${_batchParseMs.toFixed(0)} batchTotalMs=${(performance.now()-_tBatch0).toFixed(0)}`)
      _batchParseMs = 0
      if (cacheDirty) { saveSidebarCache(); cacheDirty = false }
      await yieldEventLoopTick()
    }
  }
  console.log(`[perf ${wallClock()}] backgroundIndex done i=${i} totalMs=${(performance.now()-_tBatch0).toFixed(0)}`)
  if (cacheDirty) saveSidebarCache()
}

function scheduleClaudeJsonlIndexing(fileBySessKey, names) {
  setImmediate(async () => {
    await backgroundIndexAllClaudeJsonl(fileBySessKey, names)
  })
}

/**
 * Load one platform in a dedicated worker thread.
 * Returns a Promise that resolves to { platform, projects } when the worker finishes.
 * The worker runs in its own V8 isolate, so blocking I/O never stalls the main thread.
 */
function loadPlatformInWorker(platform) {
  return new Promise((resolve) => {
    const worker = new Worker(PLATFORM_LOADER_WORKER, { workerData: { platform } })
    worker.once("message", ({ platform: p, sessions = [], error }) => {
      if (error) console.error(`[platform-worker] ${p}: ${error}`)
      const projects = resultsToProjects(sessions, p)
      resolve({ platform: p, projects })
    })
    worker.once("error", err => {
      console.error(`[platform-worker] ${platform} worker error:`, err.message)
      resolve({ platform, projects: [] })
    })
  })
}

/** Progressive recent sidebar: emit cached state + bootstrap_done immediately, then fill in background. */
async function streamRecentSidebarInitial(res, maxSessions) {
  // Emit cached sidebar state and signal bootstrap done immediately — UI is interactive from the start.
  const cachedState = loadCachedSidebarState()
  if (cachedState?.length) {
    const merged = mergeProjectsInto([], cachedState)
    const cachedTotal = countSessionsInProjects(merged)
    const trimmed = maxSessions > 0 && cachedTotal > maxSessions
      ? trimProjectsByRecentSessionCount(merged, maxSessions)
      : merged
    sseWrite(res, "projects", trimmed)
    sseWrite(res, "projects_meta", { total: cachedTotal })
  }
  sseWrite(res, "bootstrap_done", {})

  // Everything after this runs in background — doesn't block HTTP request processing.
  setImmediate(async () => {
    const _tBg0 = performance.now()
    console.log(`[perf ${wallClock()}] streamRecent bg-start`)
    const names = loadConfig().names ?? {}
    /** @type {Map<string, { fp: string, stat: import('fs').Stats }>} */
    const fileBySessKey = new Map()
    let acc = []

    // Helper: emit projects trimmed to maxSessions, with full total in meta
    const emitProjects = (projects) => {
      const total = countSessionsInProjects(projects)
      const payload = maxSessions > 0 && total > maxSessions
        ? trimProjectsByRecentSessionCount(projects, maxSessions)
        : projects
      sseWrite(res, "projects", payload)
      sseWrite(res, "projects_meta", { total })
    }

    // Launch all platform workers immediately so they run concurrently with the Claude scan.
    const PLATFORMS = ["codex", "gemini", "opencode", "hermes", "openclaw", "cursor", "cursor-agent", "antigravity"]
    const _platformT0 = performance.now()
    // pendingWorkers: Map<platform, Promise<{platform, projects}>>
    const pendingWorkers = new Map(
      PLATFORMS.map(p => [p, loadPlatformInWorker(p)])
    )

    // Track which worker results have already been merged (in case they arrive during Claude scan)
    const merged = new Set()
    const mergeReady = () => {
      for (const [p, promise] of pendingWorkers) {
        if (merged.has(p)) continue
        // Check if already settled — attach a then() that fires when ready
        promise.then(({ platform, projects }) => {
          if (merged.has(platform) || res.destroyed) return
          merged.add(platform)
          const ms = (performance.now() - _platformT0).toFixed(0)
          console.log(`[perf ${wallClock()}] platform-worker ${platform}: ${ms}ms → ${projects.length} projects`)
          if (!projects.length) return
          flushSidebarCacheFromProjects(projects, null)
          acc = mergeProjectsInto(acc, projects)
          emitProjects(sortProjectGroups(acc))
        })
      }
    }
    mergeReady()

    // Claude scan on main thread: cheap stat-only, streams a folder at a time
    for (const { path: root, label } of getClaudeScanRoots()) {
      if (res.destroyed) break
      let dirs
      try { dirs = readdirSync(root) } catch { continue }
      for (const dir of dirs) {
        if (res.destroyed) break
        const chunk = scanOneClaudeFolder(root, label, dir, names, fileBySessKey)
        if (!chunk) continue
        acc = mergeProjectsInto(acc, [chunk])
        emitProjects(sortProjectGroups(acc))
        await yieldEventLoopTick()
      }
    }
    console.log(`[perf ${wallClock()}] streamRecent claude-scan done: ${(performance.now()-_tBg0).toFixed(0)}ms, ${fileBySessKey.size} sessions`)

    // Wait for all platform workers, streaming any that haven't arrived yet
    for (const promise of pendingWorkers.values()) {
      if (res.destroyed) break
      const { platform, projects } = await promise
      if (merged.has(platform)) continue  // already streamed via mergeReady()
      merged.add(platform)
      const ms = (performance.now() - _platformT0).toFixed(0)
      console.log(`[perf ${wallClock()}] platform-worker ${platform} (late): ${ms}ms → ${projects.length} projects`)
      if (!projects.length) continue
      flushSidebarCacheFromProjects(projects, null)
      acc = mergeProjectsInto(acc, projects)
      emitProjects(sortProjectGroups(acc))
      await yieldEventLoopTick()
    }

    // Hydrate full metadata (message counts, accurate firstName) for the most recent Claude sessions.
    const hydrateN = maxSessions ?? 50
    const forHydration = hydrateN > 0
      ? trimProjectsByRecentSessionCount(acc, hydrateN)
      : sortProjectGroups(acc)
    const _tHydrate = performance.now()
    await hydrateClaudeSessionsInProjects(forHydration, fileBySessKey, names)
    console.log(`[perf ${wallClock()}] streamRecent hydrate done: ${(performance.now()-_tHydrate).toFixed(0)}ms`)
    flushSidebarCacheFromProjects(forHydration, fileBySessKey)
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
    if (!res.destroyed) emitProjects(sortProjectGroups(acc))

    scheduleClaudeJsonlIndexing(fileBySessKey, names)
  }) // end setImmediate
}

async function hydrateClaudeSessionsInProjects(projects, fileBySessKey, names) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i]
      if (s.source !== "claude") continue
      const rec = fileBySessKey.get(SESS_PATH_KEY(p.path, s.id))
      if (!rec) continue
      const cacheKey = `${p.path}/${s.id}`
      // If already in msgCache (e.g. user clicked the session), do full meta from msgs
      if (msgCache.has(cacheKey)) {
        p.sessions[i] = claudeSessionMetaFromMsgs(msgCache.get(cacheKey), s.id, s.projectPath, names, rec.stat)
      } else if (s.firstName) {
        // firstName already known (cached or cheap-read during scan) — just count lines, no full parse
        p.sessions[i] = {
          ...s,
          messageCount: countJsonlLines(rec.fp),
          customName: names[`${s.projectPath}/${s.id}`] ?? s.customName ?? null,
        }
      } else {
        // Need firstName: parse the full file and cache it for session-view reuse
        const msgs = parseJsonl(rec.fp)
        msgCache.set(cacheKey, msgs)
        p.sessions[i] = claudeSessionMetaFromMsgs(msgs, s.id, s.projectPath, names, rec.stat)
      }
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
    ...loadGeminiSessions(),
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
  const shared = loadSessionMessages(projectPath, sessionId)
  if (Array.isArray(shared)) return shared

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
  if (projectPath.startsWith("gemini:")) {
    const { msgs } = readGeminiSessionMsgs(sessionId)
    return Array.isArray(msgs) ? msgs : null
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return Math.ceil(text.length / 4)
}

function contentText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      if (typeof block.text === "string") return block.text
      if (typeof block.thinking === "string") return block.thinking
      return JSON.stringify(block)
    }).filter(Boolean).join("\n")
  }
  if (content == null) return ""
  return JSON.stringify(content)
}

function addTokens(map, name, tokens, kind) {
  if (!tokens) return
  const existing = map.get(name) ?? { name, tokens: 0, kind }
  existing.tokens += tokens
  map.set(name, existing)
}

function buildGenericContextSnapshot(projectPath, sessionId, msgs) {
  const components = new Map()
  const source = projectPath.split(":")[0] || "claude"
  let firstUser = ""
  let lastActivity = ""
  let messageCount = 0

  for (const msg of msgs ?? []) {
    if (!msg || msg.type === "file-history-snapshot") continue
    messageCount += 1
    if (msg.timestamp) lastActivity = String(msg.timestamp)

    const role = msg.message?.role ?? (msg.type === "human" || msg.type === "user" ? "user" : msg.type)
    const content = msg.message?.content ?? msg.data ?? msg.toolUseResult ?? msg
    const text = contentText(content)
    const tokens = estimateTokens(text)
    if (!firstUser && (role === "user" || msg.type === "human")) firstUser = text.trim()

    if (Array.isArray(msg.message?.content)) {
      let toolTokens = 0
      let thinkingTokens = 0
      let textTokens = 0
      for (const block of msg.message.content) {
        if (block?.type === "tool_use" || block?.type === "tool_result") toolTokens += estimateTokens(block)
        else if (block?.type === "thinking") thinkingTokens += estimateTokens(block)
        else textTokens += estimateTokens(block)
      }
      if (role === "user") addTokens(components, "User Messages", textTokens || tokens, "conversation")
      else if (role === "assistant") addTokens(components, "Assistant Text", textTokens || tokens, "conversation")
      else addTokens(components, "Other Messages", textTokens || tokens, "metadata")
      addTokens(components, "Tool Use + Results", toolTokens, "tools")
      addTokens(components, "Thinking Blocks", thinkingTokens, "thinking")
      continue
    }

    if (role === "user" || msg.type === "human") addTokens(components, "User Messages", tokens, "conversation")
    else if (role === "assistant") addTokens(components, "Assistant Messages", tokens, "conversation")
    else if (String(msg.type).includes("tool")) addTokens(components, "Tool Use + Results", tokens, "tools")
    else if (msg.type === "progress" || msg.type === "system") addTokens(components, "Progress + System", tokens, "metadata")
    else addTokens(components, "Other Messages", tokens, "metadata")
  }

  const list = [...components.values()].sort((a, b) => b.tokens - a.tokens)
  const estimatedInput = list.reduce((sum, item) => sum + item.tokens, 0)
  return {
    platform: source,
    projectPath,
    sessionId,
    title: firstUser ? firstUser.replace(/\s+/g, " ").slice(0, 110) : sessionId,
    lastActivity,
    messageCount,
    modelContextWindow: null,
    inputTokens: estimatedInput,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    components: list,
    basisLabel: "Estimated transcript tokens",
    accuracyNote: "This platform does not expose Codex-style context-window counters in the local transcript. Values are transcript-token estimates using characters/4.",
  }
}

function classifyCodexDeveloperBlock(text) {
  if (text.startsWith("<skills_instructions>")) return "Skills Manifest"
  if (text.startsWith("<apps_instructions>")) return "Apps Instructions"
  if (text.startsWith("<plugins_instructions>")) return "Plugins Instructions"
  if (text.startsWith("<permissions instructions>")) return "Permissions"
  if (text.startsWith("<collaboration_mode>")) return "Collaboration Mode"
  if (text.startsWith("## Memory")) return "Memory Policy"
  if (text.startsWith("# Instructions") || text.slice(0, 300).includes("You are Codex")) return "Developer Runtime Rules"
  return "Developer Other"
}

function buildCodexContextSnapshot(projectPath, sessionId) {
  const fp = findCodexSessionFile(sessionId)
  if (!fp) return null
  const rows = parseJsonl(fp)
  const components = new Map()
  let lastTokenInfo = null
  let firstUser = ""
  let meta = {}
  let messageCount = 0
  let skillEntries = 0

  for (const row of rows) {
    const payload = row.payload ?? {}
    if (row.type === "session_meta") {
      meta = payload
      const base = payload.base_instructions?.text ?? ""
      addTokens(components, "Base Instructions", estimateTokens(base), "system")
      continue
    }
    if (row.type === "event_msg" && payload.type === "token_count") {
      lastTokenInfo = payload.info
      continue
    }
    if (row.type !== "response_item") continue
    if (payload.type === "message") {
      messageCount += 1
      const blocks = Array.isArray(payload.content) ? payload.content : []
      const text = blocks.map(block => block?.text ?? "").filter(Boolean).join("\n")
      if (payload.role === "developer") {
        for (const block of blocks) {
          const blockText = block?.text ?? ""
          const label = classifyCodexDeveloperBlock(blockText)
          addTokens(components, label, estimateTokens(blockText), "developer")
          if (label === "Skills Manifest") {
            skillEntries = blockText.split("\n").filter(line => line.startsWith("- ") && line.includes("(file:")).length
          }
        }
      } else if (payload.role === "user") {
        if (!firstUser && !text.trim().startsWith("# AGENTS.md instructions")) firstUser = text.trim()
        addTokens(components, "User Messages", estimateTokens(text), "conversation")
      } else if (payload.role === "assistant") {
        addTokens(components, "Assistant Messages", estimateTokens(text), "conversation")
      }
    } else if (payload.type === "function_call" || payload.type === "function_call_output" || payload.type === "custom_tool_call") {
      addTokens(components, "Tool Calls + Outputs", estimateTokens(payload), "tools")
    } else if (payload.type === "reasoning") {
      addTokens(components, "Reasoning Items", estimateTokens(payload.summary ?? payload.content ?? ""), "thinking")
    }
  }

  const usage = lastTokenInfo?.last_token_usage ?? {}
  const windowTokens = Number(lastTokenInfo?.model_context_window ?? 0) || null
  const inputTokens = Number(usage.input_tokens ?? 0) || [...components.values()].reduce((sum, item) => sum + item.tokens, 0)
  const list = [...components.values()].sort((a, b) => b.tokens - a.tokens)
  return {
    platform: "codex",
    projectPath,
    sessionId,
    title: (firstUser || meta.cwd || sessionId).replace(/\s+/g, " ").slice(0, 110),
    lastActivity: meta.timestamp ?? "",
    messageCount,
    modelContextWindow: windowTokens,
    inputTokens,
    cachedInputTokens: Number(usage.cached_input_tokens ?? 0) || null,
    outputTokens: Number(usage.output_tokens ?? 0) || null,
    reasoningTokens: Number(usage.reasoning_output_tokens ?? 0) || null,
    components: list,
    skillEntries,
    skillTokens: list.find(item => item.name === "Skills Manifest")?.tokens ?? 0,
    basisLabel: windowTokens ? "Recorded Codex context window" : "Estimated transcript tokens",
    accuracyNote: windowTokens
      ? "Codex input/window totals are taken from the latest token_count event. Component buckets are estimated from the visible transcript content."
      : "No token_count event was found; values are estimated from transcript content.",
  }
}

function buildContextSnapshot(projectPath, sessionId) {
  if (projectPath.startsWith("codex:")) {
    const codex = buildCodexContextSnapshot(projectPath, sessionId)
    if (codex) return codex
  }
  const msgs = getSessionMessagesAll(projectPath, sessionId)
  if (!Array.isArray(msgs)) return null
  return buildGenericContextSnapshot(projectPath, sessionId, msgs)
}

function renderContextSnapshotHtml(snapshot) {
  const basis = snapshot.modelContextWindow || snapshot.inputTokens || 1
  const usedPct = snapshot.modelContextWindow ? (snapshot.inputTokens / snapshot.modelContextWindow) * 100 : 100
  const remaining = snapshot.modelContextWindow ? Math.max(0, snapshot.modelContextWindow - snapshot.inputTokens) : null
  const colors = { system: "#1e3a5f", developer: "#d97706", conversation: "#059669", tools: "#0f766e", thinking: "#be123c", metadata: "#64748b", remaining: "#d8d2c4" }
  const rows = snapshot.components.map(c => {
    const pctBasis = (c.tokens / basis) * 100
    const pctInput = snapshot.inputTokens ? (c.tokens / snapshot.inputTokens) * 100 : 0
    const color = colors[c.kind] ?? colors.metadata
    return `<tr><td><span class="name"><span class="swatch" style="background:${color}"></span>${escapeHtml(c.name)}</span></td><td>${c.tokens.toLocaleString()}</td><td>${pctBasis.toFixed(pctBasis < 10 ? 2 : 1)}%</td><td>${pctInput.toFixed(pctInput < 10 ? 2 : 1)}%</td><td><div class="bar"><span style="width:${Math.min(100, pctInput)}%;background:${color}"></span></div></td></tr>`
  }).join("")
  const segments = snapshot.components.map(c => {
    const width = Math.max(0.05, (c.tokens / basis) * 100)
    const color = colors[c.kind] ?? colors.metadata
    return `<span style="width:${width}%;background:${color}" title="${escapeHtml(c.name)}: ${c.tokens.toLocaleString()}"></span>`
  }).join("") + (remaining != null ? `<span style="width:${Math.max(0, 100 - usedPct)}%;background:${colors.remaining}" title="Remaining"></span>` : "")
  const skillBudget = snapshot.modelContextWindow ? Math.round(snapshot.modelContextWindow * 0.02) : null
  const skillPct = skillBudget ? (snapshot.skillTokens ?? 0) / skillBudget * 100 : null

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(snapshot.title)} - context snapshot</title>
<style>
:root{--bg:#f6f4ef;--surface:#fffdf8;--surface2:#ebe6da;--text:#1d2521;--dim:#66716b;--border:rgba(29,37,33,.13);--shadow:0 18px 50px rgba(29,37,33,.09)}
*{box-sizing:border-box}body{margin:0;color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(rgba(29,37,33,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(29,37,33,.035) 1px,transparent 1px),radial-gradient(circle at 8% 0%,rgba(217,119,6,.13),transparent 34rem),radial-gradient(circle at 92% 0%,rgba(5,150,105,.12),transparent 32rem),var(--bg);background-size:24px 24px,24px 24px,auto,auto,auto}
main{width:min(1320px,calc(100vw - 32px));margin:0 auto;padding:28px 0 44px}.hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);gap:18px;margin-bottom:18px}.panel{background:color-mix(in srgb,var(--surface) 94%,transparent);border:1px solid var(--border);box-shadow:var(--shadow);border-radius:8px;padding:22px}.eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dim);text-transform:uppercase}.title{font-size:clamp(32px,5vw,66px);line-height:.98;margin:12px 0 18px;letter-spacing:0}.sub{color:var(--dim);line-height:1.55;margin:0}.meter{height:28px;border-radius:999px;overflow:hidden;background:var(--surface2);border:1px solid var(--border);display:flex}.meter span{height:100%;min-width:1px}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:18px}.kpi{border:1px solid var(--border);background:rgba(255,253,248,.72);border-radius:8px;padding:16px}.label{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dim);text-transform:uppercase}.value{margin-top:8px;font-size:28px;font-weight:750}.grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(320px,.75fr);gap:18px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:12px 10px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left;white-space:normal}th{color:var(--dim);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;text-transform:uppercase}.name{display:flex;gap:8px;align-items:center;font-weight:650}.swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}.bar{height:8px;border-radius:999px;background:var(--surface2);overflow:hidden;min-width:110px}.bar span{display:block;height:100%;border-radius:999px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);font-size:12px;line-height:1.55;overflow-wrap:anywhere}.note{margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}@media(max-width:920px){.hero,.grid,.kpis{grid-template-columns:1fr}}
</style></head><body><main>
<section class="hero"><div class="panel"><div class="eyebrow">${escapeHtml(snapshot.platform)} context snapshot</div><h1 class="title">${escapeHtml(snapshot.title)}</h1><p class="sub">${escapeHtml(snapshot.basisLabel)} for ${escapeHtml(snapshot.projectPath)} / ${escapeHtml(snapshot.sessionId)}.</p></div><div class="panel"><div class="meter">${segments}</div><p class="mono note">${escapeHtml(snapshot.accuracyNote)}</p></div></section>
<section class="kpis">
<div class="kpi"><div class="label">${snapshot.modelContextWindow ? "Input Used" : "Estimated Tokens"}</div><div class="value">${snapshot.modelContextWindow ? `${usedPct.toFixed(1)}%` : snapshot.inputTokens.toLocaleString()}</div></div>
<div class="kpi"><div class="label">Window</div><div class="value">${snapshot.modelContextWindow ? snapshot.modelContextWindow.toLocaleString() : "n/a"}</div></div>
<div class="kpi"><div class="label">Remaining</div><div class="value">${remaining != null ? remaining.toLocaleString() : "n/a"}</div></div>
<div class="kpi"><div class="label">Messages</div><div class="value">${snapshot.messageCount.toLocaleString()}</div></div>
</section>
<section class="grid"><div class="panel"><h2>Component Breakdown</h2><table><thead><tr><th>Component</th><th>Tokens</th><th>% Basis</th><th>% Input</th><th>Scale</th></tr></thead><tbody>${rows}</tbody></table></div>
<aside class="panel"><h2>Details</h2><p class="mono">Input tokens: ${snapshot.inputTokens.toLocaleString()}<br>Cached input: ${snapshot.cachedInputTokens == null ? "n/a" : snapshot.cachedInputTokens.toLocaleString()}<br>Output tokens: ${snapshot.outputTokens == null ? "n/a" : snapshot.outputTokens.toLocaleString()}<br>Reasoning output: ${snapshot.reasoningTokens == null ? "n/a" : snapshot.reasoningTokens.toLocaleString()}<br>Skills budget: ${skillBudget == null ? "n/a" : `${(snapshot.skillTokens ?? 0).toLocaleString()} / ${skillBudget.toLocaleString()} (${skillPct.toFixed(1)}%)`}<br>Skill entries: ${snapshot.skillEntries ?? "n/a"}<br>Generated: ${escapeHtml(new Date().toISOString())}</p></aside></section>
</main></body></html>`
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

function loadGeminiSessions() {
  if (!existsSync(GEMINI_TMP_ROOT)) return []
  return resultsToProjects(readGeminiSessions(null, null), "gemini")
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

function isLocalRequest(req) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "")
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

function checkCookieAuth(req) {
  if (!AUTH_PIN || isLocalRequest(req)) return true
  const cookie = req.headers.cookie ?? ""
  const match = cookie.match(/(?:^|;\s*)auth_pin=([^;]+)/)
  return match?.[1] === AUTH_PIN
}

function checkHeaderAuth(req) {
  if (!AUTH_PIN || isLocalRequest(req)) return true
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
    // lancedb removed
    broadcastProjectsFromCache()
    return
  }
  try {
    const _t0 = performance.now()
    const stat = statSync(fp)
    const names = loadConfig().names ?? {}
    const projectKey = projectDir
    const msgs = parseJsonl(fp)
    const _tParse = performance.now()
    msgCache.set(`${projectPath}/${sessionId}`, msgs)
    const meta = claudeSessionMetaFromMsgs(msgs, sessionId, projectKey, names, stat)
    const _tMeta = performance.now()
    indexSession(projectPath, sessionId, msgs, meta)
    // lancedb removed
    const _tIndex = performance.now()
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
    const _tSave = performance.now()
    if (_tSave - _t0 > 20) {
      console.log(`[perf ${wallClock()}] handleClaudeFileChange ${sessionId.slice(0,8)} parse:${(_tParse-_t0).toFixed(1)}ms meta:${(_tMeta-_tParse).toFixed(1)}ms index:${(_tIndex-_tMeta).toFixed(1)}ms save:${(_tSave-_tIndex).toFixed(1)}ms total:${(_tSave-_t0).toFixed(1)}ms msgs:${msgs.length}`)
    }
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
  
  // Explicitly gate index.html if a PIN is required but not provided via cookie
  if (basename(filePath) === "index.html" && AUTH_PIN && !checkCookieAuth(req)) {
    // We still serve index.html because the React app will show PinGate based on /api/capabilities result.
    // However, if we wanted to be even stricter, we could serve a different small HTML here.
    // Let's stick to the current SPA-based gating but ensure /api/capabilities is correct.
  }
  
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" })
  createReadStream(filePath).pipe(res)
}

function triggerBackgroundIndexer() { /* lancedb removed */ }

// --- Event-loop lag detector (temporary debug) ---
{
  let _lastHb = Date.now()
  setInterval(() => {
    const now = Date.now()
    const lag = now - _lastHb - 500
    if (lag > 200) console.log(`[perf ${wallClock()}] ⚠ event-loop lag ${lag}ms`)
    _lastHb = now
  }, 500).unref()
}

// --- HTTP server ---

// ── Usage limits fetcher ──────────────────────────────────────────────────────

function readCursorAuth() {
  const vscdb = join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
  if (existsSync(vscdb)) {
    try {
      const tmpScript = join(tmpdir(), "_cursor_auth.py")
      writeFileSync(tmpScript, [
        "import sqlite3,base64,json",
        `con=sqlite3.connect(${JSON.stringify(vscdb)})`,
        `row=con.execute("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'").fetchone()`,
        "t=row[0] if row else ''",
        "parts=t.split('.')",
        "p=json.loads(base64.urlsafe_b64decode(parts[1]+'===')) if len(parts)>1 else {}",
        "print(json.dumps({'token':t,'userId':p.get('sub','')}))",
      ].join("\n"))
      const out = execSync(`python3 "${tmpScript}"`, { encoding: "utf8" }).trim()
      const { token, userId } = JSON.parse(out)
      if (token && userId) return { token, userId }
    } catch {}
  }
  const token  = process.env.CURSOR_ACCESS_TOKEN ?? ""
  const userId = process.env.CURSOR_USER_ID ?? ""
  if (token && userId) return { token, userId }
  return null
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1] + "==="
    return JSON.parse(Buffer.from(payload, "base64url").toString())
  } catch { return {} }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function settleUsage(name, promise, timeoutMs = 30000) {
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} usage timed out`)), timeoutMs)),
    ])
  } catch (e) {
    return { error: e?.message ?? String(e) }
  }
}

async function fetchCursorUsage() {
  const auth = readCursorAuth()
  if (!auth) return { error: "No Cursor auth found" }

  const { token, userId } = auth
  const baseHeaders = { "User-Agent": "cursor-usage-tracker/1.1", Accept: "application/json" }
  const authHeaders = { ...baseHeaders, Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${token}` }

  // /api/usage-summary is the primary endpoint (richer than /api/usage)
  const [summaryR, meR] = await Promise.allSettled([
    fetchWithTimeout("https://cursor.com/api/usage-summary", { headers: authHeaders }),
    fetchWithTimeout("https://cursor.com/api/auth/me", { headers: authHeaders }),
  ])

  const result = { fetchedAt: Date.now() }

  if (summaryR.status === "fulfilled" && summaryR.value.ok) {
    const s = await summaryR.value.json().catch(() => null)
    if (s) {
      result.usageSummary = {
        membershipType: s.membershipType,
        limitType: s.limitType,
        isUnlimited: s.isUnlimited,
        billingCycleStart: s.billingCycleStart,
        billingCycleEnd: s.billingCycleEnd,
        plan: s.individualUsage?.plan ? {
          autoPercentUsed: s.individualUsage.plan.autoPercentUsed,
          apiPercentUsed: s.individualUsage.plan.apiPercentUsed,
          totalPercentUsed: s.individualUsage.plan.totalPercentUsed,
          used: s.individualUsage.plan.used,
          limit: s.individualUsage.plan.limit,
          remaining: s.individualUsage.plan.remaining,
        } : null,
        onDemand: s.individualUsage?.onDemand ? {
          enabled: s.individualUsage.onDemand.enabled,
          used: s.individualUsage.onDemand.used,
          limit: s.individualUsage.onDemand.limit,
          remaining: s.individualUsage.onDemand.remaining,
        } : null,
      }
      // Also populate legacy `stripe` shape for backward compat with CursorCard
      result.stripe = { membershipType: s.membershipType }
    }
  } else {
    // Fallback: legacy endpoints
    const [uR, sR, cpR] = await Promise.allSettled([
      fetchWithTimeout(`https://cursor.com/api/usage?user=${userId}`, { headers: authHeaders }),
      fetchWithTimeout("https://cursor.com/api/auth/stripe", { headers: authHeaders }),
      fetchWithTimeout("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Connect-Protocol-Version": "1", "Content-Type": "application/json" },
        body: "{}",
      }),
    ])
    result.usage  = uR.status === "fulfilled" && uR.value.ok ? await uR.value.json() : null
    result.stripe = sR.status === "fulfilled" && sR.value.ok ? await sR.value.json() : null
    if (cpR.status === "fulfilled" && cpR.value.ok) {
      const cp = await cpR.value.json().catch(() => null)
      if (cp) result.currentPeriod = {
        completedRequests: cp.completedRequests,
        startOfCurrentPeriod: cp.startOfCurrentPeriod,
        planUsage: cp.planUsage ?? null,
      }
    }
    if (!result.usage && !result.stripe) {
      result.error = summaryR.reason?.message ?? "Failed to fetch Cursor usage"
    }
  }

  if (meR.status === "fulfilled" && meR.value.ok) {
    const me = await meR.value.json().catch(() => null)
    if (me) result.me = { email: me.email, name: me.name, sub: me.sub }
  }

  return result
}

async function fetchCodexUsage() {
  const authFile = join(homedir(), ".codex", "auth.json")
  if (!existsSync(authFile)) return { error: "~/.codex/auth.json not found" }
  let auth
  try { auth = JSON.parse(readFileSync(authFile, "utf8")) } catch { return { error: "Could not parse ~/.codex/auth.json" } }
  const tokens = auth?.tokens ?? {}
  const accessToken = tokens.access_token ?? ""
  const accountId   = tokens.account_id   ?? ""
  const idToken     = tokens.id_token     ?? ""
  let plan = "", activeUntil = ""
  if (idToken) {
    const decoded = decodeJwtPayload(idToken)
    const chatgptAuth = decoded["https://api.openai.com/auth"] ?? {}
    plan        = chatgptAuth.chatgpt_plan_type ?? ""
    activeUntil = chatgptAuth.chatgpt_subscription_active_until ?? ""
  }
  let sessionCount = 0, historyCount = 0
  try {
    const walk = (dir) => {
      if (!existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name))
        else if (e.name.endsWith(".jsonl")) sessionCount++
      }
    }
    walk(join(homedir(), ".codex"))
    historyCount = readFileSync(join(homedir(), ".codex", "history.jsonl"), "utf8").split("\n").filter(Boolean).length
  } catch {}
  let wham = {}
  if (accessToken && accountId) {
    try {
      const wR = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Authorization: `Bearer ${accessToken}`, Accept: "application/json",
          "ChatGPT-Account-Id": accountId, Origin: "https://chatgpt.com",
          Referer: "https://chatgpt.com/", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        },
      })
      if (wR.ok) wham = await wR.json()
    } catch {}
  }
  // Slim wham to only rate_limit + credits
  const whamSlim = wham.rate_limit ? { rate_limit: wham.rate_limit, credits: wham.credits, plan_type: wham.plan_type } : {}
  const email = wham.email ?? (idToken ? (decodeJwtPayload(idToken)?.email ?? "") : "")
  const limits = normalizeCodexRateLimit(wham.rate_limit)
  const quotaPlan = wham.plan_type || plan
  return { plan: quotaPlan, auth_plan: plan, active_until: activeUntil, sessionCount, historyCount, wham: whamSlim, limits, email }
}

function readFirefoxClaudeSessionKey() {
  // Find Firefox's cookies SQLite for claude.ai sessionKey
  const profilesDir = join(homedir(), "Library", "Application Support", "Firefox", "Profiles")
  if (!existsSync(profilesDir)) return ""
  for (const profile of readdirSync(profilesDir)) {
    const cookiesDb = join(profilesDir, profile, "cookies.sqlite")
    if (!existsSync(cookiesDb)) continue
    try {
      const tmpScript = join(tmpdir(), "_ff_cookie.py")
      writeFileSync(tmpScript, [
        "import sqlite3,sys",
        `con=sqlite3.connect(${JSON.stringify(cookiesDb)})`,
        `row=con.execute("SELECT value FROM moz_cookies WHERE host LIKE '%.claude.ai' AND name='sessionKey' ORDER BY lastAccessed DESC LIMIT 1").fetchone()`,
        "print(row[0] if row else '')",
      ].join("\n"))
      const val = execSync(`python3 "${tmpScript}"`, { encoding: "utf8" }).trim()
      if (val) return val
    } catch {}
  }
  return ""
}

function readClaudeOAuthCredentials() {
  const envToken = process.env.CLAUDE_OAUTH_ACCESS_TOKEN ?? ""
  if (envToken) return { accessToken: envToken, subscriptionType: process.env.CLAUDE_SUBSCRIPTION_TYPE ?? "" }
  try {
    const out = execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()
    if (!out) return null
    const parsed = JSON.parse(out)
    const oauth = parsed?.claudeAiOauth ?? {}
    if (!oauth.accessToken) return null
    return {
      accessToken: oauth.accessToken,
      subscriptionType: oauth.subscriptionType ?? "",
      rateLimitTier: oauth.rateLimitTier ?? "",
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
      expiresAt: oauth.expiresAt ?? null,
    }
  } catch {
    return null
  }
}

function mapClaudeOAuthWindow(window) {
  if (!window || typeof window.utilization !== "number") return null
  return {
    utilization: window.utilization,
    resets_at: window.resets_at ?? null,
  }
}

async function fetchClaudeOAuthUsage() {
  const credentials = readClaudeOAuthCredentials()
  if (!credentials?.accessToken) return null
  const usageR = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.143",
    },
  })
  if (!usageR.ok) {
    return { error: `Claude OAuth usage: ${usageR.status}` }
  }
  const usage = await usageR.json()
  return {
    source: "claude-code-oauth",
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
    usage: {
      five_hour: mapClaudeOAuthWindow(usage.five_hour),
      seven_day: mapClaudeOAuthWindow(usage.seven_day),
      seven_day_opus: mapClaudeOAuthWindow(usage.seven_day_opus ?? usage.seven_day_sonnet),
    },
  }
}

function parseClaudeCLIUsage() {
  // Read from cache written by scripts/claude-usage-poller.sh (requires a real TTY to run)
  const cacheFile = join(homedir(), ".config", "agent-session-viewer", "claude-usage-cache.json")
  try {
    if (!existsSync(cacheFile)) return null
    const data = JSON.parse(readFileSync(cacheFile, "utf8"))
    // Ignore stale cache (older than 30 minutes)
    if (data.fetchedAt && Date.now() - data.fetchedAt > 30 * 60 * 1000) return null
    return data
  } catch {
    return null
  }
}

async function fetchClaudeUsage() {
  const statsFile = join(homedir(), ".claude", "stats-cache.json")
  let slim = {}
  try {
    const stats = JSON.parse(readFileSync(statsFile, "utf8"))
    slim = {
      numSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      firstSessionDate: stats.firstSessionDate,
    }
  } catch {}

  // Parse CLI usage (session % / weekly %)
  const cliUsage = parseClaudeCLIUsage()
  if (cliUsage) slim = { ...slim, cliUsage }

  const oauthUsage = await fetchClaudeOAuthUsage()
  if (oauthUsage?.usage) {
    return { ...slim, ...oauthUsage }
  }

  let sessionKey = process.env.CLAUDE_SESSION_KEY ?? ""
  if (!sessionKey) sessionKey = readFirefoxClaudeSessionKey()
  if (!sessionKey) return { ...slim, _hint: "Could not find CLAUDE_SESSION_KEY — set it in .env or log into claude.ai in Firefox" }
  try {
    const orgsR = await fetchWithTimeout("https://claude.ai/api/organizations", {
      headers: { Cookie: `sessionKey=${sessionKey}`, Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    })
    if (!orgsR.ok) return { ...slim, error: `claude.ai organizations: ${orgsR.status}` }
    const orgs = await orgsR.json()
    const org = Array.isArray(orgs)
      ? (orgs.find(o => o.capabilities?.includes("chat")) ?? orgs[0])
      : null
    if (!org?.uuid) return { ...slim, error: "Could not find org ID" }
    const usageR = await fetchWithTimeout(`https://claude.ai/api/organizations/${org.uuid}/usage`, {
      headers: { Cookie: `sessionKey=${sessionKey}`, Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    })
    if (!usageR.ok) return { ...slim, error: `claude.ai usage: ${usageR.status}` }
    return { ...slim, usage: await usageR.json() }
  } catch (e) {
    return { ...slim, error: e.message }
  }
}

async function fetchOpenCodeUsage() {
  const dbFile = join(homedir(), ".local", "share", "opencode", "opencode.db")
  if (!existsSync(dbFile)) return { error: "OpenCode not installed (~/.local/share/opencode/opencode.db not found)" }
  try {
    const tmpScript = join(tmpdir(), "_opencode_usage.py")
    writeFileSync(tmpScript, [
      "import sqlite3, json",
      `db = sqlite3.connect(${JSON.stringify(dbFile)})`,
      "sessions = db.execute('SELECT model, cost, tokens_input, tokens_output FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 100').fetchall()",
      "total_cost = sum(r[1] or 0 for r in sessions)",
      "total_in = sum(r[2] or 0 for r in sessions)",
      "total_out = sum(r[3] or 0 for r in sessions)",
      "import json as _json",
      "top_models = {}",
      "for r in sessions:",
      "    raw = r[0] or ''",
      "    try: obj = _json.loads(raw); m = obj.get('providerID','') or obj.get('id','')",
      "    except: m = raw.split('/')[0]",
      "    if m: top_models[m] = top_models.get(m, 0) + 1",
      "providers = list(top_models.keys())",
      "top_model = max(top_models, key=top_models.get) if top_models else ''",
      "print(json.dumps({'sessionCount': len(sessions), 'totalCost': total_cost, 'totalTokensIn': total_in, 'totalTokensOut': total_out, 'providers': providers, 'topModel': top_model}))",
    ].join("\n"))
    const out = execSync(`python3 "${tmpScript}"`, { encoding: "utf8" }).trim()
    return JSON.parse(out)
  } catch (e) {
    return { error: e.message }
  }
}

function detectAntigravityLanguageServer() {
  try {
    const stdout = execSync("ps aux", { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })
    for (const line of stdout.split("\n")) {
      const lower = line.toLowerCase()
      if (!lower.includes("antigravity")) continue
      const hasSignal =
        line.includes("language-server") ||
        line.includes("lsp") ||
        line.includes("--csrf_token") ||
        line.includes("--extension_server_port") ||
        line.includes("exa.language_server_pb")
      if (!hasSignal) continue
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts[1])
      if (!Number.isFinite(pid)) continue
      const commandLine = parts.slice(10).join(" ")
      return {
        pid,
        csrfToken: extractCommandArgument(commandLine, "--csrf_token"),
        extensionServerPort: Number(extractCommandArgument(commandLine, "--extension_server_port")) || null,
      }
    }
  } catch {}
  return null
}

function antigravityListeningPorts(pid) {
  const ports = []
  try {
    const stdout = execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`, { encoding: "utf8" })
    for (const line of stdout.split("\n")) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)/)
      if (match) ports.push(Number(match[1]))
    }
  } catch {}
  return [...new Set(ports)].filter(Number.isFinite)
}

function connectRpcRequest(baseUrl, path, csrfToken, body, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const client = url.protocol === "https:" ? https : http
    const req = client.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      timeout: timeoutMs,
      rejectUnauthorized: false,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        ...(csrfToken ? { "X-Codeium-Csrf-Token": csrfToken } : {}),
      },
    }, res => {
      let data = ""
      res.on("data", chunk => { data += chunk })
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)) } catch { resolve(data) }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
        }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("Request timed out"))
    })
    req.write(JSON.stringify(body ?? { wrapper_data: {} }))
    req.end()
  })
}

async function probeAntigravityConnectPort(port, csrfToken) {
  const path = "/exa.language_server_pb.LanguageServerService/GetUnleashData"
  for (const protocol of ["https", "http"]) {
    const baseUrl = `${protocol}://127.0.0.1:${port}`
    try {
      await connectRpcRequest(baseUrl, path, csrfToken, { wrapper_data: {} }, 700)
      return baseUrl
    } catch (e) {
      const msg = String(e?.message ?? e).toLowerCase()
      if (msg.includes("http 401")) return baseUrl
    }
  }
  return null
}

function parseAntigravityQuota(userStatusResponse) {
  const userStatus = userStatusResponse?.userStatus ?? userStatusResponse ?? {}
  const planStatus = userStatus.planStatus ?? {}
  const planInfo = planStatus.planInfo ?? {}
  const available = planStatus.availablePromptCredits
  const monthly = planInfo.monthlyPromptCredits
  const promptCredits = typeof available === "number" && typeof monthly === "number"
    ? {
        available,
        monthly,
        used: monthly - available,
        remainingPercentage: monthly > 0 ? available / monthly : null,
        usedPercentage: monthly > 0 ? (monthly - available) / monthly : null,
      }
    : null
  const clientModelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs
  const models = Array.isArray(clientModelConfigs)
    ? clientModelConfigs.flatMap(model => {
        const modelId = model?.modelOrAlias?.model
        const quotaInfo = model?.quotaInfo
        if (!modelId || !quotaInfo) return []
        return [{
          modelId,
          label: model.label ?? modelId,
          remainingPercentage: typeof quotaInfo.remainingFraction === "number" ? quotaInfo.remainingFraction : null,
          usedPercentage: typeof quotaInfo.remainingFraction === "number" ? 1 - quotaInfo.remainingFraction : null,
          isExhausted: Boolean(quotaInfo.isExhausted) || quotaInfo.remainingFraction === 0,
          resetTime: quotaInfo.resetTime ?? null,
        }]
      })
    : []
  return {
    email: userStatus.email,
    planType: planInfo.planType,
    promptCredits,
    models,
  }
}

async function fetchAntigravityLocalQuota() {
  const processInfo = detectAntigravityLanguageServer()
  if (!processInfo) throw new Error("Antigravity language server is not running")
  const ports = antigravityListeningPorts(processInfo.pid)
  if (processInfo.extensionServerPort) ports.push(processInfo.extensionServerPort)
  const uniquePorts = [...new Set(ports)].filter(Number.isFinite)
  if (!uniquePorts.length) throw new Error("Could not detect Antigravity language-server port")
  for (const port of uniquePorts) {
    const baseUrl = await probeAntigravityConnectPort(port, processInfo.csrfToken)
    if (!baseUrl) continue
    const raw = await connectRpcRequest(
      baseUrl,
      "/exa.language_server_pb.LanguageServerService/GetUserStatus",
      processInfo.csrfToken,
      { metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } },
      5000,
    )
    return { source: "local-language-server", port, ...parseAntigravityQuota(raw) }
  }
  throw new Error("Could not connect to Antigravity quota endpoint")
}

async function fetchAntigravityUsage() {
  const brainDir = join(homedir(), ".gemini", "antigravity", "brain")
  if (!existsSync(brainDir)) return { error: "Antigravity not installed" }

  const conversationsDir = join(homedir(), ".gemini", "antigravity", "conversations")

  // Count brain sessions and read task titles
  const sessionDirs = existsSync(brainDir)
    ? readdirSync(brainDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : []

  const sessions = []
  for (const id of sessionDirs.slice(-20)) {  // last 20
    const taskFile = join(brainDir, id, "task.md")
    if (!existsSync(taskFile)) continue
    try {
      const content = readFileSync(taskFile, "utf8")
      const titleMatch = content.match(/^#\s+(.+)/m)
      const title = titleMatch?.[1]?.replace(/^Task:\s*/i, "").trim() ?? id.slice(0, 8)
      const doneCount = (content.match(/\[x\]/gi) ?? []).length
      const totalCount = (content.match(/\[[x ]\]/gi) ?? []).length
      sessions.push({ id, title, doneCount, totalCount })
    } catch {}
  }

  const conversationCount = existsSync(conversationsDir)
    ? readdirSync(conversationsDir).filter(f => f.endsWith(".pb")).length
    : 0

  // Read model info from state DB
  let model = ""
  const stateDb = join(homedir(), "Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb")
  if (existsSync(stateDb)) {
    try {
      const tmpScript = join(tmpdir(), "_ag_state.py")
      writeFileSync(tmpScript, [
        "import sqlite3,json",
        `con=sqlite3.connect(${JSON.stringify(stateDb)})`,
        `row=con.execute("SELECT value FROM ItemTable WHERE key='Anthropic.claude-code'").fetchone()`,
        "print(row[0] if row else '{}')",
      ].join("\n"))
      const raw = execSync(`python3 "${tmpScript}"`, { encoding: "utf8" }).trim()
      const d = JSON.parse(raw)
      model = d.model ?? d.defaultModel ?? ""
    } catch {}
  }

  let quota = null
  let quotaError = ""
  try {
    quota = await fetchAntigravityLocalQuota()
  } catch (e) {
    quotaError = e?.message ?? String(e)
  }

  return {
    sessionCount: sessionDirs.length,
    conversationCount,
    model: quota?.models?.[0]?.label ?? model,
    quota,
    quotaError,
    recentSessions: sessions.slice(-5).reverse(),
  }
}

async function fetchAllUsage() {
  const [cursor, codex, claude, opencode, antigravity] = await Promise.all([
    settleUsage("Cursor", fetchCursorUsage()),
    settleUsage("Codex", fetchCodexUsage()),
    settleUsage("Claude", fetchClaudeUsage()),
    settleUsage("OpenCode", fetchOpenCodeUsage()),
    settleUsage("Antigravity", fetchAntigravityUsage()),
  ])
  const snapshot = { cursor, codex, claude, opencode, antigravity, fetchedAt: Date.now() }
  pushUsageSnapshot(snapshot)
  return snapshot
}

function pushUsageSnapshot(snapshot) {
  const workerUrl = process.env.USAGE_WORKER_URL
  const secret    = process.env.USAGE_SYNC_SECRET
  if (!workerUrl || !secret) return
  const ingestUrl = workerUrl.replace(/\/$/, "") + "/ingest"
  fetch(ingestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sync-Secret": secret },
    body: JSON.stringify(snapshot),
  }).catch(e => console.warn("[usage-push] Failed to push to worker:", e?.message))
}

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

  // POST /api/indexer/start — trigger indexer from wrapper
  if (url.pathname === "/api/indexer/start" && req.method === "POST") {
    triggerBackgroundIndexer()
    json({ ok: true })
    return
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
    const pinRequired = Boolean(AUTH_PIN) && !isLocalRequest(req)
    json({
      openPath: true,
      debugStream: true,
      pinRequired,
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

  // GET /api/usage — cookie or header auth (daemon/CLI uses header)
  if (url.pathname === "/api/usage" && req.method === "GET") {
    if (!checkCookieAuth(req) && !checkHeaderAuth(req)) { json({ error: "Unauthorized" }, 401); return }
    json(await fetchAllUsage())
    return
  }

  // All remaining /api/* require cookie auth
  if (url.pathname.startsWith("/api/") && !checkCookieAuth(req)) {
    json({ error: "Unauthorized" }, 401)
    return
  }

  // GET /api/search/sessions?q= — sidebar search over title + platform only
  if (url.pathname === "/api/search/sessions") {
    const q = url.searchParams.get("q")?.trim() ?? ""
    if (!q) { json({ results: [] }); return }

    const rows = getSearchRows()
    const fallbackRows = rows.length ? null : loadSidebarCache().sessions.map(e => ({
      projectPath: e.projectPath,
      sessionId: e.id,
      displayTitle: String(e.customName || e.firstName || e.id.slice(0, 8) || e.id),
      meta: {
        id: e.id,
        customName: e.customName ?? null,
        firstName: e.firstName ?? null,
        source: e.source ?? "claude",
        lastActivity: e.lastActivity ?? null,
        mtime: e.mtime ?? null,
      },
      corpus: buildSidebarSearchDoc({
        id: e.id,
        customName: e.customName ?? null,
        firstName: e.firstName ?? null,
        source: e.source ?? "claude",
      }),
    }))
    const searchRows = rows.length ? rows : fallbackRows ?? []
    const t0 = performance.now()
    const results = runSidebarSessionSearch(q, searchRows)
    const ms = (performance.now() - t0).toFixed(1)
    const source = rows.length ? "index" : "cache-fallback"
    console.log(`${ts()} [search] q="${q}" rows=${searchRows.length} liveRows=${rows.length} results=${results.length} source=${source} title+platform ms=${ms}`)
    json({ results, source })
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
    json({
      sidebarCacheSessions: loadSidebarCache().sessions.length,
      searchRows: getSearchRows().length,
    })
    return
  }

  // GET /api/search/global?q= — content-only search across all platforms
  if (url.pathname === "/api/search/global") {
    const q = url.searchParams.get("q")?.trim() ?? ""
    if (!q) { json({ hits: [], source: "content" }); return }
    const t0 = performance.now()
    try {
      // content-search covers Claude+Codex JSONL (streaming) + Cursor/Hermes/OpenCode SQLite
      // rg-search covers Antigravity .md files (clean text, no JSON noise)
      const [contentHits, rgHits] = await Promise.all([
        contentSearch(q, { limit: 100 }),
        rgGlobalSearch(q, { limit: 100 }).catch(() => []),
      ])
      // Merge; deduplicate by sessionId (content-search takes precedence for shared platforms)
      const seen = new Set(contentHits.map(h => h.sessionId))
      const antigravityHits = (rgHits ?? []).filter(h => h.source === "antigravity" && !seen.has(h.sessionId))
      const hits = [...contentHits, ...antigravityHits].slice(0, 100)
      const ms = (performance.now() - t0).toFixed(1)
      console.log(`${ts()} [global-search] q="${q}" hits=${hits.length} ms=${ms}`)
      json({ hits, source: "content", ms: Number(ms) })
    } catch (err) {
      console.error(`${ts()} [global-search] error q="${q}":`, err.message)
      json({ hits: [], source: "content", error: err.message })
    }
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

  // GET /api/session-near?project=...&session=...&uuid=...&context=N
  // Returns up to 2*N+1 filtered messages centered on the target UUID.
  // Headers: X-Message-Total (filtered), X-Window-Start (filtered index of result[0]).
  if (url.pathname === "/api/session-near") {
    const projectPath = decodeURIComponent(url.searchParams.get("project") ?? "")
    const sessionId = url.searchParams.get("session") ?? ""
    const uuid = url.searchParams.get("uuid") ?? ""
    const context = Math.max(1, Math.min(300, parseInt(url.searchParams.get("context") ?? "60") || 60))
    if (!projectPath || !sessionId || !uuid) { json({ error: "Missing params" }, 400); return }
    const allMsgs = projectPath.startsWith("codex:")
      ? readCodexSessionById(sessionId, null, null)?.msgs ?? []
      : loadSessionMessages(projectPath, sessionId)
    const filtered = allMsgs.filter(m => m?.type !== "file-history-snapshot")
    const targetIdx = filtered.findIndex(m => String(m?.uuid ?? "") === uuid)
    if (targetIdx === -1) { json({ error: "Not found" }, 404); return }
    const start = Math.max(0, targetIdx - context)
    const end = Math.min(filtered.length, targetIdx + context + 1)
    const window = filtered.slice(start, end)
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Message-Total": String(filtered.length),
      "X-Window-Start": String(start),
    })
    res.end(JSON.stringify(window))
    return
  }

  // GET /api/session-message?project=...&session=...&uuid=... — fetch one exact message by id
  if (url.pathname === "/api/session-message") {
    const projectPath = decodeURIComponent(url.searchParams.get("project") ?? "")
    const sessionId = url.searchParams.get("session") ?? ""
    const uuid = url.searchParams.get("uuid") ?? ""
    if (!projectPath || !sessionId || !uuid) { json({ error: "Missing project/session/uuid" }, 400); return }
    const msgs = projectPath.startsWith("codex:")
      ? readCodexSessionById(sessionId, null, null)?.msgs ?? null
      : loadSessionMessages(projectPath, sessionId)
    if (!Array.isArray(msgs) || !msgs.length) { json({ error: "Not found" }, 404); return }
    const idx = msgs.findIndex(m => String(m?.uuid ?? "") === uuid)
    if (idx === -1) { json({ error: "Not found" }, 404); return }
    json({
      index: idx,
      total: msgs.length,
      msg: msgs[idx],
      nextMsg: msgs[idx + 1] ?? null,
      prevMsg: idx > 0 ? msgs[idx - 1] : null,
    })
    return
  }

  // GET /api/context-snapshot?project=...&session=...
  // Opens a self-contained static HTML context/token breakdown for the selected thread.
  if (url.pathname === "/api/context-snapshot") {
    const projectPath = decodeURIComponent(url.searchParams.get("project") ?? "")
    const sessionId = url.searchParams.get("session") ?? ""
    if (!projectPath || !sessionId) { json({ error: "Missing project/session" }, 400); return }
    const snapshot = buildContextSnapshot(projectPath, sessionId)
    if (!snapshot) { json({ error: "Session not found" }, 404); return }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(renderContextSnapshotHtml(snapshot))
    return
  }

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
    console.log(`[perf ${wallClock()}] /api/session start ${source}:${shortId} tail=${tail} skip=${skip} path=${projectPath}`)

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
      console.log(`[perf ${wallClock()}] /api/session ${source}:${shortId} tail=${tail} skip=${skip} → ${msgs.length}/${total} msgs | load:${loadLabel} | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
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
      console.log(`[perf ${wallClock()}] /api/session cursor:${shortId} tail=${tail} skip=${skip} → ${msgs.length}/${total} msgs | load:sqlite ${ms}ms | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(total) })
      res.end(jsonStr)
      return
    }
    // All platforms: check msgCache first (includes Claude sessions cached after first parse)
    const cacheKey = `${projectPath}/${sessionId}`
    if (msgCache.has(cacheKey)) {
      console.log(`[perf ${wallClock()}] /api/session cache-hit ${source}:${shortId} key=${cacheKey}`)
      jsonPaged(msgCache.get(cacheKey), "mem-cache")
      return
    }

    // Non-Claude platforms: on-demand read via platform-readers
    const isNonClaude = isOnDemandSessionPlatform(projectPath)
    if (isNonClaude) {
      const t0ondemand = performance.now()
      const ondemand = loadSessionMessagesOndemand(projectPath, sessionId)
      const ondemandMs = (performance.now() - t0ondemand).toFixed(1)
      console.log(`[perf ${wallClock()}] /api/session ondemand ${source}:${shortId} load=${ondemandMs}ms hit=${ondemand != null}`)
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
      console.log(`[perf ${wallClock()}] /api/session claude:${shortId} fast-tail start tail=${tail}`)
      const tailMsgs = readJsonlTail(fp, tail)
      const lineTotal = countJsonlLines(fp)
      const jsonStr = JSON.stringify(tailMsgs)
      const totalMs = (performance.now() - reqT0).toFixed(1)
      console.log(`[perf ${wallClock()}] /api/session claude:${shortId} tail=${tail} → ${tailMsgs.length}/${lineTotal} msgs | load:jsonl-tail | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
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
    console.log(`[perf ${wallClock()}] /api/session claude:${shortId} parse-start skip=${skip} tail=${tail}`)
    const parsed = parseJsonl(fp)
    msgCache.set(cacheKey, parsed)
    console.log(`[perf ${wallClock()}] /api/session claude:${shortId} parse-done count=${parsed.length}`)
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
    // Non-file-based platforms don't have a raw JSONL on disk
    if (/^(opencode|cursor|hermes):/.test(project)) {
      json({ error: "Raw JSONL not available for this platform" }, 404); return
    }
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

process.on("uncaughtException", err => {
  console.error(`${ts()} [uncaughtException]`, err.stack || err)
})
process.on("unhandledRejection", (reason, promise) => {
  console.error(`${ts()} [unhandledRejection] at:`, promise, "reason:", reason)
})

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
