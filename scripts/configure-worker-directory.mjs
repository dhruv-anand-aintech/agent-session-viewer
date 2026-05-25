#!/usr/bin/env node
import { checkbox, confirm, input, select } from "@inquirer/prompts"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_PUBLIC_URL,
  discoverCloudflareWorkers,
  discoverWorkersDevSubdomain,
  discoverLocalWorkers,
  getWranglerAuth,
  mergeWorkers,
  readGeneratedConfig,
  writeGeneratedConfig,
} from "../lib/worker-directory-config.mjs"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const GENERATED_PATH = path.join(ROOT, "worker", "workers-directory.data.ts")

function readDotEnv() {
  const envPath = path.join(ROOT, ".env")
  if (!existsSync(envPath)) return {}
  return Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split("\n")
      .map((line) => line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, "")])
  )
}

function envValue(env, key) {
  return process.env[key] || env[key] || ""
}

async function discoverWorkers(source, env, workersDevSubdomain) {
  if (source === "local") return discoverLocalWorkers(ROOT, workersDevSubdomain)

  let accountId = envValue(env, "CLOUDFLARE_ACCOUNT_ID")
  const apiToken = envValue(env, "CLOUDFLARE_API_TOKEN") || envValue(env, "CF_API_TOKEN")

  let authToken = apiToken
  if (!accountId || !authToken) {
    try {
      const wranglerAuth = getWranglerAuth(ROOT)
      accountId ||= wranglerAuth.accountId
      authToken ||= wranglerAuth.oauthToken
    } catch {
      accountId ||= ""
      authToken ||= ""
    }
  }

  if (accountId && authToken) {
    const cloudflareWorkers = await discoverCloudflareWorkers({ accountId, apiToken: authToken, workersDevSubdomain })
    console.log(`Discovered ${cloudflareWorkers.length} Workers from Cloudflare.`)
    if (cloudflareWorkers.length > 0) return cloudflareWorkers
  }

  console.log("Cloudflare API discovery was unavailable; falling back to local wrangler*.toml files.")
  return discoverLocalWorkers(ROOT, workersDevSubdomain)
}

async function main() {
  const env = readDotEnv()
  const current = readGeneratedConfig(GENERATED_PATH)
  let workersDevSubdomainDefault = envValue(env, "WORKERS_DEV_SUBDOMAIN") || "dhruv-anand"

  try {
    const apiToken = envValue(env, "CLOUDFLARE_API_TOKEN") || envValue(env, "CF_API_TOKEN")
    const wranglerAuth = getWranglerAuth(ROOT)
    const accountId = envValue(env, "CLOUDFLARE_ACCOUNT_ID") || wranglerAuth.accountId
    const authToken = apiToken || wranglerAuth.oauthToken
    workersDevSubdomainDefault = await discoverWorkersDevSubdomain({ accountId, apiToken: authToken }) || workersDevSubdomainDefault
  } catch {
    workersDevSubdomainDefault = envValue(env, "WORKERS_DEV_SUBDOMAIN") || "dhruv-anand"
  }

  const workersDevSubdomain = await input({
    message: "workers.dev subdomain",
    default: workersDevSubdomainDefault,
  })

  const publicUrl = await input({
    message: "Directory public URL shown on the page",
    default: current.publicUrl || DEFAULT_PUBLIC_URL,
  })

  const source = await select({
    message: "Discover Workers from",
    choices: [
      { name: "Cloudflare account, then local fallback", value: "cloudflare" },
      { name: "Local wrangler*.toml files only", value: "local" },
    ],
    default: "cloudflare",
  })

  const discovered = await discoverWorkers(source, env, workersDevSubdomain)
  const merged = mergeWorkers(current.workers, discovered)

  if (merged.length === 0) {
    const shouldContinue = await confirm({
      message: "No Workers were discovered. Write an empty directory config?",
      default: false,
    })
    if (!shouldContinue) return
  }

  const selectedNames = await checkbox({
    message: "Choose Workers to show in the directory",
    choices: merged.map((worker) => ({
      name: `${worker.title} (${worker.name})${worker.url ? ` - ${worker.url}` : ""}`,
      value: worker.name,
      checked: worker.enabled,
    })),
    required: false,
    pageSize: 18,
  })
  const selected = new Set(selectedNames)

  const normalized = writeGeneratedConfig(GENERATED_PATH, {
    generatedAt: new Date().toISOString(),
    publicUrl,
    workers: merged.map((worker) => ({
      ...worker,
      enabled: selected.has(worker.name),
    })),
  })

  console.log(`Updated ${path.relative(ROOT, GENERATED_PATH)}`)
  console.log(`Selected ${normalized.workers.filter((worker) => worker.enabled).length} of ${normalized.workers.length} Workers`)
  console.log("Deploy with: npm run deploy:directory")
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err)
  process.exit(1)
})
