import type { ReactNode } from "react"

/** Wrap occurrences of whitespace-separated query terms in `<mark class="search-highlight">` (case-insensitive). */
export function highlightTermsInPlainText(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q || !text) return text
  const terms = [...new Set(q.split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!terms.length) return text
  try {
    const pattern = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const re = new RegExp(`(${pattern})`, "gi")
    const parts = text.split(re)
    return (
      <>
        {parts.map((part, i) =>
          i % 2 === 1 ? (
            <mark key={i} className="search-highlight">
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </>
    )
  } catch {
    return text
  }
}
