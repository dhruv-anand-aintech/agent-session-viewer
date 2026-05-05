/**
 * Shared search helpers for sidebar (multi-session) and thread (single-session) search.
 */
import Fuse from "fuse.js"

function flattenContent(content) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    if (b.type === "text") out += `${b.text ?? ""}\n`
    else if (b.type === "thinking") out += `${b.thinking ?? ""}\n`
    else if (b.type === "tool_use")
      out += `${b.name ?? ""} ${safeJson(b.input)}\n`
    else if (b.type === "tool_result") out += `${safeJson(b.content)}\n`
    else out += `${safeJson(b)}\n`
  }
  return out
}

function safeJson(x) {
  try {
    const s = JSON.stringify(x)
    return s.length > 6000 ? s.slice(0, 6000) + "…" : s
  } catch {
    return ""
  }
}

/** Light strip of XML-ish tags for user text (parity with frontend stripXml intent). */
export function stripXmlLight(text) {
  if (!text || typeof text !== "string") return ""
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-notification[\s\S]*?<\/task-notification>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** All searchable plaintext from one message (thread search). */
export function flattenMessageForThread(msg) {
  if (!msg || msg.type === "file-history-snapshot") return ""
  const parts = []
  if (msg.message?.content) parts.push(flattenContent(msg.message.content))
  if (msg.data != null) parts.push(typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data))
  if (msg.toolUseResult != null)
    parts.push(typeof msg.toolUseResult === "string" ? msg.toolUseResult : JSON.stringify(msg.toolUseResult))
  return parts.join("\n").trim()
}

function normalizeKeywordText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenizeQuery(query) {
  return normalizeKeywordText(query)
    .split(" ")
    .filter(t => t.length >= 2)
    .slice(0, 12)
}

function countTermHits(text, term) {
  let hits = 0
  let idx = text.indexOf(term)
  while (idx !== -1) {
    hits++
    idx = text.indexOf(term, idx + term.length)
  }
  return hits
}

function scoreKeywordHit(text, terms, phrase) {
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

/**
 * @param {unknown[]} msgs
 * @param {Record<string, unknown>} meta — id, firstName?, customName?
 */
export function buildSidebarSearchDoc(msgs, meta) {
  const id = String(meta?.id ?? "")
  const title = [meta?.customName, meta?.firstName, id.slice(0, 8)].filter(Boolean).join(" ").trim() || id

  let firstUser = ""
  const userParts = []
  const systemParts = []
  const asstParts = []

  const list = Array.isArray(msgs) ? msgs : []
  for (const m of list) {
    if (m.type === "file-history-snapshot") continue
    const role = m.message?.role
    const isUser = role === "user" || m.type === "user" || m.type === "human"
    const isAsst = role === "assistant" || m.type === "assistant"

    if (isUser && m.message?.content) {
      const u = stripXmlLight(flattenContent(m.message.content))
      if (u) {
        userParts.push(u)
        if (!firstUser) firstUser = u
      }
    }

    if (role === "system" || m.type === "progress") {
      const sys = flattenMessageForThread(m)
      if (sys) systemParts.push(sys)
      continue
    }

    if (isAsst && m.message?.content) {
      const a = flattenContent(m.message.content)
      if (a) asstParts.push(a)
    }

    if (!isUser && !isAsst && !isAssistantish(role, m.type) && m.data) {
      const sys = flattenMessageForThread(m)
      if (sys) systemParts.push(sys)
    }
  }

  return {
    title,
    firstUser,
    allUser: userParts.join("\n"),
    system: systemParts.join("\n"),
    assistant: asstParts.join("\n"),
  }
}

function isAssistantish(role, type) {
  return role === "assistant" || type === "assistant"
}

/** @typedef {{ projectPath: string, sessionId: string, displayTitle: string, meta: Record<string,unknown>, corpus: ReturnType<typeof buildSidebarSearchDoc> }} SidebarSearchRow */

/** @returns {{ projectPath: string, sessionId: string, displayTitle: string, score?: number, bestKey: string }[]} */
export function runSidebarSessionSearch(query, rows) {
  const q = (query ?? "").trim()
  if (!q || !rows.length) return []

  /** @type {{ projectPath: string, sessionId: string, displayTitle: string, title: string, firstUser: string, allUser: string, system: string, assistant: string, meta: Record<string, unknown> }[]} */
  const flat = rows.map(r => ({
    ...r,
    title: r.corpus.title,
    firstUser: r.corpus.firstUser,
    allUser: r.corpus.allUser,
    system: r.corpus.system,
    assistant: r.corpus.assistant,
  }))

  const fuse = new Fuse(flat, {
    keys: [
      { name: "title", weight: 0.37 },
      { name: "firstUser", weight: 0.28 },
      { name: "allUser", weight: 0.22 },
      { name: "system", weight: 0.09 },
      { name: "assistant", weight: 0.04 },
    ],
    threshold: 0.42,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 1,
    distance: 80,
  })

  const keyPriority = { title: 0, firstUser: 1, allUser: 2, system: 3, assistant: 4 }

  const scored = fuse.search(q)
  return scored.slice(0, 200).map(hit => {
    const item = hit.item
    /** @type Record<string, string> */
    const fields = {
      title: item.title,
      firstUser: item.firstUser,
      allUser: item.allUser,
      system: item.system,
      assistant: item.assistant,
    }
    let bestKey = "title"
    let bestRank = 999
    for (const m of hit.matches ?? []) {
      const k = String(m.key ?? "")
      if (k in keyPriority && keyPriority[k] < bestRank) {
        bestRank = keyPriority[k]
        bestKey = k
      }
    }
    const excerpt =
      snippetFromField(fields[bestKey] || "") ||
      snippetFromField(item.displayTitle || "")
    return {
      projectPath: item.projectPath,
      sessionId: item.sessionId,
      displayTitle: item.displayTitle,
      score: hit.score,
      bestKey,
      snippet: excerpt,
      meta: item.meta || {},
    }
  })
}

function snippetFromField(text) {
  if (!text || !text.trim()) return ""
  const t = text.replace(/\s+/g, " ").trim()
  if (t.length <= 160) return t
  return `${t.slice(0, 160)}…`
}

/** @typedef {{ idx: number, text: string }} ThreadSearchRow */

/** @returns {{ idx: number, text: string, score?: number }[]} */
export function runThreadSearch(query, msgs) {
  const q = (query ?? "").trim()
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

/**
 * Fast keyword-only thread search. Scans the full thread in-memory and ranks
 * messages by exact phrase and term coverage, avoiding global top-N filtering.
 * @returns {{ idx: number, text: string, score: number }[]}
 */
export function runThreadKeywordSearch(query, msgs, limit = 40) {
  const q = (query ?? "").trim()
  if (!q || !Array.isArray(msgs)) return []

  const terms = tokenizeQuery(q)
  if (!terms.length) return []
  const phrase = normalizeKeywordText(q)

  const hits = []
  for (let idx = 0; idx < msgs.length; idx++) {
    const text = flattenMessageForThread(msgs[idx])
    if (!text) continue
    const norm = normalizeKeywordText(text)
    if (!norm) continue
    const score = scoreKeywordHit(norm, terms, phrase)
    if (score > 0) hits.push({ idx, text, score })
  }

  return hits.sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, limit)
}
