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
