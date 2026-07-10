import { describe, expect, it } from "vitest"
import worker from "../worker"

type Pairing = { id: string; userId: string; label: string; codeHash: string; expiresAt: string; claimed: boolean }
type Machine = { id: string; userId: string; label: string; tokenHash: string; created_at: string; last_seen_at: string | null }
type Command = { id: string; userId: string; machineId: string; type: string; payload: string }

function dbMock() {
  const pairings: Pairing[] = []
  const machines: Machine[] = []
  const commands: Command[] = []
  return {
    pairings,
    machines,
    commands,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith("insert into machine_pairings")) {
                pairings.push({ id: String(args[0]), userId: String(args[1]), label: String(args[2]), codeHash: String(args[3]), expiresAt: String(args[4]), claimed: false })
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith("update machine_pairings")) {
                const pairing = pairings.find(row => row.id === args[0] && !row.claimed && Date.parse(row.expiresAt) > Date.now())
                if (!pairing) return { meta: { changes: 0 } }
                pairing.claimed = true
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith("insert into machines")) {
                machines.push({ id: String(args[0]), userId: String(args[1]), label: String(args[2]), tokenHash: String(args[3]), created_at: new Date().toISOString(), last_seen_at: null })
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith("update machines set last_seen_at")) {
                const machine = machines.find(row => row.id === args[0])
                if (machine) machine.last_seen_at = new Date().toISOString()
                return { meta: { changes: machine ? 1 : 0 } }
              }
              if (sql.startsWith("insert into command_queue")) {
                commands.push({ id: String(args[0]), userId: String(args[1]), machineId: String(args[2]), type: String(args[3]), payload: String(args[4]) })
                return { meta: { changes: 1 } }
              }
              throw new Error(`Unhandled run: ${sql}`)
            },
            async first() {
              if (sql.includes("from machine_pairings")) {
                const pairing = pairings.find(row => row.codeHash === args[0] && !row.claimed && Date.parse(row.expiresAt) > Date.now())
                return pairing ? { id: pairing.id, userId: pairing.userId, label: pairing.label } : null
              }
              if (sql.includes("from machines where token_hash")) {
                const machine = machines.find(row => row.tokenHash === args[0])
                return machine ? { userId: machine.userId, machineId: machine.id } : null
              }
              if (sql.includes("from machines where id")) {
                const machine = machines.find(row => row.id === args[0] && row.userId === args[1])
                return machine ?? null
              }
              throw new Error(`Unhandled first: ${sql}`)
            },
            async all() {
              if (sql.includes("from machines where user_id")) {
                return { results: machines.filter(row => row.userId === args[0]) }
              }
              throw new Error(`Unhandled all: ${sql}`)
            },
          }
        },
      }
    },
  }
}

async function signedUser(secret: string): Promise<string> {
  const user = { sub: "user-1", email: "d@example.test", exp: Math.floor(Date.now() / 1000) + 3600 }
  const payload = Buffer.from(JSON.stringify(user)).toString("base64url")
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return `${payload}.${Buffer.from(signature).toString("base64url")}`
}

async function sha256(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex")
}

describe("worker cloud onboarding", () => {
  it("preserves the trusted macOS setup path through Google sign-in", async () => {
    const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", SESSION_SECRET: "session-secret" }
    const response = await worker.fetch(new Request("https://asv.test/api/auth/google/start?return=%2Fsetup%2Fmac"), env)
    expect(response.status).toBe(302)
    expect(response.headers.get("set-cookie")).toContain("asv_auth_return=%2Fsetup%2Fmac")

    const unsafe = await worker.fetch(new Request("https://asv.test/api/auth/google/start?return=%2F%2Fevil.example"), env)
    expect(unsafe.headers.get("set-cookie")).not.toContain("asv_auth_return")
  })

  it("pairs a signed-in website user with a native client using a one-time code", async () => {
    const db = dbMock()
    const secret = "test-session-secret"
    const env = { AUTH_DB: db, GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", SESSION_SECRET: secret }
    const auth = `Bearer ${await signedUser(secret)}`

    const create = await worker.fetch(new Request("https://asv.test/api/onboarding/pair", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "D's MacBook" }),
    }), env)
    expect(create.status).toBe(201)
    const pairing = await create.json() as { pairingCode: string; expiresAt: string }
    expect(pairing.pairingCode).toMatch(/^asv_pair_/)

    const claim = await worker.fetch(new Request("https://asv.test/api/cloud/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: pairing.pairingCode }),
    }), env)
    expect(claim.status).toBe(201)
    const claimed = await claim.json() as { machineId: string; token: string; cloudUrl: string }
    expect(claimed).toMatchObject({ cloudUrl: "https://asv.test" })
    expect(claimed.machineId).toMatch(/^m_/)
    expect(claimed.token).toMatch(/^asv_/)
    expect(db.machines[0].tokenHash).toBe(await sha256(claimed.token))

    const reused = await worker.fetch(new Request("https://asv.test/api/cloud/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: pairing.pairingCode }),
    }), env)
    expect(reused.status).toBe(404)
  })

  it("reports onboarding state and public macOS download metadata", async () => {
    const db = dbMock()
    const secret = "test-session-secret"
    const env = {
      AUTH_DB: db,
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      SESSION_SECRET: secret,
      MACOS_APP_DOWNLOAD_URL: "https://downloads.example.test/asv.dmg",
      MACOS_APP_VERSION: "1.2.3",
      MACOS_APP_SHA256: "abc123",
    }
    const response = await worker.fetch(new Request("https://asv.test/api/onboarding/status", {
      headers: { Authorization: `Bearer ${await signedUser(secret)}` },
    }), env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      state: "needs-app",
      machines: [],
      download: { available: true, platform: "macos", version: "1.2.3", sha256: "abc123" },
      pairing: { create: "/api/onboarding/pair", expiresInSeconds: 600 },
    })

    const download = await worker.fetch(new Request("https://asv.test/api/downloads/macos/latest"), env)
    expect(download.status).toBe(200)
    await expect(download.json()).resolves.toMatchObject({ available: true, url: "https://downloads.example.test/asv.dmg" })
  })

  it("rejects expired pairing codes", async () => {
    const db = dbMock()
    db.pairings.push({
      id: "pair_expired",
      userId: "user-1",
      label: "Old Mac",
      codeHash: await sha256("asv_pair_expired"),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      claimed: false,
    })
    const response = await worker.fetch(new Request("https://asv.test/api/cloud/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: "asv_pair_expired" }),
    }), { AUTH_DB: db })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "Pairing code is invalid or expired" })
    expect(db.machines).toHaveLength(0)
  })

  it("authenticates the daemon and omits message-less transcripts from cloud storage", async () => {
    const db = dbMock()
    const bucketObjects = new Map<string, unknown>()
    let objectWrites = 0
    const token = "asv_machine-token"
    db.machines.push({ id: "m_1", userId: "user-1", label: "Mac", tokenHash: await sha256(token), created_at: new Date().toISOString(), last_seen_at: null })
    const env = {
      AUTH_DB: db,
      SESSION_BUCKET: {
        async put(key: string, value: string) { objectWrites += 1; bucketObjects.set(key, JSON.parse(value)) },
        async get(key: string) {
          const value = bucketObjects.get(key)
          return value ? { async json() { return value } } : null
        },
      },
    }
    const status = await worker.fetch(new Request("https://asv.test/api/cloud/status", { headers: { Authorization: `Bearer ${token}` } }), env)
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toMatchObject({ ok: true, machine: { id: "m_1", connected: false } })

    const ingest = await worker.fetch(new Request("https://asv.test/api/cloud/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        projects: [{ path: "/repo", sessions: [{ id: "empty" }, { id: "real" }] }],
        sessions: [
          { projectPath: "/repo", sessionId: "empty", messages: [] },
          { projectPath: "/repo", sessionId: "real", messages: [{ role: "user", content: "hello" }] },
        ],
      }),
    }), env)
    expect(ingest.status).toBe(200)
    await expect(ingest.json()).resolves.toMatchObject({ projects: 1, sessions: 1, page: { offset: 0, limit: 30 }, changed: true, objectWrites: 2 })
    expect([...bucketObjects.keys()].filter(key => key.includes("/sessions/"))).toHaveLength(0)
    expect([...bucketObjects.keys()].filter(key => key.includes("/pages/"))).toEqual(["users/user-1/machines/m_1/pages/0.json"])
    expect(bucketObjects.get("users/user-1/machines/m_1/manifest.json")).toMatchObject({
      projects: [{ path: "/repo", sessions: [{ id: "real" }] }],
      pages: [{ offset: 0, limit: 30, key: "users/user-1/machines/m_1/pages/0.json" }],
    })

    const unchanged = await worker.fetch(new Request("https://asv.test/api/cloud/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        projects: [{ path: "/repo", sessions: [{ id: "real" }] }],
        sessions: [{ projectPath: "/repo", sessionId: "real", messages: [{ role: "user", content: "hello" }] }],
      }),
    }), env)
    await expect(unchanged.json()).resolves.toMatchObject({ changed: false, objectWrites: 0 })
    expect(objectWrites).toBe(2)
  })

  it("preserves older packed pages, reads sessions from them, and enqueues explicit load-more", async () => {
    const db = dbMock()
    const bucketObjects = new Map<string, unknown>()
    const token = "asv_machine-token"
    const secret = "test-session-secret"
    db.machines.push({ id: "m_1", userId: "user-1", label: "Mac", tokenHash: await sha256(token), created_at: new Date().toISOString(), last_seen_at: null })
    const env = {
      AUTH_DB: db,
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      SESSION_SECRET: secret,
      SESSION_BUCKET: {
        async put(key: string, value: string) { bucketObjects.set(key, JSON.parse(value)) },
        async get(key: string) {
          const value = bucketObjects.get(key)
          return value ? { async json() { return value } } : null
        },
      },
    }
    const ingestPage = (offset: number, id: string) => worker.fetch(new Request("https://asv.test/api/cloud/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        page: { offset, limit: 30 },
        projects: [{ path: "/repo", sessions: [{ id, lastActivityAt: `2026-07-${offset ? "01" : "10"}` }] }],
        sessions: [{ projectPath: "/repo", sessionId: id, messages: [{ role: "user", content: id }] }],
      }),
    }), env)

    expect((await ingestPage(0, "recent")).status).toBe(200)
    expect((await ingestPage(30, "older")).status).toBe(200)
    expect(bucketObjects.get("users/user-1/machines/m_1/manifest.json")).toMatchObject({
      projects: [{ path: "/repo", sessions: [{ id: "recent" }, { id: "older" }] }],
      pages: [{ offset: 0 }, { offset: 30 }],
    })

    const auth = `Bearer ${await signedUser(secret)}`
    const older = await worker.fetch(new Request("https://asv.test/api/session/%2Frepo/older", { headers: { Authorization: auth } }), env)
    expect(older.status).toBe(200)
    await expect(older.json()).resolves.toEqual([{ role: "user", content: "older" }])

    const loadMore = await worker.fetch(new Request("https://asv.test/api/sessions/load-more", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ offset: 60, limit: 100 }),
    }), env)
    expect(loadMore.status).toBe(202)
    await expect(loadMore.json()).resolves.toMatchObject({ queued: 1, page: { offset: 60, limit: 30 } })
    expect(db.commands).toMatchObject([{ userId: "user-1", machineId: "m_1", type: "sessions.load_more", payload: JSON.stringify({ offset: 60, limit: 30 }) }])
  })
})
