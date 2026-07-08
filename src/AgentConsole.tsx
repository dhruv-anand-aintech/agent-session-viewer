import { useEffect, useMemo, useState } from "react"
import { Bot, Loader2, RefreshCw, Send, SquarePen } from "lucide-react"
import type { SessionMessage, SessionMeta } from "./types"

type Provider = {
  id: string
  label: string
  kind: string
  status: "available" | "missing" | string
  agents: string[]
  detail?: string
}

type ProviderResponse = {
  providers: Provider[]
  defaults: {
    provider: string
    agent: string
    mode: string
    modelClass: string
    model?: string
  }
  modelOptionsByAgent?: Record<string, ModelOption[]>
}

type ChatTurn = {
  role: "user" | "assistant"
  content: string
  provider?: string
  agent?: string
}

type ModelOption = {
  value: string
  label: string
  model?: string
  modelClass?: "fast" | "pro"
  noModel?: boolean
  useExtraModelArg?: boolean
}

const DEFAULT_MODEL_OPTIONS_BY_AGENT: Record<string, ModelOption[]> = {
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
  antigravity: [{ value: "default", label: "Default", noModel: true, modelClass: "pro" }],
  amp: [{ value: "default", label: "Default", noModel: true, modelClass: "pro" }],
  "worker-js": [{ value: "default", label: "Worker JS", noModel: true, modelClass: "pro" }],
}

const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { value: "pro", label: "Pro", modelClass: "pro" },
  { value: "fast", label: "Fast", modelClass: "fast" },
]

const THINKING_LEVELS = ["auto", "low", "medium", "high"]

const SESSION_SOURCE_TO_AGL_AGENT: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
  gemini: "gemini",
  antigravity: "antigravity",
  "antigravity-cli": "antigravity",
}

function agentForSessionSource(source?: string): string | null {
  return SESSION_SOURCE_TO_AGL_AGENT[String(source ?? "").toLowerCase()] ?? null
}

function messagePreview(content: string): string {
  return content.length > 3600 ? `${content.slice(0, 3600)}\n[truncated]` : content
}

function valueFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === "string" && raw.trim() ? raw.trim() : null
}

function messageDirectory(message: SessionMessage): string | null {
  const direct =
    message.cwd ??
    valueFromRecord(message, "workspacePath") ??
    valueFromRecord(message, "directory") ??
    valueFromRecord(message, "projectPath") ??
    valueFromRecord(message.data, "cwd") ??
    valueFromRecord(message.data, "workspacePath") ??
    valueFromRecord(message.data, "directory") ??
    valueFromRecord(message.data, "projectPath")
  return direct?.startsWith("/") ? direct : null
}

function directoryLabel(path: string): string {
  const home = "/Users/dhruvanand"
  const compact = path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
  if (compact.length <= 44) return compact
  const parts = compact.split("/").filter(Boolean)
  if (parts.length < 4) return compact.slice(0, 41) + "..."
  return `${compact.startsWith("/") ? "/" : ""}${parts.slice(0, 2).join("/")}/.../${parts.slice(-2).join("/")}`
}

export function AgentConsole({
  projectPath,
  sessionMeta,
  cwd,
  messages,
  commonDirectories,
  onTranscriptUpdated,
}: {
  projectPath: string
  sessionMeta: SessionMeta
  cwd: string | null
  messages: SessionMessage[]
  commonDirectories?: string[]
  onTranscriptUpdated: () => Promise<boolean>
}) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [provider, setProvider] = useState("local")
  const [agent, setAgent] = useState("random")
  const [mode, setMode] = useState("ask")
  const [modelClass, setModelClass] = useState("pro")
  const [modelChoice, setModelChoice] = useState("pro")
  const [thinkingLevel, setThinkingLevel] = useState("auto")
  const [modelOptionsByAgent, setModelOptionsByAgent] = useState(DEFAULT_MODEL_OPTIONS_BY_AGENT)
  const [selectedCwd, setSelectedCwd] = useState(cwd ?? "")
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [prompt, setPrompt] = useState("")
  const [loadingProviders, setLoadingProviders] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [transcriptStatus, setTranscriptStatus] = useState<string | null>(null)

  const activeProvider = providers.find(entry => entry.id === provider)
  const agentOptions = activeProvider?.agents?.length ? activeProvider.agents : ["random"]
  const modelOptions = modelOptionsByAgent[agent] ?? FALLBACK_MODEL_OPTIONS
  const selectedModelOption = modelOptions.find(entry => entry.value === modelChoice) ?? modelOptions[0] ?? FALLBACK_MODEL_OPTIONS[0]
  const directoryOptions = useMemo(() => {
    const scored = new Map<string, number>()
    const add = (dir: string | null | undefined, score: number) => {
      if (!dir?.startsWith("/")) return
      scored.set(dir, (scored.get(dir) ?? 0) + score)
    }
    add(cwd, 10000)
    for (const dir of commonDirectories ?? []) add(dir, 20)
    messages.forEach((message, index) => add(messageDirectory(message), 100 + index / Math.max(1, messages.length)))
    return [...scored.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([dir]) => dir)
  }, [commonDirectories, cwd, messages])
  const contextMessages = useMemo(() => messages.slice(-100), [messages])
  const sessionAgent = agentForSessionSource(sessionMeta.source)
  const resumeCurrentSession = provider === "local" && !!sessionAgent && (agent === sessionAgent || agent === "random")

  async function loadProviders() {
    setLoadingProviders(true)
    setError(null)
    try {
      const response = await fetch("/api/agent/providers", { credentials: "include" })
      if (!response.ok) throw new Error(`Provider lookup failed (${response.status})`)
      const data = await response.json() as ProviderResponse
      setProviders(data.providers ?? [])
      setProvider(data.defaults?.provider ?? "local")
      setAgent(data.defaults?.agent ?? "random")
      setMode(data.defaults?.mode ?? "ask")
      setModelClass(data.defaults?.modelClass ?? "pro")
      setModelChoice(data.defaults?.model || data.defaults?.modelClass || "pro")
      setModelOptionsByAgent({ ...DEFAULT_MODEL_OPTIONS_BY_AGENT, ...(data.modelOptionsByAgent ?? {}) })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingProviders(false)
    }
  }

  useEffect(() => {
    void loadProviders()
  }, [])

  useEffect(() => {
    if (!agentOptions.includes(agent)) setAgent(agentOptions[0] ?? "random")
  }, [agent, agentOptions])

  useEffect(() => {
    if (modelOptions.some(entry => entry.value === modelChoice)) return
    const next = modelOptions[0] ?? FALLBACK_MODEL_OPTIONS[0]
    setModelChoice(next.value)
    setModelClass(next.modelClass ?? "pro")
  }, [modelChoice, modelOptions])

  useEffect(() => {
    if (!selectedCwd || (cwd && !directoryOptions.includes(selectedCwd))) {
      setSelectedCwd(cwd ?? directoryOptions[0] ?? "")
    }
  }, [cwd, directoryOptions, selectedCwd])

  useEffect(() => {
    setTurns([])
    setPrompt("")
    setError(null)
    setTranscriptStatus(null)
  }, [sessionMeta.id, projectPath])

  async function sendMessage() {
    const trimmed = prompt.trim()
    if (!trimmed || sending) return

    const userTurn: ChatTurn = { role: "user", content: trimmed }
    const nextTurns = [...turns, userTurn]
    setTurns(nextTurns)
    setPrompt("")
    setSending(true)
    setError(null)
    const activeCwd = selectedCwd.trim() || cwd || undefined

    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          agent,
          mode,
          modelClass: selectedModelOption.modelClass ?? modelClass,
          model: selectedModelOption.model,
          thinkingLevel,
          noModel: selectedModelOption.noModel,
          useExtraModelArg: selectedModelOption.useExtraModelArg,
          cwd: activeCwd,
          prompt: trimmed,
          conversation: nextTurns,
          resumeCurrentSession,
          sessionContext: {
            projectPath,
            sessionId: sessionMeta.id,
            source: sessionMeta.source ?? "claude",
            cwd: activeCwd,
            messages: contextMessages,
          },
        }),
      })
      const data = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string; provider?: string; agent?: string; resumedSession?: boolean }
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `Agent request failed (${response.status})`)
      if (data.resumedSession) {
        const refreshed = await onTranscriptUpdated()
        setTurns([])
        setTranscriptStatus(refreshed
          ? `Updated current ${data.agent ?? agent} transcript.`
          : `Agent finished, but transcript refresh did not return new data.`)
        return
      }
      setTurns(current => [
        ...current,
        {
          role: "assistant",
          content: data.text?.trim() || "(no output)",
          provider: data.provider ?? provider,
          agent: data.agent ?? agent,
        },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setTurns(current => current.filter(turn => turn !== userTurn))
      setPrompt(trimmed)
      setTranscriptStatus(null)
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="agent-console" aria-label="Agent console">
      <div className="agent-console-toolbar">
        <div className="agent-console-title">
          <Bot size={16} aria-hidden="true" />
          <span>Agent Console</span>
          <span className="agent-console-context">{sessionMeta.source ?? "claude"}:{sessionMeta.id.slice(0, 8)}</span>
        </div>
        <div className="agent-console-controls">
          <select value={provider} onChange={event => setProvider(event.target.value)} aria-label="Provider">
            {providers.map(entry => (
              <option key={entry.id} value={entry.id} disabled={entry.status === "missing"}>
                {entry.label}{entry.status === "missing" ? " (missing)" : ""}
              </option>
            ))}
          </select>
          <select value={agent} onChange={event => setAgent(event.target.value)} aria-label="Agent">
            {agentOptions.map(entry => <option key={entry} value={entry}>{entry}</option>)}
          </select>
          <select value={mode} onChange={event => setMode(event.target.value)} aria-label="Mode">
            {["ask", "plan", "auto", "danger", "default"].map(entry => <option key={entry} value={entry}>{entry}</option>)}
          </select>
          <select
            value={selectedCwd}
            onChange={event => setSelectedCwd(event.target.value)}
            aria-label="Directory"
            className="agent-directory-select"
          >
            {directoryOptions.length
              ? directoryOptions.map(entry => <option key={entry} value={entry}>{directoryLabel(entry)}</option>)
              : <option value="">No directory</option>}
          </select>
          <select
            value={modelChoice}
            onChange={event => {
              const option = modelOptions.find(entry => entry.value === event.target.value) ?? modelOptions[0] ?? FALLBACK_MODEL_OPTIONS[0]
              setModelChoice(option.value)
              setModelClass(option.modelClass ?? "pro")
            }}
            aria-label="Model"
          >
            {modelOptions.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
          <select value={thinkingLevel} onChange={event => setThinkingLevel(event.target.value)} aria-label="Thinking level">
            {THINKING_LEVELS.map(entry => <option key={entry} value={entry}>Thinking {entry}</option>)}
          </select>
          <button type="button" className="agent-icon-btn" onClick={() => void loadProviders()} disabled={loadingProviders} title="Refresh providers" aria-label="Refresh providers">
            <RefreshCw size={15} className={loadingProviders ? "spin-icon" : undefined} aria-hidden="true" />
          </button>
          <button type="button" className="agent-icon-btn" onClick={() => setTurns([])} disabled={sending || turns.length === 0} title="New chat" aria-label="New chat">
            <SquarePen size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {activeProvider?.detail && <div className="agent-provider-detail">{activeProvider.detail}</div>}
      {resumeCurrentSession && <div className="agent-transcript-status">Messages will resume this open {sessionMeta.source ?? "agent"} session and refresh the transcript view.</div>}
      {!resumeCurrentSession && sessionAgent && provider === "local" && (
        <div className="agent-transcript-status">Selected agent will start a separate session with this transcript as context.</div>
      )}
      {transcriptStatus && <div className="agent-transcript-status">{transcriptStatus}</div>}
      {error && <div className="agent-console-error">{error}</div>}

      <div className="agent-chat-log">
        {turns.length === 0 ? (
          <div className="agent-chat-empty">Ask about this session, continue implementation, or hand off the current thread to another coding agent.</div>
        ) : (
          turns.map((turn, index) => (
            <div key={`${turn.role}-${index}`} className={`agent-chat-turn agent-chat-turn--${turn.role}`}>
              <div className="agent-chat-role">
                {turn.role === "user" ? "D" : `${turn.agent ?? agent} via ${turn.provider ?? provider}`}
              </div>
              <div className="agent-chat-text">{messagePreview(turn.content)}</div>
            </div>
          ))
        )}
        {sending && (
          <div className="agent-chat-turn agent-chat-turn--assistant">
            <div className="agent-chat-role"><Loader2 size={14} className="spin-icon" aria-hidden="true" /> running</div>
            <div className="agent-chat-text muted">Waiting for the selected agent.</div>
          </div>
        )}
      </div>

      <form className="agent-chat-input-row" onSubmit={event => { event.preventDefault(); void sendMessage() }}>
        <textarea
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void sendMessage()
            }
          }}
          placeholder="Message the selected agent with this session as context"
          aria-label="Agent message"
        />
        <button type="submit" className="agent-send-btn" disabled={sending || !prompt.trim()} title="Send" aria-label="Send">
          {sending ? <Loader2 size={16} className="spin-icon" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        </button>
      </form>
    </section>
  )
}
