import { StrictMode, useState, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { Router, Redirect } from "wouter"
import PinGate from "./PinGate"
import App from "./App"

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
          // New servers include `authed` so we can skip a second round-trip
          if (caps.authed !== undefined) { setAuthed(caps.authed); return }
          // Older servers: no pin → authed; pin required → probe /api/projects
          if (caps.pinRequired === false) { setAuthed(true); return }
        } catch { /* fall through to probe */ }
        const pr = await fetchWithTimeout("/api/projects?maxSessions=1", { credentials: "include", timeout: 4000 })
        setAuthed(pr.ok)
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
