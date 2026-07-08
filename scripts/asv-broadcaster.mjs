#!/usr/bin/env node
/**
 * Push local Agent Session Viewer data to the cloud Worker.
 *
 * Required env:
 *   ASV_CLOUD_URL=https://agent-session-viewer.ainorthstar.tech
 *   ASV_MACHINE_TOKEN=asv_...
 *
 * Optional env:
 *   ASV_LOCAL_URL=http://127.0.0.1:3001
 *   ASV_MAX_SESSIONS=80
 *   ASV_SESSION_TAIL=200
 */

const cloudUrl = (process.env.ASV_CLOUD_URL ?? "").replace(/\/$/, "")
const localUrl = (process.env.ASV_LOCAL_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "")
const token = process.env.ASV_MACHINE_TOKEN ?? ""
const maxSessions = Number.parseInt(process.env.ASV_MAX_SESSIONS ?? "80", 10)
const sessionTail = Number.parseInt(process.env.ASV_SESSION_TAIL ?? "200", 10)
const watch = process.argv.includes("--watch")
const intervalMs = Number.parseInt(process.env.ASV_BROADCAST_INTERVAL_MS ?? "60000", 10)

if (!cloudUrl || !token) {
  console.error("Set ASV_CLOUD_URL and ASV_MACHINE_TOKEN before running the broadcaster.")
  process.exit(2)
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
  return response.json()
}

async function readLocalSnapshot() {
  const projects = await jsonFetch(`${localUrl}/api/projects?maxSessions=${maxSessions}`)
  const sessions = []
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      const sessionId = encodeURIComponent(session.id)
      const projectPath = encodeURIComponent(session.projectPath ?? project.path)
      const response = await fetch(`${localUrl}/api/session/${projectPath}/${sessionId}?tail=${sessionTail}`, { credentials: "include" })
      if (!response.ok) continue
      const messages = await response.json()
      const total = Number.parseInt(response.headers.get("X-Message-Total") ?? "", 10) || messages.length
      sessions.push({ projectPath: session.projectPath ?? project.path, sessionId: session.id, messages, total })
    }
  }
  return { projects, sessions }
}

async function pollCommands() {
  const data = await jsonFetch(`${cloudUrl}/api/cloud/poll`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  for (const command of data.commands ?? []) {
    console.log(`[command] ${command.id} ${command.type}`, JSON.stringify(command.payload ?? {}))
  }
}

async function runOnce() {
  const snapshot = await readLocalSnapshot()
  const result = await jsonFetch(`${cloudUrl}/api/cloud/ingest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(snapshot),
  })
  await pollCommands().catch(err => console.warn(`[poll] ${err.message}`))
  console.log(`[broadcast] projects=${result.projects} sessions=${result.sessions} at=${new Date().toISOString()}`)
}

await runOnce()
if (watch) {
  setInterval(() => {
    runOnce().catch(err => console.error(`[broadcast] ${err.stack || err.message}`))
  }, Math.max(10_000, intervalMs))
}
