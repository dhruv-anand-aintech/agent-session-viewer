/**
 * LanceDB keyword search engine.
 *
 * Messages are chunked at markdown boundaries (prose paragraphs + code blocks
 * as separate rows) before indexing. Thread search is handled separately in
 * memory so it can scan the full session directly without global top-N loss.
 *
 * Schema (snake_case to avoid LanceDB SQL quoting issues):
 *   vector        float32[768] — retained for compatibility, filled with zeros
 *   project_path  utf8
 *   session_id    utf8
 *   msg_idx       int32   — message position in session
 *   chunk_idx     int32   — chunk position within message
 *   chunk_type    utf8    — "text" | "code"
 *   text          utf8    — chunk content
 *   ts            utf8    — message timestamp
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { chunkMarkdown } from "./chunker.mjs"
import { loadSessionMessages } from "./session-message-loader.mjs"
import { runThreadKeywordSearch } from "./session-search-core.mjs"

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 23)

export const LANCEDB_DIR = join(homedir(), ".config", "agent-session-viewer", "lancedb")
const TABLE_NAME = "messages_v2"  // v2 = chunk-aware schema
export const EMBED_DIM = 768
const ZERO_VECTOR = new Array(EMBED_DIM).fill(0)

// ── Lazy singletons ───────────────────────────────────────────────────────────

let _lancedb = null
let _db = null
let _table = null

// ── LanceDB table ─────────────────────────────────────────────────────────────

async function getLanceDB() {
  if (!_lancedb) _lancedb = await import("@lancedb/lancedb")
  return _lancedb
}

/** Opens the table for reads. Returns null if it doesn't exist yet. */
export async function getTable() {
  if (_table) return _table
  let lancedb
  try { lancedb = await getLanceDB() } catch { return null }
  mkdirSync(LANCEDB_DIR, { recursive: true })
  if (!_db) _db = await lancedb.connect(LANCEDB_DIR)
  const names = await _db.tableNames()
  if (names.includes(TABLE_NAME)) {
    _table = await _db.openTable(TABLE_NAME)
  }
  return _table
}

/** Opens or creates the table. Creates FTS index after first real data. */
async function getOrCreateTable(firstRecords) {
  if (_table) return { table: _table, created: false }
  let lancedb
  try { lancedb = await getLanceDB() } catch { return { table: null, created: false } }
  mkdirSync(LANCEDB_DIR, { recursive: true })
  if (!_db) _db = await lancedb.connect(LANCEDB_DIR)
  const names = await _db.tableNames()
  if (names.includes(TABLE_NAME)) {
    _table = await _db.openTable(TABLE_NAME)
    return { table: _table, lancedb, created: false }
  }
  // Create table with first real data so FTS index can be built immediately
  _table = await _db.createTable(TABLE_NAME, firstRecords)
  await _table.createIndex("text", { config: lancedb.Index.fts() })
  console.log(`${ts()} [lancedb] Created messages_v2 table with FTS index`)
  return { table: _table, lancedb, created: true }
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

function sqlVal(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

function sessionFilter(projectPath, sessionId) {
  return `project_path = ${sqlVal(projectPath)} AND session_id = ${sqlVal(sessionId)}`
}

// RRF score accumulation
function rrfMerge(results, getKey, k = 60) {
  const scores = new Map()
  results.forEach((r, rank) => {
    const key = getKey(r)
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1))
  })
  return scores
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Index all messages for a session. Each message is chunked at markdown
 * boundaries; code blocks become separate rows with chunk_type="code".
 * @param {(msg: object) => string} flattenFn
 * @returns {number} chunk rows written
 */
export async function indexSessionMessages(projectPath, sessionId, msgs, flattenFn) {
  const rows = []
  for (let mi = 0; mi < msgs.length; mi++) {
    const raw = flattenFn(msgs[mi])
    if (!raw || raw.length < 5) continue
    const chunks = chunkMarkdown(raw)
    for (let ci = 0; ci < chunks.length; ci++) {
      const { type, text } = chunks[ci]
      if (!text.trim()) continue
      rows.push({ mi, ci, type, text, ts: String(msgs[mi].timestamp ?? "") })
    }
  }
  if (!rows.length) return 0

  const records = rows.map((r, i) => ({
    vector: ZERO_VECTOR,
    project_path: projectPath, session_id: sessionId,
    msg_idx: r.mi, chunk_idx: r.ci, chunk_type: r.type, text: r.text, ts: r.ts,
  }))

  const { table, lancedb, created } = await getOrCreateTable(records)
  if (!table) return 0
  if (created) return records.length  // already added by createTable

  // Existing table: delete stale rows then add
  await table.delete(sessionFilter(projectPath, sessionId))
  await table.add(records)

  // Ensure FTS index exists (creates it if it was somehow lost, e.g. table was emptied)
  try {
    const idxs = await table.listIndices()
    if (!idxs.some(ix => ix.columns?.includes("text"))) {
      await table.createIndex("text", { config: lancedb.Index.fts() })
    }
  } catch { /* listIndices not available in all versions */ }

  return records.length
}

/**
 * Sidebar search — session-level BM25 over chunk rows.
 * Returns null when the index is unavailable (caller falls back to Fuse.js).
 * @returns {{ projectPath, sessionId, score, snippet }[] | null}
 */
export async function searchSessions(query, limit = 60) {
  const table = await getTable()
  if (!table) return null

  const PER = Math.max(limit * 10, 200)
  const sessionMeta = new Map()

  const track = rows => rows.forEach(r => {
    const key = `${r.project_path}\x1f${r.session_id}`
    if (!sessionMeta.has(key)) {
      sessionMeta.set(key, {
        projectPath: r.project_path, sessionId: r.session_id,
        snippet: String(r.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      })
    }
  })

  const rows = []
  try {
    const hits = await table.query().nearestToText(query)
      .select(["project_path", "session_id", "text", "_score"]).limit(PER).toArray()
    rows.push(...hits)
    track(hits)
  } catch { /* FTS index building */ }

  if (!rows.length) return null

  const ftsS = rrfMerge(rows, r => `${r.project_path}\x1f${r.session_id}`)
  const keys = new Set(ftsS.keys())

  return Array.from(keys)
    .map(key => {
      const m = sessionMeta.get(key) ?? { projectPath: key.split("\x1f")[0], sessionId: key.split("\x1f")[1], snippet: "" }
      return { ...m, score: ftsS.get(key) ?? 0 }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * In-thread search — keyword-only, full-thread in-memory scan.
 * Returns null when the session cannot be loaded.
 * @returns {{ idx, score, text }[] | null}
 */
export function searchThread(projectPath, sessionId, query, limit = 40) {
  const msgs = loadSessionMessages(projectPath, sessionId)
  if (!Array.isArray(msgs) || !msgs.length) return null
  return runThreadKeywordSearch(query, msgs, limit)
}

/** Returns set of "project_path\x1fsession_id" keys already indexed. */
export async function getIndexedKeys() {
  const table = await getTable()
  if (!table) return new Set()
  try {
    const rows = await table.query().select(["project_path", "session_id"]).limit(1_000_000).toArray()
    return new Set(rows.map(r => `${r.project_path}\x1f${r.session_id}`))
  } catch { return new Set() }
}

export async function removeSessionFromIndex(projectPath, sessionId) {
  const table = await getTable()
  if (!table) return
  try { await table.delete(sessionFilter(projectPath, sessionId)) } catch { /* ignore */ }
}

export async function getIndexStats() {
  const table = await getTable()
  if (!table) return { available: false, sessions: 0, rows: 0 }
  try {
    const rows = await table.query().select(["project_path", "session_id"]).limit(1_000_000).toArray()
    const sessions = new Set(rows.map(r => `${r.project_path}\x1f${r.session_id}`))
    return { available: true, sessions: sessions.size, rows: rows.length }
  } catch { return { available: false, sessions: 0, rows: 0 } }
}
