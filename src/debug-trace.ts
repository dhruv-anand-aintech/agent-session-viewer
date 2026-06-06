/**
 * Client debug / perf tracing — off by default.
 * Enable: ?debug=1 on any page load (stored for the tab session), or
 *          localStorage.setItem("asv-debug", "1")
 */

const KEY = "asv-debug"

export function initDebugTrace(): void {
  if (typeof window === "undefined") return
  try {
    const q = new URLSearchParams(window.location.search)
    if (q.get("debug") === "1" || q.get("debug") === "true") {
      sessionStorage.setItem(KEY, "1")
    }
  } catch { /* ignore */ }
}

export function isDebugTrace(): boolean {
  if (typeof window === "undefined") return false
  try {
    return sessionStorage.getItem(KEY) === "1" || localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export function debugLog(...args: unknown[]): void {
  if (isDebugTrace()) console.log(...args)
}

export function debugWarn(...args: unknown[]): void {
  if (isDebugTrace()) console.warn(...args)
}
