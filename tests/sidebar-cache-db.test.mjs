import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  openSidebarCacheDb,
  closeSidebarCacheDb,
  getSidebarSessionCount,
  getTopSidebarEntries,
  getAllSidebarEntries,
  getSidebarEntry,
  deleteSidebarEntry,
  upsertSidebarEntry,
  upsertSidebarEntries,
  replaceAllSidebarEntries,
  SIDEBAR_CACHE_JSON_LEGACY,
} from "../lib/sidebar-cache-db.mjs"

function sampleEntry(id, lastActivity, overrides = {}) {
  return {
    id,
    projectPath: `/tmp/proj-${id.slice(0, 4)}`,
    projectDisplayName: `Project ${id.slice(0, 4)}`,
    source: "claude",
    messageCount: 10,
    userMessageCount: 3,
    firstName: `First ${id}`,
    lastActivity,
    mtime: String(Date.parse(lastActivity)),
    customName: null,
    ...overrides,
  }
}

describe("sidebar-cache-db", () => {
  /** @type {string} */
  let configDir

  beforeEach(() => {
    closeSidebarCacheDb()
    configDir = mkdtempSync(join(tmpdir(), "asv-cache-test-"))
  })

  afterEach(() => {
    closeSidebarCacheDb()
    rmSync(configDir, { recursive: true, force: true })
  })

  it("migrates legacy JSON when DB is empty", () => {
    const sessions = [
      sampleEntry("aaaa-1111", "2026-06-06T12:00:00.000Z"),
      sampleEntry("bbbb-2222", "2026-06-05T12:00:00.000Z"),
    ]
    writeFileSync(
      join(configDir, SIDEBAR_CACHE_JSON_LEGACY),
      JSON.stringify({ v: 2, sessions }),
    )
    const { migrated } = openSidebarCacheDb(configDir)
    assert.equal(migrated, 2)
    assert.equal(getSidebarSessionCount(), 2)
    assert.ok(!existsSync(join(configDir, SIDEBAR_CACHE_JSON_LEGACY)))
    assert.ok(existsSync(join(configDir, `${SIDEBAR_CACHE_JSON_LEGACY}.migrated`)))
    assert.equal(getTopSidebarEntries(1)[0].id, "aaaa-1111")
  })

  it("orders getTopSidebarEntries by last_activity desc", () => {
    openSidebarCacheDb(configDir)
    replaceAllSidebarEntries([
      sampleEntry("old-0001", "2026-01-01T00:00:00.000Z"),
      sampleEntry("mid-0002", "2026-03-01T00:00:00.000Z"),
      sampleEntry("new-0003", "2026-06-01T00:00:00.000Z"),
    ])
    const top2 = getTopSidebarEntries(2).map(e => e.id)
    assert.deepEqual(top2, ["new-0003", "mid-0002"])
  })

  it("upsert is idempotent when tracked fields unchanged", () => {
    openSidebarCacheDb(configDir)
    const entry = sampleEntry("sess-0001", "2026-06-06T10:00:00.000Z")
    const first = upsertSidebarEntry(entry)
    assert.equal(first.changed, true)
    assert.equal(getSidebarSessionCount(), 1)

    const second = upsertSidebarEntry({
      id: entry.id,
      messageCount: entry.messageCount,
      userMessageCount: entry.userMessageCount,
      firstName: entry.firstName,
      lastActivity: entry.lastActivity,
      mtime: entry.mtime,
    })
    assert.equal(second.changed, false)
    assert.equal(getSidebarSessionCount(), 1)
  })

  it("upsert detects messageCount changes", () => {
    openSidebarCacheDb(configDir)
    upsertSidebarEntry(sampleEntry("sess-0002", "2026-06-06T10:00:00.000Z", { messageCount: 5 }))
    const { changed, entry } = upsertSidebarEntry({
      id: "sess-0002",
      messageCount: 42,
      mtime: "1717670400001",
    })
    assert.equal(changed, true)
    assert.equal(entry.messageCount, 42)
    assert.equal(getSidebarEntry("sess-0002").messageCount, 42)
  })

  it("removes an existing Claude row when its transcript becomes empty", () => {
    openSidebarCacheDb(configDir)
    const existing = sampleEntry("empty-0001", "2026-06-06T10:00:00.000Z")
    upsertSidebarEntry(existing)
    upsertSidebarEntry({ ...existing, messageCount: 0 })
    assert.equal(getSidebarEntry(existing.id), null)
    assert.equal(getSidebarSessionCount(), 0)
  })

  it("deleteSidebarEntry removes a stale row", () => {
    openSidebarCacheDb(configDir)
    const existing = sampleEntry("stale-0001", "2026-06-06T10:00:00.000Z")
    upsertSidebarEntry(existing)
    assert.equal(deleteSidebarEntry(existing.id)?.id, existing.id)
    assert.equal(deleteSidebarEntry(existing.id), null)
    assert.equal(getSidebarSessionCount(), 0)
  })

  it("upsertSidebarEntries batches in a transaction", () => {
    openSidebarCacheDb(configDir)
    const changed = upsertSidebarEntries([
      sampleEntry("a-0001", "2026-06-06T12:00:00.000Z"),
      sampleEntry("b-0002", "2026-06-06T11:00:00.000Z"),
    ])
    assert.equal(changed.length, 2)
    assert.equal(getSidebarSessionCount(), 2)
  })

  it("replaceAllSidebarEntries replaces without duplicating count", () => {
    openSidebarCacheDb(configDir)
    replaceAllSidebarEntries([
      sampleEntry("x-0001", "2026-06-06T12:00:00.000Z"),
      sampleEntry("y-0002", "2026-06-06T11:00:00.000Z"),
    ])
    assert.equal(getSidebarSessionCount(), 2)
    replaceAllSidebarEntries([
      sampleEntry("z-0003", "2026-06-07T12:00:00.000Z"),
    ])
    assert.equal(getSidebarSessionCount(), 1)
    assert.deepEqual(getAllSidebarEntries().map(e => e.id), ["z-0003"])
  })

  it("persists sidechain metadata", () => {
    openSidebarCacheDb(configDir)
    upsertSidebarEntry(sampleEntry("sub-0001", "2026-06-06T12:00:00.000Z", {
      isSidechain: true,
      parentSessionId: "parent-99",
      agentType: "subagent",
    }))
    const got = getSidebarEntry("sub-0001")
    assert.equal(got.isSidechain, true)
    assert.equal(got.parentSessionId, "parent-99")
    assert.equal(got.agentType, "subagent")
  })

  it("upserts when sidechain metadata is added to an existing entry", () => {
    openSidebarCacheDb(configDir)
    const base = sampleEntry("sess-1", "2026-06-06T12:00:00.000Z")
    upsertSidebarEntry(base)
    const { changed } = upsertSidebarEntry({
      ...base,
      isSidechain: true,
      parentSessionId: "parent-1",
      agentType: "subagent",
    })
    assert.equal(changed, true)
    const got = getSidebarEntry("sess-1")
    assert.equal(got.isSidechain, true)
    assert.equal(got.parentSessionId, "parent-1")
  })

  it("getTopSidebarEntries(0) returns all sessions", () => {
    openSidebarCacheDb(configDir)
    replaceAllSidebarEntries([
      sampleEntry("a-0001", "2026-06-06T12:00:00.000Z"),
      sampleEntry("b-0002", "2026-06-06T11:00:00.000Z"),
    ])
    assert.equal(getTopSidebarEntries(0).length, 2)
  })

  it("getTopSidebarEntries includes subagents when parent is in top N", () => {
    openSidebarCacheDb(configDir)
    replaceAllSidebarEntries([
      sampleEntry("parent-1", "2026-06-06T15:00:00.000Z"),
      sampleEntry("other-1", "2026-06-06T14:00:00.000Z"),
      sampleEntry("sub-1", "2026-06-06T10:00:00.000Z", {
        isSidechain: true,
        parentSessionId: "parent-1",
        agentType: "subagent",
      }),
    ])
    const top = getTopSidebarEntries(2)
    const ids = top.map(e => e.id).sort()
    assert.deepEqual(ids, ["other-1", "parent-1", "sub-1"])
  })

  it("getTopSidebarEntries includes parent when subagent is in top N", () => {
    openSidebarCacheDb(configDir)
    replaceAllSidebarEntries([
      sampleEntry("parent-1", "2026-06-01T10:00:00.000Z"),
      sampleEntry("other-1", "2026-06-06T14:00:00.000Z"),
      sampleEntry("sub-1", "2026-06-06T15:00:00.000Z", {
        isSidechain: true,
        parentSessionId: "parent-1",
        agentType: "subagent",
      }),
    ])
    const top = getTopSidebarEntries(2)
    const ids = top.map(e => e.id).sort()
    assert.deepEqual(ids, ["other-1", "parent-1", "sub-1"])
  })
})
