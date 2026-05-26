import { useState, useEffect, useRef, useMemo } from "react"
import type { SessionMeta, ProjectData } from "./types"
import { highlightTermsInPlainText } from "./searchHighlight"
import { mergeSidebarSearchResultItems } from "./sidebarSearchState"
import { markSessionClick } from "./perf"
import { isRecentlyActive, relativeTime } from "./utils"
import { AgentIcon, platformFilterActiveClass } from "./platformChrome"
import { RECENT_SIDEBAR_SESSIONS } from "./useProjects"

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

function SessionItem({ s, projectPath, isSelected, onSelect, subagentCount, subagentsExpanded, onToggleSubagents, searchHint, searchMatch, highlightTitleQuery }: {
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
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [customName, setCustomName] = useState<string | undefined>(s.customName)
  const inputRef = useRef<HTMLInputElement>(null)

  const titleQuery = (highlightTitleQuery ?? "").trim()
  const showTitleHits = titleQuery.length > 0

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
          {isRecentlyActive(s.lastActivity) && <span className="ss-live">●</span>}
          {s.isSidechain && <span className="ss-subagent-icon" title="Sub-agent session">⤷</span>}
          <span className="ss-name">
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

export function Sidebar({ projects, projectsLoading, totalSessions, listMode, sessionsTruncated, onLoadAllSessions, activeSessionId: activeSessionIdProp, onSelect, width, onDragStart, mobileOpen, onMobileClose }: {
  projects: ProjectData[]
  projectsLoading: boolean
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

  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("")
  const [sidebarSearchLoading, setSidebarSearchLoading] = useState(false)
  const [sidebarSearchHits, setSidebarSearchHits] = useState<SidebarSearchHit[] | null>(null)
  const sidebarSearchSeqRef = useRef(0)

  useEffect(() => {
    const q = sidebarSearchQuery.trim()
    const requestId = ++sidebarSearchSeqRef.current
    if (!q) {
      console.log(`[sidebar-search] #${requestId} cleared`)
      setSidebarSearchHits(null)
      setSidebarSearchLoading(false)
      return
    }
    const controller = new AbortController()
    const t0 = performance.now()
    console.log(`[sidebar-search] #${requestId} start q="${q}" platform=${platformFilter}`)
    setSidebarSearchLoading(true)
    console.log(`[sidebar-search] #${requestId} keep previous results visible while loading`)
    fetch(`/api/search/sessions?q=${encodeURIComponent(q)}`, { credentials: "include", signal: controller.signal })
      .then(r => (r.ok ? r.json() : { results: [] }))
      .then((data: { results?: Record<string, unknown>[], source?: string }) => {
        if (controller.signal.aborted || requestId !== sidebarSearchSeqRef.current) {
          console.log(`[sidebar-search] #${requestId} stale result ignored q="${q}"`)
          return
        }
        console.log(`[sidebar-search] #${requestId} results=${data.results?.length ?? 0} source=${data.source ?? "unknown"} ms=${(performance.now() - t0).toFixed(1)} q="${q}" replace=1`)
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
          console.log(`[sidebar-search] #${requestId} aborted q="${q}"`)
          return
        }
        console.warn(`[sidebar-search] #${requestId} error q="${q}":`, e)
        setSidebarSearchHits([])
      })
      .finally(() => {
        if (requestId === sidebarSearchSeqRef.current) {
          console.log(`[sidebar-search] #${requestId} settled q="${q}"`)
          setSidebarSearchLoading(false)
        }
      })
    return () => {
      console.log(`[sidebar-search] #${requestId} cleanup q="${q}"`)
      controller.abort()
    }
  }, [sidebarSearchQuery, platformFilter])

  const searchBrowseActive = sidebarSearchQuery.trim().length > 0
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

  const allSessions = projects.flatMap(p => p.sessions)
  const presentPlatforms = Array.from(new Set(allSessions.map(s => s.source ?? "claude")))
  const showPlatformFilter = presentPlatforms.length > 1
  const loadedSessionCount = projects.reduce((n, p) => n + p.sessions.length, 0)
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
              placeholder="Search by title…"
              value={sidebarSearchQuery}
              onChange={e => {
                const v = e.target.value
                console.log(`[sidebar-search] input len=${v.trim().length} platform=${platformFilter}`)
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
          {projectsLoading && !searchBrowseActive && loadingLabel && (
            <div className="sidebar-loading-banner">
              <span className="sidebar-spinner" />
              <span>{loadingLabel}</span>
            </div>
          )}
          <div className="sidebar-sessions-scroll">
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
                            />
                            {expanded && children.map(cs => (
                              <SessionItem
                                key={`${project.path}/${cs.id}`}
                                s={cs}
                                projectPath={cs.projectPath || project.path}
                                isSelected={activeSessionIdProp === cs.id}
                                onSelect={() => handleSelect(cs.projectPath || project.path, cs.id)}
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
                      />
                      {expanded && children.map(({ s: cs, projectPath: cp }) => (
                        <SessionItem
                          key={`${cp}/${cs.id}`}
                          s={cs}
                          projectPath={cp}
                          isSelected={activeSessionIdProp === cs.id}
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
                    isSelected={activeSessionIdProp === s.id}
                    onSelect={() => handleSelect(projectPath, s.id)}
                  />
                ))}
              </>
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
