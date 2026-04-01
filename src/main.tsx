import { StrictMode, useState, useEffect } from "react"
import { createRoot } from "react-dom/client"
import PinGate from "./PinGate"
import App from "./App"

function Root() {
  const [authed, setAuthed] = useState<boolean | null>(null) // null = checking

  useEffect(() => {
    fetch("/api/capabilities", { credentials: "include" })
      .then(async r => {
        if (!r.ok) {
          setAuthed(false)
          return
        }
        let pinRequired = true
        try {
          const caps = (await r.json()) as { pinRequired?: boolean }
          if (caps.pinRequired === false) pinRequired = false
        } catch {
          /* older servers omit pinRequired — assume PIN may be required */
        }
        if (!pinRequired) {
          setAuthed(true)
          return
        }
        const pr = await fetch("/api/projects?maxSessions=1", { credentials: "include" })
        setAuthed(pr.ok)
      })
      .catch(() => setAuthed(false))
  }, [])

  if (authed === null) return null // brief flicker-free check
  if (!authed) return <PinGate onAuth={() => setAuthed(true)} />
  return <App />
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Root /></StrictMode>
)
