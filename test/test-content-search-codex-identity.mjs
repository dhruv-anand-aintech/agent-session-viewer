import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { codexSearchIdentity } from "../lib/content-search.mjs"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asv-codex-identity-"))

try {
  const sessionId = "019eb0d5-17d0-7273-97b3-607eb00850e1"
  const cwd = path.join(tmp, "workspace")
  fs.mkdirSync(cwd)
  const transcript = path.join(tmp, `rollout-2026-06-10T12-00-00-${sessionId}.jsonl`)
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd, cli_version: "test" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "small stacked PR" },
      }),
      "",
    ].join("\n"),
  )

  const identity = codexSearchIdentity(
    transcript,
    path.basename(transcript, ".jsonl"),
    path.dirname(transcript),
  )

  assert.equal(identity.sessionId, sessionId)
  assert.equal(identity.projectPath, `codex:${cwd}`)
  assert.equal(identity.key, `codex:codex:${cwd}:${sessionId}`)
  console.log("  ✓  Codex content-search identity uses canonical metadata")
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
