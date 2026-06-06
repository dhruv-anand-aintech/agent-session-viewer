import { StrictMode, useState, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { Router, Redirect } from "wouter"
import PinGate from "./PinGate"
import App from "./App"
import { initDebugTrace } from "./debug-trace"
import { installSsePagehideCleanup } from "./sse-lifecycle"

initDebugTrace()
installSsePagehideCleanup()

/** Abort a fetch after `ms` milliseconds. */
function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit & { timeout?: number }) {
  const { timeout = 5000, ...rest } = init ?? {}
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  return fetch(input, { ...rest, signal: ctrl.signal }).finally(() => clearTimeout(t))
}

function Root() {
  const [authed, setAuthed] = useState<boolean | null>(null) // null = checking

  useEffect(() => {
    fetchWithTimeout("/api/capabilities", { credentials: "include", timeout: 4000 })
      .then(async r => {
        if (!r.ok) { setAuthed(false); return }
        try {
          const caps = (await r.json()) as { pinRequired?: boolean; authed?: boolean }
          if (caps.pinRequired === false) { setAuthed(true); return }
          if (typeof caps.authed === "boolean") { setAuthed(caps.authed); return }
          setAuthed(false)
        } catch {
          setAuthed(false)
        }
      })
      .catch(() => setAuthed(false))
  }, [])

  if (authed === null) {
    return (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        color: "#888",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
      }}>
        Connecting…
      </div>
    )
  }
  if (!authed) return <PinGate onAuth={() => setAuthed(true)} />
  return (
    <Router>
      {/* Redirect bare / to /sessions */}
      {window.location.pathname === "/" && <Redirect to="/sessions" />}
      <App />
    </Router>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Root /></StrictMode>
)
