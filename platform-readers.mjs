/**
 * platform-readers.mjs — shared platform session readers
 *
 * Exports pure reader functions for Cursor (IDE + CLI agent), OpenCode, Antigravity, and Hermes.
 * Used by both daemon/watch.mjs (streaming sync) and local-server.mjs (direct read).
 *
 * Each reader returns { meta, msgs }[] and does NOT modify shared state.
 * Change-detection caches are managed by the callers.
 */

import fs from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"

// ── Shared helpers ────────────────────────────────────────────────────────────

export function normProjectDir(absDir) {
  return absDir.replace(homedir(), "").replace(/\//g, "-").replace(/^-/, "")
}

export function sqliteQuery(dbPath, sql, opts = {}) {
  try {
    const b = opts.busyTimeoutMs
    const ms = b === 0 ? 0 : Number.isFinite(b) && b > 0 ? Math.floor(b) : 8000
    // `.timeout` via stdin: mixing PRAGMA + SELECT in one -json arg yields two JSON blobs and breaks parse.
    const input = ms > 0 ? `.timeout ${ms}\n${sql}\n` : `${sql}\n`
    const out = execFileSync("sqlite3", ["-json", dbPath], {
      input,
      encoding: "utf8",
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    })
    return JSON.parse(out.trim() || "[]")
  } catch { return [] }
}

// ── Cursor ────────────────────────────────────────────────────────────────────
//
// Cursor stores all chats in a single global KV database:
//   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//   Table: cursorDiskKV (key TEXT, value TEXT)
//
// Key formats:
//   composerData:{composerId}  — session header JSON:
//     { name, createdAt, lastUpdatedAt, subtitle,
//       fullConversationHeadersOnly: [{bubbleId, type}], isArchived, isDraft }
//   bubbleId:{composerId}:{bubbleId}  — message JSON:
//     { type: 1 (user) | 2 (assistant), text, ... }
//     Older bubbles: top-level createdAt. Newer (_v>=3) often omit it — use composerData times.
//
// Workspace mapping:
//   workspaceStorage/{hash}/state.vscdb  (ItemTable)
//     key: "composer.composerData"  → { allComposers: [{composerId}] }
//   workspaceStorage/{hash}/workspace.json → { folder: "file:///path" }

const CURSOR_GLOBAL_DB = path.join(
  homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"
)
const CURSOR_WS_DIR = path.join(
  homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage"
)

function buildCursorComposerWorkspaceMap() {
  // Returns Map<composerId, workspaceFolderPath>
  const map = new Map()
  if (!fs.existsSync(CURSOR_WS_DIR)) return map
  for (const hash of fs.readdirSync(CURSOR_WS_DIR)) {
    // Get folder path from workspace.json
    let folder = ""
    try {
      const wj = JSON.parse(fs.readFileSync(path.join(CURSOR_WS_DIR, hash, "workspace.json"), "utf8"))
      folder = wj.folder?.replace("file://", "") ?? ""
    } catch { /* no workspace.json */ }
    if (!folder) continue

    // Get composer IDs associated with this workspace
    const wsDb = path.join(CURSOR_WS_DIR, hash, "state.vscdb")
    if (!fs.existsSync(wsDb)) continue
    const rows = sqliteQuery(wsDb, "SELECT value FROM ItemTable WHERE key='composer.composerData' LIMIT 1")
    if (!rows.length || !rows[0].value) continue
    try {
      const data = JSON.parse(rows[0].value)
      for (const c of (data.allComposers ?? [])) {
        if (c.composerId) map.set(c.composerId, folder)
      }
    } catch { /* skip */ }
  }
  return map
}

/** Parse Cursor JSON timestamp: ms since epoch, ISO string, or Unix seconds (heuristic). */
function parseCursorMs(v) {
  if (v == null || v === "") return null
  const n = Number(v)
  if (Number.isFinite(n)) {
    const ms = n < 1e12 ? n * 1000 : n
    return ms
  }
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

function msToIso(ms) {
  if (ms == null || !Number.isFinite(ms)) return new Date(0).toISOString()
  return new Date(ms).toISOString()
}

/** Lexical editor JSON (richText) → plain text when $.text is empty (_v>=3). DFS handles paragraphs, lists, headings. */
function extractLexicalPlainText(richTextJsonStr) {
  if (!richTextJsonStr || typeof richTextJsonStr !== "string") return ""
  try {
    const obj = JSON.parse(richTextJsonStr)
    const parts = []
    function walk(node) {
      if (node == null) return
      if (Array.isArray(node)) {
        for (const x of node) walk(x)
        return
      }
      if (typeof node !== "object") return
      if (node.type === "text" && typeof node.text === "string") parts.push(node.text)
      if (node.type === "linebreak") parts.push("\n")
      if (node.children) walk(node.children)
    }
    walk(obj.root ?? obj)
    return parts.join("").replace(/\n{3,}/g, "\n\n").trim()
  } catch {
    return ""
  }
}

/** Assistant bubbles with empty $.text are often tool calls — surface tool + args + result preview. */
function formatCursorToolBubble(row) {
  const name = row.toolName
  const hasTool = name || row.toolRawArgs || row.toolResultPreview
  if (!hasTool) return ""
  const head = name ? `**${name}**` : "**tool**"
  const st = row.toolStatus ? ` (${row.toolStatus})` : ""
  let body = ""
  if (row.toolRawArgs) {
    try {
      const o = JSON.parse(row.toolRawArgs)
      body = "\n\n```json\n" + JSON.stringify(o, null, 2).slice(0, 3500) + "\n```"
    } catch {
      body = "\n\n```\n" + String(row.toolRawArgs).slice(0, 3500) + "\n```"
    }
  }
  if (row.toolResultPreview) {
    const tr = String(row.toolResultPreview)
    body += "\n\n**Result:**\n```\n" + tr.slice(0, 5000) + (tr.length > 5000 ? "\n…" : "") + "\n```"
  }
  return head + st + body
}

function cursorBubbleText(row) {
  const raw = (row.text ?? "").trim()
  if (raw) return raw
  const fromLex = extractLexicalPlainText(row.richText)
  if (fromLex) return fromLex
  const tool = formatCursorToolBubble(row)
  if (tool) return tool
  const cb = (row.codeBlock0 ?? "").trim()
  if (cb) return "```\n" + cb + "\n```"
  return ""
}

/**
 * Reads all Cursor sessions from globalStorage/state.vscdb.
 * Returns { meta, msgs }[] — one entry per composer session.
 * Pass cacheGet/cacheSet (keyed by composerId, value = lastUpdatedAt) for change detection.
 * Pass `changedSet` (Set of composerIds) to limit to specific sessions,
 * or null/undefined to read all.
 */
/**
 * Convert raw bubble rows for a composerId into SessionMessage[].
 * `composerRow` is the composerData meta (for timestamps); `rows` are bubble rows.
 */
function cursorBubblesToMsgs(composerId, rows, composerRow) {
  const composerCreatedMs = parseCursorMs(composerRow?.createdAt)
  const composerUpdatedMs = parseCursorMs(composerRow?.lastUpdatedAt) ?? composerCreatedMs

  const sorted = [...rows].sort((a, b) => {
    const ta = parseCursorMs(a.ts)
    const tb = parseCursorMs(b.ts)
    if (ta != null && tb != null) return ta - tb
    if (ta != null) return -1
    if (tb != null) return 1
    return 0
  })

  const n = sorted.length
  const perBubbleMs = sorted.map((row, idx) => {
    const direct = parseCursorMs(row.ts)
    if (direct != null) return direct
    if (n <= 1) return composerUpdatedMs ?? composerCreatedMs ?? 0
    const c = composerCreatedMs ?? 0
    const u = composerUpdatedMs ?? c
    return c + ((u - c) * idx) / (n - 1)
  })

  const converted = []
  for (let si = 0; si < sorted.length; si++) {
    const msg = sorted[si]
    const role = msg.type === 2 ? "assistant" : "user"
    const bubbleId = msg.bid ?? `${composerId}-${converted.length}`

    const rawBubble = String(msg.text ?? "").trim()
    const fromLex = extractLexicalPlainText(msg.richText)
    const hasBubbleText = Boolean(rawBubble || fromLex)
    /** @type {string | unknown[]} */
    let content

    if (!hasBubbleText && msg.toolName && msg.toolRawArgs) {
      try {
        const input = JSON.parse(msg.toolRawArgs)
        const toolId = `cursor-${composerId}-${bubbleId}`
        content = [{ type: "tool_use", id: toolId, name: msg.toolName, input }]
        const preview = msg.toolResultPreview
        if (preview)
          content.push({
            type: "tool_result",
            tool_use_id: toolId,
            content:
              typeof preview === "string" ? preview : preview != null ? JSON.stringify(preview) : "",
          })
      } catch {
        content = cursorBubbleText(msg)
      }
    } else {
      content = cursorBubbleText(msg)
    }

    const emptyContent =
      typeof content === "string"
        ? !content.trim()
        : !Array.isArray(content) || content.length === 0
    if (emptyContent && role === "user") continue
    if (emptyContent && role === "assistant") content = "_(empty Cursor bubble)_"
    converted.push({
      uuid: `cursor-${composerId}-${bubbleId}`,
      parentUuid: null,
      type: role === "assistant" ? "assistant" : "human",
      sessionId: composerId,
      timestamp: msToIso(perBubbleMs[si]),
      isSidechain: false,
      message: { role, content },
    })
  }
  return converted
}

const CURSOR_BUBBLE_SELECT =
  "SELECT substr(key,10,36) as cid, json_extract(value,'$.type') as type, json_extract(value,'$.text') as text, json_extract(value,'$.richText') as richText, json_extract(value,'$.toolFormerData.name') as toolName, json_extract(value,'$.toolFormerData.status') as toolStatus, json_extract(value,'$.toolFormerData.rawArgs') as toolRawArgs, substr(json_extract(value,'$.toolFormerData.result'),1,8000) as toolResultPreview, json_extract(value,'$.codeBlocks[0].content') as codeBlock0, COALESCE(json_extract(value,'$.createdAt'), json_extract(value,'$.timestamp')) as ts, json_extract(value,'$.bubbleId') as bid FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"

/**
 * Load full messages for a single Cursor composer session.
 * Used by local-server on /api/session/ — fast since it queries only one composerId.
 */
export function readCursorSessionMsgs(composerId) {
  if (!fs.existsSync(CURSOR_GLOBAL_DB)) return []
  const composerRows = sqliteQuery(CURSOR_GLOBAL_DB,
    `SELECT substr(key,14) as cid, json_extract(value,'$.name') as name, json_extract(value,'$.lastUpdatedAt') as lastUpdatedAt, json_extract(value,'$.createdAt') as createdAt FROM cursorDiskKV WHERE key = 'composerData:${composerId}' LIMIT 1`)
  const composerRow = composerRows[0] ?? null
  const rows = sqliteQuery(CURSOR_GLOBAL_DB,
    `${CURSOR_BUBBLE_SELECT} AND key LIKE 'bubbleId:${composerId}:%' ORDER BY key`)
  return cursorBubblesToMsgs(composerId, rows, composerRow)
}

/**
 * Reads Cursor session metadata (fast — no full bubble text fetched).
 * Returns { meta, msgs: [] }[] — msgs is always empty; use readCursorSessionMsgs() on demand.
 *
 * Uses only bubble aggregate queries (COUNT + first/last key join) to avoid reading
 * composerData blobs (up to 600KB each, 320 sessions = ~150MB total disk I/O).
 */
export function readCursorSessions(cacheGet, cacheSet, changedSet) {
  if (!fs.existsSync(CURSOR_GLOBAL_DB)) return []

  const wsMap = buildCursorComposerWorkspaceMap()

  // Single query: count + last-bubble timestamp + first-bubble snippet (all key-based, fast)
  // The JOIN on maxKey/minKey is a PK lookup — ~0.2s total vs 37s reading full blobs.
  const rows = sqliteQuery(CURSOR_GLOBAL_DB, `
    SELECT b.cid, b.n,
      COALESCE(json_extract(last_val.value,'$.createdAt'), json_extract(last_val.value,'$.timestamp')) as lastTs,
      substr(json_extract(first_val.value,'$.text'),1,80) as firstText,
      json_extract(first_val.value,'$.type') as firstType
    FROM (
      SELECT substr(key,10,36) as cid, count(*) as n, max(key) as maxKey, min(key) as minKey
      FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'
      GROUP BY substr(key,10,36)
    ) b
    JOIN cursorDiskKV last_val ON last_val.key = b.maxKey
    JOIN cursorDiskKV first_val ON first_val.key = b.minKey
  `)

  const results = []
  for (const row of rows) {
    const composerId = row.cid
    if (!composerId || !row.n) continue

    const cacheVal = String(row.n)
    if (cacheGet && cacheGet(composerId) === cacheVal) continue
    if (cacheSet) cacheSet(composerId, cacheVal)

    const lastActivityMs = parseCursorMs(row.lastTs) ?? 0
    const workspaceFolder = wsMap.get(composerId) ?? ""
    const projectDir = workspaceFolder ? normProjectDir(workspaceFolder) : "cursor-unknown"
    // firstText is from first bubble; type=1 is user, type=2 is assistant
    const firstName = row.firstType === 1 && row.firstText ? row.firstText.replace(/<[^>]+>/g, "").trim() : null

    results.push({
      meta: {
        id: composerId,
        projectPath: `cursor:${projectDir}`,
        messageCount: Number(row.n),
        userMessageCount: null,  // unknown without loading bubbles
        lastActivity: msToIso(lastActivityMs),
        isActive: false,
        firstName,
        source: "cursor",
      },
      msgs: [],  // loaded on demand via readCursorSessionMsgs()
    })
  }

  return results
}

/**
 * Full Cursor session reader — loads all bubble text for every session.
 * Slow (reads all 50k+ rows) but needed by the daemon to sync messages to the Worker.
 * local-server uses readCursorSessions (metadata only) + readCursorSessionMsgs (on-demand).
 */
export function readCursorSessionsFull(cacheGet, cacheSet, changedSet) {
  if (!fs.existsSync(CURSOR_GLOBAL_DB)) return []

  const wsMap = buildCursorComposerWorkspaceMap()
  const results = []

  const composerMetaRows = sqliteQuery(CURSOR_GLOBAL_DB,
    "SELECT substr(key,14) as cid, json_extract(value,'$.name') as name, json_extract(value,'$.lastUpdatedAt') as lastUpdatedAt, json_extract(value,'$.createdAt') as createdAt FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
  const composerMeta = new Map()
  for (const row of composerMetaRows) composerMeta.set(row.cid, row)

  const BUBBLE_CHUNK = 2500
  const chunkBuf = 64 * 1024 * 1024
  const allRows = []
  for (let offset = 0; ; offset += BUBBLE_CHUNK) {
    const chunk = sqliteQuery(
      CURSOR_GLOBAL_DB,
      `${CURSOR_BUBBLE_SELECT} ORDER BY key LIMIT ${BUBBLE_CHUNK} OFFSET ${offset}`,
      { maxBuffer: chunkBuf }
    )
    if (!chunk.length) break
    allRows.push(...chunk)
    if (chunk.length < BUBBLE_CHUNK) break
  }

  const byCid = new Map()
  for (const row of allRows) {
    if (!row.cid) continue
    if (!byCid.has(row.cid)) byCid.set(row.cid, [])
    byCid.get(row.cid).push(row)
  }

  for (const [composerId, rows] of byCid) {
    const bubbleCount = String(rows.length)
    if (cacheGet && cacheGet(composerId) === bubbleCount) continue
    if (cacheSet) cacheSet(composerId, bubbleCount)

    const composer = composerMeta.get(composerId) ?? null
    const converted = cursorBubblesToMsgs(composerId, rows, composer)
    if (!converted.length) continue

    const composerCreatedMs = parseCursorMs(composer?.createdAt)
    const composerUpdatedMs = parseCursorMs(composer?.lastUpdatedAt) ?? composerCreatedMs
    let lastActivityMs = composerUpdatedMs ?? composerCreatedMs ?? 0
    for (const m of converted) {
      const t = Date.parse(m.timestamp)
      if (Number.isFinite(t) && t > lastActivityMs) lastActivityMs = t
    }

    const workspaceFolder = wsMap.get(composerId) ?? ""
    const projectDir = workspaceFolder ? normProjectDir(workspaceFolder) : "cursor-unknown"
    const firstUserText = converted.find(m => m.message.role === "user")?.message?.content
    const firstName = typeof firstUserText === "string"
      ? firstUserText.replace(/<[^>]+>/g, "").trim().slice(0, 80) : null

    results.push({
      meta: {
        id: composerId,
        projectPath: `cursor:${projectDir}`,
        messageCount: converted.length,
        userMessageCount: converted.filter(m => m.message.role === "user").length,
        lastActivity: msToIso(lastActivityMs > 0 ? lastActivityMs : 0),
        isActive: false,
        firstName: (composer?.name || null) ?? firstName,
        source: "cursor",
      },
      msgs: converted,
    })
  }

  return results
}

// ── Cursor CLI (cursor agent) ─────────────────────────────────────────────────
//
// Agent transcripts (JSONL), separate from IDE composer (state.vscdb):
//   ~/.cursor/projects/{workspace-slug}/agent-transcripts/{agentId}/{agentId}.jsonl
//   Subagents: .../{parentId}/subagents/{childId}.jsonl
// Slug = absolute workspace path with leading / dropped and / → - (same idea as normProjectDir).

export const CURSOR_PROJECTS_ROOT = path.join(homedir(), ".cursor", "projects")

/** Slug dir name under ~/.cursor/projects → absolute workspace path (best-effort). */
export function cursorAgentSlugToWorkspacePath(slug) {
  if (!slug) return ""
  return `/${slug.replace(/-/g, "/")}`
}

function extractCursorAgentMessageText(content) {
  if (content == null) return ""
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
    else if (block.type === "tool_use") {
      const name = block.name ?? "tool"
      let body = ""
      if (block.input != null) {
        try {
          body = "\n\n```json\n" + JSON.stringify(block.input, null, 2).slice(0, 8000) + "\n```"
        } catch {
          body = "\n\n```\n" + String(block.input).slice(0, 8000) + "\n```"
        }
      }
      parts.push(`**${name}**` + body)
    } else if (block.type === "tool_result") {
      const t = block.content
      const s = typeof t === "string" ? t : t != null ? JSON.stringify(t) : ""
      parts.push("**tool_result**\n\n```\n" + s.slice(0, 6000) + (s.length > 6000 ? "\n…" : "") + "\n```")
    }
  }
  return parts.join("\n\n").trim()
}

/** Plain user-visible text only (sidebar preview / title), no tool payloads. */
function cursorAgentFlattenUserText(content) {
  if (content == null) return ""
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  const parts = []
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text)
  }
  return parts.join("\n").trim()
}

/**
 * Preserve structured blocks for Pretty mode (parallel to Claude/OpenCode ingestion).
 * Returns a string only when transcript uses plain string messages.
 */
function cursorAgentBlocksFromMessageContent(raw, lineIdx) {
  const line =
    typeof lineIdx === "number" && Number.isFinite(lineIdx) ? Math.max(0, Math.floor(lineIdx)) : 0
  if (raw == null) return ""
  if (typeof raw === "string") return raw.trim()
  if (!Array.isArray(raw)) return ""
  const out = []
  for (const block of raw) {
    if (!block || typeof block !== "object") continue
    const t = block.type
    if (t === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text })
    else if (t === "thinking" || t === "reasoning") {
      const th = typeof block.thinking === "string"
        ? block.thinking
        : typeof block.text === "string"
          ? block.text
          : typeof block.reasoning === "string"
            ? block.reasoning
            : ""
      if (th) out.push({ type: "thinking", thinking: th })
    } else if (t === "tool_use") {
      const id =
        block.id ??
        block.tool_use_id ??
        block.call_id ??
        `cursor-agent-tool-${line}-${out.length}`
      let input = block.input ?? {}
      if (input && typeof input === "string") {
        try {
          input = JSON.parse(input)
        } catch {
          input = { _raw: block.input }
        }
      }
      out.push({
        type: "tool_use",
        id,
        name: block.name ?? "tool",
        input,
      })
    } else if (t === "tool_result") {
      const toolUseId =
        block.tool_use_id ?? block.toolUseId ?? block.call_id ?? block.callId ?? block.id
      out.push({
        type: "tool_result",
        tool_use_id: toolUseId ?? "unknown-tool",
        content: block.content,
      })
    } else if (t === "image") {
      out.push(block)
    }
  }
  if (out.length) return out
  if (Array.isArray(raw) && raw.length)
    return extractCursorAgentMessageText(raw)
  return ""
}

function cursorAgentRowHasAssistantBody(content) {
  if (typeof content === "string") return Boolean(content.trim())
  if (!Array.isArray(content)) return false
  return content.some(
    b =>
      (b?.type === "text" && b.text?.trim()) ||
      b?.type === "thinking" ||
      b?.type === "tool_use",
  )
}

function cursorAgentRowHasUserSignal(content) {
  if (typeof content === "string") return Boolean(content.trim())
  if (!Array.isArray(content)) return false
  return content.some(b => (b?.type === "text" && b.text?.trim()) || b?.type === "tool_result")
}

function parseCursorAgentJsonlLines(filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    return null
  }
  const lines = raw.split(/\n/).filter(Boolean)
  const converted = []
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    let row
    try {
      row = JSON.parse(lines[lineIdx])
    } catch {
      continue
    }
    const role = row.role === "assistant" ? "assistant" : "user"
    const structured = cursorAgentBlocksFromMessageContent(row.message?.content, lineIdx)
    /** @type {string | unknown[]} */
    let content =
      typeof structured === "string"
        ? structured
        : Array.isArray(structured) && structured.length
          ? structured
          : cursorAgentFlattenUserText(row.message?.content)

    const flatCheck =
      typeof content === "string"
        ? content.trim()
        : cursorAgentRowHasAssistantBody(content) || cursorAgentRowHasUserSignal(content)

    if (!flatCheck && role === "user") continue
    if (!flatCheck && role === "assistant") {
      content = "_(empty agent message)_"
    }
    const tsMs = Date.parse(row.timestamp) || null
    converted.push({
      lineIdx,
      role,
      content,
      tsMs,
    })
  }
  return { converted, lineCount: lines.length }
}

/**
 * If `absPath` is a Cursor CLI agent transcript .jsonl, returns { filePath, slug, sessionId }.
 */
export function parseCursorAgentTranscriptFilePath(absPath) {
  const norm = path.normalize(absPath)
  if (!norm.endsWith(".jsonl")) return null
  const parts = norm.split(path.sep)
  const at = parts.lastIndexOf("agent-transcripts")
  if (at < 1 || at + 2 >= parts.length) return null
  const slug = parts[at - 1]
  const agentId = parts[at + 1]
  if (parts[at + 2] === "subagents" && parts[at + 3]) {
    const leaf = parts[at + 3]
    if (!leaf.endsWith(".jsonl")) return null
    return { slug, sessionId: path.basename(leaf, ".jsonl"), filePath: norm }
  }
  const leaf = parts[at + 2]
  if (!leaf?.endsWith(".jsonl")) return null
  if (path.basename(leaf, ".jsonl") !== agentId) return null
  return { slug, sessionId: agentId, filePath: norm }
}

/** Lists Cursor agent transcript JSONL files; returns array of { filePath, slug, sessionId } */
export function listCursorAgentTranscriptFiles() {
  const root = CURSOR_PROJECTS_ROOT
  const out = []
  if (!fs.existsSync(root)) return out
  let slugs
  try {
    slugs = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const slug of slugs) {
    const atDir = path.join(root, slug, "agent-transcripts")
    if (!fs.existsSync(atDir)) continue
    let agentIds
    try {
      agentIds = fs.readdirSync(atDir)
    } catch {
      continue
    }
    for (const agentId of agentIds) {
      const agentDir = path.join(atDir, agentId)
      let st
      try {
        st = fs.statSync(agentDir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      const mainFile = path.join(agentDir, `${agentId}.jsonl`)
      if (fs.existsSync(mainFile)) {
        out.push({ filePath: mainFile, slug, sessionId: agentId })
      }
      const subDir = path.join(agentDir, "subagents")
      if (!fs.existsSync(subDir)) continue
      let subs
      try {
        subs = fs.readdirSync(subDir)
      } catch {
        continue
      }
      for (const f of subs) {
        if (!f.endsWith(".jsonl")) continue
        const childId = f.slice(0, -".jsonl".length)
        // Flat id (UUID) keeps /api/session/:project/:id URLs valid; projectPath already scopes by workspace slug.
        out.push({
          filePath: path.join(subDir, f),
          slug,
          sessionId: childId,
        })
      }
    }
  }
  return out
}

function buildCursorAgentSessionMetaAndMsgs(filePath, slug, sessionId, parsed, fileMtimeMs) {
  const { converted } = parsed
  if (!converted.length) return null

  const baseMs = Number.isFinite(fileMtimeMs) ? fileMtimeMs : Date.now()
  const n = converted.length
  const perLineMs = converted.map((row, idx) => {
    if (row.tsMs != null && Number.isFinite(row.tsMs)) return row.tsMs
    if (n <= 1) return baseMs
    return baseMs - (n - 1 - idx)
  })
  let lastActivityMs = 0
  for (const t of perLineMs) {
    if (t > lastActivityMs) lastActivityMs = t
  }

  const msgs = []
  for (let i = 0; i < converted.length; i++) {
    const row = converted[i]
    const role = row.role
    const type = role === "assistant" ? "assistant" : "human"
    msgs.push({
      uuid: `cursor-agent-${sessionId}-${row.lineIdx}`,
      parentUuid: null,
      type,
      sessionId,
      timestamp: msToIso(perLineMs[i]),
      isSidechain: false,
      message: { role, content: row.content },
    })
  }

  const firstUserRow = converted.find(r => r.role === "user")
  const firstUserText = firstUserRow ? cursorAgentFlattenUserText(firstUserRow.content) : ""
  const firstName = firstUserText
    ? firstUserText.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80)
    : null

  return {
    meta: {
      id: sessionId,
      projectPath: `cursor-agent:${slug}`,
      messageCount: msgs.length,
      userMessageCount: converted.filter(r => r.role === "user").length,
      lastActivity: msToIso(lastActivityMs),
      isActive: false,
      firstName,
      source: "cursor",
    },
    msgs,
  }
}

/**
 * Read one Cursor CLI agent transcript file.
 * cacheGet/cacheSet keyed by absolute file path; value `${mtimeMs}:${size}`.
 */
export function readCursorAgentSessionFile(filePath, slug, sessionId, cacheGet, cacheSet) {
  let st
  try {
    st = fs.statSync(filePath)
  } catch {
    return null
  }
  const cacheVal = `${st.mtimeMs}:${st.size}`
  if (cacheGet && cacheGet(filePath) === cacheVal) return null

  const parsed = parseCursorAgentJsonlLines(filePath)
  if (!parsed?.converted.length) return null
  const result = buildCursorAgentSessionMetaAndMsgs(filePath, slug, sessionId, parsed, st.mtimeMs)
  if (!result) return null
  if (cacheSet) cacheSet(filePath, cacheVal)
  return result
}

/**
 * All Cursor CLI agent sessions under ~/.cursor/projects.
 * Pass cacheGet(filePath) / cacheSet(filePath, mtimeSizeStr) for change detection.
 */
export function readCursorAgentSessions(cacheGet, cacheSet) {
  const results = []
  for (const { filePath, slug, sessionId } of listCursorAgentTranscriptFiles()) {
    const r = readCursorAgentSessionFile(filePath, slug, sessionId, cacheGet, cacheSet)
    if (r) results.push(r)
  }
  return results
}

// ── OpenCode ──────────────────────────────────────────────────────────────────
//
// OpenCode stores data under ~/.local/share/opencode/:
//   - opencode.db (SQLite) — current sessions/messages/parts (newer releases write here)
//   - storage/ — legacy and auxiliary files:
//     session/{projectHash|global}/{sessionId}.json
//     message/{sessionId}/{messageId}.json
//     part/{messageId}/{partId}.json

const OPENCODE_DIR = path.join(homedir(), ".local", "share", "opencode")
const OPENCODE_DB = path.join(OPENCODE_DIR, "opencode.db")
const OPENCODE_STORAGE = path.join(OPENCODE_DIR, "storage")

function ocPushPartObject(p, parts, fileFallbackId, orderHint) {
  const order = p.time?.start ?? orderHint ?? 0
  if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text, order })
  else if (p.type === "reasoning" && p.text) parts.push({ type: "thinking", thinking: p.text, order })
  else if (p.type === "tool" && p.tool) {
    const input = p.input ?? p.state?.input ?? {}
    const id = p.callID ?? p.id ?? (typeof fileFallbackId === "string" ? fileFallbackId : "")
    parts.push({ type: "tool_use", name: p.tool, input, id, order })
  }
}

function ocMergePartsToContent(parts) {
  if (!parts.length) return null
  const textParts = parts.filter(p => p.type === "text")
  if (parts.length === textParts.length && textParts.length === 1) return textParts[0].text
  return parts.map(({ order: _o, ...rest }) => rest)
}

function readOCMessageContent(messageId) {
  const partDir = path.join(OPENCODE_STORAGE, "part", messageId)
  if (!fs.existsSync(partDir)) return null
  const parts = []
  for (const pf of fs.readdirSync(partDir).filter(f => f.endsWith(".json"))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(partDir, pf), "utf8"))
      ocPushPartObject(p, parts, pf, 0)
    } catch { /* skip */ }
  }
  parts.sort((a, b) => a.order - b.order)
  return ocMergePartsToContent(parts)
}

function readOCMessageContentFromPartRows(dbPath, messageId) {
  const rows = sqliteQuery(
    dbPath,
    `SELECT data, time_created FROM part WHERE message_id = ${JSON.stringify(messageId)} ORDER BY time_created, id`
  )
  if (!rows.length) return null
  const parts = []
  for (const row of rows) {
    let p
    try { p = JSON.parse(row.data) } catch { continue }
    ocPushPartObject(p, parts, null, row.time_created)
  }
  parts.sort((a, b) => a.order - b.order)
  return ocMergePartsToContent(parts)
}

/**
 * Reads a single OpenCode session from its session JSON file.
 * Returns { meta, msgs, cacheKey } or null if unchanged.
 * Pass `cacheGet(sessionId)` / `cacheSet(sessionId, val)` for change detection;
 * pass null to always read.
 */
export function readOpenCodeSession(sessionFile, cacheGet, cacheSet) {
  let sessionData
  try { sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf8")) } catch { return null }
  if (!sessionData?.id) return null

  const sessionId = sessionData.id
  const updatedAt = sessionData.time?.updated ?? sessionData.time?.created ?? 0

  // Count total parts for change detection (updatedAt alone isn't enough)
  let totalParts = 0
  const msgDir0 = path.join(OPENCODE_STORAGE, "message", sessionId)
  if (fs.existsSync(msgDir0)) {
    for (const mf of fs.readdirSync(msgDir0)) {
      const pd = path.join(OPENCODE_STORAGE, "part", mf.replace(".json", ""))
      if (fs.existsSync(pd)) totalParts += fs.readdirSync(pd).length
    }
  }
  const cacheVal = `${updatedAt}:${totalParts}`
  if (cacheGet && cacheGet(sessionId) === cacheVal) return null
  if (cacheSet) cacheSet(sessionId, cacheVal)

  const messages = []
  if (fs.existsSync(msgDir0)) {
    for (const mf of fs.readdirSync(msgDir0).filter(f => f.endsWith(".json"))) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(msgDir0, mf), "utf8"))
        if (m.role === "user" || m.role === "assistant") messages.push(m)
      } catch { /* skip */ }
    }
  }
  messages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))

  const converted = messages.map((m, i) => {
    const content = readOCMessageContent(m.id) ?? m.summary?.title ?? `[${m.role} message]`
    return {
      uuid: m.id ?? `opencode-${sessionId}-${i}`,
      parentUuid: null,
      type: m.role === "assistant" ? "assistant" : "human",
      sessionId,
      timestamp: m.time?.created ? new Date(m.time.created).toISOString() : new Date().toISOString(),
      isSidechain: false,
      message: { role: m.role, content },
    }
  })

  const projectDir = sessionData.directory ? normProjectDir(sessionData.directory) : "opencode-global"

  return {
    meta: {
      id: sessionId,
      projectPath: `opencode:${projectDir}`,
      messageCount: converted.length,
      userMessageCount: converted.filter(m => m.message.role === "user").length,
      lastActivity: new Date(updatedAt || sessionData.time?.created || Date.now()).toISOString(),
      isActive: false,
      firstName: sessionData.title ?? null,
      source: "opencode",
      lastUsedModel: opencodeLastModelFromMessageRows(messages),
    },
    msgs: converted,
  }
}

function opencodeLastModelFromMessageRows(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const id = m.model?.modelID ?? m.modelID
    if (id) return id
  }
  return undefined
}

/**
 * OpenCode 1.x+ stores live sessions in opencode.db; storage/session JSON may lag.
 * Returns the same shape as readOpenCodeSession, or null if unchanged/invalid.
 */
export function readOpenCodeSessionFromSqlite(dbPath, sessionId, cacheGet, cacheSet) {
  if (!dbPath || !fs.existsSync(dbPath) || !sessionId) return null
  const sessRows = sqliteQuery(
    dbPath,
    `SELECT id, directory, title, time_updated, time_created, version
     FROM session WHERE id = ${JSON.stringify(sessionId)}`
  )
  if (!sessRows.length) return null
  const s = sessRows[0]
  const cnt = sqliteQuery(
    dbPath,
    `SELECT
      (SELECT COUNT(*) FROM message WHERE session_id = ${JSON.stringify(sessionId)}) AS messages,
     (SELECT COUNT(*) FROM part WHERE session_id = ${JSON.stringify(sessionId)}) AS parts`
  )[0] ?? { messages: 0, parts: 0 }
  const cacheVal = `db:${s.time_updated}:${cnt.messages}:${cnt.parts}`
  if (cacheGet && cacheGet(sessionId) === cacheVal) return null
  if (cacheSet) cacheSet(sessionId, cacheVal)

  const msgRows = sqliteQuery(
    dbPath,
    `SELECT id, data, time_created FROM message WHERE session_id = ${JSON.stringify(sessionId)} ORDER BY time_created, id`
  )
  const messages = []
  for (const row of msgRows) {
    let m
    try { m = JSON.parse(row.data) } catch { continue }
    if (m.role === "user" || m.role === "assistant") {
      m.id = m.id ?? row.id
      m._timeCreated = m.time?.created ?? row.time_created
      messages.push(m)
    }
  }
  messages.sort((a, b) => (a._timeCreated ?? 0) - (b._timeCreated ?? 0))

  const converted = messages.map((m, i) => {
    const mid = m.id ?? `opencode-${sessionId}-${i}`
    const content =
      readOCMessageContentFromPartRows(dbPath, mid) ?? m.summary?.title ?? `[${m.role} message]`
    return {
      uuid: mid,
      parentUuid: null,
      type: m.role === "assistant" ? "assistant" : "human",
      sessionId,
      timestamp: m.time?.created
        ? new Date(m.time.created).toISOString()
        : m._timeCreated
          ? new Date(m._timeCreated).toISOString()
          : new Date().toISOString(),
      isSidechain: false,
      message: { role: m.role, content },
    }
  })

  const projectDir = s.directory ? normProjectDir(s.directory) : "opencode-global"
  return {
    meta: {
      id: sessionId,
      projectPath: `opencode:${projectDir}`,
      messageCount: converted.length,
      userMessageCount: converted.filter(m => m.message.role === "user").length,
      lastActivity: new Date(s.time_updated || s.time_created || Date.now()).toISOString(),
      isActive: false,
      firstName: s.title || null,
      source: "opencode",
      lastUsedModel: opencodeLastModelFromMessageRows(messages),
    },
    msgs: converted,
  }
}

/**
 * Iterates all OpenCode sessions (SQLite first, then legacy JSON files not in DB).
 * Yields { sessionFile, result }[]; cacheGet/cacheSet are optional; pass null to always read.
 */
export function* iterOpenCodeSessions(cacheGet, cacheSet) {
  const inDb = new Set()
  if (fs.existsSync(OPENCODE_DB)) {
    for (const { id } of sqliteQuery(OPENCODE_DB, "SELECT id FROM session")) {
      if (!id) continue
      const result = readOpenCodeSessionFromSqlite(OPENCODE_DB, id, cacheGet, cacheSet)
      if (result) {
        inDb.add(id)
        yield { sessionFile: `sqlite:${id}`, result }
      }
    }
  }
  const sessionBaseDir = path.join(OPENCODE_STORAGE, "session")
  if (!fs.existsSync(sessionBaseDir)) return
  for (const projectHash of fs.readdirSync(sessionBaseDir)) {
    const projectDir = path.join(sessionBaseDir, projectHash)
    try { if (!fs.statSync(projectDir).isDirectory()) continue } catch { continue }
    for (const sf of fs.readdirSync(projectDir).filter(f => f.endsWith(".json"))) {
      const sessionId = sf.replace(/\.json$/, "")
      if (inDb.has(sessionId)) continue
      const sessionFile = path.join(projectDir, sf)
      const result = readOpenCodeSession(sessionFile, cacheGet, cacheSet)
      if (result) yield { sessionFile, result }
    }
  }
}

export { OPENCODE_DIR, OPENCODE_DB, OPENCODE_STORAGE }

// ── Codex ─────────────────────────────────────────────────────────────────────
//
// Codex stores rollout transcripts as JSONL event streams under:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<sessionId>.jsonl
//
// Relevant records:
//   session_meta            — session id, cwd, cli version
//   turn_context            — cwd/model/sandbox metadata
//   event_msg user_message  — plain user text
//   event_msg agent_message — commentary/status updates
//   response_item message   — assistant text
//   response_item function_call / function_call_output
//   response_item reasoning — may be encrypted; include only plain summaries when available

export const CODEX_SESSIONS_ROOT = path.join(homedir(), ".codex", "sessions")

function stringifyCodexToolOutput(value) {
  if (typeof value === "string") return value
  if (value == null) return ""
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function codexAssistantTextFromContent(content) {
  if (!Array.isArray(content)) return ""
  return content
    .map(item => item?.type === "output_text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function codexReasoningText(payload) {
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

function pushCodexAssistantBlocks(out, sessionId, seq, ts, blocks) {
  if (!blocks.length) return seq
  out.push({
    uuid: `codex-${sessionId}-a-${seq}`,
    parentUuid: out.length > 0 ? out[out.length - 1].uuid : null,
    type: "assistant",
    sessionId,
    timestamp: ts,
    isSidechain: false,
    message: { role: "assistant", content: blocks },
  })
  return seq + 1
}

function pushCodexToolResults(out, sessionId, seq, ts, blocks) {
  if (!blocks.length) return seq
  out.push({
    uuid: `codex-${sessionId}-u-${seq}`,
    parentUuid: out.length > 0 ? out[out.length - 1].uuid : null,
    type: "human",
    sessionId,
    timestamp: ts,
    isSidechain: false,
    message: { role: "user", content: blocks },
  })
  return seq + 1
}

function buildCodexSessionResult(filePath, rows, fileMtimeMs) {
  if (!rows.length) return null

  const sessionMeta = rows.find(r => r.type === "session_meta")?.payload ?? {}
  const turnContext = rows.find(r => r.type === "turn_context")?.payload ?? {}
  const sessionId = sessionMeta.id ?? path.basename(filePath, ".jsonl")
  if (!sessionId) return null

  const cwd = sessionMeta.cwd ?? turnContext.cwd ?? ""
  const projectDir = cwd ? normProjectDir(cwd) : "codex-global"
  const out = []
  let seq = 0
  let pendingAssistantBlocks = []
  let pendingToolResults = []
  let pendingTs = null

  function flushPending() {
    if (pendingAssistantBlocks.length) seq = pushCodexAssistantBlocks(out, sessionId, seq, pendingTs ?? new Date(fileMtimeMs).toISOString(), pendingAssistantBlocks)
    if (pendingToolResults.length) seq = pushCodexToolResults(out, sessionId, seq, pendingTs ?? new Date(fileMtimeMs).toISOString(), pendingToolResults)
    pendingAssistantBlocks = []
    pendingToolResults = []
    pendingTs = null
  }

  for (const row of rows) {
    const ts = typeof row.timestamp === "string" ? row.timestamp : new Date(fileMtimeMs).toISOString()
    if (row.type === "event_msg" && row.payload?.type === "user_message") {
      flushPending()
      const text = typeof row.payload.message === "string" ? row.payload.message.trim() : ""
      if (!text) continue
      out.push({
        uuid: `codex-${sessionId}-u-${seq++}`,
        parentUuid: out.length > 0 ? out[out.length - 1].uuid : null,
        type: "human",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: { role: "user", content: text },
      })
      continue
    }

    if (row.type === "event_msg" && row.payload?.type === "agent_message") {
      flushPending()
      const text = typeof row.payload.message === "string" ? row.payload.message.trim() : ""
      if (!text) continue
      out.push({
        uuid: `codex-${sessionId}-a-${seq++}`,
        parentUuid: out.length > 0 ? out[out.length - 1].uuid : null,
        type: "assistant",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: { role: "assistant", content: text },
      })
      continue
    }

    if (row.type !== "response_item" || !row.payload?.type) continue
    pendingTs ??= ts

    if (row.payload.type === "reasoning") {
      const thinking = codexReasoningText(row.payload)
      if (thinking) pendingAssistantBlocks.push({ type: "thinking", thinking })
      continue
    }

    if (row.payload.type === "function_call") {
      let input = {}
      try { input = JSON.parse(row.payload.arguments ?? "{}") } catch { input = { _raw: row.payload.arguments ?? "" } }
      pendingAssistantBlocks.push({
        type: "tool_use",
        id: row.payload.call_id ?? `${sessionId}-tool-${seq}-${pendingAssistantBlocks.length}`,
        name: row.payload.name ?? "tool",
        input,
      })
      continue
    }

    if (row.payload.type === "function_call_output") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: row.payload.call_id ?? undefined,
        content: stringifyCodexToolOutput(row.payload.output),
      })
      continue
    }

    if (row.payload.type === "message" && row.payload.role === "assistant") {
      flushPending()
      const text = codexAssistantTextFromContent(row.payload.content)
      if (!text) continue
      out.push({
        uuid: `codex-${sessionId}-a-${seq++}`,
        parentUuid: out.length > 0 ? out[out.length - 1].uuid : null,
        type: "assistant",
        sessionId,
        timestamp: ts,
        isSidechain: false,
        message: { role: "assistant", content: text },
      })
    }
  }

  flushPending()
  if (!out.length) return null

  const firstUserText = out.find(m => m.message?.role === "user" && typeof m.message?.content === "string")?.message?.content
  const firstName = typeof firstUserText === "string"
    ? firstUserText.replace(/\s+/g, " ").trim().slice(0, 80)
    : null
  const lastActivity = out[out.length - 1]?.timestamp ?? new Date(fileMtimeMs).toISOString()
  const userMessageCount = out.filter(m => m.message?.role === "user" && typeof m.message?.content === "string" && m.message.content.trim()).length

  return {
    meta: {
      id: sessionId,
      projectPath: `codex:${projectDir}`,
      messageCount: out.length,
      userMessageCount,
      lastActivity,
      isActive: Date.now() - fileMtimeMs < 5 * 60 * 1000,
      firstName,
      source: "codex",
      version: sessionMeta.cli_version ?? null,
      lastUsedModel: turnContext.model ?? null,
    },
    msgs: out,
  }
}

export function listCodexSessionFiles() {
  const out = []
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return out
  const stack = [CODEX_SESSIONS_ROOT]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full)
    }
  }
  return out
}

export function readCodexSession(filePath, cacheGet, cacheSet) {
  let st
  try { st = fs.statSync(filePath) } catch { return null }
  const cacheVal = `${st.mtimeMs}:${st.size}`
  if (cacheGet && cacheGet(filePath) === cacheVal) return null

  let rows
  try {
    rows = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch {
    return null
  }
  const result = buildCodexSessionResult(filePath, rows, st.mtimeMs)
  if (!result) return null
  if (cacheSet) cacheSet(filePath, cacheVal)
  return result
}

export function readCodexSessions(cacheGet, cacheSet) {
  const results = []
  for (const filePath of listCodexSessionFiles()) {
    const result = readCodexSession(filePath, cacheGet, cacheSet)
    if (result) results.push(result)
  }
  return results
}

// ── Antigravity ───────────────────────────────────────────────────────────────
//
// Antigravity ("Jetski" agent) stores session artifacts in:
//   ~/.gemini/antigravity/brain/{uuid}/*.md + *.md.metadata.json
//
// Session index (title + workspace) is stored as nested base64-protobuf in:
//   ~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb
//   key: antigravityUnifiedStateSync.trajectorySummaries

export const ANTIGRAVITY_BRAIN_DIR = path.join(homedir(), ".gemini", "antigravity", "brain")
const ANTIGRAVITY_STATE_DB = path.join(
  homedir(), "Library", "Application Support",
  "Antigravity", "User", "globalStorage", "state.vscdb"
)

export function parseAntigravitySessionIndex() {
  if (!fs.existsSync(ANTIGRAVITY_STATE_DB)) return []
  const rows = sqliteQuery(
    ANTIGRAVITY_STATE_DB,
    "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries' LIMIT 1"
  )
  if (!rows.length || !rows[0].value) return []
  try {
    const outer = Buffer.from(rows[0].value, "base64")
    const chunks = []
    const b64Re = /[A-Za-z0-9+/]{60,}={0,2}/g
    let m
    while ((m = b64Re.exec(outer.toString("binary"))) !== null) chunks.push(m[0])
    const sessions = []
    for (const chunk of chunks) {
      try {
        const decoded = Buffer.from(chunk, "base64")
        const text = decoded.toString("utf8")
        const uuidMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
        if (!uuidMatch) continue
        const id = uuidMatch[0]
        const beforeUuid = text.slice(0, text.indexOf(id))
        const titleMatch = beforeUuid.match(/([A-Za-z][A-Za-z0-9 ,.'"\-:!?]{5,})/)
        const title = titleMatch ? titleMatch[1].trim() : null
        const wsMatch = text.match(/file:\/\/\/[^\s\x00-\x1f"']{3,}/)
        const workspacePath = wsMatch ? wsMatch[0].replace("file://", "") : ""
        sessions.push({ id, title, workspacePath })
      } catch { /* skip */ }
    }
    const seen = new Set()
    return sessions.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true })
  } catch { return [] }
}

const ANTIGRAVITY_ARTIFACT_NAMES = ["task", "implementation_plan", "walkthrough", "architecture_rules"]
const ANTIGRAVITY_LABEL_MAP = {
  task: "Task",
  implementation_plan: "Implementation Plan",
  walkthrough: "Walkthrough",
  architecture_rules: "Architecture Rules",
}

// ── Antigravity live RPC reader ───────────────────────────────────────────────
//
// When the Antigravity language server is running, fetch full chat history via
// HTTP/JSON endpoints served on localhost.

function findAntigravityLanguageServer() {
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    const results = []
    for (const line of ps.split("\n")) {
      if (!line.includes("language_server")) continue
      if (!line.includes("Antigravity.app") && !line.includes("antigravity")) continue
      const pidMatch = line.match(/^\s*(\d+)/)
      if (!pidMatch) continue
      const pid = pidMatch[1]
      const csrfMatch = line.match(/--csrf_token[= ](\S+)/)
      const portMatch = line.match(/--extension_server_port[= ](\d+)/)
      const csrfToken = csrfMatch?.[1] ?? ""
      const extPort = portMatch?.[1] ? parseInt(portMatch[1]) : null
      let ports = []
      try {
        const lsof = execFileSync("lsof", ["-Pan", "-p", pid, "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 3000 })
        for (const l of lsof.split("\n")) {
          const m = l.match(/:(\d+)\s*\(LISTEN\)/)
          if (m) ports.push(parseInt(m[1]))
        }
      } catch { /* lsof may fail */ }
      if (extPort) ports.unshift(extPort)
      ports = [...new Set(ports)]
      results.push({ pid, csrfToken, ports })
    }
    return results
  } catch { return [] }
}

async function callAntigravityRpc(baseUrl, csrfToken, method, body = {}) {
  const res = await fetch(`${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-codeium-csrf-token": csrfToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function findWorkingAntigravityEndpoint(csrfToken, ports) {
  for (const port of ports) {
    for (const scheme of ["http", "https"]) {
      try {
        const data = await callAntigravityRpc(`${scheme}://127.0.0.1:${port}`, csrfToken, "GetAllCascadeTrajectories", {})
        if (data.trajectorySummaries) return { baseUrl: `${scheme}://127.0.0.1:${port}`, csrfToken, data }
      } catch { /* try next */ }
    }
  }
  return null
}

function antigravityStepsToMessages(cascadeId, steps) {
  const msgs = []

  // Group consecutive assistant steps into a single message with ContentBlock[]
  // so they render via the pretty card system (BashCard, FileReadCard, etc.)
  let pendingAssistantBlocks = []
  let pendingTs = null

  function flushAssistant(i) {
    if (!pendingAssistantBlocks.length) return
    msgs.push({
      uuid: `antigravity-${cascadeId}-step-${i}-asst`,
      parentUuid: msgs.length > 0 ? msgs[msgs.length - 1].uuid : null,
      type: "assistant",
      sessionId: cascadeId,
      timestamp: pendingTs ?? new Date().toISOString(),
      isSidechain: false,
      message: { role: "assistant", content: pendingAssistantBlocks },
    })
    pendingAssistantBlocks = []
    pendingTs = null
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const type = step.type ?? ""
    const ts = step.metadata?.createdAt ?? step.timestamp ?? new Date().toISOString()

    if (type.includes("USER_INPUT")) {
      flushAssistant(i)
      const items = step.userInput?.items ?? []
      const text = items.map(it => it.text ?? "").filter(Boolean).join("\n") || (step.userInput?.userResponse ?? "")
      if (!text) continue
      msgs.push({
        uuid: `antigravity-${cascadeId}-step-${i}`,
        parentUuid: msgs.length > 0 ? msgs[msgs.length - 1].uuid : null,
        type: "human",
        sessionId: cascadeId,
        timestamp: ts,
        isSidechain: false,
        message: { role: "user", content: text },
      })
    } else if (type.includes("PLANNER_RESPONSE") || type.includes("AGENT_RESPONSE")) {
      if (!pendingTs) pendingTs = ts
      const pr = step.plannerResponse ?? step.agentResponse ?? {}
      if (pr.thinking) pendingAssistantBlocks.push({ type: "thinking", thinking: pr.thinking })
      const toolCalls = pr.toolCalls ?? []
      for (const tc of toolCalls) {
        try {
          pendingAssistantBlocks.push({
            type: "tool_use",
            id: tc.id ?? `ag-${cascadeId}-tc-${i}`,
            name: tc.name ?? "unknown",
            input: (() => { try { return JSON.parse(tc.argumentsJson ?? "{}") } catch { return { _raw: tc.argumentsJson } } })(),
          })
        } catch { /* skip malformed */ }
      }
      if (!toolCalls.length && !pr.thinking) {
        const text = pr.response ?? ""
        if (text) pendingAssistantBlocks.push({ type: "text", text })
      }
    } else if (type.includes("EPHEMERAL_MESSAGE")) {
      if (!pendingTs) pendingTs = ts
      const text = step.ephemeralMessage?.text ?? step.ephemeralMessage?.message ?? ""
      if (text) pendingAssistantBlocks.push({ type: "text", text })
    } else if (type.includes("RUN_COMMAND")) {
      if (!pendingTs) pendingTs = ts
      const cmd = step.runCommand?.commandLine ?? step.runCommand?.proposedCommandLine ?? ""
      const out = step.runCommand?.combinedOutput ?? step.runCommand?.renderedOutput?.full ?? ""
      const id = `ag-${cascadeId}-run-${i}`
      pendingAssistantBlocks.push({ type: "tool_use", id, name: "Bash", input: { command: cmd, description: "run command" } })
      if (out) pendingAssistantBlocks.push({ type: "tool_result", tool_use_id: id, content: out.slice(0, 4000) })
    } else if (type.includes("VIEW_FILE") || type.includes("LIST_DIRECTORY")) {
      if (!pendingTs) pendingTs = ts
      const fp = step.viewFile?.absolutePath ?? step.viewFile?.absolutePathUri?.replace("file://", "")
        ?? step.listDirectory?.absolutePath ?? ""
      const toolName = type.includes("LIST_DIRECTORY") ? "LS" : "Read"
      pendingAssistantBlocks.push({ type: "tool_use", id: `ag-${cascadeId}-view-${i}`, name: toolName, input: { file_path: fp } })
    } else if (type.includes("FIND")) {
      if (!pendingTs) pendingTs = ts
      const query = step.find?.query ?? step.find?.pattern ?? ""
      pendingAssistantBlocks.push({ type: "tool_use", id: `ag-${cascadeId}-find-${i}`, name: "Glob", input: { pattern: query } })
    } else if (type.includes("ERROR")) {
      if (!pendingTs) pendingTs = ts
      const text = step.errorMessage?.shortError ?? step.errorMessage?.text ?? "[error]"
      pendingAssistantBlocks.push({ type: "text", text: `⚠ ${text}` })
    }
  }
  flushAssistant(steps.length)

  return msgs
}

/**
 * Fetch all Antigravity sessions from the live language server (if running).
 * Returns { meta, msgs }[] — one per cascade. Returns [] if server not found.
 */
export async function readAntigravityRpcSessions(indexMap) {
  const servers = findAntigravityLanguageServer()
  if (!servers.length) return []

  for (const { csrfToken, ports } of servers) {
    const endpoint = await findWorkingAntigravityEndpoint(csrfToken, ports)
    if (!endpoint) continue

    const { baseUrl, data } = endpoint
    const summaries = data.trajectorySummaries ?? {}
    const results = []

    for (const [cascadeId, summary] of Object.entries(summaries)) {
      try {
        let stepsData = await callAntigravityRpc(baseUrl, csrfToken, "GetCascadeTrajectorySteps", { cascadeId, verbosity: 1 })
        const steps = stepsData.steps ?? []
        const msgs = antigravityStepsToMessages(cascadeId, steps)

        const ws = (summary.workspaces ?? [])[0]?.absolutePath ?? ""
        const projectDir = ws ? normProjectDir(ws) : "antigravity-global"
        const indexEntry = indexMap instanceof Map ? indexMap.get(cascadeId) : null
        const lastModified = summary.lastModifiedTime ?? new Date().toISOString()

        results.push({
          meta: {
            id: cascadeId,
            projectPath: `antigravity:${projectDir}`,
            messageCount: msgs.length,
            userMessageCount: msgs.filter(m => m.message.role === "user").length,
            lastActivity: lastModified,
            isActive: true,
            firstName: summary.summary ?? indexEntry?.title ?? null,
            source: "antigravity",
          },
          msgs,
        })
      } catch { /* skip session on error */ }
    }
    return results
  }
  return []
}

/**
 * Reads a single Antigravity session's artifacts.
 * Returns { meta, msgs } or null if no artifacts found or unchanged.
 * cacheGet/cacheSet are optional for change detection (keyed by sessionId, value = brainDir mtime).
 */
export function readAntigravitySession(session, cacheGet, cacheSet) {
  const { id, title, workspacePath } = session
  const brainDir = path.join(ANTIGRAVITY_BRAIN_DIR, id)
  if (!fs.existsSync(brainDir)) return null

  let mtime = 0
  try { mtime = fs.statSync(brainDir).mtimeMs } catch { return null }
  if (cacheGet && cacheGet(id) === mtime) return null
  if (cacheSet) cacheSet(id, mtime)

  const parts = []
  let latestUpdatedAt = null
  for (const name of ANTIGRAVITY_ARTIFACT_NAMES) {
    const mdPath = path.join(brainDir, `${name}.md`)
    const metaPath = path.join(brainDir, `${name}.md.metadata.json`)
    if (!fs.existsSync(mdPath)) continue
    let content = ""
    try { content = fs.readFileSync(mdPath, "utf8").trim() } catch { continue }
    if (!content) continue
    let updatedAt = null
    try { updatedAt = JSON.parse(fs.readFileSync(metaPath, "utf8")).updatedAt ?? null } catch { /* optional */ }
    if (updatedAt && (!latestUpdatedAt || updatedAt > latestUpdatedAt)) latestUpdatedAt = updatedAt
    parts.push({ name, content, updatedAt })
  }
  if (!parts.length) return null

  const lastActivity = latestUpdatedAt ?? new Date().toISOString()
  const converted = []
  for (const part of parts) {
    converted.push({
      uuid: `antigravity-${id}-${part.name}-user`,
      parentUuid: null,
      type: "human",
      sessionId: id,
      timestamp: part.updatedAt ?? lastActivity,
      isSidechain: false,
      message: { role: "user", content: `[${ANTIGRAVITY_LABEL_MAP[part.name] ?? part.name}]` },
    })
    converted.push({
      uuid: `antigravity-${id}-${part.name}-assistant`,
      parentUuid: `antigravity-${id}-${part.name}-user`,
      type: "assistant",
      sessionId: id,
      timestamp: part.updatedAt ?? lastActivity,
      isSidechain: false,
      message: { role: "assistant", content: part.content },
    })
  }

  const projectDir = workspacePath ? normProjectDir(workspacePath) : "antigravity-global"
  return {
    meta: {
      id,
      projectPath: `antigravity:${projectDir}`,
      messageCount: converted.length,
      userMessageCount: parts.length,
      lastActivity,
      isActive: false,
      firstName: title ?? null,
      source: "antigravity",
    },
    msgs: converted,
  }
}

// ── Hermes ────────────────────────────────────────────────────────────────────
//
// Hermes Agent stores all sessions in a single SQLite database:
//   ~/.hermes/state.db
//   sessions (id TEXT, source TEXT, model TEXT, title TEXT, message_count INT,
//             started_at REAL, ended_at REAL, parent_session_id TEXT, ...)
//   messages (session_id TEXT, role TEXT, content TEXT, tool_calls TEXT,
//             reasoning TEXT, timestamp REAL, ...)
//
// `source` groups sessions by channel: "cli", "whatsapp", "telegram", etc.
// `parent_session_id` links sub-agent sessions (shown as sidechain, like Claude Code).

export const HERMES_DB = path.join(homedir(), ".hermes", "state.db")

/**
 * Reads all Hermes sessions from ~/.hermes/state.db.
 * Returns { meta, msgs }[].
 * Pass cacheGet/cacheSet (keyed by sessionId, value = message_count) for change detection.
 */
export function readHermesSessions(cacheGet, cacheSet) {
  if (!fs.existsSync(HERMES_DB)) return []

  const sessions = sqliteQuery(
    HERMES_DB,
    "SELECT id, source, model, title, message_count, started_at, ended_at, parent_session_id FROM sessions ORDER BY started_at DESC"
  )
  if (!sessions.length) return []

  const results = []

  for (const session of sessions) {
    const sessionId = session.id
    if (!sessionId) continue

    // Change detection: skip if message_count unchanged
    const cacheVal = String(session.message_count ?? 0)
    if (cacheGet && cacheGet(sessionId) === cacheVal) continue
    if (cacheSet) cacheSet(sessionId, cacheVal)

    const msgs = sqliteQuery(
      HERMES_DB,
      `SELECT role, content, tool_calls, reasoning, timestamp FROM messages WHERE session_id='${sessionId.replace(/'/g, "''")}' ORDER BY timestamp`
    )

    const converted = msgs.map((m, i) => {
      let content = m.content ?? ""
      // Include reasoning as thinking block if present
      if (m.reasoning) {
        content = [
          { type: "thinking", thinking: m.reasoning },
          ...(content ? [{ type: "text", text: content }] : []),
        ]
      }
      // Include tool calls if present
      if (m.tool_calls && !m.reasoning) {
        try {
          const calls = JSON.parse(m.tool_calls)
          if (Array.isArray(calls) && calls.length) {
            const blocks = calls.map(tc => ({
              type: "tool_use",
              id: tc.id ?? `hermes-${sessionId}-tool-${i}`,
              name: tc.function?.name ?? tc.name ?? "unknown",
              input: (() => { try { return JSON.parse(tc.function?.arguments ?? tc.arguments ?? "{}") } catch { return {} } })(),
            }))
            content = content ? [{ type: "text", text: content }, ...blocks] : blocks
          }
        } catch { /* malformed tool_calls, keep plain content */ }
      }

      return {
        uuid: `hermes-${sessionId}-${i}`,
        parentUuid: i > 0 ? `hermes-${sessionId}-${i - 1}` : null,
        type: m.role === "assistant" ? "assistant" : "human",
        sessionId,
        timestamp: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : new Date(session.started_at * 1000).toISOString(),
        isSidechain: !!session.parent_session_id,
        message: { role: m.role, content },
      }
    })

    const source = session.source ?? "cli"
    const projectPath = `hermes:${source}`
    const firstUserMsg = converted.find(m => m.message.role === "user")
    const firstText = typeof firstUserMsg?.message?.content === "string"
      ? firstUserMsg.message.content.trim().slice(0, 80)
      : null

    results.push({
      meta: {
        id: sessionId,
        projectPath,
        messageCount: converted.length,
        userMessageCount: converted.filter(m => m.message.role === "user").length,
        lastActivity: new Date((session.ended_at ?? session.started_at ?? 0) * 1000).toISOString(),
        isActive: !session.ended_at,
        firstName: session.title ?? firstText,
        source: "hermes",
        lastUsedModel: session.model,
        parentSessionId: session.parent_session_id ?? undefined,
        isSidechain: !!session.parent_session_id,
        agentType: session.parent_session_id ? "subagent" : undefined,
      },
      msgs: converted,
    })
  }

  return results
}
