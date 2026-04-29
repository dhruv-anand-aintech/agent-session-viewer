/**
 * In-memory search index for sidebar session search.
 * Built once at server startup, updated incrementally when files change.
 * Avoids re-reading all JSONL files on every search request.
 */
import { buildSidebarSearchDoc } from "./session-search-core.mjs"

/** @type {Map<string, { projectPath: string, sessionId: string, displayTitle: string, meta: object, corpus: object }>} */
const _index = new Map()

function key(projectPath, sessionId) {
  return `${projectPath}\x1f${sessionId}`
}

/**
 * Add or update one session in the index.
 * @param {string} projectPath
 * @param {string} sessionId
 * @param {unknown[]} msgs  — full message array
 * @param {object} meta     — session metadata (customName?, firstName?, etc.)
 */
export function indexSession(projectPath, sessionId, msgs, meta) {
  const displayTitle = String(meta?.customName || meta?.firstName || sessionId.slice(0, 8))
  const corpus = buildSidebarSearchDoc(msgs, meta)
  _index.set(key(projectPath, sessionId), { projectPath, sessionId, displayTitle, meta, corpus })
}

/** Remove a session from the index (e.g. file deleted). */
export function removeSession(projectPath, sessionId) {
  _index.delete(key(projectPath, sessionId))
}

/** Return all rows suitable for runSidebarSessionSearch. */
export function getSearchRows() {
  return Array.from(_index.values())
}

export function indexSize() {
  return _index.size
}
