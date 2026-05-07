/**
 * Markdown-boundary chunker for AI session messages.
 *
 * Strategy:
 *  1. Extract fenced code blocks as standalone chunks (type="code") — they have
 *     very different token distributions from prose and embed better separately.
 *  2. Split remaining prose at heading and double-newline paragraph boundaries.
 *  3. Hard-cap each chunk at MAX_TEXT_CHARS / MAX_CODE_CHARS — well within
 *     CodeRankEmbed's 8192-token context (≈3 chars/token for code, 4 for text).
 *
 * Returns: { type: "text"|"code", text: string, lang?: string }[]
 */

const MAX_TEXT_CHARS = 2000  // ~500 tokens — keeps text chunks focused
const MAX_CODE_CHARS = 8000  // ~2000–2700 tokens — one or two functions

// Matches ```lang\n...content...\n``` fenced code blocks
const FENCE_RE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g

/**
 * @param {string} text
 * @returns {{ type: "text"|"code", lang?: string, text: string }[]}
 */
export function chunkMarkdown(text) {
  if (!text || !text.trim()) return []

  const chunks = []
  let lastEnd = 0
  FENCE_RE.lastIndex = 0

  let m
  while ((m = FENCE_RE.exec(text)) !== null) {
    // Prose before this code block
    const prose = text.slice(lastEnd, m.index)
    if (prose.trim()) chunks.push(...splitProse(prose))

    // Code block
    const lang = m[1] || "text"
    const code = m[2].trimEnd()
    if (code.trim()) chunks.push(...splitCode(code, lang))

    lastEnd = m.index + m[0].length
  }

  // Remaining prose after last fence
  const tail = text.slice(lastEnd)
  if (tail.trim()) chunks.push(...splitProse(tail))

  return chunks.filter(c => c.text.trim().length >= 8)
}

// ── Prose splitting ───────────────────────────────────────────────────────────

function splitProse(text) {
  // First split at ATX headings so each section stands alone
  const sections = text.split(/(?=\n#{1,4} )/)
  const out = []
  for (const section of sections) {
    if (!section.trim()) continue
    if (section.length <= MAX_TEXT_CHARS) {
      out.push({ type: "text", text: section.trim() })
    } else {
      // Section too large — split at paragraph boundaries
      const paras = section.split(/\n{2,}/)
      let current = ""
      for (const para of paras) {
        if (!para.trim()) continue
        if (current && current.length + para.length + 2 > MAX_TEXT_CHARS) {
          out.push({ type: "text", text: current.trim() })
          current = para
        } else {
          current = current ? `${current}\n\n${para}` : para
        }
      }
      if (current.trim()) out.push({ type: "text", text: current.trim() })
    }
  }
  return out
}

// ── Code splitting ────────────────────────────────────────────────────────────

function splitCode(code, lang) {
  if (code.length <= MAX_CODE_CHARS) return [{ type: "code", lang, text: code }]

  // Split at double blank lines — natural function/class separators
  const blocks = code.split(/\n{2,}/)
  const out = []
  let current = ""
  for (const block of blocks) {
    if (!block.trim()) continue
    if (current && current.length + block.length + 2 > MAX_CODE_CHARS) {
      out.push({ type: "code", lang, text: current.trimEnd() })
      current = block
    } else {
      current = current ? `${current}\n\n${block}` : block
    }
  }
  if (current.trim()) out.push({ type: "code", lang, text: current.trimEnd() })
  return out.length ? out : [{ type: "code", lang, text: code.slice(0, MAX_CODE_CHARS) }]
}
