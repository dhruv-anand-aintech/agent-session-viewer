import fs from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

export const CLAUDE_PROJECTS_ROOT = path.join(homedir(), ".claude", "projects")

const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const INDEX_TTL_MS = 30 * 1000
let _cached = null

function walkFiles(root, predicate, out = []) {
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walkFiles(full, predicate, out)
    else if (entry.isFile() && predicate(full)) out.push(full)
  }
  return out
}

function parseJsonl(fp) {
  try {
    return fs.readFileSync(fp, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch {
    return []
  }
}

function textFromContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map(part => {
      if (typeof part?.text === "string") return part.text
      if (typeof part?.content === "string") return part.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function unescapeShellDoubleQuoted(text) {
  return text.replace(/\\(["\\$`])/g, "$1").replace(/\\n/g, "\n")
}

function quotedStrings(command) {
  const out = []
  const re = /"((?:\\.|[^"\\])*)"/g
  let m
  while ((m = re.exec(command))) out.push(unescapeShellDoubleQuoted(m[1]))
  return out
}

export function extractCodexCompanionTaskText(command) {
  if (typeof command !== "string") return null
  if (!command.includes("codex-companion.mjs") || !/\btask\b/.test(command)) return null
  const quoted = quotedStrings(command).filter(s => s.length > 40)
  if (quoted.length) return quoted.at(-1)
  const taskIdx = command.indexOf(" task ")
  return taskIdx === -1 ? null : command.slice(taskIdx + " task ".length).trim()
}

function normalizeText(text) {
  return String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\n/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenSet(text) {
  return new Set(normalizeText(text).split(" ").filter(t => t.length >= 5))
}

function tokenOverlap(a, b) {
  if (!a.size || !b.size) return 0
  let common = 0
  for (const t of a) if (b.has(t)) common++
  return common / Math.min(a.size, b.size)
}

function claudeSubagentIdFromPath(fp, root) {
  const rel = path.relative(root, fp).split(path.sep)
  const subIdx = rel.indexOf("subagents")
  if (subIdx < 2) return null
  const parentSessionId = rel[subIdx - 1]
  const tail = rel.slice(subIdx + 1)
  if (!parentSessionId || !tail.length) return null
  const last = tail.at(-1)
  if (!last?.endsWith(".jsonl")) return null
  tail[tail.length - 1] = last.slice(0, -".jsonl".length)
  return `${parentSessionId}/subagents/${tail.join("/")}`
}

function firstUserPrompt(rows) {
  const row = rows.find(r => r?.type === "user" && r?.message?.content)
  return textFromContent(row?.message?.content)
}

function codexTaskCalls(rows) {
  const calls = []
  for (const row of rows) {
    if (row?.type !== "assistant") continue
    const content = row.message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type !== "tool_use" || part?.name !== "Bash") continue
      const prompt = extractCodexCompanionTaskText(part.input?.command)
      if (!prompt) continue
      calls.push({ prompt, timestamp: row.timestamp })
    }
  }
  return calls
}

export function buildClaudeCodexSpawnIndex({ root = CLAUDE_PROJECTS_ROOT, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const now = Date.now()
  const files = walkFiles(root, fp => fp.endsWith(".jsonl") && fp.includes(`${path.sep}subagents${path.sep}`))
  const dispatches = []
  for (const fp of files) {
    let st
    try { st = fs.statSync(fp) } catch { continue }
    if (now - st.mtimeMs > maxAgeMs) continue
    const parentSessionId = claudeSubagentIdFromPath(fp, root)
    if (!parentSessionId) continue
    const rows = parseJsonl(fp)
    const calls = codexTaskCalls(rows)
    if (!calls.length) continue
    const cwd = rows.find(r => typeof r.cwd === "string")?.cwd ?? null
    const fallbackPrompt = firstUserPrompt(rows)
    for (const call of calls) {
      const prompt = call.prompt || fallbackPrompt
      const promptNorm = normalizeText(prompt)
      if (promptNorm.length < 40) continue
      dispatches.push({
        parentSessionId,
        cwd,
        timestamp: call.timestamp ?? rows.find(r => r.timestamp)?.timestamp ?? new Date(st.mtimeMs).toISOString(),
        timestampMs: Date.parse(call.timestamp ?? "") || st.mtimeMs,
        prompt,
        promptNorm,
        tokens: tokenSet(prompt),
        sourceFile: fp,
      })
    }
  }
  dispatches.sort((a, b) => b.timestampMs - a.timestampMs)
  return dispatches
}

function getCachedDispatches() {
  const now = Date.now()
  if (_cached && now - _cached.createdAtMs < INDEX_TTL_MS) return _cached.dispatches
  const dispatches = buildClaudeCodexSpawnIndex()
  _cached = { createdAtMs: now, dispatches }
  return dispatches
}

export function clearClaudeCodexSpawnIndexCache() {
  _cached = null
}

export function inferClaudeCodexParent({ sessionMeta = {}, turnContext = {}, firstUserText = "", dispatches = null } = {}) {
  const originator = String(sessionMeta.originator ?? "").toLowerCase()
  if (originator && originator !== "claude code") return null
  const userNorm = normalizeText(firstUserText)
  if (userNorm.length < 40) return null
  const userTokens = tokenSet(firstUserText)
  const cwd = sessionMeta.cwd ?? turnContext.cwd ?? null
  const startMs = Date.parse(sessionMeta.timestamp ?? "") || Date.now()
  const candidates = dispatches ?? getCachedDispatches()
  let best = null
  for (const d of candidates) {
    const dt = startMs - d.timestampMs
    if (dt < -2 * 60 * 1000 || dt > 6 * 60 * 60 * 1000) continue
    if (cwd && d.cwd && cwd !== d.cwd) continue
    const contains = d.promptNorm.includes(userNorm) || userNorm.includes(d.promptNorm)
    const overlap = tokenOverlap(userTokens, d.tokens)
    if (!contains && overlap < 0.55) continue
    const timeScore = Math.max(0, 20 - Math.abs(dt) / (10 * 60 * 1000))
    const score = (contains ? 100 : 0) + overlap * 100 + (cwd && d.cwd === cwd ? 15 : 0) + timeScore
    if (!best || score > best.score) best = { ...d, score, overlap, contains }
  }
  if (!best || best.score < 75) return null
  return {
    parentSessionId: best.parentSessionId,
    agentType: "codex",
    linkedBy: "claude-codex-task",
    sourceFile: best.sourceFile,
  }
}
