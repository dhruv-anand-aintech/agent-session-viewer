import assert from "node:assert/strict"
import test from "node:test"
import {
  buildLiveSessionPreview,
  compressLiveSummaryContext,
  isActivelyUpdating,
  openAILiveSummaryBody,
  openAIStreamDelta,
} from "../lib/live-summary-core.mjs"

test("active session selection uses the five-minute transcript window", () => {
  const now = Date.parse("2026-07-21T10:00:00Z")
  assert.equal(isActivelyUpdating({ lastActivity: "2026-07-21T09:57:00Z" }, now), true)
  assert.equal(isActivelyUpdating({ lastActivity: "2026-07-21T09:50:00Z" }, now), false)
})

test("preview exposes latest user text and the end of the assistant response", () => {
  const preview = buildLiveSessionPreview({ id: "abc", projectPath: "/tmp/work", source: "codex", firstName: "Fast work" }, [
    { message: { role: "user", content: "older request" } },
    { message: { role: "assistant", content: "older answer" } },
    { message: { role: "user", content: "latest   request" } },
    { message: { role: "assistant", content: `prefix ${"x".repeat(500)} verified end` } },
  ], { maxPreviewChars: 40 })
  assert.equal(preview.latestUser, "latest request")
  assert.match(preview.assistantTail, /^prefix/)
  assert.match(preview.assistantTail, /verified end$/)
})

test("preview preserves numbered assistant status checklists as deterministic evidence", () => {
  const status = `D, added as item 5:\n\n1. Detailed B2C/B2B strategy.\n2. Trial and monthly/annual/lifetime purchase hooks.\n3. Flagsmith-controlled monetization configuration.\n4. Remotely switchable Flagsmith host through an independent bootstrap.\n5. A versioned, production-ready in-app fallback snapshot on every build.\n\nI’m tightening item 5 now.`
  const preview = buildLiveSessionPreview({ id: "flags", projectPath: "/tmp/app" }, [
    { message: { role: "assistant", content: status } },
  ])
  assert.match(preview.assistantTail, /1\. Detailed B2C\/B2B strategy/)
  assert.match(preview.assistantTail, /5\. A versioned, production-ready/)
  assert.match(preview.assistantTail, /tightening item 5 now/)
})

test("compressed context contains every retained stripped turn", () => {
  const context = compressLiveSummaryContext([{ title: "A", source: "codex", projectPath: "/x", sessionId: "1", messages: [
    { role: "user", text: "build it" }, { role: "assistant", text: "done" },
  ] }])
  assert.match(context, /USER: build it/)
  assert.match(context, /ASSISTANT: done/)
})

test("OpenAI request is streamed through Luna with low effort", () => {
  const body = openAILiveSummaryBody("context")
  assert.equal(body.model, "gpt-5.6-luna")
  assert.equal(body.stream, true)
  assert.equal(body.reasoning.effort, "low")
  assert.equal(body.text.verbosity, "low")
  assert.equal(openAIStreamDelta("response.output_text.delta", { delta: "- done" }), "- done")
})
