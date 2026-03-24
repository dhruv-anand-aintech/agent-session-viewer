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

// ── Config ────────────────────────────────────────────────────────────────────

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
// Each tool is assumed to share the same directory structure as nanoclaw:
//   {dir}/store/messages.db   — SQLite chat database
//   {dir}/data/sessions/      — JSONL agent session files
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

async function syncSession(filePath) {
  const sessionId = path.basename(filePath, ".jsonl")
  const projectAbsDir = path.dirname(filePath)
  const projectDir = projectAbsDir.replace(homedir(), "").replace(/\//g, "-").replace(/^-/, "")

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
      // Strip XML tag contents (system-reminder, local-command-stdout, etc.)
      const stripped = raw
        .replace(/<[^>]+>[^<]*<\/[^>]+>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim()
      if (stripped.length > 2) return stripped.slice(0, 80)
    }
    return null
  }

  // Build lightweight meta
  const conversationMsgs = messages.filter(m => m.type === "user" || m.type === "assistant")
  const userMsgs = messages.filter(m => m.type === "user")
  const last = messages[messages.length - 1]
  const meta = {
    id: sessionId,
    projectPath: projectDir,
    messageCount: conversationMsgs.length,
    userMessageCount: userMsgs.length,
    lastActivity: last?.timestamp ?? new Date().toISOString(),
    gitBranch: last?.gitBranch ?? messages.find(m => m.gitBranch)?.gitBranch,
    version: last?.version,
    isActive: true,
    firstName: firstUserText(),
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
      log(`✓ synced ${projectDir}/${sessionId.slice(0, 8)} (${messages.length} msgs)`)
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
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl"))
    for (const f of files) {
      await syncSession(path.join(dirPath, f))
      count++
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
      const stripped = raw
        .replace(/<[^>]+>[^<]*<\/[^>]+>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim()
      if (stripped.length > 2) return stripped.slice(0, 80)
    }
    return null
  }

  const conversationMsgs = messages.filter(m => m.type === "user" || m.type === "assistant")
  const userMsgs = messages.filter(m => m.type === "user")
  const last = messages[messages.length - 1]
  const projectPath = `${tool.name}-agent-${channel}`

  const meta = {
    id: sessionId,
    projectPath,
    messageCount: conversationMsgs.length,
    userMessageCount: userMsgs.length,
    lastActivity: last?.timestamp ?? new Date().toISOString(),
    gitBranch: last?.gitBranch,
    isActive: true,
    firstName: chatName && chatName !== chatJid ? chatName : firstUserText(),
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

// ── Main ──────────────────────────────────────────────────────────────────────

log(`Daemon starting — worker: ${WORKER_URL}`)

// Read path overrides stored via the settings UI
const storedSettings = await fetchSettings()
const toolPaths = storedSettings.toolPaths ?? {}

// Build active tool list from detection
const activeTools = KNOWN_CLAW_TOOLS.map(name => {
  const dir = resolveClawDir(name, toolPaths)
  return {
    name,
    dir,
    dbPath: dir ? path.join(dir, "store", "messages.db") : "",
    dataDir: dir ? path.join(dir, "data", "sessions") : "",
  }
}).filter(t => t.dir)

if (activeTools.length > 0) {
  log(`Detected claw tools: ${activeTools.map(t => t.name).join(", ")}`)
} else {
  log("No claw tools detected (set NANOCLAW_DIR etc. to enable)")
}

await initialSync()

// Initial poll for all active tools
for (const tool of activeTools) {
  await pollClawTool(tool).catch(() => {})
}

startWatcher(activeTools)
startClawPollers(activeTools)
log("Watching for changes… (Ctrl+C to stop)")
