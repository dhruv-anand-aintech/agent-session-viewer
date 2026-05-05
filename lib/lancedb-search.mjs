/**
 * LanceDB search engine: BM25 keyword (always) + optional vector semantic search.
 *
 * Keyword  — tantivy FTS via LanceDB, no model needed, always available.
 * Semantic — nomic-ai/CodeRankEmbed (768d, CLS, 8192-token context) loaded from
 *            a locally exported ONNX, enabled only when config.semanticSearch=true
 *            and the ONNX has been exported via lib/model-exporter.mjs.
 *
 * Messages are chunked at markdown boundaries (prose paragraphs + code blocks
 * as separate rows) before indexing. Thread search deduplicates by msg_idx.
 *
 * Schema (snake_case to avoid LanceDB SQL quoting issues):
 *   vector      float32[768]
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

export const LANCEDB_DIR = join(homedir(), ".config", "agent-session-viewer", "lancedb")
const TABLE_NAME = "messages_v2"  // v2 = chunk-aware schema
export const EMBED_DIM = 768
const EMBED_BATCH = 1  // model shape hint is batch=1; batching causes ORT shape mismatch warnings

// Community ONNX export of nomic-ai/CodeRankEmbed — public, no auth required
// Has model_quantized.onnx (138 MB int8) + model.onnx (548 MB fp32)
const MODEL_ID = "Zenabius/CodeRankEmbed-onnx"
// Query-side prefix required by CodeRankEmbed (asymmetric encoding)
const QUERY_PREFIX = "Represent this query for searching relevant code: "

// ── Lazy singletons ───────────────────────────────────────────────────────────

let _lancedb = null
let _db = null
let _table = null
let _embedder = null
let _embedderReady = false
let _embedderLoading = false

// ── Embedding ─────────────────────────────────────────────────────────────────

export async function warmEmbedder() {
  if (_embedderReady || _embedderLoading) return
  _embedderLoading = true
  try {
    const { AutoTokenizer, env } = await import("@huggingface/transformers")
    // Cache to ~/.cache/huggingface — persists across npm reinstalls
    env.cacheDir = join(homedir(), ".cache", "huggingface")
    console.log("[lancedb] Loading CodeRankEmbed tokenizer + ONNX (downloads ~140 MB on first run)…")

    // Load tokenizer via transformers.js (reads JSON files — always works)
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)

    // Load the ONNX model directly with onnxruntime-node, bypassing transformers.js
    // model loading (which fails on nomic_bert quantized ONNX protobuf format)
    const ort = await import("onnxruntime-node")
    const modelPath = join(homedir(), ".cache", "huggingface", MODEL_ID.replace("/", "/"), "onnx", "model_quantized.onnx")
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] })

    _embedder = { tokenizer, session, ort }
    _embedderReady = true
    console.log("[lancedb] CodeRankEmbed ready (inputs:", session.inputNames, ")")
  } catch (err) {
    console.warn("[lancedb] Could not load embedding model:", err.message)
  } finally {
    _embedderLoading = false
  }
}

export function isEmbedderReady() { return _embedderReady }

function l2norm(vec) {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum) || 1
  return vec.map(v => v / norm)
}

/**
 * @param {string[]} texts
 * @param {boolean} isQuery — prepends CodeRankEmbed query prefix when true
 */
async function embedTexts(texts, isQuery = false) {
  if (!_embedderReady || !_embedder || !texts.length) return null
  const { tokenizer, session, ort } = _embedder
  const input = isQuery ? texts.map(t => QUERY_PREFIX + t) : texts
  const all = []

  for (let i = 0; i < input.length; i += EMBED_BATCH) {
    const batch = input.slice(i, i + EMBED_BATCH)
    // Tokenize — truncate to model's 8192-token context
    const enc = await tokenizer(batch, { padding: true, truncation: true, max_length: 8192, return_tensor: false })
    const seqLen = enc.input_ids[0].length
    const bsz = batch.length

    const inputIds = new BigInt64Array(bsz * seqLen)
    const attMask = new BigInt64Array(bsz * seqLen)
    for (let b = 0; b < bsz; b++) {
      for (let s = 0; s < seqLen; s++) {
        inputIds[b * seqLen + s] = BigInt(enc.input_ids[b][s])
        attMask[b * seqLen + s] = BigInt(enc.attention_mask[b][s])
      }
    }

    const feeds = {
      input_ids: new ort.Tensor("int64", inputIds, [bsz, seqLen]),
      attention_mask: new ort.Tensor("int64", attMask, [bsz, seqLen]),
    }
    const result = await session.run(feeds)
    const hidden = result.last_hidden_state  // [bsz, seqLen, 768]

    // CLS token pooling: take position 0 of each sequence, then L2-normalise
    for (let b = 0; b < bsz; b++) {
      const cls = Array.from(hidden.data.slice(b * seqLen * EMBED_DIM, b * seqLen * EMBED_DIM + EMBED_DIM))
      all.push(l2norm(cls))
    }
  }
  return all
}

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
  console.log("[lancedb] Created messages_v2 table with FTS index")
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

  // Embed all chunk texts (documents — no query prefix)
  const vectors = await embedTexts(rows.map(r => r.text), false)
  const zero = new Array(EMBED_DIM).fill(0)
  const records = rows.map((r, i) => ({
    vector: vectors ? vectors[i] : zero,
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
 * Sidebar search — session-level RRF over BM25 [+ vector].
 * Returns null when the index is unavailable (caller falls back to Fuse.js).
 * @returns {{ projectPath, sessionId, score, snippet }[] | null}
 */
export async function searchSessions(query, limit = 60) {
  const table = await getTable()
  if (!table) return null

  const PER = limit * 5
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

  const ftsRows = []
  const vecRows = []

  // BM25 (always)
  try {
    const rows = await table.query().nearestToText(query)
      .select(["project_path", "session_id", "text", "_score"]).limit(PER).toArray()
    ftsRows.push(...rows); track(rows)
  } catch { /* FTS index building */ }

  // Vector (only when semantic enabled + model ready)
  if (_embedderReady) {
    const vecs = await embedTexts([query], true)
    if (vecs) {
      try {
        const rows = await table.search(vecs[0])
          .select(["project_path", "session_id", "text", "_distance"]).limit(PER).toArray()
        vecRows.push(...rows); track(rows)
      } catch { /* ignore */ }
    }
  }

  if (!ftsRows.length && !vecRows.length) return null

  const ftsS = rrfMerge(ftsRows, r => `${r.project_path}\x1f${r.session_id}`)
  const vecS = rrfMerge(vecRows, r => `${r.project_path}\x1f${r.session_id}`)
  const keys = new Set([...ftsS.keys(), ...vecS.keys()])

  return Array.from(keys)
    .map(key => {
      const m = sessionMeta.get(key) ?? { projectPath: key.split("\x1f")[0], sessionId: key.split("\x1f")[1], snippet: "" }
      return { ...m, score: (ftsS.get(key) ?? 0) + (vecS.get(key) ?? 0) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * In-thread search — returns unique message indices sorted by RRF relevance.
 * Falls back to global search + post-filter when per-session FTS filter fails.
 * Returns null when index unavailable (caller falls back to Fuse.js).
 * @returns {{ idx, score, text }[] | null}
 */
export async function searchThread(projectPath, sessionId, query, limit = 40) {
  const table = await getTable()
  if (!table) return null

  const filter = sessionFilter(projectPath, sessionId)
  const PER = Math.max(limit * 3, 60)
  const ftsRows = []
  const vecRows = []
  const texts = new Map()  // msg_idx → best snippet

  const trackText = rows => rows.forEach(r => {
    if (!texts.has(r.msg_idx)) texts.set(r.msg_idx, String(r.text ?? ""))
  })

  // BM25
  try {
    const rows = await table.query().nearestToText(query).where(filter)
      .select(["msg_idx", "text", "_score"]).limit(PER).toArray()
    ftsRows.push(...rows); trackText(rows)
  } catch {
    try {
      const rows = await table.query().nearestToText(query)
        .select(["project_path", "session_id", "msg_idx", "text", "_score"]).limit(PER * 10).toArray()
      const f = rows.filter(r => r.project_path === projectPath && r.session_id === sessionId)
      ftsRows.push(...f); trackText(f)
    } catch { /* ignore */ }
  }

  // Vector
  if (_embedderReady) {
    const vecs = await embedTexts([query], true)
    if (vecs) {
      try {
        const rows = await table.search(vecs[0]).where(filter)
          .select(["msg_idx", "text", "_distance"]).limit(PER).toArray()
        vecRows.push(...rows); trackText(rows)
      } catch {
        try {
          const rows = await table.search(vecs[0])
            .select(["project_path", "session_id", "msg_idx", "text", "_distance"]).limit(PER * 10).toArray()
          const f = rows.filter(r => r.project_path === projectPath && r.session_id === sessionId)
          vecRows.push(...f); trackText(f)
        } catch { /* ignore */ }
      }
    }
  }

  if (!ftsRows.length && !vecRows.length) return null

  // Aggregate by msg_idx (multiple chunks per message → take best RRF score)
  const ftsS = rrfMerge(ftsRows, r => r.msg_idx)
  const vecS = rrfMerge(vecRows, r => r.msg_idx)
  const allIdxs = new Set([...ftsS.keys(), ...vecS.keys()])

  return Array.from(allIdxs)
    .map(idx => ({
      idx: Number(idx),
      score: (ftsS.get(idx) ?? 0) + (vecS.get(idx) ?? 0),
      text: texts.get(idx) ?? "",
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
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
  if (!table) return { available: false, sessions: 0, rows: 0, modelReady: _embedderReady }
  try {
    const rows = await table.query().select(["project_path", "session_id"]).limit(1_000_000).toArray()
    const sessions = new Set(rows.map(r => `${r.project_path}\x1f${r.session_id}`))
    return { available: true, sessions: sessions.size, rows: rows.length, modelReady: _embedderReady }
  } catch { return { available: false, sessions: 0, rows: 0, modelReady: _embedderReady } }
}
