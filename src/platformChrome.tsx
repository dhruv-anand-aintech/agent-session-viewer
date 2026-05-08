import { useState } from "react"

export function platformIconLabel(source?: string): string {
  switch (source ?? "claude") {
    case "cursor": return "Cursor"
    case "opencode": return "OpenCode"
    case "antigravity": return "Antigravity"
    case "hermes": return "Hermes"
    case "codex": return "Codex"
    case "openclaw": return "Openclaw"
    default: return "Claude"
  }
}

export function platformIconSrc(source?: string): string | null {
  switch (source ?? "claude") {
    case "claude": return "https://www.google.com/s2/favicons?sz=64&domain=claude.ai"
    case "cursor": return "https://www.google.com/s2/favicons?sz=64&domain=cursor.com"
    case "opencode": return "https://www.google.com/s2/favicons?sz=64&domain=opencode.ai"
    case "codex": return "https://www.google.com/s2/favicons?sz=64&domain=openai.com"
    case "antigravity": return "https://www.google.com/s2/favicons?sz=64&domain=idx.google.com"
    case "hermes": return "https://www.google.com/s2/favicons?sz=64&domain=nousresearch.com"
    case "openclaw": return "https://www.google.com/s2/favicons?sz=64&domain=openclaw.ai"
    default: return null
  }
}

export function platformFallbackGlyph(source?: string): string {
  switch (source ?? "claude") {
    case "cursor": return "⌁"
    case "opencode": return "</>"
    case "antigravity": return "◌"
    case "hermes": return "⚚"
    case "codex": return "{}"
    case "openclaw": return "🐾"
    default: return "C"
  }
}

export function AgentIcon({ source }: { source?: string }) {
  const [failed, setFailed] = useState(false)
  const src = platformIconSrc(source)
  const label = platformIconLabel(source)

  if (src && !failed) {
    return (
      <img
        className="platform-icon"
        src={src}
        alt={label}
        title={label}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <span className="platform-icon platform-icon-fallback" title={label} aria-label={label} role="img">
      {platformFallbackGlyph(source)}
    </span>
  )
}

export const PLATFORM_FILTER_ACTIVE: Record<string, string> = {
  all: "active-all",
  claude: "active-claude",
  cursor: "active-cursor",
  opencode: "active-opencode",
  antigravity: "active-antigravity",
  hermes: "active-hermes",
  openclaw: "active-openclaw",
}

export function platformFilterActiveClass(p: string): string {
  return PLATFORM_FILTER_ACTIVE[p] ?? "active-claude"
}
