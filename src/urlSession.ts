/** Parse `?s=projectPath/sessionId` from the current URL (deep link). */
export function parseUrlSession(search = window.location.search): { project: string; session: string } | null {
  const raw = new URLSearchParams(search).get("s")
  if (!raw) return null
  const subagent = /^([\s\S]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/subagents\/[\s\S]+)$/i.exec(raw)
  if (subagent) {
    try {
      return { project: decodeURIComponent(subagent[1]), session: subagent[2] }
    } catch {
      return null
    }
  }
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
