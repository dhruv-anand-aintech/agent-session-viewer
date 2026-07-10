/**
 * Shared utilities for local-server and build-cache
 */
import { openSync, readSync, closeSync } from "node:fs"

/**
 * Parse a JSONL file by streaming fixed-size chunks instead of reading the whole
 * file into one string (peak memory ≈ one chunk + parsed objects, not 3-4× file size).
 * Splits on the newline byte before decoding so multibyte UTF-8 never straddles a decode.
 */
export function parseJsonlStream(fp) {
  const out = []
  let fd = null
  try {
    fd = openSync(fp, "r")
    const CHUNK = 1 << 20
    const buf = Buffer.alloc(CHUNK)
    let carry = Buffer.alloc(0)
    let bytes
    while ((bytes = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, bytes)]) : buf.subarray(0, bytes)
      let start = 0
      let nl
      while ((nl = chunk.indexOf(10, start)) !== -1) {
        if (nl > start) {
          try { out.push(JSON.parse(chunk.toString("utf8", start, nl))) } catch { /* skip bad line */ }
        }
        start = nl + 1
      }
      carry = Buffer.from(chunk.subarray(start)) // copy: `buf` is reused next iteration
    }
    if (carry.length) {
      try { out.push(JSON.parse(carry.toString("utf8"))) } catch { /* skip bad line */ }
    }
    return out
  } catch {
    return []
  } finally {
    if (fd != null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/** True when a Claude JSONL contains at least one viewable transcript record. */
export function hasClaudeTranscriptMessage(fp) {
  let fd = null
  try {
    fd = openSync(fp, "r")
    const CHUNK = 1 << 16
    const buf = Buffer.alloc(CHUNK)
    let carry = Buffer.alloc(0)
    let bytes
    while ((bytes = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, bytes)]) : buf.subarray(0, bytes)
      let start = 0
      let nl
      while ((nl = chunk.indexOf(10, start)) !== -1) {
        if (nl > start) {
          try {
            if (JSON.parse(chunk.toString("utf8", start, nl))?.type !== "file-history-snapshot") return true
          } catch { /* skip bad line */ }
        }
        start = nl + 1
      }
      carry = Buffer.from(chunk.subarray(start))
    }
    if (carry.length) {
      try { return JSON.parse(carry.toString("utf8"))?.type !== "file-history-snapshot" } catch { /* skip bad line */ }
    }
    return false
  } catch {
    return false
  } finally {
    if (fd != null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

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
