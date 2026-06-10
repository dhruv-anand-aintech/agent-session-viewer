/**
 * Sidebar session metadata — SQLite persistence (replaces sidebar-cache.json).
 * One row per session; indexed by last_activity for fast top-N reads.
 */
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const Database = require("better-sqlite3")

export const SIDEBAR_CACHE_DB_FILE = "sidebar-cache.db"
export const SIDEBAR_CACHE_JSON_LEGACY = "sidebar-cache.json"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  project_display_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'claude',
  message_count INTEGER NOT NULL DEFAULT 0,
  user_message_count INTEGER,
  first_name TEXT,
  last_activity TEXT NOT NULL,
  mtime TEXT NOT NULL,
  custom_name TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  agent_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
`

let _db = null
/** @type {Map<string, object>} */
let _map = new Map()
let _count = 0

function rowToEntry(row) {
  if (!row) return null
  const entry = {
    id: row.id,
    projectPath: row.project_path,
    projectDisplayName: row.project_display_name,
    source: row.source,
    messageCount: row.message_count,
    userMessageCount: row.user_message_count,
    firstName: row.first_name,
    lastActivity: row.last_activity,
    mtime: row.mtime,
    customName: row.custom_name,
    ...(row.is_sidechain ? {
      isSidechain: true,
      parentSessionId: row.parent_session_id ?? undefined,
      agentType: row.agent_type ?? undefined,
    } : {}),
  }
  return entry
}

function entryToRow(entry) {
  return {
    id: entry.id,
    project_path: entry.projectPath ?? "",
    project_display_name: entry.projectDisplayName ?? "",
    source: entry.source ?? "claude",
    message_count: entry.messageCount ?? 0,
    user_message_count: entry.userMessageCount ?? null,
    first_name: entry.firstName ?? null,
    last_activity: entry.lastActivity ?? new Date().toISOString(),
    mtime: String(entry.mtime ?? entry.lastActivity ?? Date.now()),
    custom_name: entry.customName ?? null,
    is_sidechain: entry.isSidechain ? 1 : 0,
    parent_session_id: entry.parentSessionId ?? null,
    agent_type: entry.agentType ?? null,
  }
}

function entriesEqual(a, b) {
  if (!a || !b) return false
  return a.mtime === b.mtime &&
    a.messageCount === b.messageCount &&
    a.userMessageCount === b.userMessageCount &&
    a.firstName === b.firstName &&
    a.lastActivity === b.lastActivity &&
    a.customName === b.customName &&
    !!a.isSidechain === !!b.isSidechain &&
    (a.parentSessionId ?? null) === (b.parentSessionId ?? null) &&
    (a.agentType ?? null) === (b.agentType ?? null)
}

const UPSERT_SQL = `
INSERT INTO sessions (
  id, project_path, project_display_name, source, message_count, user_message_count,
  first_name, last_activity, mtime, custom_name, is_sidechain, parent_session_id, agent_type
) VALUES (
  @id, @project_path, @project_display_name, @source, @message_count, @user_message_count,
  @first_name, @last_activity, @mtime, @custom_name, @is_sidechain, @parent_session_id, @agent_type
)
ON CONFLICT(id) DO UPDATE SET
  project_path = excluded.project_path,
  project_display_name = excluded.project_display_name,
  source = excluded.source,
  message_count = excluded.message_count,
  user_message_count = excluded.user_message_count,
  first_name = excluded.first_name,
  last_activity = excluded.last_activity,
  mtime = excluded.mtime,
  custom_name = excluded.custom_name,
  is_sidechain = excluded.is_sidechain,
  parent_session_id = excluded.parent_session_id,
  agent_type = excluded.agent_type
`

function refreshCount() {
  _count = _db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n
}

function warmMemoryMap() {
  _map.clear()
  for (const row of _db.prepare("SELECT * FROM sessions").iterate()) {
    const entry = rowToEntry(row)
    _map.set(entry.id, entry)
  }
  refreshCount()
}

function migrateJsonIfNeeded(configDir) {
  const jsonPath = join(configDir, SIDEBAR_CACHE_JSON_LEGACY)
  if (!existsSync(jsonPath)) return 0
  const count = _db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n
  if (count > 0) return 0
  let raw
  try {
    raw = JSON.parse(readFileSync(jsonPath, "utf8"))
  } catch {
    return 0
  }
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : []
  if (!sessions.length) return 0
  const insert = _db.prepare(UPSERT_SQL)
  const tx = _db.transaction(rows => {
    for (const e of rows) insert.run(entryToRow(e))
  })
  tx(sessions)
  try { renameSync(jsonPath, `${jsonPath}.migrated`) } catch { /* ignore */ }
  return sessions.length
}

/**
 * @param {string} configDir — ~/.config/agent-session-viewer
 * @returns {{ db: import('better-sqlite3').Database, map: Map, count: number }}
 */
export function openSidebarCacheDb(configDir) {
  if (_db) return { db: _db, map: _map, count: _count }
  mkdirSync(configDir, { recursive: true })
  const dbPath = join(configDir, SIDEBAR_CACHE_DB_FILE)
  _db = new Database(dbPath)
  _db.pragma("journal_mode = WAL")
  _db.pragma("synchronous = NORMAL")
  _db.pragma("mmap_size = 0")
  _db.exec(SCHEMA)
  const migrated = migrateJsonIfNeeded(configDir)
  warmMemoryMap()
  return { db: _db, map: _map, count: _count, migrated }
}

export function getSidebarCacheMap() {
  return _map
}

export function getSidebarSessionCount() {
  return _count
}

/** Include parents of listed subagents and subagents of listed parents (sidebar nesting). */
export function expandSidebarLinkageEntries(entries) {
  if (!entries.length || !_db) return entries
  const byId = new Map(entries.map(e => [e.id, e]))
  const add = entry => {
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry)
  }
  for (const e of entries) {
    if (e.isSidechain && e.parentSessionId) add(getSidebarEntry(e.parentSessionId))
  }
  const childrenStmt = _db.prepare(
    "SELECT * FROM sessions WHERE is_sidechain = 1 AND parent_session_id = ?",
  )
  for (const e of [...byId.values()]) {
    if (e.isSidechain) continue
    for (const row of childrenStmt.all(e.id)) add(rowToEntry(row))
  }
  return Array.from(byId.values()).sort((a, b) =>
    String(b.lastActivity).localeCompare(String(a.lastActivity)),
  )
}

export function getTopSidebarEntries(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return getAllSidebarEntries()
  const rows = _db.prepare(
    "SELECT * FROM sessions ORDER BY last_activity DESC LIMIT ?",
  ).all(n)
  return expandSidebarLinkageEntries(rows.map(rowToEntry))
}

export function getAllSidebarEntries() {
  const rows = _db.prepare("SELECT * FROM sessions ORDER BY last_activity DESC").all()
  return rows.map(rowToEntry)
}

export function getSidebarEntry(sessionId) {
  return _map.get(sessionId) ?? rowToEntry(
    _db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId),
  )
}

/**
 * @returns {{ changed: boolean, entry: object }}
 */
export function upsertSidebarEntry(partial) {
  const sessionId = partial.id
  const existing = _map.get(sessionId) ?? getSidebarEntry(sessionId)
  const mtimeStr = typeof partial.mtime === "number" ? String(partial.mtime) : String(partial.mtime ?? existing?.mtime ?? Date.now())
  const entry = {
    id: sessionId,
    projectPath: partial.projectPath ?? existing?.projectPath ?? "",
    projectDisplayName: partial.projectDisplayName ?? existing?.projectDisplayName ?? "",
    source: partial.source ?? existing?.source ?? "claude",
    messageCount: partial.messageCount ?? existing?.messageCount ?? 0,
    userMessageCount: partial.userMessageCount ?? existing?.userMessageCount ?? null,
    firstName: partial.firstName ?? existing?.firstName ?? null,
    lastActivity: partial.lastActivity ?? existing?.lastActivity ?? new Date(Number(mtimeStr)).toISOString(),
    mtime: mtimeStr,
    customName: partial.customName ?? existing?.customName ?? null,
    ...(partial.isSidechain || existing?.isSidechain ? {
      isSidechain: true,
      parentSessionId: partial.parentSessionId ?? existing?.parentSessionId,
      agentType: partial.agentType ?? existing?.agentType,
    } : {}),
  }
  const changed = !existing || !entriesEqual(existing, entry)
  if (changed) {
    _db.prepare(UPSERT_SQL).run(entryToRow(entry))
    if (!existing) _count++
    _map.set(sessionId, entry)
  }
  return { changed, entry }
}

/** @returns {object[]} changed entries */
export function upsertSidebarEntries(partials) {
  const changed = []
  const tx = _db.transaction(() => {
    for (const partial of partials) {
      const { changed: c, entry } = upsertSidebarEntry(partial)
      if (c) changed.push(entry)
    }
  })
  tx()
  return changed
}

/** Bulk replace all sessions (build-cache). */
export function replaceAllSidebarEntries(entries) {
  const tx = _db.transaction(rows => {
    _db.prepare("DELETE FROM sessions").run()
    const insert = _db.prepare(UPSERT_SQL)
    for (const e of rows) insert.run(entryToRow(e))
  })
  tx(entries)
  warmMemoryMap()
}

/** Close DB and reset module state (tests only). */
export function closeSidebarCacheDb() {
  if (_db) {
    try { _db.close() } catch { /* ignore */ }
  }
  _db = null
  _map = new Map()
  _count = 0
}
