import { describe, expect, it } from "vitest"
import { DEFAULT_DOM, domLimitForMemory, MAX_DOM, MIN_DOM } from "../src/useWindowedMessages"

const gb = 1024 * 1024 * 1024
const mb = 1024 * 1024

describe("domLimitForMemory", () => {
  it("keeps a larger message window when heap usage is low", () => {
    expect(domLimitForMemory({ usedJSHeapSize: 64 * mb, jsHeapSizeLimit: 4 * gb })).toBe(MAX_DOM)
  })

  it("uses a conservative default without browser memory counters", () => {
    expect(domLimitForMemory(null)).toBe(DEFAULT_DOM)
  })

  it("falls back to the old floor under real heap pressure", () => {
    expect(domLimitForMemory({ usedJSHeapSize: 800 * mb, jsHeapSizeLimit: 2 * gb })).toBe(MIN_DOM)
  })
})
