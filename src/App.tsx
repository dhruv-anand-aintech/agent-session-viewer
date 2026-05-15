import { useState, useEffect, useRef, useCallback } from "react"
import { canonicalizeSelectedProjectPath } from "./sessionPaneState"
import { markAppInit, markSessionClick } from "./perf"
import { useProjects, useCapabilities } from "./useProjects"
import { SessionPane } from "./SessionPane"
import { Sidebar } from "./Sidebar"
import { SettingsModal } from "./SettingsModal"
import { UsageLimits } from "./UsageLimits"
import { wallClock } from "./utils"
import "./App.css"

markAppInit()

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
  const [selected, setSelected] = useState<{ project: string; session: string } | null>(() => {
    const s = parseUrlSession()
    if (s) markSessionClick(s.session)
    return s
  })
  const [showSettings, setShowSettings] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [tab, setTab] = useState<"sessions" | "usage">(() =>
    window.location.hash === "#usage" ? "usage" : "sessions"
  )
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
    const s = encodeURIComponent(canonicalProjectPath ?? activeProjectPath) + "/" + activeSessionId
    history.replaceState(null, "", "?s=" + s)
  }, [canonicalProjectPath, activeProjectPath, activeSessionId])

  useEffect(() => {
    if (!selected || !activeSessionId || !activeMeta?.projectPath) return
    if (selected.project === activeMeta.projectPath) return
    console.log(`[session-state ${wallClock()}] ${activeSessionId.slice(0, 8)} canonical-project-path selected=${selected.project} resolved=${activeMeta.projectPath}`)
    setSelected({ project: activeMeta.projectPath, session: activeSessionId })
  }, [activeMeta?.projectPath, activeSessionId, selected])

  const effectiveMeta =
    activeMeta ?? (selected && activeSessionId
      ? { id: activeSessionId, projectPath: selected.project, lastActivity: "", isActive: false, messageCount: 0,
          source: selected.project.startsWith("cursor:") ? "cursor"
            : selected.project.startsWith("opencode:") ? "opencode"
            : selected.project.startsWith("codex:") ? "codex"
            : selected.project.startsWith("hermes:") ? "hermes"
            : selected.project.startsWith("antigravity:") ? "antigravity"
            : "claude" }
      : null)
  const effectiveProjectPath = canonicalProjectPath ?? activeProjectPath

  const switchTab = (t: "sessions" | "usage") => {
    setTab(t)
    history.replaceState(null, "", t === "usage" ? "#usage" : window.location.pathname + window.location.search)
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="topbar-menu-btn" onClick={() => setMobileSidebarOpen(o => !o)} title="Sessions"
          style={{ visibility: tab === "sessions" ? "visible" : "hidden" }}>☰</button>
        <nav className="topbar-tabs">
          <button className={`topbar-tab${tab === "sessions" ? " active" : ""}`} onClick={() => switchTab("sessions")}>Sessions</button>
          <button className={`topbar-tab${tab === "usage" ? " active" : ""}`} onClick={() => switchTab("usage")}>Usage</button>
        </nav>
        <span className={`conn-badge ${connected ? "conn-on" : "conn-off"}`}>
          {connected ? "● Live" : "○ Polling"}
        </span>
        <button className="topbar-settings-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
      </header>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      <div className="main">
        {tab === "usage"
          ? <UsageLimits />
          : <>
              <Sidebar
                projects={projects}
                projectsLoading={projectsLoading}
                totalSessions={totalSessions}
                listMode={listMode}
                sessionsTruncated={sessionsTruncated}
                onLoadAllSessions={loadAllSessions}
                activeSessionId={activeSessionId}
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
        }
      </div>
    </div>
  )
}
