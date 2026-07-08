import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "agent-chat-core-"))
const mockAgl = join(root, "agl")
writeFileSync(mockAgl, `#!/usr/bin/env node
const fs = require("fs")
const args = process.argv.slice(2)
const promptFile = args[args.indexOf("--prompt-file") + 1]
const agent = args[args.indexOf("-a") + 1]
const cwd = args[args.indexOf("-C") + 1]
const prompt = fs.readFileSync(promptFile, "utf8")
console.log(JSON.stringify({ agent, cwd, hasSession: prompt.includes("Session ID: session-123"), hasUser: prompt.includes("USER MESSAGE\\nWhat changed?") }))
`, "utf8")
chmodSync(mockAgl, 0o755)
process.env.AGENT_SESSION_AGL_PATH = mockAgl

const {
  buildAgentPrompt,
  getAgentProviders,
  runLocalAglChat,
} = await import("../lib/agent-chat-core.mjs")

try {
  const prompt = buildAgentPrompt({
    userPrompt: "What changed?",
    sessionContext: {
      projectPath: "/tmp/project",
      sessionId: "session-123",
      source: "codex",
      cwd: "/tmp/project",
      messages: [
        { type: "human", message: { role: "user", content: "make a tool" } },
        { type: "assistant", message: { role: "assistant", content: "implemented it" } },
      ],
    },
    conversation: [{ role: "user", content: "hello" }],
  })
  assert.match(prompt, /Session ID: session-123/)
  assert.match(prompt, /RECENT TRANSCRIPT/)
  assert.match(prompt, /USER MESSAGE\nWhat changed\?/)

  const providerInfo = getAgentProviders()
  assert.equal(providerInfo.providers[0].id, "local")
  assert.equal(providerInfo.providers[0].status, "available")

  const result = await runLocalAglChat({
    provider: "local",
    agent: "codex",
    mode: "ask",
    modelClass: "pro",
    cwd: root,
    prompt: "What changed?",
    sessionContext: {
      projectPath: "/tmp/project",
      sessionId: "session-123",
      source: "codex",
      cwd: root,
      messages: [{ type: "human", message: { role: "user", content: "context" } }],
    },
  })
  assert.equal(result.ok, true)
  const payload = JSON.parse(result.text)
  assert.deepEqual(payload, { agent: "codex", cwd: root, hasSession: true, hasUser: true })

  console.log("agent chat core tests passed")
} finally {
  rmSync(root, { recursive: true, force: true })
}
