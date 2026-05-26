/**
 * ripgrep-based global full-text search across all file-based transcript directories.
 *
 * Platforms covered by rg (file-based):
 *   - Claude Code: ~/.claude/projects/**\/*.jsonl
 *   - Codex:       ~/.codex/sessions/**\/*.jsonl
 *   - Antigravity: ~/.gemini/antigravity/brain/**\/*.md
 *
 * Platforms NOT covered (SQLite-based — searched in-memory by the caller):
 *   - Cursor, OpenCode, Hermes
 *
 * Returns hits grouped by (platform, projectPath, sessionId) with text snippets.
 */

import { existsSync } from "fs"
import { spawn } from "child_process"
import { homedir } from "os"
import { join, basename, dirname, sep } from "path"

const HOME = homedir()

// ── Platform directory definitions ───────────────────────────────────────────

export const RG_SEARCH_DIRS = [
  {
    id: "claude",
    dir: join(HOME, ".claude", "projects"),
    glob: "*.jsonl",
    /** Map absolute file path → { projectPath, sessionId } */
    pathToSession(filePath) {
      // filePath: ~/.claude/projects/<projectDir>/<sessionId>.jsonl
      const rel = filePath.slice(join(HOME, ".claude", "projects").length + 1)
      const parts = rel.split(sep)
      if (parts.length < 2) return null
      const sessionId = basename(parts[parts.length - 1], ".jsonl")
      const projectDir = parts.slice(0, -1).join(sep)
      return {
        source: "claude",
        projectPath: join(HOME, ".claude", "projects", projectDir),
        sessionId,
      }
    },
  },
  {
    id: "codex",
    dir: join(HOME, ".codex", "sessions"),
    glob: "*.jsonl",
    pathToSession(filePath) {
      // filePath: ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<id>.jsonl
      const sessionId = basename(filePath, ".jsonl")
      return {
        source: "codex",
        projectPath: dirname(filePath),
        sessionId,
      }
    },
  },
  {
    id: "antigravity",
    dir: join(HOME, ".gemini", "antigravity", "brain"),
    glob: "*.md",
    pathToSession(filePath) {
      // filePath: ~/.gemini/antigravity/brain/<uuid>/<file>.md
      const rel = filePath.slice(join(HOME, ".gemini", "antigravity", "brain").length + 1)
      const parts = rel.split(sep)
      if (parts.length < 2) return null
      const sessionId = parts[0] // uuid directory name is the session id
      return {
        source: "antigravity",
        projectPath: join(HOME, ".gemini", "antigravity", "brain", sessionId),
        sessionId,
      }
    },
  },
]

// ── Core rg runner ────────────────────────────────────────────────────────────

const RG_BIN = "rg"
const MAX_RESULTS = 200
const SNIPPET_MAX = 300

/**
 * Run rg across all available transcript directories.
 *
 * @param {string} query   — search string (literal, case-insensitive)
 * @param {{ limit?: number, platforms?: string[] }} opts
 * @returns {Promise<RgSearchResult[]>}
 */
export async function rgGlobalSearch(query, opts = {}) {
  const { limit = MAX_RESULTS, platforms } = opts
  if (!query || !query.trim()) return []

  const dirs = RG_SEARCH_DIRS.filter(d => {
    if (!existsSync(d.dir)) return false
    if (platforms && !platforms.includes(d.id)) return false
    return true
  })

  if (!dirs.length) return []

  // Build a single rg invocation across all dirs for efficiency
  const args = [
    "--json",
    "--ignore-case",
    "--fixed-strings",
    "--max-count", "5",          // max 5 matches per file (enough for snippets)
    "--max-columns", "500",      // truncate very long lines in output
    "--no-heading",
    query,
    ...dirs.map(d => d.dir),
  ]

  const raw = await runRg(args)
  return parseRgOutput(raw, dirs, limit)
}

function runRg(args) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const proc = spawn(RG_BIN, args, { maxBuffer: 32 * 1024 * 1024 })
    proc.stdout.on("data", chunk => chunks.push(chunk))
    proc.stderr.on("data", () => {}) // suppress stderr
    proc.on("error", reject)
    proc.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

/**
 * @typedef {{ source: string, projectPath: string, sessionId: string, snippets: string[], fileCount?: number }} RgSearchResult
 */

function parseRgOutput(raw, dirs, limit) {
  /** @type {Map<string, RgSearchResult>} */
  const bySession = new Map()
  let totalFiles = 0

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.type !== "match") continue

    const filePath = record.data?.path?.text
    if (!filePath) continue

    // Find which platform dir this file belongs to
    let resolved = null
    for (const d of dirs) {
      if (filePath.startsWith(d.dir + sep) || filePath.startsWith(d.dir + "/")) {
        resolved = d.pathToSession(filePath)
        if (resolved) { resolved.platformDir = d; break }
      }
    }
    if (!resolved) continue

    const key = `${resolved.source}:${resolved.projectPath}:${resolved.sessionId}`
    if (!bySession.has(key)) {
      if (bySession.size >= limit) continue
      bySession.set(key, {
        source: resolved.source,
        projectPath: resolved.projectPath,
        sessionId: resolved.sessionId,
        snippets: [],
      })
      totalFiles++
    }

    const entry = bySession.get(key)
    if (entry.snippets.length < 3) {
      // Extract just the matched text content from JSONL lines
      const lineText = record.data?.lines?.text ?? ""
      const snippet = extractSnippet(lineText, record.data?.submatches ?? [])
      if (snippet) entry.snippets.push(snippet)
    }
  }

  return Array.from(bySession.values())
}

/**
 * Extract a human-readable snippet from a raw JSONL/Markdown line.
 * For JSONL: tries to extract the "text" content field; falls back to the raw line.
 */
function extractSnippet(line, submatches) {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Try to extract inner text from JSONL message content
  let text = trimmed
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text)
      // Look for message text content
      const extracted = extractTextFromJSONL(obj)
      if (extracted) text = extracted
    } catch {
      // Not valid JSON — use raw line
    }
  }

  // Apply length limit and mark match position
  text = text.replace(/\s+/g, " ").trim()
  if (!text) return null

  // If we have submatch positions, center the snippet around the first match
  if (submatches.length > 0) {
    const { start, end } = submatches[0]
    const matchEnd = Math.min(end ?? start + 20, text.length)
    const matchStart = Math.max(0, (start ?? 0))
    const winStart = Math.max(0, matchStart - 80)
    const winEnd = Math.min(text.length, matchEnd + 120)
    const prefix = winStart > 0 ? "…" : ""
    const suffix = winEnd < text.length ? "…" : ""
    return prefix + text.slice(winStart, winEnd) + suffix
  }

  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text
}

function extractTextFromJSONL(obj) {
  // Claude JSONL: message.content = string | array of blocks
  const content = obj?.message?.content
  if (typeof content === "string" && content.trim()) return content.trim().slice(0, SNIPPET_MAX)
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && block.text?.trim()) return block.text.trim().slice(0, SNIPPET_MAX)
    }
  }
  // Codex event messages
  if (obj?.event_msg?.content) {
    const c = obj.event_msg.content
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, SNIPPET_MAX)
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block?.type === "text" && block.text?.trim()) return block.text.trim().slice(0, SNIPPET_MAX)
      }
    }
  }
  // Generic: look for any "text" string field
  if (typeof obj?.text === "string" && obj.text.trim()) return obj.text.trim().slice(0, SNIPPET_MAX)
  return null
}
