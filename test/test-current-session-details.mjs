/**
 * Regression test for real current-machine session detail loading.
 *
 * Run with: node test/test-current-session-details.mjs
 *
 * This intentionally uses local transcript/session stores from this machine. It
 * does not call external APIs.
 */
import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { loadSessionMessages } from "../lib/session-message-loader.mjs"
import { isOnDemandSessionPlatform } from "../lib/session-platform-routing.mjs"
import {
  ANTIGRAVITY_BRAIN_DIR,
  CODEX_SESSIONS_ROOT,
  CURSOR_PROJECTS_ROOT,
  GEMINI_TMP_ROOT,
  HERMES_DB,
  OPENCLAW_ROOT,
  parseAntigravitySessionIndex,
  readAntigravitySession,
  readCodexSessions,
  readCursorAgentSessions,
  readCursorSessions,
  readGeminiSessions,
  readHermesSessions,
  readOpenclawSessions,
  iterOpenCodeSessions,
} from "../platform-readers.mjs"

const CLAUDE_DIR = path.join(homedir(), ".claude", "projects")

const loaders = {
  claude: collectClaudeSamples,
  cursor: () => readCursorSessions(null, null),
  "cursor-agent": () => fs.existsSync(CURSOR_PROJECTS_ROOT) ? readCursorAgentSessions(null, null) : [],
  codex: () => fs.existsSync(CODEX_SESSIONS_ROOT) ? readCodexSessions(null, null) : [],
  gemini: () => fs.existsSync(GEMINI_TMP_ROOT) ? readGeminiSessions(null, null) : [],
  opencode: () => [...iterOpenCodeSessions(null, null)].map(x => x.result).filter(Boolean),
  antigravity: collectAntigravitySamples,
  hermes: () => fs.existsSync(HERMES_DB) ? readHermesSessions(null, null) : [],
  openclaw: () => fs.existsSync(OPENCLAW_ROOT) ? readOpenclawSessions(null, null) : [],
}

const onDemandPlatforms = ["opencode", "codex", "gemini", "hermes", "antigravity", "cursor-agent", "openclaw"]
for (const platform of onDemandPlatforms) {
  assert(
    isOnDemandSessionPlatform(`${platform}:/tmp/project`),
    `local-server on-demand routing should include ${platform}`
  )
}
assert(!isOnDemandSessionPlatform("claude-project"), "Claude paths should stay on the JSONL file path branch")

const loaded = []
const skipped = []

for (const [platform, collect] of Object.entries(loaders)) {
  let results = []
  try {
    results = collect().filter(Boolean)
  } catch (err) {
    skipped.push(`${platform} (collector failed: ${err.message})`)
    continue
  }

  if (!results.length) {
    skipped.push(`${platform} (no current sessions found)`)
    continue
  }

  let sample = null
  let msgs = null
  for (const result of results) {
    const meta = result.meta ?? result
    if (!meta?.id || !meta?.projectPath) continue
    const loadedMsgs = loadSessionMessages(meta.projectPath, meta.id)
    if (Array.isArray(loadedMsgs) && loadedMsgs.length > 0) {
      sample = meta
      msgs = loadedMsgs
      break
    }
  }

  if (!sample) {
    throw new Error(`${platform}: found ${results.length} current session(s), but none loaded via session-detail path`)
  }

  loaded.push(`${platform}:${sample.id.slice(0, 8)} (${msgs.length} msgs)`)
}

assert(loaded.length > 0, "expected at least one current-machine session sample")
console.log("  ✓  current session detail loading works for real samples:")
for (const line of loaded) console.log(`     ${line}`)
if (skipped.length) {
  console.log("  -  skipped missing platform samples:")
  for (const line of skipped) console.log(`     ${line}`)
}

function collectClaudeSamples() {
  const out = []
  if (!fs.existsSync(CLAUDE_DIR)) return out
  for (const dir of fs.readdirSync(CLAUDE_DIR)) {
    const projectPath = path.join(CLAUDE_DIR, dir)
    try { if (!fs.statSync(projectPath).isDirectory()) continue } catch { continue }
    for (const file of fs.readdirSync(projectPath).filter(f => f.endsWith(".jsonl"))) {
      const sessionId = file.slice(0, -".jsonl".length)
      out.push({ meta: { id: sessionId, projectPath } })
    }
  }
  return out
}

function collectAntigravitySamples() {
  if (!fs.existsSync(ANTIGRAVITY_BRAIN_DIR)) return []
  const indexSessions = parseAntigravitySessionIndex()
  const indexMap = new Map(indexSessions.map(s => [s.id, s]))
  for (const id of fs.readdirSync(ANTIGRAVITY_BRAIN_DIR)) {
    if (!indexMap.has(id)) indexMap.set(id, { id, title: null, workspacePath: "" })
  }
  return [...indexMap.values()].flatMap(session => {
    const result = readAntigravitySession(session, null, null)
    return result ? [result] : []
  })
}

function assert(condition, message) {
  if (condition) return
  console.error(`  ✗  ${message}`)
  process.exitCode = 1
  throw new Error(message)
}
