import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  AGENT_BRANDS,
  agentBrandForSource,
  agentBrandLabel,
  canonicalAgentSource,
} from "../lib/agent-brand-catalog.mjs"
import {
  readConfiguredAgentSessions,
  readPiSessions,
} from "../lib/extended-agent-readers.mjs"

test("catalog covers the complete AGL/matrix brand union and preserves launch aliases", () => {
  assert.equal(AGENT_BRANDS.length, 35)
  for (const brand of AGENT_BRANDS) {
    assert.equal(agentBrandForSource(brand.source)?.label, brand.label)
    assert.equal(agentBrandLabel(brand.source), brand.label)
    for (const alias of brand.aliases) assert.equal(canonicalAgentSource(alias), brand.source)
  }
  assert.equal(agentBrandLabel("mimo"), "MiMo Code")
  assert.equal(agentBrandLabel("factory-droid"), "Factory Droid")
  assert.equal(agentBrandLabel("codex"), "OpenAI Codex CLI")
})

test("normalized JSONL adapter discovers and normalizes a sanitized transcript for every brand", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asv-agent-fixtures-"))
  const previous = process.env.ASV_AGENT_TRANSCRIPT_ROOTS
  try {
    const pairs = []
    for (const brand of AGENT_BRANDS) {
      const dir = path.join(root, brand.source)
      fs.mkdirSync(dir)
      const fixture = path.join(dir, "fixture.jsonl")
      fs.writeFileSync(fixture, [
        JSON.stringify({ type: "session", id: `fixture-${brand.source}`, cwd: "/tmp/sanitized-workspace", title: `Sanitized ${brand.label}`, startedAt: "2026-08-06T08:00:00.000Z", updatedAt: "2026-08-06T08:02:00.000Z" }),
        JSON.stringify({ type: "message", role: "user", timestamp: "2026-08-06T08:00:01.000Z", content: `SAFE_USER_${brand.source}` }),
        JSON.stringify({ type: "message", role: "assistant", timestamp: "2026-08-06T08:00:02.000Z", content: [{ type: "text", text: `SAFE_ASSISTANT_${brand.source}` }] }),
      ].join("\n") + "\n")
      pairs.push(`${brand.source}=${dir}`)
    }
    process.env.ASV_AGENT_TRANSCRIPT_ROOTS = pairs.join(",")
    const sessions = readConfiguredAgentSessions()
    assert.equal(sessions.length, AGENT_BRANDS.length)
    const bySource = new Map(sessions.map(session => [session.meta.source, session]))
    for (const brand of AGENT_BRANDS) {
      const session = bySource.get(brand.source)
      assert.ok(session, `${brand.source} was not discovered`)
      assert.deepEqual({
        source: session.meta.source,
        title: session.meta.firstName,
        messageCount: session.meta.messageCount,
        userMessageCount: session.meta.userMessageCount,
        lastActivity: session.meta.lastActivity,
        projectPath: session.meta.projectPath,
      }, {
        source: brand.source,
        title: `Sanitized ${brand.label}`,
        messageCount: 2,
        userMessageCount: 1,
        lastActivity: "2026-08-06T08:02:00.000Z",
        projectPath: `${brand.source}:/tmp/sanitized-workspace`,
      })
      assert.equal(session.msgs[0].message.content, `SAFE_USER_${brand.source}`)
      assert.equal(session.msgs[1].message.content[0].text, `SAFE_ASSISTANT_${brand.source}`)
    }
  } finally {
    if (previous == null) delete process.env.ASV_AGENT_TRANSCRIPT_ROOTS
    else process.env.ASV_AGENT_TRANSCRIPT_ROOTS = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Pi reader preserves title, counts, timestamps, tool cards, and sidechain metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asv-pi-fixture-"))
  try {
    const dir = path.join(root, "workspace")
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, "session.jsonl"), [
      JSON.stringify({ type: "session", id: "pi-sanitized", cwd: "/tmp/pi-workspace", timestamp: "2026-08-06T09:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "u", role: "user", timestamp: "2026-08-06T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "SAFE_PI_USER" }] } }),
      JSON.stringify({ type: "message", id: "a", role: "assistant", timestamp: "2026-08-06T09:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "/tmp/sanitized.txt" } }, { type: "text", text: "SAFE_PI_ASSISTANT" }] } }),
    ].join("\n") + "\n")
    const [session] = readPiSessions(root)
    assert.equal(session.meta.source, "pi")
    assert.equal(session.meta.messageCount, 2)
    assert.equal(session.meta.userMessageCount, 1)
    assert.equal(session.meta.firstName, "SAFE_PI_USER")
    assert.equal(session.meta.lastActivity, "2026-08-06T09:00:02.000Z")
    assert.equal(session.msgs[1].message.content[0].type, "tool_use")
    assert.equal(session.msgs[1].message.content[1].text, "SAFE_PI_ASSISTANT")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
