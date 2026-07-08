import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "../worker"

describe("worker local agent proxy auth", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("does not expose local agent auth material in provider metadata", async () => {
    const response = await worker.fetch(new Request("https://asv.test/api/agent/providers"), {
      LOCAL_AGENT_BASE_URL: "https://asv-dhruv.example.test",
      LOCAL_AGENT_AUTH_PIN: "secret-pin",
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { providers: Array<Record<string, unknown>> }
    const local = body.providers.find(provider => provider.id === "local")
    expect(local).toMatchObject({
      id: "local",
      status: "available",
      detail: "proxying to https://asv-dhruv.example.test",
    })
    expect(local).not.toHaveProperty("endpoint")
    expect(local).not.toHaveProperty("authToken")
    expect(local).not.toHaveProperty("authPin")
  })

  it("sends X-Auth-Pin when proxying local agent chat", async () => {
    let upstreamUrl = ""
    let upstreamInit: RequestInit | undefined
    globalThis.fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = String(request)
      upstreamInit = init
      return new Response(JSON.stringify({ ok: true, text: "proxied" }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    const response = await worker.fetch(new Request("https://asv.test/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", agent: "worker-js", prompt: "smoke" }),
    }), {
      LOCAL_AGENT_BASE_URL: "https://asv-dhruv.example.test",
      LOCAL_AGENT_AUTH_PIN: "secret-pin",
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, text: "proxied" })
    const headers = new Headers(upstreamInit?.headers)
    expect(upstreamUrl).toBe("https://asv-dhruv.example.test/api/agent/chat")
    expect(headers.get("X-Auth-Pin")).toBe("secret-pin")
    expect(headers.get("Authorization")).toBeNull()
  })
})
