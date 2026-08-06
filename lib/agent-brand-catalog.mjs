/**
 * Canonical coding-agent catalog shared by the local readers and UI.
 *
 * The matrix uses product-specific slugs while AGL uses launch aliases. Keep
 * both here so a session never falls back to the misleading Claude label just
 * because a provider has a new or exported transcript format.
 */
export const AGENT_BRANDS = Object.freeze([
  ["aider", "Aider", ["aider"]],
  ["amazonq", "Amazon Q Developer CLI", ["amazonq", "amazon-q-developer-cli"]],
  ["amp", "Amp", ["amp"]],
  ["antigravity", "Antigravity", ["antigravity", "antigravity-cli"]],
  ["claude", "Claude Code", ["claude", "claude-code"]],
  ["cline", "Cline", ["cline"]],
  ["codex", "OpenAI Codex CLI", ["codex", "codex-cli"]],
  ["cohere-north", "Cohere North", ["cohere-north"]],
  ["command-code", "Command Code", ["command-code"]],
  ["crush", "Crush", ["crush"]],
  ["cursor", "Cursor", ["cursor", "cursor-agent"]],
  ["devin", "Devin", ["devin"]],
  ["droid", "Factory Droid", ["droid", "factory-droid"]],
  ["gemini", "Gemini CLI", ["gemini", "gemini-cli"]],
  ["github-copilot-cli", "GitHub Copilot CLI", ["copilot", "github-copilot-cli"]],
  ["github-copilot-coding-agent", "GitHub Copilot", ["github-copilot-coding-agent"]],
  ["goose", "Goose", ["goose"]],
  ["grok", "Grok Build", ["grok", "grok-build"]],
  ["jules", "Google Jules", ["jules"]],
  ["junie", "JetBrains Junie", ["junie"]],
  ["kilo", "Kilo Code", ["kilo", "kilo-code"]],
  ["kimi", "Kimi CLI", ["kimi", "kimi-cli"]],
  ["kiro", "Kiro", ["kiro"]],
  ["mimo", "MiMo Code", ["mimo", "mimo-code"]],
  ["muse", "Muse Code", ["muse", "muse-code"]],
  ["opencode", "OpenCode", ["opencode"]],
  ["openhands", "OpenHands", ["openhands"]],
  ["pi", "Pi", ["pi"]],
  ["pier", "Pier Code", ["pier", "pier-code"]],
  ["qwen", "Qwen Code", ["qwen", "qwen-code"]],
  ["replit-agent", "Replit Agent", ["replit-agent"]],
  ["roo-code", "Roo Code", ["roo-code"]],
  ["trae", "Trae Agent", ["trae", "trae-agent"]],
  ["windsurf", "Windsurf Cascade", ["windsurf"]],
  ["zcode", "ZCode", ["zcode"]],
].map(([source, label, aliases]) => Object.freeze({ source, label, aliases: Object.freeze(aliases) })))

const BY_ALIAS = new Map()
for (const brand of AGENT_BRANDS) {
  BY_ALIAS.set(brand.source, brand)
  for (const alias of brand.aliases) BY_ALIAS.set(alias, brand)
}

export function agentBrandForSource(source) {
  return BY_ALIAS.get(String(source ?? "").trim().toLowerCase()) ?? null
}

export function agentBrandLabel(source) {
  return agentBrandForSource(source)?.label ?? (source ? String(source) : "Claude Code")
}

export function canonicalAgentSource(source) {
  return agentBrandForSource(source)?.source ?? String(source ?? "claude")
}

export const AGENT_BRAND_SOURCES = Object.freeze(AGENT_BRANDS.map(brand => brand.source))
