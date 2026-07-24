import assert from "node:assert/strict"
import test from "node:test"
import { buildAgentPrompt, summarizeRecentChats } from "../lib/agent-chat-core.mjs"

const chat = {
  title: "Ship transcript agent",
  source: "codex",
  projectPath: "codex:/workspace/asv",
  sessionId: "session-1",
  lastActivity: "2026-07-21T10:00:00.000Z",
  messages: [
    { type: "user", message: { role: "user", content: "Add a live summary." } },
    { type: "assistant", message: { role: "assistant", content: "Implemented and verified the summary endpoint." } },
  ],
}

test("formats recent chats with provenance", () => {
  const context = summarizeRecentChats([chat])
  assert.match(context, /Chat: Ship transcript agent/)
  assert.match(context, /Source: codex/)
  assert.match(context, /Implemented and verified/)
})

test("builds a read-only all-transcript research prompt", () => {
  const prompt = buildAgentPrompt({
    prompt: "What remains?",
    sessionContext: {
      transcriptScope: "all",
      transcriptLocations: ["~/.codex/sessions", "~/.claude/projects"],
      recentChats: [chat],
    },
  })
  assert.match(prompt, /read and search transcript files and databases with shell and database tools/)
  assert.match(prompt, /never modify, move, or delete transcript sources/)
  assert.match(prompt, /running processes, ports, and current commands/)
  assert.match(prompt, /RECENT CHATS ACROSS AGENTS/)
  assert.match(prompt, /READ-ONLY TRANSCRIPT LOCATIONS/)
  assert.match(prompt, /~\/.codex\/sessions/)
  assert.match(prompt, /USER MESSAGE\nWhat remains\?/)
})
