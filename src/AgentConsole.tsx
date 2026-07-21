import { useEffect, useMemo, useRef, useState } from "react"
import { Bot, Loader2, RefreshCw, Sparkles, X } from "lucide-react"
import {
  AgenticComposer,
  AgenticMarkdown,
  AgenticSessionList,
  AgenticStageTimeline,
  AgenticThreadSidebar,
  AgenticTracePanel,
  useAgenticComposerQueue,
} from "@ainorthstar/agentic-ai-bar/react"
import { streamSse, type AgenticMentionOption, type AgenticModelOption } from "@ainorthstar/agentic-ai-bar"
import "@ainorthstar/agentic-ai-bar/react.css"
import type { SessionMessage, SessionMeta } from "./types"

type Provider = {
  id: string
  label: string
  kind: string
  status: "available" | "missing" | string
  agents: string[]
  detail?: string
}

type ModelOption = {
  value: string
  label: string
  model?: string
  modelClass?: "fast" | "pro"
  noModel?: boolean
  useExtraModelArg?: boolean
}

type ProviderResponse = {
  providers: Provider[]
  defaults: { provider: string; agent: string; mode: string; modelClass: string; model?: string }
  modelOptionsByAgent?: Record<string, ModelOption[]>
  transcriptLocations?: string[]
}

type ChatTurn = { role: "user" | "assistant"; content: string; provider?: string; agent?: string }
type AgentThread = { id: string; title: string; turns: ChatTurn[]; updatedAt: string }
type PlanItem = { id: string; label: string; status: "idle" | "running" | "complete" | "failed" }
type SessionPlan = {
  sessionId: string
  source: string
  title: string
  timestamp?: string | null
  lastActivity?: string | null
  items: PlanItem[]
}
type LiveSessionPreview = {
  sessionId: string
  projectPath: string
  source: string
  title: string
  lastActivity?: string | null
  latestUser: string
  assistantTail: string
}
type SummaryMetrics = { chatsCount?: number; collectionMs?: number; firstTokenMs?: number; generationMs?: number; model?: string }

const THREADS_KEY = "asv-agentic-transcript-threads-v1"
const FALLBACK_MODELS: ModelOption[] = [
  { value: "pro", label: "Pro", modelClass: "pro" },
  { value: "fast", label: "Fast", modelClass: "fast" },
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

function liveMessageText(message: SessionMessage): string {
  const content = message.message?.content
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n")
      : ""
  return text.replace(/\s+/g, " ").trim()
}

function currentSessionPreview(projectPath: string, meta: SessionMeta, messages: SessionMessage[]): LiveSessionPreview | null {
  const recentlyActive = meta.isActive || Date.now() - Date.parse(meta.lastActivity) <= 5 * 60_000
  if (!recentlyActive) return null
  const latestUser = messages.findLast(message => message.message?.role === "user" && liveMessageText(message))
  const latestAssistant = messages.findLast(message => message.message?.role === "assistant" && liveMessageText(message))
  const clip = (text: string) => text.length > 1200 ? `${text.slice(0, 840)} … ${text.slice(-360)}` : text
  return {
    sessionId: meta.id,
    projectPath,
    source: meta.source ?? "claude",
    title: meta.customName || meta.firstName || meta.id.slice(0, 8),
    lastActivity: meta.lastActivity,
    latestUser: latestUser ? clip(liveMessageText(latestUser)) : "No recent user message",
    assistantTail: latestAssistant ? clip(liveMessageText(latestAssistant)) : "No assistant response yet",
  }
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
  const [providers, setProviders] = useState<Provider[]>([])
  const [provider, setProvider] = useState("local")
  const [agent, setAgent] = useState("codex")
  const [mode, setMode] = useState("ask")
  const [thinkingLevel, setThinkingLevel] = useState("auto")
  const [modelOptionsByAgent, setModelOptionsByAgent] = useState<Record<string, ModelOption[]>>({})
  const [modelChoice, setModelChoice] = useState("pro")
  const [selectedCwd, setSelectedCwd] = useState(cwd ?? "")
  const [transcriptLocations, setTranscriptLocations] = useState<string[]>([])
  const [threads, setThreads] = useState<AgentThread[]>(loadThreads)
  const [activeThreadId, setActiveThreadId] = useState("")
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summarySessions, setSummarySessions] = useState<LiveSessionPreview[]>([])
  const [summaryContextReady, setSummaryContextReady] = useState(false)
  const [summaryMetrics, setSummaryMetrics] = useState<SummaryMetrics | null>(null)
  const [plans, setPlans] = useState<SessionPlan[]>([])
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const activeThread = threads.find(thread => thread.id === activeThreadId) ?? threads[0]
  const activeProvider = providers.find(entry => entry.id === provider)
  const agentOptions = useMemo(
    () => activeProvider?.agents?.length ? activeProvider.agents : ["codex"],
    [activeProvider],
  )
  const rawModels = modelOptionsByAgent[agent] ?? FALLBACK_MODELS
  const selectedRawModel = rawModels.find(option => option.value === modelChoice) ?? rawModels[0] ?? FALLBACK_MODELS[0]
  const models = useMemo<AgenticModelOption[]>(() => rawModels.map(option => ({
    id: option.value,
    label: option.label,
    provider: agent,
  })), [agent, rawModels])
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
    if (!activeThreadId && threads[0]) setActiveThreadId(threads[0].id)
  }, [activeThreadId, threads])

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
        if (!response.ok) throw new Error(`Provider lookup failed (${response.status})`)
        return response.json() as Promise<ProviderResponse>
      })
      .then(data => {
        setProviders(data.providers ?? [])
        setProvider(data.defaults?.provider ?? "local")
        setAgent(data.defaults?.agent ?? "codex")
        setMode(data.defaults?.mode ?? "ask")
        setModelChoice(data.defaults?.model || data.defaults?.modelClass || "pro")
        setModelOptionsByAgent(data.modelOptionsByAgent ?? {})
        setTranscriptLocations(data.transcriptLocations ?? [])
      })
      .catch(err => { if (err.name !== "AbortError") setError(err instanceof Error ? err.message : String(err)) })
    return () => controller.abort()
  }, [])

  async function loadPlans() {
    const response = await fetch("/api/agent/plans?limit=8", { credentials: "include" })
    if (!response.ok) throw new Error(`Plan status lookup failed (${response.status})`)
    const data = await response.json() as { plans?: SessionPlan[] }
    setPlans(data.plans ?? [])
  }

  useEffect(() => {
    void loadPlans().catch(err => setError(err instanceof Error ? err.message : String(err)))
    const timer = window.setInterval(() => {
      void loadPlans().catch(() => undefined)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!agentOptions.includes(agent)) setAgent(agentOptions[0] ?? "codex")
  }, [agent, agentOptions])

  useEffect(() => {
    if (!rawModels.some(option => option.value === modelChoice)) setModelChoice(rawModels[0]?.value ?? "pro")
  }, [modelChoice, rawModels])

  useEffect(() => {
    if (!selectedCwd || (cwd && !directoryOptions.includes(selectedCwd))) setSelectedCwd(cwd ?? directoryOptions[0] ?? "")
  }, [cwd, directoryOptions, selectedCwd])

  function updateThread(threadId: string, updater: (thread: AgentThread) => AgentThread) {
    setThreads(current => current.map(thread => thread.id === threadId ? updater(thread) : thread))
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
          provider,
          agent,
          mode,
          modelClass: selectedRawModel.modelClass ?? "pro",
          model: selectedRawModel.model,
          thinkingLevel,
          noModel: selectedRawModel.noModel,
          useExtraModelArg: selectedRawModel.useExtraModelArg,
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
      const data = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string; provider?: string; agent?: string }
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `Agent request failed (${response.status})`)
      updateThread(threadId, thread => ({
        ...thread,
        turns: [...thread.turns, { role: "assistant", content: data.text ?? "No response text returned.", provider: data.provider, agent: data.agent }],
        updatedAt: new Date().toISOString(),
      }))
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : String(err))
    } finally {
      abortRef.current = null
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
    if (summaryLoading || sending) return
    const thread = makeThread(`Live update · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)
    setThreads(current => [thread, ...current].slice(0, 20))
    setActiveThreadId(thread.id)
    setSummaryLoading(true)
    setSummarySessions([])
    setSummaryContextReady(false)
    setSummaryMetrics(null)
    setSending(true)
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const immediateSession = currentSessionPreview(projectPath, sessionMeta, messages)
      if (immediateSession) {
        setSummarySessions([immediateSession])
        setSummaryContextReady(true)
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }

      const contextPromise = fetch("/api/agent/summary-context", {
        credentials: "include",
        signal: controller.signal,
      })
      const streamPromise = immediateSession ? fetch("/api/agent/summary-stream", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, cwd: selectedCwd || cwd || undefined }),
      }) : null
      const contextResponse = await contextPromise
      const contextData = await contextResponse.json().catch(() => ({})) as SummaryMetrics & { ok?: boolean; error?: string; sessions?: LiveSessionPreview[] }
      if (!contextResponse.ok || contextData.ok === false) throw new Error(contextData.error ?? `Live evidence failed (${contextResponse.status})`)
      setSummarySessions(contextData.sessions ?? [])
      setSummaryMetrics(contextData)
      setSummaryContextReady(true)
      updateThread(thread.id, current => ({ ...current, title: `Live update · ${contextData.chatsCount ?? "active"} chats` }))
      if (!immediateSession) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

      const response = streamPromise ? await streamPromise : await fetch("/api/agent/summary-stream", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          cwd: selectedCwd || cwd || undefined,
        }),
      })
      let summaryText = ""
      let paintFrame: number | null = null
      const paintSummary = () => {
        paintFrame = null
        updateThread(thread.id, current => ({
          ...current,
          turns: [{ role: "assistant", content: summaryText, provider: "openai", agent: "gpt-5.6-luna" }],
          updatedAt: new Date().toISOString(),
        }))
      }
      await streamSse(response, async (eventName, payload) => {
        if (eventName === "session" || eventName === "session_discovered") {
          const session = payload as LiveSessionPreview
          setSummarySessions(current => {
            const index = current.findIndex(item => item.sessionId === session.sessionId)
            if (index < 0) return [...current, session]
            const next = [...current]
            next[index] = session
            return next
          })
          return
        }
        if (eventName === "context_complete") {
          const metrics = payload as SummaryMetrics
          setSummaryMetrics(current => ({ ...current, ...metrics }))
          setSummaryContextReady(true)
          updateThread(thread.id, current => ({ ...current, title: `Live update · ${metrics.chatsCount ?? "active"} chats` }))
          return
        }
        if (eventName === "delta") {
          summaryText += String((payload as { text?: string }).text ?? "")
          if (paintFrame == null) paintFrame = requestAnimationFrame(paintSummary)
          return
        }
        if (eventName === "done") setSummaryMetrics(current => ({ ...current, ...(payload as SummaryMetrics) }))
      })
      if (paintFrame != null) cancelAnimationFrame(paintFrame)
      paintSummary()
      if (!summaryText) throw new Error("The summary stream completed without text.")
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : String(err))
    } finally {
      abortRef.current = null
      setSummaryLoading(false)
      setSending(false)
    }
  }

  function newThread() {
    const thread = makeThread()
    setThreads(current => [thread, ...current].slice(0, 20))
    setActiveThreadId(thread.id)
    setDraft("")
  }

  return (
    <section className="agent-console agentic-asv-shell" aria-label="Transcript research agent">
      <header className="agent-console-toolbar">
        <div className="agent-console-title">
          <Bot size={16} aria-hidden="true" />
          <span>Transcript agent</span>
          <span className="agent-console-context">read-only · {transcriptLocations.length || "all"} sources</span>
        </div>
        <div className="agent-console-controls">
          <button className="agent-live-summary-btn" type="button" onClick={() => void runLiveSummary()} disabled={sending}>
            {summaryLoading && summaryContextReady ? <Loader2 size={15} className="spin-icon" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
            Live update
          </button>
          <select value={provider} onChange={event => setProvider(event.target.value)} aria-label="Agent provider">
            {providers.map(entry => <option key={entry.id} value={entry.id} disabled={entry.status !== "available"}>{entry.label}</option>)}
          </select>
          <select value={agent} onChange={event => setAgent(event.target.value)} aria-label="Agent">
            {agentOptions.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          <select value={mode} onChange={event => setMode(event.target.value)} aria-label="Agent mode">
            {(["ask", "plan", "default"] as const).map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          <select value={thinkingLevel} onChange={event => setThinkingLevel(event.target.value)} aria-label="Thinking level">
            {(["auto", "low", "medium", "high"] as const).map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          <select className="agent-directory-select" value={selectedCwd} onChange={event => setSelectedCwd(event.target.value)} aria-label="Working directory">
            {directoryOptions.map(dir => <option key={dir} value={dir}>{directoryLabel(dir)}</option>)}
          </select>
          <button className="agent-icon-btn" type="button" onClick={() => void Promise.all([onTranscriptUpdated(), loadPlans()])} title="Refresh transcript evidence" aria-label="Refresh transcript evidence">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button className="agent-icon-btn agent-close-btn" type="button" onClick={onClose} title="Close transcript agent" aria-label="Close transcript agent">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {activeProvider?.detail ? <div className="agent-provider-detail">{activeProvider.detail}</div> : null}
      {error ? <div className="agent-console-error" role="alert">{error}</div> : null}

      <div className={`agent-workspace ${summarySessions.length ? "agent-workspace--live-summary" : ""}`}>
        <AgenticThreadSidebar
          title="Research threads"
          threads={threads.map(thread => ({
            id: thread.id,
            title: thread.title,
            updatedAt: new Date(thread.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            runCount: thread.turns.filter(turn => turn.role === "assistant").length,
            status: sending && thread.id === activeThreadId ? "running" : "idle",
          }))}
          activeThreadId={activeThreadId}
          onNewThread={newThread}
          onSelectThread={setActiveThreadId}
          onRenameThread={(id, title) => updateThread(id, thread => ({ ...thread, title }))}
          onArchiveThread={id => {
            setThreads(current => current.filter(thread => thread.id !== id))
            if (id === activeThreadId) setActiveThreadId(threads.find(thread => thread.id !== id)?.id ?? "")
          }}
        />

        <div className="agent-chat-column">
          {!summarySessions.length ? <AgenticSessionList
            title="Active evidence"
            activeSessionId={sessionMeta.id}
            sessions={[{
              id: sessionMeta.id,
              label: sessionMeta.customName || sessionMeta.firstName || sessionMeta.id.slice(0, 8),
              detail: `${sessionMeta.source ?? "claude"} · current chat + ${transcriptLocations.length || "all"} transcript sources`,
              status: "complete",
            }]}
          /> : null}
          {!summarySessions.length ? <AgenticTracePanel
            title="Live plan status"
            subtitle={plans.length ? `${plans.length} recent session${plans.length === 1 ? "" : "s"} · refreshes every 15s` : "No update_plan or TodoWrite records in recent sessions"}
            events={plans.flatMap(plan => plan.items.map(item => ({
              id: `${plan.sessionId}-${item.id}`,
              label: item.label,
              detail: `${plan.source} · ${plan.title}`,
              kind: "plan",
              status: item.status,
              time: plan.timestamp ? new Date(plan.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : undefined,
            }))).slice(0, 18)}
          /> : null}
          <div className="agent-chat-log" aria-live="polite">
            {summarySessions.length ? (
              <section className="agent-live-evidence" data-summary-phase={summaryContextReady ? "summarizing" : "collecting"}>
                <div className="agent-live-evidence-heading">
                  <strong>Active sessions now</strong>
                  <span>{summarySessions.length} found{summaryMetrics?.collectionMs != null ? ` · ${summaryMetrics.collectionMs} ms` : ""}{summaryMetrics?.generationMs != null ? ` · ${summaryMetrics.generationMs} ms AI` : ""}</span>
                </div>
                {summarySessions.map(session => (
                  <article className="agent-live-session" key={session.sessionId}>
                    <div className="agent-live-session-meta"><strong>{session.title}</strong><span>{session.source}</span></div>
                    <div className="agent-live-snippet"><span>Latest request</span><p>{session.latestUser}</p></div>
                    <div className="agent-live-snippet agent-live-snippet--assistant"><span>Latest assistant update</span><p>{session.assistantTail}</p></div>
                  </article>
                ))}
              </section>
            ) : null}
            {activeThread?.turns.length ? activeThread.turns.map((turn, index) => (
              <article key={`${activeThread.id}-${index}`} className={`agent-chat-turn agent-chat-turn--${turn.role}`}>
                <div className="agent-chat-role">{turn.role === "assistant" ? (turn.agent ?? "agent") : "you"}</div>
                {turn.role === "assistant"
                  ? <AgenticMarkdown text={turn.content} className="agent-chat-text" />
                  : <div className="agent-chat-text">{turn.content}</div>}
              </article>
            )) : (
              <div className="agent-chat-empty">Ask across Claude, Codex, Cursor, OpenCode, Antigravity, Hermes, Gemini, and claw transcripts—or click <strong>Live update</strong> for completed and remaining work.</div>
            )}
            {sending && (!summaryLoading || summaryContextReady) ? (
              <AgenticStageTimeline
                loading
                title={summaryLoading ? "Building live update" : "Researching transcripts"}
                stages={[
                  { id: "collect", label: summaryLoading ? `${summarySessions.length} active sessions loaded` : "Collect recent transcript evidence", status: "complete" },
                  { id: "research", label: summaryLoading ? `Streaming ${summaryMetrics?.model ?? "GPT-5.6 Luna low"} summary` : "Search relevant transcript sources", status: "running" },
                ]}
              />
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
              placeholder="Ask a detailed question across all transcripts…"
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
