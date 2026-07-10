import { ArrowRight, Cloud, Code2, MonitorUp, Search, ShieldCheck, Sparkles } from "lucide-react"
import "./Marketing.css"

const platforms = ["Claude Code", "Codex", "Cursor", "OpenCode", "Hermes", "Antigravity"]

function GoogleIcon() {
  return (
    <svg className="marketing-google-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285f4" d="M21.35 12.22c0-.74-.07-1.45-.19-2.13H12v4.03h5.24a4.48 4.48 0 0 1-1.94 2.94v2.62h3.14c1.84-1.69 2.91-4.19 2.91-7.46Z" />
      <path fill="#34a853" d="M12 21.73c2.62 0 4.82-.87 6.44-2.35l-3.14-2.62c-.87.58-1.98.93-3.3.93-2.53 0-4.67-1.71-5.44-4.01H3.31v2.7A9.73 9.73 0 0 0 12 21.73Z" />
      <path fill="#fbbc05" d="M6.56 13.68A5.85 5.85 0 0 1 6.25 12c0-.58.11-1.15.31-1.68v-2.7H3.31A9.73 9.73 0 0 0 2.27 12c0 1.57.38 3.05 1.04 4.38l3.25-2.7Z" />
      <path fill="#ea4335" d="M12 6.31c1.43 0 2.71.49 3.72 1.45l2.79-2.79A9.35 9.35 0 0 0 12 2.27a9.73 9.73 0 0 0-8.69 5.35l3.25 2.7c.77-2.3 2.91-4.01 5.44-4.01Z" />
    </svg>
  )
}

function SignInButton({ compact = false }: { compact?: boolean }) {
  const returnQuery = window.location.pathname === "/setup/mac" ? "?return=%2Fsetup%2Fmac" : ""
  return (
    <a className={`marketing-signin${compact ? " marketing-signin--compact" : ""}`} href={`/api/auth/google/start${returnQuery}`}>
      <GoogleIcon />
      <span>Continue with Google</span>
      {!compact && <ArrowRight size={16} strokeWidth={1.8} />}
    </a>
  )
}

export default function GoogleGate() {
  return (
    <div className="marketing-page">
      <div className="marketing-glow marketing-glow--one" />
      <div className="marketing-glow marketing-glow--two" />

      <header className="marketing-nav">
        <a className="marketing-brand" href="/" aria-label="Agent Session Viewer home">
          <span className="marketing-brand-mark"><Sparkles size={17} /></span>
          <span>Agent Session Viewer</span>
        </a>
        <nav className="marketing-nav-links" aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href="https://github.com/dhruv-anand-aintech/agent-session-viewer" target="_blank" rel="noreferrer"><Code2 size={15} /> GitHub</a>
        </nav>
        <SignInButton compact />
      </header>

      <main>
        <section className="marketing-hero">
          <div className="marketing-eyebrow"><span /> Your AI coding work, in one place</div>
          <h1>Every agent session.<br /><em>Always within reach.</em></h1>
          <p className="marketing-hero-copy">Search, revisit, and continue work across every coding agent you use. Your Mac syncs privately in the background, so context is waiting wherever you sign in.</p>
          <div className="marketing-hero-actions">
            <SignInButton />
            <span className="marketing-signin-note"><ShieldCheck size={14} /> Private to your account</span>
          </div>
          <div className="marketing-platforms" aria-label="Supported coding agents">
            <span>Works with</span>
            {platforms.map((platform) => <span className="marketing-platform-pill" key={platform}>{platform}</span>)}
          </div>
        </section>

        <section className="marketing-product-frame" aria-label="Agent Session Viewer preview">
          <div className="marketing-window-bar">
            <span className="marketing-window-dots"><i /><i /><i /></span>
            <span className="marketing-window-title">agent-session-viewer</span>
            <span className="marketing-live"><i /> Live</span>
          </div>
          <div className="marketing-demo">
            <aside className="marketing-demo-sidebar">
              <div className="marketing-demo-search"><Search size={13} /> Search sessions</div>
              <p>RECENT PROJECTS</p>
              {[
                ["agent-session-viewer", "Add cloud onboarding", "Claude"],
                ["lipi", "Improve Hindi ranking", "Codex"],
                ["daily-work-report", "Build weekly brief", "Cursor"],
              ].map(([project, session, agent], index) => (
                <div className={`marketing-demo-session${index === 0 ? " active" : ""}`} key={project}>
                  <i className={`agent-dot agent-dot--${agent.toLowerCase()}`} />
                  <span><b>{project}</b><small>{session}</small></span>
                  <em>{index === 0 ? "now" : `${index + 1}h`}</em>
                </div>
              ))}
            </aside>
            <div className="marketing-demo-content">
              <div className="marketing-demo-heading"><span><b>Add cloud onboarding</b><small>agent-session-viewer · Claude Code</small></span><span className="marketing-demo-status">Running</span></div>
              <div className="marketing-chat marketing-chat--user"><span>D</span><p>Build a clean onboarding flow for the desktop sync app.</p></div>
              <div className="marketing-chat marketing-chat--agent"><span>AI</span><div><p>I’ll connect the signed-in state to machine status, then make setup feel like a short guided handoff to the Mac app.</p><div className="marketing-code"><i /> Inspecting authentication and cloud sync APIs</div></div></div>
              <div className="marketing-chat marketing-chat--agent marketing-chat--muted"><span>AI</span><p>Onboarding is ready. The viewer now opens as soon as the first sync completes.</p></div>
            </div>
          </div>
        </section>

        <section className="marketing-how" id="how-it-works">
          <div className="marketing-section-heading"><span>From local to available everywhere</span><h2>Set it up once. Keep your context.</h2></div>
          <div className="marketing-feature-grid">
            <article><span><MonitorUp size={20} /></span><small>01</small><h3>Install on your Mac</h3><p>A lightweight menu bar app securely watches the agent transcripts already on your computer.</p></article>
            <article><span><Cloud size={20} /></span><small>02</small><h3>Sync in the background</h3><p>New sessions appear automatically. No exporting, copying paths, or keeping a tunnel alive.</p></article>
            <article><span><Search size={20} /></span><small>03</small><h3>Find any decision</h3><p>Open the viewer from any device and search across tools, projects, messages, and subagents.</p></article>
          </div>
        </section>
      </main>

      <footer className="marketing-footer"><span>Agent Session Viewer</span><span>Your sessions stay private to your account.</span></footer>
    </div>
  )
}
