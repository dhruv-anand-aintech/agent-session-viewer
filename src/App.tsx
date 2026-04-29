import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import type { SessionMessage } from "./types"
import MessageBlock from "./MessageBlock"
import PrettyMessageBlock, { charCountMsg } from "./pretty/PrettyMessageBlock"
import { idbPut, idbGet } from "./idb"
import { runThreadSearch } from "./threadSearch"
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
  source?: "claude" | "cursor" | "opencode" | "antigravity" | "hermes" | "codex" | string
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
  homeDir?: string
}

function useCapabilities(): Capabilities {
  const [caps, setCaps] = useState<Capabilities>({ openPath: false })
  useEffect(() => {
    fetch("/api/capabilities")
      .then(r => (r.ok ? r.json() : {}))
      .then((c: unknown) => {
        const o =
          c && typeof c === "object" && c !== null
            ? (c as Record<string, unknown>)
            : {}
        setCaps({ openPath: !!o.openPath, homeDir: typeof o.homeDir === "string" ? o.homeDir : undefined })
      })
      .catch(() => {})
  }, [])
  return caps
}

const RECENT_SIDEBAR_SESSIONS = 30

function mergeProjectData(existing: ProjectData[], incoming: ProjectData[]): ProjectData[] {
  const projectsByPath = new Map(existing.map(p => [p.path, { ...p, sessions: [...p.sessions] }]))

  for (const project of incoming) {
    const current = projectsByPath.get(project.path)
    if (!current) {
      projectsByPath.set(project.path, { ...project, sessions: [...project.sessions] })
      continue
    }

    current.displayName = project.displayName || current.displayName
    const sessionsById = new Map(current.sessions.map(s => [s.id, s]))
    for (const session of project.sessions) {
      const prev = sessionsById.get(session.id)
      sessionsById.set(session.id, {
        ...prev,
        ...session,
        firstName: session.firstName ?? prev?.firstName,
        customName: session.customName ?? prev?.customName,
      })
    }
    current.sessions = Array.from(sessionsById.values()).sort((a, b) =>
      String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? "")),
    )
  }

  return Array.from(projectsByPath.values()).sort((a, b) =>
    String(b.sessions[0]?.lastActivity ?? "").localeCompare(String(a.sessions[0]?.lastActivity ?? "")),
  )
}

function useProjects() {
  const [projects, setProjects] = useState<ProjectData[]>([])
  const [connected, setConnected] = useState(false)
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [totalSessions, setTotalSessions] = useState<number | null>(null)
  const [listMode, setListMode] = useState<"recent" | "full">("recent")
  const projectsRef = useRef<ProjectData[]>([])

  useEffect(() => {
    projectsRef.current = projects
  }, [projects])

  useEffect(() => {
    const qs = listMode === "recent" ? `?maxSessions=${RECENT_SIDEBAR_SESSIONS}` : ""
    queueMicrotask(() => {
      setProjectsLoading(true)
      if (listMode === "recent" || projectsRef.current.length === 0) setProjects([])
      setTotalSessions(null)
    })
    const es = new EventSource(`/api/stream${qs}`)
    es.onopen = () => setConnected(true)
    es.onerror = () => {
      setConnected(false)
      setProjectsLoading(false)
    }
    es.addEventListener("projects_meta", e => {
      try {
        const o = JSON.parse((e as MessageEvent).data) as { total?: unknown }
        if (typeof o.total === "number") setTotalSessions(o.total)
      } catch {
        /* ignore */
      }
    })
    es.addEventListener("projects", e => {
      try {
        const incoming = JSON.parse((e as MessageEvent).data) as ProjectData[]
        setProjects(prev => mergeProjectData(prev, incoming))
      } catch {
        /* ignore */
      }
    })
    es.addEventListener("bootstrap_done", () => setProjectsLoading(false))
    return () => {
      es.close()
      setProjectsLoading(false)
    }
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

const CHUNK = 60           // messages to load per step (client windowing)
const MAX_DOM = 180        // max messages to keep in DOM at once
const INITIAL_TAIL = 5     // messages to fetch from server on first load
const IDB_KEY = (projectDir: string, sessionId: string) => `sess/${projectDir}/${sessionId}`

interface MsgWindow {
  msgs: SessionMessage[]
  startIdx: number  // index in locally-held array where this window starts
  total: number     // server-side total (may exceed locally-held length)
  serverFetchedFrom: number  // how many msgs from tail have been fetched (locally-held = fullRef.current.length)
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

function sessionUrl(projectDir: string, sessionId: string, tail?: number, skip?: number) {
  const base = `/api/session/${encodeURIComponent(projectDir)}/${sessionId}`
  const params = new URLSearchParams()
  if (tail) params.set("tail", String(tail))
  if (skip) params.set("skip", String(skip))
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

function useWindowedMessages(projectDir: string | null, sessionId: string | null, isActive: boolean) {
  const [win, setWin] = useState<MsgWindow | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [chatDir, setChatDir] = useState<string | null>(null)
  // Locally-held messages (tail of the full session)
  const fullRef = useRef<SessionMessage[]>([])

  const idbKey = projectDir && sessionId ? IDB_KEY(projectDir, sessionId) : null

  const updateChatDir = useCallback((msgs: SessionMessage[]) => {
    const cwd = msgs.find(m => typeof m.cwd === "string" && m.cwd.trim())?.cwd?.trim() ?? null
    setChatDir(cwd)
  }, [])

  const initWindow = useCallback((msgs: SessionMessage[], serverTotal: number) => {
    const filtered = msgs.filter(m => m.type !== "file-history-snapshot")
    fullRef.current = filtered
    updateChatDir(filtered)
    const startIdx = Math.max(0, filtered.length - MAX_DOM)
    // serverFetchedFrom tracks RAW server position — use msgs.length (not filtered) so skip stays aligned
    setWin({ msgs: filtered.slice(startIdx), startIdx, total: serverTotal, serverFetchedFrom: serverTotal - msgs.length })
  }, [updateChatDir])

  // Fetch the tail from server
  const fetchRemote = useCallback(async () => {
    try {
      if (!projectDir || !sessionId || !idbKey) return
      const r = await fetch(sessionUrl(projectDir, sessionId, INITIAL_TAIL), { credentials: "include" })
      if (!r.ok) return
      const serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || 0
      const msgs: SessionMessage[] = await r.json()
      await idbPut(idbKey, msgs)
      initWindow(msgs, serverTotal || msgs.length)
    } catch {
      /* network or parse */
    } finally {
      setLoading(false)
    }
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
        // Show cached without knowing serverTotal — will be corrected by fetchRemote
        initWindow(cached, cached.length)
        setLoading(false)
      }
      await fetchRemote()
    })()
  }, [projectDir, sessionId, idbKey, fetchRemote, initWindow, updateChatDir])

  // Auto-refresh for active sessions — only update window tail with new messages
  useEffect(() => {
    if (!isActive || !projectDir || !sessionId || !idbKey) return
    const t = setInterval(async () => {
      try {
        const r = await fetch(sessionUrl(projectDir, sessionId, INITIAL_TAIL), { credentials: "include" })
        if (!r.ok) return
        const serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || 0
        const msgs: SessionMessage[] = await r.json()
        await idbPut(idbKey, msgs)
        const filtered = msgs.filter(m => m.type !== "file-history-snapshot")
        // Merge new tail: keep any earlier-loaded messages, append new ones
        setWin(prev => {
          if (!prev) {
            const startIdx = Math.max(0, filtered.length - MAX_DOM)
            fullRef.current = filtered
            updateChatDir(filtered)
            return { msgs: filtered.slice(startIdx), startIdx, total: serverTotal || filtered.length, serverFetchedFrom: (serverTotal || filtered.length) - filtered.length }
          }
          // Prepend any older messages we already have that aren't in new tail
          const alreadyHeld = fullRef.current.slice(0, prev.serverFetchedFrom > 0 ? fullRef.current.length - filtered.length : 0)
          const merged = [...alreadyHeld, ...filtered]
          fullRef.current = merged
          updateChatDir(merged)
          const newStart = prev.startIdx
          const newMsgs = merged.slice(newStart)
          if (newMsgs.length > MAX_DOM) {
            const trimStart = newStart + (newMsgs.length - MAX_DOM)
            return { msgs: merged.slice(trimStart), startIdx: trimStart, total: serverTotal || merged.length, serverFetchedFrom: (serverTotal || merged.length) - merged.length }
          }
          return { msgs: newMsgs, startIdx: newStart, total: serverTotal || merged.length, serverFetchedFrom: (serverTotal || merged.length) - merged.length }
        })
      } catch { /* ignore */ }
    }, 4000)
    return () => clearInterval(t)
  }, [isActive, projectDir, sessionId, idbKey, updateChatDir])

  // true if there are more messages to show — either locally-held earlier ones OR unfetched on server
  const hasEarlier = win ? (win.startIdx > 0 || win.serverFetchedFrom > 0) : false
  const hasLater = win ? win.startIdx + win.msgs.length < fullRef.current.length : false

  const loadingEarlierRef = useRef(false)
  const loadingLaterRef = useRef(false)

  async function loadEarlier() {
    if (!win || !projectDir || !sessionId) return
    const full = fullRef.current

    // Case 1: still have locally-held messages earlier in the window
    if (win.startIdx > 0) {
      const newStart = Math.max(0, win.startIdx - adaptivePage(full, win.startIdx))
      const existingEnd = win.startIdx + win.msgs.length
      const newMsgs = full.slice(newStart, existingEnd)
      const trimmed = newMsgs.length > MAX_DOM ? newMsgs.slice(0, MAX_DOM) : newMsgs
      setWin({ ...win, msgs: trimmed, startIdx: newStart })
      return
    }

    // Case 2: need to fetch more from server
    if (win.serverFetchedFrom <= 0) return
    setLoadingMore(true)
    try {
      const skip = win.total - win.serverFetchedFrom  // messages already held from tail
      const r = await fetch(sessionUrl(projectDir, sessionId, CHUNK, skip), { credentials: "include" })
      if (!r.ok) return
      const serverTotal = parseInt(r.headers.get("X-Message-Total") ?? "0") || win.total
      const newMsgs: SessionMessage[] = await r.json()
      const newFiltered = newMsgs.filter(m => m.type !== "file-history-snapshot")
      // Prepend to held messages
      const merged = [...newFiltered, ...full]
      fullRef.current = merged
      // Decrement by raw count (newMsgs.length) not filtered — keeps skip aligned with server position
      const newServerFetchedFrom = Math.max(0, win.serverFetchedFrom - newMsgs.length)
      // Show window ending just before the old start of fullRef
      const newEnd = newFiltered.length + Math.min(win.msgs.length, MAX_DOM - newFiltered.length)
      const startIdx = 0
      setWin({
        msgs: merged.slice(startIdx, Math.min(MAX_DOM, newEnd)),
        startIdx,
        total: serverTotal,
        serverFetchedFrom: newServerFetchedFrom,
      })
    } catch { /* ignore */ }
    finally { setLoadingMore(false) }
  }

  function loadLater() {
    if (!win) return
    const full = fullRef.current
    const currentEnd = win.startIdx + win.msgs.length
    if (currentEnd >= full.length) return
    const newEnd = Math.min(full.length, currentEnd + CHUNK)
    const newMsgs = full.slice(win.startIdx, newEnd)
    if (newMsgs.length > MAX_DOM) {
      const trimStart = win.startIdx + (newMsgs.length - MAX_DOM)
      setWin({ ...win, msgs: full.slice(trimStart, newEnd), startIdx: trimStart })
    } else {
      setWin({ ...win, msgs: newMsgs })
    }
  }

  /** Replace local buffer with a full session fetch (e.g. thread search). */
  const injectFullMessages = useCallback(
    async (all: SessionMessage[]) => {
      const filtered = all.filter(m => m.type !== "file-history-snapshot")
      fullRef.current = filtered
      updateChatDir(filtered)
      const total = filtered.length
      const startIdx = Math.max(0, total - MAX_DOM)
      setWin({
        msgs: filtered.slice(startIdx, Math.min(total, startIdx + MAX_DOM)),
        startIdx,
        total,
        serverFetchedFrom: 0,
      })
      if (idbKey) await idbPut(idbKey, filtered)
    },
    [idbKey, updateChatDir]
  )

  /** Scroll window so message at global index is in DOM, then caller can scrollIntoView on data-msg-index. */
  const bringMessageIndexIntoView = useCallback((targetIdx: number) => {
    setWin(prev => {
      if (!prev) return prev
      const full = fullRef.current
      if (targetIdx < 0 || targetIdx >= full.length) return prev
      if (targetIdx >= prev.startIdx && targetIdx < prev.startIdx + prev.msgs.length) return prev
      const half = Math.floor(MAX_DOM / 2)
      const newStart = Math.min(Math.max(0, targetIdx - half), Math.max(0, full.length - MAX_DOM))
      const end = Math.min(full.length, newStart + MAX_DOM)
      return { ...prev, startIdx: newStart, msgs: full.slice(newStart, end) }
    })
  }, [])

  return {
    win,
    loading,
    loadingMore,
    hasEarlier,
    hasLater,
    loadEarlier,
    loadLater,
    fullRef,
    loadingEarlierRef,
    loadingLaterRef,
    chatDir,
    injectFullMessages,
    bringMessageIndexIntoView,
  }
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
  const {
    win,
    loading,
    loadingMore,
    hasEarlier,
    hasLater,
    loadEarlier,
    loadLater,
    loadingEarlierRef,
    loadingLaterRef,
    chatDir,
    fullRef,
    injectFullMessages,
    bringMessageIndexIntoView,
  } = useWindowedMessages(projectDir, sessionMeta.id, isRecentlyActive(sessionMeta.lastActivity))

  const [threadSearchOpen, setThreadSearchOpen] = useState(false)
  const [threadSearchQuery, setThreadSearchQuery] = useState("")
  const [threadSearchLoading, setThreadSearchLoading] = useState(false)
  const [threadSearchMsgs, setThreadSearchMsgs] = useState<SessionMessage[] | null>(null)
  const [threadHits, setThreadHits] = useState<{ idx: number; text: string; score?: number }[]>([])
  const [threadHitPos, setThreadHitPos] = useState(0)
  const threadSearchInputRef = useRef<HTMLInputElement>(null)

  async function prepareThreadSearch() {
    setThreadSearchOpen(true)
    setThreadSearchLoading(true)
    const localMsgs = fullRef.current.filter(m => m.type !== "file-history-snapshot")
    if (localMsgs.length) {
      setThreadSearchMsgs(localMsgs)
      setThreadSearchQuery("")
      setThreadHits([])
      setThreadHitPos(0)
      setTimeout(() => threadSearchInputRef.current?.focus(), 0)
    }
    try {
      const r = await fetch(`/api/session/${encodeURIComponent(projectDir)}/${sessionMeta.id}`, { credentials: "include" })
      if (!r.ok) return
      const msgs: SessionMessage[] = await r.json()
      const filtered = msgs.filter(m => m.type !== "file-history-snapshot")
      await injectFullMessages(msgs)
      setThreadSearchMsgs(filtered)
      if (!localMsgs.length) {
        setThreadSearchQuery("")
        setThreadHits([])
        setThreadHitPos(0)
        setTimeout(() => threadSearchInputRef.current?.focus(), 0)
      }
    } finally {
      setThreadSearchLoading(false)
    }
  }

  function closeThreadSearch() {
    setThreadSearchOpen(false)
    setThreadSearchQuery("")
    setThreadHits([])
    setThreadHitPos(0)
    setThreadSearchMsgs(null)
  }

  useEffect(() => {
    if (!threadSearchOpen || !threadSearchMsgs?.length) {
      setThreadHits([])
      return
    }
    const q = threadSearchQuery.trim()
    if (!q) {
      setThreadHits([])
      setThreadHitPos(0)
      return
    }
    setThreadHits(runThreadSearch(q, threadSearchMsgs))
    setThreadHitPos(0)
  }, [threadSearchOpen, threadSearchQuery, threadSearchMsgs])

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

  useEffect(() => {
    if (!threadSearchOpen || threadHits.length === 0) return
    const hit = threadHits[threadHitPos]
    if (!hit) return
    bringMessageIndexIntoView(hit.idx)
    let raf = 0
    raf = requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-msg-index="${hit.idx}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
    return () => cancelAnimationFrame(raf)
  }, [threadHitPos, threadHits, threadSearchOpen, bringMessageIndexIntoView])

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
  }, [hasEarlier, win?.startIdx, win?.serverFetchedFrom])

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
  const chatDirLabel = chatDir ?? projectDir

  return (
    <div className="session-pane">
      <div className="session-header" data-tooltip={`${projectDir}/${sessionMeta.id}`}>
        {onBack && <button className="back-btn" onClick={onBack} title="Back to sessions">←</button>}
        <span className="session-id">{sessionMeta.id.slice(0, 8)}</span>
        {chatDirLabel && <span className="session-cwd hide-mobile" title={chatDirLabel}>{chatDirLabel}</span>}
        {capabilities.openPath && (
          <a
            className="session-path-btn hide-mobile"
            href={`/api/raw-jsonl?project=${encodeURIComponent(projectDir)}&session=${sessionMeta.id}`}
            title={capabilities.homeDir ? `${capabilities.homeDir}/.claude/projects/${projectDir}/${sessionMeta.id}.jsonl` : `${sessionMeta.id}.jsonl`}
            target="_blank"
            rel="noreferrer"
          >
            {sessionMeta.id.slice(0, 8)}.jsonl
          </a>
        )}
        {loading && win && <span className="session-refreshing" title="Refreshing…" />}
        {sessionMeta.gitBranch && <span className="git-branch hide-mobile">⎇ {sessionMeta.gitBranch}</span>}
        {isRecentlyActive(sessionMeta.lastActivity) && <span className="active-badge">● Live</span>}
        <span className="msg-count hide-mobile">{sessionMeta.messageCount} messages</span>
        <button
          type="button"
          className={`user-nav-btn thread-search-toggle ${threadSearchOpen ? "active" : ""}`}
          onClick={() => (threadSearchOpen ? closeThreadSearch() : void prepareThreadSearch())}
          title={threadSearchOpen ? "Close thread search" : "Search messages in this thread"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.5"/><line x1="9.3" y1="9.3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
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
      {threadSearchOpen && (
        <div className="thread-search-panel">
          <input
            ref={threadSearchInputRef}
            className="thread-search-input"
            placeholder="Search this thread…"
            value={threadSearchQuery}
            onChange={e => setThreadSearchQuery(e.target.value)}
            aria-label="Search messages in this thread"
          />
          {threadSearchLoading ? (
            <span className="thread-search-meta">Loading full transcript…</span>
          ) : threadHits.length > 0 ? (
            <>
              <span className="thread-search-meta">
                Match {Math.min(threadHitPos + 1, threadHits.length)} of {threadHits.length}
              </span>
              <button type="button" className="thread-search-step" onClick={() => setThreadHitPos(p => (p - 1 + threadHits.length) % threadHits.length)} title="Previous match (↑)">
                ◀
              </button>
              <button type="button" className="thread-search-step" onClick={() => setThreadHitPos(p => (p + 1) % threadHits.length)} title="Next match (↓)">
                ▶
              </button>
            </>
          ) : threadSearchMsgs && threadSearchQuery.trim() ? (
            <span className="thread-search-meta muted">No matches</span>
          ) : threadSearchMsgs ? (
            <span className="thread-search-meta muted">Type to search.</span>
          ) : null}
          <button type="button" className="thread-search-close" onClick={closeThreadSearch} title="Close">
            ✕
          </button>
        </div>
      )}
<div className="messages-scroll" ref={scrollRef} onScroll={handleScroll}>
        {loading && !win && <div className="loading-state">Loading messages…</div>}
        {loadingMore && <div className="loading-state loading-state--more">Loading earlier messages…</div>}
        {!loading && hasEarlier && (
          <div>
            <div ref={topSentinelRef} style={{ height: 1 }} />
            <div className="load-more-wrap">
              <button className="load-more-pill" onClick={loadEarlierPreserveScroll} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "↑ Load earlier messages"}
                <span className="load-more-count">{(win?.serverFetchedFrom ?? 0) + startIdx} remaining</span>
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
            <div key={msg.uuid ?? i} className={sugg ? "msg-with-suggestion" : undefined} data-msg-index={startIdx + i}>
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

// ── Platform chrome (sidebar icons + filter pills share hue tokens in App.css) ─

function platformIconLabel(source?: string): string {
  switch (source ?? "claude") {
    case "cursor":
      return "Cursor"
    case "opencode":
      return "OpenCode"
    case "antigravity":
      return "Antigravity"
    case "hermes":
      return "Hermes"
    case "codex":
      return "Codex"
    default:
      return "Claude"
  }
}

function platformIconSrc(source?: string): string | null {
  switch (source ?? "claude") {
    case "claude":
      return "https://www.google.com/s2/favicons?sz=64&domain=claude.ai"
    case "cursor":
      return "https://www.google.com/s2/favicons?sz=64&domain=cursor.com"
    case "opencode":
      return "https://www.google.com/s2/favicons?sz=64&domain=opencode.ai"
    case "codex":
      return "https://www.google.com/s2/favicons?sz=64&domain=openai.com"
    default:
      return null
  }
}

function platformFallbackGlyph(source?: string): string {
  switch (source ?? "claude") {
    case "cursor":
      return "⌁"
    case "opencode":
      return "</>"
    case "antigravity":
      return "◌"
    case "hermes":
      return "⚚"
    case "codex":
      return "{}"
    default:
      return "C"
  }
}

function AgentIcon({ source }: { source?: string }) {
  const [failed, setFailed] = useState(false)
  const src = platformIconSrc(source)
  const label = platformIconLabel(source)

  if (src && !failed) {
    return (
      <img
        className="platform-icon"
        src={src}
        alt={label}
        title={label}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <span className="platform-icon platform-icon-fallback" title={label} aria-label={label} role="img">
      {platformFallbackGlyph(source)}
    </span>
  )
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

function SessionItem({ s, projectPath, isSelected, onSelect, subagentCount, subagentsExpanded, onToggleSubagents, searchHint }: {
  s: SessionMeta
  projectPath: string
  isSelected: boolean
  onSelect: () => void
  subagentCount?: number
  subagentsExpanded?: boolean
  onToggleSubagents?: () => void
  /** When set (e.g. global search), show a second line under the title. */
  searchHint?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [customName, setCustomName] = useState<string | undefined>(s.customName)
  const inputRef = useRef<HTMLInputElement>(null)

  const displayName = customName || s.firstName || s.id.slice(0, 8)
  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setDraft(customName ?? s.firstName ?? "")
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  async function commitRename() {
    setEditing(false)
    const name = draft.trim()
    if (name === (customName ?? "")) return  // no change
    await fetch(`/api/names/${encodeURIComponent(projectPath)}/${s.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name }),
    })
    setCustomName(name || undefined)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitRename()
    if (e.key === "Escape") setEditing(false)
  }

  return (
    <div
      className={`sidebar-session ${isSelected ? "active" : ""} ${s.isSidechain ? "sidechain" : ""} ${searchHint ? "sidebar-session--multiline" : ""}`}
      onClick={onSelect}
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
          <span className="platform-icon-wrap" aria-hidden="true">
            <AgentIcon source={s.source} />
          </span>
          {isRecentlyActive(s.lastActivity) && <span className="ss-live">●</span>}
          {s.isSidechain && <span className="ss-subagent-icon" title="Sub-agent session">⤷</span>}
          <span className="ss-name">{displayName}</span>
          {searchHint && <div className="ss-search-hint" title={searchHint}>{searchHint}</div>}
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

function searchFieldLabel(key: string): string {
  switch (key) {
    case "title":
      return "Title"
    case "firstUser":
      return "First user"
    case "allUser":
      return "User"
    case "system":
      return "System"
    case "assistant":
      return "Assistant"
    default:
      return key
  }
}

interface SidebarSearchHit {
  projectPath: string
  sessionId: string
  displayTitle: string
  bestKey: string
  snippet: string
  meta: SessionMeta
}

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

  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("")
  const [sidebarSearchLoading, setSidebarSearchLoading] = useState(false)
  const [sidebarSearchHits, setSidebarSearchHits] = useState<SidebarSearchHit[] | null>(null)

  useEffect(() => {
    const q = sidebarSearchQuery.trim()
    if (!q) return
    let cancelled = false
    setSidebarSearchLoading(true)
    fetch(`/api/search/sessions?q=${encodeURIComponent(q)}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : { results: [] }))
      .then((data: { results?: Record<string, unknown>[] }) => {
        if (cancelled) return
        const mapped: SidebarSearchHit[] = (data.results ?? []).map(raw => ({
          projectPath: String(raw.projectPath ?? ""),
          sessionId: String(raw.sessionId ?? ""),
          displayTitle: String(raw.displayTitle ?? ""),
          bestKey: String(raw.bestKey ?? ""),
          snippet: String(raw.snippet ?? ""),
          meta: raw.meta as SessionMeta,
        }))
        setSidebarSearchHits(mapped)
      })
      .catch(() => {
        if (!cancelled) setSidebarSearchHits([])
      })
      .finally(() => {
        if (!cancelled) setSidebarSearchLoading(false)
      })
    return () => { cancelled = true }
  }, [sidebarSearchQuery])

  const searchBrowseActive = sidebarSearchQuery.trim().length > 0
  const filteredSearchHits = (sidebarSearchHits ?? []).filter(
    h => platformFilter === "all" || (h.meta.source ?? "claude") === platformFilter
  )

  // Instant title-match from already-loaded sessions — shown while API search is in flight
  const titleMatchSessions = useMemo(() => {
    const q = sidebarSearchQuery.trim().toLowerCase()
    if (!q) return []
    return projects.flatMap(p =>
      p.sessions
        .filter(s => {
          if (platformFilter !== "all" && (s.source ?? "claude") !== platformFilter) return false
          const title = (s.customName ?? s.firstName ?? s.id).toLowerCase()
          return title.includes(q)
        })
        .map(s => ({ s, projectPath: p.path }))
    )
  }, [sidebarSearchQuery, projects, platformFilter])

  function toggleGrouped(val: boolean) {
    setGrouped(val)
    localStorage.setItem("sidebarGrouped", String(val))
  }

  function toggleParent(id: string) {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
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

  const listedSessionCount = projects.reduce((n, p) => n + p.sessions.length, 0)
  const moreSessionsHidden =
    totalSessions != null && listMode === "recent" ? Math.max(0, totalSessions - listedSessionCount) : 0

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onMobileClose} />}
    <nav className={`sidebar${mobileOpen ? " mobile-open" : ""}`} style={isMobile ? undefined : { width }}>
      <div className="sidebar-top">
        <div className="sidebar-title">
          Sessions
          <div className="sidebar-view-toggle">
            <button className={`sidebar-view-btn ${!grouped ? "active" : ""}`} onClick={() => toggleGrouped(false)}>Flat</button>
            <button className={`sidebar-view-btn ${grouped ? "active" : ""}`} onClick={() => toggleGrouped(true)}>Groups</button>
          </div>
        </div>
        {showPlatformFilter && (
          <div className="sidebar-platform-filter">
            {["all", ...presentPlatforms].map(p => (
              <button
                key={p}
                type="button"
                className={`sidebar-platform-btn ${platformFilter === p ? platformFilterActiveClass(p) : ""}`}
                onClick={() => setPlatformFilter(p)}
              >
                {p === "all" ? "All" : p === "claude" ? "Claude" : p === "cursor" ? "Cursor" : p === "opencode" ? "OpenCode" : p === "antigravity" ? "Antigravity" : p === "hermes" ? "Hermes" : p === "codex" ? "Codex" : p}
              </button>
            ))}
          </div>
        )}
        <div className="sidebar-search-row">
          <span className="sidebar-search-icon" aria-hidden><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="5.5" cy="5.5" r="3.75" stroke="currentColor" strokeWidth="1.4"/><line x1="8.6" y1="8.6" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>
          <input
            type="search"
            className="sidebar-search-input"
            placeholder="Search threads…"
            value={sidebarSearchQuery}
            onChange={e => {
              const v = e.target.value
              setSidebarSearchQuery(v)
              if (!v.trim()) {
                setSidebarSearchHits(null)
                setSidebarSearchLoading(false)
              }
            }}
            aria-label="Search all threads"
          />
          {sidebarSearchQuery ? (
            <button
              type="button"
              className="sidebar-search-clear"
              onClick={() => {
                setSidebarSearchQuery("")
                setSidebarSearchHits(null)
                setSidebarSearchLoading(false)
              }}
              title="Clear search"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>
      <div className="sidebar-body">
        <div className="sidebar-sessions-scroll">
        {searchBrowseActive ? (
          <>
            {sidebarSearchLoading && (
              <div className="sidebar-empty">
                <span className="sidebar-spinner" />
                Searching…
              </div>
            )}
            {/* While API search is loading, show instant title matches so nothing disappears */}
            {sidebarSearchLoading && titleMatchSessions.map(({ s, projectPath }) => (
              <SessionItem
                key={s.id}
                s={s}
                projectPath={projectPath}
                isSelected={selected?.session === s.id && selected?.project === projectPath}
                onSelect={() => handleSelect(projectPath, s.id)}
              />
            ))}
            {!sidebarSearchLoading && sidebarSearchHits !== null && filteredSearchHits.length === 0 && titleMatchSessions.length === 0 && (
              <div className="sidebar-empty">No threads match your search.</div>
            )}
            {/* API results arrived: show them; title-only matches not in API results fall through */}
            {!sidebarSearchLoading && sidebarSearchHits !== null && filteredSearchHits.length > 0 &&
              filteredSearchHits.map(hit => (
                <SessionItem
                  key={`${hit.projectPath}/${hit.sessionId}`}
                  s={{ ...hit.meta, id: hit.meta.id ?? hit.sessionId }}
                  projectPath={hit.projectPath}
                  isSelected={selected?.session === hit.sessionId && selected?.project === hit.projectPath}
                  onSelect={() => handleSelect(hit.projectPath, hit.sessionId)}
                  searchHint={[searchFieldLabel(hit.bestKey), hit.snippet].filter(Boolean).join(" · ") || undefined}
                />
              ))}
            {/* API returned no hits but title matches exist — show them */}
            {!sidebarSearchLoading && (sidebarSearchHits === null || filteredSearchHits.length === 0) && titleMatchSessions.map(({ s, projectPath }) => (
              <SessionItem
                key={s.id}
                s={s}
                projectPath={projectPath}
                isSelected={selected?.session === s.id && selected?.project === projectPath}
                onSelect={() => handleSelect(projectPath, s.id)}
              />
            ))}
          </>
        ) : grouped ? (
          projects
            .map(project => ({
              ...project,
              sessions: project.sessions.filter(s => platformFilter === "all" || (s.source ?? "claude") === platformFilter),
            }))
            .filter(p => p.sessions.length > 0)
            .map(project => (
              <div key={project.path} className="sidebar-project">
              <div className="sidebar-project-name" data-tooltip={project.path}>{project.displayName}</div>
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
        {projectsLoading && projects.length === 0 && !searchBrowseActive && (
          <div className="sidebar-empty">
            <span className="sidebar-spinner" />
            {sessionsTruncated || listMode === "recent"
              ? "Loading recent sessions…"
              : totalSessions != null
                ? `Loading ${totalSessions} sessions…`
                : "Loading…"}
          </div>
        )}
        {!projectsLoading && projects.length === 0 && !searchBrowseActive && <div className="sidebar-empty">No sessions found</div>}
        </div>
        {sessionsTruncated && totalSessions != null && moreSessionsHidden > 0 && !searchBrowseActive && (
          <div className="sidebar-load-more">
            <button
              type="button"
              className="sidebar-load-more-btn"
              onClick={onLoadAllSessions}
              title="Load every session into the sidebar (slower for very large libraries)"
            >
              <span className="sidebar-load-more-label">Load older sessions</span>
              <span className="sidebar-load-more-meta">
                {moreSessionsHidden} more of {totalSessions} total
              </span>
            </button>
          </div>
        )}
      </div>
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
  const raw = new URLSearchParams(window.location.search).get("s")
  if (!raw) return null
  const m = /^([\s\S]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw)
  if (m) {
    try {
      return { project: decodeURIComponent(m[1]), session: m[2] }
    } catch {
      return null
    }
  }
  const slash = raw.lastIndexOf("/")
  if (slash < 1) return null
  try {
    return { project: decodeURIComponent(raw.slice(0, slash)), session: raw.slice(slash + 1) }
  } catch {
    return null
  }
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

  const defaultProject = !selected ? projects[0]?.path ?? null : null
  const defaultSession = !selected ? projects[0]?.sessions[0]?.id ?? null : null
  const activeProjectPath = selected?.project ?? defaultProject
  const activeSessionId = selected?.session ?? defaultSession

  useEffect(() => {
    if (!activeProjectPath || !activeSessionId) return
    const s = encodeURIComponent(activeProjectPath) + "/" + activeSessionId
    history.replaceState(null, "", "?s=" + s)
  }, [activeProjectPath, activeSessionId])

  const activeProject = projects.find(p => p.path === activeProjectPath)
  const activeMeta = activeProject?.sessions.find(s => s.id === activeSessionId)

  // When loading from a URL param (?s=), the target session may not be in the sidebar yet
  // (e.g. Cursor loads in the slow SSE path). Render the pane immediately with a stub so
  // messages start loading without waiting for metadata to arrive.
  const effectiveMeta: SessionMeta | null =
    activeMeta ?? (selected && activeSessionId
      ? { id: activeSessionId, projectPath: selected.project, lastActivity: "", isActive: false, messageCount: 0,
          source: selected.project.startsWith("cursor:") ? "cursor"
            : selected.project.startsWith("opencode:") ? "opencode"
            : selected.project.startsWith("codex:") ? "codex"
            : selected.project.startsWith("hermes:") ? "hermes"
            : selected.project.startsWith("antigravity:") ? "antigravity"
            : "claude" }
      : null)
  const effectiveProjectPath = activeProject?.path ?? (selected ? selected.project : null)

  return (
    <div className="app">
      <header className="topbar">
        <button className="topbar-menu-btn" onClick={() => setMobileSidebarOpen(o => !o)} title="Sessions">☰</button>
        <span className="topbar-title">Agent Session Viewer</span>
        <div className="topbar-tabs">
          <button className="topbar-tab active">Sessions</button>
        </div>
        <span className={`conn-badge ${connected ? "conn-on" : "conn-off"}`}>
          {connected ? "● Live" : "○ Polling"}
        </span>
        <button className="topbar-settings-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
      </header>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
<div className="main">
        {(
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
              {effectiveMeta && effectiveProjectPath
                ? <SessionPane
                    key={effectiveMeta.id}
                    projectDir={effectiveProjectPath}
                    sessionMeta={effectiveMeta}
                    onBack={() => setMobileSidebarOpen(true)}
                    capabilities={capabilities}
                  />
                : <div className="empty-state">Select a session from the sidebar</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
