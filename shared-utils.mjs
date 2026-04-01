/**
 * Shared utilities for local-server and daemon
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
  return out
}
