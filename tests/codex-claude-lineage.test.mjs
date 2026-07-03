import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildClaudeCodexSpawnIndex,
  extractCodexCompanionTaskText,
  inferClaudeCodexParent,
} from "../lib/codex-claude-lineage.mjs"

function writeJsonl(fp, rows) {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
}

describe("Claude-spawned Codex lineage", () => {
  it("extracts the prompt from a codex-companion task command", () => {
    const prompt = "<task>Run the exact requested Codex task in /tmp/work.</task>"
    const command = `node "/plugins/codex-companion.mjs" task --model gpt-5.4-mini --write --background "${prompt}"`
    assert.equal(extractCodexCompanionTaskText(command), prompt)
  })

  it("links a Claude Code-originated Codex rollout to the matching Claude subagent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asv-lineage-"))
    const claudeFile = path.join(
      root,
      "-Users-d-Code-lipi",
      "parent-session-1",
      "subagents",
      "agent-a123.jsonl",
    )
    const taskText = "Expanded leakage-safe benchmark in /Users/d/Code/lipi: grow the leakage-safe eval to at least 100 rows per language and baseline dictionary plus CPU models."
    writeJsonl(claudeFile, [
      {
        type: "user",
        timestamp: "2026-07-02T20:28:10.000Z",
        cwd: "/Users/d/Code/lipi",
        sessionId: "parent-session-1",
        agentId: "a123",
        message: { role: "user", content: `Forward this exact task to Codex via one task call: ${taskText}` },
      },
      {
        type: "assistant",
        timestamp: "2026-07-02T20:28:15.000Z",
        cwd: "/Users/d/Code/lipi",
        sessionId: "parent-session-1",
        agentId: "a123",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            name: "Bash",
            input: {
              command: `node "/plugins/codex-companion.mjs" task --model gpt-5.4-mini --write --background "${taskText}"`,
            },
          }],
        },
      },
    ])

    const dispatches = buildClaudeCodexSpawnIndex({ root, maxAgeMs: 365 * 24 * 60 * 60 * 1000 })
    assert.equal(dispatches.length, 1)

    const parent = inferClaudeCodexParent({
      sessionMeta: {
        originator: "Claude Code",
        cwd: "/Users/d/Code/lipi",
        timestamp: "2026-07-02T20:28:24.000Z",
      },
      firstUserText: taskText,
      dispatches,
    })

    assert.equal(parent?.parentSessionId, "parent-session-1/subagents/agent-a123")
    assert.equal(parent?.agentType, "codex")
  })

  it("does not link non-Claude-originated Codex sessions", () => {
    const parent = inferClaudeCodexParent({
      sessionMeta: { originator: "User", cwd: "/Users/d/Code/lipi", timestamp: "2026-07-02T20:28:24.000Z" },
      firstUserText: "Expanded leakage-safe benchmark in /Users/d/Code/lipi: grow the leakage-safe eval to at least 100 rows per language.",
      dispatches: [{
        parentSessionId: "parent/subagents/agent-a123",
        cwd: "/Users/d/Code/lipi",
        timestampMs: Date.parse("2026-07-02T20:28:15.000Z"),
        promptNorm: "expanded leakage-safe benchmark in /users/d/code/lipi grow the leakage-safe eval to at least 100 rows per language",
        tokens: new Set(["expanded", "leakage-safe", "benchmark", "/users/d/code/lipi", "language"]),
      }],
    })
    assert.equal(parent, null)
  })
})
