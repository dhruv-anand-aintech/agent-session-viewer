/**
 * Regression test for Codex session file lookup caching.
 *
 * Run with: node test/test-codex-session-file-cache.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-viewer-codex-cache-"))
const codexRoot = path.join(tempHome, ".codex", "sessions", "2026", "05", "08")
fs.mkdirSync(codexRoot, { recursive: true })

const sessionId = "019e0733-e9f3-7b00-b8ba-d38c6f466ec5"
const filePath = path.join(codexRoot, `rollout-2026-05-08T16-38-44-${sessionId}.jsonl`)
fs.writeFileSync(filePath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }) + "\n")

process.env.HOME = tempHome

let readdirCount = 0
const origReaddirSync = fs.readdirSync
fs.readdirSync = function patchedReaddirSync(...args) {
  readdirCount++
  return origReaddirSync.apply(this, args)
}

try {
  const mod = await import(pathToFileURL(path.join(process.cwd(), "platform-readers.mjs")).href + `?v=${Date.now()}`)
  mod.clearCodexSessionFileCache?.()

  const first = mod.findCodexSessionFile(sessionId)
  const afterFirst = readdirCount
  const second = mod.findCodexSessionFile(sessionId)
  const afterSecond = readdirCount

  const ok =
    first === filePath &&
    second === filePath &&
    afterFirst > 0 &&
    afterSecond === afterFirst

  if (ok) {
    console.log("  ✓  cached Codex file lookup reuses the first resolved path")
  } else {
    console.error("  ✗  cached Codex file lookup did not behave as expected")
    console.error(JSON.stringify({ first, second, afterFirst, afterSecond, filePath }, null, 2))
    process.exitCode = 1
  }
} finally {
  fs.readdirSync = origReaddirSync
}
