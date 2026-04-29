/** Client-side fuzzy thread search (parity with lib/session-search-core.mjs runThreadSearch). */
import Fuse from "fuse.js"
import type { ContentBlock, SessionMessage } from "./types"

function safeJson(x: unknown): string {
  try {
    const s = JSON.stringify(x)
    return s.length > 6000 ? s.slice(0, 6000) + "…" : s
  } catch {
    return ""
  }
}

function flattenContent(content: string | ContentBlock[] | undefined): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    if (b.type === "text") out += `${(b as ContentBlock & { text?: string }).text ?? ""}\n`
    else if (b.type === "thinking") out += `${(b as ContentBlock & { thinking?: string }).thinking ?? ""}\n`
    else if (b.type === "tool_use")
      out += `${(b as ContentBlock & { name?: string }).name ?? ""} ${safeJson((b as ContentBlock & { input?: unknown }).input)}\n`
    else if (b.type === "tool_result") out += `${safeJson((b as ContentBlock & { content?: unknown }).content)}\n`
    else out += `${safeJson(b)}\n`
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

export type ThreadSearchHit = { idx: number; text: string; score?: number }

export function runThreadSearch(query: string, msgs: SessionMessage[]): ThreadSearchHit[] {
  const q = query.trim()
  if (!q || !Array.isArray(msgs)) return []

  const rows = msgs
    .map((msg, idx) => ({ idx, text: flattenMessageForThread(msg) }))
    .filter(r => r.text.length > 0)

  if (!rows.length) return []

  const fuse = new Fuse(rows, {
    keys: ["text"],
    threshold: 0.42,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 1,
    distance: 100,
  })

  return fuse.search(q).map(hit => ({ ...hit.item, score: hit.score }))
}
