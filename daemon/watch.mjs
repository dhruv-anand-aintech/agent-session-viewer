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
 */

import fs from "node:fs"
import path from "node:path"
import { watch } from "node:fs"
import { homedir } from "node:os"

// ── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const argGet = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const WORKER_URL = argGet("--worker") ?? process.env.WORKER_URL ?? ""
const AUTH_PIN   = argGet("--pin")    ?? process.env.AUTH_PIN ?? ""
const PROJECTS_DIR = path.join(homedir(), ".claude", "projects")
const DEBOUNCE_MS = 600

// Nanoclaw integration (optional) — set NANOCLAW_DIR to your nanoclaw repo path
const NANOCLAW_DIR = argGet("--nanoclaw") ?? process.env.NANOCLAW_DIR ?? ""

if (!WORKER_URL) {
  console.error("❌  WORKER_URL not set. Set --worker <url> or WORKER_URL env var.")
  process.exit(1)
}
if (!AUTH_PIN) {
  console.error("⚠  AUTH_PIN not set — syncs will be rejected by worker. Set --pin or AUTH_PIN env var.")
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
  const last = messages[messages.length - 1]
  const meta = {
    id: sessionId,
    projectPath: projectDir,
    messageCount: messages.filter(m => m.type === "user" || m.type === "assistant").length,
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

function startWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    log(`Projects dir not found: ${PROJECTS_DIR}`); return
  }

  log(`Watching ${PROJECTS_DIR}`)

  watch(PROJECTS_DIR, { recursive: true }, (event, filename) => {
    if (!filename?.endsWith(".jsonl")) return
    const full = path.join(PROJECTS_DIR, filename)
    if (!fs.existsSync(full)) return
    scheduleSync(full)
  })

  // Also watch nanoclaw agent session JSONL files
  if (fs.existsSync(NANOCLAW_DATA_DIR)) {
    watch(NANOCLAW_DATA_DIR, { recursive: true }, (event, filename) => {
      if (!filename?.endsWith(".jsonl")) return
      // Trigger a nanoclaw poll when any agent session changes
      pollNanoclaw().catch(() => {})
    })
    log(`Watching nanoclaw agent sessions at ${NANOCLAW_DATA_DIR}`)
  }
}

// ── Nanoclaw SQLite poller ────────────────────────────────────────────────────

import { execFileSync } from "node:child_process"

const NANOCLAW_DB = NANOCLAW_DIR ? path.join(NANOCLAW_DIR, "store", "messages.db") : ""
const NANOCLAW_POLL_MS = 5000
const nanoclawLastSync = new Map() // chatJid → last message id synced

function sqliteQuery(sql) {
  try {
    const out = execFileSync("sqlite3", ["-json", NANOCLAW_DB, sql], { encoding: "utf8" })
    return JSON.parse(out.trim() || "[]")
  } catch (e) {
    log(`⚠  sqlite3 error: ${e.stderr?.slice(0, 120) ?? e.message}`)
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

async function syncNanoclawChat(chatJid, chatName, channel) {
  const messages = sqliteQuery(
    `SELECT id, chat_jid, sender_name, content, timestamp, is_from_me, is_bot_message
     FROM messages WHERE chat_jid='${chatJid.replace(/'/g, "''")}' ORDER BY timestamp ASC`
  )
  if (!messages.length) return

  const lastId = messages[messages.length - 1].id
  if (nanoclawLastSync.get(chatJid) === lastId) return // no change
  nanoclawLastSync.set(chatJid, lastId)

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

  const projectPath = `nanoclaw-${channel}`
  const encodedJid = encodeJid(chatJid)

  const meta = {
    id: encodedJid,
    projectPath,
    messageCount: messages.length,
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
      log(`✓ nanoclaw [${channel}] ${chatName || chatJid} (${messages.length} msgs)`)
    } else {
      log(`✗ nanoclaw sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ nanoclaw fetch error: ${e.message}`)
  }
}

// ── Nanoclaw agent session syncer ─────────────────────────────────────────────
// Each registered group has a persistent Claude Code session JSONL at:
//   data/sessions/{folder}/.claude/projects/-workspace-group/{session_id}.jsonl
// This contains thinking, tool calls, and full agent reasoning — much richer than the DB.

const NANOCLAW_DATA_DIR = NANOCLAW_DIR ? path.join(NANOCLAW_DIR, "data", "sessions") : ""
const nanoclawAgentLastSync = new Map() // group_folder → last mtime

async function syncNanoclawAgentSession(groupFolder, chatJid, chatName, channel) {
  const projectsDir = path.join(NANOCLAW_DATA_DIR, groupFolder, ".claude", "projects", "-workspace-group")
  if (!fs.existsSync(projectsDir)) return

  const jsonlFiles = fs.readdirSync(projectsDir).filter(f => f.endsWith(".jsonl"))
  if (!jsonlFiles.length) return

  // Use the most recently modified session file
  const sessionFile = jsonlFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(projectsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f

  const filePath = path.join(projectsDir, sessionFile)
  const mtime = fs.statSync(filePath).mtimeMs
  const cacheKey = `${groupFolder}/${sessionFile}`
  if (nanoclawAgentLastSync.get(cacheKey) === mtime) return // no change
  nanoclawAgentLastSync.set(cacheKey, mtime)

  const messages = parseJsonl(filePath)
  if (!messages) return

  const sessionId = path.basename(sessionFile, ".jsonl")

  // Extract first non-system user text as display name
  function firstUserText() {
    for (const m of messages) {
      if (m.type !== "user") continue
      const content = m.message?.content
      if (Array.isArray(content) && content.every(b => b.type === "tool_result")) continue
      const raw = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter(b => b.type === "text").map(b => b.text).join(" ")
        : ""
      // Strip XML context wrappers
      const stripped = raw
        .replace(/<[^>]+>[^<]*<\/[^>]+>/g, " ")
        .replace(/<[^>]+>/g, " ")
        // Also strip <messages> XML block
        .replace(/\s+/g, " ").trim()
      if (stripped.length > 2) return stripped.slice(0, 80)
    }
    return null
  }

  const last = messages[messages.length - 1]
  const projectPath = `nanoclaw-agent-${channel}`

  const meta = {
    id: sessionId,
    projectPath,
    messageCount: messages.filter(m => m.type === "user" || m.type === "assistant").length,
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
      log(`✓ nanoclaw-agent [${channel}] ${chatName || chatJid} session ${sessionId.slice(0, 8)} (${messages.length} msgs)`)
    } else {
      log(`✗ nanoclaw-agent sync failed ${resp.status}`)
    }
  } catch (e) {
    log(`✗ nanoclaw-agent fetch error: ${e.message}`)
  }
}

async function pollNanoclaw() {
  if (!NANOCLAW_DB || !fs.existsSync(NANOCLAW_DB)) return

  // Get all registered groups
  const registeredGroups = sqliteQuery(`SELECT jid, name, folder FROM registered_groups`)

  // Sync flat chat messages from DB (for non-main chats)
  const chats = sqliteQuery(
    `SELECT c.jid, c.name, c.channel
     FROM chats c
     WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_jid = c.jid)
     AND c.jid <> '__group_sync__'`
  )
  for (const chat of chats) {
    const channel = inferChannel(chat.jid, chat.channel)
    await syncNanoclawChat(chat.jid, chat.name, channel)
  }

  // Sync rich agent sessions (thinking, tools) for registered groups
  for (const rg of registeredGroups) {
    const channel = inferChannel(rg.jid, null)
    await syncNanoclawAgentSession(rg.folder, rg.jid, rg.name, channel)
  }
}

function startNanoclawPoller() {
  if (!NANOCLAW_DB || !fs.existsSync(NANOCLAW_DB)) {
    if (NANOCLAW_DIR) log(`Nanoclaw DB not found at ${NANOCLAW_DB} — nanoclaw sync disabled`)
    return
  }
  log(`Polling nanoclaw DB every ${NANOCLAW_POLL_MS / 1000}s`)
  setInterval(pollNanoclaw, NANOCLAW_POLL_MS)
}

// ── Main ──────────────────────────────────────────────────────────────────────

log(`Daemon starting — worker: ${WORKER_URL}`)
await initialSync()
await pollNanoclaw()
startWatcher()
startNanoclawPoller()
log("Watching for changes… (Ctrl+C to stop)")
