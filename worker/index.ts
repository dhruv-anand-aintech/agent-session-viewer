type Provider = {
  id: string
  label: string
  kind: "local-tunnel" | "worker-js" | "cloud-http"
  status: "available" | "missing"
  agents: string[]
  detail?: string
  endpoint?: string
}

type Env = {
  ASSETS?: { fetch: (request: Request) => Promise<Response> }
  LOCAL_AGENT_BASE_URL?: string
  AGENT_PROVIDER_CONFIG?: string
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Auth-Pin",
    },
  })
}

function parseProviderConfig(raw?: string): Provider[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const providers = Array.isArray(parsed) ? parsed : parsed.providers
    if (!Array.isArray(providers)) return []
    return providers
      .map((provider): Provider => ({
        id: String(provider.id ?? "").trim(),
        label: String(provider.label ?? provider.id ?? "").trim(),
        kind: provider.kind === "local-tunnel" || provider.kind === "worker-js" ? provider.kind : "cloud-http",
        status: "available",
        agents: Array.isArray(provider.agents) ? provider.agents.map(String) : ["random"],
        detail: provider.detail ? String(provider.detail) : undefined,
        endpoint: provider.endpoint ? String(provider.endpoint) : undefined,
      }))
      .filter(provider => provider.id.length > 0 && provider.label.length > 0)
  } catch {
    return []
  }
}

function providers(env: Env): Provider[] {
  const localBase = env.LOCAL_AGENT_BASE_URL?.replace(/\/$/, "")
  return [
    {
      id: "local",
      label: "Local agl tunnel",
      kind: "local-tunnel",
      status: localBase ? "available" : "missing",
      agents: ["random", "codex", "claude", "cursor", "opencode", "gemini", "antigravity"],
      detail: localBase ? `proxying to ${localBase}` : "Set LOCAL_AGENT_BASE_URL to a Cloudflare Tunnel or other local origin URL.",
      endpoint: localBase ? `${localBase}/api/agent/chat` : undefined,
    },
    {
      id: "worker-js",
      label: "Worker JS",
      kind: "worker-js",
      status: "available",
      agents: ["worker-js"],
      detail: "Runs inside Cloudflare Workers; useful for lightweight JS-based agents only.",
    },
    ...parseProviderConfig(env.AGENT_PROVIDER_CONFIG),
  ]
}

async function proxyChat(endpoint: string, request: Request): Promise<Response> {
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

async function workerJsChat(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({})) as {
    prompt?: string
    sessionContext?: { sessionId?: string; source?: string; messages?: unknown[] }
  }
  const messageCount = Array.isArray(body.sessionContext?.messages) ? body.sessionContext.messages.length : 0
  const text = [
    "Worker JS provider is connected.",
    `Session: ${body.sessionContext?.source ?? "unknown"}:${body.sessionContext?.sessionId ?? "unknown"}`,
    `Context messages available: ${messageCount}`,
    "",
    "This provider cannot run local CLIs. Choose Local agl tunnel or a cloud HTTP provider for coding-agent execution.",
    body.prompt ? `\nLatest message: ${body.prompt}` : "",
  ].join("\n")
  return json({ ok: true, provider: "worker-js", agent: "worker-js", text })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return json({}, 204)

    const url = new URL(request.url)
    if (url.pathname === "/api/agent/providers" && request.method === "GET") {
      const list = providers(env)
      return json({
        providers: list,
        defaults: {
          provider: list.find(provider => provider.id === "local" && provider.status === "available") ? "local" : "worker-js",
          agent: "random",
          mode: "ask",
          modelClass: "pro",
        },
      })
    }

    if (url.pathname === "/api/agent/chat" && request.method === "POST") {
      const body = await request.clone().json().catch(() => ({})) as { provider?: string }
      const providerId = body.provider ?? "local"
      if (providerId === "worker-js") return workerJsChat(request)

      const provider = providers(env).find(entry => entry.id === providerId)
      if (!provider?.endpoint) return json({ ok: false, error: `Provider is not configured: ${providerId}` }, 400)

      try {
        return await proxyChat(provider.endpoint, request)
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502)
      }
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, runtime: "cloudflare-worker" })
    }

    if (env.ASSETS) return env.ASSETS.fetch(request)
    return new Response("Agent Session Viewer Worker is running.", { headers: { "Content-Type": "text/plain" } })
  },
}
