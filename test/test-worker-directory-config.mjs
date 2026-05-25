import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  discoverCloudflareWorkers,
  discoverWorkersDevSubdomain,
  discoverLocalWorkers,
  mergeWorkers,
  readGeneratedConfig,
  slugToTitle,
  workersDevUrl,
  writeGeneratedConfig,
} from "../lib/worker-directory-config.mjs"

const root = mkdtempSync(path.join(tmpdir(), "worker-directory-"))
writeFileSync(path.join(root, "wrangler.toml"), [
  'name = "alpha-worker"',
  'main = "worker/index.ts"',
  "workers_dev = true",
].join("\n"))
mkdirSync(path.join(root, "nested"))
writeFileSync(path.join(root, "nested", "wrangler.beta.toml"), [
  'name = "beta-api"',
  'main = "src/index.ts"',
  "",
  "[[routes]]",
  'pattern = "beta.example.com"',
  "custom_domain = true",
].join("\n"))

assert.equal(slugToTitle("alpha-worker"), "Alpha Worker")
assert.equal(workersDevUrl("alpha-worker", "dhruv-anand"), "https://alpha-worker.dhruv-anand.workers.dev")

const localWorkers = discoverLocalWorkers(root, "dhruv-anand")
assert.equal(localWorkers.length, 2)
assert.equal(localWorkers.find((worker) => worker.name === "alpha-worker")?.url, "https://alpha-worker.dhruv-anand.workers.dev")
assert.equal(localWorkers.find((worker) => worker.name === "beta-api")?.url, "https://beta.example.com")

const merged = mergeWorkers([
  {
    name: "alpha-worker",
    title: "Alpha",
    url: "https://custom.example.com",
    description: "Pinned description",
    source: "manual",
    enabled: true,
    tags: ["pinned"],
  },
], localWorkers)
assert.equal(merged.find((worker) => worker.name === "alpha-worker")?.url, "https://custom.example.com")
assert.equal(merged.find((worker) => worker.name === "alpha-worker")?.enabled, true)
assert.equal(merged.find((worker) => worker.name === "beta-api")?.enabled, false)

const generatedPath = path.join(root, "workers-directory.data.ts")
writeGeneratedConfig(generatedPath, {
  generatedAt: "2026-05-15T00:00:00.000Z",
  publicUrl: "https://dhruv-anand.workers.dev",
  workers: merged,
})
assert.ok(readFileSync(generatedPath, "utf8").includes("export const directoryConfig"))
assert.equal(readGeneratedConfig(generatedPath).workers.length, 2)

const requests = []
const fetchImpl = async (url) => {
  requests.push(url)
  if (url.endsWith("/workers/subdomain")) {
    return Response.json({ success: true, result: { subdomain: "dhruv-anand" } })
  }
  if (url.endsWith("/workers/scripts")) {
    return Response.json({
      success: true,
      result: [
        { id: "remote-worker", modified_on: "2026-05-15T00:00:00.000Z" },
        { id: "custom-worker" },
      ],
    })
  }
  if (url.endsWith("/workers/domains")) {
    return Response.json({
      success: true,
      result: [
        { service: "custom-worker", hostname: "custom.example.com", enabled: true },
        { service: "disabled-worker", hostname: "disabled.example.com", enabled: false },
      ],
    })
  }
  throw new Error(`Unexpected URL ${url}`)
}

assert.equal(
  await discoverWorkersDevSubdomain({ accountId: "account-id", apiToken: "token", fetchImpl }),
  "dhruv-anand"
)
const remoteWorkers = await discoverCloudflareWorkers({
  accountId: "account-id",
  apiToken: "token",
  workersDevSubdomain: "dhruv-anand",
  fetchImpl,
})
assert.equal(remoteWorkers.length, 2)
assert.equal(remoteWorkers.find((worker) => worker.name === "remote-worker")?.url, "https://remote-worker.dhruv-anand.workers.dev")
assert.equal(remoteWorkers.find((worker) => worker.name === "custom-worker")?.url, "https://custom.example.com")
assert.ok(requests.some((url) => url.endsWith("/workers/scripts")))
assert.ok(requests.some((url) => url.endsWith("/workers/domains")))

console.log("worker directory config tests passed")
