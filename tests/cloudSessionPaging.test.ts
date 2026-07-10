import { describe, expect, it, vi } from "vitest"
import { CLOUD_SESSION_PAGE_SIZE, requestMoreCloudSessions } from "../src/cloudSessionPaging"

describe("requestMoreCloudSessions", () => {
  it("requests one 30-session page with the signed-in cookie", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ queued: true }), { status: 202 }))

    await requestMoreCloudSessions({ offset: 30 }, fetcher as typeof fetch)

    expect(CLOUD_SESSION_PAGE_SIZE).toBe(30)
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/load-more", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ offset: 30, limit: 30 }),
    })
  })

  it("surfaces the API error", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "No connected Mac" }), { status: 409 }))

    await expect(requestMoreCloudSessions({ offset: 60 }, fetcher as typeof fetch))
      .rejects.toThrow("No connected Mac")
  })

  it("allows the local viewer to widen its SSE query without a cloud endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }))

    await expect(requestMoreCloudSessions({ offset: 30 }, fetcher as typeof fetch))
      .resolves.toEqual({ local: true })
  })
})
