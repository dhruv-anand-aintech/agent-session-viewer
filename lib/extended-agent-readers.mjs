/**
 * Readers for coding-agent stores which are not part of the original viewer
 * platform set. All readers return the same { meta, msgs } shape as
 * platform-readers.mjs and keep transcript bodies local to the caller.
 */
import fs from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import {
  readCodexSession,
  readOpenCodeSessionFromSqlite,
  sqliteQuery,
} from "../platform-readers.mjs"

const require = createRequire(import.meta.url)
let BetterSqlite
try { BetterSqlite = require("better-sqlite3") } catch { /* subprocess fallback below */ }

export const PI_ROOT = path.join(homedir(), ".pi", "agent", "sessions")
export const GOOSE_DB = path.join(homedir(), ".local", "share", "goose", "sessions", "sessions.db")
export const MIMO_DB = path.join(homedir(), ".local", "share", "mimocode", "mimocode.db")
export const PIER_DB = path.join(homedir(), ".pier", "state_5.sqlite")
export const DEVIN_DB = path.join(homedir(), ".local", "share", "devin", "cli", "sessions.db")

export const EXTENDED_AGENT_PLATFORMS = Object.freeze([
  "pi", "goose", "mimo", "pier", "devin", "normalized-agents",
])

function iso(value, fallback = Date.now()) {
  if (value == null || value === "") return new Date(fallback).toISOString()
  const n = Number(value)
  if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n).toISOString()
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(fallback).toISOString()
}

function textFromContent(content) {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content.map(block => {
    if (typeof block === "string") return block
    if (block?.type === "text" || block?.type === "output_text") return block.text ?? block.content ?? ""
    return ""
  }).filter(Boolean).join("\n\n").trim()
}

function blocksFromContent(content, prefix) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const blocks = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const type = String(block.type ?? "").toLowerCase()
    if (type === "thinking" || type === "reasoning") blocks.push({ type: "thinking", thinking: block.thinking ?? block.text ?? "" })
    else if (type === "toolcall" || type === "tool_call" || type === "tool_use") blocks.push({
      type: "tool_use", id: block.id ?? `${prefix}-tool-${blocks.length}`, name: block.name ?? block.toolName ?? "tool", input: block.arguments ?? block.input ?? {},
    })
    else if (type === "toolresult" || type === "tool_result") blocks.push({
      type: "tool_result", tool_use_id: block.toolCallId ?? block.tool_use_id, content: block.content ?? block.result ?? block.text ?? "",
    })
    else if (type === "text" || type === "output_text") blocks.push({ type: "text", text: block.text ?? block.content ?? "" })
  }
  return blocks.length ? blocks : textFromContent(content)
}

function makeMsg({ source, sessionId, index, role, content, timestamp, parentUuid = null, isSidechain = false }) {
  const messageRole = role === "assistant" ? "assistant" : "user"
  return {
    uuid: `${source}-${sessionId}-${index}`,
    parentUuid,
    type: messageRole === "assistant" ? "assistant" : "human",
    sessionId,
    timestamp: iso(timestamp),
    isSidechain,
    message: { role: messageRole, content: blocksFromContent(content, `${source}-${sessionId}-${index}`) },
  }
}

function result({ source, id, projectPath, title, cwd, createdAt, updatedAt, msgs, parentSessionId, model }) {
  if (!msgs.length) return null
  const first = msgs.find(msg => msg.message?.role === "user")
  const firstText = textFromContent(first?.message?.content)
  return {
    meta: {
      id,
      projectPath: `${source}:${projectPath || cwd || `${source}-global`}`,
      messageCount: msgs.length,
      userMessageCount: msgs.filter(msg => msg.message?.role === "user").length,
      lastActivity: iso(updatedAt ?? msgs.at(-1)?.timestamp ?? createdAt),
      isActive: updatedAt ? Date.now() - Date.parse(iso(updatedAt)) < 5 * 60 * 1000 : false,
      firstName: title || firstText.replace(/\s+/g, " ").slice(0, 100) || null,
      source,
      lastUsedModel: model || undefined,
      parentSessionId: parentSessionId || undefined,
      isSidechain: !!parentSessionId,
      agentType: parentSessionId ? "subagent" : undefined,
    },
    msgs,
  }
}

function readJsonl(filePath) {
  try { return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }) } catch { return [] }
}

function readPiFile(filePath) {
  const rows = readJsonl(filePath)
  const header = rows.find(row => row.type === "session")
  if (!header?.id) return null
  const msgs = []
  for (const row of rows) {
    if (row.type !== "message" || !row.message) continue
    const role = row.message.role ?? row.role
    if (role !== "user" && role !== "assistant") continue
    msgs.push(makeMsg({ source: "pi", sessionId: header.id, index: msgs.length, role, content: row.message.content, timestamp: row.timestamp, parentUuid: msgs.at(-1)?.uuid ?? null }))
  }
  return result({ source: "pi", id: header.id, projectPath: header.cwd, cwd: header.cwd, createdAt: header.timestamp, updatedAt: rows.at(-1)?.timestamp, msgs, model: rows.find(row => row.type === "model_change")?.modelId })
}

export function readPiSessions(root = PI_ROOT) {
  if (!fs.existsSync(root)) return []
  const out = []
  const stack = [root]
  while (stack.length) {
    let entries = []
    try { entries = fs.readdirSync(stack.pop(), { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(entry.parentPath ?? root, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.endsWith(".jsonl")) { const parsed = readPiFile(full); if (parsed) out.push(parsed) }
    }
  }
  return out
}

function readGooseDb(dbPath = GOOSE_DB) {
  if (!fs.existsSync(dbPath)) return []
  const sessions = sqliteQuery(dbPath, "SELECT id, name, working_dir, created_at, updated_at, provider_name FROM sessions WHERE archived_at IS NULL OR archived_at = 0 ORDER BY updated_at DESC")
  return sessions.flatMap(session => {
    const rows = sqliteQuery(dbPath, `SELECT role, content_json, timestamp, created_timestamp FROM messages WHERE session_id='${String(session.id).replaceAll("'", "''")}' ORDER BY created_timestamp, id`)
    const msgs = rows.filter(row => row.role === "user" || row.role === "assistant").map((row, index) => makeMsg({ source: "goose", sessionId: session.id, index, role: row.role, content: (() => { try { return JSON.parse(row.content_json) } catch { return row.content_json ?? "" } })(), timestamp: row.timestamp ?? row.created_timestamp, parentUuid: index ? `goose-${session.id}-${index - 1}` : null }))
    return [result({ source: "goose", id: session.id, projectPath: session.working_dir, cwd: session.working_dir, title: session.user_set_name || session.name, createdAt: session.created_at, updatedAt: session.updated_at, msgs, model: session.provider_name })].filter(Boolean)
  })
}

function rebrandOpenCodeResult(parsed, source, projectPath) {
  if (!parsed) return null
  return { ...parsed, meta: { ...parsed.meta, source, projectPath: `${source}:${parsed.meta.projectPath.replace(/^opencode:/, "") || projectPath || `${source}-global`}` }, msgs: parsed.msgs.map(msg => ({ ...msg, uuid: msg.uuid.replace(/^opencode-/, `${source}-`) })) }
}

function readMimoDb(dbPath = MIMO_DB) {
  if (!fs.existsSync(dbPath)) return []
  const sessions = sqliteQuery(dbPath, "SELECT id, directory, title, time_created, time_updated, parent_id FROM session ORDER BY time_updated DESC")
  return sessions.flatMap(session => [rebrandOpenCodeResult(readOpenCodeSessionFromSqlite(dbPath, session.id, null, null), "mimo", session.directory)].filter(Boolean))
}

function readPierDb(dbPath = PIER_DB) {
  if (!fs.existsSync(dbPath)) return []
  const threads = sqliteQuery(dbPath, "SELECT id, rollout_path, cwd, title, created_at, updated_at, model FROM threads WHERE rollout_path IS NOT NULL ORDER BY updated_at DESC")
  const parentRows = sqliteQuery(dbPath, "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges")
  const parents = new Map(parentRows.map(row => [row.child_thread_id, row.parent_thread_id]))
  return threads.flatMap(thread => {
    const parsed = thread.rollout_path && fs.existsSync(thread.rollout_path) ? readCodexSession(thread.rollout_path, null, null) : null
    if (!parsed) return []
    return [result({ source: "pier", id: thread.id, projectPath: thread.cwd, cwd: thread.cwd, title: thread.title, createdAt: thread.created_at, updatedAt: thread.updated_at, parentSessionId: parents.get(thread.id), model: thread.model, msgs: parsed.msgs.map((msg, index) => ({ ...msg, uuid: `pier-${thread.id}-${index}`, sessionId: thread.id, parentUuid: index ? `pier-${thread.id}-${index - 1}` : null })) })].filter(Boolean)
  })
}

function readDevinDb(dbPath = DEVIN_DB) {
  if (!fs.existsSync(dbPath)) return []
  const sessions = sqliteQuery(dbPath, "SELECT id, working_directory, model, created_at, last_activity_at, title, hidden FROM sessions WHERE hidden = 0 OR hidden IS NULL ORDER BY last_activity_at DESC")
  return sessions.flatMap(session => {
    const rows = sqliteQuery(dbPath, `SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id='${String(session.id).replaceAll("'", "''")}' ORDER BY created_at, row_id`)
    const msgs = rows.flatMap((row, index) => {
      try {
        const parsed = JSON.parse(row.chat_message)
        if (parsed.role !== "user" && parsed.role !== "assistant") return []
        return [makeMsg({ source: "devin", sessionId: session.id, index, role: parsed.role, content: parsed.content, timestamp: row.created_at, parentUuid: index ? `devin-${session.id}-${index - 1}` : null })]
      } catch { return [] }
    })
    return [result({ source: "devin", id: session.id, projectPath: session.working_directory, cwd: session.working_directory, title: session.title, createdAt: session.created_at, updatedAt: session.last_activity_at, model: session.model, msgs })].filter(Boolean)
  })
}

function readNormalizedFile(filePath, source) {
  const rows = readJsonl(filePath)
  const header = rows.find(row => row.type === "session") ?? {}
  const id = header.id || path.basename(filePath, path.extname(filePath))
  const msgs = rows.filter(row => row.type === "message" && (row.role === "user" || row.role === "assistant" || row.message?.role)).map((row, index) => makeMsg({ source, sessionId: id, index, role: row.role ?? row.message.role, content: row.content ?? row.message.content, timestamp: row.timestamp, parentUuid: index ? `${source}-${id}-${index - 1}` : null }))
  return result({ source, id, projectPath: header.cwd, cwd: header.cwd, title: header.title, createdAt: header.startedAt, updatedAt: header.updatedAt, msgs })
}

export function readConfiguredAgentSessions() {
  const roots = process.env.ASV_AGENT_TRANSCRIPT_ROOTS?.split(",").map(pair => pair.trim()).filter(Boolean) ?? []
  const out = []
  for (const pair of roots) {
    const separator = pair.indexOf("=")
    if (separator < 1) continue
    const source = pair.slice(0, separator).trim()
    const root = pair.slice(separator + 1).replace(/^~/, homedir())
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const parsed = readNormalizedFile(path.join(root, entry.name), source)
      if (parsed) out.push(parsed)
    }
  }
  return out
}

export function readExtendedAgentSessions(platform = "all") {
  const results = []
  if (platform === "all" || platform === "pi") results.push(...readPiSessions())
  if (platform === "all" || platform === "goose") results.push(...readGooseDb())
  if (platform === "all" || platform === "mimo") results.push(...readMimoDb())
  if (platform === "all" || platform === "pier") results.push(...readPierDb())
  if (platform === "all" || platform === "devin") results.push(...readDevinDb())
  if (platform === "all" || platform === "normalized-agents") results.push(...readConfiguredAgentSessions())
  return results
}

export function isExtendedAgentProject(projectPath) {
  return /^(pi|goose|mimo|pier|devin|normalized-agents|aider|amazonq|amp|cline|cohere-north|command-code|crush|github-copilot-cli|github-copilot-coding-agent|jules|junie|kilo|kimi|kiro|muse|openhands|qwen|replit-agent|roo-code|trae|windsurf|zcode):/.test(projectPath)
}
