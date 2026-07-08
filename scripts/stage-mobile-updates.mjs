#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const mobileRoot = path.join(root, "apps", "mobile")
const sourceDir = path.join(mobileRoot, "dist-update")
const targetDir = path.join(root, "dist", "mobile-updates", "latest")

function b64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function uuidFromHash(hash) {
  const bytes = Buffer.from(hash, "hex").subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

console.log("Exporting Android mobile update bundle...")
execFileSync("npm", ["--prefix", mobileRoot, "run", "updates:export"], { cwd: root, stdio: "inherit" })

if (!existsSync(path.join(root, "dist"))) {
  throw new Error("Root dist/ is missing. Run npm run build before staging mobile updates.")
}
if (!existsSync(path.join(sourceDir, "metadata.json"))) {
  throw new Error("Mobile update metadata.json was not generated.")
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })
cpSync(sourceDir, targetDir, { recursive: true })

const metadata = JSON.parse(readFileSync(path.join(targetDir, "metadata.json"), "utf8"))
const bundlePath = metadata.fileMetadata?.android?.bundle
if (!bundlePath) throw new Error("Android bundle path missing from mobile update metadata.")

const bundleFile = path.join(targetDir, bundlePath)
const bundleBytes = readFileSync(bundleFile)
const hash = createHash("sha256").update(bundleBytes).digest()
const hashHex = hash.toString("hex")
const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
const bundleName = path.basename(bundlePath)

writeFileSync(
  path.join(targetDir, "asv-manifest.json"),
  JSON.stringify({
    id: uuidFromHash(hashHex),
    createdAt: new Date().toISOString(),
    runtimeVersion: "0.1.0",
    commit,
    launchAsset: {
      key: bundleName.replace(/\.[^.]+$/, ""),
      hash: b64url(hash),
      contentType: "application/javascript",
      fileExtension: ".hbc",
      path: `/mobile-updates/latest/${bundlePath}`,
    },
    assets: [],
  }, null, 2),
)

console.log(`Staged Android mobile update ${bundleName} for commit ${commit}`)
