#!/usr/bin/env node
/**
 * Minimal HTTP runner for AGL-backed coding agents.
 *
 * Intended for small cloud VMs or private local runner hosts. Keep this process
 * behind a firewall or tunnel and set ASV_RUNNER_TOKEN.
 */

import http from "http"
import { getAgentProviders, runLocalAglChat } from "../lib/agent-chat-core.mjs"

const host = process.env.ASV_RUNNER_HOST ?? "127.0.0.1"
const port = Number.parseInt(process.env.ASV_RUNNER_PORT ?? "3002", 10)
const token = process.env.ASV_RUNNER_TOKEN ?? ""

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  })
  res.end(JSON.stringify(data))
}

function authorized(req) {
  if (!token) return true
  const header = req.headers.authorization ?? ""
  return header === `Bearer ${token}`
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text.trim()) return {}
  return JSON.parse(text)
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, {})
      return
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`)

    if (url.pathname === "/api/health") {
      sendJson(res, {
        ok: true,
        runner: "asv-agent-runner",
        providers: getAgentProviders().providers,
        tokenRequired: !!token,
      })
      return
    }

    if (!authorized(req)) {
      sendJson(res, { ok: false, error: "Unauthorized" }, 401)
      return
    }

    if (url.pathname === "/api/agent/providers" && req.method === "GET") {
      sendJson(res, getAgentProviders())
      return
    }

    if (url.pathname === "/api/agent/chat" && req.method === "POST") {
      const body = await readJson(req)
      const result = await runLocalAglChat({ ...body, provider: "local" })
      sendJson(res, result, result.ok ? 200 : 500)
      return
    }

    sendJson(res, { ok: false, error: "Not found" }, 404)
  } catch (err) {
    sendJson(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

server.listen(port, host, () => {
  console.log(`[asv-agent-runner] listening on http://${host}:${port}`)
})
