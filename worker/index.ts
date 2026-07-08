type Provider = {
  id: string
  label: string
  kind: "local-tunnel" | "worker-js" | "cloud-http"
  status: "available" | "missing"
  agents: string[]
  detail?: string
  endpoint?: string
  authToken?: string
}

type ModelOption = {
  value: string
  label: string
  model?: string
  modelClass?: "fast" | "pro"
  noModel?: boolean
  useExtraModelArg?: boolean
}

const OPENCODE_MODELS = [
  "opencode/big-pickle",
  "opencode/claude-fable-5",
  "opencode/claude-haiku-4-5",
  "opencode/claude-opus-4-1",
  "opencode/claude-opus-4-5",
  "opencode/claude-opus-4-6",
  "opencode/claude-opus-4-7",
  "opencode/claude-opus-4-8",
  "opencode/claude-sonnet-4",
  "opencode/claude-sonnet-4-5",
  "opencode/claude-sonnet-4-6",
  "opencode/claude-sonnet-5",
  "opencode/deepseek-v4-flash",
  "opencode/deepseek-v4-pro",
  "opencode/gemini-3-flash",
  "opencode/gemini-3.1-pro",
  "opencode/gemini-3.5-flash",
  "opencode/glm-5",
  "opencode/glm-5.1",
  "opencode/glm-5.2",
  "opencode/gpt-5",
  "opencode/gpt-5-codex",
  "opencode/gpt-5.1",
  "opencode/gpt-5.1-codex",
  "opencode/gpt-5.2",
  "opencode/gpt-5.3-codex",
  "opencode/gpt-5.4",
  "opencode/gpt-5.4-mini",
  "opencode/gpt-5.5",
  "opencode/kimi-k2.6",
  "opencode/kimi-k2.7-code",
  "opencode/minimax-m3",
  "opencode/qwen3.6-plus",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/kimi-k2.6",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m3",
  "opencode-go/qwen3.6-plus",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "mistral/codestral-latest",
  "mistral/mistral-large-latest",
  "mistral/mistral-medium-latest",
  "mistral/mistral-small-latest",
]

function modelClassForModel(model: string): "fast" | "pro" {
  return /flash|haiku|mini|nano|lite|fast|free|small/i.test(model) ? "fast" : "pro"
}

function modelLabel(model: string): string {
  return model
    .replace(/^opencode-go\//, "OpenCode Go / ")
    .replace(/^opencode\//, "OpenCode / ")
    .replace(/^google\//, "Google / ")
    .replace(/^mistral\//, "Mistral / ")
}

function modelOptions(models: string[], extra: Partial<ModelOption> = {}): ModelOption[] {
  return models.map(model => ({
    value: model,
    label: modelLabel(model),
    model,
    modelClass: modelClassForModel(model),
    ...extra,
  }))
}

const MODEL_OPTIONS_BY_AGENT: Record<string, ModelOption[]> = {
  random: [
    { value: "pro", label: "Auto pro", modelClass: "pro" },
    { value: "fast", label: "Auto fast", modelClass: "fast" },
  ],
  codex: modelOptions(["gpt-5.5", "gpt-5.4-mini", "gpt-5.1-codex", "gpt-5-codex"]),
  claude: modelOptions(["sonnet", "haiku", "opus"]),
  cursor: modelOptions(["composer-2.5-fast"]),
  gemini: modelOptions(["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash"]),
  opencode: modelOptions(OPENCODE_MODELS),
  pi: modelOptions(OPENCODE_MODELS),
  pier: modelOptions(["pier-hybrid", "sarvam-30b"]),
  droid: modelOptions(["claude-opus-4-8", "claude-opus-4-8-fast"]),
  antigravity: modelOptions([
    "Gemini 3.5 Flash (Medium)",
    "Gemini 3.5 Flash (High)",
    "Gemini 3.5 Flash (Low)",
    "Gemini 3.1 Pro (Low)",
    "Gemini 3.1 Pro (High)",
    "Claude Sonnet 4.6 (Thinking)",
    "Claude Opus 4.6 (Thinking)",
    "GPT-OSS 120B (Medium)",
  ], { useExtraModelArg: true }),
  amp: [{ value: "default", label: "Default", noModel: true, modelClass: "pro" }],
  "worker-js": [{ value: "default", label: "Worker JS", noModel: true, modelClass: "pro" }],
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
  GCS_BUCKET?: string
  GCP_SERVICE_ACCOUNT_EMAIL?: string
  GCP_PRIVATE_KEY?: string
  LOCAL_AGENT_BASE_URL?: string
  AGENT_PROVIDER_CONFIG?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET?: string
  BUILD_COMMIT?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
let gcsTokenCache: { token: string; exp: number } | null = null

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

function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location })
  for (const value of cookies) headers.append("Set-Cookie", value)
  return new Response(null, { status: 302, headers })
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

function pemToBytes(pem: string): Uint8Array {
  const clean = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "")
  return unb64url(clean.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""))
}

async function rsaSign(value: string, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(value))
  return b64url(new Uint8Array(signature))
}

async function gcsAccessToken(env: Env): Promise<string> {
  if (!env.GCP_SERVICE_ACCOUNT_EMAIL || !env.GCP_PRIVATE_KEY) throw new Error("GCP service account secrets are not configured")
  const now = Math.floor(Date.now() / 1000)
  if (gcsTokenCache && gcsTokenCache.exp - 60 > now) return gcsTokenCache.token
  const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
  const claim = b64url(encoder.encode(JSON.stringify({
    iss: env.GCP_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/devstorage.read_write",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })))
  const unsigned = `${header}.${claim}`
  const assertion = `${unsigned}.${await rsaSign(unsigned, env.GCP_PRIVATE_KEY)}`
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })
  if (!tokenRes.ok) throw new Error(`GCS token exchange failed: ${tokenRes.status}`)
  const token = await tokenRes.json() as { access_token: string; expires_in?: number }
  gcsTokenCache = { token: token.access_token, exp: now + (token.expires_in ?? 3600) }
  return gcsTokenCache.token
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

async function readSignedUser(signed: string | null, env: Env): Promise<User | null> {
  if (!signed || !env.SESSION_SECRET) return null
  const [payload, sig] = signed.split(".")
  if (!payload || !sig) return null
  if (await hmac(payload, env.SESSION_SECRET) !== sig) return null
  try {
    const user = JSON.parse(decoder.decode(unb64url(payload))) as User
    if (user.exp && user.exp < Math.floor(Date.now() / 1000)) return null
    return user
  } catch {
    return null
  }
}

async function readUser(request: Request, env: Env): Promise<User | null> {
  if (!configuredForGoogle(env)) return null
  const auth = request.headers.get("Authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null
  return await readSignedUser(bearer, env) ?? await readSignedUser(cookieValue(request, "asv_session"), env)
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
  const url = new URL(request.url)
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
  const cookies = [cookie("asv_oauth_state", state, 600)]
  const mobileReturn = url.searchParams.get("mobile") === "1" ? url.searchParams.get("return") : null
  if (mobileReturn?.startsWith("asv://auth")) cookies.push(cookie("asv_mobile_return", encodeURIComponent(mobileReturn), 600))
  return redirectWithCookies(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, cookies)
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
  const signedUser = await signUser(user, env.SESSION_SECRET!)
  const mobileReturn = cookieValue(request, "asv_mobile_return")
  if (mobileReturn) {
    const decodedReturn = decodeURIComponent(mobileReturn)
    if (decodedReturn.startsWith("asv://auth")) {
      return redirectWithCookies(`/mobile-auth#token=${encodeURIComponent(signedUser)}&email=${encodeURIComponent(user.email)}`, [
        cookie("asv_session", signedUser, 60 * 60 * 24 * 14),
        cookie("asv_oauth_state", "", 0),
        cookie("asv_mobile_return", "", 0),
      ])
    }
  }
  return redirectWithCookies("/sessions", [
    cookie("asv_session", signedUser, 60 * 60 * 24 * 14),
    cookie("asv_oauth_state", "", 0),
    cookie("asv_mobile_return", "", 0),
  ])
}

async function mobileAuthFinish(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const token = url.searchParams.get("token")
  const user = await readSignedUser(token, env)
  if (!user || !token) return json({ error: "Invalid mobile auth token" }, 401)
  return redirectWithCookies("/sessions", [
    cookie("asv_session", token, 60 * 60 * 24 * 14),
  ])
}

function mobileAuthHandoff(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Open Agent Session Viewer</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f7f7f4;color:#1f2426}
    main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    section{max-width:420px;background:#fff;border:1px solid #deded8;border-radius:8px;padding:24px}
    h1{font-size:24px;margin:0 0 8px}
    p{color:#687174;line-height:1.45}
    a{display:inline-flex;align-items:center;justify-content:center;border-radius:8px;background:#207a62;color:white;text-decoration:none;font-weight:700;padding:14px 18px;margin-top:12px}
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Open Agent Session Viewer</h1>
      <p>Authentication is complete. Return to the app to load your cloud sessions.</p>
      <a id="open-app" href="asv://auth">Open app</a>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
    const token = params.get("token") || "";
    const email = params.get("email") || "";
    const appUrl = "asv://auth#token=" + encodeURIComponent(token) + (email ? "&email=" + encodeURIComponent(email) : "");
    const link = document.getElementById("open-app");
    if (token) {
      link.href = appUrl;
      setTimeout(() => { location.href = appUrl; }, 250);
    } else {
      link.textContent = "Start again";
      link.href = "/api/auth/google/start?mobile=1&return=asv%3A%2F%2Fauth";
    }
  </script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
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
        authToken: provider.authToken ? String(provider.authToken) : undefined,
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

function publicProvider(provider: Provider): Provider {
  const { endpoint, authToken, ...safe } = provider
  void endpoint
  void authToken
  return safe
}

async function proxyChat(provider: Provider, request: Request): Promise<Response> {
  if (!provider.endpoint) return json({ ok: false, error: `Provider is not configured: ${provider.id}` }, 400)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (provider.authToken) headers.Authorization = `Bearer ${provider.authToken}`
  const upstream = await fetch(provider.endpoint, {
    method: "POST",
    headers,
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

async function putObjectJson(env: Env, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  if (env.GCS_BUCKET) {
    const token = await gcsAccessToken(env)
    const params = new URLSearchParams({ uploadType: "media", name: key })
    const res = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(env.GCS_BUCKET)}/o?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: text,
    })
    if (!res.ok) throw new Error(`GCS put failed: ${res.status} ${await res.text()}`)
    return
  }
  if (env.SESSION_BUCKET) {
    await env.SESSION_BUCKET.put(key, text, { httpMetadata: { contentType: "application/json" } })
    return
  }
  throw new Error("No transcript object store configured")
}

async function getObjectJson<T>(env: Env, key: string): Promise<T | null> {
  if (env.GCS_BUCKET) {
    const token = await gcsAccessToken(env)
    const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(env.GCS_BUCKET)}/o/${encodeURIComponent(key)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GCS get failed: ${res.status} ${await res.text()}`)
    return await res.json() as T
  }
  if (env.SESSION_BUCKET) {
    const object = await env.SESSION_BUCKET.get(key)
    if (!object) return null
    return await object.json().catch(() => null) as T | null
  }
  return null
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
  const machines = await listMachines(user, env)
  const byPath = new Map<string, any>()
  for (const machine of machines) {
    const manifest = await getObjectJson<{ projects?: any[] }>(env, manifestKey(user.sub, machine.id)).catch(() => null)
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
  for (const machine of await listMachines(user, env)) {
    const data = await getObjectJson<{ messages?: unknown[]; total?: number }>(env, sessionKey(user.sub, machine.id, projectPath, sessionId)).catch(() => null)
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
  if (!env.AUTH_DB) return json({ error: "AUTH_DB is required" }, 503)
  const machine = await machineFromToken(request, env)
  if (machine instanceof Response) return machine
  const body = await request.json().catch(() => ({})) as { projects?: unknown[]; sessions?: Array<{ projectPath: string; sessionId: string; messages: unknown[]; total?: number }> }
  const projects = Array.isArray(body.projects) ? body.projects : []
  const sessions = Array.isArray(body.sessions) ? body.sessions : []
  await putObjectJson(env, manifestKey(machine.userId, machine.machineId), { projects, updatedAt: new Date().toISOString() })
  for (const session of sessions) {
    if (!session.projectPath || !session.sessionId || !Array.isArray(session.messages)) continue
    await putObjectJson(
      env,
      sessionKey(machine.userId, machine.machineId, session.projectPath, session.sessionId),
      { messages: session.messages, total: session.total ?? session.messages.length, updatedAt: new Date().toISOString() },
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

async function serveMobileUpdateManifest(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return json({ error: "ASSETS is not configured" }, 503)
  const requestPlatform = request.headers.get("Expo-Platform")?.toLowerCase()
  const requestRuntime = request.headers.get("Expo-Runtime-Version")
  const origin = originFrom(request)
  const stagedRes = await env.ASSETS.fetch(new Request(`${origin}/mobile-updates/latest/asv-manifest.json`))
  if (!stagedRes.ok) return json({ error: "Mobile update is not staged" }, 404)
  const staged = await stagedRes.json() as {
    id: string
    createdAt: string
    runtimeVersion: string
    commit?: string
    launchAsset: { key: string; hash?: string; contentType: string; fileExtension?: string; path: string }
    assets?: Array<{ key: string; hash?: string; contentType: string; fileExtension?: string; path: string }>
  }
  const headers = {
    "Content-Type": "application/expo+json",
    "Expo-Protocol-Version": "1",
    "Expo-SFV-Version": "0",
    "Cache-Control": "private, max-age=0, no-cache",
  }
  if (requestPlatform && requestPlatform !== "android") return new Response(null, { status: 204, headers })
  if (requestRuntime && requestRuntime !== staged.runtimeVersion) return new Response(null, { status: 204, headers })
  const assetUrl = (asset: { path: string }) => `${origin}${asset.path}`
  return new Response(JSON.stringify({
    id: staged.id,
    createdAt: staged.createdAt,
    runtimeVersion: staged.runtimeVersion,
    launchAsset: {
      key: staged.launchAsset.key,
      hash: staged.launchAsset.hash,
      contentType: staged.launchAsset.contentType,
      fileExtension: staged.launchAsset.fileExtension,
      url: assetUrl(staged.launchAsset),
    },
    assets: (staged.assets ?? []).map(asset => ({
      key: asset.key,
      hash: asset.hash,
      contentType: asset.contentType,
      fileExtension: asset.fileExtension,
      url: assetUrl(asset),
    })),
    metadata: { commit: staged.commit ?? "" },
    extra: {
      scopeKey: "tech.ainorthstar.agent_session_viewer",
      expoClient: {
        name: "Agent Session Viewer",
        slug: "agent-session-viewer-mobile",
        version: "0.1.0",
        android: { package: "tech.ainorthstar.agent_session_viewer" },
      },
    },
  }), { headers })
}

async function serveAssets(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) return new Response("Agent Session Viewer Worker is running.", { headers: { "Content-Type": "text/plain" } })
  const response = await env.ASSETS.fetch(request)
  const url = new URL(request.url)
  if (response.status !== 404 || request.method !== "GET" || url.pathname.startsWith("/api/")) return response
  return env.ASSETS.fetch(new Request(`${url.origin}/`, request))
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
    if (url.pathname === "/api/auth/mobile/finish") return mobileAuthFinish(request, env)
    if (url.pathname === "/mobile-auth") return mobileAuthHandoff()
    if (url.pathname === "/api/auth/logout") return redirect("/", { "Set-Cookie": cookie("asv_session", "", 0) })
    if (url.pathname === "/api/auth/me") return json({ user: await readUser(request, env) })
    if (url.pathname === "/mobile-updates/manifest" && request.method === "GET") return serveMobileUpdateManifest(request, env)
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
        providers: list.map(publicProvider),
        defaults: {
          provider: list.find(provider => provider.id === "local" && provider.status === "available") ? "local" : "worker-js",
          agent: "random",
          mode: "ask",
          modelClass: "pro",
          model: "",
        },
        modelOptionsByAgent: MODEL_OPTIONS_BY_AGENT,
      })
    }

    if (url.pathname === "/api/agent/chat" && request.method === "POST") {
      const body = await request.clone().json().catch(() => ({})) as { provider?: string }
      const providerId = body.provider ?? "local"
      if (providerId === "worker-js") return workerJsChat(request)

      const provider = providers(env).find(entry => entry.id === providerId)
      if (!provider?.endpoint) return json({ ok: false, error: `Provider is not configured: ${providerId}` }, 400)

      try {
        return await proxyChat(provider, request)
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502)
      }
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        runtime: "cloudflare-worker",
        auth: configuredForGoogle(env) ? "google" : "none",
        commit: env.BUILD_COMMIT ?? "unknown",
      })
    }

    return serveAssets(request, env)
  },
}
