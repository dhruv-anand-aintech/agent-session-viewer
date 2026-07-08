import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execFile, spawnSync } from "child_process"

export const AGL_AGENTS = [
  "random",
  "codex",
  "claude",
  "cursor",
  "opencode",
  "gemini",
  "antigravity",
  "aider",
  "amazonq",
  "amp",
  "cline",
  "copilot",
  "crush",
  "droid",
  "goose",
  "grok",
  "kilo",
  "kimi",
  "kiro",
  "mimo",
  "openhands",
  "pi",
  "pier",
  "qwen",
  "trae",
]

const AGENT_BINARIES = {
  aider: ["aider"],
  amazonq: ["q"],
  amp: ["amp"],
  antigravity: ["antigravity"],
  claude: ["claude"],
  cline: ["cline"],
  codex: ["codex"],
  copilot: ["gh", "copilot"],
  crush: ["crush"],
  cursor: ["cursor-agent", "cursor"],
  droid: ["droid"],
  gemini: ["gemini"],
  goose: ["goose"],
  grok: ["grok"],
  kilo: ["kilo"],
  kimi: ["kimi"],
  kiro: ["kiro"],
  mimo: ["mimo"],
  opencode: ["opencode"],
  openhands: ["openhands"],
  pi: ["pi"],
  pier: ["pier"],
  qwen: ["qwen"],
  trae: ["trae"],
}

const SESSION_SOURCE_TO_AGL_AGENT = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
  gemini: "gemini",
  antigravity: "antigravity",
  "antigravity-cli": "antigravity",
}

export function aglAgentForSessionSource(source) {
  return SESSION_SOURCE_TO_AGL_AGENT[String(source ?? "").toLowerCase()] ?? null
}

export function canResumeSessionWithAgl(source, agent) {
  const sessionAgent = aglAgentForSessionSource(source)
  if (!sessionAgent) return false
  return agent === sessionAgent || agent === "random"
}

function commandExists(command) {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
    stdio: "ignore",
  })
  return result.status === 0
}

export function resolveAglPath() {
  if (process.env.AGENT_SESSION_AGL_PATH) return process.env.AGENT_SESSION_AGL_PATH
  if (commandExists("agl")) return "agl"
  if (commandExists("agent-launch")) return "agent-launch"
  return null
}

export function listInstalledAglAgents() {
  const installed = []
  for (const agent of AGL_AGENTS) {
    if (agent === "random") continue
    const binaries = AGENT_BINARIES[agent] ?? [agent]
    if (binaries.some(commandExists)) installed.push(agent)
  }
  return installed
}

export function getAgentProviders() {
  const aglPath = resolveAglPath()
  const installedAgents = listInstalledAglAgents()
  const providers = [
    {
      id: "local",
      label: "Local agl",
      kind: "local",
      status: aglPath ? "available" : "missing",
      agents: ["random", ...installedAgents],
      detail: aglPath ? `using ${aglPath}` : "agl or agent-launch was not found on PATH",
    },
  ]

  const configured = parseConfiguredProviders(process.env.AGENT_SESSION_AGENT_PROVIDERS_JSON)
  for (const provider of configured) providers.push(provider)

  return {
    providers,
    defaults: {
      provider: "local",
      agent: installedAgents.includes("codex") ? "codex" : "random",
      mode: "ask",
      modelClass: "pro",
    },
  }
}

export function parseConfiguredProviders(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const providers = Array.isArray(parsed) ? parsed : parsed.providers
    if (!Array.isArray(providers)) return []
    return providers
      .map(provider => ({
        id: String(provider.id ?? "").trim(),
        label: String(provider.label ?? provider.id ?? "").trim(),
        kind: String(provider.kind ?? "cloud-http"),
        status: String(provider.status ?? "available"),
        agents: Array.isArray(provider.agents) ? provider.agents.map(String) : ["random"],
        detail: provider.detail ? String(provider.detail) : undefined,
        endpoint: provider.endpoint ? String(provider.endpoint) : undefined,
      }))
      .filter(provider => provider.id && provider.label)
  } catch {
    return []
  }
}

function contentText(content) {
  if (!content) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(block => {
    if (block?.type === "text") return block.text ?? ""
    if (block?.type === "thinking") return block.thinking ?? ""
    if (block?.type === "tool_use") return `[tool_use ${block.name ?? ""}]`
    if (block?.type === "tool_result") return "[tool_result]"
    return `[${block?.type ?? "block"}]`
  }).filter(Boolean).join("\n")
}

export function summarizeTranscript(messages, maxMessages = 80, maxChars = 18000) {
  const usable = Array.isArray(messages) ? messages.filter(msg => msg?.message?.role || msg?.type) : []
  const recent = usable.slice(-maxMessages)
  const lines = []
  let chars = 0
  for (const msg of recent) {
    const role = msg.message?.role ?? msg.type ?? "message"
    const text = contentText(msg.message?.content).trim()
    if (!text) continue
    const clipped = text.length > 1600 ? `${text.slice(0, 1600)}\n[truncated]` : text
    const line = `${role.toUpperCase()} ${msg.timestamp ?? ""}\n${clipped}`
    chars += line.length
    lines.push(line)
    while (chars > maxChars && lines.length > 1) {
      const removed = lines.shift()
      chars -= removed?.length ?? 0
    }
  }
  return lines.join("\n\n---\n\n")
}

export function buildAgentPrompt({ userPrompt, prompt, conversation, sessionContext }) {
  const turns = Array.isArray(conversation) ? conversation.slice(-12) : []
  const transcript = summarizeTranscript(sessionContext?.messages ?? [])
  const sessionLines = [
    `Project: ${sessionContext?.projectPath ?? "unknown"}`,
    `Session ID: ${sessionContext?.sessionId ?? "unknown"}`,
    `Source: ${sessionContext?.source ?? "unknown"}`,
    sessionContext?.cwd ? `Working directory: ${sessionContext.cwd}` : null,
  ].filter(Boolean).join("\n")
  const chat = turns.map(turn => `${String(turn.role ?? "user").toUpperCase()}: ${String(turn.content ?? "").trim()}`).join("\n\n")

  return [
    "You are helping continue work from an existing coding-agent transcript.",
    "Use the transcript as context, but answer the user's latest message directly.",
    "Do not expose implementation details about agl unless the user asks.",
    "",
    "SESSION",
    sessionLines,
    "",
    transcript ? `RECENT TRANSCRIPT\n${transcript}` : "RECENT TRANSCRIPT\nNo transcript messages were supplied.",
    "",
    chat ? `CHAT SO FAR\n${chat}` : null,
    "",
    "USER MESSAGE",
    String(userPrompt ?? prompt ?? "").trim(),
  ].filter(Boolean).join("\n")
}

export async function runLocalAglChat(request) {
  const aglPath = resolveAglPath()
  if (!aglPath) {
    return { ok: false, error: "agl or agent-launch was not found on PATH", exitCode: 127 }
  }

  const agent = AGL_AGENTS.includes(request.agent) ? request.agent : "random"
  const mode = ["default", "ask", "plan", "auto", "danger"].includes(request.mode) ? request.mode : "ask"
  const modelClass = ["fast", "pro"].includes(request.modelClass) ? request.modelClass : "pro"
  const timeoutSeconds = Math.max(5, Math.min(900, Number(request.timeoutSeconds) || 180))
  const cwd = typeof request.cwd === "string" && request.cwd.trim() ? request.cwd.trim() : process.cwd()
  const prompt = buildAgentPrompt(request)
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-session-agl-"))
  const promptFile = join(tmpDir, "prompt.txt")
  writeFileSync(promptFile, prompt, "utf8")

  const args = [
    "-n",
    "-a", agent,
    "-m", mode,
    "--model-class", modelClass,
    "-C", cwd,
    "--attempt-timeout", String(timeoutSeconds),
    "--prompt-file", promptFile,
  ]
  if (request.resume) args.splice(args.length - 2, 0, "--resume", String(request.resume))

  try {
    const result = await execFilePromise(aglPath, args, {
      cwd: existsSync(cwd) ? cwd : process.cwd(),
      timeout: (timeoutSeconds + 20) * 1000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    })
    return {
      ok: result.code === 0,
      text: result.stdout.trim() || result.stderr.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code,
      provider: "local",
      agent,
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function execFilePromise(file, args, options) {
  return new Promise(resolve => {
    execFile(file, args, options, (error, stdout = "", stderr = "") => {
      resolve({
        code: typeof error?.code === "number" ? error.code : (error ? 1 : 0),
        stdout,
        stderr,
      })
    })
  })
}
