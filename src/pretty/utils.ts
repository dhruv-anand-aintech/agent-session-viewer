/** Strip XML-style tags and system wrappers from user message text */
export function stripXml(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, (_, c) => c.trim())
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, "/$1")
    .replace(/<command-message>([\s\S]*?)<\/command-message>/g, "")
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, "")
    .replace(/<channel source="[^"]*"[^>]*>([\s\S]*?)<\/channel>/g, (_, c) => c.trim())
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Linkify local file paths like /Users/... or ~/... */
export function linkifyPaths(text: string): Array<{ type: "text" | "path"; value: string }> {
  const re = /(?:~|\/(?:Users|home|tmp|var|etc|opt))[^\s"',`\])}]+/g
  const parts: Array<{ type: "text" | "path"; value: string }> = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) })
    parts.push({ type: "path", value: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) })
  return parts.length ? parts : [{ type: "text", value: text }]
}

/** Short display name for a file path */
export function basename(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path
}

/** Classify tool name into a category */
export type ToolCategory =
  | "bash" | "read" | "write" | "edit" | "glob" | "grep"
  | "telegram" | "cloudflare" | "gmail" | "google"
  | "web-search" | "web-fetch" | "agent" | "tool-search"
  | "mcp-generic" | "unknown"

const LOWER = (s: string) => s.toLowerCase()

export function classifyTool(name: string): ToolCategory {
  const n = name.trim()
  const l = LOWER(n)
  if (
    n === "Bash" ||
    n === "Shell" ||
    l === "run_terminal_cmd" ||
    l === "exec_command" ||
    l === "write_stdin"
  )
    return "bash"
  if (n === "Read" || l === "read_file" || n === "read_mcp_resource" || n === "view_image")
    return "read"
  if (n === "Write" || l === "write") return "write"
  if (
    n === "Edit" ||
    n === "apply_patch" ||
    l === "str_replace" ||
    l === "search_replace"
  )
    return "edit"
  if (n === "Glob" || l === "glob_file_search") return "glob"
  if (n === "Grep" || l === "codebase_search" || l === "grep") return "grep"
  if (name === "WebSearch") return "web-search"
  if (name === "WebFetch" || name === "web.run") return "web-fetch"
  if (name === "Agent" || name === "spawn_agent" || name === "send_input" || name === "multi_tool_use.parallel") return "agent"
  if (name === "ToolSearch") return "tool-search"
  if (name.includes("telegram")) return "telegram"
  if (name.includes("Cloudflare") || name.includes("cloudflare")) return "cloudflare"
  if (name.includes("Gmail") || name.includes("gmail")) return "gmail"
  if (name.includes("Google") || name.includes("gcal")) return "google"
  if (name.startsWith("mcp__")) return "mcp-generic"
  return "unknown"
}

export const TOOL_META: Record<ToolCategory, { icon: string; label: string; color: string }> = {
  bash:         { icon: ">_", label: "Bash",       color: "#22c55e" },
  read:         { icon: "📄", label: "Read",        color: "#60a5fa" },
  write:        { icon: "✍️",  label: "Write",       color: "#f59e0b" },
  edit:         { icon: "✏️",  label: "Edit",        color: "#fb923c" },
  glob:         { icon: "🔍", label: "Glob",        color: "#a78bfa" },
  grep:         { icon: "🔎", label: "Grep",        color: "#c084fc" },
  "web-search": { icon: "🌐", label: "Web Search",  color: "#38bdf8" },
  "web-fetch":  { icon: "🔗", label: "Web Fetch",   color: "#67e8f9" },
  agent:        { icon: "🤖", label: "Agent",       color: "#f472b6" },
  "tool-search":{ icon: "🛠️", label: "Tool Search", color: "#94a3b8" },
  telegram:     { icon: "✈️",  label: "Telegram",    color: "#38bdf8" },
  cloudflare:   { icon: "☁️",  label: "Cloudflare",  color: "#f97316" },
  gmail:        { icon: "📧", label: "Gmail",       color: "#ef4444" },
  google:       { icon: "📅", label: "Google",      color: "#4ade80" },
  "mcp-generic":{ icon: "🔌", label: "MCP",         color: "#e879f9" },
  unknown:      { icon: "⚙️",  label: "Tool",        color: "#6b7280" },
}

export function charCount(x: unknown): number {
  return JSON.stringify(x)?.length ?? 0
}
