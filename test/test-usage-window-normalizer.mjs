import assert from "node:assert/strict"
import { normalizeCodexRateLimit } from "../lib/usage-window-normalizer.mjs"

const fixedNow = Date.parse("2026-05-17T00:00:00.000Z")

const normalized = normalizeCodexRateLimit({
  primary_window: {
    used_percent: 9,
    reset_at: 1_800_000_000,
    limit_window_seconds: 18_000,
  },
  secondary_window: {
    used_percent: "1",
    reset_at: 1_800_604_800,
    limit_window_seconds: 604_800,
  },
}, { now: fixedNow })

assert.equal(normalized.primary.usedPercent, 9)
assert.equal(normalized.primary.remainingPercent, 91)
assert.equal(normalized.primary.windowMinutes, 300)
assert.equal(normalized.primary.resetsAt, "2027-01-15T08:00:00.000Z")

assert.equal(normalized.secondary.usedPercent, 1)
assert.equal(normalized.secondary.remainingPercent, 99)
assert.equal(normalized.secondary.windowMinutes, 10080)
assert.equal(normalized.secondary.resetsAt, "2027-01-22T08:00:00.000Z")

const swapped = normalizeCodexRateLimit({
  primary_window: {
    used_percent: 2,
    reset_at: 1_800_604_800,
    limit_window_seconds: 604_800,
  },
  secondary_window: {
    used_percent: 12,
    reset_at: 1_800_000_000,
    limit_window_seconds: 18_000,
  },
}, { now: fixedNow })

assert.equal(swapped.primary.windowMinutes, 300)
assert.equal(swapped.primary.usedPercent, 12)
assert.equal(swapped.secondary.windowMinutes, 10080)
assert.equal(swapped.secondary.usedPercent, 2)

console.log("usage window normalizer ok")
