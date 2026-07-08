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
  }
}

type ChatTurn = {
  role: "user" | "assistant"
  content: string
  provider?: string
  agent?: string
}

function messagePreview(content: string): string {
  return content.length > 3600 ? `${content.slice(0, 3600)}\n[truncated]` : content
}

export function AgentConsole({
  projectPath,
  sessionMeta,
  cwd,
  messages,
}: {
  projectPath: string
  sessionMeta: SessionMeta
  cwd: string | null
  messages: SessionMessage[]
}) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [provider, setProvider] = useState("local")
  const [agent, setAgent] = useState("random")
  const [mode, setMode] = useState("ask")
  const [modelClass, setModelClass] = useState("pro")
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [prompt, setPrompt] = useState("")
  const [loadingProviders, setLoadingProviders] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeProvider = providers.find(entry => entry.id === provider)
  const agentOptions = activeProvider?.agents?.length ? activeProvider.agents : ["random"]
  const contextMessages = useMemo(() => messages.slice(-100), [messages])

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
    setTurns([])
    setPrompt("")
    setError(null)
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

    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          agent,
          mode,
          modelClass,
          prompt: trimmed,
          conversation: nextTurns,
          sessionContext: {
            projectPath,
            sessionId: sessionMeta.id,
            source: sessionMeta.source ?? "claude",
            cwd,
            messages: contextMessages,
          },
        }),
      })
      const data = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string; provider?: string; agent?: string }
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `Agent request failed (${response.status})`)
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
          <select value={modelClass} onChange={event => setModelClass(event.target.value)} aria-label="Model class">
            {["pro", "fast"].map(entry => <option key={entry} value={entry}>{entry}</option>)}
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
