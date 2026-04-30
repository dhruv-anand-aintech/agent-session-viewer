/**
 * Local server — full replacement for the Cloudflare Worker.
 * Reads ~/.claude/projects/ directly; no Cloudflare account needed.
 *
 * Run via: npm run local
 * Config persisted to: ~/.claude/agent-session-viewer-local.json
 */

import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, extname, join, sep } from "path"
import http from "http"
import { fileURLToPath } from "url"
import { exec } from "child_process"
import { stripXml, trimProjectsByRecentSessionCount, countSessionsInProjects } from "./shared-utils.mjs"
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
} from "./platform-readers.mjs"
import { buildSidebarSearchDoc, runSidebarSessionSearch } from "./lib/session-search-core.mjs"
import { indexSession, removeSession, getSearchRows } from "./lib/search-index.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const CONFIG_FILE = join(homedir(), ".claude", "agent-session-viewer-local.json")
const SIDEBAR_CACHE_FILE = join(homedir(), ".claude", "agent-session-viewer-sidebar-cache.json")

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
    // Migrate v1 (plain object keyed by sessionId) to v2
    if (!raw.v || raw.v < 2) {
      _sidebarCache = { v: 2, sessions: [], _map: new Map() }
    } else {
      _sidebarCache = raw
      _sidebarCache._map = new Map(_sidebarCache.sessions.map(e => [e.id, e]))
    }
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
    if (!s.messageCount) s.messageCount = entry.messageCount ?? 0
    if (s.userMessageCount == null) s.userMessageCount = entry.userMessageCount ?? null
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
  try {
    return readFileSync(fp, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
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
    projectPath: projectKey,
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
        const msgs = parseJsonl(fp)
        sessions.push(claudeSessionMetaFromMsgs(msgs, sessionId, projectKey, names, stat))
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
  const sessions = []
  for (const f of files) {
    const fp = join(dp, f)
    let stat
    try { stat = statSync(fp) } catch { continue }
    const sessionId = f.replace(".jsonl", "")
    fileBySessKey.set(SESS_PATH_KEY(projectPath, sessionId), { fp, stat })
    sessions.push({
      id: sessionId,
      projectPath: projectKey,
      lastActivity: stat.mtime.toISOString(),
      version: undefined,
      gitBranch: undefined,
      isActive: Date.now() - stat.mtimeMs < FIVE_MIN,
      userMessageCount: 0,
      messageCount: 0,
      firstName: cheapReadFirstUserMsg(fp),
      customName: names[`${projectKey}/${sessionId}`] ?? null,
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

/** Merge incoming project rows into acc (by path + session id), then sort groups by most recent row. */
function mergeProjectsInto(acc, incoming) {
  const map = new Map(acc.map(p => [p.path, { ...p, sessions: [...p.sessions] }]))
  for (const inc of incoming) {
    if (!map.has(inc.path)) {
      map.set(inc.path, { ...inc, sessions: [...inc.sessions] })
    } else {
      const cur = map.get(inc.path)
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

/** Progressive recent sidebar: emit trimmed running snapshot after each Claude folder / platform, then hydrate. */
async function streamRecentSidebarInitial(res, maxSessions) {
  // Emit cached sidebar state immediately so the UI shows real data before any scanning
  const cachedState = loadCachedSidebarState()
  if (cachedState?.length) sseWrite(res, "projects", sortProjectGroups(cachedState))

  const names = loadConfig().names ?? {}
  /** @type {Map<string, { fp: string, stat: import('fs').Stats }>} */
  const fileBySessKey = new Map()
  let acc = []

  for (const { path: root, label } of getClaudeScanRoots()) {
    let dirs
    try { dirs = readdirSync(root) } catch { continue }
    for (const dir of dirs) {
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
  ]
  for (const loadFn of fastPlatformLoads) {
    const part = await loadFn()
    if (!part.length) continue
    acc = mergeProjectsInto(acc, part)
    sseWrite(res, "projects", sortProjectGroups(acc))
    await yieldEventLoopTick()
  }

  const total = countSessionsInProjects(acc)
  sseWrite(res, "projects_meta", { total })

  // Hydrate full metadata (message counts, accurate firstName) for the most recent sessions only.
  // firstName is already set cheaply for all sessions via cheapReadFirstUserMsg in scanOneClaudeFolder.
  const hydrateN = maxSessions ?? 50
  const forHydration = hydrateN > 0
    ? trimProjectsByRecentSessionCount(acc, hydrateN)
    : sortProjectGroups(acc)
  hydrateClaudeSessionsInProjects(forHydration, fileBySessKey, names)
  flushSidebarCacheFromProjects(forHydration, fileBySessKey)
  // Copy hydrated firstName values back to acc so all SSE events carry correct titles
  for (const p of forHydration) {
    const ap = acc.find(a => a.path === p.path)
    if (!ap) continue
    const byId = new Map(ap.sessions.map(s => [s.id, s]))
    for (const s of p.sessions) {
      const as = byId.get(s.id)
      if (as && s.firstName) as.firstName = s.firstName
    }
  }
  // Emit ALL sessions (no trim) — older sessions visible immediately; firstName set for all via cheap scan
  const allSorted = sortProjectGroups(acc)
  sseWrite(res, "projects", allSorted)
  sseWrite(res, "bootstrap_done", {})

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
}

function hydrateClaudeSessionsInProjects(projects, fileBySessKey, names) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i]
      if (s.source !== "claude") continue
      const rec = fileBySessKey.get(SESS_PATH_KEY(p.path, s.id))
      if (!rec) continue
      const msgs = parseJsonl(rec.fp)
      p.sessions[i] = claudeSessionMetaFromMsgs(msgs, s.id, s.projectPath, names, rec.stat)
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
  ].sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity ?? ""
    const bLast = b.sessions[0]?.lastActivity ?? ""
    return String(bLast).localeCompare(String(aLast))
  })

  const total = countSessionsInProjects(allProjects)
  const trimmed =
    total > maxSessions ? trimProjectsByRecentSessionCount(allProjects, maxSessions) : allProjects
  hydrateClaudeSessionsInProjects(trimmed, fileBySessKey, names)
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
    /^(opencode|codex|hermes|antigravity|cursor-agent):/.test(projectPath) &&
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
      const dirPart = projectPath.replace(`${platformPrefix}:`, "")
      projects.set(projectPath, {
        path: projectPath,
        displayName: `${platformPrefix}: ${encodedDirToDisplayName(dirPart)}`,
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
  if (!existsSync(fp)) { removeSession(projectPath, sessionId); broadcastProjects(); return }
  try {
    const stat = statSync(fp)
    const names = loadConfig().names ?? {}
    const projectKey = projectDir
    const msgs = parseJsonl(fp)
    const meta = claudeSessionMetaFromMsgs(msgs, sessionId, projectKey, names, stat)
    indexSession(projectPath, sessionId, msgs, meta)
  } catch { /* ignore */ }
  broadcastProjects()
}

try {
  watch(CLAUDE_DIR, { recursive: true }, (_evt, filename) => handleClaudeFileChange(filename))
} catch {
  setInterval(broadcastProjects, 3000)
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

  // GET /api/search/sessions?q= — fuzzy search across all threads (titles, users, system, …)
  if (url.pathname === "/api/search/sessions") {
    const q = url.searchParams.get("q")?.trim() ?? ""
    if (!q) { json({ results: [] }); return }
    const rows = getSearchRows()
    const results = runSidebarSessionSearch(q, rows)
    json({ results })
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

  // GET /api/session/:project/:id[?tail=N&skip=M]
  // tail=N  → return last N messages (default: all)
  // skip=M  → skip M messages from the end before taking tail (for pagination)
  const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/)
  if (sessionMatch) {
    const projectPath = decodeURIComponent(sessionMatch[1])
    const sessionId = sessionMatch[2]
    const tailParam = url.searchParams.get("tail")
    const skipParam = url.searchParams.get("skip")
    const tail = tailParam ? Math.max(1, parseInt(tailParam) || 0) : 0
    const skip = skipParam ? Math.max(0, parseInt(skipParam) || 0) : 0

    function sliceMsgs(all) {
      const total = all.length
      if (!tail) return { msgs: all, total }
      const end = total - skip
      const start = Math.max(0, end - tail)
      return { msgs: all.slice(start, end > 0 ? end : 0), total }
    }

    function jsonPaged(all) {
      const { msgs, total } = sliceMsgs(all)
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(total) })
      res.end(JSON.stringify(msgs))
    }

    // Cursor: push tail/skip into SQLite — avoids reading all bubbles for a tail fetch
    if (projectPath.startsWith("cursor:")) {
      const { msgs, total } = readCursorSessionMsgs(sessionId, { tail, skip })
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(total) })
      res.end(JSON.stringify(msgs))
      return
    }
    // Other non-Claude platforms: msgCache (filled by /api/projects) or on-demand read
    const cacheKey = `${projectPath}/${sessionId}`
    if (msgCache.has(cacheKey)) { jsonPaged(msgCache.get(cacheKey)); return }
    const ondemand = loadSessionMessagesOndemand(projectPath, sessionId)
    if (ondemand != null) {
      msgCache.set(cacheKey, ondemand)
      jsonPaged(ondemand)
      return
    }
    // Claude Code: projectPath is a folder slug under ~/.claude/projects or an absolute project root.
    // Never join ~/.claude/projects with platform keys (e.g. opencode:…); on-demand load failed above.
    if (
      /^(opencode|codex|hermes|antigravity|cursor-agent):/.test(projectPath) &&
      !/^[A-Za-z]:[\\/]/.test(projectPath)
    ) {
      res.writeHead(404); res.end("Not Found"); return
    }
    const fp = projectPath.startsWith("/")
      ? join(projectPath, `${sessionId}.jsonl`)
      : join(CLAUDE_DIR, projectPath, `${sessionId}.jsonl`)
    if (!existsSync(fp)) { res.writeHead(404); res.end("Not Found"); return }
    jsonPaged(parseJsonl(fp))
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

const BIND_HOST = process.env.HOST ?? "127.0.0.1"
server.listen(PORT, BIND_HOST, () => {
  const displayHost = BIND_HOST === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : "localhost"
  console.log(`\n  Agent Session Viewer (local mode)`)
  console.log(`  API:      http://localhost:${PORT} (bound to ${displayHost})`)
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
