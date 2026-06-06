import { useState, useEffect, useRef, useCallback } from "react"
import type { Capabilities, ProjectData, SessionMeta } from "./types"
import { markSSEOpen, markProjectsFirst, markBootstrapDone } from "./perf"
import {
  RECENT_SIDEBAR_SESSIONS,
  mergeProjectData,
  mergeSessionUpsert,
  trimProjectsToMaxSessions,
} from "./projects-merge"
import { trackedEventSource } from "./sse-lifecycle"

export { RECENT_SIDEBAR_SESSIONS, mergeProjectData, mergeSessionUpsert } from "./projects-merge"

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
  const [projectsUpdating, setProjectsUpdating] = useState(true)
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
      setProjectsUpdating(true)
      if (listMode === "recent" || projectsRef.current.length === 0) setProjects([])
      setTotalSessions(null)
    })
    const es = trackedEventSource(`/api/stream${qs}`)
    let firstProjectsBatch = true
    es.onopen = () => { setConnected(true); markSSEOpen() }
    es.onerror = () => {
      setConnected(false)
      setProjectsLoading(false)
      setProjectsUpdating(false)
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
        if (firstProjectsBatch) {
          markProjectsFirst()
          firstProjectsBatch = false
          setProjectsLoading(false)
        }
        setProjects(prev => mergeProjectData(prev, incoming))
      } catch { /* ignore */ }
    })
    es.addEventListener("session_upsert", e => {
      try {
        const o = JSON.parse((e as MessageEvent).data) as {
          projectPath?: string
          projectDisplayName?: string
          session?: SessionMeta
        }
        if (!o.projectPath || !o.session) return
        if (firstProjectsBatch) {
          markProjectsFirst()
          firstProjectsBatch = false
          setProjectsLoading(false)
        }
        setProjects(prev => {
          let next = mergeSessionUpsert(
            prev,
            o.projectPath!,
            o.projectDisplayName ?? o.projectPath!,
            o.session!,
          )
          if (listMode === "recent") next = trimProjectsToMaxSessions(next, RECENT_SIDEBAR_SESSIONS)
          return next
        })
      } catch { /* ignore */ }
    })
    es.addEventListener("bootstrap_done", () => {
      setProjectsLoading(false)
      if (listMode === "full") setProjectsUpdating(false)
      requestAnimationFrame(() => markBootstrapDone(projectsRef.current.reduce((n, p) => n + p.sessions.length, 0)))
    })
    es.addEventListener("background_done", () => {
      setProjectsUpdating(false)
    })
    return () => {
      es.close()
      setProjectsLoading(false)
      setProjectsUpdating(false)
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
    projectsUpdating,
    totalSessions,
    listMode,
    sessionsTruncated,
    loadAllSessions,
  }
}

export type { SessionMeta, ProjectData }
