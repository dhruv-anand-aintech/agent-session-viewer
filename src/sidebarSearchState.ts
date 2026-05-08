export interface SidebarSearchResultItem {
  key: string
  s: {
    id: string
    source?: string
    customName?: string
    firstName?: string
  }
  projectPath: string
  sessionId: string
  highlightTitleQuery?: string
  searchMatch?: {
    fieldLabel?: string
    snippet: string
    highlightQuery: string
  }
}

function dedupeKey(item: SidebarSearchResultItem): string {
  return `${item.projectPath}/${item.sessionId}`
}

export function mergeSidebarSearchResultItems(
  primary: SidebarSearchResultItem[],
  secondary: SidebarSearchResultItem[],
): SidebarSearchResultItem[] {
  const seen = new Set<string>()
  const merged: SidebarSearchResultItem[] = []

  for (const item of [...primary, ...secondary]) {
    const key = dedupeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }

  return merged
}
