/**
 * Worker thread entry point for loading one platform's sessions.
 * Runs in its own V8 isolate so blocking I/O (SQLite, file reads) never stalls the main thread.
 * Posts { platform, sessions } back to the main thread when done.
 */
import { workerData, parentPort } from "node:worker_threads"
import { existsSync, readdirSync } from "node:fs"
import * as readers from "../platform-readers.mjs"

const { platform } = workerData

async function load() {
  switch (platform) {
    case "opencode":
      return [...readers.iterOpenCodeSessions(null, null)].map(x => x.result).filter(Boolean)

    case "cursor":
      return readers.readCursorSessions(null, null)

    case "cursor-agent":
      return existsSync(readers.CURSOR_PROJECTS_ROOT)
        ? readers.readCursorAgentSessions(null, null)
        : []

    case "codex":
      return existsSync(readers.CODEX_SESSIONS_ROOT)
        ? readers.readCodexSessions(null, null)
        : []

    case "gemini":
      return existsSync(readers.GEMINI_TMP_ROOT)
        ? readers.readGeminiSessions(null, null)
        : []

    case "hermes":
      return existsSync(readers.HERMES_DB)
        ? readers.readHermesSessions(null, null)
        : []

    case "openclaw":
      return existsSync(readers.OPENCLAW_ROOT)
        ? readers.readOpenclawSessions(null, null)
        : []

    case "antigravity": {
      if (!existsSync(readers.ANTIGRAVITY_BRAIN_DIR)) return []
      const indexSessions = readers.parseAntigravitySessionIndex()
      const indexMap = new Map(indexSessions.map(s => [s.id, s]))
      const rpcResults = await readers.readAntigravityRpcSessions(indexMap).catch(() => [])
      if (rpcResults.length) return rpcResults
      // Fallback: markdown artifacts
      for (const id of readdirSync(readers.ANTIGRAVITY_BRAIN_DIR)) {
        if (!indexMap.has(id)) indexMap.set(id, { id, title: null, workspacePath: "" })
      }
      const results = []
      for (const session of indexMap.values()) {
        const r = readers.readAntigravitySession(session, null, null)
        if (r) results.push(r)
      }
      return results
    }

    case "antigravity-cli":
      return existsSync(readers.ANTIGRAVITY_CLI_DIR)
        ? readers.readAntigravityCliSessions(null, null)
        : []

    default:
      return []
  }
}

load()
  .then(sessions => parentPort.postMessage({ platform, sessions }))
  .catch(err => parentPort.postMessage({ platform, sessions: [], error: err.message }))
