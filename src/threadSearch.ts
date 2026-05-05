/** Client-side keyword thread search (parity with lib/session-search-core.mjs runThreadKeywordSearch). */
import type { SessionMessage } from "./types"

export type ThreadSearchHit = { idx: number; text: string; score?: number }

function flattenContent(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    const block = b as Record<string, unknown>
    if (block.type === "text") out += `${String(block.text ?? "")}\n`
    else if (block.type === "thinking") out += `${String(block.thinking ?? "")}\n`
    else if (block.type === "tool_use") out += `${String(block.name ?? "")} ${safeJson(block.input)}\n`
    else if (block.type === "tool_result") out += `${safeJson(block.content)}\n`
    else out += `${safeJson(block)}\n`
  }
  return out
}

function flattenMessageForThread(msg: SessionMessage): string {
  if (!msg || msg.type === "file-history-snapshot") return ""
  const parts: string[] = []
  if (msg.message?.content) parts.push(flattenContent(msg.message.content))
  if (msg.data != null) parts.push(typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data))
  if (msg.toolUseResult != null)
    parts.push(typeof msg.toolUseResult === "string" ? msg.toolUseResult : JSON.stringify(msg.toolUseResult))
  return parts.join("\n").trim()
}

function safeJson(x: unknown): string {
  try {
    const s = JSON.stringify(x)
    return s.length > 6000 ? s.slice(0, 6000) + "…" : s
  } catch {
    return ""
  }
}

function normalizeKeywordText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenizeQuery(query: string): string[] {
  return normalizeKeywordText(query)
    .split(" ")
    .filter(t => t.length >= 2)
    .slice(0, 12)
}

function countTermHits(text: string, term: string): number {
  let hits = 0
  let idx = text.indexOf(term)
  while (idx !== -1) {
    hits++
    idx = text.indexOf(term, idx + term.length)
  }
  return hits
}

function scoreKeywordHit(text: string, terms: string[], phrase: string): number {
  if (!terms.length) return 0
  const phrasePos = phrase ? text.indexOf(phrase) : -1
  let score = 0
  let matched = 0

  if (phrasePos !== -1) {
    score += 30 + Math.max(0, 12 - Math.floor(phrasePos / 10))
  }

  for (const term of terms) {
    const pos = text.indexOf(term)
    if (pos === -1) continue
    matched++
    score += 8 + Math.max(0, 8 - Math.floor(pos / 25))
    score += Math.min(4, countTermHits(text, term))
  }

  if (!matched) return 0
  if (matched === terms.length) score += 15
  score += matched * 2
  return score
}

export function runThreadSearch(query: string, msgs: SessionMessage[]): ThreadSearchHit[] {
  const q = (query ?? "").trim()
  if (!q || !Array.isArray(msgs)) return []

  const terms = tokenizeQuery(q)
  if (!terms.length) return []
  const phrase = normalizeKeywordText(q)

  const hits: ThreadSearchHit[] = []
  for (let idx = 0; idx < msgs.length; idx++) {
    const text = flattenMessageForThread(msgs[idx])
    if (!text) continue
    const norm = normalizeKeywordText(text)
    if (!norm) continue
    const score = scoreKeywordHit(norm, terms, phrase)
    if (score > 0) hits.push({ idx, text, score })
  }

  return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.idx - b.idx).slice(0, 40)
}
