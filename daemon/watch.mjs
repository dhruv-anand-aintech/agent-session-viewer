#!/usr/bin/env node
/**
 * Claude Session Viewer — local file-watcher daemon
 *
 * Watches ~/.claude/projects/**\/*.jsonl for changes.
 * On each change, parses the session and PUTs it to the Cloudflare Worker
 * so the viewer receives live updates.
 *
 * Usage:  node daemon/watch.mjs [--worker <url>] [--pin <pin>]
 *   or:   WORKER_URL=... AUTH_PIN=... node daemon/watch.mjs
 *
 * Claw tool integration (nanoclaw is the primary supported tool):
 *   --nanoclaw <path>    nanoclaw repo dir (highest priority, checked first)
 *   NANOCLAW_DIR=<path>  env var alternative
 *   --openclaw / --picoclaw / etc. work the same way for other claw tools.
 * Auto-detection also checks ~/toolname and ~/.toolname for each known tool.
 * Path overrides saved in the viewer's settings UI are also read at startup.
 */

import fs from "node:fs"
import path from "node:path"
import { watch } from "node:fs"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { stripXml } from "../shared-utils.mjs"

// ── Config ────────────────────────────────────────────────────────────────────

// Load .env from project root (same dir as package.json, one level up from daemon/)
const envPath = path.join(import.meta.dirname, "..", ".env")
try {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const args = process.argv.slice(2)
const argGet = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const WORKER_URL = argGet("--worker") ?? process.env.WORKER_URL ?? ""
const AUTH_PIN   = argGet("--pin")    ?? process.env.AUTH_PIN ?? ""
const PROJECTS_DIR = path.join(homedir(), ".claude", "projects")
const DEBOUNCE_MS = 600

if (!WORKER_URL) {
  console.error("❌  WORKER_URL not set. Set --worker <url> or WORKER_URL env var.")
  process.exit(1)
}
if (!AUTH_PIN) {
  console.error("⚠  AUTH_PIN not set — syncs will be rejected by worker. Set --pin or AUTH_PIN env var.")
}

// ── Known claw tools ──────────────────────────────────────────────────────────
// Two storage layouts are supported:
//
//  "nanoclaw-style" (default):
//   {dir}/store/messages.db   — SQLite chat database
//   {dir}/data/sessions/      — JSONL agent session files (Claude Code format)
//
//  "picoclaw-style":
//   No SQLite DB — chats are stored as JSONL directly
//   {dir}/workspace/sessions/ — JSONL session files ({key}.jsonl + {key}.meta.json)
//   Message format per line: {role, content, tool_calls?, tool_call_id?}
//   Meta format: {key, summary, skip, count, created_at, updated_at}
//   Session key encodes channel: "telegram:123456789" (sanitized to filename)
//
// Detection order (first match wins):
//   1. CLI flag   --{name}
//   2. Env var    {NAME}_DIR
//   3. Settings stored in the viewer (fetched at startup from /api/settings)
//   4. Auto-detect: ~/toolname  or  ~/.toolname

const KNOWN_CLAW_TOOLS = [
  "nanoclaw",
  "openclaw",
  "picoclaw",
  "femtoclaw",
  "attoclaw",
  "kiloclaw",
  "megaclaw",
  "zeroclaw",
  "microclaw",
  "rawclaw",
]

// Tools that use picoclaw's workspace/sessions layout instead of nanoclaw's store/data layout.
const PICOCLAW_STYLE_TOOLS = new Set(["picoclaw"])

function autoDetectDir(name) {
  const candidates = [
    path.join(homedir(), name),
    path.join(homedir(), `.${name}`),
  ]
  return candidates.find(d => fs.existsSync(d)) ?? ""
}

function resolveClawDir(name, settingsOverrides = {}) {
  return (
    argGet(`--${name}`) ??
    process.env[`${name.toUpperCase().replace(/-/g, "_")}_DIR`] ??
    settingsOverrides[name] ??
    autoDetectDir(name) ??
    ""
  )
}

// ── Fetch settings from Worker at startup ─────────────────────────────────────

async function fetchSettings() {
  try {
    const r = await fetch(`${WORKER_URL}/api/settings`, {
      headers: { "X-Auth-Pin": AUTH_PIN },
    })
    if (r.ok) return await r.json()
  } catch { /* ignore — settings are optional */ }
  return {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`) }

function parseJsonl(filePath) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)
    return lines.map(l => JSON.parse(l))
  } catch { return null }
}

function normProjectDir(absDir) {
  return absDir.replace(homedir(), "").replace(/\//g, "-").replace(/^-/, "")
}

/** Returns true only for genuine human-typed user turns (not tool-result-only messages) */
function isRealUserMsg(m) {
  if (m.type !== "user") return false
  const content = m.message?.content
  if (!content) return false
  if (typeof content === "string") return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(b => b.type !== "tool_result")
}

async function syncSession(filePath) {
  const sessionId = path.basename(filePath, ".jsonl")
  const projectAbsDir = path.dirname(filePath)

  // Subagent sessions live at: {projectDir}/{parentSessionId}/subagents/agent-{id}.jsonl
  // Detect this by checking if grandparent dir basename is a session UUID and parent is "subagents"
  const isSubagent = path.basename(projectAbsDir) === "subagents"
  let projectDir, agentDescription, agentType, parentSessionId
  if (isSubagent) {
    // Navigate up: subagents/ → parentSession/ → projectDir/
    const parentSessionAbsDir = path.dirname(projectAbsDir)
    const parentProjectAbsDir = path.dirname(parentSessionAbsDir)
    projectDir = normProjectDir(parentProjectAbsDir)
    parentSessionId = path.basename(parentSessionAbsDir)
    // Read the companion .meta.json for agent description and type
    try {
      const meta = JSON.parse(fs.readFileSync(filePath.replace(".jsonl", ".meta.json"), "utf8"))
      agentDescription = meta.description
      agentType = meta.agentType
    } catch { /* meta file optional */ }
  } else {
    projectDir = normProjectDir(projectAbsDir)
  }

  const messages = parseJsonl(filePath)
  if (!messages) { log(`⚠  Failed to parse ${filePath}`); return }

  // Extract first user message text as display name fallback
  function firstUserText() {
    for (const m of messages) {
      if (m.type !== "user") continue
      const content = m.message?.content
      // Skip pure tool_result messages (these are system/hook responses, not actual user input)
      if (Array.isArray(content) && content.every(b => b.type === "tool_result")) continue
      const raw = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter(b => b.type === "text").map(b => b.text).join(" ")
        : ""
      // Prefer <command-name> tag content (skill invocations) over full stripped text
      const commandName = raw.match(/<command-name>([^<]+)<\/command-name>/)?.[1]?.trim()
      if (commandName) return commandName.slice(0, 80)
      const stripped = stripXml(raw)
      if (stripped.length > 2) return stripped.slice(0, 80)
    }
    return null
  }

  // Detect prompt_suggestion agents by agentId (no .meta.json for these)
  const firstMsg = messages[0]
  const agentId = firstMsg?.agentId ?? ""
  if (!agentType && agentId.includes("prompt_suggestion")) agentType = "prompt_suggestion"

  // For prompt_suggestion agents, extract the suggestion text and the parentUuid it targets
  let suggestionText, suggestionParentUuid
  if (agentType === "prompt_suggestion") {
    const userMsg = messages.find(m => m.type === "user")
    suggestionParentUuid = userMsg?.parentUuid
    const assistantMsg = messages.find(m => m.type === "assistant")
    const content = assistantMsg?.message?.content
    suggestionText = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter(b => b.type === "text").map(b => b.text).join("") : undefined
    if (suggestionText) suggestionText = suggestionText.trim().slice(0, 300)
  }

  // Build lightweight meta
  const conversationMsgs = messages.filter(m => m.type === "user" || m.type === "assistant")
  const userMsgs = messages.filter(isRealUserMsg)
  const sidechainMsgs = messages.filter(m => m.isSidechain)
  const lastWithTs = [...messages].reverse().find(m => m.timestamp)
  const meta = {
    id: sessionId,
    projectPath: projectDir,
    messageCount: conversationMsgs.length,
    userMessageCount: userMsgs.length,
    lastActivity: lastWithTs?.timestamp ?? new Date().toISOString(),
    gitBranch: lastWithTs?.gitBranch ?? messages.find(m => m.gitBranch)?.gitBranch,
    version: lastWithTs?.version,
    isActive: true,
    // Subagents: use description from .meta.json as the display name
    firstName: agentDescription ?? firstUserText(),
    isSidechain: isSubagent || (conversationMsgs.length > 0 && sidechainMsgs.length / conversationMsgs.length > 0.5),
    agentType: agentType ?? undefined,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(suggestionParentUuid ? { suggestionParentUuid } : {}),
    ...(suggestionText ? { suggestionText } : {}),
    hasInsights: fs.existsSync(path.join(homedir(), ".claude", "usage-data", "facets", `${sessionId}.json`)),
    source: "claude",
  }

  const payload = { meta, msgs: messages }

  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Pin": AUTH_PIN,
      },
      body: JSON.stringify(payload),
    })
    if (resp.ok) {
      log(`✓ synced ${isSubagent ? "⤷ " : ""}${projectDir}/${sessionId.slice(0, 8)} (${messages.length} msgs)`)
    } else {
      log(`✗ sync failed ${resp.status}: ${await resp.text()}`)
    }
  } catch (e) {
    log(`✗ fetch error: ${e.message}`)
  }
}

// ── Debounced file queue ──────────────────────────────────────────────────────

const pending = new Map() // filePath → timeout

function scheduleSync(filePath) {
  if (pending.has(filePath)) clearTimeout(pending.get(filePath))
  pending.set(filePath, setTimeout(() => {
    pending.delete(filePath)
    syncSession(filePath)
  }, DEBOUNCE_MS))
}

// ── Initial sync of all sessions ──────────────────────────────────────────────

async function initialSync() {
  if (!fs.existsSync(PROJECTS_DIR)) { log(`Projects dir not found: ${PROJECTS_DIR}`); return }
  const dirs = fs.readdirSync(PROJECTS_DIR)
  let count = 0
  for (const dir of dirs) {
    const dirPath = path.join(PROJECTS_DIR, dir)
    if (!fs.statSync(dirPath).isDirectory()) continue

    // Sync root session JSONL files
    for (const f of fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl"))) {
      await syncSession(path.join(dirPath, f))
      count++
    }

    // Sync subagent sessions: {projectDir}/{sessionId}/subagents/agent-*.jsonl
    for (const sessionDir of fs.readdirSync(dirPath)) {
      const subagentsDir = path.join(dirPath, sessionDir, "subagents")
      if (!fs.existsSync(subagentsDir)) continue
      for (const f of fs.readdirSync(subagentsDir).filter(f => f.endsWith(".jsonl"))) {
        await syncSession(path.join(subagentsDir, f))
        count++
      }
    }
  }
  log(`Initial sync complete: ${count} sessions`)
}

// ── File watcher ──────────────────────────────────────────────────────────────

function startWatcher(activeTools) {
  if (!fs.existsSync(PROJECTS_DIR)) {
    log(`Projects dir not found: ${PROJECTS_DIR}`); return
  }

  log(`Watching ${PROJECTS_DIR}`)

  watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".jsonl")) return
    const full = path.join(PROJECTS_DIR, filename)
    if (!fs.existsSync(full)) return
    scheduleSync(full)
  })

  // Also watch each active claw tool's agent session JSONL files
  for (const tool of activeTools) {
    if (fs.existsSync(tool.dataDir)) {
      watch(tool.dataDir, { recursive: true }, (_event, filename) => {
        if (!filename?.endsWith(".jsonl")) return
        pollClawTool(tool).catch(() => {})
      })
      log(`Watching ${tool.name} agent sessions at ${tool.dataDir}`)
    }
  }
}

// ── Generic claw tool SQLite poller ──────────────────────────────────────────

const CLAW_POLL_MS = 5000
const clawLastSync = new Map()    // `${toolName}:${chatJid}` → last message id
const clawAgentLastSync = new Map() // `${toolName}:${groupFolder}/${file}` → mtime

function sqliteQuery(dbPath, sql) {
  try {
    const out = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" })
    return JSON.parse(out.trim() || "[]")
  } catch (e) {
    log(`⚠  sqlite3 error (${dbPath}): ${e.stderr?.slice(0, 120) ?? e.message}`)
    return []
  }
}

function encodeJid(jid) {
  return jid.replace(/[@.:]/g, "-")
}

function inferChannel(jid, channelFromDb) {
  if (channelFromDb === "telegram" || jid.startsWith("tg:")) return "telegram"
  return "whatsapp"
}

async function syncClawChat(tool, chatJid, chatName, channel) {
  const messages = sqliteQuery(
    tool.dbPath,
    `SELECT id, chat_jid, sender_name, content, timestamp, is_from_me, is_bot_message
     FROM messages WHERE chat_jid='${chatJid.replace(/'/g, "''")}' ORDER BY timestamp ASC`
  )
  if (!messages.length) return

  const lastId = messages[messages.length - 1].id
  const cacheKey = `${tool.name}:${chatJid}`
  if (clawLastSync.get(cacheKey) === lastId) return // no change
  clawLastSync.set(cacheKey, lastId)

  // Convert to SessionMessage format
  const sessionMsgs = messages.map(m => ({
    uuid: String(m.id),
    parentUuid: null,
    type: (m.is_bot_message === 1 || m.is_from_me === 1) ? "assistant" : "human",
    sessionId: chatJid,
    timestamp: m.timestamp,
    isSidechain: false,
    message: {
      role: (m.is_bot_message === 1 || m.is_from_me === 1) ? "assistant" : "user",
      content: m.sender_name && m.is_bot_message === 0 && m.is_from_me === 0
        ? `**${m.sender_name}**: ${m.content ?? ""}`
        : (m.content ?? ""),
    },
  }))

  const firstUserMsg = sessionMsgs.find(m => m.message.role === "user")
  const firstText = typeof firstUserMsg?.message?.content === "string"
    ? firstUserMsg.message.content.replace(/^\*\*[^*]+\*\*:\s*/, "").slice(0, 80)
    : null

  const userMsgCount = sessionMsgs.filter(m => m.message.role === "user").length
  const projectPath = `${tool.name}-${channel}`
  const encodedJid = encodeJid(chatJid)

  const meta = {
    id: encodedJid,
    projectPath,
    messageCount: messages.length,
    userMessageCount: userMsgCount,
    lastActivity: messages[messages.length - 1].timestamp,
    isActive: true,
    firstName: firstText,
    customName: chatName && chatName !== chatJid ? chatName : null,
    channel,
    chatJid,
  }

  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify({ meta, msgs: sessionMsgs }),
    })
    if (resp.ok) {
      log(`✓ ${tool.name} [${channel}] ${chatName || chatJid} (${messages.length} msgs)`)
    } else {
      log(`✗ ${tool.name} sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ ${tool.name} fetch error: ${e.message}`)
  }
}

async function syncClawAgentSession(tool, groupFolder, chatJid, chatName, channel) {
  const projectsDir = path.join(tool.dataDir, groupFolder, ".claude", "projects", "-workspace-group")
  if (!fs.existsSync(projectsDir)) return

  const jsonlFiles = fs.readdirSync(projectsDir).filter(f => f.endsWith(".jsonl"))
  if (!jsonlFiles.length) return

  // Use the most recently modified session file
  const sessionFile = jsonlFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(projectsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f

  const filePath = path.join(projectsDir, sessionFile)
  const mtime = fs.statSync(filePath).mtimeMs
  const cacheKey = `${tool.name}:${groupFolder}/${sessionFile}`
  if (clawAgentLastSync.get(cacheKey) === mtime) return // no change
  clawAgentLastSync.set(cacheKey, mtime)

  const messages = parseJsonl(filePath)
  if (!messages) return

  const sessionId = path.basename(sessionFile, ".jsonl")

  function firstUserText() {
    for (const m of messages) {
      if (m.type !== "user") continue
      const content = m.message?.content
      if (Array.isArray(content) && content.every(b => b.type === "tool_result")) continue
      const raw = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter(b => b.type === "text").map(b => b.text).join(" ")
        : ""
      const stripped = stripXml(raw)
      if (stripped.length > 2) return stripped.slice(0, 80)
    }
    return null
  }

  const conversationMsgs = messages.filter(m => m.type === "user" || m.type === "assistant")
  const userMsgs = messages.filter(isRealUserMsg)
  const sidechainMsgs = messages.filter(m => m.isSidechain)
  const lastWithTs = [...messages].reverse().find(m => m.timestamp)
  const projectPath = `${tool.name}-agent-${channel}`

  const meta = {
    id: sessionId,
    projectPath,
    messageCount: conversationMsgs.length,
    userMessageCount: userMsgs.length,
    lastActivity: lastWithTs?.timestamp ?? new Date().toISOString(),
    gitBranch: lastWithTs?.gitBranch,
    isActive: true,
    firstName: chatName && chatName !== chatJid ? chatName : firstUserText(),
    isSidechain: conversationMsgs.length > 0 && sidechainMsgs.length / conversationMsgs.length > 0.5,
    customName: null,
    channel,
    chatJid,
  }

  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify({ meta, msgs: messages }),
    })
    if (resp.ok) {
      log(`✓ ${tool.name}-agent [${channel}] ${chatName || chatJid} session ${sessionId.slice(0, 8)} (${messages.length} msgs)`)
    } else {
      log(`✗ ${tool.name}-agent sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ ${tool.name}-agent fetch error: ${e.message}`)
  }
}

async function pollClawTool(tool) {
  if (!tool.dbPath || !fs.existsSync(tool.dbPath)) return

  const registeredGroups = sqliteQuery(tool.dbPath, `SELECT jid, name, folder FROM registered_groups`)

  const chats = sqliteQuery(
    tool.dbPath,
    `SELECT c.jid, c.name, c.channel
     FROM chats c
     WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_jid = c.jid)
     AND c.jid <> '__group_sync__'`
  )
  for (const chat of chats) {
    const channel = inferChannel(chat.jid, chat.channel)
    await syncClawChat(tool, chat.jid, chat.name, channel)
  }

  for (const rg of registeredGroups) {
    const channel = inferChannel(rg.jid, null)
    await syncClawAgentSession(tool, rg.folder, rg.jid, rg.name, channel)
  }
}

function startClawPollers(activeTools) {
  for (const tool of activeTools) {
    if (!tool.dbPath || !fs.existsSync(tool.dbPath)) {
      if (tool.dir) log(`${tool.name} DB not found at ${tool.dbPath} — ${tool.name} sync disabled`)
      continue
    }
    log(`Polling ${tool.name} DB every ${CLAW_POLL_MS / 1000}s (${tool.dbPath})`)
    setInterval(() => pollClawTool(tool).catch(() => {}), CLAW_POLL_MS)
  }
}

// ── PicoClaw-style session syncer ─────────────────────────────────────────────
// PicoClaw stores sessions as {sanitized_key}.jsonl + {sanitized_key}.meta.json
// under {dir}/workspace/sessions/. The session key encodes the channel and chat
// ID separated by a colon, e.g. "telegram:123456789".

const picoClawLastSync = new Map() // `${toolName}:${basename}` → mtime

function parsePicoClawMeta(metaPath) {
  try { return JSON.parse(fs.readFileSync(metaPath, "utf8")) } catch { return null }
}

function parsePicoClawJsonl(jsonlPath) {
  try {
    return fs.readFileSync(jsonlPath, "utf8")
      .split("\n").filter(Boolean)
      .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  } catch { return [] }
}

function picoClawChannelFromKey(key) {
  // Key format before sanitization: "telegram:123456789", "discord:user123", etc.
  // After sanitization colons become underscores: "telegram_123456789"
  // Try to extract channel from the original key stored in meta, or fall back to
  // parsing the filename prefix.
  if (!key) return "chat"
  const colon = key.indexOf(":")
  if (colon > 0) return key.slice(0, colon)
  const underscore = key.indexOf("_")
  if (underscore > 0) {
    const prefix = key.slice(0, underscore)
    if (["telegram", "discord", "qq", "dingtalk", "line", "whatsapp"].includes(prefix)) return prefix
  }
  return "chat"
}

async function syncPicoClawSession(tool, jsonlPath) {
  const basename = path.basename(jsonlPath, ".jsonl")
  const metaPath = jsonlPath.replace(".jsonl", ".meta.json")

  const stat = fs.statSync(jsonlPath)
  const cacheKey = `${tool.name}:${basename}`
  if (picoClawLastSync.get(cacheKey) === stat.mtimeMs) return
  picoClawLastSync.set(cacheKey, stat.mtimeMs)

  const meta = parsePicoClawMeta(metaPath)
  const rawMsgs = parsePicoClawJsonl(jsonlPath)
  if (!rawMsgs.length) return

  // Original unsanitized key is stored in meta (e.g. "telegram:123456789").
  // Fall back to basename if meta is missing.
  const sessionKey = meta?.key ?? basename
  const channel = picoClawChannelFromKey(sessionKey)
  const chatId = sessionKey.includes(":") ? sessionKey.split(":").slice(1).join(":") : sessionKey

  // Apply skip offset from meta (logically truncated messages)
  const skip = meta?.skip ?? 0
  const activeMsgs = rawMsgs.slice(skip)

  // Convert picoclaw {role, content} format to session viewer format.
  // Skip "tool" and "system" role messages — they are internal plumbing.
  const converted = activeMsgs
    .filter(m => m.role === "user" || m.role === "assistant")
    .map((m, i) => ({
      type: m.role,
      message: { role: m.role, content: m.content ?? "" },
      sessionId: basename,
      timestamp: meta?.updated_at ?? stat.mtime.toISOString(),
      uuid: `${basename}-${i}`,
      parentUuid: null,
      isSidechain: false,
    }))

  if (!converted.length) return

  const userCount = converted.filter(m => m.type === "user").length
  const firstUserText = converted.find(m => m.type === "user")?.message?.content?.slice(0, 80) ?? null
  const projectPath = `${tool.name}-${channel}`

  const sessionMeta = {
    id: basename,
    projectPath,
    messageCount: converted.length,
    userMessageCount: userCount,
    lastActivity: meta?.updated_at ?? stat.mtime.toISOString(),
    isActive: true,
    firstName: firstUserText,
    customName: null,
    channel,
    chatJid: chatId,
  }

  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify({ meta: sessionMeta, msgs: converted }),
    })
    if (resp.ok) {
      log(`✓ ${tool.name} [${channel}] ${chatId} (${converted.length} msgs)`)
    } else {
      log(`✗ ${tool.name} sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ ${tool.name} fetch error: ${e.message}`)
  }
}

async function initialSyncPicoClawTool(tool) {
  const sessionsDir = tool.dataDir
  if (!fs.existsSync(sessionsDir)) return
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"))
  for (const f of files) {
    await syncPicoClawSession(tool, path.join(sessionsDir, f)).catch(() => {})
  }
  log(`${tool.name}: synced ${files.length} session(s) from ${sessionsDir}`)
}

function startPicoClawWatcher(tool) {
  const sessionsDir = tool.dataDir
  if (!fs.existsSync(sessionsDir)) {
    log(`${tool.name} sessions dir not found: ${sessionsDir} — ${tool.name} sync disabled`)
    return
  }
  watch(sessionsDir, { recursive: false }, (_event, filename) => {
    if (!filename?.endsWith(".jsonl")) return
    const full = path.join(sessionsDir, filename)
    if (!fs.existsSync(full)) return
    syncPicoClawSession(tool, full).catch(() => {})
  })
  log(`Watching ${tool.name} sessions at ${sessionsDir}`)
}

// ── Antigravity adaptor ───────────────────────────────────────────────────────
// Antigravity ("Jetski" agent) stores data across two locations:
//
//  1. Session index — state.vscdb (SQLite):
//     Key: antigravityUnifiedStateSync.trajectorySummaries
//     Value: base64-encoded protobuf containing repeated session entries.
//     Each entry contains an inner base64-encoded protobuf with:
//       - session UUID
//       - session title (human-readable)
//       - workspace file:// URL
//     Parsed by extracting base64 chunks and decoding them with regex.
//
//  2. Session artifacts — ~/.gemini/antigravity/brain/{uuid}/:
//     task.md                  — task checklist (markdown)
//     implementation_plan.md   — implementation plan (markdown)
//     walkthrough.md           — summary walkthrough (markdown)
//     *.metadata.json          — {artifactType, summary, updatedAt} per artifact
//
// Full conversation logs are in old_conversations_backup/{uuid}.pb (binary protobuf
// with unknown schema — not used). The markdown artifacts are rich enough.

const ANTIGRAVITY_BRAIN_DIR = path.join(homedir(), ".gemini", "antigravity", "brain")
const ANTIGRAVITY_STATE_DB = path.join(
  homedir(), "Library", "Application Support",
  "Antigravity", "User", "globalStorage", "state.vscdb"
)
const antigravityLastSync = new Map() // sessionId → mtime of brain dir

function parseAntigravitySessionIndex() {
  // Returns [{id, title, workspacePath}]
  if (!fs.existsSync(ANTIGRAVITY_STATE_DB)) return []
  const rows = sqliteQuery(
    ANTIGRAVITY_STATE_DB,
    "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries' LIMIT 1"
  )
  if (!rows.length || !rows[0].value) return []

  try {
    const outer = Buffer.from(rows[0].value, "base64")
    // Extract inner base64 chunks (≥60 chars, valid base64)
    const chunks = []
    const b64Re = /[A-Za-z0-9+/]{60,}={0,2}/g
    let m
    while ((m = b64Re.exec(outer.toString("binary"))) !== null) {
      chunks.push(m[0])
    }

    const sessions = []
    for (const chunk of chunks) {
      try {
        const decoded = Buffer.from(chunk, "base64")
        const text = decoded.toString("utf8")
        // Extract UUID (first occurrence)
        const uuidMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
        if (!uuidMatch) continue
        const id = uuidMatch[0]
        // Extract title: first readable string before the UUID
        const beforeUuid = text.slice(0, text.indexOf(id))
        const titleMatch = beforeUuid.match(/([A-Za-z][A-Za-z0-9 ,.'"\-:!?]{5,})/)
        const title = titleMatch ? titleMatch[1].trim() : null
        // Extract workspace: file:// URL
        const wsMatch = text.match(/file:\/\/\/[^\s\x00-\x1f"']{3,}/)
        const workspacePath = wsMatch ? wsMatch[0].replace("file://", "") : ""
        sessions.push({ id, title, workspacePath })
      } catch { /* skip */ }
    }

    // Deduplicate by id (first occurrence wins)
    const seen = new Set()
    return sessions.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true })
  } catch { return [] }
}

function readAntigravitySessionArtifacts(sessionId) {
  const brainDir = path.join(ANTIGRAVITY_BRAIN_DIR, sessionId)
  if (!fs.existsSync(brainDir)) return null

  const artifacts = ["task", "implementation_plan", "walkthrough", "architecture_rules"]
  const parts = []
  let latestUpdatedAt = null

  for (const name of artifacts) {
    const mdPath = path.join(brainDir, `${name}.md`)
    const metaPath = path.join(brainDir, `${name}.md.metadata.json`)
    if (!fs.existsSync(mdPath)) continue

    let content = ""
    try { content = fs.readFileSync(mdPath, "utf8").trim() } catch { continue }
    if (!content) continue

    let updatedAt = null
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"))
      updatedAt = meta.updatedAt ?? null
    } catch { /* metadata optional */ }

    if (updatedAt && (!latestUpdatedAt || updatedAt > latestUpdatedAt)) {
      latestUpdatedAt = updatedAt
    }
    parts.push({ name, content, updatedAt })
  }

  return { parts, latestUpdatedAt }
}

async function syncAntigravitySession(session) {
  const { id, title, workspacePath } = session
  const artifacts = readAntigravitySessionArtifacts(id)
  if (!artifacts || !artifacts.parts.length) return

  const { parts, latestUpdatedAt } = artifacts
  const lastActivity = latestUpdatedAt ?? new Date().toISOString()

  // Check cache — skip if nothing changed
  const brainDir = path.join(ANTIGRAVITY_BRAIN_DIR, id)
  let mtime = 0
  try { mtime = fs.statSync(brainDir).mtimeMs } catch { return }
  if (antigravityLastSync.get(id) === mtime) return
  antigravityLastSync.set(id, mtime)

  // Convert artifacts to session messages: one "user" prompt + one "assistant" response per artifact
  const converted = []
  for (const part of parts) {
    const labelMap = {
      task: "Task",
      implementation_plan: "Implementation Plan",
      walkthrough: "Walkthrough",
      architecture_rules: "Architecture Rules",
    }
    converted.push({
      uuid: `antigravity-${id}-${part.name}-user`,
      parentUuid: null,
      type: "human",
      sessionId: id,
      timestamp: part.updatedAt ?? lastActivity,
      isSidechain: false,
      message: { role: "user", content: `[${labelMap[part.name] ?? part.name}]` },
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

  const meta = {
    id,
    projectPath: `antigravity:${projectDir}`,
    messageCount: converted.length,
    userMessageCount: parts.length,
    lastActivity,
    isActive: false,
    firstName: title ?? null,
    source: "antigravity",
  }

  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify({ meta, msgs: converted }),
    })
    if (resp.ok) {
      log(`✓ antigravity ${projectDir}/${id.slice(0, 8)} "${title ?? ""}" (${parts.length} artifacts)`)
    } else {
      log(`✗ antigravity sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ antigravity fetch error: ${e.message}`)
  }
}

async function initialSyncAntigravity() {
  if (!fs.existsSync(ANTIGRAVITY_BRAIN_DIR)) { log("Antigravity brain dir not found — Antigravity sync disabled"); return }
  const sessions = parseAntigravitySessionIndex()
  // Also pick up any brain sessions not in the index
  const brainIds = new Set(fs.readdirSync(ANTIGRAVITY_BRAIN_DIR))
  const indexIds = new Set(sessions.map(s => s.id))
  for (const id of brainIds) {
    if (!indexIds.has(id)) sessions.push({ id, title: null, workspacePath: "" })
  }
  for (const session of sessions) {
    await syncAntigravitySession(session).catch(() => {})
  }
  log(`Antigravity: synced ${sessions.length} session(s)`)
}

function startAntigravityWatcher() {
  if (!fs.existsSync(ANTIGRAVITY_BRAIN_DIR)) return
  const indexSessions = parseAntigravitySessionIndex()
  const indexMap = new Map(indexSessions.map(s => [s.id, s]))

  watch(ANTIGRAVITY_BRAIN_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const sessionId = filename.split(path.sep)[0]
    if (!sessionId) return
    const session = indexMap.get(sessionId) ?? { id: sessionId, title: null, workspacePath: "" }
    antigravityLastSync.delete(sessionId) // force re-sync on any change
    syncAntigravitySession(session).catch(() => {})
  })
  log(`Watching Antigravity brain at ${ANTIGRAVITY_BRAIN_DIR}`)
}

// ── Cursor adaptor ────────────────────────────────────────────────────────────
// Cursor stores chats in ~/.cursor/chats/{workspaceHash}/{sessionUUID}/store.db
// Each store.db has:
//   meta  (key TEXT, value TEXT)  — hex-encoded JSON with {name, createdAt, lastUsedModel}
//   blobs (id TEXT, data BLOB)    — raw JSON message objects {role, content, id?}
// Workspace hash → folder path via:
//   ~/Library/Application Support/Cursor/User/workspaceStorage/{hash}/workspace.json

const CURSOR_CHATS_DIR = path.join(homedir(), ".cursor", "chats")
const CURSOR_WS_DIR = path.join(
  homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage"
)
const cursorLastSync = new Map() // sessionUUID → latestRootBlobId (unchanged = skip)

function buildCursorWorkspaceMap() {
  const map = new Map() // hash → folder path
  if (!fs.existsSync(CURSOR_WS_DIR)) return map
  for (const hash of fs.readdirSync(CURSOR_WS_DIR)) {
    const wjPath = path.join(CURSOR_WS_DIR, hash, "workspace.json")
    try {
      const wj = JSON.parse(fs.readFileSync(wjPath, "utf8"))
      const folder = wj.folder?.replace("file://", "") ?? ""
      if (folder) map.set(hash, folder)
    } catch { /* skip */ }
  }
  return map
}

function readCursorSession(sessionDir, workspaceFolder) {
  const dbPath = path.join(sessionDir, "store.db")
  if (!fs.existsSync(dbPath)) return null

  const metaRows = sqliteQuery(dbPath, "SELECT key, value FROM meta LIMIT 10")
  if (!metaRows.length) return null

  let sessionMeta = null
  for (const row of metaRows) {
    try {
      sessionMeta = JSON.parse(Buffer.from(row.value, "hex").toString("utf8"))
      if (sessionMeta.agentId) break
    } catch { continue }
  }
  if (!sessionMeta?.agentId) return null

  const latestRootBlobId = sessionMeta.latestRootBlobId
  const sessionId = sessionMeta.agentId

  // Skip if unchanged
  if (cursorLastSync.get(sessionId) === latestRootBlobId) return null
  cursorLastSync.set(sessionId, latestRootBlobId)

  // Read all blobs — each is a JSON message {role, content, id?}
  const blobs = sqliteQuery(dbPath, "SELECT data FROM blobs")
  const messages = []
  for (const b of blobs) {
    try {
      const msg = JSON.parse(b.data)
      if (msg.role === "user" || msg.role === "assistant") messages.push(msg)
    } catch { /* skip non-JSON or non-message blobs */ }
  }
  if (!messages.length) return null

  // Convert to SessionMessage format
  const converted = messages.map((m, i) => ({
    uuid: m.id ?? `cursor-${sessionId}-${i}`,
    parentUuid: null,
    type: m.role === "assistant" ? "assistant" : "human",
    sessionId,
    timestamp: sessionMeta.createdAt ? new Date(sessionMeta.createdAt).toISOString() : new Date().toISOString(),
    isSidechain: false,
    message: { role: m.role, content: m.content ?? "" },
  }))

  const projectDir = workspaceFolder
    ? normProjectDir(workspaceFolder)
    : `cursor-unknown`

  const firstUserText = converted.find(m => m.message.role === "user")
    ?.message?.content
  const firstName = typeof firstUserText === "string"
    ? firstUserText.replace(/<[^>]+>/g, "").trim().slice(0, 80)
    : null

  return {
    meta: {
      id: sessionId,
      projectPath: `cursor:${projectDir}`,
      messageCount: converted.length,
      userMessageCount: converted.filter(m => m.message.role === "user").length,
      lastActivity: new Date(sessionMeta.createdAt ?? Date.now()).toISOString(),
      isActive: false,
      firstName,
      source: "cursor",
      lastUsedModel: sessionMeta.lastUsedModel,
    },
    msgs: converted,
  }
}

async function syncCursorSession(sessionDir, workspaceFolder) {
  const result = readCursorSession(sessionDir, workspaceFolder)
  if (!result) return
  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify(result),
    })
    if (resp.ok) {
      log(`✓ cursor ${result.meta.projectPath}/${result.meta.id.slice(0, 8)} (${result.msgs.length} msgs)`)
    } else {
      log(`✗ cursor sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ cursor fetch error: ${e.message}`)
  }
}

async function initialSyncCursor() {
  if (!fs.existsSync(CURSOR_CHATS_DIR)) return
  const wsMap = buildCursorWorkspaceMap()
  let count = 0
  for (const wsHash of fs.readdirSync(CURSOR_CHATS_DIR)) {
    const wsDir = path.join(CURSOR_CHATS_DIR, wsHash)
    if (!fs.statSync(wsDir).isDirectory()) continue
    const wsFolder = wsMap.get(wsHash) ?? ""
    for (const sessionUUID of fs.readdirSync(wsDir)) {
      const sessionDir = path.join(wsDir, sessionUUID)
      if (!fs.statSync(sessionDir).isDirectory()) continue
      await syncCursorSession(sessionDir, wsFolder)
      count++
    }
  }
  log(`Cursor: synced ${count} session(s)`)
}

function startCursorWatcher() {
  if (!fs.existsSync(CURSOR_CHATS_DIR)) { log("Cursor chats dir not found — Cursor sync disabled"); return }
  const wsMap = buildCursorWorkspaceMap()
  watch(CURSOR_CHATS_DIR, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith("store.db")) return
    // filename: wsHash/sessionUUID/store.db
    const parts = filename.split(path.sep)
    if (parts.length < 3) return
    const wsHash = parts[0]
    const sessionUUID = parts[1]
    const sessionDir = path.join(CURSOR_CHATS_DIR, wsHash, sessionUUID)
    const wsFolder = wsMap.get(wsHash) ?? ""
    syncCursorSession(sessionDir, wsFolder).catch(() => {})
  })
  log(`Watching Cursor chats at ${CURSOR_CHATS_DIR}`)
}

// ── OpenCode adaptor ──────────────────────────────────────────────────────────
// OpenCode stores sessions in ~/.local/share/opencode/storage/
//   session/{projectHash|global}/{sessionId}.json  — session metadata
//   message/{sessionId}/{messageId}.json           — individual messages
// Session JSON: {id, version, projectID, directory, title, time: {created, updated}}
// Message JSON: {id, sessionID, role, time: {created}, summary?, model?}
//   Messages with role "user"/"assistant" may have a "parts" array with text content
//   or the content may be stored differently. We read what's available.

const OPENCODE_STORAGE = path.join(homedir(), ".local", "share", "opencode", "storage")
const opencodeLastSync = new Map() // sessionId → updatedAt (ms)

function readOpenCodeSession(sessionFile) {
  let sessionData
  try { sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf8")) } catch { return null }
  if (!sessionData?.id) return null

  const sessionId = sessionData.id
  const updatedAt = sessionData.time?.updated ?? sessionData.time?.created ?? 0

  // Skip if unchanged
  if (opencodeLastSync.get(sessionId) === updatedAt) return null
  opencodeLastSync.set(sessionId, updatedAt)

  // Read all messages for this session
  const msgDir = path.join(OPENCODE_STORAGE, "message", sessionId)
  const messages = []
  if (fs.existsSync(msgDir)) {
    for (const mf of fs.readdirSync(msgDir).filter(f => f.endsWith(".json"))) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(msgDir, mf), "utf8"))
        if (m.role === "user" || m.role === "assistant") messages.push(m)
      } catch { /* skip */ }
    }
  }

  // Sort by creation time
  messages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))

  const converted = messages.map((m, i) => ({
    uuid: m.id ?? `opencode-${sessionId}-${i}`,
    parentUuid: null,
    type: m.role === "assistant" ? "assistant" : "human",
    sessionId,
    timestamp: m.time?.created ? new Date(m.time.created).toISOString() : new Date().toISOString(),
    isSidechain: false,
    message: {
      role: m.role,
      // OpenCode messages may have a summary title but actual text is streamed separately
      // Use summary title as fallback display text
      content: m.summary?.title ?? `[${m.role} message]`,
    },
  }))

  const projectDir = sessionData.directory
    ? normProjectDir(sessionData.directory)
    : `opencode-global`

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

async function syncOpenCodeSession(sessionFile) {
  const result = readOpenCodeSession(sessionFile)
  if (!result) return
  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify(result),
    })
    if (resp.ok) {
      log(`✓ opencode ${result.meta.projectPath}/${result.meta.id.slice(0, 8)} (${result.msgs.length} msgs)`)
    } else {
      log(`✗ opencode sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ opencode fetch error: ${e.message}`)
  }
}

async function initialSyncOpenCode() {
  const sessionBaseDir = path.join(OPENCODE_STORAGE, "session")
  if (!fs.existsSync(sessionBaseDir)) { log("OpenCode storage not found — OpenCode sync disabled"); return }
  let count = 0
  for (const projectHash of fs.readdirSync(sessionBaseDir)) {
    const projectDir = path.join(sessionBaseDir, projectHash)
    if (!fs.statSync(projectDir).isDirectory()) continue
    for (const sf of fs.readdirSync(projectDir).filter(f => f.endsWith(".json"))) {
      await syncOpenCodeSession(path.join(projectDir, sf))
      count++
    }
  }
  log(`OpenCode: synced ${count} session(s)`)
}

function startOpenCodeWatcher() {
  const sessionBaseDir = path.join(OPENCODE_STORAGE, "session")
  if (!fs.existsSync(sessionBaseDir)) return
  watch(sessionBaseDir, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".json")) return
    const full = path.join(sessionBaseDir, filename)
    if (!fs.existsSync(full)) return
    syncOpenCodeSession(full).catch(() => {})
  })
  // Also watch message dir so updates to individual messages trigger re-sync
  const msgBaseDir = path.join(OPENCODE_STORAGE, "message")
  if (fs.existsSync(msgBaseDir)) {
    watch(msgBaseDir, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith(".json")) return
      // filename: sessionId/messageId.json — find the session file
      const sessionId = filename.split(path.sep)[0]
      if (!sessionId) return
      // Find the session file in any project dir
      const sessionBaseDir2 = path.join(OPENCODE_STORAGE, "session")
      for (const projectHash of fs.readdirSync(sessionBaseDir2)) {
        const sf = path.join(sessionBaseDir2, projectHash, `${sessionId}.json`)
        if (fs.existsSync(sf)) {
          // Reset cache so this session re-syncs even if timestamp unchanged
          opencodeLastSync.delete(sessionId)
          syncOpenCodeSession(sf).catch(() => {})
          break
        }
      }
    })
  }
  log(`Watching OpenCode storage at ${OPENCODE_STORAGE}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

log(`Daemon starting — worker: ${WORKER_URL}`)

// Read path overrides stored via the settings UI
const storedSettings = await fetchSettings()
const toolPaths = storedSettings.toolPaths ?? {}

// Build active tool list from detection
const activeTools = KNOWN_CLAW_TOOLS.map(name => {
  const dir = resolveClawDir(name, toolPaths)
  if (!dir) return null
  const isPicoStyle = PICOCLAW_STYLE_TOOLS.has(name)
  return {
    name,
    dir,
    isPicoStyle,
    // nanoclaw-style paths
    dbPath: isPicoStyle ? "" : path.join(dir, "store", "messages.db"),
    // nanoclaw-style: data/sessions  |  picoclaw-style: workspace/sessions
    dataDir: isPicoStyle
      ? path.join(dir, "workspace", "sessions")
      : path.join(dir, "data", "sessions"),
  }
}).filter(Boolean)

if (activeTools.length > 0) {
  log(`Detected claw tools: ${activeTools.map(t => t.name).join(", ")}`)
} else {
  log("No claw tools detected (set NANOCLAW_DIR etc. to enable)")
}

await initialSync()
await initialSyncAntigravity()
await initialSyncCursor()
await initialSyncOpenCode()

// Initial poll / sync for all active tools
for (const tool of activeTools) {
  if (tool.isPicoStyle) {
    await initialSyncPicoClawTool(tool).catch(() => {})
  } else {
    await pollClawTool(tool).catch(() => {})
  }
}

// Start watchers and pollers, routing by tool type
const nanocStyleTools = activeTools.filter(t => !t.isPicoStyle)
const picoStyleTools  = activeTools.filter(t => t.isPicoStyle)

startWatcher(nanocStyleTools)
startClawPollers(nanocStyleTools)
for (const tool of picoStyleTools) startPicoClawWatcher(tool)
startAntigravityWatcher()
startCursorWatcher()
startOpenCodeWatcher()

// Keep event loop alive regardless of which watchers are active
setInterval(() => {}, 60_000)

log("Watching for changes… (Ctrl+C to stop)")

// ── Debug log tail ────────────────────────────────────────────────────────────

const DEBUG_LINK = path.join(homedir(), ".claude", "debug", "latest")
const DEBUG_MAX_LINES = 500

let debugTarget = null
let debugOffset = 0  // byte offset already sent

function resolveDebugTarget() {
  try { return fs.realpathSync(DEBUG_LINK) } catch { return null }
}

async function pushDebugLines() {
  const target = resolveDebugTarget()
  if (!target) return
  // If symlink changed, reset
  if (target !== debugTarget) {
    debugTarget = target
    debugOffset = 0
  }
  let stat
  try { stat = fs.statSync(target) } catch { return }
  if (stat.size <= debugOffset) return

  const buf = Buffer.alloc(stat.size - debugOffset)
  const fd = fs.openSync(target, "r")
  fs.readSync(fd, buf, 0, buf.length, debugOffset)
  fs.closeSync(fd)
  debugOffset = stat.size

  const newLines = buf.toString("utf8").split("\n").filter(Boolean)
  if (newLines.length === 0) return

  try {
    await fetch(`${WORKER_URL}/api/debug-ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify({ lines: newLines, target }),
    })
  } catch { /* ignore */ }
}

// Watch for debug log changes
const debugDir = path.join(homedir(), ".claude", "debug")
if (fs.existsSync(debugDir)) {
  // Initial push of last N lines
  debugTarget = resolveDebugTarget()
  if (debugTarget) {
    try {
      const all = fs.readFileSync(debugTarget, "utf8").split("\n").filter(Boolean)
      const tail = all.slice(-DEBUG_MAX_LINES)
      debugOffset = fs.statSync(debugTarget).size
      await fetch(`${WORKER_URL}/api/debug-ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
        body: JSON.stringify({ lines: tail, target: debugTarget, reset: true }),
      }).catch(() => {})
    } catch { /* ignore */ }
  }
  watch(debugDir, { recursive: false }, () => pushDebugLines().catch(() => {}))
  log(`Watching debug log at ${DEBUG_LINK}`)
}

// ── Todos sync ────────────────────────────────────────────────────────────────

const TODOS_DIR = path.join(homedir(), ".claude", "todos")

async function syncTodo(filePath) {
  const id = path.basename(filePath, ".json")
  let items
  try { items = JSON.parse(fs.readFileSync(filePath, "utf8")) } catch { return }
  const mtime = fs.statSync(filePath).mtime.toISOString()
  await fetch(`${WORKER_URL}/api/todos-ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
    body: JSON.stringify({ id, items, mtime }),
  }).catch(() => {})
}

if (fs.existsSync(TODOS_DIR)) {
  // Initial sync of all todo files
  for (const f of fs.readdirSync(TODOS_DIR).filter(f => f.endsWith(".json"))) {
    await syncTodo(path.join(TODOS_DIR, f)).catch(() => {})
  }
  // Watch for changes
  watch(TODOS_DIR, { recursive: false }, (_event, filename) => {
    if (!filename?.endsWith(".json")) return
    const full = path.join(TODOS_DIR, filename)
    if (fs.existsSync(full)) syncTodo(full).catch(() => {})
  })
  log(`Watching todos at ${TODOS_DIR}`)
}
