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

  it("proxies deterministic context and preserves the live summary stream", async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    globalThis.fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request)
      calls.push({ url, headers: new Headers(init?.headers) })
      if (url.endsWith("summary-context")) {
        return new Response(JSON.stringify({ ok: true, sessions: [{ sessionId: "active" }] }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("event: delta\ndata: {\"text\":\"- done\"}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    }) as unknown as typeof fetch
    const env = {
      LOCAL_AGENT_BASE_URL: "https://asv-dhruv.example.test",
      LOCAL_AGENT_AUTH_PIN: "secret-pin",
    }

    const context = await worker.fetch(new Request("https://asv.test/api/agent/summary-context"), env)
    expect(context.status).toBe(200)
    await expect(context.json()).resolves.toMatchObject({ ok: true })

    const stream = await worker.fetch(new Request("https://asv.test/api/agent/summary-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local" }),
    }), env)
    expect(stream.headers.get("Content-Type")).toBe("text/event-stream")
    await expect(stream.text()).resolves.toContain("event: delta")
    expect(calls.map(call => call.url)).toEqual([
      "https://asv-dhruv.example.test/api/agent/summary-context",
      "https://asv-dhruv.example.test/api/agent/summary-stream",
    ])
    expect(calls.every(call => call.headers.get("X-Auth-Pin") === "secret-pin")).toBe(true)
  })
})
