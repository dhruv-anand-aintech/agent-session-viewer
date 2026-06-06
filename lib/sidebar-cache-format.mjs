/** Pure helpers: cache DB rows → API / SSE project payloads. */

export function cacheEntryToSessionRow(e, names = {}) {
  return {
    id: e.id,
    projectPath: e.projectPath,
    lastActivity: e.lastActivity,
    messageCount: e.messageCount ?? 0,
    userMessageCount: e.userMessageCount ?? null,
    firstName: e.firstName ?? null,
    customName: names[`${e.projectPath}/${e.id}`] ?? e.customName ?? null,
    source: e.source ?? "claude",
    isActive: false,
    ...(e.isSidechain ? { isSidechain: true, parentSessionId: e.parentSessionId, agentType: e.agentType } : {}),
  }
}

/** Group cache session rows into ProjectData[] (sessions pre-sorted by lastActivity desc). */
export function groupCacheSessionsToProjects(entries, names = {}) {
  const projectMap = new Map()
  for (const e of entries) {
    if (!projectMap.has(e.projectPath)) {
      projectMap.set(e.projectPath, {
        path: e.projectPath,
        displayName: e.projectDisplayName,
        sessions: [],
      })
    }
    projectMap.get(e.projectPath).sessions.push(cacheEntryToSessionRow(e, names))
  }
  return Array.from(projectMap.values())
}

export function sessionUpsertPayload(entry, names = {}) {
  return {
    projectPath: entry.projectPath,
    projectDisplayName: entry.projectDisplayName,
    session: cacheEntryToSessionRow(entry, names),
  }
}
