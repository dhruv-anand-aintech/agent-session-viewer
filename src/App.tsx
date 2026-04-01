import { useState, useEffect, useRef, useCallback } from "react"
import type { SessionMessage } from "./types"
import MessageBlock from "./MessageBlock"
import PrettyMessageBlock, { charCountMsg } from "./pretty/PrettyMessageBlock"
import { idbPut, idbGet } from "./idb"
import "./App.css"

interface SessionMeta {
  id: string
  projectPath: string
  messageCount: number
  userMessageCount?: number
  lastActivity: string
  version?: string
  gitBranch?: string
  isActive: boolean
  isSidechain?: boolean
  agentType?: string
  firstName?: string
  customName?: string
  parentSessionId?: string
  source?: "claude" | "cursor" | "opencode" | "antigravity" | "hermes" | string
}

function isRecentlyActive(iso: string): boolean {
  const diff = Date.now() - new Date(iso).getTime()
  return !isNaN(diff) && diff < 5 * 60 * 1000 // active within last 5 minutes
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (isNaN(diff)) return ""
  const m = Math.floor(diff / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

interface ProjectData {
  path: string
  displayName: string
  sessions: SessionMeta[]
}

interface Capabilities {
  openPath: boolean
  debugStream: boolean
}

function useCapabilities(): Capabilities {
  const [caps, setCaps] = useState<Capabilities>({ openPath: false, debugStream: false })
  useEffect(() => {
    fetch("/api/capabilities")
      .then(r => (r.ok ? r.json() : {}))
      .then((c: unknown) => {
        const o =
          c && typeof c === "object" && c !== null
            ? (c as Record<string, unknown>)
            : {}
        setCaps({ openPath: !!o.openPath, debugStream: !!o.debugStream })
      })
      .catch(() => {})
  }, [])
  return caps
}

const RECENT_SIDEBAR_SESSIONS = 30

function useProjects() {
  const [projects, setProjects] = useState<ProjectData[]>([])
  const [connected, setConnected] = useState(false)
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [totalSessions, setTotalSessions] = useState<number | null>(null)
  const [listMode, setListMode] = useState<"recent" | "full">("recent")

  useEffect(() => {
    setProjectsLoading(true)
    const qs = listMode === "recent" ? `?maxSessions=${RECENT_SIDEBAR_SESSIONS}` : ""
    fetch(`/api/projects${qs}`, { credentials: "include" })
      .then(r => {
        const total = r.headers.get("X-Total-Sessions")
        if (total) setTotalSessions(Number(total))
        return r.json()
      })
      .then(data => {
        setProjects(data as ProjectData[])
        setProjectsLoading(false)
      })
      .catch(() => setProjectsLoading(false))

    const es = new EventSource(`/api/stream${qs}`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.addEventListener("projects", (e) => {
      try {
        setProjects(JSON.parse((e as MessageEvent).data) as ProjectData[])
      } catch { /* ignore */ }
    })
    return () => es.close()
  }, [listMode])

  const visibleCount = projects.reduce((n, p) => n + p.sessions.length, 0)
  const sessionsTruncated =
    listMode === "recent" && totalSessions != null && totalSessions > visibleCount

  const loadAllSessions = useCallback(() => setListMode("full"), [])

  return {
    projects,
    connected,
    projectsLoading,
    totalSessions,
    listMode,
    sessionsTruncated,
    loadAllSessions,
  }
}

// ── IDB-backed windowed message store ─────────────────────────────────────────

const CHUNK = 60        // messages to load per step
const MAX_DOM = 180     // max messages to keep in DOM at once
const IDB_KEY = (projectDir: string, sessionId: string) => `sess/${projectDir}/${sessionId}`

interface MsgWindow {
  msgs: SessionMessage[]
  startIdx: number  // index in full array where this window starts
  total: number     // total messages in full array
}

// Adaptive page size for backward compat
const CHAR_TARGET = 5000
function adaptivePage(all: SessionMessage[], fromIdx: number): number {
  let chars = 0
  let count = 0
  for (let i = fromIdx - 1; i >= 0 && count < 50; i--, count++) {
    chars += charCountMsg(all[i])
    if (chars >= CHAR_TARGET) return count + 1
  }
  return Math.max(count, 5)
}

function useWindowedMessages(projectDir: string | null, sessionId: string | null, isActive: boolean) {
  const [win, setWin] = useState<MsgWindow | null>(null)
  const [loading, setLoading] = useState(false)
  // Full array lives here (module-scope per hook instance — not React state)
  const fullRef = useRef<SessionMessage[]>([])

  const idbKey = projectDir && sessionId ? IDB_KEY(projectDir, sessionId) : null

  const initWindow = useCallback((all: SessionMessage[]) => {
    const filtered = all.filter(m => m.type !== "file-history-snapshot")
    fullRef.current = filtered
    const startIdx = Math.max(0, filtered.length - MAX_DOM)
    setWin({ msgs: filtered.slice(startIdx), startIdx, total: filtered.length })
  }, [])

  // Fetch from remote, store in IDB, init window
  const fetchRemote = useCallback(async () => {
    if (!projectDir || !sessionId || !idbKey) return
    try {
      const r = await fetch(`/api/session/${encodeURIComponent(projectDir)}/${sessionId}`)
      if (!r.ok) return
      const msgs: SessionMessage[] = await r.json()
      await idbPut(idbKey, msgs)
      initWindow(msgs)
      setLoading(false)
    } catch { setLoading(false) }
  }, [projectDir, sessionId, idbKey, initWindow])

  // Initial load: try IDB first for instant display, then refresh from remote
  useEffect(() => {
    if (!projectDir || !sessionId || !idbKey) return
    setWin(null)
    setLoading(true)
    fullRef.current = []
    ;(async () => {
      const cached = await idbGet<SessionMessage[]>(idbKey)
      if (cached && cached.length > 0) {
        initWindow(cached)
        setLoading(false)
      }
      // Always fetch fresh (cached view is instant, remote updates it)
      await fetchRemote()
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, sessionId])

  // Auto-refresh for active sessions — only update window tail with new messages
  useEffect(() => {
    if (!isActive || !projectDir || !sessionId || !idbKey) return
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/session/${encodeURIComponent(projectDir)}/${sessionId}`)
        if (!r.ok) return
        const msgs: SessionMessage[] = await r.json()
        await idbPut(idbKey, msgs)
        const filtered = msgs.filter(m => m.type !== "file-history-snapshot")
        fullRef.current = filtered
        // Extend window to include new tail messages
        setWin(prev => {
          if (!prev) return { msgs: filtered.slice(Math.max(0, filtered.length - MAX_DOM)), startIdx: Math.max(0, filtered.length - MAX_DOM), total: filtered.length }
          const newStart = prev.startIdx
          const newMsgs = filtered.slice(newStart)
          // If window grew too large, trim from start
          if (newMsgs.length > MAX_DOM) {
            const trimStart = newStart + (newMsgs.length - MAX_DOM)
            return { msgs: filtered.slice(trimStart), startIdx: trimStart, total: filtered.length }
          }
          return { msgs: newMsgs, startIdx: newStart, total: filtered.length }
        })
      } catch { /* ignore */ }
    }, 4000)
    return () => clearInterval(t)
  }, [isActive, projectDir, sessionId, idbKey])

  const hasEarlier = win ? win.startIdx > 0 : false
  const hasLater = win ? win.startIdx + win.msgs.length < win.total : false

  // Lock refs prevent the IntersectionObserver from firing a new load
  // while a previous load is still being processed, avoiding runaway loops.
  const loadingEarlierRef = useRef(false)
  const loadingLaterRef = useRef(false)

  function loadEarlier() {
    if (!win || win.startIdx === 0) return
    const full = fullRef.current
    const newStart = Math.max(0, win.startIdx - adaptivePage(full, win.startIdx))
    // Keep the existing bottom boundary — don't evict messages from the bottom end
    const existingEnd = win.startIdx + win.msgs.length
    const newMsgs = full.slice(newStart, existingEnd)
    // Only trim from the bottom if we exceed MAX_DOM
    const trimmed = newMsgs.length > MAX_DOM ? newMsgs.slice(0, MAX_DOM) : newMsgs
    setWin({ msgs: trimmed, startIdx: newStart, total: win.total })
  }

  function loadLater() {
    if (!win) return
    const full = fullRef.current
    const currentEnd = win.startIdx + win.msgs.length
    if (currentEnd >= win.total) return
    const newEnd = Math.min(win.total, currentEnd + CHUNK)
    const newMsgs = full.slice(win.startIdx, newEnd)
    // Trim from top if too large
    if (newMsgs.length > MAX_DOM) {
      const trimStart = win.startIdx + (newMsgs.length - MAX_DOM)
      setWin({ msgs: full.slice(trimStart, newEnd), startIdx: trimStart, total: win.total })
    } else {
      setWin({ msgs: newMsgs, startIdx: win.startIdx, total: win.total })
    }
  }

  return { win, loading, hasEarlier, hasLater, loadEarlier, loadLater, fullRef, loadingEarlierRef, loadingLaterRef }
}

// ── Session pane ──────────────────────────────────────────────────────────────

type Suggestion = { parentUuid: string; text: string; id: string }

function wordOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().match(/\b\w{4,}\b/g) ?? [])
  const wa = words(a), wb = words(b)
  let hits = 0
  wa.forEach(w => { if (wb.has(w)) hits++ })
  return wa.size ? hits / wa.size : 0
}

function SessionPane({ projectDir, sessionMeta, onBack, capabilities }: { projectDir: string; sessionMeta: SessionMeta; onBack?: () => void; capabilities: Capabilities }) {
  const { win, loading, hasEarlier, hasLater, loadEarlier, loadLater, loadingEarlierRef, loadingLaterRef } =
    useWindowedMessages(projectDir, sessionMeta.id, isRecentlyActive(sessionMeta.lastActivity))

  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({})
  useEffect(() => {
    fetch(`/api/suggestions/${encodeURIComponent(projectDir)}/${sessionMeta.id}`)
      .then(r => r.ok ? r.json() : [])
      .then((list: Suggestion[]) => {
        const map: Record<string, Suggestion> = {}
        list.forEach(s => { if (s.parentUuid) map[s.parentUuid] = s })
        setSuggestions(map)
      }).catch(() => {})
  }, [projectDir, sessionMeta.id])

  const [todos, setTodos] = useState<TodoFile | null>(null)
  useEffect(() => {
    fetch(`/api/todos/${sessionMeta.id}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(setTodos)
      .catch(() => {})
  }, [sessionMeta.id])
  const bottomRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [prettyMode, setPrettyMode] = useState(true)
  const pendingPrevNav = useRef(false)
  const initialScrollDone = useRef(false)

  // On first load, instantly jump to bottom (no smooth — avoids seeing the top flash)
  useEffect(() => {
    if (win && !initialScrollDone.current) {
      initialScrollDone.current = true
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [win])

  // After initial load, smooth-follow new messages only if already at bottom.
  // We skip the very first win update (handled by the instant-scroll above).
  const prevWinLenRef = useRef(0)
  useEffect(() => {
    if (!win || !initialScrollDone.current) return
    const newLen = win.msgs.length
    if (autoScroll && newLen > prevWinLenRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
    prevWinLenRef.current = newLen
  }, [win, autoScroll])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }, [])

  function jumpToBottom() {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAutoScroll(true)
  }

  function loadEarlierPreserveScroll() {
    const el = scrollRef.current
    const prevHeight = el?.scrollHeight ?? 0
    loadEarlier()
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - prevHeight
    })
  }

  // IntersectionObserver: auto load earlier when top sentinel visible.
  // loadingEarlierRef prevents re-entrant loads while a load is in flight.
  useEffect(() => {
    if (!hasEarlier) return
    const sentinel = topSentinelRef.current
    if (!sentinel) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadingEarlierRef.current) {
          loadingEarlierRef.current = true
          loadEarlierPreserveScroll()
          setTimeout(() => { loadingEarlierRef.current = false }, 400)
        }
      },
      { root: scrollRef.current, threshold: 0.1 }
    )
    obs.observe(sentinel)
    return () => obs.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEarlier, win?.startIdx])

  // IntersectionObserver: auto load later when bottom sentinel visible (for evicted tail).
  // loadingLaterRef prevents re-entrant loads.
  useEffect(() => {
    if (!hasLater) return
    const sentinel = bottomSentinelRef.current
    if (!sentinel) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadingLaterRef.current) {
          loadingLaterRef.current = true
          loadLater()
          setTimeout(() => { loadingLaterRef.current = false }, 400)
        }
      },
      { root: scrollRef.current, threshold: 0.1 }
    )
    obs.observe(sentinel)
    return () => obs.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLater, win?.startIdx, win?.msgs.length])

  const Block = prettyMode ? PrettyMessageBlock : MessageBlock

  function getUserTurns(): HTMLElement[] {
    return Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-user-turn]") ?? [])
  }

  // Pending prev-nav: keep loading earlier until user message is above viewport
  useEffect(() => {
    if (!pendingPrevNav.current) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const containerTop = scrollEl.getBoundingClientRect().top
    const turns = getUserTurns()
    const above = turns.filter(el => el.getBoundingClientRect().top - containerTop < -10)
    if (above.length > 0) {
      pendingPrevNav.current = false
      above[above.length - 1].scrollIntoView({ behavior: "smooth", block: "start" })
    } else if (hasEarlier) {
      loadEarlierPreserveScroll()
    } else {
      pendingPrevNav.current = false
      turns[0]?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win?.msgs.length, win?.startIdx])

  function navUserMsg(dir: "prev" | "next") {
    const turns = getUserTurns()
    if (!turns.length && !hasEarlier) return
    const scrollEl = scrollRef.current!
    const containerTop = scrollEl.getBoundingClientRect().top

    if (dir === "next") {
      const target = turns.find(el => el.getBoundingClientRect().top - containerTop > 10)
      target?.scrollIntoView({ behavior: "smooth", block: "start" })
    } else {
      const above = turns.filter(el => el.getBoundingClientRect().top - containerTop < -10)
      if (above.length > 0) {
        above[above.length - 1].scrollIntoView({ behavior: "smooth", block: "start" })
      } else if (hasEarlier) {
        pendingPrevNav.current = true
        loadEarlierPreserveScroll()
      } else {
        turns[0]?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
    }
  }

  function jumpToFirst() {
    if (win && win.startIdx === 0) {
      // Already loaded from beginning — just scroll to top
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })
    } else {
      // Trigger continuous loadEarlier until startIdx == 0, then scroll to top
      pendingPrevNav.current = true
      loadEarlierPreserveScroll()
      // After all loads complete, pendingPrevNav effect will scroll to first user turn
      // For a true "jump to very first line", we override: scroll to top after loads
      const check = setInterval(() => {
        if (!pendingPrevNav.current) {
          clearInterval(check)
          scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })
        }
      }, 200)
    }
  }

  const visible = win?.msgs ?? []
  const total = win?.total ?? 0
  const startIdx = win?.startIdx ?? 0

  return (
    <div className="session-pane">
      <div className="session-header">
        {onBack && <button className="back-btn" onClick={onBack} title="Back to sessions">←</button>}
        <span className="session-id">{sessionMeta.id.slice(0, 8)}</span>
        {capabilities.openPath && (
          <button
            className="session-path-btn hide-mobile"
            onClick={() => fetch(`/api/open-path?project=${encodeURIComponent(projectDir)}&session=${sessionMeta.id}`).catch(() => {})}
            title={`~/.claude/projects/${projectDir}/${sessionMeta.id}.jsonl`}
          >
            📄 {sessionMeta.id.slice(0, 8)}.jsonl
          </button>
        )}
        {sessionMeta.gitBranch && <span className="git-branch hide-mobile">⎇ {sessionMeta.gitBranch}</span>}
        {isRecentlyActive(sessionMeta.lastActivity) && <span className="active-badge">● Live</span>}
        <span className="msg-count hide-mobile">{sessionMeta.messageCount} messages</span>
        <div className="user-nav">
          <button className="user-nav-btn" onClick={jumpToFirst} title="Jump to first message">⤒</button>
          <button className="user-nav-btn" onClick={() => navUserMsg("prev")} title="Previous user message">↑</button>
          <button className="user-nav-btn" onClick={() => navUserMsg("next")} title="Next user message">↓</button>
          {!autoScroll && (
            <button className="user-nav-btn jump-bottom-btn" onClick={jumpToBottom} title="Jump to bottom">⤓</button>
          )}
        </div>
        <div className="mode-toggle">
          <button className={`mode-toggle-btn ${prettyMode ? "" : "active"}`} onClick={() => setPrettyMode(false)}>Raw</button>
          <button className={`mode-toggle-btn ${prettyMode ? "active" : ""}`} onClick={() => setPrettyMode(true)}>Pretty</button>
        </div>
      </div>
      {todos && todos.items.length > 0 && (
        <div className="session-todos">
          {todos.items.map((item, i) => (
            <div key={i} className={`session-todo-item ${item.status === "completed" ? "done" : item.status === "in_progress" ? "active" : ""}`}>
              <span className="session-todo-check">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○"}</span>
              <span className="session-todo-text">{item.activeForm ?? item.content}</span>
            </div>
          ))}
        </div>
      )}
      <div className="messages-scroll" ref={scrollRef} onScroll={handleScroll}>
        {loading && <div className="loading-state">Loading messages…</div>}
        {!loading && hasEarlier && (
          <div>
            <div ref={topSentinelRef} style={{ height: 1 }} />
            <div className="load-more-wrap">
              <button className="load-more-pill" onClick={loadEarlierPreserveScroll}>
                ↑ Load earlier messages
                <span className="load-more-count">{startIdx} remaining</span>
              </button>
            </div>
          </div>
        )}
        {visible.map((msg, i) => {
          const sugg = msg.uuid ? suggestions[msg.uuid] : undefined
          const nextUserMsg = sugg ? visible.slice(i + 1).find(m => m.type === "user") : undefined
          const nextText = nextUserMsg ? (typeof nextUserMsg.message?.content === "string" ? nextUserMsg.message.content : (nextUserMsg.message?.content as {type:string;text?:string}[])?.filter(b => b.type === "text").map(b => b.text).join("") ?? "") : ""
          const chosen = sugg && nextText ? wordOverlap(sugg.text, nextText) > 0.4 : false
          return (
            <div key={msg.uuid ?? i} className={sugg ? "msg-with-suggestion" : undefined}>
              <Block msg={msg} index={startIdx + i} nextMsg={visible[i + 1]} source={sessionMeta.source} />
              {sugg && (
                <div className="suggestion-pill" title={sugg.text}>
                  <span className="suggestion-icon">{chosen ? "✓" : "💡"}</span>
                  <span className="suggestion-text">{sugg.text.slice(0, 80)}{sugg.text.length > 80 ? "…" : ""}</span>
                  {chosen && <span className="suggestion-chosen">chosen</span>}
                </div>
              )}
            </div>
          )
        })}
        {!loading && hasLater && (
          <div>
            <div ref={bottomSentinelRef} style={{ height: 1 }} />
            <div className="load-more-wrap">
              <button className="load-more-pill load-more-pill--later" onClick={loadLater}>
                ↓ Load later messages
                <span className="load-more-count">{total - startIdx - visible.length} remaining</span>
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ── Platform chrome (sidebar dots + filter pills share hue tokens in App.css) ─

function platformDotClass(source?: string): string {
  switch (source ?? "claude") {
    case "cursor":
      return "dot-cursor"
    case "opencode":
      return "dot-opencode"
    case "antigravity":
      return "dot-antigravity"
    case "hermes":
      return "dot-hermes"
    default:
      return "dot-claude"
  }
}

function platformTitle(source?: string): string {
  switch (source ?? "claude") {
    case "cursor":
      return "Cursor"
    case "opencode":
      return "OpenCode"
    case "antigravity":
      return "Antigravity"
    case "hermes":
      return "Hermes"
    default:
      return "Claude"
  }
}

const PLATFORM_FILTER_ACTIVE: Record<string, string> = {
  all: "active-all",
  claude: "active-claude",
  cursor: "active-cursor",
  opencode: "active-opencode",
  antigravity: "active-antigravity",
  hermes: "active-hermes",
}

function platformFilterActiveClass(p: string): string {
  return PLATFORM_FILTER_ACTIVE[p] ?? "active-claude"
}

// ── Session item ──────────────────────────────────────────────────────────────

function SessionItem({ s, projectPath, isSelected, onSelect, subagentCount, subagentsExpanded, onToggleSubagents }: {
  s: SessionMeta
  projectPath: string
  isSelected: boolean
  onSelect: () => void
  subagentCount?: number
  subagentsExpanded?: boolean
  onToggleSubagents?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const displayName = s.customName || s.firstName || s.id.slice(0, 8)
  // Tooltip: show full display name, agent type, and session ID
  const tooltip = [
    displayName,
    s.agentType ? `[${s.agentType}]` : null,
    s.firstName && s.firstName !== displayName ? s.firstName : null,
    s.id,
  ].filter(Boolean).join("\n\n")

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setDraft(s.customName ?? s.firstName ?? "")
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  async function commitRename() {
    setEditing(false)
    const name = draft.trim()
    if (name === (s.customName ?? "")) return  // no change
    await fetch(`/api/names/${encodeURIComponent(projectPath)}/${s.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name }),
    })
    s.customName = name || undefined
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitRename()
    if (e.key === "Escape") setEditing(false)
  }

  return (
    <div
      className={`sidebar-session ${isSelected ? "active" : ""} ${s.isSidechain ? "sidechain" : ""}`}
      onClick={onSelect}
      data-tooltip={tooltip}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="ss-rename-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={onKeyDown}
          onClick={e => e.stopPropagation()}
          placeholder="Session name…"
        />
      ) : (
        <>
          <span
            className={`platform-dot ${platformDotClass(s.source)}`}
            title={platformTitle(s.source)}
            role="img"
            aria-label={platformTitle(s.source)}
          />
          {isRecentlyActive(s.lastActivity) && <span className="ss-live">●</span>}
          {s.isSidechain && <span className="ss-subagent-icon" title="Sub-agent session">⤷</span>}
          <span className="ss-name">{displayName}</span>
          {onToggleSubagents && (
            <button className="ss-subagents-toggle" onClick={e => { e.stopPropagation(); onToggleSubagents() }} title={`${subagentsExpanded ? "Hide" : "Show"} ${subagentCount} subagents`}>
              {subagentsExpanded ? "▾" : "▸"}{subagentCount}
            </button>
          )}
          <button className="ss-rename-btn" onClick={startEdit} title="Rename">✎</button>
          <div className="ss-meta">
            <span className="ss-count">
              {s.userMessageCount != null ? `${s.userMessageCount}/${s.messageCount}` : s.messageCount}
            </span>
            {s.lastActivity && <span className="ss-time">{relativeTime(s.lastActivity)}</span>}
          </div>
        </>
      )}
    </div>
  )
}

// ── Todos tab ─────────────────────────────────────────────────────────────────

interface TodoFile {
  id: string
  items: { content: string; status: string; activeForm?: string }[]
  mtime: string
}


// ── Debug tab ─────────────────────────────────────────────────────────────────

function DebugTab() {
  const [lines, setLines] = useState<string[]>([])
  const [target, setTarget] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let es: EventSource | null = null
    let cancelled = false

    ;(async () => {
      try {
        const r = await fetch("/api/debug-tail", { credentials: "include" })
        if (!cancelled && r.ok) {
          const j = (await r.json()) as { lines?: string[]; target?: string | null }
          if (j.lines && j.lines.length > 0) {
            setLines(j.lines)
            setTarget(j.target ?? null)
          }
        }
      } catch { /* ignore — SSE init will populate */ }

      if (cancelled) return
      es = new EventSource("/api/debug-stream", { withCredentials: true })
      es.onopen = () => setConnected(true)
      es.onerror = () => setConnected(false)
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string; lines: string[]; target?: string }
          if (msg.type === "init") {
            setTarget(msg.target ?? null)
            setLines(msg.lines)
          } else if (msg.type === "append") {
            setLines(prev => [...prev, ...msg.lines])
          }
        } catch { /* ignore */ }
      }
    })()

    return () => {
      cancelled = true
      es?.close()
    }
  }, [])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView()
  }, [lines, autoScroll])

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  function levelClass(line: string) {
    if (line.includes("[ERROR]") || line.includes("[error]")) return "dbg-error"
    if (line.includes("[WARN]") || line.includes("[warn]")) return "dbg-warn"
    if (line.includes("[INFO]") || line.includes("[info]")) return "dbg-info"
    return "dbg-debug"
  }

  return (
    <div className="debug-tab">
      <div className="debug-header">
        <span className="debug-title">Debug Log</span>
        {target && <span className="debug-path">{target}</span>}
        <span className={`conn-badge ${connected ? "conn-on" : "conn-off"}`} style={{ marginLeft: "auto" }}>
          {connected ? "● Live" : "○ Connecting"}
        </span>
        {!autoScroll && (
          <button className="debug-scroll-btn" onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView() }}>
            ⤓ Follow
          </button>
        )}
      </div>
      <div className="debug-scroll" ref={scrollRef} onScroll={handleScroll}>
        {lines.map((line, i) => line ? (
          <div key={i} className={`dbg-line ${levelClass(line)}`}>{line}</div>
        ) : null)}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ── Settings modal ────────────────────────────────────────────────────────────

const KNOWN_CLAW_TOOLS = [
  "nanoclaw", "openclaw", "picoclaw", "femtoclaw", "attoclaw",
  "kiloclaw", "megaclaw", "zeroclaw", "microclaw", "rawclaw",
]

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [toolPaths, setToolPaths] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch("/api/settings", { credentials: "include" })
      .then(r => r.ok ? r.json() : {})
      .then((s: Record<string, unknown>) => setToolPaths((s.toolPaths as Record<string, string>) ?? {}))
      .catch(() => {})
  }, [])

  async function save() {
    setSaving(true)
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ toolPaths }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="settings-section-label">Claw Tool Paths</div>
          <div className="settings-hint">
            Leave blank to auto-detect (checks <code>~/toolname</code>).
            Restart the daemon after changing paths.
          </div>
          {KNOWN_CLAW_TOOLS.map(name => (
            <div key={name} className="settings-row">
              <label className="settings-label">{name}</label>
              <input
                className="settings-input"
                placeholder={`e.g. /Users/you/${name}`}
                value={toolPaths[name] ?? ""}
                onChange={e => setToolPaths(p => ({ ...p, [name]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="settings-footer">
          <button className="settings-save-btn" onClick={save} disabled={saving}>
            {saved ? "Saved!" : saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 640px)").matches)
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)")
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])
  return mobile
}

function Sidebar({ projects, projectsLoading, totalSessions, listMode, sessionsTruncated, onLoadAllSessions, selected, onSelect, width, onDragStart, mobileOpen, onMobileClose }: {
  projects: ProjectData[]
  projectsLoading: boolean
  totalSessions: number | null
  listMode: "recent" | "full"
  sessionsTruncated: boolean
  onLoadAllSessions: () => void
  selected: { project: string; session: string } | null
  onSelect: (p: string, s: string) => void
  width: number
  onDragStart: (e: React.PointerEvent) => void
  mobileOpen: boolean
  onMobileClose: () => void
}) {
  const isMobile = useIsMobile()
  // Default: flat (not grouped)
  const [grouped, setGrouped] = useState(() => localStorage.getItem("sidebarGrouped") === "true")
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [platformFilter, setPlatformFilter] = useState<string>("all")

  function toggleGrouped(val: boolean) {
    setGrouped(val)
    localStorage.setItem("sidebarGrouped", String(val))
  }

  function toggleParent(id: string) {
    setExpandedParents(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Detect which platforms have sessions
  const allSessions = projects.flatMap(p => p.sessions)
  const presentPlatforms = Array.from(new Set(allSessions.map(s => s.source ?? "claude")))
  const showPlatformFilter = presentPlatforms.length > 1

  const allFlat: { s: SessionMeta; projectPath: string }[] = projects
    .flatMap(p => p.sessions.map(s => ({ s, projectPath: p.path })))
    .filter(({ s }) => platformFilter === "all" || (s.source ?? "claude") === platformFilter)
    .sort((a, b) => String(b.s.lastActivity ?? "").localeCompare(String(a.s.lastActivity ?? "")))

  // Build flat groups: top-level sessions each with their subagents
  const subagentsByParent = new Map<string, { s: SessionMeta; projectPath: string }[]>()
  const topLevel: { s: SessionMeta; projectPath: string }[] = []
  for (const item of allFlat) {
    if (item.s.isSidechain && item.s.parentSessionId) {
      const arr = subagentsByParent.get(item.s.parentSessionId) ?? []
      arr.push(item)
      subagentsByParent.set(item.s.parentSessionId, arr)
    } else if (!item.s.isSidechain) {
      topLevel.push(item)
    }
  }
  // Orphan subagents (no known parent in list) shown after top-level
  const orphans = allFlat.filter(({ s }) => s.isSidechain && (!s.parentSessionId || !subagentsByParent.has(s.parentSessionId) || !topLevel.find(t => t.s.id === s.parentSessionId)))

  function handleSelect(p: string, s: string) {
    onSelect(p, s)
    onMobileClose()
  }

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onMobileClose} />}
    <nav className={`sidebar${mobileOpen ? " mobile-open" : ""}`} style={isMobile ? undefined : { width }}>
      <div className="sidebar-title">
        Sessions
        <div className="sidebar-view-toggle">
          <button className={`sidebar-view-btn ${!grouped ? "active" : ""}`} onClick={() => toggleGrouped(false)}>Flat</button>
          <button className={`sidebar-view-btn ${grouped ? "active" : ""}`} onClick={() => toggleGrouped(true)}>Groups</button>
        </div>
      </div>
      {(showPlatformFilter || sessionsTruncated) && (
        <div className="sidebar-platform-filter">
          {showPlatformFilter &&
            ["all", ...presentPlatforms].map(p => (
              <button
                key={p}
                type="button"
                className={`sidebar-platform-btn ${platformFilter === p ? platformFilterActiveClass(p) : ""}`}
                onClick={() => setPlatformFilter(p)}
              >
                {p === "all" ? "All" : p === "claude" ? "Claude" : p === "cursor" ? "Cursor" : p === "opencode" ? "OpenCode" : p === "antigravity" ? "Antigravity" : p === "hermes" ? "Hermes" : p}
              </button>
            ))}
          {sessionsTruncated && totalSessions != null && (
            <button
              type="button"
              className="sidebar-platform-btn load-all-sessions-pill"
              onClick={onLoadAllSessions}
              title="Load every session into the sidebar (slower)"
            >
              All ({totalSessions})
            </button>
          )}
        </div>
      )}
      {grouped ? (
        projects
          .map(project => ({
            ...project,
            sessions: project.sessions.filter(s => platformFilter === "all" || (s.source ?? "claude") === platformFilter),
          }))
          .filter(p => p.sessions.length > 0)
          .map(project => (
          <div key={project.path} className="sidebar-project">
            <div className="sidebar-project-name" title={project.path}>{project.displayName}</div>
            {project.sessions.map(s => (
              <SessionItem
                key={s.id}
                s={s}
                projectPath={project.path}
                isSelected={selected?.session === s.id}
                onSelect={() => handleSelect(project.path, s.id)}

              />
            ))}
          </div>
        ))
      ) : (
        <>
          {topLevel.map(({ s, projectPath }) => {
            const children = subagentsByParent.get(s.id) ?? []
            const expanded = expandedParents.has(s.id)
            return (
              <div key={`${projectPath}/${s.id}`}>
                <SessionItem
                  s={s}
                  projectPath={projectPath}
                  isSelected={selected?.session === s.id}
                  onSelect={() => handleSelect(projectPath, s.id)}
  
                  subagentCount={children.length}
                  subagentsExpanded={expanded}
                  onToggleSubagents={children.length > 0 ? () => toggleParent(s.id) : undefined}
                />
                {expanded && children.map(({ s: cs, projectPath: cp }) => (
                  <SessionItem
                    key={`${cp}/${cs.id}`}
                    s={cs}
                    projectPath={cp}
                    isSelected={selected?.session === cs.id}
                    onSelect={() => handleSelect(cp, cs.id)}
    
                  />
                ))}
              </div>
            )
          })}
          {orphans.map(({ s, projectPath }) => (
            <SessionItem
              key={`${projectPath}/${s.id}`}
              s={s}
              projectPath={projectPath}
              isSelected={selected?.session === s.id}
              onSelect={() => handleSelect(projectPath, s.id)}
            />
          ))}
        </>
      )}
      {projectsLoading && projects.length === 0 && (
        <div className="sidebar-empty">
          <span className="sidebar-spinner" />
          {sessionsTruncated || listMode === "recent"
            ? "Loading recent sessions…"
            : totalSessions != null
              ? `Loading ${totalSessions} sessions…`
              : "Loading…"}
        </div>
      )}
      {!projectsLoading && projects.length === 0 && <div className="sidebar-empty">No sessions found</div>}
      <div className="sidebar-resize-handle" onPointerDown={onDragStart} />
    </nav>
    </>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

const SIDEBAR_MIN = 140
const SIDEBAR_MAX = 520
const SIDEBAR_DEFAULT = 220

function parseUrlSession(): { project: string; session: string } | null {
  const s = new URLSearchParams(window.location.search).get("s")
  if (!s) return null
  const slash = s.lastIndexOf("/")
  if (slash < 1) return null
  return { project: decodeURIComponent(s.slice(0, slash)), session: s.slice(slash + 1) }
}

export default function App() {
  const {
    projects,
    connected,
    projectsLoading,
    totalSessions,
    listMode,
    sessionsTruncated,
    loadAllSessions,
  } = useProjects()
  const capabilities = useCapabilities()
  const [selected, setSelected] = useState<{ project: string; session: string } | null>(parseUrlSession)
  const [showSettings, setShowSettings] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<"sessions" | "debug">("sessions")
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("sidebarWidth")
    return saved ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(saved))) : SIDEBAR_DEFAULT
  })
  const dragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartW = useRef(0)

  const onDragStart = useCallback((e: React.PointerEvent) => {
    dragging.current = true
    dragStartX.current = e.clientX
    dragStartW.current = sidebarWidth
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [sidebarWidth])

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragging.current) return
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, dragStartW.current + e.clientX - dragStartX.current))
      setSidebarWidth(w)
    }
    function onUp() {
      if (!dragging.current) return
      dragging.current = false
      setSidebarWidth(w => { localStorage.setItem("sidebarWidth", String(w)); return w })
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp) }
  }, [])

  useEffect(() => {
    if (selected) {
      const s = encodeURIComponent(selected.project) + "/" + selected.session
      history.replaceState(null, "", "?s=" + s)
    }
  }, [selected])

  useEffect(() => {
    if (!selected && projects.length > 0 && projects[0].sessions.length > 0) {
      setSelected({ project: projects[0].path, session: projects[0].sessions[0].id })
    }
  }, [projects, selected])

  const activeProject = projects.find(p => p.path === selected?.project)
  const activeMeta = activeProject?.sessions.find(s => s.id === selected?.session)

  return (
    <div className="app">
      <header className="topbar">
        <button className="topbar-menu-btn" onClick={() => setMobileSidebarOpen(o => !o)} title="Sessions">☰</button>
        <span className="topbar-title">Claude Session Viewer</span>
        <div className="topbar-tabs">
          <button className={`topbar-tab ${activeTab === "sessions" ? "active" : ""}`} onClick={() => setActiveTab("sessions")}>Sessions</button>
          {capabilities.debugStream && <button className={`topbar-tab ${activeTab === "debug" ? "active" : ""}`} onClick={() => setActiveTab("debug")}>Debug</button>}
        </div>
        <span className={`conn-badge ${connected ? "conn-on" : "conn-off"}`}>
          {connected ? "● Live" : "○ Polling"}
        </span>
        <button className="topbar-settings-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
      </header>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
<div className="main">
        {activeTab === "sessions" && (
          <>
            <Sidebar
              projects={projects}
              projectsLoading={projectsLoading}
              totalSessions={totalSessions}
              listMode={listMode}
              sessionsTruncated={sessionsTruncated}
              onLoadAllSessions={loadAllSessions}
              selected={selected}
              onSelect={(p, s) => setSelected({ project: p, session: s })}
              width={sidebarWidth}
              onDragStart={onDragStart}
              mobileOpen={mobileSidebarOpen}
              onMobileClose={() => setMobileSidebarOpen(false)}
            />
            <div className="content">
              {activeMeta && activeProject
                ? <SessionPane
                    key={activeMeta.id}
                    projectDir={activeProject.path}
                    sessionMeta={activeMeta}
                    onBack={() => setMobileSidebarOpen(true)}
                    capabilities={capabilities}
                  />
                : <div className="empty-state">Select a session from the sidebar</div>}
            </div>
          </>
        )}
        {activeTab === "debug" && <DebugTab />}
      </div>
    </div>
  )
}
