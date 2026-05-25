#!/usr/bin/env node
/**
 * Publish generated study pages from ~/.agent/diagrams into Cloudflare KV and
 * deploy the companion Worker that serves them.
 *
 * Usage:
 *   npm run publish:studies
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(ROOT, "..")
const STUDIES_DIR = path.join(process.env.HOME || process.env.USERPROFILE || "", ".agent", "diagrams")
const TEMPLATE_CONFIG = path.join(REPO_ROOT, "wrangler.studies.toml")
const TMP_DIR = path.join(REPO_ROOT, ".tmp")
const GENERATED_CONFIG = path.join(TMP_DIR, "wrangler.studies.generated.toml")
const BINDING = "STUDIES_KV"

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    ...opts,
  })
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function parseNamespaceId(output) {
  const match = output.match(/id\s*=\s*"([a-f0-9]{32})"/i)
  if (!match) throw new Error(`Could not parse namespace id from:\n${output}`)
  return match[1]
}

function ensureNamespaceIds() {
  const template = readFileSync(TEMPLATE_CONFIG, "utf8")
  let id = process.env.STUDIES_KV_ID || ""
  let previewId = process.env.STUDIES_KV_PREVIEW_ID || ""

  if ((!id || !previewId) && existsSync(GENERATED_CONFIG)) {
    const existing = readFileSync(GENERATED_CONFIG, "utf8")
    id ||= existing.match(/id\s*=\s*"([a-f0-9]{32})"/i)?.[1] || ""
    previewId ||= existing.match(/preview_id\s*=\s*"([a-f0-9]{32})"/i)?.[1] || ""
  }

  if (!id) {
    const out = run("npx", ["wrangler", "kv", "namespace", "create", BINDING])
    id = parseNamespaceId(out)
    console.log(`Created namespace ${BINDING}: ${id}`)
  }

  if (!previewId) {
    const out = run("npx", ["wrangler", "kv", "namespace", "create", BINDING, "--preview"])
    previewId = parseNamespaceId(out)
    console.log(`Created preview namespace ${BINDING}: ${previewId}`)
  }

  ensureDir(TMP_DIR)
  const config = template
    .replace('main = "worker/studies.ts"', 'main = "../worker/studies.ts"')
    .replace("PLACEHOLDER_STUDIES_KV_ID", id)
    .replace("PLACEHOLDER_STUDIES_KV_PREVIEW_ID", previewId)
  writeFileSync(GENERATED_CONFIG, config)
  return { id, previewId, configPath: GENERATED_CONFIG }
}

function stripExtension(file) {
  return file.replace(/\.html$/i, "")
}

function readMeta(studiesDir, file) {
  const htmlPath = path.join(studiesDir, file)
  const metaCandidates = [
    path.join(studiesDir, `${stripExtension(file)}.json`),
    path.join(studiesDir, `${stripExtension(file)}-data.json`),
  ]
  const html = readFileSync(htmlPath, "utf8")
  const title = html.match(/<title>(.*?)<\/title>/is)?.[1]?.trim() || stripExtension(file)
  const description =
    html.match(/<meta name="description" content="(.*?)">/is)?.[1]?.trim() ||
    html.match(/<p class="dek">([\s\S]*?)<\/p>/is)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ||
    title

  let meta = {}
  for (const jsonPath of metaCandidates) {
    if (existsSync(jsonPath)) {
      try {
        meta = JSON.parse(readFileSync(jsonPath, "utf8"))
        break
      } catch {
        meta = {}
      }
    }
  }

  return {
    file,
    slug: stripExtension(file).toLowerCase(),
    title,
    description,
    bytes: Buffer.byteLength(html, "utf8"),
    html,
    meta,
    metaPath: metaCandidates.find((candidate) => existsSync(candidate)) || "",
  }
}

function publishKey(configPath, namespaceId, key, filePath) {
  run("npx", [
    "wrangler",
    "kv",
    "key",
    "put",
    key,
    "--path",
    filePath,
    "--namespace-id",
    namespaceId,
    "--remote",
    "--config",
    configPath,
  ], { cwd: REPO_ROOT })
}

function buildManifest(studies) {
  return {
    generatedAt: new Date().toISOString(),
    studies: studies.map((study) => {
      const summary =
        study.meta?.summary ||
        study.description ||
        study.title
      return {
        slug: study.slug,
        title: study.title,
        summary,
        href: `/studies/${study.slug}`,
        kind: study.meta?.kind || study.meta?.metrics?.dataset || "",
        updatedAt: study.meta?.metrics?.generated_at || study.meta?.updatedAt || new Date().toISOString(),
        bytes: study.bytes,
      }
    }),
  }
}

async function main() {
  if (!existsSync(STUDIES_DIR)) {
    throw new Error(`Missing studies directory: ${STUDIES_DIR}`)
  }
  const { id, configPath } = ensureNamespaceIds()

  const htmlFiles = readdirSync(STUDIES_DIR)
    .filter((file) => file.endsWith(".html"))
    .filter((file) => !file.startsWith("index"))
    .sort()

  if (htmlFiles.length === 0) {
    throw new Error(`No HTML studies found in ${STUDIES_DIR}`)
  }

  const studies = htmlFiles.map((file) => readMeta(STUDIES_DIR, file))
  const manifest = buildManifest(studies)

  ensureDir(TMP_DIR)
  const manifestPath = path.join(TMP_DIR, "studies-manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8")

  publishKey(configPath, id, "manifest.json", manifestPath)
  for (const study of studies) {
    const htmlPath = path.join(STUDIES_DIR, study.file)
    publishKey(configPath, id, `pages/${study.slug}.html`, htmlPath)
    if (study.metaPath) {
      publishKey(configPath, id, `meta/${study.slug}.json`, study.metaPath)
    }
    console.log(`Uploaded ${study.slug}`)
  }

  const deployOutput = run("npx", ["wrangler", "deploy", "--config", configPath], { cwd: REPO_ROOT })
  process.stdout.write(deployOutput)
  console.log(`Published ${studies.length} studies from ${STUDIES_DIR}`)
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err)
  process.exit(1)
})
