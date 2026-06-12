import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useLocation } from "wouter"
import { canonicalizeSelectedProjectPath } from "./sessionPaneState"
import { parseUrlSession } from "./urlSession"
import { markAppInit, markSessionClick } from "./perf"
import { useProjects, useCapabilities } from "./useProjects"
import { SessionPane } from "./SessionPane"
import { Sidebar } from "./Sidebar"
import { SettingsModal } from "./SettingsModal"
import { UsageLimits } from "./UsageLimits"
import { GlobalSearch } from "./GlobalSearch"
import { wallClock } from "./utils"
import { debugLog } from "./debug-trace"
import "./App.css"

markAppInit()

const SIDEBAR_MIN = 300
const SIDEBAR_MAX = 520
const SIDEBAR_DEFAULT = 320

export default function App() {
  const {
    projects,
    projectsLoading,
    projectsUpdating,
    totalSessions,
    listMode,
    sessionsTruncated,
    loadAllSessions,
  } = useProjects()
  const capabilities = useCapabilities()
  const [selected, setSelected] = useState<{ project: string; session: string; initialQuery?: string } | null>(() => {
    const s = parseUrlSession()
    if (s) markSessionClick(s.session)
    return s
  })
  const [showSettings, setShowSettings] = useState(false)
  const [showGlobalSearch, setShowGlobalSearch] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [location, setLocation] = useLocation()
  const tab = location === "/usage" ? "usage" : "sessions"
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
  const activeProject = activeProjectPath
    ? (projects.find(p => p.path === activeProjectPath) ??
       (activeSessionId ? projects.find(p => p.sessions.some(s => s.id === activeSessionId)) : undefined))
    : undefined
  const activeMeta = activeProject?.sessions.find(s => s.id === activeSessionId)
  const canonicalProjectPath = canonicalizeSelectedProjectPath(
    selected?.project ?? null,
    activeProjectPath ?? null,
    activeMeta?.projectPath ?? null,
  )

  useEffect(() => {
    if (!activeProjectPath || !activeSessionId) return
    if (!selected) return
    const s = encodeURIComponent(canonicalProjectPath ?? activeProjectPath) + "/" + activeSessionId
    history.replaceState(null, "", "?s=" + s)
  }, [canonicalProjectPath, activeProjectPath, activeSessionId, selected])

  useEffect(() => {
    if (!selected || !activeSessionId || !activeMeta?.projectPath) return
    if (selected.project === activeMeta.projectPath) return
    debugLog(`[session-state ${wallClock()}] ${activeSessionId.slice(0, 8)} canonical-project-path selected=${selected.project} resolved=${activeMeta.projectPath}`)
    setSelected({ project: activeMeta.projectPath, session: activeSessionId })
  }, [activeMeta?.projectPath, activeSessionId, selected])

  const effectiveMeta =
    activeMeta ?? (selected && activeSessionId
      ? { id: activeSessionId, projectPath: selected.project, lastActivity: "", isActive: false, messageCount: 0,
          source: selected.project.startsWith("cursor:") ? "cursor"
            : selected.project.startsWith("opencode:") ? "opencode"
            : selected.project.startsWith("codex:") ? "codex"
            : selected.project.startsWith("hermes:") ? "hermes"
            : selected.project.startsWith("antigravity-cli:") ? "antigravity-cli"
            : selected.project.startsWith("antigravity:") ? "antigravity"
            : "claude" }
      : null)
  const effectiveProjectPath = canonicalProjectPath ?? activeProjectPath

  // Cmd+K / Ctrl+K to open global search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setShowGlobalSearch(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Build a title map from loaded projects for result enrichment
  const sessionTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of projects) {
      for (const s of p.sessions) {
        const title = s.customName ?? s.firstName ?? s.id.slice(0, 8)
        m.set(`${s.projectPath ?? p.path}/${s.id}`, title)
      }
    }
    return m
  }, [projects])

  const switchTab = (t: "sessions" | "usage") => setLocation(t === "usage" ? "/usage" : "/sessions")

  return (
    <div className="app">
      <header className="topbar">
        <button className="topbar-menu-btn" onClick={() => setMobileSidebarOpen(o => !o)} title="Sessions"
          style={{ visibility: tab === "sessions" ? "visible" : "hidden" }}>☰</button>
        <nav className="topbar-tabs">
          <button className={`topbar-tab${tab === "sessions" ? " active" : ""}`} onClick={() => switchTab("sessions")}>Sessions</button>
          <button className={`topbar-tab${tab === "usage" ? " active" : ""}`} onClick={() => switchTab("usage")}>Usage</button>
        </nav>
        <button
          className="topbar-global-search-btn"
          onClick={() => setShowGlobalSearch(true)}
          title="Search transcript content (⌘K)"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
            <circle cx="5.5" cy="5.5" r="3.75" stroke="currentColor" strokeWidth="1.4"/>
            <line x1="8.6" y1="8.6" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <span className="topbar-global-search-label">Search</span>
          <span className="topbar-global-search-kbd">⌘K</span>
        </button>
        <button className="topbar-settings-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
      </header>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showGlobalSearch && (
        <GlobalSearch
          onNavigate={(projectPath, sessionId, query) => {
            setSelected({ project: projectPath, session: sessionId, initialQuery: query })
            setLocation("/sessions")
          }}
          onClose={() => setShowGlobalSearch(false)}
          sessionTitles={sessionTitles}
        />
      )}
      <div className="main">
        <UsageLimits visible={tab === "usage"} />
        <div className="sessions-layout" style={{ display: tab === "sessions" ? "flex" : "none", flex: 1, overflow: "hidden" }}>
          <Sidebar
            projects={projects}
            projectsLoading={projectsLoading}
            projectsUpdating={projectsUpdating}
            totalSessions={totalSessions}
            listMode={listMode}
            sessionsTruncated={sessionsTruncated}
            onLoadAllSessions={loadAllSessions}
            activeSessionId={activeSessionId}
            onSelect={(p, s) => setSelected({ project: p, session: s, initialQuery: undefined })}
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
                  initialQuery={selected?.session === effectiveMeta.id ? selected?.initialQuery : undefined}
                />
              : <div className="empty-state">Select a session from the sidebar</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
