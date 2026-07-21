import assert from "node:assert/strict"
import test from "node:test"

import { buildCodexSessionResult } from "../platform-readers.mjs"

test("Codex parser keeps encrypted reasoning markers and custom tool calls", () => {
  const sessionId = "019f653e-e5d5-7921-a018-096de67f0bb6"
  const timestamp = "2026-07-15T10:08:15.192Z"
  const result = buildCodexSessionResult(`/tmp/rollout-${sessionId}.jsonl`, [
    { type: "session_meta", payload: { id: sessionId, cwd: "/tmp/project" } },
    { type: "event_msg", timestamp, payload: { type: "user_message", message: "Inspect this" } },
    { type: "response_item", timestamp, payload: { type: "reasoning", summary: [], encrypted_content: "ciphertext" } },
    { type: "response_item", timestamp, payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "text(ALL_TOOLS);" } },
    { type: "response_item", timestamp, payload: { type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "done" }] } },
  ], Date.parse(timestamp))

  assert.ok(result)
  assert.deepEqual(result.msgs[1].message.content, [
    { type: "thinking", thinking: "Reasoning is encrypted by OpenAI and only decryptable server-side; plaintext is not available to this client." },
    { type: "tool_use", id: "call-1", name: "exec", input: { _raw: "text(ALL_TOOLS);" } },
  ])
  assert.deepEqual(result.msgs[2].message.content, [{
    type: "tool_result",
    tool_use_id: "call-1",
    content: JSON.stringify([{ type: "input_text", text: "done" }], null, 2),
  }])
})

test("Codex parser displays structured plaintext reasoning when a provider exposes it", () => {
  const timestamp = "2026-07-15T10:08:15.192Z"
  const result = buildCodexSessionResult("/tmp/rollout-plaintext.jsonl", [
    { type: "session_meta", payload: { id: "plaintext", cwd: "/tmp/project" } },
    { type: "event_msg", timestamp, payload: { type: "user_message", message: "Inspect this" } },
    { type: "response_item", timestamp, payload: {
      type: "reasoning",
      summary: [],
      content: [
        { type: "reasoning_text", text: "First inspect the inputs." },
        { type: "reasoning_text", reasoning_text: "Then compare the outputs." },
      ],
      encrypted_content: null,
    } },
  ], Date.parse(timestamp))

  assert.deepEqual(result.msgs[1].message.content, [{
    type: "thinking",
    thinking: "First inspect the inputs.\nThen compare the outputs.",
  }])
})

test("Codex parser deduplicates final answers with response-only memory citations", () => {
  const timestamp = "2026-07-16T06:22:03.420Z"
  const answer = "D, completed the cumulative Multi Chart fix."
  const responseAnswer = `${answer}\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:174-175|note=[production baseline]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>`
  const result = buildCodexSessionResult("/tmp/rollout-citation-dedupe.jsonl", [
    { type: "session_meta", payload: { id: "citation-dedupe", cwd: "/tmp/project" } },
    { type: "event_msg", timestamp, payload: { type: "user_message", message: "Fix duplicate messages" } },
    { type: "event_msg", timestamp, payload: { type: "agent_message", message: answer } },
    { type: "response_item", timestamp, payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: responseAnswer }],
    } },
  ], Date.parse(timestamp))

  assert.ok(result)
  assert.equal(result.msgs.length, 2)
  assert.equal(result.msgs[1].message.content, answer)
})
