/** Client-side keyword thread search (parity with lib/session-search-core.mjs runThreadKeywordSearch). */
import type { SessionMessage } from "./types"

export type ThreadSearchHit = { idx: number; text: string; uuid?: string; score?: number }

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


export function runThreadSearch(query: string, msgs: SessionMessage[]): ThreadSearchHit[] {
  const q = (query ?? "").trim()
  if (!q || !Array.isArray(msgs)) return []

  let re: RegExp
  try {
    re = new RegExp(q, "gi")
  } catch {
    re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
  }

  const hits: ThreadSearchHit[] = []
  for (let idx = 0; idx < msgs.length; idx++) {
    const text = flattenMessageForThread(msgs[idx])
    if (!text) continue
    re.lastIndex = 0
    const match = re.exec(text)
    if (!match) continue
    const score = Math.max(1, 1000 - match.index)
    hits.push({ idx, text, uuid: msgs[idx]?.uuid, score })
  }

  return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.idx - b.idx).slice(0, 40)
}
