import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
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

export const AGL_MODEL_OPTIONS_BY_AGENT = {
  random: [
    { value: "pro", label: "Auto pro", modelClass: "pro" },
    { value: "fast", label: "Auto fast", modelClass: "fast" },
  ],
  codex: [
    { value: "gpt-5.5", label: "GPT-5.5", model: "gpt-5.5", modelClass: "pro" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 mini", model: "gpt-5.4-mini", modelClass: "fast" },
  ],
  claude: [
    { value: "sonnet", label: "Sonnet", model: "sonnet", modelClass: "pro" },
    { value: "haiku", label: "Haiku", model: "haiku", modelClass: "fast" },
  ],
  cursor: [
    { value: "composer-2.5-fast", label: "Composer 2.5 Fast", model: "composer-2.5-fast", modelClass: "fast" },
  ],
  gemini: [
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", model: "gemini-2.5-pro", modelClass: "pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", model: "gemini-2.5-flash", modelClass: "fast" },
  ],
  opencode: [
    { value: "opencode-go/kimi-k2.6", label: "Kimi K2.6", model: "opencode-go/kimi-k2.6", modelClass: "pro" },
    { value: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash", model: "opencode-go/deepseek-v4-flash", modelClass: "fast" },
  ],
  pi: [
    { value: "opencode-go/kimi-k2.6", label: "Kimi K2.6", model: "opencode-go/kimi-k2.6", modelClass: "pro" },
    { value: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash", model: "opencode-go/deepseek-v4-flash", modelClass: "fast" },
  ],
  pier: [
    { value: "pier-hybrid", label: "Pier Hybrid", model: "pier-hybrid", modelClass: "pro" },
    { value: "sarvam-30b", label: "Sarvam 30B", model: "sarvam-30b", modelClass: "fast" },
  ],
  droid: [
    { value: "claude-opus-4-8", label: "Claude Opus 4.8", model: "claude-opus-4-8", modelClass: "pro" },
    { value: "claude-opus-4-8-fast", label: "Claude Opus 4.8 Fast", model: "claude-opus-4-8-fast", modelClass: "fast" },
  ],
  antigravity: [
    { value: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)", model: "Gemini 3.5 Flash (Medium)", modelClass: "pro", useExtraModelArg: true },
    { value: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)", model: "Gemini 3.5 Flash (High)", modelClass: "pro", useExtraModelArg: true },
    { value: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)", model: "Gemini 3.5 Flash (Low)", modelClass: "fast", useExtraModelArg: true },
    { value: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)", model: "Gemini 3.1 Pro (High)", modelClass: "pro", useExtraModelArg: true },
    { value: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)", model: "Gemini 3.1 Pro (Low)", modelClass: "fast", useExtraModelArg: true },
    { value: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)", model: "Claude Sonnet 4.6 (Thinking)", modelClass: "pro", useExtraModelArg: true },
    { value: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)", model: "Claude Opus 4.6 (Thinking)", modelClass: "pro", useExtraModelArg: true },
    { value: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B (Medium)", model: "GPT-OSS 120B (Medium)", modelClass: "pro", useExtraModelArg: true },
  ],
  amp: [
    { value: "default", label: "Default", noModel: true, modelClass: "pro" },
  ],
  "worker-js": [
    { value: "default", label: "Worker JS", noModel: true, modelClass: "pro" },
  ],
}

const OPENCODE_FALLBACK_MODELS = [
  "opencode/big-pickle",
  "opencode/claude-fable-5",
  "opencode/claude-haiku-4-5",
  "opencode/claude-opus-4-1",
  "opencode/claude-opus-4-5",
  "opencode/claude-opus-4-6",
  "opencode/claude-opus-4-7",
  "opencode/claude-opus-4-8",
  "opencode/claude-sonnet-4",
  "opencode/claude-sonnet-4-5",
  "opencode/claude-sonnet-4-6",
  "opencode/claude-sonnet-5",
  "opencode/deepseek-v4-flash",
  "opencode/deepseek-v4-pro",
  "opencode/gemini-3-flash",
  "opencode/gemini-3.1-pro",
  "opencode/gemini-3.5-flash",
  "opencode/glm-5",
  "opencode/glm-5.1",
  "opencode/glm-5.2",
  "opencode/gpt-5",
  "opencode/gpt-5-codex",
  "opencode/gpt-5.1",
  "opencode/gpt-5.1-codex",
  "opencode/gpt-5.2",
  "opencode/gpt-5.3-codex",
  "opencode/gpt-5.4",
  "opencode/gpt-5.4-mini",
  "opencode/gpt-5.5",
  "opencode/grok-build-0.1",
  "opencode/kimi-k2.6",
  "opencode/kimi-k2.7-code",
  "opencode/minimax-m3",
  "opencode/qwen3.6-plus",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/kimi-k2.6",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m3",
  "opencode-go/qwen3.6-plus",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "mistral/codestral-latest",
  "mistral/mistral-large-latest",
  "mistral/mistral-medium-latest",
  "mistral/mistral-small-latest",
]

const AGENT_BINARIES = {
  aider: ["aider"],
  amazonq: ["q"],
  amp: ["amp"],
  antigravity: ["agy", "antigravity"],
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

let modelOptionsCache = null
let modelOptionsCacheAt = 0

function modelClassForModel(model) {
  const value = model.toLowerCase()
  return /flash|haiku|mini|nano|lite|fast|free|small/.test(value) ? "fast" : "pro"
}

function modelLabel(model) {
  return model
    .replace(/^opencode-go\//, "OpenCode Go / ")
    .replace(/^opencode\//, "OpenCode / ")
    .replace(/^google\//, "Google / ")
    .replace(/^mistral\//, "Mistral / ")
}

function modelOptionsFromLines(lines, extra = {}) {
  return [...new Set(lines.map(line => line.trim()).filter(Boolean))]
    .map(model => ({
      value: model,
      label: modelLabel(model),
      model,
      modelClass: modelClassForModel(model),
      ...extra,
    }))
}

function discoverModelLines(command, args, timeout = 4000) {
  if (!commandExists(command)) return null
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) return null
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

export function getModelOptionsByAgent() {
  const now = Date.now()
  if (modelOptionsCache && now - modelOptionsCacheAt < 60_000) return modelOptionsCache

  const options = { ...AGL_MODEL_OPTIONS_BY_AGENT }
  const opencodeLines = discoverModelLines("opencode", ["models"], 4000) ?? OPENCODE_FALLBACK_MODELS
  if (opencodeLines.length) {
    const opencodeOptions = modelOptionsFromLines(opencodeLines)
    options.opencode = opencodeOptions
    options.pi = opencodeOptions
  }

  modelOptionsCache = options
  modelOptionsCacheAt = now
  return options
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function agentExecutionEnv() {
  const home = homedir()
  const pathEntries = [
    join(home, ".local", "bin"),
    join(home, ".nvm", "versions", "node", "v22.22.0", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH ?? "",
  ].filter(Boolean)
  return {
    ...process.env,
    PATH: [...new Set(pathEntries.join(":").split(":").filter(Boolean))].join(":"),
  }
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

export function prepareAglChatRequest(request = {}) {
  const sessionContext = request.sessionContext && typeof request.sessionContext === "object"
    ? { ...request.sessionContext }
    : {}
  const requestedAgent = String(request.agent ?? "random")
  const resumeCurrentSession = request.resumeCurrentSession === true &&
    typeof sessionContext.sessionId === "string" &&
    canResumeSessionWithAgl(sessionContext.source, requestedAgent)
  const resumeAgent = resumeCurrentSession
    ? (aglAgentForSessionSource(sessionContext.source) ?? requestedAgent)
    : requestedAgent
  return {
    ...request,
    agent: resumeAgent,
    resume: resumeCurrentSession ? sessionContext.sessionId : request.resume,
    sessionContext,
    resumedSession: resumeCurrentSession,
  }
}

function commandExists(command) {
  return Boolean(commandPath(command))
}

function commandPath(command) {
  const script = `command -v ${JSON.stringify(command)} >/dev/null 2>&1`
  const pathScript = `command -v ${JSON.stringify(command)}`
  for (const [shell, args] of [
    ["/bin/sh", ["-lc", pathScript]],
    ["/bin/zsh", ["-lc", pathScript]],
    ["/bin/zsh", ["-lic", pathScript]],
  ]) {
    if (!existsSync(shell)) continue
    const result = spawnSync(shell, args, {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 64 * 1024,
    })
    if (result.status !== 0) continue
    const resolved = String(result.stdout ?? "").split(/\r?\n/).map(line => line.trim()).find(Boolean)
    if (resolved) return resolved
  }
  const result = spawnSync("/bin/sh", ["-lc", script], { stdio: "ignore" })
  return result.status === 0 ? command : null
}

export function resolveAglPath() {
  if (process.env.AGENT_SESSION_AGL_PATH) return process.env.AGENT_SESSION_AGL_PATH
  const aglPath = commandPath("agl")
  if (aglPath) return aglPath
  const agentLaunchPath = commandPath("agent-launch")
  if (agentLaunchPath) return agentLaunchPath
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
      model: "",
    },
    modelOptionsByAgent: getModelOptionsByAgent(),
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
  request = prepareAglChatRequest(request)
  const aglPath = resolveAglPath()
  if (!aglPath) {
    return { ok: false, error: "agl or agent-launch was not found on PATH", exitCode: 127 }
  }

  const agent = AGL_AGENTS.includes(request.agent) ? request.agent : "random"
  const mode = ["default", "ask", "plan", "auto", "danger"].includes(request.mode) ? request.mode : "ask"
  const modelClass = ["fast", "pro"].includes(request.modelClass) ? request.modelClass : "pro"
  const thinkingLevel = ["auto", "low", "medium", "high"].includes(request.thinkingLevel) ? request.thinkingLevel : "auto"
  const model = typeof request.model === "string" ? request.model.trim() : ""
  const useExtraModelArg = request.useExtraModelArg === true && agent === "antigravity"
  const timeoutSeconds = Math.max(5, Math.min(900, Number(request.timeoutSeconds) || 180))
  const cwd = typeof request.cwd === "string" && request.cwd.trim() ? request.cwd.trim() : process.cwd()
  const prompt = buildAgentPrompt(request)
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-session-agl-"))
  const promptFile = join(tmpDir, "prompt.txt")
  writeFileSync(promptFile, prompt, "utf8")

  const validExtraModel = useExtraModelArg &&
    model &&
    (getModelOptionsByAgent().antigravity ?? []).some(option => option.model === model)

  const modelArgs = request.noModel === true || validExtraModel
    ? ["--no-model"]
    : model
      ? ["--model", model]
      : ["--model-class", modelClass]

  const args = [
    "-n",
    "-a", agent,
    "-m", mode,
    ...modelArgs,
    "--thinking-level", thinkingLevel,
    "-C", cwd,
    "--attempt-timeout", String(timeoutSeconds),
    "--prompt-file", promptFile,
  ]
  if (validExtraModel) args.splice(args.length - 2, 0, "--extra", `--model ${shellSingleQuote(model)}`)
  if (request.resume) args.splice(args.length - 2, 0, "--resume", String(request.resume))

  try {
    const result = await execFilePromise(aglPath, args, {
      cwd: existsSync(cwd) ? cwd : process.cwd(),
      timeout: (timeoutSeconds + 20) * 1000,
      maxBuffer: 10 * 1024 * 1024,
      env: agentExecutionEnv(),
    })
    return {
      ok: result.code === 0,
      text: result.stdout.trim() || result.stderr.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code,
      provider: "local",
      agent,
      resumedSession: request.resumedSession,
      sessionId: request.resumedSession ? request.sessionContext?.sessionId : undefined,
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
