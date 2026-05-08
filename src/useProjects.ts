import { useState, useEffect, useRef, useCallback } from "react"
import type { Capabilities, ProjectData, SessionMeta } from "./types"
import { markSSEOpen, markProjectsFirst, markBootstrapDone } from "./perf"

export const RECENT_SIDEBAR_SESSIONS = 30

export function mergeProjectData(existing: ProjectData[], incoming: ProjectData[]): ProjectData[] {
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

export function useCapabilities(): Capabilities {
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

export function useProjects() {
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
    let firstProjectsBatch = true
    es.onopen = () => { setConnected(true); markSSEOpen() }
    es.onerror = () => {
      setConnected(false)
      setProjectsLoading(false)
    }
    es.addEventListener("projects_meta", e => {
      try {
        const o = JSON.parse((e as MessageEvent).data) as { total?: unknown }
        if (typeof o.total === "number") setTotalSessions(o.total)
      } catch { /* ignore */ }
    })
    es.addEventListener("projects", e => {
      try {
        const incoming = JSON.parse((e as MessageEvent).data) as ProjectData[]
        if (firstProjectsBatch) { markProjectsFirst(); firstProjectsBatch = false }
        setProjects(prev => mergeProjectData(prev, incoming))
      } catch { /* ignore */ }
    })
    es.addEventListener("bootstrap_done", () => {
      setProjectsLoading(false)
      requestAnimationFrame(() => markBootstrapDone(projectsRef.current.reduce((n, p) => n + p.sessions.length, 0)))
    })
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

export type { SessionMeta, ProjectData }
