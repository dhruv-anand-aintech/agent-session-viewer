export const ON_DEMAND_SESSION_PLATFORM_RE = /^(opencode|codex|gemini|hermes|antigravity|cursor-agent|openclaw|pi|goose|mimo|pier|devin|normalized-agents|aider|amazonq|amp|cline|cohere-north|command-code|crush|github-copilot-cli|github-copilot-coding-agent|jules|junie|kilo|kimi|kiro|muse|openhands|qwen|replit-agent|roo-code|trae|windsurf|zcode):/

export function isOnDemandSessionPlatform(projectPath) {
  return ON_DEMAND_SESSION_PLATFORM_RE.test(projectPath)
}
