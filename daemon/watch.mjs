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
import {
  normProjectDir as _normProjectDir,
  readCodexSessions,
  readCodexSession,
  CODEX_SESSIONS_ROOT,
  readCursorSessionsFull,
  readCursorAgentSessions,
  readCursorAgentSessionFile,
  parseCursorAgentTranscriptFilePath,
  CURSOR_PROJECTS_ROOT,
  readOpenCodeSession,
  iterOpenCodeSessions,
  OPENCODE_STORAGE,
  ANTIGRAVITY_BRAIN_DIR,
  parseAntigravitySessionIndex,
  readAntigravitySession,
  readAntigravityRpcSessions,
  HERMES_DB,
  readHermesSessions,
} from "../platform-readers.mjs"

// ── Persistent sync cache ─────────────────────────────────────────────────────
// Survives daemon restarts so already-uploaded sessions are not re-sent.
// Stored at ~/.claude/session-viewer-sync-cache.json
// Keys: `platform:sessionIdOrFilePath` → cacheVal string

const SYNC_CACHE_FILE = path.join(homedir(), ".claude", "session-viewer-sync-cache.json")
let _syncCache = null
let _syncCacheTimer = null

function loadSyncCache() {
  try { _syncCache = JSON.parse(fs.readFileSync(SYNC_CACHE_FILE, "utf8")) }
  catch { _syncCache = {} }
}

function flushSyncCache() {
  if (_syncCacheTimer) clearTimeout(_syncCacheTimer)
  _syncCacheTimer = setTimeout(() => {
    try { fs.writeFileSync(SYNC_CACHE_FILE, JSON.stringify(_syncCache)) }
    catch { /* ignore write errors */ }
  }, 1500)
}

function scGet(key) { return _syncCache[key] }
function scSet(key, val) { _syncCache[key] = val; flushSyncCache() }
function scDel(key) { delete _syncCache[key]; flushSyncCache() }

// Namespace helpers for each platform
const sc = {
  claude: { get: k => scGet(`c:${k}`), set: (k, v) => scSet(`c:${k}`, v) },
  codex: { get: k => scGet(`cx:${k}`), set: (k, v) => scSet(`cx:${k}`, v), del: k => scDel(`cx:${k}`) },
  // Bump prefix when Cursor reader output shape changes (forces re-sync; was bubble-count-only cache).
  cursor: { get: k => scGet(`cuv3:${k}`), set: (k, v) => scSet(`cuv3:${k}`, v) },
  cursorAgent: { get: k => scGet(`ca-v1:${k}`), set: (k, v) => scSet(`ca-v1:${k}`, v) },
  opencode: { get: k => scGet(`oc:${k}`), set: (k, v) => scSet(`oc:${k}`, v), del: k => scDel(`oc:${k}`) },
  antigravity: { get: k => scGet(`ag:${k}`), set: (k, v) => scSet(`ag:${k}`, v), del: k => scDel(`ag:${k}`) },
  hermes: { get: k => scGet(`h:${k}`), set: (k, v) => scSet(`h:${k}`, v) },
}

loadSyncCache()

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

const normProjectDir = _normProjectDir

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

  // Skip if file unchanged since last successful upload
  const fileMtime = String(fs.statSync(filePath).mtimeMs)
  if (sc.claude.get(filePath) === fileMtime) return

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
      sc.claude.set(filePath, fileMtime)
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
/** In-memory Cursor IDE composer bubble counts between state.vscdb watch events */
const cursorComposerLastSync = new Map()
/** In-memory Hermes message_count between state.db watch events */
const hermesLastSync = new Map()

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

// ── Antigravity adaptor (via platform-readers.mjs) ───────────────────────────

async function syncAntigravitySession(session) {
  const result = readAntigravitySession(
    session,
    id => sc.antigravity.get(id),
    (id, v) => sc.antigravity.set(id, v)
  )
  if (!result) return
  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify({ meta: result.meta, msgs: result.msgs }),
    })
    if (resp.ok) {
      log(`✓ antigravity ${result.meta.projectPath}/${result.meta.id.slice(0, 8)} "${result.meta.firstName ?? ""}" (${result.meta.userMessageCount} artifacts)`)
    } else {
      log(`✗ antigravity sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ antigravity fetch error: ${e.message}`)
  }
}

async function syncAntigravityResults(results) {
  for (const result of results) {
    try {
      const resp = await fetch(`${WORKER_URL}/api/sync`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
        body: JSON.stringify(result),
      })
      if (resp.ok) {
        log(`✓ antigravity ${result.meta.projectPath}/${result.meta.id.slice(0, 8)} "${result.meta.firstName ?? ""}" (${result.msgs.length} msgs)`)
      }
    } catch (e) {
      log(`✗ antigravity sync error: ${e.message}`)
    }
  }
}

async function initialSyncAntigravity() {
  if (!fs.existsSync(ANTIGRAVITY_BRAIN_DIR)) { log("Antigravity brain dir not found — Antigravity sync disabled"); return }

  // Try live RPC first (full chat history)
  const indexSessions = parseAntigravitySessionIndex()
  const indexMap = new Map(indexSessions.map(s => [s.id, s]))
  const rpcResults = await readAntigravityRpcSessions(indexMap).catch(() => [])
  if (rpcResults.length) {
    log(`Antigravity: ${rpcResults.length} session(s) via live RPC`)
    await syncAntigravityResults(rpcResults)
    return
  }

  // Fall back to markdown artifacts
  const brainIds = new Set(fs.readdirSync(ANTIGRAVITY_BRAIN_DIR))
  const indexIds = new Set(indexSessions.map(s => s.id))
  for (const id of brainIds) {
    if (!indexIds.has(id)) indexSessions.push({ id, title: null, workspacePath: "" })
  }
  for (const session of indexSessions) {
    await syncAntigravitySession(session).catch(() => {})
  }
  log(`Antigravity: synced ${indexSessions.length} session(s) from artifacts`)
}

function startAntigravityWatcher() {
  if (!fs.existsSync(ANTIGRAVITY_BRAIN_DIR)) return
  const indexSessions = parseAntigravitySessionIndex()
  const indexMap = new Map(indexSessions.map(s => [s.id, s]))
  watch(ANTIGRAVITY_BRAIN_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const sessionId = filename.split(path.sep)[0]
    if (!sessionId) return
    // Try live RPC first, fall back to artifact for changed session
    readAntigravityRpcSessions(indexMap).then(results => {
      if (results.length) {
        syncAntigravityResults(results).catch(() => {})
      } else {
        const session = indexMap.get(sessionId) ?? { id: sessionId, title: null, workspacePath: "" }
        sc.antigravity.del(sessionId)
        syncAntigravitySession(session).catch(() => {})
      }
    }).catch(() => {
      const session = indexMap.get(sessionId) ?? { id: sessionId, title: null, workspacePath: "" }
      sc.antigravity.del(sessionId)
      syncAntigravitySession(session).catch(() => {})
    })
  })
  log(`Watching Antigravity brain at ${ANTIGRAVITY_BRAIN_DIR}`)
}

// ── Cursor adaptor (via platform-readers.mjs) ────────────────────────────────
// Reads from globalStorage/state.vscdb cursorDiskKV — all 271+ sessions.

const CURSOR_GLOBAL_DB = path.join(
  homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"
)

async function syncCursorResult(result) {
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
  if (!fs.existsSync(CURSOR_GLOBAL_DB)) { log("Cursor globalStorage DB not found — Cursor sync disabled"); return }
  const results = readCursorSessionsFull(
    id => sc.cursor.get(id),
    (id, v) => sc.cursor.set(id, v)
  )
  for (const result of results) {
    await syncCursorResult(result)
  }
  log(`Cursor: synced ${results.length} session(s)`)
}

function startCursorWatcher() {
  if (!fs.existsSync(CURSOR_GLOBAL_DB)) return
  const globalStorageDir = path.dirname(CURSOR_GLOBAL_DB)
  watch(globalStorageDir, { recursive: false }, (_event, filename) => {
    if (!filename?.includes("state.vscdb")) return
    const results = readCursorSessionsFull(
      id => cursorComposerLastSync.get(id),
      (id, v) => cursorComposerLastSync.set(id, v)
    )
    results.forEach(result => syncCursorResult(result).catch(() => {}))
  })
  log(`Watching Cursor globalStorage at ${globalStorageDir}`)
}

async function syncCursorAgentResult(result) {
  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify(result),
    })
    if (resp.ok) {
      log(`✓ cursor-agent ${result.meta.projectPath}/${String(result.meta.id).slice(0, 8)} (${result.msgs.length} msgs)`)
    } else {
      log(`✗ cursor-agent sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ cursor-agent fetch error: ${e.message}`)
  }
}

async function initialSyncCursorAgent() {
  if (!fs.existsSync(CURSOR_PROJECTS_ROOT)) {
    log("Cursor CLI agent-transcripts not found — Cursor agent sync disabled")
    return
  }
  const results = readCursorAgentSessions(
    id => sc.cursorAgent.get(id),
    (id, v) => sc.cursorAgent.set(id, v)
  )
  for (const result of results) {
    await syncCursorAgentResult(result)
  }
  log(`Cursor agent: synced ${results.length} CLI session(s)`)
}

function startCursorAgentWatcher() {
  if (!fs.existsSync(CURSOR_PROJECTS_ROOT)) return
  watch(CURSOR_PROJECTS_ROOT, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".jsonl")) return
    const full = path.join(CURSOR_PROJECTS_ROOT, filename)
    if (!fs.existsSync(full)) return
    const info = parseCursorAgentTranscriptFilePath(full)
    if (!info) return
    const result = readCursorAgentSessionFile(
      info.filePath,
      info.slug,
      info.sessionId,
      id => sc.cursorAgent.get(id),
      (id, v) => sc.cursorAgent.set(id, v)
    )
    if (result) syncCursorAgentResult(result).catch(() => {})
  })
  log(`Watching Cursor CLI transcripts at ${CURSOR_PROJECTS_ROOT}`)
}

// ── Codex adaptor (via platform-readers.mjs) ─────────────────────────────────

async function syncCodexResult(result) {
  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify(result),
    })
    if (resp.ok) {
      log(`✓ codex ${result.meta.projectPath}/${String(result.meta.id).slice(0, 8)} (${result.msgs.length} msgs)`)
    } else {
      log(`✗ codex sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ codex fetch error: ${e.message}`)
  }
}

async function initialSyncCodex() {
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) {
    log("Codex sessions not found — Codex sync disabled")
    return
  }
  const results = readCodexSessions(
    filePath => sc.codex.get(filePath),
    (filePath, v) => sc.codex.set(filePath, v)
  )
  for (const result of results) await syncCodexResult(result)
  log(`Codex: synced ${results.length} session(s)`)
}

function startCodexWatcher() {
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return
  watch(CODEX_SESSIONS_ROOT, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".jsonl")) return
    const full = path.join(CODEX_SESSIONS_ROOT, filename)
    if (!fs.existsSync(full)) return
    const result = readCodexSession(
      full,
      filePath => sc.codex.get(filePath),
      (filePath, v) => sc.codex.set(filePath, v)
    )
    if (result) syncCodexResult(result).catch(() => {})
  })
  log(`Watching Codex sessions at ${CODEX_SESSIONS_ROOT}`)
}

// ── OpenCode adaptor (via platform-readers.mjs) ───────────────────────────────


async function syncOpenCodeSession(sessionFile) {
  const result = readOpenCodeSession(
    sessionFile,
    id => sc.opencode.get(id),
    (id, v) => sc.opencode.set(id, v)
  )
  if (!result) return
  await pushOpenCodeResult(result)
}

async function pushOpenCodeResult(result) {
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
  for (const { result } of iterOpenCodeSessions(
    id => sc.opencode.get(id),
    (id, v) => sc.opencode.set(id, v)
  )) {
    await pushOpenCodeResult(result)
    count++
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
  const msgBaseDir = path.join(OPENCODE_STORAGE, "message")
  if (fs.existsSync(msgBaseDir)) {
    watch(msgBaseDir, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith(".json")) return
      const sessionId = filename.split(path.sep)[0]
      if (!sessionId) return
      for (const projectHash of fs.readdirSync(path.join(OPENCODE_STORAGE, "session"))) {
        const sf = path.join(OPENCODE_STORAGE, "session", projectHash, `${sessionId}.json`)
        if (fs.existsSync(sf)) {
          sc.opencode.del(sessionId)
          syncOpenCodeSession(sf).catch(() => {})
          break
        }
      }
    })
  }
  log(`Watching OpenCode storage at ${OPENCODE_STORAGE}`)
}

// ── Hermes adaptor (via platform-readers.mjs) ────────────────────────────────


async function syncHermesSession(result) {
  try {
    const resp = await fetch(`${WORKER_URL}/api/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Auth-Pin": AUTH_PIN },
      body: JSON.stringify(result),
    })
    if (resp.ok) {
      log(`✓ hermes ${result.meta.projectPath}/${result.meta.id.slice(0, 8)} (${result.msgs.length} msgs)`)
    } else {
      log(`✗ hermes sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ hermes fetch error: ${e.message}`)
  }
}

async function initialSyncHermes() {
  if (!fs.existsSync(HERMES_DB)) { log("Hermes DB not found — Hermes sync disabled"); return }
  const results = readHermesSessions(
    id => sc.hermes.get(id),
    (id, v) => sc.hermes.set(id, v)
  )
  for (const result of results) await syncHermesSession(result)
  log(`Hermes: synced ${results.length} session(s)`)
}

function startHermesWatcher() {
  if (!fs.existsSync(HERMES_DB)) return
  const dbDir = path.dirname(HERMES_DB)
  watch(dbDir, { recursive: false }, (_event, filename) => {
    if (!filename?.includes("state.db")) return
    const results = readHermesSessions(
      id => hermesLastSync.get(id),
      (id, v) => hermesLastSync.set(id, v)
    )
    results.forEach(result => syncHermesSession(result).catch(() => {}))
  })
  log(`Watching Hermes DB at ${HERMES_DB}`)
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
await initialSyncCodex()
await initialSyncAntigravity()
await initialSyncCursor()
await initialSyncCursorAgent()
await initialSyncOpenCode()
await initialSyncHermes()

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
startCodexWatcher()
startAntigravityWatcher()
startCursorWatcher()
startCursorAgentWatcher()
startOpenCodeWatcher()
startHermesWatcher()

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
