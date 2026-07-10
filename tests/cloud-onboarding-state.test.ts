import { describe, expect, it } from "vitest"
import { isCloudMachineConnected, isNewCloudMachineConnected } from "../src/cloudOnboardingState"

describe("isCloudMachineConnected", () => {
  it("recognizes the onboarding status flag", () => {
    expect(isCloudMachineConnected({ connected: true })).toBe(true)
    expect(isCloudMachineConnected({ connected: false })).toBe(false)
  })

  it("requires a machine to have checked in", () => {
    expect(isCloudMachineConnected({ machines: [{ id: "new", last_seen_at: null }] })).toBe(false)
    expect(isCloudMachineConnected({ machines: [{ id: "live", last_seen_at: "2026-07-10T10:00:00Z" }] })).toBe(true)
  })

  it("is false for malformed responses", () => {
    expect(isCloudMachineConnected(null)).toBe(false)
    expect(isCloudMachineConnected([])).toBe(false)
  })

  it("waits for the newly paired Mac instead of an older connected machine", () => {
    const existing = new Set(["old"])
    expect(isNewCloudMachineConnected({ machines: [
      { id: "old", connected: true },
      { id: "new", connected: false },
    ] }, existing)).toBe(false)
    expect(isNewCloudMachineConnected({ machines: [
      { id: "old", connected: true },
      { id: "new", last_seen_at: "2026-07-10 15:00:00" },
    ] }, existing)).toBe(true)
  })
})
