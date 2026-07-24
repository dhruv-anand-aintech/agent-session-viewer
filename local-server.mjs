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
import { exec, execFile, execFileSync, execSync, spawnSync } from "child_process"
import { stripXml, trimProjectsByRecentSessionCount, countSessionsInProjects, parseJsonlStream, hasClaudeTranscriptMessage } from "./shared-utils.mjs"
import { isLegacyCodexProjectPath, loadSessionMessages } from "./lib/session-message-loader.mjs"
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
  ANTIGRAVITY_CLI_DIR,
  readAntigravityCliSessions,
  HERMES_DB,
  readHermesSessions,
  readCodexSessionById,
  listCodexSessionFiles,
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
import { extractLatestPlan } from "./lib/plan-status-core.mjs"
import { inferClaudeCodexParent } from "./lib/codex-claude-lineage.mjs"
import { indexSession, removeSession, getSearchRows } from "./lib/search-index.mjs"
import { rgGlobalSearch } from "./lib/rg-search.mjs"
import { contentSearchStream } from "./lib/content-search.mjs"
import { isDebugTrace, debugLog, debugWarn } from "./lib/debug-trace.mjs"
import { canResumeSessionWithAgl, getAgentProviders, parseConfiguredProviders, runLocalAglChat } from "./lib/agent-chat-core.mjs"
import { buildLiveSessionPreview, compressLiveSummaryContext, isActivelyUpdating, openAILiveSummaryBody, openAIStreamDelta } from "./lib/live-summary-core.mjs"
import {
  openSidebarCacheDb,
  getSidebarCacheMap,
  getSidebarSessionCount,
  getTopSidebarEntries,
  getAllSidebarEntries,
  getSidebarEntry,
  deleteSidebarEntry,
  upsertSidebarEntry,
  expandSidebarLinkageEntries,
} from "./lib/sidebar-cache-db.mjs"
import {
  cacheEntryToSessionRow,
  groupCacheSessionsToProjects,
  sessionUpsertPayload,
} from "./lib/sidebar-cache-format.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env files from the project and shared ~/Code workspace (without overriding process env).
try {
  for (const envFile of [join(__dirname, ".env"), join(dirname(__dirname), ".env")]) {
    if (!existsSync(envFile)) continue
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
    }
  }
} catch {}

const PLATFORM_LOADER_WORKER = join(__dirname, "lib", "platform-loader-worker.mjs")
// Priority order: codex first (Claude scans on the main thread), then cursor/opencode;
// the rest queue behind the MAX_PLATFORM_WORKERS pool.
const STREAM_PLATFORM_WORKERS = ["codex", "cursor", "cursor-agent", "opencode", "gemini", "hermes", "openclaw", "antigravity", "antigravity-cli"]
const BUNDLE_PLATFORM_WORKERS = STREAM_PLATFORM_WORKERS
const SERVER_START_TIME = Date.now()
const SERVER_GIT = readServerGitMetadata()

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const APP_CONFIG_DIR = join(homedir(), ".config", "agent-session-viewer")
const CONFIG_FILE = join(APP_CONFIG_DIR, "config.json")
const SIDEBAR_CACHE_DB = join(APP_CONFIG_DIR, "sidebar-cache.db")

function getTranscriptReadLocations() {
  return [
    join(homedir(), ".claude", "projects"),
    join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    CURSOR_PROJECTS_ROOT,
    OPENCODE_DB,
    OPENCODE_STORAGE,
    CODEX_SESSIONS_ROOT,
    ANTIGRAVITY_BRAIN_DIR,
    ANTIGRAVITY_CLI_DIR,
    HERMES_DB,
    GEMINI_TMP_ROOT,
    OPENCLAW_ROOT,
  ].filter((location, index, locations) => location && locations.indexOf(location) === index)
}

function wallClock() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  })
}

function readServerGitMetadata() {
  const runGit = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: __dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    } catch {
      return null
    }
  }

  const status = runGit(["status", "--short"]) ?? ""

  return {
    commit: runGit(["rev-parse", "HEAD"]),
    shortCommit: runGit(["rev-parse", "--short", "HEAD"]),
    branch: runGit(["branch", "--show-current"]),
    commitDate: runGit(["show", "-s", "--format=%cI", "HEAD"]),
    dirtyAtStart: status.length > 0,
    statusAtStart: status ? status.split("\n") : [],
  }
}

function readCurrentGitState() {
  const runGit = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: __dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    } catch {
      return null
    }
  }
  const commit = runGit(["rev-parse", "HEAD"])
  const status = runGit(["status", "--short"]) ?? ""
  return {
    commit,
    shortCommit: runGit(["rev-parse", "--short", "HEAD"]),
    branch: runGit(["branch", "--show-current"]),
    dirty: status.length > 0,
    status: status ? status.split("\n") : [],
    commitMatchesDeployed: Boolean(commit && SERVER_GIT.commit && commit === SERVER_GIT.commit),
  }
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
const RECENT_CODEX_SEED_LIMIT = 40
const STREAM_BACKGROUND_DELAY_MS = 1200

// --- Config persistence (names + settings) ---

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) } catch { return {} }
}

function saveConfig(data) {
  mkdirSync(APP_CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2))
}

// --- Sidebar cache (SQLite sidebar-cache.db + in-memory Map for O(1) lookup) ---

let _sidebarCacheReady = false

function initSidebarCache() {
  if (_sidebarCacheReady) return
  const _t0 = performance.now()
  const { migrated } = openSidebarCacheDb(APP_CONFIG_DIR)
  let pruned = 0
  for (const entry of getAllSidebarEntries()) {
    if (entry.source !== "claude") continue
    const fp = join(entry.projectPath, `${entry.id}.jsonl`)
    if (hasClaudeTranscriptMessage(fp)) continue
    if (deleteSidebarEntry(entry.id)) pruned++
  }
  const count = getSidebarSessionCount()
  for (const entry of getAllSidebarEntries()) {
    indexSession(entry.projectPath, entry.id, [], {
      id: entry.id,
      customName: entry.customName ?? null,
      firstName: entry.firstName ?? null,
      source: entry.source ?? "claude",
    })
  }
  _sidebarCacheReady = true
  const ms = (performance.now() - _t0).toFixed(1)
  if (migrated) {
    debugLog(`${ts()} [sidebar-cache] migrated ${migrated} sessions JSON→SQLite (${ms}ms)`)
  } else {
    debugLog(`${ts()} [sidebar-cache] opened ${count} sessions from ${SIDEBAR_CACHE_DB}; pruned ${pruned} missing Claude transcripts (${ms}ms)`)
  }
}

/** @deprecated Use getSidebarCacheMap() — kept for callers expecting { sessions, _map }. */
function loadSidebarCache() {
  initSidebarCache()
  return { v: 2, sessions: getAllSidebarEntries(), _map: getSidebarCacheMap() }
}

/**
 * Convert the cache into ProjectData[] groups, applying stored customNames.
 * Returns null if cache is empty.
 */
function loadCachedSidebarState() {
  initSidebarCache()
  const entries = getAllSidebarEntries()
  if (!entries.length) return null
  const names = loadConfig().names ?? {}
  return groupCacheSessionsToProjects(entries, names)
}

/**
 * Sidebar cache only — no live platform scan. Top N via indexed SQLite query.
 */
function loadPinnedSessionEntry(pinProjectPath, pinSessionId, names) {
  if (!pinProjectPath || !pinSessionId) return null
  if (pinProjectPath.startsWith("codex:")) {
    const fp = findCodexSessionFile(pinSessionId)
    if (!fp) return null
    let stat
    try { stat = statSync(fp) } catch { return null }
    const parsed = readCodexSessionById(pinSessionId, null, null)
    const parsedMeta = parsed?.meta
    const meta = parsedMeta ?? cheapCodexMetaFromFile(fp, names)
    if (!meta || (meta.projectPath !== pinProjectPath && !isLegacyCodexProjectPath(pinProjectPath, meta.projectPath))) return null
    return {
      id: pinSessionId,
      projectPath: meta.projectPath,
      projectDisplayName: displayNameForProjectPath(meta.projectPath),
      source: "codex",
      messageCount: parsed?.msgs?.length ?? meta.messageCount ?? countJsonlLines(fp),
      userMessageCount: meta.userMessageCount ?? null,
      firstName: meta.firstName ?? pinSessionId.slice(0, 8),
      lastActivity: meta.lastActivity ?? stat.mtime.toISOString(),
      mtime: stat.mtimeMs,
      customName: names[`${meta.projectPath}/${pinSessionId}`] ?? meta.customName ?? null,
      ...(meta.isSidechain ? {
        isSidechain: true,
        parentSessionId: meta.parentSessionId,
        agentType: meta.agentType,
      } : {}),
    }
  }
  const msgs = loadSessionMessages(pinProjectPath, pinSessionId)
  if (!Array.isArray(msgs) || !msgs.length) return null
  const source = pinProjectPath.match(/^([a-z-]+):/)?.[1] ?? "claude"
  const firstUserText = msgs.find(m => m.message?.role === "user" && typeof m.message?.content === "string")
    ?.message?.content
  const lastActivity = msgs[msgs.length - 1]?.timestamp ?? ""
  return {
    id: pinSessionId,
    projectPath: pinProjectPath,
    projectDisplayName: displayNameForProjectPath(pinProjectPath),
    source,
    messageCount: msgs.length,
    userMessageCount: msgs.filter(m => m.message?.role === "user").length,
    firstName: typeof firstUserText === "string"
      ? firstUserText.replace(/\s+/g, " ").trim().slice(0, 80)
      : pinSessionId.slice(0, 8),
    lastActivity,
    mtime: lastActivity,
    customName: names[`${pinProjectPath}/${pinSessionId}`] ?? null,
  }
}

function upsertSidebarCacheFromLoadedSession(projectPath, sessionId) {
  const names = loadConfig().names ?? {}
  const entry = loadPinnedSessionEntry(projectPath, sessionId, names)
  if (!entry) return
  const { changed, entry: cached } = updateSidebarCacheEntry(sessionId, entry)
  if (changed) sseBroadcastSessionUpserts([cached])
}

function displayNameForProjectPath(projectPath) {
  const withoutSource = String(projectPath ?? "").replace(/^[a-z-]+:/, "")
  const parts = withoutSource.split("/").filter(Boolean)
  return parts[parts.length - 1] || String(projectPath ?? "")
}

function loadProjectsFromSidebarCache(maxSessions, pinSessionId = null, pinProjectPath = null) {
  initSidebarCache()
  const _t0 = performance.now()
  const total = getSidebarSessionCount()
  if (!total) return { projects: [], total: 0 }
  const names = loadConfig().names ?? {}
  const n = Number(maxSessions)
  let entries = Number.isFinite(n) && n > 0 ? getTopSidebarEntries(n) : getAllSidebarEntries()
  if (pinSessionId) {
    const pinned = getSidebarEntry(pinSessionId) ?? loadPinnedSessionEntry(pinProjectPath, pinSessionId, names)
    if (pinned?.id) entries = expandSidebarLinkageEntries([...entries, pinned])
  }
  const projects = sortProjectGroups(groupCacheSessionsToProjects(entries, names))
  const ms = (performance.now() - _t0).toFixed(1)
  debugLog(`[perf ${wallClock()}] loadProjectsFromSidebarCache n=${entries.length}/${total} ${ms}ms`)
  return { projects, total }
}

/** Apply cached counts/names to sessions that are missing them (cheap-scan results). */
function applySidebarCache(sessions) {
  initSidebarCache()
  const map = getSidebarCacheMap()
  for (const s of sessions) {
    const entry = map.get(s.id)
    if (!entry) continue
    // Use cached value whenever the live value is 0/null (cheap-scan placeholder)
    if (!s.messageCount && entry.messageCount) s.messageCount = entry.messageCount
    if (!s.userMessageCount && entry.userMessageCount) s.userMessageCount = entry.userMessageCount
    if (!s.firstName && entry.firstName) s.firstName = entry.firstName
  }
}

/** Upsert a cache entry. Returns { changed, entry }. */
function updateSidebarCacheEntry(sessionId, { projectPath, projectDisplayName, source, messageCount, userMessageCount, firstName, lastActivity, mtime, customName, isSidechain, parentSessionId, agentType }) {
  initSidebarCache()
  const { changed, entry } = upsertSidebarEntry({
    id: sessionId,
    projectPath,
    projectDisplayName,
    source,
    messageCount,
    userMessageCount,
    firstName,
    lastActivity,
    mtime,
    customName,
    isSidechain,
    parentSessionId,
    agentType,
  })
  if (changed) {
    indexSession(entry.projectPath, entry.id, [], {
      id: entry.id,
      customName: entry.customName ?? null,
      firstName: entry.firstName ?? null,
      source: entry.source ?? "claude",
    })
  }
  return { changed, entry }
}

/** Flush updated cache entries from a hydrated projects array. Returns changed entries. */
function flushSidebarCacheFromProjects(projects, fileBySessKey) {
  const changed = []
  for (const p of projects) {
    for (const s of p.sessions) {
      const mtimeMs = fileBySessKey
        ? fileBySessKey.get(SESS_PATH_KEY(p.path, s.id))?.stat?.mtimeMs
        : null
      const { changed: c, entry } = updateSidebarCacheEntry(s.id, {
        projectPath: p.path,
        projectDisplayName: p.displayName,
        source: s.source ?? "claude",
        messageCount: s.messageCount ?? 0,
        userMessageCount: s.userMessageCount ?? null,
        firstName: s.firstName ?? null,
        lastActivity: s.lastActivity,
        mtime: mtimeMs ?? s.lastActivity,
        customName: s.customName ?? null,
        isSidechain: s.isSidechain,
        parentSessionId: s.parentSessionId,
        agentType: s.agentType,
      })
      if (c) changed.push(entry)
    }
  }
  return changed
}

function codexSessionIdFromFile(filePath) {
  const base = basename(filePath, ".jsonl")
  const matches = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
  return matches?.at(-1) ?? base
}

function readJsonlPrefixRows(filePath, maxBytes = 1024 * 1024, maxLines = 100) {
  let fd = null
  try {
    const st = statSync(filePath)
    const len = Math.min(maxBytes, st.size)
    const buf = Buffer.alloc(len)
    fd = openSync(filePath, "r")
    const bytes = readSync(fd, buf, 0, len, 0)
    const text = buf.toString("utf8", 0, bytes)
    return text
      .split("\n")
      .filter(Boolean)
      .slice(0, maxLines)
      .flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
  } catch {
    return []
  } finally {
    if (fd != null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function cheapCodexMetaFromFile(filePath, names) {
  let stat
  try { stat = statSync(filePath) } catch { return null }
  const rows = readJsonlPrefixRows(filePath)
  const sessionMeta = rows.find(r => r?.type === "session_meta")?.payload ?? {}
  const turnContext = rows.find(r => r?.type === "turn_context")?.payload ?? {}
  const sessionId = sessionMeta.id ?? codexSessionIdFromFile(filePath)
  const cwd = sessionMeta.cwd ?? turnContext.cwd ?? ""
  const projectDir = cwd ? normProjectDir(cwd) : "codex-global"
  const projectPath = `codex:${projectDir}`
  const cacheEntry = loadSidebarCache()._map.get(sessionId)
  const isSubagent = sessionMeta.thread_source === "subagent" ||
    (typeof sessionMeta.source === "object" && sessionMeta.source?.subagent != null)
  const parentSessionId = sessionMeta.forked_from_id ??
    sessionMeta.parent_thread_id ??
    sessionMeta.source?.subagent?.thread_spawn?.parent_thread_id ??
    null
  const subagentNickname = sessionMeta.agent_nickname ??
    sessionMeta.source?.subagent?.thread_spawn?.agent_nickname ??
    null
  const firstUser = rows.find(r => r?.type === "event_msg" && r?.payload?.type === "user_message")
  const firstUserText = typeof firstUser?.payload?.message === "string" ? firstUser.payload.message : ""
  const claudeCodexParent = isSubagent ? null : inferClaudeCodexParent({ sessionMeta, turnContext, firstUserText })
  const firstName = isSubagent && typeof subagentNickname === "string" && subagentNickname.trim()
    ? subagentNickname.trim()
    : firstUserText
      ? stripXml(firstUserText).replace(/\s+/g, " ").trim().slice(0, 80)
      : cacheEntry?.firstName ?? null
  return {
    id: sessionId,
    projectPath,
    messageCount: cacheEntry?.messageCount ?? 0,
    userMessageCount: cacheEntry?.userMessageCount ?? null,
    lastActivity: stat.mtime.toISOString(),
    isActive: Date.now() - stat.mtimeMs < FIVE_MIN,
    firstName,
    customName: names[`${projectPath}/${sessionId}`] ?? cacheEntry?.customName ?? null,
    source: "codex",
    version: sessionMeta.cli_version ?? cacheEntry?.version ?? null,
    lastUsedModel: turnContext.model ?? cacheEntry?.lastUsedModel ?? null,
    ...(isSubagent ? { isSidechain: true, parentSessionId, agentType: "subagent" } : {}),
    ...(claudeCodexParent ? {
      isSidechain: true,
      parentSessionId: claudeCodexParent.parentSessionId,
      agentType: claudeCodexParent.agentType,
    } : {}),
  }
}

/** Live-scan Codex rollout files for subagents of a parent (cache backfill on deep links). */
function findCodexSubagentsForParent(parentSessionId, names = {}) {
  if (!parentSessionId || !existsSync(CODEX_SESSIONS_ROOT)) return []
  const out = []
  for (const filePath of listCodexSessionFiles()) {
    const rows = readJsonlPrefixRows(filePath)
    const sessionMeta = rows.find(r => r?.type === "session_meta")?.payload ?? {}
    const parentId = sessionMeta.forked_from_id ??
      sessionMeta.parent_thread_id ??
      sessionMeta.source?.subagent?.thread_spawn?.parent_thread_id ??
      null
    if (parentId !== parentSessionId) continue
    const meta = cheapCodexMetaFromFile(filePath, names)
    if (meta) out.push(meta)
  }
  return out
}

function backfillPinnedSessionLinkage(pinSessionId) {
  if (!pinSessionId) return []
  const pinned = getSidebarEntry(pinSessionId)
  if (!pinned?.id || pinned.isSidechain) return []
  const names = loadConfig().names ?? {}
  const changed = []
  for (const meta of findCodexSubagentsForParent(pinSessionId, names)) {
    const existing = getSidebarEntry(meta.id)
    if (existing?.isSidechain && existing.parentSessionId === pinSessionId) continue
    const { changed: c, entry } = updateSidebarCacheEntry(meta.id, {
      projectPath: meta.projectPath,
      source: meta.source ?? "codex",
      messageCount: meta.messageCount ?? 0,
      userMessageCount: meta.userMessageCount ?? null,
      firstName: meta.firstName ?? null,
      lastActivity: meta.lastActivity,
      mtime: meta.lastActivity,
      isSidechain: meta.isSidechain,
      parentSessionId: meta.parentSessionId,
      agentType: meta.agentType,
    })
    if (c) changed.push(entry)
  }
  return changed
}

function loadRecentCodexProjectsCheap(limit = RECENT_CODEX_SEED_LIMIT) {
  if (!existsSync(CODEX_SESSIONS_ROOT)) return []
  const names = loadConfig().names ?? {}
  const recentFiles = listCodexSessionFiles()
    .flatMap(filePath => {
      try { return [{ filePath, mtimeMs: statSync(filePath).mtimeMs }] } catch { return [] }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, limit))
  const projects = new Map()
  for (const { filePath } of recentFiles) {
    const meta = cheapCodexMetaFromFile(filePath, names)
    if (!meta) continue
    const projectPath = meta.projectPath
    if (!projects.has(projectPath)) {
      projects.set(projectPath, {
        path: projectPath,
        displayName: projectPath,
        sessions: [],
      })
    }
    projects.get(projectPath).sessions.push(meta)
  }
  for (const project of projects.values()) {
    project.sessions.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
  }
  return Array.from(projects.values())
}

function stringifyCodexTailOutput(value) {
  if (typeof value === "string") return value
  if (value == null) return ""
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function codexTailAssistantText(content) {
  if (!Array.isArray(content)) return ""
  return content
    .map(item => item?.type === "output_text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function codexTailReasoningText(payload) {
  if (typeof payload?.content === "string" && payload.content.trim()) return payload.content.trim()
  if (!Array.isArray(payload?.summary)) return ""
  return payload.summary
    .map(part => {
      if (typeof part === "string") return part
      if (typeof part?.text === "string") return part.text
      if (typeof part?.summary_text === "string") return part.summary_text
      return ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function codexTailRowsToMessages(sessionId, rows, fallbackTs) {
  const out = []
  let seq = 0
  // Codex emits each assistant message twice (event_msg agent_message + response_item
  // message); skip the copy from the other stream — see buildCodexSessionResult.
  const assistantSeen = new Map()
  const isDuplicateAssistant = (text, source) => {
    const prev = assistantSeen.get(text)
    if (prev && prev !== source) {
      assistantSeen.delete(text)
      return true
    }
    assistantSeen.set(text, source)
    return false
  }
  const push = msg => {
    out.push({
      ...msg,
      parentUuid: out.length > 0 ? out[out.length - 1].uuid : null,
    })
  }
  for (const row of rows) {
    const ts = typeof row?.timestamp === "string" ? row.timestamp : fallbackTs
    if (row?.type === "event_msg" && row?.payload?.type === "user_message") {
      const text = typeof row.payload.message === "string" ? row.payload.message.trim() : ""
      if (!text) continue
      push({
        uuid: `codex-${sessionId}-tail-u-${seq++}`,
        type: "human",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: { role: "user", content: text },
      })
      continue
    }
    if (row?.type === "event_msg" && row?.payload?.type === "agent_message") {
      const text = typeof row.payload.message === "string" ? row.payload.message.trim() : ""
      if (!text || isDuplicateAssistant(text, "event")) continue
      push({
        uuid: `codex-${sessionId}-tail-a-${seq++}`,
        type: "assistant",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: { role: "assistant", content: text },
      })
      continue
    }
    if (row?.type !== "response_item" || !row?.payload?.type) continue
    if (row.payload.type === "message" && row.payload.role === "assistant") {
      const text = codexTailAssistantText(row.payload.content)
      if (!text || isDuplicateAssistant(text, "response")) continue
      push({
        uuid: `codex-${sessionId}-tail-a-${seq++}`,
        type: "assistant",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: { role: "assistant", content: text },
      })
      continue
    }
    if (row.payload.type === "reasoning") {
      const thinking = codexTailReasoningText(row.payload)
      if (!thinking) continue
      push({
        uuid: `codex-${sessionId}-tail-a-${seq++}`,
        type: "assistant",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "thinking", thinking }] },
      })
      continue
    }
    if (row.payload.type === "function_call") {
      let input = {}
      try { input = JSON.parse(row.payload.arguments ?? "{}") } catch { input = { _raw: row.payload.arguments ?? "" } }
      push({
        uuid: `codex-${sessionId}-tail-a-${seq++}`,
        type: "assistant",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: row.payload.call_id ?? `${sessionId}-tail-tool-${seq}`,
            name: row.payload.name ?? "tool",
            input,
          }],
        },
      })
      continue
    }
    if (row.payload.type === "function_call_output") {
      push({
        uuid: `codex-${sessionId}-tail-u-${seq++}`,
        type: "human",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: row.payload.call_id ?? undefined,
            content: stringifyCodexTailOutput(row.payload.output),
          }],
        },
      })
    }
  }
  return out
}

function readCodexSessionTailFast(projectPath, sessionId, tail) {
  const result = readCodexSessionById(sessionId, null, null)
  if (!result?.meta || !Array.isArray(result.msgs)) return null
  if (result.meta.projectPath !== projectPath && !isLegacyCodexProjectPath(projectPath, result.meta.projectPath)) return null
  const msgs = result.msgs
  if (!msgs.length) return null
  return {
    msgs: msgs.slice(-tail),
    total: msgs.length,
  }
}

// --- Session reading ---

function parseJsonl(fp) {
  const t0 = performance.now()
  const result = parseJsonlStream(fp)
  const ms = (performance.now() - t0).toFixed(1)
  if (parseFloat(ms) > 50) debugWarn(`[perf] parseJsonl ${ms}ms — ${result.length} msgs — ${fp.split("/").pop()}`)
  return result
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

/**
 * Read a Claude subagent's sibling `<basename>.meta.json` if present.
 * Returns { agentType, description } or null. Description is preferred over the
 * (very long) first-prompt body when present.
 */
function readClaudeSubagentMeta(jsonlPath) {
  if (!jsonlPath.endsWith(".jsonl")) return null
  const metaPath = jsonlPath.slice(0, -".jsonl".length) + ".meta.json"
  try {
    const raw = readFileSync(metaPath, "utf8")
    const obj = JSON.parse(raw)
    if (obj && typeof obj === "object") {
      return {
        agentType: typeof obj.agentType === "string" ? obj.agentType : null,
        description: typeof obj.description === "string" ? obj.description : null,
      }
    }
  } catch { /* missing or malformed — fine */ }
  return null
}

/**
 * Pick a display name for a subagent session. Prefers the meta.json description
 * (often concise like "Research ORT protobuf parsing failure") and falls back to
 * the truncated first user prompt body.
 */
function pickClaudeSubagentFirstName(jsonlPath, meta) {
  if (meta?.description?.trim()) return meta.description.trim().slice(0, 100)
  return cheapReadFirstUserMsg(jsonlPath)
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

/** Full project list without full Claude JSONL parsing — search uses rg/content search. */
async function loadProjectsFull() {
  const names = loadConfig().names ?? {}
  const { projects } = scanClaudeProjectsCheap(names)

  const allProjects = [
    ...projects,
    ...await loadPlatformProjectsHybrid(),
  ]

  return allProjects.sort((a, b) => {
    const aLast = a.sessions[0]?.lastActivity ?? ""
    const bLast = b.sessions[0]?.lastActivity ?? ""
    return bLast.localeCompare(aLast)
  })
}

const SESS_PATH_KEY = (projectPath, sessionId) => `${projectPath}\x1f${sessionId}`

/**
 * Scan a Claude project's subagent storage.
 *
 * Layout per parent session:
 *   <project>/<parentSessionId>/subagents/agent-<agentId>.jsonl           — direct subagent
 *   <project>/<parentSessionId>/subagents/agent-<agentId>.meta.json
 *   <project>/<parentSessionId>/subagents/workflows/wf_<wfId>/agent-<agentId>.jsonl
 *   <project>/<parentSessionId>/subagents/workflows/wf_<wfId>/agent-<agentId>.meta.json
 *
 * Returns session rows keyed by full relative path inside `projectPath` so that
 * `join(projectPath, sessionId + ".jsonl")` resolves the file. Each row is
 * flagged `isSidechain: true` with `parentSessionId` set so the sidebar groups
 * them under their parent.
 */
function scanClaudeSubagents(projectPath, names) {
  const out = []
  let entries
  try { entries = readdirSync(projectPath) } catch { return out }

  for (const parentSessionId of entries) {
    if (!parentSessionId) continue
    if (parentSessionId.endsWith(".jsonl")) continue
    const parentDir = join(projectPath, parentSessionId)
    let parentStat
    try { parentStat = statSync(parentDir) } catch { continue }
    if (!parentStat.isDirectory()) continue

    const subDir = join(parentDir, "subagents")
    let subEntries
    try { subEntries = readdirSync(subDir) } catch { continue }

    for (const subEntry of subEntries) {
      const subEntryPath = join(subDir, subEntry)
      let subStat
      try { subStat = statSync(subEntryPath) } catch { continue }

      if (subStat.isFile() && subEntry.startsWith("agent-") && subEntry.endsWith(".jsonl")) {
        // Direct subagent: <parentSessionId>/subagents/agent-<id>.jsonl
        const id = `${parentSessionId}/subagents/${subEntry.slice(0, -".jsonl".length)}`
        out.push({ id, parentSessionId, filePath: subEntryPath, stat: subStat, workflowId: null })
        continue
      }

      if (subStat.isDirectory() && subEntry === "workflows") {
        // Dynamic-workflow subagents: <parentSessionId>/subagents/workflows/wf_<wfId>/agent-<id>.jsonl
        let wfEntries
        try { wfEntries = readdirSync(subEntryPath) } catch { continue }
        for (const wfId of wfEntries) {
          if (!wfId.startsWith("wf_")) continue
          const wfDir = join(subEntryPath, wfId)
          let wfStat
          try { wfStat = statSync(wfDir) } catch { continue }
          if (!wfStat.isDirectory()) continue
          let agentEntries
          try { agentEntries = readdirSync(wfDir) } catch { continue }
          for (const agentFile of agentEntries) {
            if (!agentFile.startsWith("agent-") || !agentFile.endsWith(".jsonl")) continue
            const agentPath = join(wfDir, agentFile)
            let agentStat
            try { agentStat = statSync(agentPath) } catch { continue }
            const id = `${parentSessionId}/subagents/workflows/${wfId}/${agentFile.slice(0, -".jsonl".length)}`
            out.push({ id, parentSessionId, filePath: agentPath, stat: agentStat, workflowId: wfId })
          }
        }
      }
    }
  }
  return out
}

/**
 * One Claude project directory under a scan root. Fills `fileBySessKey`; returns a project row or null.
 */
function scanOneClaudeFolder(root, label, dir, names, fileBySessKey) {
  const dp = join(root, dir)
  try { if (!statSync(dp).isDirectory()) return null } catch { return null }
  const projectPath = `${root}/${dir}`
  const cacheMap = loadSidebarCache()._map
  const sessions = []
  let topLevelJsonl = []
  try { topLevelJsonl = readdirSync(dp).filter(f => f.endsWith(".jsonl")) } catch { /* ignore */ }

  for (const f of topLevelJsonl) {
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

  // Subagent sessions: same project, flagged as sidechains of their parent session
  for (const sub of scanClaudeSubagents(projectPath, names)) {
    fileBySessKey.set(SESS_PATH_KEY(projectPath, sub.id), { fp: sub.filePath, stat: sub.stat })
    const cachedEntry = cacheMap.get(sub.id)
    const meta = readClaudeSubagentMeta(sub.filePath)
    const firstName =
      cachedEntry?.firstName ??
      pickClaudeSubagentFirstName(sub.filePath, meta)
    const sessionId = sub.id
    sessions.push({
      id: sessionId,
      projectPath,
      lastActivity: sub.stat.mtime.toISOString(),
      version: undefined,
      gitBranch: undefined,
      isActive: Date.now() - sub.stat.mtimeMs < FIVE_MIN,
      userMessageCount: cachedEntry?.userMessageCount ?? null,
      messageCount: cachedEntry?.messageCount ?? 0,
      firstName,
      customName: names[`${projectPath}/${sessionId}`] ?? null,
      source: "claude",
      isSidechain: true,
      parentSessionId: sub.parentSessionId,
      agentType: meta?.agentType ?? cachedEntry?.agentType ?? "subagent",
    })
  }

  if (!sessions.length) return null
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

function sseEmitSessionUpserts(res, entries) {
  if (!entries.length || res.destroyed) return
  const names = loadConfig().names ?? {}
  for (const entry of expandSidebarLinkageEntries(entries)) {
    sseWrite(res, "session_upsert", sessionUpsertPayload(entry, names))
  }
  sseWrite(res, "projects_meta", { total: getSidebarSessionCount() })
}

function sseBroadcastSessionUpserts(entries) {
  if (!entries.length || sseClients.size === 0) return
  const names = loadConfig().names ?? {}
  const total = getSidebarSessionCount()
  const payloads = expandSidebarLinkageEntries(entries).map(e => sessionUpsertPayload(e, names))
  for (const c of sseClients) {
    try {
      for (const payload of payloads) {
        c.res.write(`event: session_upsert\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      c.res.write(`event: projects_meta\ndata: ${JSON.stringify({ total })}\n\n`)
    } catch {
      sseClients.delete(c)
    }
  }
}

function sseWriteSessionRemove(res, entry) {
  sseWrite(res, "session_remove", {
    sessionId: entry.id,
    projectPath: entry.projectPath,
  })
}

function sseBroadcastSessionRemove(entry) {
  if (!entry || sseClients.size === 0) return
  const total = getSidebarSessionCount()
  for (const c of sseClients) {
    try {
      sseWriteSessionRemove(c.res, entry)
      c.res.write(`event: projects_meta\ndata: ${JSON.stringify({ total })}\n\n`)
    } catch {
      sseClients.delete(c)
    }
  }
}

function yieldEventLoopTick() {
  return new Promise(r => setTimeout(r, 0))
}

/** Parse and index every Claude JSONL under `fileBySessKey` (yields so the event loop stays responsive). */
async function backgroundIndexAllClaudeJsonl(fileBySessKey, names) {
  let i = 0
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
      updateSidebarCacheEntry(sessionId, {
        messageCount: meta.messageCount,
        userMessageCount: meta.userMessageCount,
        firstName: meta.firstName ?? null,
        mtime: stat.mtimeMs,
      })
    } catch { /* ignore bad files */ }
    if (++i % 20 === 0) {
      debugLog(`[perf ${wallClock()}] backgroundIndex batch i=${i} batchParseMs=${_batchParseMs.toFixed(0)} batchTotalMs=${(performance.now()-_tBatch0).toFixed(0)}`)
      _batchParseMs = 0
      await yieldEventLoopTick()
    }
  }
  debugLog(`[perf ${wallClock()}] backgroundIndex done i=${i} totalMs=${(performance.now()-_tBatch0).toFixed(0)}`)
}

function scheduleClaudeJsonlIndexing(fileBySessKey, names) {
  if (!ENABLE_BACKGROUND_INDEXER) return
  setImmediate(async () => {
    await backgroundIndexAllClaudeJsonl(fileBySessKey, names)
  })
}

/**
 * Load one platform in a dedicated worker thread.
 * Returns a Promise that resolves to { platform, projects } when the worker finishes.
 * The worker runs in its own V8 isolate, so blocking I/O never stalls the main thread.
 */
// Worker pool: at most MAX_PLATFORM_WORKERS V8 isolates alive at once (RSS control).
const MAX_PLATFORM_WORKERS = 5
let _activePlatformWorkers = 0
const _platformWorkerQueue = []
function _acquireWorkerSlot() {
  if (_activePlatformWorkers < MAX_PLATFORM_WORKERS) {
    _activePlatformWorkers++
    return Promise.resolve()
  }
  return new Promise(r => _platformWorkerQueue.push(r))
}
function _releaseWorkerSlot() {
  const next = _platformWorkerQueue.shift()
  if (next) next()
  else _activePlatformWorkers--
}

async function loadPlatformInWorker(platform) {
  await _acquireWorkerSlot()
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      _releaseWorkerSlot()
      resolve(result)
    }
    const worker = new Worker(PLATFORM_LOADER_WORKER, {
      workerData: { platform },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
    })
    worker.once("message", ({ platform: p, sessions = [], error }) => {
      if (error) console.error(`[platform-worker] ${p}: ${error}`)
      const projects = resultsToProjects(sessions, p)
      done({ platform: p, projects })
    })
    worker.once("error", err => {
      console.error(`[platform-worker] ${platform} worker error:`, err.message)
      done({ platform, projects: [] })
    })
  })
}

async function loadPlatformProjectsInWorkers() {
  const results = await Promise.all(BUNDLE_PLATFORM_WORKERS.map(platform => loadPlatformInWorker(platform)))
  return results.flatMap(({ projects }) => projects)
}

async function loadPlatformProjectsHybrid() {
  return loadPlatformProjectsInWorkers()
}

/** Progressive recent sidebar: cache-only burst from SQLite, then background session deltas. */
async function streamRecentSidebarInitial(res, maxSessions, pinSessionId = null, pinProjectPath = null) {
  const _tBurst0 = performance.now()
  const { projects, total } = loadProjectsFromSidebarCache(maxSessions, pinSessionId, pinProjectPath)
  if (projects.length) {
    sseWrite(res, "projects", projects)
    sseWrite(res, "projects_meta", { total })
  }
  if (pinSessionId && !projects.some(project => project.sessions.some(session => session.id === pinSessionId))) {
    sseWriteSessionRemove(res, { id: pinSessionId, projectPath: pinProjectPath })
  }
  sseWrite(res, "bootstrap_done", {})
  debugLog(`[perf ${wallClock()}] streamRecent burst: ${projects.length} projects, total=${total}, ${(performance.now() - _tBurst0).toFixed(1)}ms`)

  // Everything after this is delayed so deep-linked session fetches win the event loop.
  setTimeout(async () => {
    if (res.destroyed) return
    const _tBg0 = performance.now()
    debugLog(`[perf ${wallClock()}] streamRecent bg-start`)
    const names = loadConfig().names ?? {}
    /** @type {Map<string, { fp: string, stat: import('fs').Stats }>} */
    const fileBySessKey = new Map()
    let acc = []

    const emitCacheDeltas = (projects) => {
      const changed = flushSidebarCacheFromProjects(projects, null)
      sseEmitSessionUpserts(res, changed)
    }

    // Launch all platform workers immediately so they run concurrently with the Claude scan.
    const _platformT0 = performance.now()
    // pendingWorkers: Map<platform, Promise<{platform, projects}>>
    const pendingWorkers = new Map(
      STREAM_PLATFORM_WORKERS.map(p => [p, loadPlatformInWorker(p)])
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
          debugLog(`[perf ${wallClock()}] platform-worker ${platform}: ${ms}ms → ${projects.length} projects`)
          if (!projects.length) return
          acc = mergeProjectsInto(acc, projects)
          emitCacheDeltas(projects)
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
        emitCacheDeltas([chunk])
        await yieldEventLoopTick()
      }
    }
    debugLog(`[perf ${wallClock()}] streamRecent claude-scan done: ${(performance.now()-_tBg0).toFixed(0)}ms, ${fileBySessKey.size} sessions`)

    // Wait for all platform workers, streaming any that haven't arrived yet
    for (const promise of pendingWorkers.values()) {
      if (res.destroyed) break
      const { platform, projects } = await promise
      if (merged.has(platform)) continue  // already streamed via mergeReady()
      merged.add(platform)
      const ms = (performance.now() - _platformT0).toFixed(0)
      debugLog(`[perf ${wallClock()}] platform-worker ${platform} (late): ${ms}ms → ${projects.length} projects`)
      if (!projects.length) continue
      acc = mergeProjectsInto(acc, projects)
      emitCacheDeltas(projects)
      await yieldEventLoopTick()
    }

    // Hydrate full metadata (message counts, accurate firstName) for the most recent Claude sessions.
    const hydrateN = maxSessions ?? 50
    const forHydration = hydrateN > 0
      ? trimProjectsByRecentSessionCount(acc, hydrateN)
      : sortProjectGroups(acc)
    const _tHydrate = performance.now()
    await hydrateClaudeSessionsInProjects(forHydration, fileBySessKey, names)
    debugLog(`[perf ${wallClock()}] streamRecent hydrate done: ${(performance.now()-_tHydrate).toFixed(0)}ms`)
    const hydratedChanged = flushSidebarCacheFromProjects(forHydration, fileBySessKey)
    sseEmitSessionUpserts(res, hydratedChanged)
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
    scheduleClaudeJsonlIndexing(fileBySessKey, names)
    if (!res.destroyed) sseWrite(res, "background_done", {})
  }, STREAM_BACKGROUND_DELAY_MS)
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
      if (msgCacheHas(cacheKey)) {
        const entry = msgCacheGetEntry(cacheKey)
        const meta = claudeSessionMetaFromMsgs(entry.msgs, s.id, s.projectPath, names, rec.stat)
        meta.messageCount = entry.total
        p.sessions[i] = meta
      } else if (s.firstName) {
        // firstName already known (cached or cheap-read during scan) — just count lines, no full parse
        p.sessions[i] = {
          ...s,
          messageCount: countJsonlLines(rec.fp),
          customName: names[`${s.projectPath}/${s.id}`] ?? s.customName ?? null,
        }
      } else {
        p.sessions[i] = {
          ...s,
          firstName: cheapReadFirstUserMsg(rec.fp),
          messageCount: countJsonlLines(rec.fp),
          customName: names[`${s.projectPath}/${s.id}`] ?? s.customName ?? null,
        }
      }
      await yieldEventLoopTick()
    }
    if (p.sessions.length) {
      p.sessions.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))
    }
  }
}

/** Instant sidebar slice from in-memory/disk cache (updated by workers, watchers, broadcasts). */
function loadProjectsBundleCached(maxSessions) {
  return loadProjectsFromSidebarCache(maxSessions)
}

/** Full rescan — trim using file mtime, then parse JSONL only for sessions kept. */
async function loadProjectsBundleRecent(maxSessions) {
  const names = loadConfig().names ?? {}
  const { projects: claudeProjects, fileBySessKey } = scanClaudeProjectsCheap(names)
  const allProjects = [
    ...claudeProjects,
    ...await loadPlatformProjectsHybrid(),
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
  return loadProjectsBundleCached(n) // sync — sidebar cache only
}

// ── Hot-session tail cache (top N recently viewed; tail window, not full parse) ─
// Matches frontend windowing: MAX_DOM=180, CHUNK=60 → keep ~240 msgs from session end.
const MSG_CACHE_MAX = 12
const MSG_CACHE_TAIL = 240
const msgCache = new Map() // key → { msgs: SessionMessage[], total: number }

function makeMsgCacheEntry(msgs, total) {
  const t = total ?? msgs.length
  const tailMsgs = msgs.length > MSG_CACHE_TAIL ? msgs.slice(-MSG_CACHE_TAIL) : msgs
  return { msgs: tailMsgs, total: t }
}

function msgCacheTouch(key, entry) {
  if (msgCache.has(key)) msgCache.delete(key)
  msgCache.set(key, entry)
  while (msgCache.size > MSG_CACHE_MAX) {
    const oldest = msgCache.keys().next().value
    msgCache.delete(oldest)
  }
}

function msgCachePeek(key) {
  return msgCache.get(key)
}

function msgCacheGetEntry(key) {
  const entry = msgCache.get(key)
  if (!entry) return undefined
  msgCacheTouch(key, entry)
  return entry
}

/** True when cached tail window can satisfy tail/skip without disk. */
function msgCacheCovers(entry, tail, skip) {
  if (!entry?.msgs?.length) return false
  if (!tail) return entry.msgs.length >= entry.total
  return skip + tail <= entry.msgs.length
}

function msgCacheSlice(entry, tail, skip) {
  const { msgs, total } = entry
  if (!tail) return { msgs, total }
  const end = msgs.length - skip
  const start = Math.max(0, end - tail)
  return { msgs: msgs.slice(start, end > 0 ? end : 0), total }
}

function msgCacheSet(key, msgs, total) {
  if (!Array.isArray(msgs) || !msgs.length) return
  msgCacheTouch(key, makeMsgCacheEntry(msgs, total))
}

function msgCacheHas(key) {
  return msgCache.has(key)
}

function msgCacheDelete(key) {
  msgCache.delete(key)
}

function msgCacheEstimatedKb() {
  let bytes = 0
  for (const { msgs } of msgCache.values()) {
    try { bytes += JSON.stringify(msgs).length } catch { /* ignore */ }
  }
  return Math.round(bytes / 1024)
}

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
  if (projectPath.startsWith("antigravity-cli:")) {
    for (const { meta, msgs } of readAntigravityCliSessions(null, null)) {
      if (meta.id === sessionId) return msgs
    }
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

function loadRecentChatContext(chatLimit = 4, messagesPerChat = 6) {
  initSidebarCache()
  const requested = Math.max(chatLimit * 3, chatLimit)
  const entries = getTopSidebarEntries(requested)
  const primary = entries.filter(entry => !entry.isSidechain)
  const selected = (primary.length >= chatLimit ? primary : entries).slice(0, chatLimit)
  const chats = []
  for (const entry of selected) {
    const messages = loadSessionMessagesOndemand(entry.projectPath, entry.id)
    if (!Array.isArray(messages) || messages.length === 0) continue
    const conversational = messages.filter(message => {
      const role = message?.message?.role
      return role === "user" || role === "assistant" || message?.type === "human" || message?.type === "assistant"
    })
    chats.push({
      sessionId: entry.id,
      projectPath: entry.projectPath,
      source: entry.source ?? "claude",
      title: entry.customName || entry.firstName || entry.id.slice(0, 8),
      lastActivity: entry.lastActivity ?? entry.mtime ?? null,
      messages: conversational.slice(-messagesPerChat),
    })
  }
  return chats
}

function getActiveSessionEntries(limit = 4) {
  initSidebarCache()
  return getTopSidebarEntries(Math.max(limit * 5, limit))
    .filter(entry => !entry.isSidechain && isActivelyUpdating(entry))
    .slice(0, limit)
}

function loadLiveSummaryTail(entry) {
  const cacheKey = `${entry.projectPath}/${entry.id}`
  const cached = msgCachePeek(cacheKey)
  if (cached?.msgs?.length) return cached.msgs
  if (entry.projectPath.startsWith("codex:")) {
    const filePath = findCodexSessionFile(entry.id)
    if (!filePath) return null
    const rows = readJsonlTail(filePath, 500)
    return codexTailRowsToMessages(entry.id, rows, entry.lastActivity ?? new Date().toISOString())
  }
  if (entry.source === "claude" || entry.projectPath.startsWith("/")) {
    const filePath = entry.projectPath.startsWith("/")
      ? join(entry.projectPath, `${entry.id}.jsonl`)
      : join(CLAUDE_DIR, entry.projectPath, `${entry.id}.jsonl`)
    return existsSync(filePath) ? readJsonlTail(filePath, 120) : null
  }
  return loadSessionMessagesOndemand(entry.projectPath, entry.id)
}

function collectActiveSessionPreviews(limit = 4) {
  const startedAt = performance.now()
  const sessions = []
  for (const entry of getActiveSessionEntries(limit)) {
    const messages = loadLiveSummaryTail(entry)
    if (!Array.isArray(messages) || messages.length === 0) continue
    sessions.push(buildLiveSessionPreview(entry, messages))
  }
  return { sessions, collectionMs: Math.round(performance.now() - startedAt) }
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function streamOpenAILiveSummary(res, sessions) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured on the local transcript server")
  const context = compressLiveSummaryContext(sessions)
  const model = process.env.AGENT_SUMMARY_OPENAI_MODEL || "gpt-5.6-luna"
  const startedAt = performance.now()
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(openAILiveSummaryBody(context, model)),
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload?.error?.message || `OpenAI summary failed (${response.status})`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let firstTokenMs = null
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split("\n\n")
    buffer = chunks.pop() ?? ""
    for (const chunk of chunks) {
      const eventName = chunk.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim() || "message"
      const raw = chunk.split("\n").filter(line => line.startsWith("data:")).map(line => line.replace(/^data:\s?/, "")).join("\n")
      if (!raw || raw === "[DONE]") continue
      const payload = JSON.parse(raw)
      if (eventName === "error" || payload?.error) throw new Error(payload?.error?.message || payload?.message || "OpenAI stream failed")
      const delta = openAIStreamDelta(eventName, payload)
      if (delta) {
        firstTokenMs ??= Math.round(performance.now() - startedAt)
        writeSse(res, "delta", { text: delta })
      }
    }
  }
  return { model, contextChars: context.length, firstTokenMs, generationMs: Math.round(performance.now() - startedAt) }
}

function withTranscriptResearchContext(sessionContext = {}, { includeRecentChats = false } = {}) {
  return {
    ...sessionContext,
    transcriptScope: "all",
    transcriptLocations: getTranscriptReadLocations(),
    ...(includeRecentChats ? { recentChats: loadRecentChatContext() } : {}),
  }
}

function loadRecentPlans(limit = 8) {
  initSidebarCache()
  const entries = getTopSidebarEntries(Math.max(limit * 3, limit))
  const plans = []
  for (const entry of entries) {
    if (entry.isSidechain || plans.length >= limit) continue
    const messages = loadLiveSummaryTail(entry)
    if (!Array.isArray(messages)) continue
    const plan = extractLatestPlan(messages)
    if (!plan) continue
    plans.push({
      sessionId: entry.id,
      projectPath: entry.projectPath,
      source: entry.source ?? "claude",
      title: entry.customName || entry.firstName || entry.id.slice(0, 8),
      lastActivity: entry.lastActivity ?? entry.mtime ?? null,
      ...plan,
    })
  }
  return plans
}

/** Full message array for a session (no tail windowing). */
function getSessionMessagesAll(projectPath, sessionId) {
  if (projectPath.startsWith("cursor:")) {
    return readCursorSessionMsgs(sessionId).msgs
  }
  const cacheKey = `${projectPath}/${sessionId}`
  const cached = msgCachePeek(cacheKey)
  if (cached && cached.msgs.length >= cached.total) return cached.msgs
  const ondemand = loadSessionMessagesOndemand(projectPath, sessionId)
  if (ondemand != null) return ondemand
  if (
    /^(opencode|codex|hermes|antigravity|antigravity-cli|cursor-agent|openclaw):/.test(projectPath) &&
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
  const source = projectPath.includes(":") && !projectPath.startsWith("/") ? projectPath.split(":")[0] : "claude"
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
    const { id, projectPath } = meta
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

// ── Antigravity CLI sessions ───────────────────────────────────────────────────

function loadAntigravityCliSessions() {
  if (!existsSync(ANTIGRAVITY_CLI_DIR)) return []
  return resultsToProjects(readAntigravityCliSessions(null, null), "antigravity-cli")
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

/** Broadcast session deltas to all SSE clients (used when we lack per-session entry). */
function broadcastProjectsFromCache() {
  // Legacy hook for platform watchers — no-op; per-session upserts are sent from update paths.
}

async function broadcastProjects() {
  broadcastProjectsFromCache()
}

// Watch ~/.claude/projects for file changes; update search index for changed JSONL files.
function handleClaudeFileChange(filename) {
  if (!filename || !filename.endsWith(".jsonl")) { broadcastProjects(); return }
  // filename is relative to ~/.claude/projects:
  //   "<projectDir>/<sessionId>.jsonl"                                 — top-level session
  //   "<projectDir>/<parentSessionId>/subagents/agent-<id>.jsonl"     — direct subagent
  //   "<projectDir>/<parentSessionId>/subagents/workflows/wf_<wfId>/agent-<id>.jsonl" — workflow subagent
  const parts = filename.split(/[\\/]/)
  if (parts.length < 2) { broadcastProjects(); return }

  let projectDir, sessionId, parentSessionId
  if (parts.length >= 5 && parts[parts.length - 3] === "subagents" && parts[parts.length - 2].startsWith("workflows")) {
    // .../<projectDir>/<parentSessionId>/subagents/workflows/wf_<wfId>/agent-<id>.jsonl
    const leaf = parts[parts.length - 1].replace(".jsonl", "")
    const wfId = parts[parts.length - 2]
    const parent = parts[parts.length - 4]
    projectDir = parts.slice(0, -4).join("/")
    parentSessionId = parent
    sessionId = `${parent}/subagents/workflows/${wfId}/${leaf}`
  } else if (parts.length >= 4 && parts[parts.length - 2] === "subagents") {
    // .../<projectDir>/<parentSessionId>/subagents/agent-<id>.jsonl
    const leaf = parts[parts.length - 1].replace(".jsonl", "")
    const parent = parts[parts.length - 3]
    projectDir = parts.slice(0, -3).join("/")
    parentSessionId = parent
    sessionId = `${parent}/subagents/${leaf}`
  } else {
    // .../<projectDir>/<sessionId>.jsonl
    sessionId = parts[parts.length - 1].replace(".jsonl", "")
    projectDir = parts.slice(0, -1).join("/")
  }
  const projectPath = join(CLAUDE_DIR, projectDir)
  const fp = join(projectPath, `${sessionId}.jsonl`)
  if (!existsSync(fp)) {
    removeSession(projectPath, sessionId)
    const deleted = deleteSidebarEntry(sessionId)
    if (deleted) sseBroadcastSessionRemove(deleted)
    return
  }
  try {
    const _t0 = performance.now()
    const stat = statSync(fp)
    const names = loadConfig().names ?? {}
    const cachedEntry = loadSidebarCache()._map.get(sessionId)
    const meta = readClaudeSubagentMeta(fp)
    const firstName =
      cachedEntry?.firstName ??
      pickClaudeSubagentFirstName(fp, meta)
    const messageCount = countJsonlLines(fp)
    if (!hasClaudeTranscriptMessage(fp)) {
      removeSession(projectPath, sessionId)
      const deleted = deleteSidebarEntry(sessionId)
      if (deleted) sseBroadcastSessionRemove(deleted)
      return
    }
    const _tRead = performance.now()
    msgCacheDelete(`${projectPath}/${sessionId}`)
    const sessionMeta = {
      id: sessionId,
      projectPath,
      lastActivity: stat.mtime.toISOString(),
      isActive: Date.now() - stat.mtimeMs < FIVE_MIN,
      userMessageCount: cachedEntry?.userMessageCount ?? null,
      messageCount,
      firstName,
      customName: names[`${projectPath}/${sessionId}`] ?? null,
      source: "claude",
      ...(parentSessionId
        ? {
            isSidechain: true,
            parentSessionId,
            agentType: meta?.agentType ?? cachedEntry?.agentType ?? "subagent",
          }
        : {}),
    }
    const _tMeta = performance.now()
    indexSession(projectPath, sessionId, [], sessionMeta)
    // lancedb removed
    const _tIndex = performance.now()
    // Update sidebar cache so the next broadcast reflects new mtime + message count
    const projectDisplayName = encodedDirToDisplayName(projectDir)
    const { changed, entry } = updateSidebarCacheEntry(sessionId, {
      projectPath,  // absolute path — matches what scanOneClaudeFolder uses
      projectDisplayName,
      source: "claude",
      messageCount: sessionMeta.messageCount,
      userMessageCount: sessionMeta.userMessageCount ?? null,
      firstName: sessionMeta.firstName ?? null,
      lastActivity: stat.mtime.toISOString(),
      mtime: stat.mtimeMs,
      customName: sessionMeta.customName ?? null,
      isSidechain: !!parentSessionId,
      parentSessionId: parentSessionId ?? null,
      agentType: sessionMeta.agentType ?? "subagent",
    })
    if (changed) sseBroadcastSessionUpserts([entry])
    const _tDone = performance.now()
    if (_tDone - _t0 > 20) {
      debugLog(`[perf ${wallClock()}] handleClaudeFileChange ${sessionId.slice(0,8)} read:${(_tRead-_t0).toFixed(1)}ms meta:${(_tMeta-_tRead).toFixed(1)}ms index:${(_tIndex-_tMeta).toFixed(1)}ms cache:${(_tDone-_tIndex).toFixed(1)}ms total:${(_tDone-_t0).toFixed(1)}ms lines:${messageCount}`)
    }
  } catch { /* ignore */ }
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

if (existsSync(ANTIGRAVITY_BRAIN_DIR)) {
  try {
    watch(ANTIGRAVITY_BRAIN_DIR, { recursive: true }, () => broadcastProjects())
  } catch {
    try {
      watch(ANTIGRAVITY_BRAIN_DIR, () => broadcastProjects())
    } catch { /* ignore */ }
  }
}

if (existsSync(ANTIGRAVITY_CLI_DIR)) {
  try {
    watch(join(ANTIGRAVITY_CLI_DIR, "brain"), { recursive: true }, () => broadcastProjects())
  } catch {
    try {
      watch(ANTIGRAVITY_CLI_DIR, { recursive: true }, () => broadcastProjects())
    } catch { /* ignore */ }
  }
}

// Watch ~/.codex/sessions: upsert the changed rollout file into the sidebar cache and push over SSE.
function handleCodexFileChange(filename) {
  if (!filename || !filename.endsWith(".jsonl")) return
  const fp = join(CODEX_SESSIONS_ROOT, filename)
  if (!existsSync(fp)) return
  try {
    const names = loadConfig().names ?? {}
    const meta = cheapCodexMetaFromFile(fp, names)
    if (!meta?.id) return
    const { changed, entry } = updateSidebarCacheEntry(meta.id, {
      projectPath: meta.projectPath,
      projectDisplayName: displayNameForProjectPath(meta.projectPath),
      source: "codex",
      messageCount: meta.messageCount ?? 0,
      userMessageCount: meta.userMessageCount ?? null,
      firstName: meta.firstName ?? null,
      lastActivity: meta.lastActivity,
      mtime: meta.lastActivity,
      customName: meta.customName ?? null,
      isSidechain: meta.isSidechain,
      parentSessionId: meta.parentSessionId,
      agentType: meta.agentType,
    })
    if (changed) sseBroadcastSessionUpserts([entry])
  } catch { /* ignore */ }
}

if (existsSync(CODEX_SESSIONS_ROOT)) {
  try {
    watch(CODEX_SESSIONS_ROOT, { recursive: true }, (_evt, filename) => handleCodexFileChange(filename))
  } catch { /* ignore */ }
}

// Safety net for platforms without (working) fs watchers: refresh all platform
// readers in worker threads every few minutes and flush deltas into the sidebar cache.
const PLATFORM_REFRESH_MS = Number(process.env.PLATFORM_REFRESH_MS ?? 5 * 60 * 1000)
let _platformRefreshRunning = false
setInterval(async () => {
  if (_platformRefreshRunning) return
  _platformRefreshRunning = true
  try {
    const projects = await loadPlatformProjectsInWorkers()
    const changed = flushSidebarCacheFromProjects(projects, null)
    if (changed.length) sseBroadcastSessionUpserts(changed)
    debugLog(`[refresh ${wallClock()}] periodic platform refresh: ${changed.length} sidebar deltas`)
  } catch (e) {
    debugLog(`[refresh ${wallClock()}] periodic platform refresh failed: ${e.message}`)
  } finally {
    _platformRefreshRunning = false
  }
}, PLATFORM_REFRESH_MS).unref()

// Memory watchdog: alert when RSS exceeds the cap, but keep the process alive for inspection.
const WATCHDOG_MAX_RSS_MB = Number(process.env.WATCHDOG_MAX_RSS_MB ?? 2000)
let _watchdogAlerted = false
setInterval(() => {
  const rssMb = process.memoryUsage().rss / (1024 * 1024)
  if (rssMb > WATCHDOG_MAX_RSS_MB && !_watchdogAlerted) {
    _watchdogAlerted = true
    const message = `Agent Session Viewer RSS is ${rssMb.toFixed(0)} MB, above the ${WATCHDOG_MAX_RSS_MB} MB cap. Process ${process.pid} is still running for inspection.`
    console.error(`[watchdog] ${message}`)
    execFile("osascript", [
      "-e",
      `display alert "Agent Session Viewer high memory" message ${JSON.stringify(message)} as warning`,
    ], () => {})
  }
}, 60_000).unref()

// Lazy backfill: claude sidebar entries with unknown userMessageCount render "?" in the UI
// (background indexer is disabled, so cheap-scanned sessions never get a count).
// Sweep them with two ripgrep line counts per batch — no JSONL parsing.
function rgCountPerFile(pattern, files) {
  return new Promise(resolve => {
    execFile("rg", ["-c", "--no-config", "--no-ignore", pattern, ...files], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const counts = new Map()
      // exit 1 = no matches (fine); other errors → empty map
      for (const line of String(stdout ?? "").split("\n")) {
        const sep = line.lastIndexOf(":")
        if (sep > 0) counts.set(line.slice(0, sep), Number(line.slice(sep + 1)) || 0)
      }
      resolve(counts)
    })
  })
}

let _userCountBackfillRunning = false
async function backfillClaudeUserCounts() {
  if (_userCountBackfillRunning) return
  _userCountBackfillRunning = true
  try {
    const todo = []
    for (const e of getAllSidebarEntries()) {
      if ((e.source ?? "claude") !== "claude" || e.userMessageCount != null || e.isSidechain) continue
      const fp = join(e.projectPath, `${e.id}.jsonl`)
      if (existsSync(fp)) todo.push({ entry: e, fp })
    }
    if (!todo.length) return
    const changed = []
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50)
      const files = batch.map(b => b.fp)
      const userRows = await rgCountPerFile('"type":"user"', files)
      const toolResultRows = await rgCountPerFile('"type":"user".*"tool_result"', files)
      for (const { entry: e, fp } of batch) {
        const count = Math.max(0, (userRows.get(fp) ?? 0) - (toolResultRows.get(fp) ?? 0))
        const { changed: c, entry } = updateSidebarCacheEntry(e.id, { ...e, userMessageCount: count })
        if (c) changed.push(entry)
      }
      await yieldEventLoopTick()
    }
    if (changed.length) sseBroadcastSessionUpserts(changed)
    debugLog(`[backfill ${wallClock()}] userMessageCount: ${changed.length}/${todo.length} entries updated`)
  } catch (e) {
    debugLog(`[backfill ${wallClock()}] userMessageCount failed: ${e.message}`)
  } finally {
    _userCountBackfillRunning = false
  }
}
setTimeout(backfillClaudeUserCounts, 20_000).unref()        // after startup settles
setInterval(backfillClaudeUserCounts, 10 * 60 * 1000).unref() // catch new cheap-scanned sessions

// SSE keepalive: ping every 30s so dead clients error out and get reaped
// (also keeps idle tunnel connections from buffering/timing out).
setInterval(() => {
  for (const c of sseClients) {
    if (c.res.destroyed) { sseClients.delete(c); continue }
    try { c.res.write(": ping\n\n") } catch { sseClients.delete(c) }
  }
}, 30_000).unref()

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

// --- Event-loop lag detector (debug only) ---
if (isDebugTrace()) {
  let _lastHb = Date.now()
  setInterval(() => {
    const now = Date.now()
    const lag = now - _lastHb - 500
    if (lag > 200) debugLog(`[perf ${wallClock()}] ⚠ event-loop lag ${lag}ms`)
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

  // GET /api/health — lightweight diagnostics (no auth)
  if (url.pathname === "/api/health") {
    const mem = process.memoryUsage()
    json({
      ok: true,
      git: {
        ...SERVER_GIT,
        current: readCurrentGitState(),
      },
      uptimeSec: Math.round((Date.now() - SERVER_START_TIME) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      msgCacheEntries: msgCache.size,
      msgCacheMax: MSG_CACHE_MAX,
      msgCacheTail: MSG_CACHE_TAIL,
      msgCacheEstimatedKb: msgCacheEstimatedKb(),
      sidebarCacheSessions: loadSidebarCache().sessions.length,
      sseClients: sseClients.size,
    })
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

  // GET|PUT /api/settings — allow both cookie + header auth (legacy automation clients)
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

  // GET /api/usage — cookie or header auth for optional remote clients
  if (url.pathname === "/api/usage" && req.method === "GET") {
    if (!checkCookieAuth(req) && !checkHeaderAuth(req)) { json({ error: "Unauthorized" }, 401); return }
    json(await fetchAllUsage())
    return
  }

  // All remaining /api/* require cookie auth, or header auth for trusted automation/proxy callers.
  if (url.pathname.startsWith("/api/") && !checkCookieAuth(req) && !checkHeaderAuth(req)) {
    json({ error: "Unauthorized" }, 401)
    return
  }

  // GET /api/agent/providers — available execution surfaces for the agent console.
  if (url.pathname === "/api/agent/providers" && req.method === "GET") {
    json({ ...getAgentProviders(), transcriptLocations: getTranscriptReadLocations() })
    return
  }

  // GET /api/agent/plans — latest persisted update_plan/TodoWrite state from recent sessions.
  if (url.pathname === "/api/agent/plans" && req.method === "GET") {
    const requested = Number(url.searchParams.get("limit"))
    const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(20, requested)) : 8
    json({ plans: loadRecentPlans(limit), generatedAt: new Date().toISOString() })
    return
  }

  // GET /api/agent/summary-context — fast deterministic evidence, intentionally separate from AI.
  if (url.pathname === "/api/agent/summary-context" && req.method === "GET") {
    const result = collectActiveSessionPreviews(4)
    if (!result.sessions.length) {
      json({ ok: false, error: "No actively updating transcript sessions were found in the last five minutes." }, 404)
      return
    }
    json({
      ok: true,
      sessions: result.sessions.map(session => ({ ...session, messages: undefined })),
      chatsCount: result.sessions.length,
      collectionMs: result.collectionMs,
      generatedAt: new Date().toISOString(),
    })
    return
  }

  // POST /api/agent/summary-stream — deterministic active evidence first, then streamed AI summary.
  if (url.pathname === "/api/agent/summary-stream" && req.method === "POST") {
    await readBody()
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.flushHeaders()
    // Force small-chunk proxies/tunnels to deliver the deterministic evidence events immediately.
    res.write(`: stream-open ${".".repeat(4096)}\n\n`)
    const collectionStartedAt = performance.now()
    try {
      const entries = getActiveSessionEntries(4)
      if (!entries.length) throw new Error("No actively updating transcript sessions were found in the last five minutes.")
      for (const entry of entries) writeSse(res, "session_discovered", {
        sessionId: entry.id,
        projectPath: entry.projectPath,
        source: entry.source ?? "claude",
        title: entry.customName || entry.firstName || entry.id.slice(0, 8),
        lastActivity: entry.lastActivity ?? entry.mtime ?? null,
        latestUser: "Loading latest request…",
        assistantTail: "Loading latest assistant update…",
      })
      const sessions = []
      for (const entry of entries) {
        const messages = loadLiveSummaryTail(entry)
        if (!Array.isArray(messages) || messages.length === 0) continue
        const session = buildLiveSessionPreview(entry, messages)
        sessions.push(session)
        writeSse(res, "session", { ...session, messages: undefined })
      }
      if (!sessions.length) throw new Error("Active transcripts were found, but their latest messages could not be read.")
      writeSse(res, "context_complete", {
        chatsCount: sessions.length,
        collectionMs: Math.round(performance.now() - collectionStartedAt),
      })
      const metrics = await streamOpenAILiveSummary(res, sessions)
      writeSse(res, "done", { ok: true, chatsCount: sessions.length, ...metrics })
    } catch (err) {
      writeSse(res, "error", { error: err instanceof Error ? err.message : String(err) })
    } finally {
      res.end()
    }
    return
  }

  // POST /api/agent/summary — one-click cross-agent update from recent chat tails.
  if (url.pathname === "/api/agent/summary" && req.method === "POST") {
    const body = await readBody()
    const recentChats = loadRecentChatContext()
    if (!recentChats.length) {
      json({ ok: false, error: "No recent transcript messages were found." }, 404)
      return
    }
    const result = await runLocalAglChat({
      ...body,
      agent: String(body.agent ?? "codex"),
      mode: "ask",
      timeoutSeconds: Math.min(180, Number(body.timeoutSeconds) || 120),
      resumeCurrentSession: false,
      conversation: [],
      prompt: [
        "Give me a concise live work update from the supplied recent chats.",
        "Use exactly two Markdown headings: Completed and Remaining.",
        "Under each heading, write short evidence-based bullet points.",
        "Treat proposed, attempted, unverified, failed, or interrupted work as remaining, not completed.",
        "If nothing is supported for a section, write one bullet saying so.",
      ].join("\n"),
      sessionContext: withTranscriptResearchContext({ recentChats }),
    })
    json({ ...result, chatsCount: recentChats.length, generatedAt: new Date().toISOString() }, result.ok ? 200 : 500)
    return
  }

  // POST /api/agent/chat — chat through agl locally, or proxy to a configured provider.
  if (url.pathname === "/api/agent/chat" && req.method === "POST") {
    const body = await readBody()
    const provider = String(body.provider ?? "local")
    let sessionContext = body.sessionContext && typeof body.sessionContext === "object"
      ? { ...body.sessionContext }
      : {}

    if ((!Array.isArray(sessionContext.messages) || sessionContext.messages.length === 0) && sessionContext.projectPath && sessionContext.sessionId) {
      const loaded = loadSessionMessagesOndemand(String(sessionContext.projectPath), String(sessionContext.sessionId))
      if (Array.isArray(loaded)) sessionContext.messages = loaded.slice(-100)
    }
    sessionContext = withTranscriptResearchContext(sessionContext, { includeRecentChats: true })

    if (provider === "local") {
      const requestedAgent = String(body.agent ?? "random")
      const resumeCurrentSession = body.resumeCurrentSession === true &&
        typeof sessionContext.projectPath === "string" &&
        canResumeSessionWithAgl(sessionContext.source, requestedAgent)
      const result = await runLocalAglChat({
        ...body,
        sessionContext,
      })
      if (resumeCurrentSession) {
        msgCacheDelete(`${sessionContext.projectPath}/${sessionContext.sessionId}`)
      }
      json(result, result.ok ? 200 : 500)
      return
    }

    const configured = parseConfiguredProviders(process.env.AGENT_SESSION_AGENT_PROVIDERS_JSON)
    const target = configured.find(entry => entry.id === provider && entry.endpoint)
    if (!target) {
      json({ ok: false, error: `Unknown agent provider: ${provider}` }, 400)
      return
    }

    try {
      const upstream = await fetch(target.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, sessionContext }),
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" })
      res.end(text)
    } catch (err) {
      json({ ok: false, error: err?.message ?? String(err) }, 502)
    }
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
    debugLog(`${ts()} [search] q="${q}" rows=${searchRows.length} liveRows=${rows.length} results=${results.length} source=${source} title+platform ms=${ms}`)
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

  // GET /api/search/global?q= — NDJSON streaming: one JSON line per platform as it finishes
  if (url.pathname === "/api/search/global") {
    const q = url.searchParams.get("q")?.trim() ?? ""
    if (!q) { json({ hits: [], done: true }); return }
    const t0 = performance.now()
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    })
    try {
      // Run content-search (all 5 platforms) + rg for Antigravity concurrently.
      // onChunk fires as each platform resolves — SQLite ones arrive in <50ms.
      const seen = new Set()
      const rgPromise = rgGlobalSearch(q, { limit: 100 }).catch(() => null)

      await contentSearchStream(q, { limit: 100 }, hits => {
        for (const h of hits) seen.add(h.sessionId)
        res.write(JSON.stringify({ hits }) + "\n")
      })

      // Flush Antigravity + Antigravity CLI hits from rg (not covered by content-search)
      const rgHits = await rgPromise
      if (rgHits?.length) {
        const agHits = rgHits.filter(h => (h.source === "antigravity" || h.source === "antigravity-cli") && !seen.has(h.sessionId))
        if (agHits.length) res.write(JSON.stringify({ hits: agHits }) + "\n")
      }

      const ms = (performance.now() - t0).toFixed(1)
      debugLog(`${ts()} [global-search] q="${q}" ms=${ms}`)
      res.write(JSON.stringify({ done: true, ms: Number(ms) }) + "\n")
    } catch (err) {
      console.error(`${ts()} [global-search] error q="${q}":`, err.message)
      res.write(JSON.stringify({ error: err.message, done: true }) + "\n")
    }
    res.end()
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
    const pinSessionId = url.searchParams.get("pinSession")?.trim() || null
    const pinProjectPath = url.searchParams.get("pinProject")?.trim() || null
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write(": connected\n\n")  // flush headers immediately so EventSource.onopen fires now
    if (maxSessions != null) {
      await streamRecentSidebarInitial(res, maxSessions, pinSessionId, pinProjectPath)
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
    let watchIsDir = false
    if (projectPath.startsWith("openclaw:")) {
      watchFile = findOpenclawSessionFile(sessionId)
    } else if (projectPath.startsWith("codex:")) {
      watchFile = findCodexSessionFile(sessionId)
    } else if (projectPath.startsWith("antigravity:")) {
      // Antigravity desktop writes markdown artifacts in place; watch the brain dir itself —
      // on macOS, fs.watch on a directory fires for child file content changes too.
      const brainDir = join(ANTIGRAVITY_BRAIN_DIR, sessionId)
      if (existsSync(brainDir)) { watchFile = brainDir; watchIsDir = true }
    } else if (projectPath.startsWith("antigravity-cli:")) {
      // Antigravity CLI appends JSONL — watch transcript.jsonl directly (size-based diff)
      const transcriptFile = join(ANTIGRAVITY_CLI_DIR, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl")
      if (existsSync(transcriptFile)) watchFile = transcriptFile
    } else if (!projectPath.startsWith("cursor:") && !projectPath.startsWith("cursor-agent:") &&
               !projectPath.startsWith("opencode:") && !projectPath.startsWith("hermes:")) {
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

    function dirMaxMtime(dir) {
      try {
        return Math.max(...readdirSync(dir).map(f => { try { return statSync(join(dir, f)).mtimeMs } catch { return 0 } }))
      } catch { return 0 }
    }

    let lastSig = 0
    try {
      lastSig = watchIsDir ? dirMaxMtime(watchFile) : statSync(watchFile).size
    } catch { /* file may not exist yet */ }

    function pushUpdate() {
      try {
        const msgs = getSessionMessagesAll(projectPath, sessionId)
        if (!msgs) return
        // Invalidate cache so next read is fresh
        msgCacheDelete(`${projectPath}/${sessionId}`)
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
        // Small debounce: JSONL appends / md rewrites may fire multiple events per write
        debounceTimer = setTimeout(() => {
          try {
            const newSig = watchIsDir ? dirMaxMtime(watchFile) : statSync(watchFile).size
            if (newSig === lastSig) return
            lastSig = newSig
            // Invalidate mem-cache so fresh parse picks up new lines
            msgCacheDelete(`${projectPath}/${sessionId}`)
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
    const sessionId = decodeURIComponent(sessionMatch[2])
    const tailParam = url.searchParams.get("tail")
    const skipParam = url.searchParams.get("skip")
    const tail = tailParam ? Math.max(1, parseInt(tailParam) || 0) : 0
    const skip = skipParam ? Math.max(0, parseInt(skipParam) || 0) : 0
    const shortId = sessionId.slice(0, 8)
    const source = projectPath.split(":")[0] || "claude"
    debugLog(`[perf ${wallClock()}] /api/session start ${source}:${shortId} tail=${tail} skip=${skip} path=${projectPath}`)

    function sliceMsgs(all) {
      const total = all.length
      if (!tail) return { msgs: all, total }
      const end = total - skip
      const start = Math.max(0, end - tail)
      return { msgs: all.slice(start, end > 0 ? end : 0), total }
    }

    function jsonPaged(all, loadLabel, totalOverride) {
      const { msgs, total } = sliceMsgs(all)
      const lineTotal = totalOverride ?? total
      const jsonStr = JSON.stringify(msgs)
      const totalMs = (performance.now() - reqT0).toFixed(1)
      debugLog(`[perf ${wallClock()}] /api/session ${source}:${shortId} tail=${tail} skip=${skip} → ${msgs.length}/${lineTotal} msgs | load:${loadLabel} | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(lineTotal) })
      res.end(jsonStr)
    }

    function jsonFromWindow(windowMsgs, lineTotal, loadLabel) {
      const jsonStr = JSON.stringify(windowMsgs)
      const totalMs = (performance.now() - reqT0).toFixed(1)
      debugLog(`[perf ${wallClock()}] /api/session ${source}:${shortId} tail=${tail} skip=${skip} → ${windowMsgs.length}/${lineTotal} msgs | load:${loadLabel} | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(lineTotal) })
      res.end(jsonStr)
    }

    const cacheKey = `${projectPath}/${sessionId}`

    function cacheAndRespond(msgs, lineTotal, loadLabel) {
      msgCacheSet(cacheKey, msgs, lineTotal)
      if (msgCacheCovers(msgCachePeek(cacheKey), tail, skip)) {
        const sliced = msgCacheSlice(msgCachePeek(cacheKey), tail, skip)
        jsonFromWindow(sliced.msgs, sliced.total, loadLabel)
        return true
      }
      if (!tail) {
        jsonPaged(msgs, loadLabel, lineTotal)
        return true
      }
      const end = msgs.length - skip
      const start = Math.max(0, end - tail)
      jsonFromWindow(msgs.slice(start, end > 0 ? end : 0), lineTotal, loadLabel)
      return true
    }

    // Cursor: push tail/skip into SQLite — avoids reading all bubbles for a tail fetch
    if (projectPath.startsWith("cursor:")) {
      const t0 = performance.now()
      const { msgs, total } = readCursorSessionMsgs(sessionId, { tail, skip })
      const ms = (performance.now() - t0).toFixed(1)
      const jsonStr = JSON.stringify(msgs)
      const totalMs = (performance.now() - reqT0).toFixed(1)
      debugLog(`[perf ${wallClock()}] /api/session cursor:${shortId} tail=${tail} skip=${skip} → ${msgs.length}/${total} msgs | load:sqlite ${ms}ms | total:${totalMs}ms | resp:${(jsonStr.length/1024).toFixed(1)}KB`)
      res.writeHead(200, { "Content-Type": "application/json", "X-Message-Total": String(total) })
      res.end(jsonStr)
      return
    }
    // Hot tail cache — top few recently viewed sessions keep last MSG_CACHE_TAIL msgs
    const cachedEntry = msgCachePeek(cacheKey)
    if (cachedEntry && msgCacheCovers(cachedEntry, tail, skip)) {
      debugLog(`[perf ${wallClock()}] /api/session cache-hit ${source}:${shortId} cached=${cachedEntry.msgs.length}/${cachedEntry.total}`)
      const sliced = msgCacheSlice(cachedEntry, tail, skip)
      jsonFromWindow(sliced.msgs, sliced.total, "mem-cache")
      msgCacheTouch(cacheKey, cachedEntry)
      return
    }

    if (projectPath.startsWith("codex:")) {
      if (tail > 0 && skip === 0) {
        const t0fast = performance.now()
        const quick = readCodexSessionTailFast(projectPath, sessionId, tail)
        const fastMs = (performance.now() - t0fast).toFixed(1)
        if (quick?.msgs?.length) {
          jsonFromWindow(quick.msgs, quick.total, `codex-tail ${fastMs}ms`)
          setImmediate(() => upsertSidebarCacheFromLoadedSession(projectPath, sessionId))
          setImmediate(() => {
            if (msgCacheHas(cacheKey)) return
            const warm = readCodexSessionTailFast(projectPath, sessionId, MSG_CACHE_TAIL)
            if (warm?.msgs?.length) msgCacheSet(cacheKey, warm.msgs, warm.total)
          })
          return
        }
      }
      const need = tail > 0 ? skip + tail : MSG_CACHE_TAIL
      const t0tail = performance.now()
      const quick = readCodexSessionTailFast(projectPath, sessionId, need)
      const tailMs = (performance.now() - t0tail).toFixed(1)
      if (quick?.msgs?.length) {
        cacheAndRespond(quick.msgs, quick.total, `codex-tail ${tailMs}ms`)
        return
      }
    }

    // Non-Claude platforms: on-demand read via platform-readers
    const isNonClaude = isOnDemandSessionPlatform(projectPath)
    if (isNonClaude) {
      const t0ondemand = performance.now()
      const ondemand = loadSessionMessagesOndemand(projectPath, sessionId)
      const ondemandMs = (performance.now() - t0ondemand).toFixed(1)
      debugLog(`[perf ${wallClock()}] /api/session ondemand ${source}:${shortId} load=${ondemandMs}ms hit=${ondemand != null}`)
      if (ondemand != null) {
        cacheAndRespond(ondemand, ondemand.length, `ondemand ${ondemandMs}ms`)
        setImmediate(() => upsertSidebarCacheFromLoadedSession(projectPath, sessionId))
        return
      }
      res.writeHead(404); res.end("Not Found"); return
    }

    // Claude Code: tail-read from file end (no full parse unless necessary)
    const fp = projectPath.startsWith("/")
      ? join(projectPath, `${sessionId}.jsonl`)
      : join(CLAUDE_DIR, projectPath, `${sessionId}.jsonl`)
    if (!existsSync(fp)) { res.writeHead(404); res.end("Not Found"); return }

    const lineTotal = countJsonlLines(fp)

    if (tail > 0 && skip === 0) {
      debugLog(`[perf ${wallClock()}] /api/session claude:${shortId} fast-tail start tail=${tail}`)
      const tailMsgs = readJsonlTail(fp, tail)
      jsonFromWindow(tailMsgs, lineTotal, "jsonl-tail")
      setImmediate(() => {
        if (msgCacheHas(cacheKey)) return
        const warm = readJsonlTail(fp, Math.min(MSG_CACHE_TAIL, lineTotal))
        if (warm.length) msgCacheSet(cacheKey, warm, lineTotal)
      })
      return
    }

    if (tail > 0 || skip > 0) {
      const needFromEnd = skip + (tail || MSG_CACHE_TAIL)
      const fetchN = Math.min(Math.max(needFromEnd, MSG_CACHE_TAIL), lineTotal)
      debugLog(`[perf ${wallClock()}] /api/session claude:${shortId} tail-read need=${needFromEnd} fetch=${fetchN}`)
      const tailMsgs = readJsonlTail(fp, fetchN)
      cacheAndRespond(tailMsgs, lineTotal, "jsonl-tail")
      return
    }

    // tail=0: rare full-session request — parse once, cache tail window only
    debugLog(`[perf ${wallClock()}] /api/session claude:${shortId} parse-start full`)
    const parsed = parseJsonl(fp)
    debugLog(`[perf ${wallClock()}] /api/session claude:${shortId} parse-done count=${parsed.length}`)
    cacheAndRespond(parsed, parsed.length, "jsonl-parse")
    return
  }

  // Archived (hidden) sessions — persisted server-side so the list follows the
  // backend across origins (localhost + any tunnel domain share one list).
  if (url.pathname === "/api/archived" && req.method === "GET") {
    json({ keys: loadConfig().archived ?? [] })
    return
  }
  if (url.pathname === "/api/archived" && req.method === "POST") {
    const body = await readBody()
    const config = loadConfig()
    const set = new Set(config.archived ?? [])
    const key = String(body.key ?? "")
    if (!key) { res.writeHead(400); res.end("Missing key"); return }
    if (body.archived) set.add(key)
    else set.delete(key)
    config.archived = [...set]
    saveConfig(config)
    json({ ok: true, count: set.size })
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
  if (err?.code === "EADDRINUSE") process.exit(1)
})
process.on("unhandledRejection", (reason, promise) => {
  console.error(`${ts()} [unhandledRejection] at:`, promise, "reason:", reason)
})

const BIND_HOST = process.env.HOST ?? "127.0.0.1"
initSidebarCache()
server.on("error", err => {
  console.error(`${ts()} [serverError]`, err.stack || err)
  process.exit(1)
})
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
