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

async function getProjects(env: Env): Promise<{ projects: ReturnType<typeof buildProjects>; total: number }> {
  const list = await env.SESSIONS_KV.list({ prefix: "meta/" })
  const total = list.keys.length

  const entries = await Promise.all(
    list.keys.map(async key => {
      const parts = key.name.split("/")
      if (parts.length < 3) return null
      const data = await env.SESSIONS_KV.get(key.name, "json")
      if (!data) return null
      return { projectPath: decodeURIComponent(parts[1]), data }
    })
  )

  const map: Record<string, unknown[]> = {}
  for (const entry of entries) {
    if (!entry) continue
    if (!map[entry.projectPath]) map[entry.projectPath] = []
    map[entry.projectPath].push(entry.data)
  }

  return { total, projects: buildProjects(map) }
}

function buildProjects(map: Record<string, unknown[]>) {
  return Object.entries(map).map(([path, sessions]) => ({
    path,
    displayName: path
      .replace(/^(cursor|opencode|antigravity|hermes):/, "$1: ")
      .replace(/^(cursor|opencode|antigravity): -Users-[^-]+-(?:Code|gemini-antigravity-brain)-/, "$1: ")
      .replace(/^-Users-[^-]+-Code-/, "")
      .replace(/-/g, "/"),
    sessions: (sessions as Record<string, unknown>[])
      .filter(s => (s as Record<string,unknown>).agentType !== "prompt_suggestion")
      .sort((a, b) =>
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
        meta.userMessageCount = (msgs as Array<{type?: string; message?: {content?: unknown}}>)
          .filter(m => {
            if (m.type !== "user") return false
            const c = m.message?.content
            if (!c) return false
            if (typeof c === "string") return (c as string).trim().length > 0
            if (!Array.isArray(c)) return false
            return (c as Array<{type?: string}>).some(b => b.type !== "tool_result")
          }).length
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

    // Patch meta fields — daemon uses X-Auth-Pin to set lightweight flags like hasInsights
    if (url.pathname === "/api/meta-patch" && request.method === "POST") {
      if (!checkSyncAuth(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders({ "Content-Type": "application/json" }) })
      }
      const { projectPath, sessionId, fields } = await request.json() as { projectPath: string; sessionId: string; fields: Record<string, unknown> }
      const metaKey = `meta/${projectPath}/${sessionId}`
      const existing = await env.SESSIONS_KV.get(metaKey, "json") as Record<string, unknown> | null
      if (!existing) return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders({ "Content-Type": "application/json" }) })
      await env.SESSIONS_KV.put(metaKey, JSON.stringify({ ...existing, ...fields }))
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders({ "Content-Type": "application/json" }) })
    }

    // Daemon ingest endpoints — authenticated via X-Auth-Pin (must be before cookie guard)
    if (url.pathname === "/api/todos-ingest" && request.method === "POST") {
      if (!checkSyncAuth(request, env)) return new Response("Unauthorized", { status: 401, headers: corsHeaders() })
      const body = await request.json() as { id: string; items: unknown[]; mtime: string }
      await env.SESSIONS_KV.put(`todo/${body.id}`, JSON.stringify({ id: body.id, items: body.items, mtime: body.mtime }))
      return new Response("ok", { headers: corsHeaders() })
    }

    if (url.pathname === "/api/debug-ingest" && request.method === "POST") {
      if (!checkSyncAuth(request, env)) return new Response("Unauthorized", { status: 401, headers: corsHeaders() })
      const body = await request.json() as { lines: string[]; target?: string; reset?: boolean }
      const existing = body.reset ? { lines: [], target: body.target } : (await env.SESSIONS_KV.get("debug/buffer", "json") as { lines: string[]; target?: string } | null) ?? { lines: [] }
      const merged = [...(existing.lines ?? []), ...body.lines].slice(-500)
      await env.SESSIONS_KV.put("debug/buffer", JSON.stringify({ lines: merged, target: body.target ?? existing.target }))
      return new Response("ok", { headers: corsHeaders() })
    }

    if (url.pathname.startsWith("/api/") && !checkAuth(request, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: new Headers({ "Content-Type": "application/json" }) })
    }

    if (url.pathname === "/api/capabilities") {
      return Response.json({ openPath: false, debugStream: true }, { headers: corsHeaders() })
    }

    if (url.pathname === "/api/debug") {
      const list = await env.SESSIONS_KV.list({ prefix: "meta/" })
      await env.SESSIONS_KV.put("__test__", "hello-from-kv")
      const selfTest = await env.SESSIONS_KV.get("__test__")
      return Response.json({ keyCount: list.keys.length, selfTest }, { headers: corsHeaders() })
    }

    if (url.pathname === "/api/projects") {
      const { projects, total } = await getProjects(env)
      return Response.json(projects, { headers: corsHeaders({ "X-Total-Sessions": String(total) }) })
    }

    if (url.pathname === "/api/stream") {
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const enc = new TextEncoder()
      const send = async (event: string, data: unknown) =>
        writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      ;(async () => {
        try {
          await send("projects", (await getProjects(env)).projects)
          const deadline = Date.now() + 88_000
          while (Date.now() < deadline && !request.signal.aborted) {
            await new Promise(r => setTimeout(r, 4000))
            await send("projects", (await getProjects(env)).projects)
          }
        } catch { /* disconnect */ }
        finally { writer.close() }
      })()
      return new Response(readable, {
        headers: corsHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }),
      })
    }

    // Suggestions for a session: scan all metas in the project for prompt_suggestion with matching parentSessionId
    const suggestionsMatch = url.pathname.match(/^\/api\/suggestions\/([^/]+)\/([^/]+)$/)
    if (suggestionsMatch) {
      const projectPath = decodeURIComponent(suggestionsMatch[1])
      const parentSessionId = suggestionsMatch[2]
      const list = await env.SESSIONS_KV.list({ prefix: `meta/${projectPath}/` })
      const results = await Promise.all(
        list.keys.map(async k => {
          const m = await env.SESSIONS_KV.get(k.name, "json") as Record<string,unknown> | null
          if (!m || m.agentType !== "prompt_suggestion" || m.parentSessionId !== parentSessionId) return null
          return { parentUuid: m.suggestionParentUuid, text: m.suggestionText, id: m.id }
        })
      )
      return Response.json(results.filter(Boolean), { headers: corsHeaders() })
    }

    // List all todos
    if (url.pathname === "/api/todos") {
      const list = await env.SESSIONS_KV.list({ prefix: "todo/" })
      const todos = await Promise.all(list.keys.map(k => env.SESSIONS_KV.get(k.name, "json")))
      const sorted = (todos.filter(Boolean) as { id: string; items: unknown[]; mtime: string }[])
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
      return Response.json(sorted, { headers: corsHeaders() })
    }

    // Todos for a specific session — looks up todo/{sessionId}-agent-{sessionId}
    const todoSessionMatch = url.pathname.match(/^\/api\/todos\/(.+)$/)
    if (todoSessionMatch) {
      const sessionId = todoSessionMatch[1]
      const data = await env.SESSIONS_KV.get(`todo/${sessionId}-agent-${sessionId}`, "json")
      if (!data) return new Response("Not Found", { status: 404, headers: corsHeaders() })
      return Response.json(data, { headers: corsHeaders() })
    }

    // Debug log stream — SSE, polls KV every 2s
    if (url.pathname === "/api/debug-stream") {
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const enc = new TextEncoder()
      const send = (data: unknown) => writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
      ;(async () => {
        try {
          const buf = await env.SESSIONS_KV.get("debug/buffer", "json") as { lines: string[]; target?: string } | null
          await send({ type: "init", lines: buf?.lines ?? [], target: buf?.target ?? null })
          let lastLen = buf?.lines?.length ?? 0
          const deadline = Date.now() + 88_000
          while (Date.now() < deadline && !request.signal.aborted) {
            await new Promise(r => setTimeout(r, 2000))
            const cur = await env.SESSIONS_KV.get("debug/buffer", "json") as { lines: string[]; target?: string } | null
            const curLines = cur?.lines ?? []
            if (curLines.length > lastLen) {
              await send({ type: "append", lines: curLines.slice(lastLen), target: cur?.target ?? null })
              lastLen = curLines.length
            } else if (curLines.length < lastLen) {
              // reset (new session)
              await send({ type: "init", lines: curLines, target: cur?.target ?? null })
              lastLen = curLines.length
            }
          }
        } catch { /* disconnect */ }
        finally { writer.close() }
      })()
      return new Response(readable, { headers: corsHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }) })
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
