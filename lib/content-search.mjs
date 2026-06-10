/**
 * Per-platform content-only search.
 *
 * Each platform has its own extractor that pulls human-readable text
 * from the raw storage format (JSONL or SQLite), ignoring metadata
 * fields like "role", "type", "parentUuid", etc.
 *
 * File-based platforms (JSONL): stream + parse line-by-line
 * SQLite platforms: query text fields directly
 *
 * Returns hits in the same shape as rg-search.mjs: { source, projectPath, sessionId, snippets[] }
 */

import { existsSync, readdirSync, readFileSync, createReadStream } from "fs"
import { createInterface } from "readline"
import { join, basename, dirname } from "path"
import { homedir } from "os"
import { createRequire } from "module"
import { readCodexSession } from "../platform-readers.mjs"

const HOME = homedir()
const SNIPPET_MAX = 300

// ── better-sqlite3 (reuse same approach as platform-readers) ─────────────────

let _BetterSqlite
try {
  const req = createRequire(import.meta.url)
  _BetterSqlite = req("better-sqlite3")
} catch { /* subprocess fallback not needed here — SQLite platforms skip if unavailable */ }

function openDb(dbPath) {
  if (!_BetterSqlite || !existsSync(dbPath)) return null
  try { return _BetterSqlite(dbPath, { readonly: true, fileMustExist: true }) } catch { return null }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeRegex(query) {
  try { return new RegExp(query, "gi") } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
  }
}

function snippet(text, re, max = SNIPPET_MAX) {
  re.lastIndex = 0
  const m = re.exec(text)
  if (!m) return text.slice(0, max) + (text.length > max ? "…" : "")
  const half = Math.floor(max / 2)
  const start = Math.max(0, m.index - half)
  const end = Math.min(text.length, start + max)
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "")
}

function pushHit(map, key, source, projectPath, sessionId, text, re) {
  if (!map.has(key)) map.set(key, { source, projectPath, sessionId, snippets: [] })
  const entry = map.get(key)
  if (entry.snippets.length < 3) entry.snippets.push(snippet(text, re))
}

export function codexSearchIdentity(filePath, fallbackSessionId, fallbackProjectPath) {
  const result = readCodexSession(filePath, null, null)
  const sessionId = result?.meta?.id ?? fallbackSessionId
  const projectPath = result?.meta?.projectPath ?? fallbackProjectPath
  return { sessionId, projectPath, key: `codex:${projectPath}:${sessionId}` }
}

// ── Claude JSONL extractor ────────────────────────────────────────────────────
// Format: one JSON object per line
// Extract: message.content (string | {type:"text",text}[] | {type:"thinking",thinking}[])
//          data field (string) for some tool result lines

function extractClaudeLine(obj) {
  const parts = []
  const content = obj?.message?.content
  if (typeof content === "string") {
    parts.push(content)
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === "text" && b.text) parts.push(b.text)
      else if (b?.type === "thinking" && b.thinking) parts.push(b.thinking)
      // Skip tool_use/tool_result — those are metadata/code, not user content
    }
  }
  // data field: used by some tool result lines (plain string)
  if (typeof obj?.data === "string" && obj.data.trim()) parts.push(obj.data)
  return parts.join("\n").trim()
}

async function searchClaudeDir(dir, re, limit, results) {
  if (!existsSync(dir)) return
  for (const project of readdirSync(dir)) {
    const projectPath = join(dir, project)
    for (const file of readdirSync(projectPath).filter(f => f.endsWith(".jsonl"))) {
      const filePath = join(projectPath, file)
      const sessionId = basename(file, ".jsonl")
      const key = `claude:${projectPath}:${sessionId}`
      if (results.size >= limit) return
      await streamJsonlFile(filePath, obj => {
        const text = extractClaudeLine(obj)
        if (!text) return false
        re.lastIndex = 0
        if (!re.test(text)) return false
        pushHit(results, key, "claude", projectPath, sessionId, text, re)
        return false // keep scanning for more snippets (up to 3)
      })
    }
  }
}

// ── Codex JSONL extractor ─────────────────────────────────────────────────────
// Format: one JSON object per line, typed events
// Extract:
//   event_msg + type=user_message → payload.message (string)
//   event_msg + type=agent_message → payload.message (string)
//   response_item + type=message + role=assistant → payload.content[].text (output_text)
//   response_item + type=function_call_output → NOT extracted (tool output noise)

function extractCodexLine(obj) {
  if (obj?.type === "event_msg") {
    const t = obj?.payload?.type
    if (t === "user_message" || t === "agent_message") {
      const msg = obj?.payload?.message
      if (typeof msg === "string" && msg.trim()) return msg.trim()
    }
    return null
  }
  if (obj?.type === "response_item") {
    const p = obj?.payload
    // Assistant text messages only
    if (p?.type === "message" && p?.role === "assistant") {
      const parts = []
      for (const b of (p.content ?? [])) {
        if ((b.type === "output_text" || b.type === "text") && b.text) parts.push(b.text)
      }
      return parts.join("\n").trim() || null
    }
    // Reasoning blocks (thinking)
    if (p?.type === "reasoning") {
      const parts = []
      for (const b of (p.content ?? [])) {
        if (b.type === "thinking" && b.thinking) parts.push(b.thinking)
      }
      return parts.join("\n").trim() || null
    }
    // Skip function_call, function_call_output, session_meta, task_started, etc.
  }
  return null
}

async function searchCodexDir(dir, re, limit, results) {
  if (!existsSync(dir)) return
  // Walk YYYY/MM/DD/rollout-*.jsonl
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(join(d, entry.name)); continue }
      if (!entry.name.endsWith(".jsonl")) continue
      const filePath = join(d, entry.name)
      const sessionId = entry.name.slice(0, -6) // strip .jsonl
      const projectPath = d
      if (results.size < limit) {
        // Can't await inside sync walk; collect paths instead
        _codexPending.push({ filePath, sessionId, projectPath, identity: null })
      }
    }
  }
  const _codexPending = []
  walk(dir)
  for (const pending of _codexPending) {
    if (results.size >= limit) break
    await streamJsonlFile(pending.filePath, obj => {
      const text = extractCodexLine(obj)
      if (!text) return false
      re.lastIndex = 0
      if (!re.test(text)) return false
      pending.identity ??= codexSearchIdentity(pending.filePath, pending.sessionId, pending.projectPath)
      const { key, projectPath, sessionId } = pending.identity
      pushHit(results, key, "codex", projectPath, sessionId, text, re)
      return false
    })
  }
}

// ── JSONL streaming helper ────────────────────────────────────────────────────

function streamJsonlFile(filePath, onLine) {
  return new Promise(resolve => {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
    rl.on("line", line => {
      if (!line.trim()) return
      let obj
      try { obj = JSON.parse(line) } catch { return }
      onLine(obj)
    })
    rl.on("close", resolve)
    rl.on("error", resolve)
  })
}

// ── Cursor SQLite search ──────────────────────────────────────────────────────
// cursorDiskKV table: key LIKE 'bubbleId:%', value JSON
// Text fields: $.text (plain), $.richText (ProseMirror JSON — extract text nodes)
// Skip tool bubbles (type != 1 and != 2: user=1, assistant=2)

function extractCursorBubbleText(row) {
  // row.text is the primary plain text field
  if (row.text && row.text.trim()) return row.text.trim()
  // richText is ProseMirror JSON — extract text nodes
  if (row.richText) {
    try {
      const doc = JSON.parse(row.richText)
      return extractProseMirrorText(doc).trim()
    } catch { /* ignore */ }
  }
  return null
}

function extractProseMirrorText(node) {
  if (!node) return ""
  if (node.type === "text") return node.text ?? ""
  const parts = []
  if (Array.isArray(node.content)) {
    for (const child of node.content) parts.push(extractProseMirrorText(child))
  }
  return parts.join(" ")
}

async function searchCursor(re, limit, results) {
  const { CURSOR_GLOBAL_DB } = await import("../platform-readers.mjs")
  if (!existsSync(CURSOR_GLOBAL_DB)) return
  const db = openDb(CURSOR_GLOBAL_DB)
  if (!db) return

  // Get all composers first
  const composers = db.prepare(
    "SELECT substr(key,14) as cid, json_extract(value,'$.name') as name FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND key NOT LIKE 'composerData:composer%'"
  ).all()

  for (const { cid: composerId, name } of composers) {
    if (results.size >= limit) break
    const rows = db.prepare(
      "SELECT json_extract(value,'$.type') as type, json_extract(value,'$.text') as text, json_extract(value,'$.richText') as richText, json_extract(value,'$.bubbleId') as bid FROM cursorDiskKV WHERE key LIKE ? AND (json_extract(value,'$.type') = 1 OR json_extract(value,'$.type') = 2)"
    ).all(`bubbleId:${composerId}:%`)

    const key = `cursor:cursor:${composerId}:${composerId}`
    for (const row of rows) {
      if (results.size >= limit) break
      const text = extractCursorBubbleText(row)
      if (!text) continue
      re.lastIndex = 0
      if (!re.test(text)) continue
      if (!results.has(key)) {
        results.set(key, { source: "cursor", projectPath: `cursor:${composerId}`, sessionId: composerId, snippets: [] })
      }
      const entry = results.get(key)
      if (entry.snippets.length < 3) entry.snippets.push(snippet(text, re))
    }
  }
}

// ── Hermes SQLite search ──────────────────────────────────────────────────────
// messages table: role TEXT, content TEXT (plain string), session_id TEXT

async function searchHermes(re, limit, results) {
  const { HERMES_DB } = await import("../platform-readers.mjs")
  if (!existsSync(HERMES_DB)) return
  const db = openDb(HERMES_DB)
  if (!db) return

  const rows = db.prepare(
    "SELECT session_id, role, content FROM messages WHERE role IN ('user','assistant') AND content IS NOT NULL AND content != '' ORDER BY timestamp"
  ).all()

  for (const row of rows) {
    if (results.size >= limit) break
    const text = typeof row.content === "string" ? row.content.trim() : ""
    if (!text) continue
    re.lastIndex = 0
    if (!re.test(text)) continue
    const key = `hermes::${row.session_id}`
    if (!results.has(key)) {
      results.set(key, { source: "hermes", projectPath: "hermes:", sessionId: row.session_id, snippets: [] })
    }
    const entry = results.get(key)
    if (entry.snippets.length < 3) entry.snippets.push(snippet(text, re))
  }
}

// ── OpenCode SQLite search ────────────────────────────────────────────────────
// part table: session_id TEXT, data JSON
// Extract: data.type=text → data.text; data.type=tool (skip)

async function searchOpenCode(re, limit, results) {
  const { OPENCODE_DB } = await import("../platform-readers.mjs")
  if (!existsSync(OPENCODE_DB)) return
  const db = openDb(OPENCODE_DB)
  if (!db) return

  // Get sessions for projectPath lookup
  const sessions = db.prepare("SELECT id, directory FROM session").all()
  const sessionDirMap = new Map(sessions.map(s => [s.id, s.directory ?? ""]))

  // Only fetch text parts
  const rows = db.prepare(
    "SELECT session_id, json_extract(data,'$.text') as text FROM part WHERE json_extract(data,'$.type') = 'text' AND json_extract(data,'$.text') IS NOT NULL AND json_extract(data,'$.text') != ''"
  ).all()

  for (const row of rows) {
    if (results.size >= limit) break
    const text = typeof row.text === "string" ? row.text.trim() : ""
    if (!text) continue
    re.lastIndex = 0
    if (!re.test(text)) continue
    const dir = sessionDirMap.get(row.session_id) ?? ""
    const projectPath = `opencode:${dir}`
    const key = `opencode:${row.session_id}`
    if (!results.has(key)) {
      results.set(key, { source: "opencode", projectPath, sessionId: row.session_id, snippets: [] })
    }
    const entry = results.get(key)
    if (entry.snippets.length < 3) entry.snippets.push(snippet(text, re))
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const CLAUDE_DIR = join(HOME, ".claude", "projects")
const CODEX_DIR  = join(HOME, ".codex", "sessions")

export async function contentSearch(query, { limit = 100 } = {}) {
  if (!query?.trim()) return []
  const re = makeRegex(query)
  const results = new Map()

  await Promise.all([
    searchClaudeDir(CLAUDE_DIR, re, limit, results),
    searchCodexDir(CODEX_DIR, re, limit, results),
    searchCursor(re, limit, results).catch(() => {}),
    searchHermes(re, limit, results).catch(() => {}),
    searchOpenCode(re, limit, results).catch(() => {}),
  ])

  return Array.from(results.values()).slice(0, limit)
}

/**
 * Streaming variant — calls onChunk(hits[]) as each platform finishes.
 * All platforms run concurrently; fast SQLite ones call back first.
 */
export async function contentSearchStream(query, { limit = 100 } = {}, onChunk) {
  if (!query?.trim()) return
  const re = makeRegex(query)

  function platform(fn) {
    const map = new Map()
    return fn(re, limit, map).catch(() => {}).then(() => {
      const hits = Array.from(map.values())
      if (hits.length) onChunk(hits)
    })
  }

  await Promise.all([
    platform((r, lim, map) => searchCursor(r, lim, map)),
    platform((r, lim, map) => searchHermes(r, lim, map)),
    platform((r, lim, map) => searchOpenCode(r, lim, map)),
    platform((r, lim, map) => searchClaudeDir(CLAUDE_DIR, r, lim, map)),
    platform((r, lim, map) => searchCodexDir(CODEX_DIR, r, lim, map)),
  ])
}
