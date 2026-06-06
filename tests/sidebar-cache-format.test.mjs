import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  cacheEntryToSessionRow,
  groupCacheSessionsToProjects,
  sessionUpsertPayload,
} from "../lib/sidebar-cache-format.mjs"

const entry = {
  id: "sess-abc",
  projectPath: "/Users/me/Code/foo",
  projectDisplayName: "Code/foo",
  source: "cursor",
  messageCount: 12,
  userMessageCount: 4,
  firstName: "Fix the bug",
  lastActivity: "2026-06-06T15:00:00.000Z",
  mtime: "1717686000000",
  customName: null,
}

describe("sidebar-cache-format", () => {
  it("cacheEntryToSessionRow applies config custom names", () => {
    const row = cacheEntryToSessionRow(entry, { "/Users/me/Code/foo/sess-abc": "My rename" })
    assert.equal(row.customName, "My rename")
    assert.equal(row.source, "cursor")
    assert.equal(row.isActive, false)
  })

  it("groupCacheSessionsToProjects groups by project path", () => {
    const e2 = { ...entry, id: "sess-def", lastActivity: "2026-06-05T15:00:00.000Z" }
    const other = {
      ...entry,
      id: "sess-zzz",
      projectPath: "/Users/me/Code/bar",
      projectDisplayName: "Code/bar",
    }
    const projects = groupCacheSessionsToProjects([entry, e2, other])
    assert.equal(projects.length, 2)
    const foo = projects.find(p => p.path === "/Users/me/Code/foo")
    assert.equal(foo?.sessions.length, 2)
    assert.equal(foo?.displayName, "Code/foo")
  })

  it("sessionUpsertPayload matches SSE wire shape", () => {
    const payload = sessionUpsertPayload(entry)
    assert.equal(payload.projectPath, entry.projectPath)
    assert.equal(payload.projectDisplayName, entry.projectDisplayName)
    assert.equal(payload.session.id, entry.id)
    assert.equal(payload.session.messageCount, 12)
    assert.ok("firstName" in payload.session)
    assert.ok(!("projectDisplayName" in payload.session))
  })
})
