export const ON_DEMAND_SESSION_PLATFORM_RE = /^(opencode|codex|gemini|hermes|antigravity|cursor-agent|openclaw):/

export function isOnDemandSessionPlatform(projectPath) {
  return ON_DEMAND_SESSION_PLATFORM_RE.test(projectPath)
}
