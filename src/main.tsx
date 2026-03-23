import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import PinGate from "./PinGate"
import App from "./App"

function Root() {
  const [authed, setAuthed] = useState(false)
  if (!authed) return <PinGate onAuth={() => setAuthed(true)} />
  return <App />
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Root /></StrictMode>
)
