/**
 * platform-readers.mjs — shared platform session readers
 *
 * Exports pure reader functions for Cursor, OpenCode, Antigravity, and Hermes.
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

export function sqliteQuery(dbPath, sql) {
  try {
    const out = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" })
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
//     { type: 1 (user) | 2 (assistant), text, codeBlocks, thinking, createdAt }
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

/**
 * Reads all Cursor sessions from globalStorage/state.vscdb.
 * Returns { meta, msgs }[] — one entry per composer session.
 * Pass cacheGet/cacheSet (keyed by composerId, value = lastUpdatedAt) for change detection.
 * Pass `changedSet` (Set of composerIds) to limit to specific sessions,
 * or null/undefined to read all.
 */
export function readCursorSessions(cacheGet, cacheSet, changedSet) {
  if (!fs.existsSync(CURSOR_GLOBAL_DB)) return []

  // Fetch all (or specific) composerData entries
  const composerRows = changedSet
    ? [...changedSet].flatMap(id => sqliteQuery(CURSOR_GLOBAL_DB, `SELECT key, value FROM cursorDiskKV WHERE key='composerData:${id}' LIMIT 1`))
    : sqliteQuery(CURSOR_GLOBAL_DB, "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")

  if (!composerRows.length) return []

  const wsMap = buildCursorComposerWorkspaceMap()
  const results = []

  for (const row of composerRows) {
    let composer
    try { composer = JSON.parse(row.value) } catch { continue }

    const composerId = row.key.replace("composerData:", "")
    if (!composerId || composer.isDraft) continue

    // Change detection: skip if lastUpdatedAt matches cache
    const cacheVal = composer.lastUpdatedAt ?? composer.createdAt ?? ""
    if (cacheGet && cacheGet(composerId) === cacheVal) continue
    if (cacheSet) cacheSet(composerId, cacheVal)

    const headers = composer.fullConversationHeadersOnly ?? []
    if (!headers.length) continue

    // Fetch bubble messages in one query using IN clause
    const bubbleIds = headers.map(h => h.bubbleId).filter(Boolean)
    if (!bubbleIds.length) continue

    const inClause = bubbleIds.map(id => `'bubbleId:${composerId}:${id}'`).join(",")
    const bubbleRows = sqliteQuery(
      CURSOR_GLOBAL_DB,
      `SELECT key, value FROM cursorDiskKV WHERE key IN (${inClause})`
    )

    // Build a map for ordered lookup
    const bubbleMap = new Map()
    for (const br of bubbleRows) {
      try {
        const msg = JSON.parse(br.value)
        const bid = br.key.split(":").slice(2).join(":")
        bubbleMap.set(bid, msg)
      } catch { /* skip */ }
    }

    // Convert to SessionMessage format, preserving header order
    const converted = []
    for (const h of headers) {
      const msg = bubbleMap.get(h.bubbleId)
      if (!msg) continue
      const role = msg.type === 2 ? "assistant" : "user"
      const content = msg.text ?? ""
      if (!content && role === "user") continue  // skip empty user turns
      converted.push({
        uuid: `cursor-${composerId}-${h.bubbleId}`,
        parentUuid: null,
        type: role === "assistant" ? "assistant" : "human",
        sessionId: composerId,
        timestamp: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date(composer.createdAt ?? Date.now()).toISOString(),
        isSidechain: false,
        message: { role, content },
      })
    }

    if (!converted.length) continue

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
        lastActivity: new Date(composer.lastUpdatedAt ?? composer.createdAt ?? Date.now()).toISOString(),
        isActive: false,
        firstName: composer.name ?? firstName,
        source: "cursor",
      },
      msgs: converted,
    })
  }

  return results
}

// ── OpenCode ──────────────────────────────────────────────────────────────────
//
// OpenCode stores sessions in ~/.local/share/opencode/storage/
//   session/{projectHash|global}/{sessionId}.json  — session metadata
//   message/{sessionId}/{messageId}.json           — message header
//   part/{messageId}/{partId}.json                 — actual text/tool content

const OPENCODE_STORAGE = path.join(homedir(), ".local", "share", "opencode", "storage")

function readOCMessageContent(messageId) {
  const partDir = path.join(OPENCODE_STORAGE, "part", messageId)
  if (!fs.existsSync(partDir)) return null
  const parts = []
  for (const pf of fs.readdirSync(partDir).filter(f => f.endsWith(".json"))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(partDir, pf), "utf8"))
      if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text, order: p.time?.start ?? 0 })
      else if (p.type === "reasoning" && p.text) parts.push({ type: "thinking", thinking: p.text, order: p.time?.start ?? 0 })
      else if (p.type === "tool" && p.tool) parts.push({ type: "tool_use", name: p.tool, input: p.input ?? {}, id: p.id ?? pf, order: p.time?.start ?? 0 })
    } catch { /* skip */ }
  }
  parts.sort((a, b) => a.order - b.order)
  if (!parts.length) return null
  const textParts = parts.filter(p => p.type === "text")
  if (parts.length === textParts.length && textParts.length === 1) return textParts[0].text
  return parts.map(({ order: _o, ...rest }) => rest)
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
      lastUsedModel: messages.find(m => m.model?.modelID)?.model?.modelID,
    },
    msgs: converted,
  }
}

/**
 * Iterates all OpenCode session files and returns {sessionFile, result}[].
 * cacheGet/cacheSet are optional; pass null to always read.
 */
export function* iterOpenCodeSessions(cacheGet, cacheSet) {
  const sessionBaseDir = path.join(OPENCODE_STORAGE, "session")
  if (!fs.existsSync(sessionBaseDir)) return
  for (const projectHash of fs.readdirSync(sessionBaseDir)) {
    const projectDir = path.join(sessionBaseDir, projectHash)
    try { if (!fs.statSync(projectDir).isDirectory()) continue } catch { continue }
    for (const sf of fs.readdirSync(projectDir).filter(f => f.endsWith(".json"))) {
      const sessionFile = path.join(projectDir, sf)
      const result = readOpenCodeSession(sessionFile, cacheGet, cacheSet)
      if (result) yield { sessionFile, result }
    }
  }
}

export { OPENCODE_STORAGE }

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
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const type = step.type ?? ""
    let role = null
    let content = null

    if (type.includes("USER_INPUT")) {
      role = "user"
      const items = step.userInput?.items ?? []
      content = items.map(it => it.text ?? "").filter(Boolean).join("\n") || (step.userInput?.userResponse ?? "")
    } else if (type.includes("PLANNER_RESPONSE") || type.includes("AGENT_RESPONSE")) {
      role = "assistant"
      const pr = step.plannerResponse ?? step.agentResponse ?? {}
      // Build content: thinking block + tool calls or fallback to response text
      const parts = []
      if (pr.thinking) parts.push(`*${pr.thinking.trim()}*`)
      const toolCalls = pr.toolCalls ?? []
      if (toolCalls.length) {
        for (const tc of toolCalls) {
          try { parts.push(`**${tc.name}**\n\`\`\`json\n${tc.argumentsJson ?? "{}"}\n\`\`\``) } catch { /* skip */ }
        }
      }
      if (!parts.length) parts.push(pr.response ?? "")
      content = parts.join("\n\n")
    } else if (type.includes("EPHEMERAL_MESSAGE")) {
      role = "assistant"
      content = step.ephemeralMessage?.text ?? step.ephemeralMessage?.message ?? ""
    } else if (type.includes("RUN_COMMAND")) {
      role = "assistant"
      const cmd = step.runCommand?.commandLine ?? step.runCommand?.proposedCommandLine ?? ""
      const out = step.runCommand?.combinedOutput ?? step.runCommand?.renderedOutput?.full ?? ""
      content = `\`\`\`shell\n$ ${cmd}\n${out}\`\`\``
    } else if (type.includes("VIEW_FILE")) {
      role = "assistant"
      const fp = step.viewFile?.absolutePath ?? step.viewFile?.absolutePathUri?.replace("file://", "") ?? ""
      content = `[View file: \`${fp}\`]`
    } else if (type.includes("ERROR")) {
      role = "assistant"
      content = step.errorMessage?.shortError ?? step.errorMessage?.text ?? "[error]"
    }

    if (!role || !content) continue

    msgs.push({
      uuid: `antigravity-${cascadeId}-step-${i}`,
      parentUuid: msgs.length > 0 ? msgs[msgs.length - 1].uuid : null,
      type: role === "assistant" ? "assistant" : "human",
      sessionId: cascadeId,
      timestamp: step.metadata?.createdAt ?? step.timestamp ?? new Date().toISOString(),
      isSidechain: false,
      message: { role, content },
    })
  }
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
