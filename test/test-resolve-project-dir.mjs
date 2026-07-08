/**
 * Tests for resolveProjectDir — run with: node test/test-resolve-project-dir.mjs
 *
 * Uses real paths from this machine to verify correctness.
 * All cases verified against actual disk contents.
 */
import { homedir } from "os"
import { join } from "path"
import { existsSync } from "fs"

const home = homedir()

// ── Import the function under test ───────────────────────────────────────────

// Inline the implementation so tests are self-contained and can be run before
// the server is started. This must stay in sync with local-server.mjs.

const CLAUDE_DIR = join(home, ".claude", "projects")

function decodeClaudeEncodedDir(encodedDir) {
  // Strip leading "-Users-<username>-" prefix (Claude encodes full abs path as dashes)
  const withoutUser = encodedDir.replace(/^-?Users-[^-]+-/, "")
  const segments = withoutUser.split("-").filter(Boolean)

  let current = home
  let i = 0
  while (i < segments.length) {
    let matched = false
    // Try longest prefix of remaining segments first (greedy)
    for (let j = segments.length; j > i; j--) {
      const name = segments.slice(i, j).join("-")
      if (existsSync(join(current, name))) {
        current = join(current, name)
        i = j
        matched = true
        break
      }
    }
    if (!matched) {
      // Nothing on disk matches — append remaining as a single dashed name (best guess)
      current = join(current, segments.slice(i).join("-"))
      break
    }
  }
  return current
}

function resolveProjectDir(projectPath) {
  // Modern platform-prefixed with absolute path: "prefix:/actual/path"
  const absMatch = projectPath.match(/^[a-z-]+:(\/.+)$/)
  if (absMatch) return absMatch[1]

  // Claude absolute path under CLAUDE_DIR (always dash-encoded by Claude)
  if (projectPath.startsWith(CLAUDE_DIR + "/")) {
    return decodeClaudeEncodedDir(projectPath.slice(CLAUDE_DIR.length + 1))
  }

  // Legacy platform-prefixed with encoded path (old normProjectDir / cursor-agent slug)
  // e.g. "cursor-agent:Users-dhruvanand-Code-myproject" or "codex:Code-myproject"
  const encodedMatch = projectPath.match(/^[a-z-]+:([^/].+)$/)
  if (encodedMatch) {
    const encoded = encodedMatch[1]
    // cursor-agent slugs omit the leading "/" so they start with "Users-"
    return decodeClaudeEncodedDir(encoded.startsWith("Users-") ? `-${encoded}` : encoded)
  }

  if (projectPath.startsWith("/")) return projectPath
  return join(home, projectPath)
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function expect(label, got, want) {
  if (got === want) {
    console.log(`  ✓  ${label}`)
    passed++
  } else {
    console.error(`  ✗  ${label}`)
    console.error(`       got : ${got}`)
    console.error(`       want: ${want}`)
    failed++
  }
}

// ── Claude encoded paths ──────────────────────────────────────────────────────

console.log("\nClaude encoded dirs (CLAUDE_DIR paths):")

// Simple: no ambiguous dashes in project name
expect(
  "agent-session-viewer",
  resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-agent-session-viewer`),
  `${home}/Code/agent-session-viewer`
)
expect(
  "agent-rules-sync-standalone (dashes in name)",
  resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-agent-rules-sync-standalone`),
  `${home}/Code/agent-rules-sync-standalone`
)
expect(
  "etymology-viz",
  resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-etymology-viz`),
  `${home}/Code/etymology-viz`
)
expect(
  "lipsync (no dash in name)",
  resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-lipsync`),
  `${home}/Code/lipsync`
)

// Nested: home-debug is a real dir, CloudSweeper lives inside it
expect(
  "home-debug/CloudSweeper (nested, home-debug is real dir)",
  resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-home-debug-CloudSweeper`),
  `${home}/Code/home-debug/CloudSweeper`
)

// Flat with dashes: when home-debug-librera-voice exists as a real top-level
// dir, it beats the nested home-debug fallback. If it is absent on this
// machine, the resolver should fall back under the existing home-debug dir.
const flatHomeDebugLibrera = `${home}/Code/home-debug-librera-voice`
expect(
  "home-debug-librera-voice (flat with dashes if present, otherwise nested fallback)",
  resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-home-debug-librera-voice`),
  existsSync(flatHomeDebugLibrera) ? flatHomeDebugLibrera : `${home}/Code/home-debug/librera-voice`
)

// Nested where inner dir has dashes: home-debug/location-pois doesn't exist on disk,
// but home-debug does — should fall back gracefully into home-debug
expect(
  "home-debug-location-pois (home-debug exists, location-pois missing → best guess)",
  resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-home-debug-location-pois`),
  `${home}/Code/home-debug/location-pois`
)

// Just ~/Code itself
expect(
  "-Users-dhruvanand-Code (project is ~/Code)",
  resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code`),
  `${home}/Code`
)

// ── Modern platform-prefixed paths (after normProjectDir fix) ────────────────

console.log("\nModern platform paths (prefix:/absolute/path):")

expect(
  "codex absolute",
  resolveProjectDir("codex:/Users/dhruvanand/Code/agent-session-viewer"),
  "/Users/dhruvanand/Code/agent-session-viewer"
)
expect(
  "opencode absolute",
  resolveProjectDir("opencode:/Users/dhruvanand/Code/agent-session-viewer"),
  "/Users/dhruvanand/Code/agent-session-viewer"
)
expect(
  "codex nested path",
  resolveProjectDir("codex:/Users/dhruvanand/Code/home-debug/location-pois"),
  "/Users/dhruvanand/Code/home-debug/location-pois"
)
expect(
  "codex Downloads path",
  resolveProjectDir("codex:/Users/dhruvanand/Downloads/fwdframeswithmeasurements"),
  "/Users/dhruvanand/Downloads/fwdframeswithmeasurements"
)
expect(
  "hermes non-standard (hermes:cli)",
  // hermes:cli → encoded match, decoded as ~/cli best-guess
  resolveProjectDir("hermes:cli"),
  `${home}/cli`
)

// ── Cross-platform: same real dir should resolve to same absolute path ────────

console.log("\nCross-platform merge (same real dir, different projectPath formats):")

const claudePath = resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-agent-session-viewer`)
const codexPath  = resolveProjectDir("codex:/Users/dhruvanand/Code/agent-session-viewer")
const ocodePath  = resolveProjectDir("opencode:/Users/dhruvanand/Code/agent-session-viewer")
expect("claude == codex for agent-session-viewer",  claudePath, codexPath)
expect("claude == opencode for agent-session-viewer", claudePath, ocodePath)

const claudeNested = resolveProjectDir(`${CLAUDE_DIR}/-Users-dhruvanand-Code-home-debug-CloudSweeper`)
const codexNested  = resolveProjectDir("codex:/Users/dhruvanand/Code/home-debug/CloudSweeper")
expect("claude == codex for home-debug/CloudSweeper", claudeNested, codexNested)

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
