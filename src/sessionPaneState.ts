export interface PinnedProjectPath {
  readonly current: string
  diverges(nextProjectPath: string): boolean
}

export interface WindowLike {
  startIdx: number
  serverFetchedFrom: number
  globalOffset?: number
  filteredTotal?: number
}

export interface LoadEarlierControlState {
  show: boolean
  disabled: boolean
  label: string
}

interface ProjectWithSessions<TSession extends { id: string; source?: string }> {
  path: string
  sessions: TSession[]
}

/** Resolve duplicate-UUID deep links to the provider-native project when one exists. */
export function resolveSessionProject<TSession extends { id: string; source?: string }>(
  projects: ProjectWithSessions<TSession>[],
  selectedProjectPath: string | null | undefined,
  sessionId: string | null | undefined,
): ProjectWithSessions<TSession> | undefined {
  if (!sessionId) return selectedProjectPath ? projects.find(project => project.path === selectedProjectPath) : undefined
  const candidates = projects.filter(project => project.sessions.some(session => session.id === sessionId))
  const selected = candidates.find(project => project.path === selectedProjectPath)
  const providerNative = candidates.find(project => {
    const session = project.sessions.find(item => item.id === sessionId)
    return session?.source && session.source !== "claude" && project.path.startsWith(`${session.source}:`)
  })
  if (selected?.path.includes("/.claude/projects/") && providerNative) return providerNative
  return selected ?? providerNative ?? candidates[0]
}

export function createPinnedProjectPath(projectPath: string): PinnedProjectPath {
  const current = projectPath
  return {
    current,
    diverges(nextProjectPath: string) {
      return nextProjectPath !== current
    },
  }
}

export function hasEarlierMessages(win: WindowLike | null | undefined): boolean {
  return !!win && (win.startIdx > 0 || win.serverFetchedFrom > 0 || (win.globalOffset ?? 0) > 0)
}

export function getLoadEarlierControlState(
  win: WindowLike | null | undefined,
  loadingMore: boolean,
  initialRemotePending: boolean,
): LoadEarlierControlState {
  if (!win) return { show: false, disabled: false, label: "" }
  const hasEarlier = hasEarlierMessages(win)
  if (hasEarlier) {
    return {
      show: true,
      disabled: loadingMore,
      label: loadingMore ? "Loading earlier messages…" : "↑ Load earlier messages",
    }
  }
  if (loadingMore || initialRemotePending) {
    return {
      show: true,
      disabled: true,
      label: "Checking for earlier messages…",
    }
  }
  return { show: false, disabled: false, label: "" }
}

export function canonicalizeSelectedProjectPath(
  selectedProjectPath: string | null | undefined,
  activeProjectPath: string | null | undefined,
  activeMetaProjectPath: string | null | undefined,
): string | null {
  return activeMetaProjectPath ?? activeProjectPath ?? selectedProjectPath ?? null
}
