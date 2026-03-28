import { StrictMode, useState, useEffect } from "react"
import { createRoot } from "react-dom/client"
import PinGate from "./PinGate"
import App from "./App"

function Root() {
  const [authed, setAuthed] = useState<boolean | null>(null) // null = checking

  useEffect(() => {
    fetch("/api/capabilities", { credentials: "include" })
      .then(r => setAuthed(r.ok))
      .catch(() => setAuthed(false))
  }, [])

  if (authed === null) return null // brief flicker-free check
  if (!authed) return <PinGate onAuth={() => setAuthed(true)} />
  return <App />
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Root /></StrictMode>
)
