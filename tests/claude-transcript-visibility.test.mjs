import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasClaudeTranscriptMessage } from "../shared-utils.mjs"

describe("Claude transcript visibility", () => {
  it("requires at least one non-snapshot JSONL record", () => {
    const dir = mkdtempSync(join(tmpdir(), "asv-claude-visible-"))
    const fp = join(dir, "session.jsonl")
    try {
      writeFileSync(fp, "")
      assert.equal(hasClaudeTranscriptMessage(fp), false)

      writeFileSync(fp, `${JSON.stringify({ type: "file-history-snapshot" })}\n`)
      assert.equal(hasClaudeTranscriptMessage(fp), false)

      writeFileSync(fp, [
        JSON.stringify({ type: "file-history-snapshot" }),
        JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      ].join("\n"))
      assert.equal(hasClaudeTranscriptMessage(fp), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
