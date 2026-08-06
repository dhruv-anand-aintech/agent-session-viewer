import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const OPENCODE_CORRELATION_FILE = process.env.ASV_OPENCODE_CORRELATION_FILE || join(
  homedir(),
  ".config",
  "agent-session-viewer",
  "opencode-correlations.json",
)

const PARENT_ID_KEYS = [
  "parentSessionId",
  "parent_session_id",
  "codexSessionId",
  "codex_session_id",
]

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value
}

function parseJsonObject(value) {
  if (typeof value !== "string" || !value.trim()) return null
  try { return asObject(JSON.parse(value)) } catch { return null }
}

function parentFromObject(value, evidence) {
  const object = asObject(value)
  if (!object) return null
  for (const key of PARENT_ID_KEYS) {
    const parentSessionId = object[key]
    if (typeof parentSessionId === "string" && parentSessionId.trim()) {
      return {
        parentSessionId: parentSessionId.trim(),
        parentSource: object.parentSource ?? object.parent_source ?? (key.startsWith("codex") ? "codex" : "opencode"),
        correlationEvidence: object.evidence ?? evidence,
      }
    }
  }
  for (const key of ["correlation", "provenance", "metadata"]) {
    const nested = parentFromObject(object[key], evidence)
    if (nested) return nested
  }
  return null
}

/** Read a persisted explicit mapping written by a session creator/gateway. */
export function loadOpenCodeCorrelations(filePath = OPENCODE_CORRELATION_FILE) {
  if (!filePath || !existsSync(filePath)) return new Map()
  let raw
  try { raw = JSON.parse(readFileSync(filePath, "utf8")) } catch { return new Map() }
  const root = asObject(raw)
  const records = asObject(root?.sessions) ?? root
  const out = new Map()
  for (const [sessionId, value] of Object.entries(records ?? {})) {
    if (!sessionId || sessionId === "sessions") continue
    const record = typeof value === "string" ? { parentSessionId: value } : value
    const correlation = parentFromObject(record, `explicit mapping in ${filePath}`)
    if (correlation) out.set(sessionId, correlation)
  }
  return out
}

/**
 * Resolve only explicit provenance. Natural-language prompts and timestamps are
 * deliberately ignored; an unlinked OpenCode session stays flat.
 */
export function resolveOpenCodeCorrelation({ sessionId, parentId, metadata, firstUserText, correlations }) {
  if (typeof parentId === "string" && parentId.trim()) {
    return {
      parentSessionId: parentId.trim(),
      parentSource: "opencode",
      correlationEvidence: "OpenCode session.parent_id",
    }
  }

  const fromMetadata = parentFromObject(parseJsonObject(metadata) ?? metadata, "OpenCode session metadata")
  if (fromMetadata) return fromMetadata

  // A gateway may inject this exact machine-readable marker into the first
  // prompt when the OpenCode API has no metadata field. It is not inferred from
  // ordinary prompt text.
  const marker = typeof firstUserText === "string"
    ? firstUserText.match(/(?:^|\n)ASV_PARENT_SESSION_ID=([^\s\n]+)(?:\n|$)/)
    : null
  if (marker?.[1]) {
    return {
      parentSessionId: marker[1].trim(),
      parentSource: "codex",
      correlationEvidence: "ASV_PARENT_SESSION_ID prompt marker",
    }
  }

  const fromFile = correlations?.get(sessionId)
  return fromFile ?? null
}
