import { useState, useEffect, useRef, useCallback } from "react"

// Module-level thread search cache: key = "projectPath\\x1fsessionId\\x1fquery" -> hits[]
const _threadCache = new Map<string, { hits: ThreadSearchHit[] }>()
import type { SessionMessage, SessionMeta, Capabilities } from "./types"
import MessageBlock from "./MessageBlock"
import PrettyMessageBlock from "./pretty/PrettyMessageBlock"
import { runThreadSearch } from "./threadSearch"
import { highlightTermsInPlainText } from "./searchHighlight"
import { createPinnedProjectPath, getLoadEarlierControlState } from "./sessionPaneState"
import { markFirstPaint, markSessionClick } from "./perf"
import { isRecentlyActive, wallClock } from "./utils"
import { debugLog, debugWarn } from "./debug-trace"
import { useWindowedMessages } from "./useWindowedMessages"

type Suggestion = { parentUuid: string; text: string; id: string }
type ThreadSearchHit = { idx: number; text: string; uuid?: string; score?: number }

/** Extract a snippet centered around the first match of the query in text. */
function extractMatchSnippet(text: string, query: string, maxLen: number): string {
  if (!text) return ""
  const q = query.trim().toLowerCase()
  if (!q) return text.slice(0, maxLen)
  const idx = text.toLowerCase().indexOf(q)
  if (idx === -1) return text.slice(0, maxLen)
  // Center a window around the match
  const half = Math.floor(maxLen / 2)
  const start = Math.max(0, idx - half)
  const end = Math.min(text.length, start + maxLen)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  return prefix + text.slice(start, end) + suffix
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function cwdFromProjectPath(projectPath: string, chatDir: string | null): string | null {
  if (chatDir?.startsWith("/")) return chatDir
  if (projectPath.includes("/.claude/projects/")) return null
  const prefixed = projectPath.match(/^[a-z-]+:(\/.+)$/)
  if (prefixed) return prefixed[1]
  if (projectPath.startsWith("/")) return projectPath
  return null
}

function resumeCommandForSession(projectPath: string, sessionMeta: SessionMeta, chatDir: string | null): string | null {
  const source = sessionMeta.source ?? (projectPath.includes(":") && !projectPath.startsWith("/") ? projectPath.split(":")[0] : "claude")
  const id = shellQuote(sessionMeta.id)
  let command: string | null = null
  switch (source) {
    case "claude":
      command = `claude --resume ${id}`
      break
    case "codex":
      command = `codex resume ${id}`
      break
    case "cursor-agent":
      command = `cursor-agent --resume ${id}`
      break
    case "opencode":
      command = `opencode --session ${id}`
      break
    case "gemini":
      command = `gemini --resume ${id}`
      break
    default:
      return null
  }
  const cwd = cwdFromProjectPath(projectPath, chatDir)
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command
}

function ThreadSearchResultCard({
  hit,
  active,
  query,
  prettyMode,
  projectDir,
  sessionId,
  source,
  onSelect,
}: {
  hit: ThreadSearchHit
  active: boolean
  query: string
  prettyMode: boolean
  projectDir: string
  sessionId: string
  source?: string
  onSelect: () => void
}) {
  const [payload, setPayload] = useState<{ msg: SessionMessage; nextMsg?: SessionMessage | null; index: number } | null>(null)
  const summary = extractMatchSnippet(hit.text, query, 220)

  useEffect(() => {
    if (!hit.uuid) {
      setPayload(null)
      return
    }
    const controller = new AbortController()
    setPayload(null)
    fetch(
      `/api/session-message?project=${encodeURIComponent(projectDir)}&session=${encodeURIComponent(sessionId)}&uuid=${encodeURIComponent(hit.uuid)}`,
      { credentials: "include", signal: controller.signal },
    )
      .then(r => (r.ok ? r.json() : null))
      .then((data: { msg?: SessionMessage; nextMsg?: SessionMessage | null; index?: number } | null) => {
        if (controller.signal.aborted || !data?.msg) return
        setPayload({
          msg: data.msg,
          nextMsg: data.nextMsg ?? null,
          index: typeof data.index === "number" ? data.index : hit.idx,
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) setPayload(null)
      })
    return () => controller.abort()
  }, [hit.uuid, hit.idx, projectDir, sessionId])

  return (
    <div className={`thread-search-result-card ${prettyMode ? "thread-search-result-card--pretty" : "thread-search-result-card--raw"} ${active ? "active" : ""}`}>
      <button type="button" className="thread-search-result-card-head" onClick={onSelect}>
        <div className="thread-search-result-card-meta">
          <span>Msg {hit.idx + 1}</span>
          {hit.uuid ? <span className="thread-search-result-card-id">{hit.uuid.slice(0, 8)}</span> : null}
        </div>
        <div className="thread-search-result-card-snippet">
          {highlightTermsInPlainText(summary, query)}
        </div>
      </button>
      <div className="thread-search-result-card-body">
        {payload ? (
          prettyMode ? (
            <PrettyMessageBlock msg={payload.msg} index={payload.index} nextMsg={payload.nextMsg ?? undefined} source={source} />
          ) : (
            <MessageBlock msg={payload.msg} index={payload.index} nextMsg={payload.nextMsg ?? undefined} source={source} />
          )
        ) : (
          <div className="thread-search-result-loading">Loading exact message…</div>
        )}
      </div>
    </div>
  )
}

function wordOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().match(/\b\w{4,}\b/g) ?? [])
  const wa = words(a), wb = words(b)
  let hits = 0
  wa.forEach(w => { if (wb.has(w)) hits++ })
  return wa.size ? hits / wa.size : 0
}

export function SessionPane({ projectDir, sessionMeta, onBack, capabilities, initialQuery }: { projectDir: string; sessionMeta: SessionMeta; onBack?: () => void; capabilities: Capabilities; initialQuery?: string }) {
  const paintLogged = useRef(false)
  const stableProjectDirRef = useRef(createPinnedProjectPath(projectDir))
  const stableProjectDir = stableProjectDirRef.current.current

  useEffect(() => {
    if (stableProjectDirRef.current.diverges(projectDir)) {
      debugLog(`[session-state ${wallClock()}] ${sessionMeta.id.slice(0, 8)} project-path-diverged mounted=${stableProjectDirRef.current.current} prop=${projectDir}`)
    }
  }, [projectDir, sessionMeta.id])

  const {
    win,
    loading,
    loadingMore,
    initialRemotePending,
    hasEarlier,
    hasLater,
    loadEarlier,
    loadLater,
    loadFirstPage,
    loadError,
    loadingEarlierRef,
    loadingLaterRef,
    chatDir,
    fullRef,
    bringMessageIndexIntoView,
    jumpToUuid,
    newMsgUuids,
  } = useWindowedMessages(stableProjectDir, sessionMeta.id, isRecentlyActive(sessionMeta.lastActivity))
  const winRef = useRef(win)
  useEffect(() => { winRef.current = win }, [win])

  const [threadSearchOpen, setThreadSearchOpen] = useState(false)
  const [threadSearchQuery, setThreadSearchQuery] = useState("")
  const [threadSearchLoading, setThreadSearchLoading] = useState(false)
  const [threadSearchMsgs, setThreadSearchMsgs] = useState<SessionMessage[] | null>(null)
  const [threadHits, setThreadHits] = useState<ThreadSearchHit[]>([])
  const [threadHitPos, setThreadHitPos] = useState(0)
  const threadSearchInputRef = useRef<HTMLInputElement>(null)
  const initialQueryApplied = useRef(false)

  // Auto-open thread search with initialQuery (from global search navigation)
  useEffect(() => {
    if (!initialQuery || initialQueryApplied.current) return
    if (fullRef.current.length === 0) return // wait for messages
    initialQueryApplied.current = true
    setThreadSearchOpen(true)
    setThreadSearchMsgs(fullRef.current.filter(m => m.type !== "file-history-snapshot"))
    setThreadSearchQuery(initialQuery)
    setThreadHits([])
    setThreadHitPos(0)
  }, [initialQuery, win]) // re-check when win loads

  async function prepareThreadSearch() {
    setThreadSearchOpen(true)
    setThreadSearchLoading(false)
    setThreadSearchMsgs(fullRef.current.filter(m => m.type !== "file-history-snapshot"))
    setThreadSearchQuery("")
    setThreadHits([])
    setThreadHitPos(0)
    debugLog(`[thread-search] panel open project=${stableProjectDir} session=${sessionMeta.id} loaded=${fullRef.current.length}`)
    setTimeout(() => threadSearchInputRef.current?.focus(), 0)
  }

  function closeThreadSearch() {
    setThreadSearchOpen(false)
    setThreadSearchQuery("")
    setThreadHits([])
    setThreadHitPos(0)
    setThreadSearchMsgs(null)
  }

  useEffect(() => {
    if (!threadSearchOpen) {
      setThreadHits([])
      return
    }
    const q = threadSearchQuery.trim()
    if (!q) {
      setThreadHits([])
      setThreadHitPos(0)
      setThreadSearchLoading(false)
      return
    }

    const cacheKey = `${stableProjectDir}\x1f${sessionMeta.id}\x1f${q.toLowerCase()}`
    const cached = _threadCache.get(cacheKey)
    if (cached) {
      setThreadHits(cached.hits)
      setThreadHitPos(0)
      setThreadSearchLoading(false)
      return
    }

    let cancelled = false
    const runSearch = async () => {
      const requestStartedAt = performance.now()
      setThreadSearchLoading(true)
      try {
        const r = await fetch(
          `/api/search/thread?project=${encodeURIComponent(stableProjectDir)}&session=${encodeURIComponent(sessionMeta.id)}&q=${encodeURIComponent(q)}`,
          { credentials: "include" }
        )
        if (!cancelled && r.ok) {
          const data = await r.json()
          if (data.hits && Array.isArray(data.hits) && data.hits.length) {
            const hits = [...data.hits].sort((a, b) => b.idx - a.idx)
            _threadCache.set(cacheKey, { hits })
            setThreadHits(hits)
            setThreadHitPos(0)
            debugLog(`[thread-search] results=${hits.length} source=server ms=${(performance.now() - requestStartedAt).toFixed(1)} q="${q}"`)
            if (!cancelled) setThreadSearchLoading(false)
            return
          }
        }
      } catch (e) {
        debugWarn(`[thread-search] server search error q="${q}":`, e)
      }

      if (!cancelled) {
        const raw = runThreadSearch(q, threadSearchMsgs ?? [])
        raw.sort((a, b) => b.idx - a.idx)
        _threadCache.set(cacheKey, { hits: raw })
        setThreadHits(raw)
        setThreadHitPos(0)
        debugLog(`[thread-search] results=${raw.length} source=local ms=${(performance.now() - requestStartedAt).toFixed(1)} q="${q}"`)
      }
      if (!cancelled) setThreadSearchLoading(false)
    }

    runSearch()
    return () => { cancelled = true }
  }, [threadSearchOpen, threadSearchQuery, threadSearchMsgs, stableProjectDir, sessionMeta?.id])

  const visible = win?.msgs ?? []
  const total = win?.total ?? 0
  const startIdx = win?.startIdx ?? 0
  const globalOffset = win?.globalOffset ?? 0

  useEffect(() => {
    if (!threadSearchOpen || threadHits.length === 0) return
    const hit = threadHits[threadHitPos]
    if (!hit) return
    if (hit.uuid) {
      void jumpToUuid(hit.uuid, scrollRef.current)
    } else {
      bringMessageIndexIntoView(hit.idx)
      requestAnimationFrame(() => {
        scrollRef.current?.querySelector(`[data-msg-index="${globalOffset + hit.idx}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      })
    }
  }, [threadHitPos, threadHits, threadSearchOpen, bringMessageIndexIntoView, jumpToUuid, globalOffset])

  async function focusThreadHit(hit: { idx: number; text: string; uuid?: string }) {
    debugLog(`[thread-search] focus idx=${hit.idx} uuid=${hit.uuid ?? "n/a"}`)
    if (hit.uuid) {
      await jumpToUuid(hit.uuid, scrollRef.current)
    }
  }

  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({})
  useEffect(() => {
    fetch(`/api/suggestions/${encodeURIComponent(stableProjectDir)}/${sessionMeta.id}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then((list: Suggestion[]) => {
        const map: Record<string, Suggestion> = {}
        list.forEach(s => { if (s.parentUuid) map[s.parentUuid] = s })
        setSuggestions(map)
      }).catch(() => {})
  }, [stableProjectDir, sessionMeta.id])

  const bottomRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [prettyMode, setPrettyMode] = useState(true)
  const pendingPrevNav = useRef(false)
  const initialScrollDone = useRef(false)

  useEffect(() => {
    if (win && !initialScrollDone.current) {
      initialScrollDone.current = true
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [win])

  useEffect(() => {
    if (!win || win.msgs.length === 0 || paintLogged.current) return
    paintLogged.current = true
    requestAnimationFrame(() => markFirstPaint(sessionMeta.id, win.msgs.length))
  }, [win, sessionMeta.id])

  const prevWinLenRef = useRef(0)
  useEffect(() => {
    if (!win || !initialScrollDone.current) return
    const newLen = win.msgs.length
    if (autoScroll && newLen > prevWinLenRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
    prevWinLenRef.current = newLen
  }, [win, autoScroll])

  useEffect(() => {
    if (!win) return
    debugLog(`[session-state ${wallClock()}] ${sessionMeta.id.slice(0, 8)} project=${stableProjectDir} hasEarlier=${hasEarlier} hasLater=${hasLater} loading=${loading} loadingMore=${loadingMore} initialRemotePending=${initialRemotePending} win=${win.msgs.length}/${win.total} serverFetchedFrom=${win.serverFetchedFrom}`)
  }, [win, hasEarlier, hasLater, loading, loadingMore, initialRemotePending, stableProjectDir, sessionMeta.id])

  const loadEarlierControl = getLoadEarlierControlState(win, loadingMore, initialRemotePending)

  const lastScrollRef = useRef<{ dir: "up" | "down"; time: number; scrollTop: number } | null>(null)

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const now = Date.now()
    const prev = lastScrollRef.current
    const dir = prev && el.scrollTop < prev.scrollTop ? "up" : "down"
    lastScrollRef.current = { dir, time: now, scrollTop: el.scrollTop }
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

  useEffect(() => {
    if (!hasEarlier) return
    const sentinel = topSentinelRef.current
    if (!sentinel) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || loadingEarlierRef.current) return
        const scroll = lastScrollRef.current
        const hasUpPressure = scroll && scroll.dir === "up" && Date.now() - scroll.time < 2000
        if (!hasUpPressure) return
        loadingEarlierRef.current = true
        loadEarlierPreserveScroll()
        setTimeout(() => { loadingEarlierRef.current = false }, 400)
      },
      { root: scrollRef.current, threshold: 0.1 }
    )
    obs.observe(sentinel)
    return () => obs.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEarlier, win?.startIdx, win?.serverFetchedFrom])

  useEffect(() => {
    if (!hasLater) return
    const sentinel = bottomSentinelRef.current
    if (!sentinel) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || loadingLaterRef.current) return
        const scroll = lastScrollRef.current
        const hasDownPressure = scroll && scroll.dir === "down" && Date.now() - scroll.time < 2000
        if (!hasDownPressure) return
        loadingLaterRef.current = true
        loadLater()
        setTimeout(() => { loadingLaterRef.current = false }, 400)
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

  async function jumpToFirst() {
    if (win && win.startIdx === 0 && !hasEarlier) {
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })
    } else {
      await loadFirstPage()
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })
      })
    }
  }

  const chatDirLabel = chatDir ?? stableProjectDir
  const resumeCommand = resumeCommandForSession(stableProjectDir, sessionMeta, chatDir)
  const [resumeCopied, setResumeCopied] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)

  async function copyResumeCommand() {
    if (!resumeCommand) return
    await navigator.clipboard.writeText(resumeCommand)
    setResumeCopied(true)
    window.setTimeout(() => setResumeCopied(false), 1400)
  }

  async function copyShareLink() {
    const shareUrl = `${window.location.origin}/?s=${encodeURIComponent(stableProjectDir)}/${sessionMeta.id}`
    await navigator.clipboard.writeText(shareUrl)
    setShareCopied(true)
    window.setTimeout(() => setShareCopied(false), 1400)
  }

  return (
    <div className="session-pane">
      <div className="session-header" data-tooltip={`${stableProjectDir}/${sessionMeta.id}`}>
        {onBack && <button className="back-btn" onClick={onBack} title="Back to sessions">←</button>}
        <span className="session-id">{sessionMeta.id.slice(0, 8)}</span>
        {chatDirLabel && <span className="session-cwd hide-mobile" title={chatDirLabel}>{chatDirLabel}</span>}
        {capabilities.openPath && (
          <a
            className="session-path-btn hide-mobile"
            href={`/api/raw-jsonl?project=${encodeURIComponent(stableProjectDir)}&session=${sessionMeta.id}`}
            title={capabilities.homeDir ? `${capabilities.homeDir}/.claude/projects/${stableProjectDir}/${sessionMeta.id}.jsonl` : `${sessionMeta.id}.jsonl`}
            target="_blank"
            rel="noreferrer"
          >
            {sessionMeta.id.slice(0, 8)}.jsonl
          </a>
        )}
        <a
          className="session-path-btn context-snapshot-btn hide-mobile"
          href={`/api/context-snapshot?project=${encodeURIComponent(stableProjectDir)}&session=${encodeURIComponent(sessionMeta.id)}`}
          title="Open context usage snapshot"
          target="_blank"
          rel="noreferrer"
        >
          Context
        </a>
        {resumeCommand && (
          <button
            type="button"
            className={`session-path-btn resume-copy-btn ${resumeCopied ? "copied" : ""}`}
            onClick={() => void copyResumeCommand()}
            title={resumeCopied ? "Copied resume command" : resumeCommand}
            aria-label="Copy resume command"
          >
            {resumeCopied ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M2.5 7.2 5.4 10 11.5 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <rect x="4.25" y="2.25" width="6.75" height="8.75" rx="1.25" stroke="currentColor" strokeWidth="1.3" />
                <path d="M3 4.1H2.6c-.7 0-1.1.4-1.1 1.1v6.2c0 .7.4 1.1 1.1 1.1h5.1c.7 0 1.1-.4 1.1-1.1V11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            )}
          </button>
        )}
        <button
          type="button"
          className={`session-path-btn resume-copy-btn ${shareCopied ? "copied" : ""}`}
          onClick={() => void copyShareLink()}
          title={shareCopied ? "Copied share link" : "Copy share link"}
          aria-label="Copy share link"
        >
          {shareCopied ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2.5 7.2 5.4 10 11.5 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M5.6 8.4 8.4 5.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M6.6 3.4 7.8 2.2a2.6 2.6 0 0 1 3.7 3.7L10.3 7.1a2.6 2.6 0 0 1-3.4.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
              <path d="M7.4 10.6 6.2 11.8a2.6 2.6 0 0 1-3.7-3.7L3.7 6.9a2.6 2.6 0 0 1 3.4-.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          )}
        </button>
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
        <>
          <div className="thread-search-panel">
            <input
              ref={threadSearchInputRef}
              className="thread-search-input"
              placeholder="Search this thread…"
              value={threadSearchQuery}
              onChange={e => setThreadSearchQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && threadHits.length > 0) {
                  e.preventDefault()
                  setThreadHitPos(p => (p + 1) % threadHits.length)
                } else if (e.key === "Escape") {
                  closeThreadSearch()
                }
              }}
              aria-label="Search messages in this thread"
            />
            {threadSearchLoading ? (
              <span className="thread-search-meta">Searching thread…</span>
            ) : threadHits.length > 0 ? (
              <>
                <span className="thread-search-meta">
                  Match {Math.min(threadHitPos + 1, threadHits.length)} of {threadHits.length}
                </span>
                <button type="button" className="thread-search-step" onClick={() => setThreadHitPos(p => (p - 1 + threadHits.length) % threadHits.length)} title="Newer match (more recent in thread)">
                  ◀
                </button>
                <button type="button" className="thread-search-step" onClick={() => setThreadHitPos(p => (p + 1) % threadHits.length)} title="Older match (earlier in thread) — same as Enter">
                  ▶
                </button>
              </>
            ) : threadSearchQuery.trim() ? (
              <span className="thread-search-meta muted">No matches</span>
            ) : (
              <span className="thread-search-meta muted">Type to search.</span>
            )}
            <button type="button" className="thread-search-close" onClick={closeThreadSearch} title="Close">
              ✕
            </button>
          </div>
          {threadHits.length > 0 && (
            <div className={`thread-search-results ${prettyMode ? "thread-search-results--pretty" : "thread-search-results--raw"}`}>
              {threadHits.slice(0, 12).map((hit, i) => (
                <ThreadSearchResultCard
                  key={`${hit.uuid ?? hit.idx}-${i}`}
                  hit={hit}
                  active={i === threadHitPos}
                  query={threadSearchQuery}
                  prettyMode={prettyMode}
                  projectDir={stableProjectDir}
                  sessionId={sessionMeta.id}
                  source={sessionMeta.source}
                  onSelect={() => {
                    setThreadHitPos(i)
                    void focusThreadHit(hit)
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
      <div className="messages-scroll" ref={scrollRef} onScroll={handleScroll}>
        {loading && !win && !loadError && <div className="loading-state">Loading messages…</div>}
        {loadError && !win && <div className="loading-state">{loadError}</div>}
        {loadEarlierControl.show && !loading && (
          <div>
            <div ref={topSentinelRef} style={{ height: 1 }} />
            <div className="load-more-wrap">
              <button className="load-more-pill" onClick={loadEarlierControl.disabled ? undefined : loadEarlierPreserveScroll} disabled={loadEarlierControl.disabled}>
                {loadEarlierControl.label}
                {!loadEarlierControl.disabled && hasEarlier && <span className="load-more-count">{(win?.serverFetchedFrom ?? 0) + startIdx} remaining</span>}
              </button>
            </div>
          </div>
        )}
        {visible.map((msg, i) => {
          const sugg = msg.uuid ? suggestions[msg.uuid] : undefined
          const nextUserMsg = sugg ? visible.slice(i + 1).find(m => m.type === "user") : undefined
          const nextText = nextUserMsg ? (typeof nextUserMsg.message?.content === "string" ? nextUserMsg.message.content : (nextUserMsg.message?.content as {type:string;text?:string}[])?.filter(b => b.type === "text").map(b => b.text).join("") ?? "") : ""
          const chosen = sugg && nextText ? wordOverlap(sugg.text, nextText) > 0.4 : false
          const activeHit = threadSearchOpen && threadHits.length > 0 ? threadHits[threadHitPos] : undefined
          const isThreadSearchHit = activeHit
            ? (activeHit.uuid ? activeHit.uuid === msg.uuid : activeHit.idx === globalOffset + startIdx + i)
            : false
          const isNew = !!(msg.uuid && newMsgUuids.has(msg.uuid) && (msg.type === "user" || msg.type === "assistant" || msg.type === "human"))
          return (
            <div
              key={msg.uuid ? `${msg.uuid}:${globalOffset + startIdx + i}` : globalOffset + startIdx + i}
              className={[sugg ? "msg-with-suggestion" : "", isThreadSearchHit ? "msg-search-hit-wrap" : "", isNew ? "msg-new" : ""].filter(Boolean).join(" ") || undefined}
              data-msg-index={globalOffset + startIdx + i}
            >
              {isNew && <span className="new-msg-dot" title="New since load" />}
              <Block
                msg={msg}
                index={globalOffset + startIdx + i}
                nextMsg={visible[i + 1]}
                source={sessionMeta.source}
                {...(prettyMode ? { projectPath: projectDir } : {})}
              />
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

// Re-export for App.tsx convenience
export { markSessionClick }
export type { SessionMeta, Capabilities }
