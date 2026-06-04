import { useState, useEffect } from "react"

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [rateLimitAlertsEnabled, setRateLimitAlertsEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch("/api/settings", { credentials: "include" })
      .then(r => r.ok ? r.json() : {})
      .then((s: Record<string, unknown>) => {
        if (typeof s.rateLimitAlertsEnabled === "boolean") {
          setRateLimitAlertsEnabled(s.rateLimitAlertsEnabled)
        }
      })
      .catch(() => {})
  }, [])

  async function save() {
    setSaving(true)
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rateLimitAlertsEnabled }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="settings-section-label">Rate Limit Alerts</div>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={rateLimitAlertsEnabled}
              onChange={e => setRateLimitAlertsEnabled(e.target.checked)}
            />
            <span>
              Watch local agent transcripts and show macOS alerts when a coding agent hits a usage limit.
            </span>
          </label>
          <div className="settings-hint">
            Install the LaunchAgent with <code>npm run rate-limit-watch:launchd-install</code>.
            The watcher covers Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Hermes, and OpenClaw.
          </div>
        </div>
        <div className="settings-footer">
          <button className="settings-save-btn" onClick={save} disabled={saving}>
            {saved ? "Saved!" : saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
