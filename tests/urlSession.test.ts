import { describe, expect, it } from "vitest"
import { parseUrlSession } from "../src/urlSession"

describe("parseUrlSession", () => {
  it("preserves Claude workflow subagent ids", () => {
    const project = "/Users/dhruvanand/.claude/projects/-Users-dhruvanand-Code-resource-tracker-app"
    const session = "b64fb8bd-40d0-462e-a7a1-c8464a4071eb/subagents/workflows/wf_0eeb5f13-057/agent-ae661d9f005dae18f"
    const parsed = parseUrlSession(`?s=${encodeURIComponent(`${project}/${session}`)}`)

    expect(parsed).toEqual({ project, session })
  })

  it("preserves Claude direct subagent ids", () => {
    const project = "/Users/dhruvanand/.claude/projects/-Users-dhruvanand-Code-resource-tracker-app"
    const session = "b64fb8bd-40d0-462e-a7a1-c8464a4071eb/subagents/agent-ae661d9f005dae18f"
    const parsed = parseUrlSession(`?s=${encodeURIComponent(`${project}/${session}`)}`)

    expect(parsed).toEqual({ project, session })
  })
})
