import { useState, useEffect, useRef, useMemo } from "react"
import { Bot, Clock, User } from "lucide-react"
import type { SessionMeta, ProjectData } from "./types"
import { highlightTermsInPlainText } from "./searchHighlight"
import { mergeSidebarSearchResultItems } from "./sidebarSearchState"
import { markSessionClick } from "./perf"
import { isRecentlyActive, relativeTime } from "./utils"
import { AgentIcon, platformFilterActiveClass } from "./platformChrome"
import { RECENT_SIDEBAR_SESSIONS } from "./useProjects"
import { debugLog, debugWarn } from "./debug-trace"

function normalizeSidebarSearchText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenizeSidebarSearchQuery(query: string): string[] {
  return normalizeSidebarSearchText(query)
    .split(" ")
    .filter(Boolean)
}

function formatPlatformLabel(source?: string): string {
  const s = (source ?? "claude").trim()
  if (!s || s === "claude") return "Claude"
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function sessionCountLabel(s: SessionMeta): { user: number | null; assistant: number | null; title: string } {
  if (s.userMessageCount == null) {
    return {
      user: null,
      assistant: null,
      title: `${s.messageCount} total records; user-message count not indexed yet`,
    }
  }
  const assistant = Math.max(0, s.messageCount - s.userMessageCount)
  return {
    user: s.userMessageCount,
    assistant,
    title: `${s.userMessageCount} user messages / ${assistant} assistant and tool records`,
  }
}

function SessionColumnsHeader() {
  return (
    <div className="sidebar-columns-header" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span className="sidebar-count-heading" title="User messages">
        <User size={11} strokeWidth={1.8} />
      </span>
      <span className="sidebar-count-heading" title="Assistant and tool records">
        <Bot size={11} strokeWidth={1.8} />
      </span>
      <span className="sidebar-time-heading" title="Age">
        <Clock size={11} strokeWidth={1.8} />
      </span>
    </div>
  )
}

function matchesSidebarSearchFields(query: string, ...fields: Array<string | undefined | null>): boolean {
  const terms = tokenizeSidebarSearchQuery(query)
  if (!terms.length) return false
  const haystack = normalizeSidebarSearchText(fields.filter(Boolean).join(" "))
  if (!haystack) return false
  return terms.every(term => haystack.includes(term))
}

interface SidebarSearchHit {
  projectPath: string
  sessionId: string
  displayTitle: string
  bestKey: string
  snippet: string
  meta: SessionMeta
}

interface SessionSearchMatch {
  fieldLabel?: string
  snippet: string
  highlightQuery: string
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

function SessionItem({ s, projectPath, isSelected, onSelect, subagentCount, subagentsExpanded, onToggleSubagents, searchHint, searchMatch, highlightTitleQuery, archived, onToggleArchive }: {
  s: SessionMeta
  projectPath: string
  isSelected: boolean
  onSelect: () => void
  subagentCount?: number
  subagentsExpanded?: boolean
  onToggleSubagents?: () => void
  searchHint?: string
  searchMatch?: SessionSearchMatch
  highlightTitleQuery?: string
  archived?: boolean
  onToggleArchive?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [customName, setCustomName] = useState<string | undefined>(s.customName)
  const inputRef = useRef<HTMLInputElement>(null)

  const titleQuery = (highlightTitleQuery ?? "").trim()
  const showTitleHits = titleQuery.length > 0
  const countLabel = sessionCountLabel(s)

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
    if (name === (customName ?? "")) return
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
      className={`sidebar-session ${isSelected ? "active" : ""} ${s.isSidechain ? "sidechain" : ""} ${searchHint || searchMatch ? "sidebar-session--multiline" : ""}`}
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
          <span className="ss-name">
            {isRecentlyActive(s.lastActivity) && <span className="ss-live">●</span>}
            {s.isSidechain && <span className="ss-subagent-icon" title="Sub-agent session">⤷</span>}
            {showTitleHits ? highlightTermsInPlainText(displayName, titleQuery) : displayName}
          </span>
          {(searchMatch || searchHint) && (
            <div
              className="ss-search-hint"
              title={
                searchMatch
                  ? [searchMatch.fieldLabel, searchMatch.snippet].filter(Boolean).join(" · ")
                  : searchHint
              }
            >
              {searchMatch ? (
                <>
                  {searchMatch.fieldLabel && (
                    <span className="ss-search-hint-field">{searchMatch.fieldLabel}</span>
                  )}
                  {searchMatch.fieldLabel && searchMatch.snippet.trim() ? " · " : null}
                  {searchMatch.snippet.trim() ? (
                    <span className="ss-search-hint-snippet">
                      {highlightTermsInPlainText(searchMatch.snippet, searchMatch.highlightQuery)}
                    </span>
                  ) : null}
                </>
              ) : (
                searchHint
              )}
            </div>
          )}
          {onToggleSubagents && (
            <button className="ss-subagents-toggle" onClick={e => { e.stopPropagation(); onToggleSubagents() }} title={`${subagentsExpanded ? "Hide" : "Show"} ${subagentCount} subagents`}>
              {subagentsExpanded ? "▾" : "▸"}{subagentCount}
            </button>
          )}
          <span className="ss-row-actions">
            {onToggleArchive && (
              <button
                className="ss-archive-btn"
                onClick={e => { e.stopPropagation(); onToggleArchive() }}
                title={archived ? "Unarchive (show again)" : "Archive (hide from list)"}
              >
                {archived ? (
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden><path d="M1.5 4.5h11M2.5 4.5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7M1.5 4.5l1-2.5h9l1 2.5M7 10.5V7M5.2 8.8 7 7l1.8 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden><path d="M1.5 4.5h11M2.5 4.5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7M1.5 4.5l1-2.5h9l1 2.5M5.5 7.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )}
              </button>
            )}
            <button className="ss-rename-btn" onClick={startEdit} title="Rename">✎</button>
          </span>
          <span className="ss-count ss-count-user" title={countLabel.title} aria-label={countLabel.title}>
            {countLabel.user ?? "?"}
          </span>
          <span className="ss-count ss-count-bot" title={countLabel.title} aria-label={countLabel.title}>
            {countLabel.assistant ?? s.messageCount}
          </span>
          <span className="ss-time">{s.lastActivity ? relativeTime(s.lastActivity) : ""}</span>
        </>
      )}
    </div>
  )
}

export function Sidebar({ projects: projectsProp, projectsLoading, projectsUpdating, totalSessions, listMode, sessionsTruncated, onLoadAllSessions, activeSessionId: activeSessionIdProp, onSelect, width, onDragStart, mobileOpen, onMobileClose }: {
  projects: ProjectData[]
  projectsLoading: boolean
  projectsUpdating: boolean
  totalSessions: number | null
  listMode: "recent" | "full"
  sessionsTruncated: boolean
  onLoadAllSessions: () => void
  activeSessionId: string | null
  onSelect: (p: string, s: string) => void
  width: number
  onDragStart: (e: React.PointerEvent) => void
  mobileOpen: boolean
  onMobileClose: () => void
}) {
  const isMobile = useIsMobile()
  const [grouped, setGrouped] = useState(() => localStorage.getItem("sidebarGrouped") === "true")
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [platformFilter, setPlatformFilter] = useState<string>("all")
  const [sidebarBottomInView, setSidebarBottomInView] = useState(false)
  const sessionsScrollRef = useRef<HTMLDivElement>(null)
  const sidebarBottomRef = useRef<HTMLDivElement>(null)

  const [archivedKeys, setArchivedKeys] = useState<Set<string>>(new Set())
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    fetch("/api/archived", { credentials: "include" })
      .then(r => (r.ok ? r.json() : { keys: [] }))
      .then((data: { keys?: string[] }) => setArchivedKeys(new Set(data.keys ?? [])))
      .catch(() => {})
  }, [])

  const archiveKeyFor = (s: SessionMeta, fallbackPath: string) => `${s.projectPath || fallbackPath}/${s.id}`

  function toggleArchive(key: string) {
    setArchivedKeys(prev => {
      const next = new Set(prev)
      const nowArchived = !next.has(key)
      if (nowArchived) next.add(key)
      else next.delete(key)
      fetch("/api/archived", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ key, archived: nowArchived }),
      }).catch(() => {})
      return next
    })
  }

  const projects = useMemo(() => {
    if (showArchived || archivedKeys.size === 0) return projectsProp
    return projectsProp
      .map(p => ({ ...p, sessions: p.sessions.filter(s => !archivedKeys.has(archiveKeyFor(s, p.path))) }))
      .filter(p => p.sessions.length > 0)
  }, [projectsProp, archivedKeys, showArchived])

  const archivedCount = useMemo(() => {
    if (archivedKeys.size === 0) return 0
    let n = 0
    for (const p of projectsProp) for (const s of p.sessions) if (archivedKeys.has(archiveKeyFor(s, p.path))) n++
    return n
  }, [projectsProp, archivedKeys])

  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("")
  const [sidebarSearchLoading, setSidebarSearchLoading] = useState(false)
  const [sidebarSearchHits, setSidebarSearchHits] = useState<SidebarSearchHit[] | null>(null)
  const sidebarSearchSeqRef = useRef(0)

  useEffect(() => {
    const q = sidebarSearchQuery.trim()
    const requestId = ++sidebarSearchSeqRef.current
    if (!q) {
      debugLog(`[sidebar-search] #${requestId} cleared`)
      setSidebarSearchHits(null)
      setSidebarSearchLoading(false)
      return
    }
    const controller = new AbortController()
    const t0 = performance.now()
    debugLog(`[sidebar-search] #${requestId} start q="${q}" platform=${platformFilter}`)
    setSidebarSearchLoading(true)
    debugLog(`[sidebar-search] #${requestId} keep previous results visible while loading`)
    fetch(`/api/search/sessions?q=${encodeURIComponent(q)}`, { credentials: "include", signal: controller.signal })
      .then(r => (r.ok ? r.json() : { results: [] }))
      .then((data: { results?: Record<string, unknown>[], source?: string }) => {
        if (controller.signal.aborted || requestId !== sidebarSearchSeqRef.current) {
          debugLog(`[sidebar-search] #${requestId} stale result ignored q="${q}"`)
          return
        }
        debugLog(`[sidebar-search] #${requestId} results=${data.results?.length ?? 0} source=${data.source ?? "unknown"} ms=${(performance.now() - t0).toFixed(1)} q="${q}" replace=1`)
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
      .catch((e) => {
        if (controller.signal.aborted || requestId !== sidebarSearchSeqRef.current) {
          debugLog(`[sidebar-search] #${requestId} aborted q="${q}"`)
          return
        }
        debugWarn(`[sidebar-search] #${requestId} error q="${q}":`, e)
        setSidebarSearchHits([])
      })
      .finally(() => {
        if (requestId === sidebarSearchSeqRef.current) {
          debugLog(`[sidebar-search] #${requestId} settled q="${q}"`)
          setSidebarSearchLoading(false)
        }
      })
    return () => {
      debugLog(`[sidebar-search] #${requestId} cleanup q="${q}"`)
      controller.abort()
    }
  }, [sidebarSearchQuery, platformFilter])

  const allSessions = projects.flatMap(p => p.sessions)
  const presentPlatforms = Array.from(new Set(allSessions.map(s => s.source ?? "claude")))
  const showPlatformFilter = presentPlatforms.length > 1
  const loadedSessionCount = projects.reduce((n, p) => n + p.sessions.length, 0)

  const searchBrowseActive = sidebarSearchQuery.trim().length > 0
  useEffect(() => {
    if (searchBrowseActive) {
      setSidebarBottomInView(false)
      return
    }
    const root = sessionsScrollRef.current
    const target = sidebarBottomRef.current
    if (!root || !target || !("IntersectionObserver" in window)) {
      setSidebarBottomInView(false)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setSidebarBottomInView(entry.isIntersecting),
      { root, threshold: 0.1 },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [searchBrowseActive, grouped, platformFilter, loadedSessionCount])

  const filteredSearchHits = (sidebarSearchHits ?? []).filter(h => {
    if (platformFilter !== "all" && (h.meta.source ?? "claude") !== platformFilter) return false
    return matchesSidebarSearchFields(
      sidebarSearchQuery,
      h.displayTitle,
      h.meta.source ?? "claude",
      formatPlatformLabel(String(h.meta.source ?? "claude")),
    )
  })

  const titleMatchSessions = useMemo(() => {
    const q = sidebarSearchQuery.trim()
    if (!q) return []
    return projects.flatMap(p =>
      p.sessions
        .filter(s => {
          if (platformFilter !== "all" && (s.source ?? "claude") !== platformFilter) return false
          const title = s.customName ?? s.firstName ?? s.id
          const source = s.source ?? "claude"
          return matchesSidebarSearchFields(q, title, source, formatPlatformLabel(String(source)))
        })
        .map(s => ({
          s,
          projectPath: p.path,
          matchField: normalizeSidebarSearchText(s.customName ?? s.firstName ?? s.id).includes(normalizeSidebarSearchText(q))
            ? "title"
            : "source",
        }))
    )
  }, [sidebarSearchQuery, projects, platformFilter])

  const sidebarSearchRows = useMemo(() => {
    const q = sidebarSearchQuery.trim()
    if (!q) return []

    const apiRows = filteredSearchHits.map(hit => ({
      key: `${hit.projectPath}/${hit.sessionId}`,
      s: hit.meta,
      projectPath: hit.projectPath,
      sessionId: hit.sessionId,
      highlightTitleQuery: hit.bestKey === "title" ? q : undefined,
      searchMatch:
        hit.bestKey === "title"
          ? undefined
          : {
              fieldLabel: "Platform",
              snippet: formatPlatformLabel(hit.meta.source),
              highlightQuery: q,
            },
    }))

    const titleRows = titleMatchSessions.map(({ s, projectPath, matchField }) => ({
      key: `${projectPath}/${s.id}`,
      s,
      projectPath,
      sessionId: s.id,
      highlightTitleQuery: matchField === "title" ? q : undefined,
      searchMatch: matchField === "source"
        ? {
            fieldLabel: "Platform",
            snippet: formatPlatformLabel(s.source),
            highlightQuery: q,
          }
        : undefined,
    }))

    return mergeSidebarSearchResultItems(apiRows, titleRows)
  }, [filteredSearchHits, sidebarSearchQuery, titleMatchSessions])

  function toggleGrouped(val: boolean) {
    setGrouped(val)
    localStorage.setItem("sidebarGrouped", String(val))
  }

  function toggleParent(id: string) {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  // Deep-link / selection: reveal the active parent or active subagent.
  useEffect(() => {
    if (!activeSessionIdProp || projectsLoading) return
    const flat = projects.flatMap(p => p.sessions.map(s => ({ s, projectPath: s.projectPath || p.path })))
    const active = flat.find(({ s }) => s.id === activeSessionIdProp)
    if (!active) return
    if (active.s.isSidechain && active.s.parentSessionId) {
      setExpandedParents(prev => (
        prev.has(active.s.parentSessionId!) ? prev : new Set(prev).add(active.s.parentSessionId!)
      ))
      return
    }
    if (active.s.isSidechain) return
    const childCount = flat.filter(({ s }) => s.isSidechain && s.parentSessionId === activeSessionIdProp).length
    if (childCount === 0) return
    setExpandedParents(prev => (prev.has(activeSessionIdProp) ? prev : new Set(prev).add(activeSessionIdProp)))
  }, [activeSessionIdProp, projects, projectsLoading])

  const recentTargetCount =
    listMode === "recent" && totalSessions != null
      ? Math.min(totalSessions, RECENT_SIDEBAR_SESSIONS)
      : null
  const loadingLabel = projectsLoading
    ? listMode === "recent"
      ? recentTargetCount != null
        ? loadedSessionCount > 0
          ? `Loading recent sessions… ${loadedSessionCount}/${recentTargetCount}`
          : `Loading recent sessions…`
        : loadedSessionCount > 0
          ? `Loading recent sessions… ${loadedSessionCount}`
          : `Loading recent sessions…`
      : totalSessions != null
        ? loadedSessionCount > 0
          ? `Loading ${totalSessions} sessions… ${loadedSessionCount} loaded`
          : `Loading ${totalSessions} sessions…`
        : loadedSessionCount > 0
          ? `Loading sessions… ${loadedSessionCount} loaded`
          : `Loading…`
    : null
  const inlineLoadingLabel =
    sessionsTruncated && sidebarBottomInView
      ? "Loading older sessions…"
      : listMode === "recent"
        ? "Loading recent sessions…"
        : totalSessions != null
          ? `Loading sessions… ${loadedSessionCount} loaded`
          : "Loading sessions…"
  const showTopLoading = projectsLoading && loadedSessionCount === 0
  const showInlineLoading =
    projectsUpdating &&
    loadedSessionCount > 0 &&
    sidebarBottomInView

  useEffect(() => {
    if (searchBrowseActive || projectsLoading || loadedSessionCount === 0) return
    if (!sessionsTruncated || !sidebarBottomInView) return
    onLoadAllSessions()
  }, [searchBrowseActive, projectsLoading, loadedSessionCount, sessionsTruncated, sidebarBottomInView, onLoadAllSessions])

  const _allFlatRaw: { s: SessionMeta; projectPath: string }[] = projects
    .flatMap(p => p.sessions.map(s => ({ s, projectPath: s.projectPath || p.path })))
    .filter(({ s }) => platformFilter === "all" || (s.source ?? "claude") === platformFilter)
    .sort((a, b) => String(b.s.lastActivity ?? "").localeCompare(String(a.s.lastActivity ?? "")))
  const _seenIds = new Set<string>()
  const allFlat = _allFlatRaw.filter(({ s }) => {
    if (_seenIds.has(s.id)) return false
    _seenIds.add(s.id)
    return true
  })

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
  const orphans = allFlat.filter(({ s }) => s.isSidechain && (!s.parentSessionId || !subagentsByParent.has(s.parentSessionId) || !topLevel.find(t => t.s.id === s.parentSessionId)))

  function handleSelect(p: string, s: string) {
    markSessionClick(s)
    onSelect(p, s)
    onMobileClose()
  }

  const listedSessionCount = projects.reduce((n, p) => n + p.sessions.length, 0)
  const moreSessionsHidden =
    totalSessions != null && listMode === "recent" ? Math.max(0, totalSessions - listedSessionCount) : 0
  const showLoadOlderButton =
    sessionsTruncated &&
    totalSessions != null &&
    moreSessionsHidden > 0 &&
    !searchBrowseActive &&
    !sidebarBottomInView

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
          {archivedCount > 0 && (
            <button
              type="button"
              className={`sidebar-archived-toggle ${showArchived ? "active" : ""}`}
              onClick={() => setShowArchived(v => !v)}
              title={showArchived ? "Hide archived sessions" : "Show archived sessions"}
            >
              {showArchived ? `Hide archived (${archivedCount})` : `Archived (${archivedCount})`}
            </button>
          )}
          <div className="sidebar-search-row">
            <span className="sidebar-search-icon" aria-hidden><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="5.5" cy="5.5" r="3.75" stroke="currentColor" strokeWidth="1.4"/><line x1="8.6" y1="8.6" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>
            <input
              type="search"
              className="sidebar-search-input"
              placeholder="Search by title…"
              value={sidebarSearchQuery}
              onChange={e => {
                const v = e.target.value
                debugLog(`[sidebar-search] input len=${v.trim().length} platform=${platformFilter}`)
                if (v.trim()) setSidebarSearchLoading(true)
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
          {showTopLoading && !searchBrowseActive && loadingLabel && (
            <div className="sidebar-loading-banner">
              <span className="sidebar-spinner" />
              <span>{loadingLabel}</span>
            </div>
          )}
          <SessionColumnsHeader />
          <div className="sidebar-sessions-scroll" ref={sessionsScrollRef}>
            {searchBrowseActive ? (
              <>
                {sidebarSearchLoading && (
                  <div className="sidebar-empty">
                    <span className="sidebar-spinner" />
                    Searching…
                  </div>
                )}
                {!sidebarSearchLoading && sidebarSearchHits !== null && sidebarSearchRows.length === 0 && (
                  <div className="sidebar-empty">No threads match your search.</div>
                )}
                {sidebarSearchRows.map(row => (
                  <SessionItem
                    key={row.key}
                    s={row.s as SessionMeta}
                    projectPath={row.projectPath}
                    isSelected={activeSessionIdProp === row.sessionId}
                    onSelect={() => handleSelect(row.projectPath, row.sessionId)}
                    highlightTitleQuery={row.highlightTitleQuery}
                    searchMatch={row.searchMatch}
                    archived={archivedKeys.has(archiveKeyFor(row.s as SessionMeta, row.projectPath))}
                    onToggleArchive={() => toggleArchive(archiveKeyFor(row.s as SessionMeta, row.projectPath))}
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
                .map(project => {
                  const projSubagents = new Map<string, SessionMeta[]>()
                  const projTopLevel: SessionMeta[] = []
                  for (const s of project.sessions) {
                    if (s.isSidechain && s.parentSessionId) {
                      const arr = projSubagents.get(s.parentSessionId) ?? []
                      arr.push(s)
                      projSubagents.set(s.parentSessionId, arr)
                    } else {
                      projTopLevel.push(s)
                    }
                  }
                  const projOrphans = project.sessions.filter(s => s.isSidechain && (!s.parentSessionId || !projTopLevel.find(t => t.id === s.parentSessionId)))
                  return (
                    <div key={project.path} className="sidebar-project">
                      <div className="sidebar-project-name" data-tooltip={project.groupPath ?? project.path}>{project.displayName}</div>
                      {projTopLevel.map(s => {
                        const children = projSubagents.get(s.id) ?? []
                        const expanded = expandedParents.has(s.id)
                        return (
                          <div key={`${project.path}/${s.id}`}>
                            <SessionItem
                              s={s}
                              projectPath={s.projectPath || project.path}
                              isSelected={activeSessionIdProp === s.id}
                              onSelect={() => handleSelect(s.projectPath || project.path, s.id)}
                              subagentCount={children.length}
                              subagentsExpanded={expanded}
                              onToggleSubagents={children.length > 0 ? () => toggleParent(s.id) : undefined}
                              archived={archivedKeys.has(archiveKeyFor(s, project.path))}
                              onToggleArchive={() => toggleArchive(archiveKeyFor(s, project.path))}
                            />
                            {expanded && children.map(cs => (
                              <SessionItem
                                key={`${project.path}/${cs.id}`}
                                s={cs}
                                projectPath={cs.projectPath || project.path}
                                isSelected={activeSessionIdProp === cs.id}
                                onSelect={() => handleSelect(cs.projectPath || project.path, cs.id)}
                                archived={archivedKeys.has(archiveKeyFor(cs, project.path))}
                                onToggleArchive={() => toggleArchive(archiveKeyFor(cs, project.path))}
                              />
                            ))}
                          </div>
                        )
                      })}
                      {projOrphans.map(s => (
                        <SessionItem
                          key={`${project.path}/${s.id}`}
                          s={s}
                          projectPath={s.projectPath || project.path}
                          isSelected={activeSessionIdProp === s.id}
                          onSelect={() => handleSelect(s.projectPath || project.path, s.id)}
                          archived={archivedKeys.has(archiveKeyFor(s, project.path))}
                          onToggleArchive={() => toggleArchive(archiveKeyFor(s, project.path))}
                        />
                      ))}
                    </div>
                  )
                })
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
                        isSelected={activeSessionIdProp === s.id}
                        onSelect={() => handleSelect(projectPath, s.id)}
                        subagentCount={children.length}
                        subagentsExpanded={expanded}
                        onToggleSubagents={children.length > 0 ? () => toggleParent(s.id) : undefined}
                        archived={archivedKeys.has(archiveKeyFor(s, projectPath))}
                        onToggleArchive={() => toggleArchive(archiveKeyFor(s, projectPath))}
                      />
                      {expanded && children.map(({ s: cs, projectPath: cp }) => (
                        <SessionItem
                          key={`${cp}/${cs.id}`}
                          s={cs}
                          projectPath={cp}
                          isSelected={activeSessionIdProp === cs.id}
                          onSelect={() => handleSelect(cp, cs.id)}
                          archived={archivedKeys.has(archiveKeyFor(cs, cp))}
                          onToggleArchive={() => toggleArchive(archiveKeyFor(cs, cp))}
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
                    isSelected={activeSessionIdProp === s.id}
                    onSelect={() => handleSelect(projectPath, s.id)}
                    archived={archivedKeys.has(archiveKeyFor(s, projectPath))}
                    onToggleArchive={() => toggleArchive(archiveKeyFor(s, projectPath))}
                  />
                ))}
              </>
            )}
            {!searchBrowseActive && (
              <div ref={sidebarBottomRef} className="sidebar-bottom-sentinel" aria-hidden />
            )}
            {!searchBrowseActive && showInlineLoading && (
              <div className="sidebar-loading-banner sidebar-loading-banner--inline">
                <span className="sidebar-spinner" />
                <span>{inlineLoadingLabel}</span>
              </div>
            )}
            {!projectsLoading && projects.length === 0 && !searchBrowseActive && <div className="sidebar-empty">No sessions found</div>}
          </div>
          {showLoadOlderButton && (
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
