#!/usr/bin/env node
/**
 * Populates ~/.claude/agent-session-viewer-sidebar-cache.json by scanning all
 * session directories. Run once after install, or any time you want to pre-warm
 * the sidebar cache (e.g. after adding a new session root).
 *
 * Cache shape v2: { v: 2, sessions: CacheEntry[] } sorted by lastActivity desc.
 * CacheEntry: { id, projectPath, projectDisplayName, source, messageCount,
 *               userMessageCount, firstName, lastActivity, mtime }
 *
 * Usage: node build-cache.mjs   (or: npm run build-cache)
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripXml, trimProjectsByRecentSessionCount } from "./shared-utils.mjs"
import {
  normProjectDir,
  readCursorSessions,
  readCodexSessions,
  readCursorAgentSessions,
  iterOpenCodeSessions,
  readHermesSessions,
  CODEX_SESSIONS_ROOT,
  CURSOR_PROJECTS_ROOT,
  HERMES_DB,
} from "./platform-readers.mjs"

const ROOT = dirname(fileURLToPath(import.meta.url))
const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const CONFIG_FILE = join(homedir(), ".claude", "agent-session-viewer-local.json")
const SIDEBAR_CACHE_FILE = join(homedir(), ".claude", "agent-session-viewer-sidebar-cache.json")

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) } catch { return {} }
}

function parseJsonl(fp) {
  try {
    return readFileSync(fp, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch { return [] }
}

function sessionMetaFromMsgs(msgs, stat) {
  let firstName = null
  for (const m of msgs.slice(0, 30)) {
    const role = m.message?.role ?? m.type
    if (role !== "user") continue
    const content = m.message?.content ?? m.content
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.find(b => b.type === "text")?.text ?? "" : ""
    if (text.trim()) { firstName = stripXml(text).slice(0, 100); break }
  }
  const messageCount = msgs.filter(m => m.type !== "file-history-snapshot").length
  const userMessageCount = msgs.filter(m => {
    const role = m.message?.role ?? m.type
    if (role !== "user") return false
    const content = m.message?.content ?? m.content
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.find(b => b.type === "text")?.text ?? "" : ""
    return text.trim().length > 0
  }).length
  return { messageCount, userMessageCount, firstName }
}

function encodedDirToDisplayName(encodedDir) {
  const abs = "/" + encodedDir.replace(/-/g, "/")
  if (existsSync(abs)) return abs.replace(homedir() + "/", "")
  return encodedDir.replace(/^-?Users-[^-]+-Code-/, "")
}

function getClaudeScanRoots() {
  const config = loadConfig()
  const roots = [{ path: CLAUDE_DIR, label: null }]
  for (const extra of config.extraRoots ?? []) {
    const p = extra.path?.replace(/^~/, homedir())
    if (p && existsSync(p)) roots.push({ path: p, label: extra.label ?? null })
  }
  return roots
}

// Map: sessionId → CacheEntry
const byId = new Map()

function upsert(entry) {
  byId.set(entry.id, entry)
}

// ── Claude JSONL sessions ──────────────────────────────────────────────────────
let claudeCount = 0
const names = loadConfig().names ?? {}
for (const { path: root, label } of getClaudeScanRoots()) {
  let dirs
  try { dirs = readdirSync(root) } catch { continue }
  for (const dir of dirs) {
    const dp = join(root, dir)
    try { if (!statSync(dp).isDirectory()) continue } catch { continue }
    let files
    try { files = readdirSync(dp).filter(f => f.endsWith(".jsonl")) } catch { continue }

    const projectPath = `${root}/${dir}`
    const baseName = encodedDirToDisplayName(dir)
    const projectDisplayName = label ? `[${label}] ${baseName}` : baseName

    for (const f of files) {
      const fp = join(dp, f)
      let stat
      try { stat = statSync(fp) } catch { continue }
      const sessionId = f.replace(".jsonl", "")
      const msgs = parseJsonl(fp)
      const { messageCount, userMessageCount, firstName } = sessionMetaFromMsgs(msgs, stat)
      upsert({
        id: sessionId,
        projectPath,
        projectDisplayName,
        source: "claude",
        messageCount,
        userMessageCount,
        firstName: firstName ?? null,
        lastActivity: stat.mtime.toISOString(),
        mtime: String(stat.mtimeMs),
        customName: names[`${projectPath}/${sessionId}`] ?? null,
      })
      claudeCount++
      if (claudeCount % 50 === 0) process.stdout.write(`\r  Claude: ${claudeCount} sessions…`)
    }
  }
}
if (claudeCount > 0) process.stdout.write(`\r  Claude: ${claudeCount} sessions\n`)

// ── Platform sessions ──────────────────────────────────────────────────────────
function ingestResults(results, platformPrefix, label) {
  let n = 0
  for (const { meta } of results) {
    if (!meta?.id || !meta.projectPath) continue
    const dirPart = meta.projectPath.replace(`${platformPrefix}:`, "")
    const baseName = encodedDirToDisplayName(dirPart)
    const projectDisplayName = `${platformPrefix}: ${baseName}`
    upsert({
      id: meta.id,
      projectPath: meta.projectPath,
      projectDisplayName,
      source: meta.source ?? platformPrefix,
      messageCount: meta.messageCount ?? 0,
      userMessageCount: meta.userMessageCount ?? null,
      firstName: meta.firstName ?? null,
      lastActivity: meta.lastActivity ?? new Date().toISOString(),
      mtime: String(meta.lastActivity ?? Date.now()),
      customName: null,
    })
    n++
  }
  if (n > 0) console.log(`  ${label}: ${n} sessions`)
}

try { ingestResults(readCursorSessions(), "cursor", "Cursor") } catch { /* db not present */ }
try { if (existsSync(CODEX_SESSIONS_ROOT)) ingestResults(readCodexSessions(null, null), "codex", "Codex") } catch { /* ignore */ }
try { if (existsSync(CURSOR_PROJECTS_ROOT)) ingestResults(readCursorAgentSessions(null, null), "cursor-agent", "Cursor agent") } catch { /* ignore */ }
try { ingestResults([...iterOpenCodeSessions(null, null)].map(x => x.result), "opencode", "OpenCode") } catch { /* ignore */ }
try { if (existsSync(HERMES_DB)) ingestResults(readHermesSessions(null, null), "hermes", "Hermes") } catch { /* ignore */ }

// ── Write sorted cache ─────────────────────────────────────────────────────────
const sessions = Array.from(byId.values())
  .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))

writeFileSync(SIDEBAR_CACHE_FILE, JSON.stringify({ v: 2, sessions }))
console.log(`\n✓ Sidebar cache written: ${sessions.length} sessions → ${SIDEBAR_CACHE_FILE}`)
