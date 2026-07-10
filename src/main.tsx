/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useState, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { Router, Redirect } from "wouter"
import { LoaderCircle } from "lucide-react"
import PinGate from "./PinGate"
import GoogleGate from "./GoogleGate"
import CloudOnboarding from "./CloudOnboarding"
import { isCloudMachineConnected } from "./cloudOnboardingState"
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
  const wantsMacSetup = window.location.pathname === "/setup/mac"
  const [authed, setAuthed] = useState<boolean | null>(null) // null = checking
  const [authProvider, setAuthProvider] = useState<"pin" | "google" | "none">("pin")
  const [user, setUser] = useState<{ email?: string; name?: string; picture?: string } | null>(null)
  const [cloudConnected, setCloudConnected] = useState<boolean | null>(null)

  useEffect(() => {
    fetchWithTimeout("/api/capabilities", { credentials: "include", timeout: 4000 })
      .then(async r => {
        if (!r.ok) { setAuthed(false); return }
        try {
          const caps = (await r.json()) as { pinRequired?: boolean; authed?: boolean; authProvider?: "pin" | "google" | "none"; user?: { email?: string; name?: string; picture?: string } | null }
          setAuthProvider(caps.authProvider ?? "pin")
          setUser(caps.user ?? null)
          if (caps.pinRequired === false) { setAuthed(true); return }
          if (typeof caps.authed === "boolean") { setAuthed(caps.authed); return }
          setAuthed(false)
        } catch {
          setAuthed(false)
        }
      })
      .catch(() => setAuthed(false))
  }, [])

  useEffect(() => {
    if (!authed || authProvider !== "google") return
    fetchWithTimeout("/api/onboarding/status", { credentials: "include", cache: "no-store", timeout: 4000 })
      .then(async response => {
        if (!response.ok) throw new Error("status unavailable")
        setCloudConnected(isCloudMachineConnected(await response.json()))
      })
      .catch(() => setCloudConnected(false))
  }, [authed, authProvider])

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
  if (!authed) return authProvider === "google" ? <GoogleGate /> : <PinGate onAuth={() => setAuthed(true)} />
  if (authProvider === "google" && cloudConnected === null) {
    return <div className="cloud-bootstrap"><LoaderCircle className="spin" size={18} /><span>Loading your workspace…</span></div>
  }
  if (authProvider === "google" && (cloudConnected === false || wantsMacSetup)) {
    return <CloudOnboarding
      user={user}
      onConnected={() => {
        setCloudConnected(true)
        if (wantsMacSetup) window.location.assign("/sessions")
      }}
    />
  }
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
