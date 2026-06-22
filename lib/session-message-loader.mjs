import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  readCursorSessionMsgs,
  readCursorAgentSessionFile,
  listCursorAgentTranscriptFiles,
  readOpenCodeSession,
  readOpenCodeSessionFromSqlite,
  readCodexSessionById,
  readAntigravitySession,
  parseAntigravitySessionIndex,
  readHermesSessions,
  readOpenclawSessions,
  readGeminiSessionMsgs,
  OPENCODE_DB,
  OPENCODE_STORAGE,
} from "../platform-readers.mjs"

import { parseJsonlStream } from "../shared-utils.mjs"

function parseJsonl(fp) {
  return parseJsonlStream(fp)
}

function loadClaudeSession(projectPath, sessionId) {
  const fp = projectPath.startsWith("/")
    ? join(projectPath, `${sessionId}.jsonl`)
    : join(homedir(), ".claude", "projects", projectPath, `${sessionId}.jsonl`)
  if (!existsSync(fp)) return null
  const msgs = parseJsonl(fp)
  return msgs.length ? msgs : null
}

function loadCursorAgentSession(projectPath, sessionId) {
  for (const { filePath, slug: s, sessionId: sid } of listCursorAgentTranscriptFiles()) {
    if (sid !== sessionId) continue
    const r = readCursorAgentSessionFile(filePath, s, sid, null, null)
    if (r?.meta?.projectPath === projectPath) return r?.msgs?.length ? r.msgs : null
  }
  return null
}

function loadOpenCodeSession(sessionId) {
  if (existsSync(OPENCODE_DB)) {
    const r = readOpenCodeSessionFromSqlite(OPENCODE_DB, sessionId, null, null)
    if (r?.msgs?.length) return r.msgs
  }

  const base = join(OPENCODE_STORAGE, "session")
  if (!existsSync(base)) return null

  for (const projectHash of readdirSync(base)) {
    const fp = join(base, projectHash, `${sessionId}.json`)
    if (!existsSync(fp)) continue
    const r = readOpenCodeSession(fp, null, null)
    if (r?.msgs?.length) return r.msgs
  }
  return null
}

function loadCodexSession(projectPath, sessionId) {
  const result = readCodexSessionById(sessionId, null, null)
  if (result?.meta?.projectPath === projectPath && Array.isArray(result.msgs)) return result.msgs
  if (isLegacyCodexProjectPath(projectPath, result?.meta?.projectPath) && Array.isArray(result?.msgs)) return result.msgs
  return null
}

export function isLegacyCodexProjectPath(projectPath, canonicalProjectPath) {
  return typeof projectPath === "string" &&
    projectPath.startsWith("codex:") &&
    typeof canonicalProjectPath === "string" &&
    canonicalProjectPath.startsWith("codex:") &&
    projectPath !== canonicalProjectPath
}

function loadAntigravitySession(sessionId) {
  const entry = parseAntigravitySessionIndex().find(s => s.id === sessionId) ?? { id: sessionId, title: null, workspacePath: "" }
  const r = readAntigravitySession(entry, null, null)
  if (r?.meta?.id === sessionId && Array.isArray(r.msgs)) return r.msgs
  return null
}

function loadHermesSession(projectPath, sessionId) {
  for (const { meta, msgs } of readHermesSessions(null, null)) {
    if (meta.id === sessionId && meta.projectPath === projectPath) return msgs
  }
  return null
}

function loadOpenclawSession(projectPath, sessionId) {
  for (const { meta, msgs } of readOpenclawSessions(null, null)) {
    if (meta.id === sessionId && meta.projectPath === projectPath) return msgs
  }
  return null
}

/**
 * Load full message array for a session based on the project cache entry.
 * Returns null when the session cannot be resolved.
 */
export function loadSessionMessages(projectPath, sessionId) {
  if (!projectPath || !sessionId) return null
  if (projectPath.startsWith("cursor:")) return readCursorSessionMsgs(sessionId).msgs ?? null
  if (projectPath.startsWith("cursor-agent:")) return loadCursorAgentSession(projectPath, sessionId)
  if (projectPath.startsWith("opencode:")) return loadOpenCodeSession(sessionId)
  if (projectPath.startsWith("codex:")) return loadCodexSession(projectPath, sessionId)
  if (projectPath.startsWith("antigravity:")) return loadAntigravitySession(sessionId)
  if (projectPath.startsWith("hermes:")) return loadHermesSession(projectPath, sessionId)
  if (projectPath.startsWith("openclaw:")) return loadOpenclawSession(projectPath, sessionId)
  if (projectPath.startsWith("gemini:")) return readGeminiSessionMsgs(sessionId).msgs ?? null
  return loadClaudeSession(projectPath, sessionId)
}
