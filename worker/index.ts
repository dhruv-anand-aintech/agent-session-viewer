type Provider = {
  id: string
  label: string
  kind: "local-tunnel" | "worker-js" | "cloud-http"
  status: "available" | "missing"
  agents: string[]
  detail?: string
  endpoint?: string
}

type User = {
  sub: string
  email: string
  name?: string
  picture?: string
  exp?: number
}

type Env = {
  ASSETS?: { fetch: (request: Request) => Promise<Response> }
  AUTH_DB?: any
  SESSION_BUCKET?: any
  LOCAL_AGENT_BASE_URL?: string
  AGENT_PROVIDER_CONFIG?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Auth-Pin",
    },
  })
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } })
}

function configuredForGoogle(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET)
}

function b64url(bytes: Uint8Array): string {
  let raw = ""
  for (const byte of bytes) raw += String.fromCharCode(byte)
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function unb64url(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(value))
  return b64url(new Uint8Array(sig))
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function randomId(prefix = ""): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return `${prefix}${b64url(bytes)}`
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? ""
  for (const part of cookie.split(";")) {
    const [rawName, ...rest] = part.trim().split("=")
    if (rawName === name) return rest.join("=")
  }
  return null
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

async function signUser(user: User, secret: string): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify(user)))
  return `${payload}.${await hmac(payload, secret)}`
}

async function readUser(request: Request, env: Env): Promise<User | null> {
  if (!configuredForGoogle(env)) return null
  const signed = cookieValue(request, "asv_session")
  if (!signed) return null
  const [payload, sig] = signed.split(".")
  if (!payload || !sig) return null
  if (await hmac(payload, env.SESSION_SECRET!) !== sig) return null
  try {
    const user = JSON.parse(decoder.decode(unb64url(payload))) as User
    if (user.exp && user.exp < Math.floor(Date.now() / 1000)) return null
    return user
  } catch {
    return null
  }
}

async function requireUser(request: Request, env: Env): Promise<User | Response> {
  const user = await readUser(request, env)
  return user ?? json({ error: "Unauthorized" }, 401)
}

function originFrom(request: Request): string {
  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}

async function authStart(request: Request, env: Env): Promise<Response> {
  if (!configuredForGoogle(env)) return json({ error: "Google auth is not configured" }, 503)
  const state = randomId("st_")
  const redirectUri = `${originFrom(request)}/api/auth/google/callback`
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  })
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, {
    "Set-Cookie": cookie("asv_oauth_state", state, 600),
  })
}

async function authCallback(request: Request, env: Env): Promise<Response> {
  if (!configuredForGoogle(env)) return json({ error: "Google auth is not configured" }, 503)
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state || state !== cookieValue(request, "asv_oauth_state")) {
    return json({ error: "Invalid OAuth state" }, 400)
  }

  const redirectUri = `${originFrom(request)}/api/auth/google/callback`
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  })
  if (!tokenRes.ok) return json({ error: "Token exchange failed" }, 502)
  const token = await tokenRes.json() as { access_token?: string }
  if (!token.access_token) return json({ error: "Missing access token" }, 502)

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  })
  if (!infoRes.ok) return json({ error: "Userinfo lookup failed" }, 502)
  const info = await infoRes.json() as User
  const user: User = {
    sub: String(info.sub),
    email: String(info.email),
    name: info.name ? String(info.name) : undefined,
    picture: info.picture ? String(info.picture) : undefined,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
  }
  await env.AUTH_DB?.prepare(
    "insert into users (id, email, name, picture, updated_at) values (?, ?, ?, ?, datetime('now')) on conflict(id) do update set email = excluded.email, name = excluded.name, picture = excluded.picture, updated_at = datetime('now')",
  ).bind(user.sub, user.email, user.name ?? null, user.picture ?? null).run()
  return redirect("/sessions", {
    "Set-Cookie": [
      cookie("asv_session", await signUser(user, env.SESSION_SECRET!), 60 * 60 * 24 * 14),
      cookie("asv_oauth_state", "", 0),
    ].join(", "),
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
    "This provider cannot run local CLIs. Choose Local agl tunnel, GCP runner, or another cloud HTTP provider for coding-agent execution.",
    body.prompt ? `\nLatest message: ${body.prompt}` : "",
  ].join("\n")
  return json({ ok: true, provider: "worker-js", agent: "worker-js", text })
}

function encodedProject(projectPath: string): string {
  return encodeURIComponent(projectPath).replace(/%/g, "~")
}

function sessionKey(userId: string, machineId: string, projectPath: string, sessionId: string): string {
  return `users/${userId}/machines/${machineId}/sessions/${encodedProject(projectPath)}/${encodeURIComponent(sessionId)}.json`
}

function manifestKey(userId: string, machineId: string): string {
  return `users/${userId}/machines/${machineId}/manifest.json`
}

async function machineFromToken(request: Request, env: Env): Promise<{ userId: string; machineId: string } | Response> {
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : ""
  if (!token || !env.AUTH_DB) return json({ error: "Missing machine token" }, 401)
  const hash = await sha256Hex(token)
  const row = await env.AUTH_DB.prepare(
    "select user_id as userId, id as machineId from machines where token_hash = ? and revoked_at is null",
  ).bind(hash).first()
  return row ? { userId: String(row.userId), machineId: String(row.machineId) } : json({ error: "Invalid machine token" }, 401)
}

async function listMachines(user: User, env: Env): Promise<Array<{ id: string; label: string; created_at?: string; last_seen_at?: string }>> {
  if (!env.AUTH_DB) return []
  const rows = await env.AUTH_DB.prepare(
    "select id, label, created_at, last_seen_at from machines where user_id = ? and revoked_at is null order by created_at desc",
  ).bind(user.sub).all()
  return rows.results ?? []
}

async function loadProjects(user: User, env: Env): Promise<unknown[]> {
  if (!env.SESSION_BUCKET) return []
  const machines = await listMachines(user, env)
  const byPath = new Map<string, any>()
  for (const machine of machines) {
    const object = await env.SESSION_BUCKET.get(manifestKey(user.sub, machine.id))
    if (!object) continue
    const manifest = await object.json().catch(() => null) as { projects?: any[] } | null
    for (const project of manifest?.projects ?? []) {
      const existing = byPath.get(project.path)
      byPath.set(project.path, existing
        ? { ...existing, sessions: [...(existing.sessions ?? []), ...(project.sessions ?? [])] }
        : project)
    }
  }
  return [...byPath.values()]
}

async function streamProjects(user: User, env: Env): Promise<Response> {
  const projects = await loadProjects(user, env)
  const body = [
    `event: projects_meta\ndata: ${JSON.stringify({ total: projects.reduce((sum, p: any) => sum + (p.sessions?.length ?? 0), 0) })}\n`,
    `event: projects\ndata: ${JSON.stringify(projects)}\n`,
    "event: done\ndata: {}\n",
    "",
  ].join("\n")
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

async function readSession(user: User, env: Env, projectPath: string, sessionId: string): Promise<Response> {
  if (!env.SESSION_BUCKET) return json({ error: "SESSION_BUCKET is not configured" }, 503)
  for (const machine of await listMachines(user, env)) {
    const object = await env.SESSION_BUCKET.get(sessionKey(user.sub, machine.id, projectPath, sessionId))
    if (!object) continue
    const data = await object.json().catch(() => null) as { messages?: unknown[]; total?: number } | null
    if (!data) continue
    return new Response(JSON.stringify(data.messages ?? []), {
      headers: { "Content-Type": "application/json", "X-Message-Total": String(data.total ?? data.messages?.length ?? 0) },
    })
  }
  return json({ error: "Session not found" }, 404)
}

async function registerMachine(request: Request, env: Env, user: User): Promise<Response> {
  if (!env.AUTH_DB) return json({ error: "AUTH_DB is not configured" }, 503)
  const body = await request.json().catch(() => ({})) as { label?: string }
  const machineId = randomId("m_")
  const token = randomId("asv_")
  await env.AUTH_DB.prepare(
    "insert into machines (id, user_id, label, token_hash, created_at) values (?, ?, ?, ?, datetime('now'))",
  ).bind(machineId, user.sub, body.label || "local machine", await sha256Hex(token)).run()
  return json({ machineId, token })
}

async function ingest(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_BUCKET || !env.AUTH_DB) return json({ error: "SESSION_BUCKET and AUTH_DB are required" }, 503)
  const machine = await machineFromToken(request, env)
  if (machine instanceof Response) return machine
  const body = await request.json().catch(() => ({})) as { projects?: unknown[]; sessions?: Array<{ projectPath: string; sessionId: string; messages: unknown[]; total?: number }> }
  const projects = Array.isArray(body.projects) ? body.projects : []
  const sessions = Array.isArray(body.sessions) ? body.sessions : []
  await env.SESSION_BUCKET.put(manifestKey(machine.userId, machine.machineId), JSON.stringify({ projects, updatedAt: new Date().toISOString() }), {
    httpMetadata: { contentType: "application/json" },
  })
  for (const session of sessions) {
    if (!session.projectPath || !session.sessionId || !Array.isArray(session.messages)) continue
    await env.SESSION_BUCKET.put(
      sessionKey(machine.userId, machine.machineId, session.projectPath, session.sessionId),
      JSON.stringify({ messages: session.messages, total: session.total ?? session.messages.length, updatedAt: new Date().toISOString() }),
      { httpMetadata: { contentType: "application/json" } },
    )
  }
  await env.AUTH_DB.prepare("update machines set last_seen_at = datetime('now') where id = ?").bind(machine.machineId).run()
  return json({ ok: true, projects: projects.length, sessions: sessions.length })
}

async function pollCommands(request: Request, env: Env): Promise<Response> {
  if (!env.AUTH_DB) return json({ error: "AUTH_DB is not configured" }, 503)
  const machine = await machineFromToken(request, env)
  if (machine instanceof Response) return machine
  const rows = await env.AUTH_DB.prepare(
    "select id, type, payload, created_at from command_queue where machine_id = ? and delivered_at is null order by created_at asc limit 20",
  ).bind(machine.machineId).all()
  const commands = (rows.results ?? []).map((row: any) => ({ ...row, payload: JSON.parse(row.payload || "{}") }))
  if (commands.length) {
    const ids = commands.map((command: any) => command.id)
    await env.AUTH_DB.prepare(`update command_queue set delivered_at = datetime('now') where id in (${ids.map(() => "?").join(",")})`).bind(...ids).run()
  }
  return json({ commands })
}

async function enqueueCommand(request: Request, env: Env, user: User, machineId: string): Promise<Response> {
  if (!env.AUTH_DB) return json({ error: "AUTH_DB is not configured" }, 503)
  const body = await request.json().catch(() => ({}))
  const machine = await env.AUTH_DB.prepare("select id from machines where id = ? and user_id = ? and revoked_at is null").bind(machineId, user.sub).first()
  if (!machine) return json({ error: "Machine not found" }, 404)
  const id = randomId("cmd_")
  await env.AUTH_DB.prepare(
    "insert into command_queue (id, user_id, machine_id, type, payload, created_at) values (?, ?, ?, ?, ?, datetime('now'))",
  ).bind(id, user.sub, machineId, String(body.type ?? "agent.chat"), JSON.stringify(body.payload ?? body)).run()
  return json({ id })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return json({}, 204)

    const url = new URL(request.url)
    if (url.pathname === "/api/capabilities") {
      const user = await readUser(request, env)
      return json({
        openPath: false,
        debugStream: false,
        pinRequired: configuredForGoogle(env),
        authProvider: configuredForGoogle(env) ? "google" : "none",
        authed: configuredForGoogle(env) ? !!user : true,
        user,
      })
    }
    if (url.pathname === "/api/auth/google/start") return authStart(request, env)
    if (url.pathname === "/api/auth/google/callback") return authCallback(request, env)
    if (url.pathname === "/api/auth/logout") return redirect("/", { "Set-Cookie": cookie("asv_session", "", 0) })
    if (url.pathname === "/api/auth/me") return json({ user: await readUser(request, env) })
    if (url.pathname === "/api/cloud/ingest" && request.method === "POST") return ingest(request, env)
    if (url.pathname === "/api/cloud/poll" && request.method === "GET") return pollCommands(request, env)

    const protectedPaths = ["/api/projects", "/api/stream", "/api/machines"]
    const needsUser = protectedPaths.some(path => url.pathname === path || url.pathname.startsWith(`${path}/`)) || url.pathname.startsWith("/api/session/")
    const userOrResponse = needsUser ? await requireUser(request, env) : null
    if (userOrResponse instanceof Response) return userOrResponse
    const user = userOrResponse as User | null

    if (url.pathname === "/api/projects" && request.method === "GET") return json(await loadProjects(user!, env))
    if (url.pathname === "/api/stream" && request.method === "GET") return streamProjects(user!, env)
    if (url.pathname === "/api/machines" && request.method === "GET") return json({ machines: await listMachines(user!, env) })
    if (url.pathname === "/api/machines" && request.method === "POST") return registerMachine(request, env, user!)

    const commandMatch = url.pathname.match(/^\/api\/machines\/([^/]+)\/commands$/)
    if (commandMatch && request.method === "POST") return enqueueCommand(request, env, user!, decodeURIComponent(commandMatch[1]))

    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/)
    if (sessionMatch) return readSession(user!, env, decodeURIComponent(sessionMatch[1]), decodeURIComponent(sessionMatch[2]))

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
      return json({ ok: true, runtime: "cloudflare-worker", auth: configuredForGoogle(env) ? "google" : "none" })
    }

    if (env.ASSETS) return env.ASSETS.fetch(request)
    return new Response("Agent Session Viewer Worker is running.", { headers: { "Content-Type": "text/plain" } })
  },
}
