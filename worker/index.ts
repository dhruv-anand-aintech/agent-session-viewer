export interface Env {
  SESSIONS_KV: KVNamespace
  AUTH_PIN: string
}

function checkAuth(request: Request, env: Env): boolean {
  const cookie = request.headers.get("Cookie") ?? ""
  const match = cookie.match(/(?:^|;\s*)auth_pin=([^;]+)/)
  return match?.[1] === env.AUTH_PIN
}

function checkSyncAuth(request: Request, env: Env): boolean {
  // Daemon uses X-Auth-Pin header (not cookie — no browser)
  const pin = request.headers.get("X-Auth-Pin") ?? ""
  return pin === env.AUTH_PIN
}

function corsHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, PUT, OPTIONS", ...extra })
}

async function getProjects(env: Env) {
  const list = await env.SESSIONS_KV.list({ prefix: "meta/" })
  const map: Record<string, unknown[]> = {}

  for (const key of list.keys) {
    const parts = key.name.split("/")
    if (parts.length < 3) continue
    const projectPath = decodeURIComponent(parts[1])
    const data = await env.SESSIONS_KV.get(key.name, "json")
    if (!data) continue
    if (!map[projectPath]) map[projectPath] = []
    map[projectPath].push(data)
  }

  return Object.entries(map).map(([path, sessions]) => ({
    path,
    displayName: path.replace(/^-Users-[^-]+-Code-/, "").replace(/-/g, "/"),
    sessions: (sessions as Record<string, unknown>[]).sort((a, b) =>
      String(b.lastActivity ?? "").localeCompare(String(a.lastActivity ?? ""))
    ),
  })).sort((a, b) => {
    const aDate = String((a.sessions[0] as Record<string,unknown>)?.lastActivity ?? "")
    const bDate = String((b.sessions[0] as Record<string,unknown>)?.lastActivity ?? "")
    return bDate.localeCompare(aDate)
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() })

    // PIN auth: /api/login accepts POST with {pin}, sets cookie; all other /api/* routes require it
    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json() as { pin?: string }
      if (body.pin === env.AUTH_PIN) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: new Headers({
            "Content-Type": "application/json",
            "Set-Cookie": `auth_pin=${env.AUTH_PIN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
          }),
        })
      }
      return new Response(JSON.stringify({ ok: false }), { status: 401, headers: new Headers({ "Content-Type": "application/json" }) })
    }

    // Daemon sync endpoint — authenticated via X-Auth-Pin header
    if (url.pathname === "/api/sync" && request.method === "PUT") {
      if (!checkSyncAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders({ "Content-Type": "application/json" }) })
      }
      const payload = await request.json() as { meta: Record<string, unknown>; msgs: unknown[] }
      const { meta, msgs } = payload
      const projectPath = String(meta.projectPath ?? "")
      const sessionId = String(meta.id ?? "")
      if (!projectPath || !sessionId) {
        return new Response(JSON.stringify({ error: "Missing projectPath or id" }), { status: 400, headers: corsHeaders({ "Content-Type": "application/json" }) })
      }
      // Preserve any existing customName set via the UI
      const existing = await env.SESSIONS_KV.get(`meta/${projectPath}/${sessionId}`, "json") as Record<string, unknown> | null
      if (existing?.customName) meta.customName = existing.customName
      meta.isActive = true
      // Backfill userMessageCount from msgs if daemon didn't compute it
      if (meta.userMessageCount == null) {
        meta.userMessageCount = (msgs as Array<{type?: string}>).filter(m => m.type === "user").length
      }
      await env.SESSIONS_KV.put(`meta/${projectPath}/${sessionId}`, JSON.stringify(meta))
      await env.SESSIONS_KV.put(`msgs/${projectPath}/${sessionId}`, JSON.stringify(msgs))
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders({ "Content-Type": "application/json" }) })
    }

    // Rename a session — store customName in meta
    const renameMatch = url.pathname.match(/^\/api\/names\/([^/]+)\/([^/]+)$/)
    if (renameMatch && request.method === "PUT") {
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: new Headers({ "Content-Type": "application/json" }) })
      }
      const projectPath = decodeURIComponent(renameMatch[1])
      const sessionId = renameMatch[2]
      const { name } = await request.json() as { name: string }
      const metaKey = `meta/${projectPath}/${sessionId}`
      const existing = await env.SESSIONS_KV.get(metaKey, "json") as Record<string, unknown> | null
      if (!existing) return new Response("Not Found", { status: 404, headers: corsHeaders() })
      existing.customName = name.trim() || null  // empty string → clear name
      await env.SESSIONS_KV.put(metaKey, JSON.stringify(existing))
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders({ "Content-Type": "application/json" }) })
    }

    // Settings — must be before the global cookie guard because daemon uses X-Auth-Pin
    if (url.pathname === "/api/settings") {
      if (request.method === "GET") {
        if (!checkSyncAuth(request, env) && !checkAuth(request, env)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders({ "Content-Type": "application/json" }) })
        }
        const settings = await env.SESSIONS_KV.get("settings", "json") ?? {}
        return Response.json(settings, { headers: corsHeaders() })
      }
      if (request.method === "PUT") {
        if (!checkAuth(request, env)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders({ "Content-Type": "application/json" }) })
        }
        const body = await request.json() as Record<string, unknown>
        await env.SESSIONS_KV.put("settings", JSON.stringify(body))
        return Response.json({ ok: true }, { headers: corsHeaders() })
      }
    }

    if (url.pathname.startsWith("/api/") && !checkAuth(request, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: new Headers({ "Content-Type": "application/json" }) })
    }

    if (url.pathname === "/api/debug") {
      const list = await env.SESSIONS_KV.list({ prefix: "meta/" })
      await env.SESSIONS_KV.put("__test__", "hello-from-kv")
      const selfTest = await env.SESSIONS_KV.get("__test__")
      return Response.json({ keyCount: list.keys.length, selfTest }, { headers: corsHeaders() })
    }

    if (url.pathname === "/api/projects") {
      return Response.json(await getProjects(env), { headers: corsHeaders() })
    }

    if (url.pathname === "/api/stream") {
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const enc = new TextEncoder()
      const send = async (event: string, data: unknown) =>
        writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      ;(async () => {
        try {
          await send("projects", await getProjects(env))
          const deadline = Date.now() + 88_000
          while (Date.now() < deadline && !request.signal.aborted) {
            await new Promise(r => setTimeout(r, 4000))
            await send("projects", await getProjects(env))
          }
        } catch { /* disconnect */ }
        finally { writer.close() }
      })()
      return new Response(readable, {
        headers: corsHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }),
      })
    }

    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/)
    if (sessionMatch) {
      const key = `msgs/${decodeURIComponent(sessionMatch[1])}/${sessionMatch[2]}`
      const data = await env.SESSIONS_KV.get(key, "json")
      return data
        ? Response.json(data, { headers: corsHeaders() })
        : new Response("Not Found", { status: 404, headers: corsHeaders() })
    }

    // All other routes: let Cloudflare assets handle it (set by `assets = { directory }`)
    return new Response("Not Found", { status: 404 })
  },
}
