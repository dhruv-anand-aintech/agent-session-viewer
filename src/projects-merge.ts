import type { ProjectData, SessionMeta } from "./types"

export const RECENT_SIDEBAR_SESSIONS = 30

/** Keep parent↔subagent pairs intact after top-N trimming (matches server-side cache expansion). */
export function expandProjectsLinkage(projects: ProjectData[], pool?: ProjectData[]): ProjectData[] {
  if (!projects.length) return projects
  const source = pool ?? projects
  const poolFlat: { p: ProjectData; s: SessionMeta }[] = []
  for (const p of source) {
    for (const s of p.sessions) poolFlat.push({ p, s })
  }
  const byId = new Map<string, { p: ProjectData; s: SessionMeta }>()
  for (const p of projects) {
    for (const s of p.sessions) byId.set(s.id, { p, s })
  }
  const add = (item: { p: ProjectData; s: SessionMeta }) => {
    if (!byId.has(item.s.id)) byId.set(item.s.id, item)
  }
  for (const { s } of [...byId.values()]) {
    if (s.isSidechain && s.parentSessionId) {
      const parent = poolFlat.find(x => x.s.id === s.parentSessionId)
      if (parent) add(parent)
    }
  }
  for (const { s } of [...byId.values()]) {
    if (s.isSidechain) continue
    for (const item of poolFlat) {
      if (item.s.isSidechain && item.s.parentSessionId === s.id) add(item)
    }
  }
  const projectMap = new Map<string, ProjectData>()
  for (const { p, s } of byId.values()) {
    const cur = projectMap.get(p.path)
    if (!cur) projectMap.set(p.path, { ...p, sessions: [s] })
    else cur.sessions.push(s)
  }
  return Array.from(projectMap.values())
    .map(p => ({
      ...p,
      sessions: p.sessions.sort((a, b) =>
        String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? "")),
      ),
    }))
    .sort((a, b) =>
      String(b.sessions[0]?.lastActivity ?? "").localeCompare(String(a.sessions[0]?.lastActivity ?? "")),
    )
}

export function trimProjectsToMaxSessions(
  projects: ProjectData[],
  max: number,
  pinSessionIds?: ReadonlySet<string> | string[],
): ProjectData[] {
  if (max <= 0 || !projects.length) return projects
  const pinned = pinSessionIds instanceof Set
    ? pinSessionIds
    : new Set(pinSessionIds ?? [])
  const flat: { p: ProjectData; s: SessionMeta; la: string }[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      flat.push({ p, s, la: String(s.lastActivity ?? "") })
    }
  }
  if (flat.length <= max) return projects
  flat.sort((a, b) => b.la.localeCompare(a.la))
  const keepKeys = flat.slice(0, max).map(({ p, s }) => `${p.path}\x1f${s.id}`)
  for (const { p, s } of flat) {
    if (pinned.has(s.id) && !keepKeys.includes(`${p.path}\x1f${s.id}`)) {
      keepKeys.push(`${p.path}\x1f${s.id}`)
    }
  }
  const keep = new Set(keepKeys)
  const out: ProjectData[] = []
  for (const p of projects) {
    const sessions = p.sessions.filter(s => keep.has(`${p.path}\x1f${s.id}`))
    if (sessions.length) out.push({ ...p, sessions })
  }
  const trimmed = out.sort((a, b) =>
    String(b.sessions[0]?.lastActivity ?? "").localeCompare(String(a.sessions[0]?.lastActivity ?? "")),
  )
  return expandProjectsLinkage(trimmed, projects)
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
        ...(session.isSidechain || prev?.isSidechain ? {
          isSidechain: true as const,
          parentSessionId: session.parentSessionId ?? prev?.parentSessionId,
          agentType: session.agentType ?? prev?.agentType,
        } : {}),
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
