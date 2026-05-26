import { useState, useEffect, useRef, useCallback } from "react"
import "./GlobalSearch.css"

export interface GlobalSearchHit {
  source: string
  projectPath: string
  sessionId: string
  snippets: string[]
  // Enriched by the sidebar session list if available
  displayTitle?: string
}

interface Props {
  onNavigate: (projectPath: string, sessionId: string, query: string) => void
  onClose: () => void
  /** Optional session metadata map for title enrichment */
  sessionTitles?: Map<string, string>
}

const SOURCE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
  opencode: "OpenCode",
  hermes: "Hermes",
}

const SOURCE_DOTS: Record<string, string> = {
  claude: "dot-claude",
  codex: "dot-codex",
  antigravity: "dot-antigravity",
  cursor: "dot-cursor",
  opencode: "dot-opencode",
  hermes: "dot-hermes",
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <span>{text}</span>
  const q = query.trim()
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return <span>{text}</span>
  return (
    <span>
      {text.slice(0, idx)}
      <mark className="gs-highlight">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </span>
  )
}

export function GlobalSearch({ onNavigate, onClose, sessionTitles }: Props) {
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<GlobalSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [ms, setMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const seqRef = useRef(0)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // Search when query changes (300ms delay)
  useEffect(() => {
    const q = query.trim()
    const id = ++seqRef.current
    if (!q) {
      setHits([])
      setMs(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/global?q=${encodeURIComponent(q)}`, { credentials: "include" })
        if (id !== seqRef.current) return
        const data = await res.json()
        if (id !== seqRef.current) return
        setHits(data.hits ?? [])
        setMs(data.ms ?? null)
        setError(data.error ?? null)
        setActiveIdx(0)
      } catch (e: unknown) {
        if (id !== seqRef.current) return
        setError(e instanceof Error ? e.message : "Search failed")
        setHits([])
      } finally {
        if (id === seqRef.current) setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  // Keyboard navigation through results
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, hits.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === "Enter" && hits.length > 0) {
      e.preventDefault()
      const hit = hits[activeIdx]
      if (hit) { onNavigate(hit.projectPath, hit.sessionId, query.trim()); onClose() }
    }
  }, [hits, activeIdx, onNavigate, onClose])

  // Scroll active result into view
  useEffect(() => {
    const el = resultsRef.current?.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIdx])

  function titleFor(hit: GlobalSearchHit): string {
    const key = `${hit.projectPath}/${hit.sessionId}`
    const fromMap = sessionTitles?.get(key)
    if (fromMap) return fromMap
    // Fallback: last segment of projectPath + short session id
    const parts = hit.projectPath.replace(/\\/g, "/").split("/")
    const dir = parts[parts.length - 1] ?? ""
    return dir ? `${dir} / ${hit.sessionId.slice(0, 8)}` : hit.sessionId.slice(0, 8)
  }

  return (
    <div className="gs-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gs-modal" role="dialog" aria-label="Global search">
        <div className="gs-input-row">
          <span className="gs-input-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.6"/>
              <line x1="10.1" y1="10.1" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </span>
          <input
            ref={inputRef}
            className="gs-input"
            type="search"
            placeholder="Search all transcripts…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <span className="gs-spinner" aria-label="Searching…" />}
          {!loading && ms !== null && query.trim() && (
            <span className="gs-meta-badge">{hits.length} result{hits.length !== 1 ? "s" : ""} · {ms}ms</span>
          )}
          <button className="gs-close-btn" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {error && <div className="gs-error">Search error: {error}</div>}

        {hits.length === 0 && query.trim() && !loading && !error && (
          <div className="gs-empty">No matches found for <strong>{query}</strong></div>
        )}

        {hits.length === 0 && !query.trim() && (
          <div className="gs-hint">
            <div className="gs-hint-line">Search across all Claude, Codex, and Antigravity transcripts</div>
            <div className="gs-hint-keys">
              <span><kbd>↑↓</kbd> navigate</span>
              <span><kbd>Enter</kbd> open</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </div>
        )}

        {hits.length > 0 && (
          <div className="gs-results" ref={resultsRef}>
            {hits.map((hit, i) => (
              <button
                key={`${hit.projectPath}/${hit.sessionId}`}
                data-idx={i}
                className={`gs-result${i === activeIdx ? " gs-result--active" : ""}`}
                onClick={() => { onNavigate(hit.projectPath, hit.sessionId, query.trim()); onClose() }}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <div className="gs-result-head">
                  <span className={`gs-dot ${SOURCE_DOTS[hit.source] ?? ""}`} />
                  <span className="gs-result-title">{titleFor(hit)}</span>
                  <span className="gs-result-source">{SOURCE_LABELS[hit.source] ?? hit.source}</span>
                </div>
                {hit.snippets.length > 0 && (
                  <div className="gs-result-snippets">
                    {hit.snippets.slice(0, 2).map((s, si) => (
                      <div key={si} className="gs-result-snippet">
                        <HighlightedSnippet text={s} query={query.trim()} />
                      </div>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
