import { describe, expect, it } from "vitest"
import { resolveSessionProject } from "../src/sessionPaneState"

describe("resolveSessionProject", () => {
  it("prefers a provider-native Codex project over a stale Claude deep-link duplicate", () => {
    const id = "019f8412-cc2f-7972-a221-93e3c9da9e16"
    const stale = "/Users/dhruvanand/.claude/projects/-Users-dhruvanand-Code-universal-computer-use-mobile"
    const canonical = "codex:/Users/dhruvanand/Code/universal-computer-use-mobile"
    const projects = [
      { path: stale, sessions: [{ id, source: "codex" }] },
      { path: canonical, sessions: [{ id, source: "codex" }] },
    ]

    expect(resolveSessionProject(projects, stale, id)?.path).toBe(canonical)
  })

  it("preserves an ordinary exact project selection", () => {
    const projects = [{ path: "/claude/project", sessions: [{ id: "session", source: "claude" }] }]
    expect(resolveSessionProject(projects, "/claude/project", "session")?.path).toBe("/claude/project")
  })
})
