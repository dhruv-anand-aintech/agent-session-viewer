/** Track open EventSources and close them on pagehide so refresh doesn't stall behind stale SSE. */
const open = new Set<EventSource>()

export function trackedEventSource(url: string | URL, init?: EventSourceInit): EventSource {
  const es = new EventSource(url, init)
  open.add(es)
  const origClose = es.close.bind(es)
  es.close = () => {
    open.delete(es)
    origClose()
  }
  return es
}

export function closeTrackedEventSources(): void {
  for (const es of open) {
    try { es.close() } catch { /* ignore */ }
  }
  open.clear()
}

let installed = false

export function installSsePagehideCleanup(): void {
  if (installed || typeof window === "undefined") return
  installed = true
  const close = () => closeTrackedEventSources()
  window.addEventListener("pagehide", close)
  window.addEventListener("beforeunload", close)
}
