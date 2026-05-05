/**
 * Background indexer — crawls all sessions and feeds them into the LanceDB index.
 * Designed to run asynchronously inside local-server without blocking request handling.
 * Skips sessions already in the index; processes the rest in setImmediate-yielding batches.
 */
import {
  indexSessionMessages,
  getIndexedKeys,
  removeSessionFromIndex,
} from "./lancedb-search.mjs"
import { flattenMessageForThread } from "./session-search-core.mjs"

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 23)

let _running = false
let _indexedCount = 0
let _pendingCount = 0
let _lastError = null

export function getIndexerStatus() {
  return {
    running: _running,
    indexed: _indexedCount,
    pending: _pendingCount,
    lastError: _lastError,
    modelReady: false,
  }
}

/**
 * Index (or re-index) a single session immediately.
 * Called when a session file changes so the index stays current.
 */
export async function indexOneSession(projectPath, sessionId, msgs) {
  try {
    const n = await indexSessionMessages(projectPath, sessionId, msgs, flattenMessageForThread)
    if (n > 0) _indexedCount++
    return n
  } catch (err) {
    _lastError = err.message
    return 0
  }
}

/** Remove a session from the index (file deleted). */
export async function removeOne(projectPath, sessionId) {
  try {
    await removeSessionFromIndex(projectPath, sessionId)
  } catch { /* ignore */ }
}

/**
 * Start the background indexing loop.
 *
 * @param {() => { projectPath: string, sessionId: string }[]} getRowsFn
 *   Returns current in-memory search rows (from lib/search-index.mjs).
 * @param {(projectPath: string, sessionId: string) => unknown[] | null} readMsgsFn
 *   Reads full message array for a session (sync or async).
 */
export async function startBackgroundIndexer(getRowsFn, readMsgsFn) {
  if (_running) return
  _running = true
  _lastError = null

  try {
    const indexed = await getIndexedKeys()
    const rows = getRowsFn()
    const todo = rows.filter(r => !indexed.has(`${r.projectPath}\x1f${r.sessionId}`))
    _pendingCount = todo.length

    if (!todo.length) {
      console.log(`${ts()} [lancedb-indexer] Index up to date (${indexed.size} sessions)`)
      return
    }

    const total = todo.length
    console.log(`${ts()} [lancedb-indexer] Indexing ${total} new sessions (${indexed.size} already indexed)`)

    const bar = (done, total) => {
      const W = 30
      const filled = Math.round((done / total) * W)
      return `[${"█".repeat(filled)}${"░".repeat(W - filled)}] ${done}/${total}`
    }

    let done = 0
    for (const row of todo) {
      if (!_running) break
      try {
        const msgs = await readMsgsFn(row.projectPath, row.sessionId)
        if (Array.isArray(msgs) && msgs.length) {
          await indexOneSession(row.projectPath, row.sessionId, msgs)
        }
        _pendingCount--
      } catch (err) {
        _lastError = err.message
        _pendingCount--
      }
      done++
      process.stdout.write(`\r${ts()} [lancedb-indexer] ${bar(done, total)}`)
      // Yield between sessions so HTTP requests aren't starved
      await new Promise(r => setImmediate(r))
    }

    process.stdout.write("\n")
    console.log(`${ts()} [lancedb-indexer] Done. Total indexed: ${_indexedCount} sessions`)
  } catch (err) {
    _lastError = err.message
    console.error(`${ts()} [lancedb-indexer] Fatal error:`, err.message)
  } finally {
    _running = false
  }
}

export function stopIndexer() { _running = false }
