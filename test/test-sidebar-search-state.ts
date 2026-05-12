/**
 * Regression test for sidebar search result merging.
 *
 * Run with: npx tsx test/test-sidebar-search-state.ts
 */
import assert from "node:assert/strict"
import { mergeSidebarSearchResultItems } from "../src/sidebarSearchState.ts"

const apiSession = {
  id: "sess-1",
  source: "codex",
  customName: "Codex title",
  firstName: "Codex first",
}

const merged = mergeSidebarSearchResultItems(
  [
    {
      key: "codex:/workspace/sess-1",
      s: apiSession,
      projectPath: "codex:/workspace",
      sessionId: "sess-1",
      highlightTitleQuery: "codex",
    },
  ],
  [
    {
      key: "codex:/workspace/sess-1",
      s: { ...apiSession },
      projectPath: "codex:/workspace",
      sessionId: "sess-1",
      searchMatch: { fieldLabel: "Platform", snippet: "Codex", highlightQuery: "codex" },
    },
    {
      key: "openclaw:/workspace/sess-2",
      s: { id: "sess-2", source: "openclaw" },
      projectPath: "openclaw:/workspace",
      sessionId: "sess-2",
      highlightTitleQuery: "openclaw",
    },
  ],
)

assert.equal(merged.length, 2, "duplicate sidebar search rows should be merged away")
assert.equal(merged[0].key, "codex:/workspace/sess-1", "API results should keep their position")
assert.equal(merged[0].s, apiSession, "primary result should win when keys collide")
assert.equal(merged[1].key, "openclaw:/workspace/sess-2", "non-duplicate rows should remain")

console.log("  ✓  sidebar search result merge deduplicates duplicate keys")
