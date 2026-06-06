/**
 * Perf markers for DevTools timeline + optional console tracing (debug only).
 * performance.mark() always runs so tunnel regression can read bootstrap:done.
 */
import { isDebugTrace, debugLog } from "./debug-trace"

function clk() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  })
}

function mark(name: string) {
  performance.mark(name)
}

function measure(label: string, startMark: string, endMark?: string) {
  if (!isDebugTrace()) return 0
  try {
    const m = performance.measure(label, startMark, endMark)
    debugLog(`[perf ${clk()}] ⏱ ${label}: ${m.duration.toFixed(1)}ms`)
    return m.duration
  } catch {
    return 0
  }
}

// ── Page load ─────────────────────────────────────────────────────────────────

/** Call once at app init (top of App component or main.tsx). */
export function markAppInit() {
  mark("app:init")
  debugLog(`[perf ${clk()}] 📄 page load — JS parsed & App mounting`)
}

/** Call when first SSE connection opens. */
export function markSSEOpen() {
  mark("sse:open")
  measure("SSE connect", "app:init", "sse:open")
}

/** Call when first projects batch arrives over SSE. */
export function markProjectsFirst() {
  mark("projects:first")
  measure("first projects batch", "app:init", "projects:first")
}

/** Call when bootstrap_done fires — sidebar is fully populated. */
export function markBootstrapDone(sessionCount: number) {
  mark("bootstrap:done")
  measure("sidebar bootstrap", "app:init", "bootstrap:done")
  debugLog(`[perf ${clk()}] 📋 sidebar ready — ${sessionCount} sessions`)
}

// ── Session switch ─────────────────────────────────────────────────────────────

const switchT0: Record<string, number> = {}

/** Call immediately when the user clicks a session in the sidebar. */
export function markSessionClick(sessionId: string) {
  const key = `session:click:${sessionId}`
  mark(key)
  switchT0[sessionId] = performance.now()
  debugLog(`[perf ${clk()}] 🖱 session click ${sessionId.slice(0, 8)}`)
}

/** Call when IDB returns (hit or miss) after a session click. */
export function markIDBResult(sessionId: string, hit: boolean, count: number, ms: number) {
  debugLog(`[perf ${clk()}] 💾 IDB ${hit ? `hit (${count} msgs)` : "miss"} ${sessionId.slice(0, 8)} — ${ms.toFixed(1)}ms`)
}

/** Call inside requestAnimationFrame after first messages appear in DOM. */
export function markFirstPaint(sessionId: string, msgCount: number) {
  const elapsed = switchT0[sessionId] != null
    ? (performance.now() - switchT0[sessionId]).toFixed(1)
    : "?"
  debugLog(`[perf ${clk()}] 🖼  first paint ${sessionId.slice(0, 8)} — ${msgCount} msgs — ${elapsed}ms wall time from click`)
  delete switchT0[sessionId]
}

/** Call after fetchRemote completes and data is handed to initWindow. */
export function markRemoteFetch(sessionId: string, fetchMs: number, parseMs: number, count: number, total: number) {
  debugLog(`[perf ${clk()}] 🌐 remote fetch ${sessionId.slice(0, 8)} — ${count}/${total} msgs | fetch:${fetchMs.toFixed(1)}ms json:${parseMs.toFixed(1)}ms`)
}

/** Call when a loadEarlier chunk fetch completes. */
export function markChunkLoad(sessionId: string, chunk: number, skip: number, ms: number) {
  debugLog(`[perf ${clk()}] 📦 chunk load ${sessionId.slice(0, 8)} skip=${skip} → ${chunk} msgs in ${ms.toFixed(1)}ms`)
}
