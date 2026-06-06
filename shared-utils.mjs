/**
 * Shared utilities for local-server and build-cache
 */

export function stripXml(text) {
  return text
    .replace(/<[^>]+>[^<]*<\/[^>]+>/g, " ")  // paired tags with content
    .replace(/<[^>]+>/g, " ")                 // standalone tags
    .replace(/\s+/g, " ")                     // collapse whitespace
    .trim()
}

const SESS_KEY = (path, id) => `${path}\x1f${id}`

/** Count sessions across project groups */
export function countSessionsInProjects(projects) {
  if (!Array.isArray(projects)) return 0
  let n = 0
  for (const p of projects) n += p.sessions?.length ?? 0
  return n
}

/** Keep parent↔subagent pairs when trimming top-N session lists. */
export function expandProjectsLinkage(projects, pool) {
  if (!projects?.length) return projects
  const source = pool ?? projects
  const poolFlat = []
  for (const p of source) {
    for (const s of p.sessions ?? []) poolFlat.push({ p, s })
  }
  const byId = new Map()
  for (const p of projects) {
    for (const s of p.sessions ?? []) byId.set(s.id, { p, s })
  }
  const add = item => {
    if (!byId.has(item.s.id)) byId.set(item.s.id, item)
  }
  for (const { s } of byId.values()) {
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
  const projectMap = new Map()
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

/**
 * Keep only the `max` most recently active sessions (by lastActivity), regrouped under projects.
 */
export function trimProjectsByRecentSessionCount(projects, max) {
  if (max == null || max <= 0 || !Array.isArray(projects) || !projects.length) return projects
  const flat = []
  for (const p of projects) {
    for (const s of p.sessions ?? []) {
      flat.push({ p, s, la: String(s.lastActivity ?? "") })
    }
  }
  if (flat.length <= max) return projects
  flat.sort((a, b) => b.la.localeCompare(a.la))
  const keep = new Set(flat.slice(0, max).map(({ p, s }) => SESS_KEY(p.path, s.id)))
  const out = []
  for (const p of projects) {
    const sessions = (p.sessions ?? []).filter(s => keep.has(SESS_KEY(p.path, s.id)))
    if (sessions.length) out.push({ ...p, sessions })
  }
  out.sort((a, b) =>
    String(b.sessions[0]?.lastActivity ?? "").localeCompare(String(a.sessions[0]?.lastActivity ?? ""))
  )
  return expandProjectsLinkage(out, projects)
}
