import { useEffect, useMemo, useRef, useState } from "react"
import { Bot, Loader2, Plus, RefreshCw, Sparkles, X } from "lucide-react"
import {
  AgenticComposer,
  AgenticMarkdown,
  useAgenticComposerQueue,
} from "@ainorthstar/agentic-ai-bar/react"
import type { AgenticMentionOption, AgenticModelOption } from "@ainorthstar/agentic-ai-bar"
import "@ainorthstar/agentic-ai-bar/react.css"
import type { SessionMessage, SessionMeta } from "./types"

type ModelOption = {
  value: string
  label: string
  model?: string
  modelClass?: "fast" | "pro"
  noModel?: boolean
}

type ProviderResponse = {
  modelOptionsByAgent?: Record<string, ModelOption[]>
  transcriptLocations?: string[]
  codexAuth?: {
    kind?: "chatgpt" | "api-key" | "unknown"
    authenticated?: boolean
    label?: string
  }
}

type ChatTurn = { role: "user" | "assistant"; content: string; provider?: string; agent?: string }
type AgentThread = { id: string; title: string; turns: ChatTurn[]; updatedAt: string }

const THREADS_KEY = "asv-agentic-transcript-threads-v1"
const FALLBACK_MODELS: ModelOption[] = [
  { value: "gpt-5.6", label: "GPT-5.6", model: "gpt-5.6", modelClass: "pro" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", model: "gpt-5.6-luna", modelClass: "fast" },
]

function makeThread(title = "Transcript question"): AgentThread {
  return { id: crypto.randomUUID(), title, turns: [], updatedAt: new Date().toISOString() }
}

function loadThreads(): AgentThread[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(THREADS_KEY) ?? "[]")
    if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, 20)
  } catch { /* start clean */ }
  return [makeThread()]
}

function directoryLabel(path: string): string {
  const compact = path.replace(/^\/Users\/dhruvanand(?=\/)/, "~")
  return compact.length > 54 ? `${compact.slice(0, 24)}…${compact.slice(-27)}` : compact
}

function messageDirectory(message: SessionMessage): string | null {
  const candidates = [message.cwd, message.data?.cwd, message.data?.workspacePath, message.data?.directory, message.data?.projectPath]
  return candidates.find(value => typeof value === "string" && value.startsWith("/")) as string | undefined ?? null
}

export function AgentConsole({
  projectPath,
  sessionMeta,
  cwd,
  messages,
  commonDirectories,
  onTranscriptUpdated,
  onClose,
}: {
  projectPath: string
  sessionMeta: SessionMeta
  cwd: string | null
  messages: SessionMessage[]
  commonDirectories?: string[]
  onTranscriptUpdated: () => Promise<boolean>
  onClose: () => void
}) {
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(FALLBACK_MODELS)
  const [modelChoice, setModelChoice] = useState(FALLBACK_MODELS[0].value)
  const [selectedCwd, setSelectedCwd] = useState(cwd ?? "")
  const [transcriptLocations, setTranscriptLocations] = useState<string[]>([])
  const [codexAuth, setCodexAuth] = useState<ProviderResponse["codexAuth"]>()
  const [threads, setThreads] = useState<AgentThread[]>(loadThreads)
  const [activeThreadId, setActiveThreadId] = useState(() => threads[0]?.id ?? "")
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [workingLabel, setWorkingLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const activeThread = threads.find(thread => thread.id === activeThreadId) ?? threads[0]
  const selectedRawModel = modelOptions.find(option => option.value === modelChoice) ?? modelOptions[0] ?? FALLBACK_MODELS[0]
  const models = useMemo<AgenticModelOption[]>(() => modelOptions.map(option => ({
    id: option.value,
    label: option.label,
    provider: "codex",
  })), [modelOptions])
  const selectedModel = models.find(option => option.id === selectedRawModel.value) ?? models[0]

  const directoryOptions = useMemo(() => {
    const dirs = new Set<string>()
    if (cwd) dirs.add(cwd)
    commonDirectories?.forEach(dir => dirs.add(dir))
    messages.forEach(message => { const dir = messageDirectory(message); if (dir) dirs.add(dir) })
    return [...dirs].slice(0, 30)
  }, [commonDirectories, cwd, messages])

  const transcriptMentions = useMemo<AgenticMentionOption[]>(() => transcriptLocations.map((location, index) => ({
    id: `transcript-${index}`,
    label: directoryLabel(location),
    kind: "source",
    aliases: ["transcript", "chat", location.split("/").filter(Boolean).at(-1) ?? ""],
    description: `Read-only transcript source: ${location}`,
    metadata: { path: location, access: "read-only" },
  })), [transcriptLocations])

  useEffect(() => {
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(0, 20)))
  }, [threads])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/agent/providers", { credentials: "include", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Codex lookup failed (${response.status})`)
        return response.json() as Promise<ProviderResponse>
      })
      .then(data => {
        const codexModels = data.modelOptionsByAgent?.codex
        if (codexModels?.length) {
          setModelOptions(codexModels)
          setModelChoice(current => codexModels.some(option => option.value === current) ? current : codexModels[0].value)
        }
        setTranscriptLocations(data.transcriptLocations ?? [])
        setCodexAuth(data.codexAuth)
      })
      .catch(err => { if (err.name !== "AbortError") setError(err instanceof Error ? err.message : String(err)) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!selectedCwd || (cwd && !directoryOptions.includes(selectedCwd))) setSelectedCwd(cwd ?? directoryOptions[0] ?? "")
  }, [cwd, directoryOptions, selectedCwd])

  function updateThread(threadId: string, updater: (thread: AgentThread) => AgentThread) {
    setThreads(current => current.map(thread => thread.id === threadId ? updater(thread) : thread))
  }

  function addAssistantTurn(threadId: string, content: string, agent = "codex") {
    updateThread(threadId, thread => ({
      ...thread,
      turns: [...thread.turns, { role: "assistant", content, provider: "local", agent }],
      updatedAt: new Date().toISOString(),
    }))
  }

  async function submitText(text: string) {
    const trimmed = text.trim()
    if (!trimmed || sending || !activeThread) return
    const threadId = activeThread.id
    const userTurn: ChatTurn = { role: "user", content: trimmed }
    const conversation = [...activeThread.turns, userTurn]
    updateThread(threadId, thread => ({
      ...thread,
      title: thread.turns.length ? thread.title : trimmed.slice(0, 54),
      turns: conversation,
      updatedAt: new Date().toISOString(),
    }))
    setSending(true)
    setWorkingLabel("Codex is inspecting live context…")
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "local",
          agent: "codex",
          mode: "auto",
          modelClass: selectedRawModel.modelClass ?? "pro",
          model: selectedRawModel.model,
          thinkingLevel: "auto",
          noModel: selectedRawModel.noModel,
          cwd: selectedCwd || cwd || undefined,
          prompt: trimmed,
          conversation,
          resumeCurrentSession: false,
          sessionContext: {
            projectPath,
            sessionId: sessionMeta.id,
            source: sessionMeta.source ?? "claude",
            cwd: selectedCwd || cwd || undefined,
            messages: messages.slice(-100),
            transcriptScope: "all",
          },
        }),
      })
      const data = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string; agent?: string }
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `Codex request failed (${response.status})`)
      addAssistantTurn(threadId, data.text ?? "No response text returned.", data.agent)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : String(err))
    } finally {
      abortRef.current = null
      setWorkingLabel(null)
      setSending(false)
    }
  }

  const queue = useAgenticComposerQueue({
    busy: sending,
    draft,
    setDraft,
    submit: submitText,
    interrupt: () => abortRef.current?.abort(),
  })

  async function runLiveSummary() {
    if (sending || !activeThread) return
    const threadId = activeThread.id
    setSending(true)
    setWorkingLabel("Codex is reading recent transcripts…")
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const response = await fetch("/api/agent/summary", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "local",
          agent: "codex",
          modelClass: selectedRawModel.modelClass ?? "pro",
          model: selectedRawModel.model,
          thinkingLevel: "low",
          cwd: selectedCwd || cwd || undefined,
        }),
      })
      const data = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string; agent?: string; chatsCount?: number }
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `Live update failed (${response.status})`)
      addAssistantTurn(threadId, data.text ?? "No live update was returned.", data.agent)
      updateThread(threadId, thread => ({ ...thread, title: `Live update · ${data.chatsCount ?? "recent"} chats` }))
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : String(err))
    } finally {
      abortRef.current = null
      setWorkingLabel(null)
      setSending(false)
    }
  }

  function newThread() {
    const thread = makeThread()
    setThreads(current => [thread, ...current].slice(0, 20))
    setActiveThreadId(thread.id)
    setDraft("")
    setError(null)
  }

  const authLabel = codexAuth?.kind === "chatgpt"
    ? "ChatGPT subscription"
    : codexAuth?.kind === "api-key"
      ? "API key"
      : "Codex CLI"

  return (
    <section className="agent-console agentic-asv-shell" aria-label="Codex transcript agent">
      <header className="agent-console-toolbar">
        <div className="agent-console-title">
          <Bot size={16} aria-hidden="true" />
          <span>Codex</span>
          <span className="agent-console-context">{authLabel} · {transcriptLocations.length || "all"} transcript sources</span>
        </div>
        <div className="agent-console-controls">
          <button className="agent-live-summary-btn" type="button" onClick={() => void runLiveSummary()} disabled={sending}>
            {workingLabel?.startsWith("Codex is reading") ? <Loader2 size={15} className="spin-icon" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
            Live update
          </button>
          {directoryOptions.length > 1 ? (
            <select className="agent-directory-select" value={selectedCwd} onChange={event => setSelectedCwd(event.target.value)} aria-label="Working directory">
              {directoryOptions.map(dir => <option key={dir} value={dir}>{directoryLabel(dir)}</option>)}
            </select>
          ) : null}
          <button className="agent-icon-btn" type="button" onClick={newThread} disabled={sending} title="New chat" aria-label="New chat">
            <Plus size={14} aria-hidden="true" />
          </button>
          <button className="agent-icon-btn" type="button" onClick={() => void onTranscriptUpdated()} title="Refresh transcript context" aria-label="Refresh transcript context">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button className="agent-icon-btn agent-close-btn" type="button" onClick={onClose} title="Close Codex" aria-label="Close Codex">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error ? <div className="agent-console-error" role="alert">{error}</div> : null}

      <div className="agent-workspace">
        <div className="agent-chat-column">
          <div className="agent-chat-log" aria-live="polite">
            {activeThread?.turns.length ? activeThread.turns.map((turn, index) => (
              <article key={`${activeThread.id}-${index}`} className={`agent-chat-turn agent-chat-turn--${turn.role}`}>
                <div className="agent-chat-role">{turn.role === "assistant" ? "codex" : "you"}</div>
                {turn.role === "assistant"
                  ? <AgenticMarkdown text={turn.content} className="agent-chat-text" />
                  : <div className="agent-chat-text">{turn.content}</div>}
              </article>
            )) : (
              <div className="agent-chat-empty">
                Ask Codex to search any transcript, inspect this repo, or check current processes and commands. Transcript sources stay read-only.
              </div>
            )}
            {workingLabel ? (
              <div className="agent-working" role="status">
                <Loader2 size={14} className="spin-icon" aria-hidden="true" />
                {workingLabel}
              </div>
            ) : null}
          </div>
          <div className="agent-composer-wrap">
            <AgenticComposer
              value={draft}
              busy={sending}
              models={models}
              selectedModel={selectedModel}
              onModelChange={model => setModelChoice(model.id)}
              onChange={setDraft}
              onSubmit={queue.submitCurrent}
              onInterrupt={() => abortRef.current?.abort()}
              onQueue={queue.queueCurrent}
              queuedMessages={queue.queuedMessages}
              onQueuedMessagesReorder={queue.setQueuedMessages}
              onQueuedMessageSteer={queue.steerQueuedMessage}
              onQueuedMessageRemove={queue.removeQueuedMessage}
              mentionOptions={transcriptMentions}
              placeholder="Ask Codex about transcripts, code, or live processes…"
              submitLabel="Ask"
              stopLabel="Stop"
              queueLabel="Queue"
            />
          </div>
        </div>
      </div>
    </section>
  )
}
