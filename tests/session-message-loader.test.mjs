import assert from "node:assert/strict"
import { test } from "node:test"

import { isLegacyCodexProjectPath } from "../lib/session-message-loader.mjs"

test("detects stale Codex project paths for UUID-based deep-link fallback", () => {
  assert.equal(
    isLegacyCodexProjectPath(
      "codex:codex-global",
      "codex:/Users/dhruvanand/Code/phone-debug",
    ),
    true,
  )
  assert.equal(
    isLegacyCodexProjectPath(
      "codex:/Users/dhruvanand/Code/phone-debug",
      "codex:/Users/dhruvanand/Code/phone-debug",
    ),
    false,
  )
  assert.equal(
    isLegacyCodexProjectPath(
      "/Users/dhruvanand/.claude/projects/-Users-dhruvanand-Code-phone-debug",
      "codex:/Users/dhruvanand/Code/phone-debug",
    ),
    false,
  )
})
