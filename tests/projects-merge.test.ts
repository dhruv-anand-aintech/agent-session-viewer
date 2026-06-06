import { describe, it, expect } from "vitest"
import type { ProjectData, SessionMeta } from "../src/types"
import {
  mergeProjectData,
  mergeSessionUpsert,
  trimProjectsToMaxSessions,
  expandProjectsLinkage,
  RECENT_SIDEBAR_SESSIONS,
} from "../src/projects-merge"

function sess(id: string, lastActivity: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    projectPath: "/p",
    messageCount: 1,
    lastActivity,
    isActive: false,
    ...extra,
  }
}

function project(path: string, sessions: SessionMeta[], displayName = path): ProjectData {
  return { path, displayName, sessions }
}

describe("projects-merge", () => {
  it("mergeProjectData merges sessions within the same project", () => {
    const existing = [project("/a", [sess("s1", "2026-06-01T00:00:00.000Z", { firstName: "keep" })])]
    const incoming = [project("/a", [sess("s1", "2026-06-02T00:00:00.000Z", { messageCount: 9 })])]
    const out = mergeProjectData(existing, incoming)
    expect(out).toHaveLength(1)
    expect(out[0].sessions[0].messageCount).toBe(9)
    expect(out[0].sessions[0].firstName).toBe("keep")
  })

  it("mergeSessionUpsert adds a new project group", () => {
    const out = mergeSessionUpsert([], "/new", "New proj", sess("n1", "2026-06-06T00:00:00.000Z"))
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe("/new")
    expect(out[0].sessions[0].id).toBe("n1")
  })

  it("mergeSessionUpsert sorts sessions by lastActivity desc", () => {
    const base = [project("/a", [
      sess("old", "2026-06-01T00:00:00.000Z"),
      sess("new", "2026-06-06T00:00:00.000Z"),
    ])]
    const out = mergeSessionUpsert(base, "/a", "A", sess("mid", "2026-06-03T00:00:00.000Z"))
    expect(out[0].sessions.map(s => s.id)).toEqual(["new", "mid", "old"])
  })

  it("trimProjectsToMaxSessions keeps globally newest sessions", () => {
    const projects = [
      project("/a", [
        sess("a1", "2026-06-06T00:00:00.000Z"),
        sess("a2", "2026-06-05T00:00:00.000Z"),
      ]),
      project("/b", [
        sess("b1", "2026-06-04T00:00:00.000Z"),
        sess("b2", "2026-06-03T00:00:00.000Z"),
      ]),
    ]
    const trimmed = trimProjectsToMaxSessions(projects, 2)
    const ids = trimmed.flatMap(p => p.sessions.map(s => s.id)).sort()
    expect(ids).toEqual(["a1", "a2"])
  })

  it("trimProjectsToMaxSessions evicts oldest when delta pushes over limit", () => {
    let state = trimProjectsToMaxSessions(
      [project("/a", Array.from({ length: RECENT_SIDEBAR_SESSIONS }, (_, i) =>
        sess(`fill-${i}`, `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
      ))],
      RECENT_SIDEBAR_SESSIONS,
    )
    expect(state.flatMap(p => p.sessions)).toHaveLength(RECENT_SIDEBAR_SESSIONS)

    state = trimProjectsToMaxSessions(
      mergeSessionUpsert(state, "/b", "B", sess("hot", "2026-12-31T00:00:00.000Z")),
      RECENT_SIDEBAR_SESSIONS,
    )
    const ids = state.flatMap(p => p.sessions.map(s => s.id))
    expect(ids).toHaveLength(RECENT_SIDEBAR_SESSIONS)
    expect(ids).toContain("hot")
    expect(ids).not.toContain("fill-0")
  })

  it("RECENT_SIDEBAR_SESSIONS is 30", () => {
    expect(RECENT_SIDEBAR_SESSIONS).toBe(30)
  })

  it("trimProjectsToMaxSessions keeps subagents when parent remains in top N", () => {
    const projects = [
      project("/a", [
        sess("parent", "2026-06-06T00:00:00.000Z"),
        sess("sub", "2026-06-01T00:00:00.000Z", {
          isSidechain: true,
          parentSessionId: "parent",
          agentType: "subagent",
        }),
      ]),
      project("/b", [sess("other", "2026-06-05T00:00:00.000Z")]),
    ]
    const trimmed = trimProjectsToMaxSessions(projects, 2)
    const ids = trimmed.flatMap(p => p.sessions.map(s => s.id)).sort()
    expect(ids).toEqual(["other", "parent", "sub"])
  })

  it("mergeProjectData preserves sidechain metadata on partial upsert", () => {
    const existing = [project("/a", [sess("sub", "2026-06-06T00:00:00.000Z", {
      isSidechain: true,
      parentSessionId: "parent",
      agentType: "subagent",
    })])]
    const incoming = [project("/a", [sess("sub", "2026-06-07T00:00:00.000Z", { messageCount: 5 })])]
    const out = mergeProjectData(existing, incoming)
    expect(out[0].sessions[0].isSidechain).toBe(true)
    expect(out[0].sessions[0].parentSessionId).toBe("parent")
  })

  it("trimProjectsToMaxSessions includes parent when only subagent would make top N", () => {
    const projects = [
      project("/a", [
        sess("parent", "2026-06-01T00:00:00.000Z"),
        sess("sub", "2026-06-06T00:00:00.000Z", {
          isSidechain: true,
          parentSessionId: "parent",
          agentType: "subagent",
        }),
      ]),
      project("/b", [sess("other", "2026-06-05T00:00:00.000Z")]),
    ]
    const trimmed = trimProjectsToMaxSessions(projects, 2)
    const ids = trimmed.flatMap(p => p.sessions.map(s => s.id)).sort()
    expect(ids).toEqual(["other", "parent", "sub"])
  })

  it("expandProjectsLinkage adds parent for orphan subagent in set", () => {
    const projects = [
      project("/a", [sess("sub", "2026-06-01T00:00:00.000Z", {
        isSidechain: true,
        parentSessionId: "parent",
      })]),
    ]
    const pool = [
      project("/a", [
        sess("parent", "2026-06-06T00:00:00.000Z"),
        sess("sub", "2026-06-01T00:00:00.000Z", { isSidechain: true, parentSessionId: "parent" }),
      ]),
    ]
    const out = expandProjectsLinkage(projects, pool)
    expect(out[0].sessions.map(s => s.id).sort()).toEqual(["parent", "sub"])
  })
})
