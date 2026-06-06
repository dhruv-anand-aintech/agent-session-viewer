/**
 * Server debug / perf tracing — off by default.
 * Enable: DEBUG=1 or AGENT_SESSION_VIEWER_DEBUG=1
 */

export const isDebugTrace = () =>
  process.env.DEBUG === "1" ||
  process.env.DEBUG === "true" ||
  process.env.AGENT_SESSION_VIEWER_DEBUG === "1" ||
  process.env.AGENT_SESSION_VIEWER_DEBUG === "true"

export function debugLog(...args) {
  if (isDebugTrace()) console.log(...args)
}

export function debugWarn(...args) {
  if (isDebugTrace()) console.warn(...args)
}
