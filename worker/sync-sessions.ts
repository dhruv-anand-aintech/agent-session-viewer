#!/usr/bin/env tsx
/**
 * Sync local Claude Code JSONL session files into Wrangler KV
 * for local dev / preview.
 *
 * Usage:
 *   npx tsx worker/sync-sessions.ts
 *
 * Reads from ~/.claude/projects/
 * Writes to local KV via `wrangler kv:key put`
 */

import { readdirSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { execSync } from "child_process"

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const FIVE_MIN = 5 * 60 * 1000

interface SessionMessage {
  uuid?: string
  parentUuid?: string | null
  type: string
  sessionId?: string
  cwd?: string
  version?: string
  timestamp?: string
  message?: { role: string; content: unknown }
  data?: unknown
  isSidechain?: boolean
  gitBranch?: string
}

function parseJsonl(filePath: string): SessionMessage[] {
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean)
  const msgs: SessionMessage[] = []
  for (const line of lines) {
    try { msgs.push(JSON.parse(line)) } catch { /* skip malformed */ }
  }
  return msgs
}

function putKV(key: string, value: unknown) {
  const json = JSON.stringify(value)
  execSync(`npx wrangler kv:key put --binding SESSIONS_KV "${key}" '${json.replace(/'/g, "'\\''")}'`, { stdio: "pipe" })
}

const projects = readdirSync(CLAUDE_DIR).filter(d => {
  try { return statSync(join(CLAUDE_DIR, d)).isDirectory() } catch { return false }
})

for (const projectDir of projects) {
  const projectPath = join(CLAUDE_DIR, projectDir)
  const jsonlFiles = readdirSync(projectPath).filter(f => f.endsWith(".jsonl"))

  for (const file of jsonlFiles) {
    const sessionId = file.replace(".jsonl", "")
    const filePath = join(projectPath, file)
    const stat = statSync(filePath)
    const isActive = Date.now() - stat.mtimeMs < FIVE_MIN

    const messages = parseJsonl(filePath)
    const firstMsg = messages.find(m => m.sessionId)
    const lastMsg = [...messages].reverse().find(m => m.timestamp)

    const sessionData = {
      id: sessionId,
      projectPath: projectDir,
      messages,
      lastActivity: lastMsg?.timestamp ?? stat.mtime.toISOString(),
      version: firstMsg?.version,
      gitBranch: firstMsg?.gitBranch,
      isActive,
    }

    const key = `sessions/${encodeURIComponent(projectDir)}/${sessionId}`
    console.log(`Syncing ${key} (${messages.length} messages, active=${isActive})`)
    putKV(key, sessionData)
  }
}

console.log("Sync complete.")
