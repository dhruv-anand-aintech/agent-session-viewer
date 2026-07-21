import assert from "node:assert/strict"
import test from "node:test"
import { extractLatestPlan } from "../lib/plan-status-core.mjs"

test("extracts the newest Codex update_plan call", () => {
  const result = extractLatestPlan([{
    timestamp: "2026-07-21T10:00:00Z",
    message: { content: [{ type: "tool_use", name: "update_plan", input: {
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Ship", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ],
    } }] },
  }])
  assert.deepEqual(result?.items.map(item => item.status), ["complete", "running", "idle"])
  assert.equal(result?.items[1].label, "Ship")
})

test("extracts Claude TodoWrite status", () => {
  const result = extractLatestPlan([{
    message: { content: [{ type: "tool_use", name: "TodoWrite", input: {
      todos: [{ content: "Fix tunnel", status: "completed" }],
    } }] },
  }])
  assert.equal(result?.tool, "todowrite")
  assert.equal(result?.items[0].status, "complete")
})
