import { useState, useEffect } from "react"
import "./PinGate.css"

export default function PinGate({ onAuth }: { onAuth: () => void }) {
  const [pin, setPin] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    async function checkAuth() {
      try {
        const r = await fetch("/api/capabilities", { credentials: "include" })
        const data = await r.json()
        if (data.authed) {
          onAuth()
        } else {
          setChecking(false)
        }
      } catch {
        setChecking(false)
      }
    }
    checkAuth()
  }, [onAuth])

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

  if (checking) return null

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
