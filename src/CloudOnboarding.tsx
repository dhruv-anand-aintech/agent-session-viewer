import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowRight, Check, Cloud, Download, Laptop, LoaderCircle, RefreshCw, ShieldCheck, Sparkles } from "lucide-react"
import { isNewCloudMachineConnected } from "./cloudOnboardingState"
import "./Marketing.css"

type User = { email?: string; name?: string; picture?: string }
type PairingResponse = { pairingCode: string; expiresAt?: string; claimEndpoint?: string }

const MAC_DOWNLOAD_URL = import.meta.env.VITE_MAC_APP_DOWNLOAD_URL || "/downloads/AgentSessionViewer-macOS.zip"

function defaultMachineLabel() {
  return "My Mac"
}

export default function CloudOnboarding({ user, onConnected }: { user?: User | null; onConnected: () => void }) {
  const [label, setLabel] = useState(defaultMachineLabel)
  const [pairing, setPairing] = useState<PairingResponse | null>(null)
  const [creating, setCreating] = useState(false)
  const [checking, setChecking] = useState(false)
  const [existingMachineIds, setExistingMachineIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState("")

  const connectUrl = useMemo(() => {
    if (!pairing?.pairingCode) return ""
    const params = new URLSearchParams({ cloud: window.location.origin, pairing: pairing.pairingCode })
    return `asv://connect#${params.toString()}`
  }, [pairing])

  const checkStatus = useCallback(async (quiet = false) => {
    if (!quiet) setChecking(true)
    try {
      const response = await fetch("/api/onboarding/status", { credentials: "include", cache: "no-store" })
      if (!response.ok) throw new Error("Could not check the connection yet.")
      if (isNewCloudMachineConnected(await response.json(), existingMachineIds)) onConnected()
    } catch (statusError) {
      if (!quiet) setError(statusError instanceof Error ? statusError.message : "Could not check the connection yet.")
    } finally {
      if (!quiet) setChecking(false)
    }
  }, [existingMachineIds, onConnected])

  useEffect(() => {
    if (!pairing) return
    const timer = window.setInterval(() => void checkStatus(true), 2500)
    return () => window.clearInterval(timer)
  }, [pairing, checkStatus])

  async function startPairing() {
    setCreating(true)
    setError("")
    try {
      const statusResponse = await fetch("/api/onboarding/status", { credentials: "include", cache: "no-store" })
      if (!statusResponse.ok) throw new Error("Could not inspect your existing Macs.")
      const status = await statusResponse.json() as { machines?: Array<{ id?: string }> }
      setExistingMachineIds(new Set((status.machines ?? []).flatMap(machine => machine.id ? [machine.id] : [])))
      const response = await fetch("/api/onboarding/pair", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() || defaultMachineLabel() }),
      })
      if (!response.ok) throw new Error("Could not create a secure connection code.")
      const result = await response.json() as PairingResponse
      if (!result.pairingCode) throw new Error("The server did not return a connection code.")
      setPairing(result)
    } catch (pairingError) {
      setError(pairingError instanceof Error ? pairingError.message : "Could not start pairing.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="onboarding-page">
      <div className="marketing-glow marketing-glow--one" />
      <header className="onboarding-header">
        <a className="marketing-brand" href="/"><span className="marketing-brand-mark"><Sparkles size={17} /></span><span>Agent Session Viewer</span></a>
        <div className="onboarding-user">{user?.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : <span>{(user?.name || user?.email || "A").slice(0, 1).toUpperCase()}</span>}<span>{user?.email}</span></div>
      </header>

      <main className="onboarding-main">
        <div className="onboarding-intro">
          <span className="onboarding-kicker"><Cloud size={14} /> Cloud workspace</span>
          <h1>Bring your first Mac online.</h1>
          <p>Agent Session Viewer reads transcripts on your Mac, then securely syncs them to your private workspace. Setup takes about a minute.</p>
        </div>

        <div className="onboarding-layout">
          <section className="onboarding-steps">
            <article className="onboarding-step is-active">
              <span className="onboarding-step-number">1</span>
              <div><h2>Download the Mac app</h2><p>The app includes the background sync service. Unzip it, move it to Applications, and open it once.</p><a className="onboarding-primary" href={MAC_DOWNLOAD_URL} download><Download size={17} /> Download for macOS</a><small><ShieldCheck size={13} /> macOS 14 or later · Runs in the menu bar</small></div>
            </article>

            <article className={`onboarding-step${pairing ? " is-complete" : " is-active"}`}>
              <span className="onboarding-step-number">{pairing ? <Check size={17} /> : "2"}</span>
              <div><h2>Name and connect this Mac</h2><p>This label helps distinguish your computers. The one-time code expires automatically.</p>
                <div className="onboarding-pair-row">
                  <label><span>Computer name</span><input value={label} onChange={event => setLabel(event.target.value)} maxLength={64} disabled={creating || Boolean(pairing)} /></label>
                  {!pairing && <button className="onboarding-secondary" onClick={startPairing} disabled={creating}>{creating ? <LoaderCircle className="spin" size={17} /> : <Laptop size={17} />} Create connection</button>}
                </div>
                {pairing && <div className="onboarding-pair-ready"><span><Check size={16} /> Secure code ready</span><a className="onboarding-primary" href={connectUrl}>Open Agent Session Viewer <ArrowRight size={16} /></a></div>}
              </div>
            </article>

            <article className={`onboarding-step${pairing ? " is-active" : ""}`}>
              <span className="onboarding-step-number">3</span>
              <div><h2>Wait for the first sync</h2><p>Keep the app open for a moment. This page will take you to your sessions as soon as your Mac checks in.</p><button className="onboarding-check" onClick={() => void checkStatus()} disabled={checking || !pairing}>{checking ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Check connection</button></div>
            </article>
          </section>

          <aside className="onboarding-aside">
            <div className="onboarding-aside-icon"><Laptop size={29} /></div>
            <h3>Private by default</h3><p>Each Mac receives its own credentials after a one-time pairing. Disconnecting one computer does not affect the others.</p>
            <ul><li><Check size={14} /> Background sync after login</li><li><Check size={14} /> No terminal setup required</li><li><Check size={14} /> Revoke a Mac at any time</li></ul>
          </aside>
        </div>
        {error && <div className="onboarding-error" role="alert">{error}</div>}
      </main>
    </div>
  )
}
