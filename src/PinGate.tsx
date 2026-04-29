import { useState } from "react"
import "./PinGate.css"

export default function PinGate({ onAuth }: { onAuth: () => void }) {
  const [pin, setPin] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pin }),
      })
      if (r.ok) {
        onAuth()
      } else {
        setError("Incorrect PIN")
        setPin("")
      }
    } catch {
      setError("Connection error")
    }
    setLoading(false)
  }

  return (
    <div className="pin-gate">
      <div className="pin-card">
        <div className="pin-title">Agent Session Viewer</div>
        <div className="pin-subtitle">Enter your PIN to continue</div>
        <form onSubmit={submit} className="pin-form">
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            value={pin}
            onChange={e => setPin(e.target.value)}
            placeholder="PIN"
            className="pin-input"
            autoFocus
            maxLength={8}
          />
          {error && <div className="pin-error">{error}</div>}
          <button type="submit" disabled={loading || pin.length === 0} className="pin-btn">
            {loading ? "…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  )
}
