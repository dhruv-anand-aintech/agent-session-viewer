export default function GoogleGate() {
  return (
    <div className="google-gate">
      <div className="google-gate-panel">
        <div className="google-gate-mark">ASV</div>
        <h1>Agent Session Viewer</h1>
        <p>Sign in with Google to view synced coding-agent sessions from your registered machines.</p>
        <a className="google-gate-button" href="/api/auth/google/start">
          Continue with Google
        </a>
      </div>
    </div>
  )
}
