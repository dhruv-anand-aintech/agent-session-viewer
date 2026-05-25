import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse } from "smol-toml"

const DEFAULT_PUBLIC_URL = "https://dhruv-anand.workers.dev"

export function slugToTitle(name) {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function workersDevUrl(name, workersDevSubdomain) {
  if (!workersDevSubdomain) return ""
  return `https://${name}.${workersDevSubdomain}.workers.dev`
}

export function normalizeWorker(entry, defaults = {}) {
  const name = String(entry.name || "").trim()
  if (!name) throw new Error("Worker entry is missing a name")

  const url = String(entry.url || workersDevUrl(name, defaults.workersDevSubdomain) || "").trim()
  return {
    name,
    title: String(entry.title || slugToTitle(name)),
    url,
    description: String(entry.description || `Cloudflare Worker: ${name}`),
    source: entry.source || defaults.source || "manual",
    enabled: Boolean(entry.enabled),
    tags: Array.isArray(entry.tags) ? entry.tags.map(String).filter(Boolean) : [],
  }
}

export function mergeWorkers(existingWorkers, discoveredWorkers) {
  const existingByName = new Map(existingWorkers.map((worker) => [worker.name, worker]))
  const merged = []

  for (const discovered of discoveredWorkers) {
    const existing = existingByName.get(discovered.name)
    merged.push({
      ...discovered,
      ...existing,
      url: existing?.url || discovered.url,
      source: existing?.source || discovered.source,
      enabled: existing?.enabled ?? false,
      tags: existing?.tags?.length ? existing.tags : discovered.tags,
    })
    existingByName.delete(discovered.name)
  }

  return merged
    .concat([...existingByName.values()])
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function readGeneratedConfig(generatedPath) {
  if (!existsSync(generatedPath)) {
    return {
      generatedAt: "1970-01-01T00:00:00.000Z",
      publicUrl: DEFAULT_PUBLIC_URL,
      workers: [],
    }
  }

  const text = readFileSync(generatedPath, "utf8")
  const objectMatch = text.match(/export const directoryConfig: DirectoryConfig = (\{[\s\S]*\})\s*$/)
  if (!objectMatch) throw new Error(`Could not parse ${generatedPath}`)
  return JSON.parse(objectMatch[1])
}

export function writeGeneratedConfig(generatedPath, config) {
  const normalized = {
    generatedAt: config.generatedAt || new Date().toISOString(),
    publicUrl: config.publicUrl || DEFAULT_PUBLIC_URL,
    workers: config.workers.map((worker) => normalizeWorker(worker)),
  }
  const source = `export type DirectoryWorker = {
  name: string
  title: string
  url: string
  description: string
  source: "cloudflare" | "local" | "manual"
  enabled: boolean
  tags: string[]
}

export type DirectoryConfig = {
  generatedAt: string
  publicUrl: string
  workers: DirectoryWorker[]
}

export const directoryConfig: DirectoryConfig = ${JSON.stringify(normalized, null, 2)}
`
  writeFileSync(generatedPath, source, "utf8")
  return normalized
}

export function discoverLocalWorkers(searchRoot, workersDevSubdomain = "") {
  const configs = findWranglerConfigs(searchRoot)
  return configs.flatMap((configPath) => {
    const config = parse(readFileSync(configPath, "utf8"))
    const name = typeof config.name === "string" ? config.name : ""
    if (!name) return []

    const routes = Array.isArray(config.routes) ? config.routes : []
    const customDomain = routes.find((route) => route && route.custom_domain === true && typeof route.pattern === "string")
    const routePattern = customDomain?.pattern?.replace(/\/\*$/, "")
    const workersDevEnabled = config.workers_dev !== false

    const url = routePattern
      ? `https://${routePattern}`
      : workersDevEnabled
        ? workersDevUrl(name, workersDevSubdomain)
        : ""

    return [normalizeWorker({
      name,
      url,
      source: "local",
      tags: ["local-config"],
      description: `Discovered from ${path.relative(searchRoot, configPath)}`,
    })]
  })
}

export function findWranglerConfigs(searchRoot) {
  const results = []
  const ignored = new Set(["node_modules", ".git", "dist", ".tmp"])

  function visit(dir, depth) {
    if (depth > 4) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) visit(path.join(dir, entry.name), depth + 1)
        continue
      }
      if (/^wrangler(?:\.[\w-]+)?\.toml$/.test(entry.name)) {
        results.push(path.join(dir, entry.name))
      }
    }
  }

  visit(searchRoot, 0)
  return results.sort()
}

export function getAccountIdFromWhoami(cwd) {
  const output = execFileSync("npx", ["wrangler", "whoami", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  })
  const parsed = JSON.parse(output)
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
  return accounts[0]?.id || accounts[0]?.account_id || ""
}

export function getWranglerAuth(cwd) {
  const output = execFileSync("npx", ["wrangler", "whoami", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  })
  const parsed = JSON.parse(output)
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
  const accountId = accounts[0]?.id || accounts[0]?.account_id || ""
  const oauthToken = readWranglerOAuthToken()
  return { accountId, oauthToken }
}

export function readWranglerOAuthToken() {
  const candidates = [
    path.join(os.homedir(), ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const parsed = parse(readFileSync(candidate, "utf8"))
    if (typeof parsed.oauth_token === "string" && parsed.oauth_token) return parsed.oauth_token
    if (typeof parsed.api_token === "string" && parsed.api_token) return parsed.api_token
  }

  return ""
}

export async function discoverWorkersDevSubdomain({ accountId, apiToken, fetchImpl = fetch }) {
  if (!accountId || !apiToken) return ""

  const payload = await cloudflareApiJson({
    accountId,
    apiToken,
    pathName: "/workers/subdomain",
    fetchImpl,
  })
  return typeof payload?.result?.subdomain === "string" ? payload.result.subdomain : ""
}

export async function discoverCloudflareWorkers({ accountId, apiToken, workersDevSubdomain, fetchImpl = fetch }) {
  if (!accountId || !apiToken) return []

  const scriptsPayload = await cloudflareApiJson({
    accountId,
    apiToken,
    pathName: "/workers/scripts",
    fetchImpl,
  })
  const scripts = Array.isArray(scriptsPayload.result) ? scriptsPayload.result : []

  const domainsPayload = await cloudflareApiJson({
    accountId,
    apiToken,
    pathName: "/workers/domains",
    fetchImpl,
  })
  const domains = Array.isArray(domainsPayload.result) ? domainsPayload.result : []
  const domainsByService = new Map()

  for (const domain of domains) {
    if (!domain?.enabled || !domain.service || !domain.hostname) continue
    const existing = domainsByService.get(domain.service) || []
    existing.push(domain.hostname)
    domainsByService.set(domain.service, existing)
  }

  return scripts.map((script) => {
    const name = script.id || script.name
    const hostnames = domainsByService.get(name) || []
    const url = hostnames[0] ? `https://${hostnames[0]}` : workersDevUrl(name, workersDevSubdomain)
    const tags = ["cloudflare"].concat(hostnames.length > 0 ? ["custom-domain"] : ["workers.dev"])
    return normalizeWorker({
      name,
      url,
      source: "cloudflare",
      tags,
      description: script.modified_on ? `Modified ${script.modified_on}` : "Discovered from Cloudflare",
    })
  })
}

async function cloudflareApiJson({ accountId, apiToken, pathName, fetchImpl }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${pathName}`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  })
  if (!response.ok) {
    throw new Error(`Cloudflare API ${pathName} failed: ${response.status} ${await response.text()}`)
  }

  const payload = await response.json()
  if (payload.success === false) {
    throw new Error(`Cloudflare API ${pathName} failed: ${JSON.stringify(payload.errors || payload)}`)
  }
  return payload
}

export { DEFAULT_PUBLIC_URL }
