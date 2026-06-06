import type { ProjectData, SessionMeta } from "./types"

export const RECENT_SIDEBAR_SESSIONS = 30

export function trimProjectsToMaxSessions(projects: ProjectData[], max: number): ProjectData[] {
  if (max <= 0 || !projects.length) return projects
  const flat: { p: ProjectData; s: SessionMeta; la: string }[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      flat.push({ p, s, la: String(s.lastActivity ?? "") })
    }
  }
  if (flat.length <= max) return projects
  flat.sort((a, b) => b.la.localeCompare(a.la))
  const keep = new Set(flat.slice(0, max).map(({ p, s }) => `${p.path}\x1f${s.id}`))
  const out: ProjectData[] = []
  for (const p of projects) {
    const sessions = p.sessions.filter(s => keep.has(`${p.path}\x1f${s.id}`))
    if (sessions.length) out.push({ ...p, sessions })
  }
  return out.sort((a, b) =>
    String(b.sessions[0]?.lastActivity ?? "").localeCompare(String(a.sessions[0]?.lastActivity ?? "")),
  )
}

export function mergeSessionUpsert(
  existing: ProjectData[],
  projectPath: string,
  projectDisplayName: string,
  session: SessionMeta,
): ProjectData[] {
  return mergeProjectData(existing, [{
    path: projectPath,
    displayName: projectDisplayName,
    sessions: [session],
  }])
}

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
