/**
 * Regression test for session pane path pinning and load-more visibility.
 *
 * Run with: npx tsx test/test-session-pane-state.ts
 */
import assert from "node:assert/strict"
import { canonicalizeSelectedProjectPath, createPinnedProjectPath, getLoadEarlierControlState, hasEarlierMessages } from "../src/sessionPaneState.ts"

const mountProjectDir = "codex:/Users/dhruvanand/Code/agent-session-viewer"
const divergedProjectDir = "/Users/dhruvanand/.claude/projects/-Users-dhruvanand-Code-agent-session-viewer"

const pinned = createPinnedProjectPath(mountProjectDir)

assert.equal(pinned.current, mountProjectDir, "pinned path should keep the mount-time project dir")
assert.equal(pinned.diverges(mountProjectDir), false, "same project path should not diverge")
assert.equal(pinned.diverges(divergedProjectDir), true, "late project-path changes should be reported as divergent")
assert.equal(pinned.current, mountProjectDir, "divergence must not mutate the pinned path")

assert.equal(hasEarlierMessages({ startIdx: 0, serverFetchedFrom: 298 }), true, "tail windows with server-fetched history should show load earlier")
assert.equal(hasEarlierMessages({ startIdx: 12, serverFetchedFrom: 0 }), true, "locally-held earlier messages should show load earlier")
assert.equal(hasEarlierMessages({ startIdx: 0, serverFetchedFrom: 0 }), false, "fully loaded windows should hide load earlier")

const pendingControl = getLoadEarlierControlState({ startIdx: 0, serverFetchedFrom: 0 }, false, true)
assert.equal(pendingControl.show, true, "pending remote confirmation should keep the control visible")
assert.equal(pendingControl.disabled, true, "pending remote confirmation should disable the control")
assert.equal(pendingControl.label, "Checking for earlier messages…", "pending remote confirmation should use a neutral label")

const readyControl = getLoadEarlierControlState({ startIdx: 0, serverFetchedFrom: 298 }, false, false)
assert.equal(readyControl.show, true, "server-fetched history should keep the control visible")
assert.equal(readyControl.disabled, false, "server-fetched history should enable the control")
assert.equal(readyControl.label, "↑ Load earlier messages", "server-fetched history should use the normal label")

assert.equal(
  canonicalizeSelectedProjectPath(
    "/Users/dhruvanand/.claude/projects/-Users-dhruvanand-Code-agent-session-viewer",
    "codex:/Users/dhruvanand/Code/agent-session-viewer",
    "codex:/Users/dhruvanand/Code/agent-session-viewer",
  ),
  "codex:/Users/dhruvanand/Code/agent-session-viewer",
  "canonical project path should prefer resolved metadata over stale URL paths",
)

console.log("  ✓  session pane path pinning and load-more visibility behave as expected")
