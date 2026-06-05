import { directoryConfig, type DirectoryWorker } from "./workers-directory.data"

type Env = {
  CF_API_TOKEN?: string
  CF_ACCOUNT_ID?: string
  WORKERS_DEV_SUBDOMAIN?: string
}

type LiveWorker = {
  name: string
  title: string
  url: string
  description: string
  tags: string[]
  modifiedOn: string | null
}

// Build a quick lookup of curated metadata (nice titles/descriptions/tags) by name.
const curatedByName = new Map(directoryConfig.workers.map((w) => [w.name, w]))

function titleFromName(name: string): string {
  return name
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

// Query the Cloudflare API for every deployed Worker script, then shape each into a
// LiveWorker, preferring curated metadata when we have it.
async function discoverLiveWorkers(env: Env): Promise<LiveWorker[]> {
  const token = env.CF_API_TOKEN
  const account = env.CF_ACCOUNT_ID
  const subdomain = env.WORKERS_DEV_SUBDOMAIN || "dhruv-anand"

  const curatedFallback = (): LiveWorker[] =>
    directoryConfig.workers
      .filter((w) => w.enabled)
      .map((w) => ({ name: w.name, title: w.title, url: w.url, description: w.description, tags: w.tags, modifiedOn: null }))

  if (!token || !account) {
    // No live discovery configured — fall back to the curated enabled set.
    return curatedFallback()
  }

  let body: { result?: Array<{ id: string; modified_on?: string }> }
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`Cloudflare API ${res.status}`)
    body = (await res.json()) as typeof body
  } catch {
    // API unreachable or token expired/invalid — degrade to the curated list.
    return curatedFallback()
  }
  const scripts = body.result || []

  return scripts.map((script) => {
    const curated = curatedByName.get(script.id)
    return {
      name: script.id,
      title: curated?.title || titleFromName(script.id),
      // Prefer a curated URL (handles custom domains); otherwise the workers.dev URL.
      url: curated?.url || `https://${script.id}.${subdomain}.workers.dev`,
      description: curated?.description || "Deployed Cloudflare Worker",
      tags: curated?.tags?.length ? curated.tags : ["workers.dev"],
      modifiedOn: script.modified_on || null,
    }
  }).sort((a, b) => a.title.localeCompare(b.title))
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function renderTags(worker: DirectoryWorker): string {
  const tags = worker.tags.length > 0 ? worker.tags : [worker.source]
  return tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")
}

function renderCard(worker: DirectoryWorker): string {
  return `<article class="worker-card" data-name="${escapeHtml(worker.name)}" data-url="${escapeHtml(worker.url)}">
    <span class="dot checking" title="checking"></span>
    <div class="tags">${renderTags(worker)}</div>
    <h2>${escapeHtml(worker.title || worker.name)}</h2>
    <p>${escapeHtml(worker.description || worker.url)}</p>
    <a href="${escapeHtml(worker.url)}" rel="noopener noreferrer">Open Worker</a>
  </article>`
}

function renderPage(): string {
  const visibleWorkers = directoryConfig.workers
    .filter((worker) => worker.enabled)
    .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name))

  const cards = visibleWorkers.length > 0
    ? visibleWorkers.map(renderCard).join("")
    : `<section class="empty">
        <h2>No Workers selected</h2>
        <p>Run <code>npm run configure:directory</code> locally and choose which Worker links should appear here.</p>
      </section>`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Directory of Dhruv Anand Cloudflare Workers">
  <title>Dhruv Anand Workers</title>
  <style>
    :root {
      --bg: #f7f8f4;
      --surface: #ffffff;
      --surface-soft: #eef3ec;
      --text: #17201b;
      --muted: #5f6d65;
      --line: rgba(23, 32, 27, 0.14);
      --accent: #0f766e;
      --accent-strong: #164e63;
      --shadow: rgba(28, 43, 35, 0.09);
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101513;
        --surface: #171f1b;
        --surface-soft: #1f2b26;
        --text: #eef5ef;
        --muted: #a8b7ae;
        --line: rgba(238, 245, 239, 0.14);
        --accent: #5eead4;
        --accent-strong: #93c5fd;
        --shadow: rgba(0, 0, 0, 0.22);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        linear-gradient(90deg, rgba(15, 118, 110, 0.045) 1px, transparent 1px),
        linear-gradient(rgba(22, 78, 99, 0.045) 1px, transparent 1px),
        var(--bg);
      background-size: 28px 28px;
    }
    main {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 36px 0 56px;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: end;
      padding-bottom: 22px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(38px, 7vw, 76px);
      line-height: 0.95;
      letter-spacing: 0;
      font-weight: 700;
    }
    .lead {
      margin: 0;
      max-width: 64ch;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.55;
    }
    .status {
      display: grid;
      gap: 8px;
      min-width: 220px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      text-align: right;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin-top: 22px;
    }
    .worker-card, .empty {
      background: color-mix(in srgb, var(--surface) 94%, transparent);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 18px 40px var(--shadow);
      padding: 18px;
    }
    .worker-card {
      min-height: 210px;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 12px;
      position: relative;
      transition: opacity 0.4s ease, filter 0.4s ease;
    }
    /* New cards fade/slide in when discovered live. */
    @keyframes cardIn {
      from { opacity: 0; transform: translateY(8px) scale(0.98); }
      to { opacity: 1; transform: none; }
    }
    .worker-card.is-new { animation: cardIn 0.45s ease both; }
    /* A worker that stops responding is greyed and de-emphasised. */
    .worker-card.is-down {
      opacity: 0.45;
      filter: grayscale(1);
    }
    .worker-card.is-down a { pointer-events: none; }
    .dot {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--muted);
    }
    .dot.up {
      background: #22c55e;
      box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 22%, transparent);
    }
    .dot.down { background: #ef4444; }
    .dot.checking { background: #eab308; }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tags span {
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--accent-strong);
      background: var(--surface-soft);
      padding: 5px 8px;
      font-size: 11px;
      line-height: 1;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    h2 {
      margin: 0;
      font-size: 19px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
    }
    a {
      color: var(--text);
      text-decoration: none;
      width: fit-content;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 10px 14px;
      background: var(--surface-soft);
    }
    a:hover { border-color: var(--accent); }
    .empty {
      grid-column: 1 / -1;
      display: grid;
      gap: 10px;
    }
    code {
      background: var(--surface-soft);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 2px 5px;
    }
    @media (max-width: 900px) {
      header, .grid { grid-template-columns: 1fr; }
      .status { text-align: left; min-width: 0; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Dhruv Anand Workers</h1>
        <p class="lead">A curated directory of Cloudflare Workers and Worker-backed sites that are intentionally exposed from this top-level index.</p>
      </div>
      <aside class="status">
        <span>${visibleWorkers.length} public links</span>
        <span>updated ${escapeHtml(directoryConfig.generatedAt)}</span>
        <span>${escapeHtml(directoryConfig.publicUrl)}</span>
      </aside>
    </header>
    <section class="grid" id="grid">${cards}</section>
  </main>
  <script>${clientScript}</script>
  <footer style="border-top:1px solid #ebebeb;background:#f2f2f2;padding:14px 24px;font-size:13px;color:#70757a;text-align:center;font-family:arial,sans-serif;">© 2026 AI Northstar Tech Private Limited. All Rights Reserved.</footer>
</body>
</html>`
}

// Runs in the browser. Two independent loops:
//   1. Discovery (every 1h): GET /api/workers -> reconcile cards (add new, remove gone).
//   2. Health (every 60s): probe each card's URL -> toggle up/down greying.
const clientScript = `
const DISCOVERY_MS = 60 * 60 * 1000;
const HEALTH_MS = 60 * 1000;
const grid = document.getElementById("grid");

function cardHtml(w) {
  const tags = (w.tags && w.tags.length ? w.tags : ["worker"])
    .map(t => '<span>' + esc(t) + '</span>').join("");
  return '<span class="dot checking"></span>'
    + '<div class="tags">' + tags + '</div>'
    + '<h2>' + esc(w.title || w.name) + '</h2>'
    + '<p>' + esc(w.description || w.url) + '</p>'
    + '<a href="' + esc(w.url) + '" rel="noopener noreferrer">Open Worker</a>';
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// TODO(you): decide what "up" means. We can only do a cross-origin no-cors probe,
// which yields an opaque response: it RESOLVES if the worker answered at all
// (any status, even 403/500) and REJECTS on a network/DNS failure or timeout.
// Implement the up/down decision and pick the timeout. Return true = up, false = down.
async function probeWorker(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000); // 6s = down
  try {
    await fetch(url, { mode: "no-cors", signal: ctrl.signal, cache: "no-store" });
    return true;  // opaque response resolved -> the worker answered -> up
  } catch {
    return false; // network error, refused, or timeout -> down
  } finally {
    clearTimeout(timer);
  }
}

async function reconcile() {
  let data;
  try { data = await (await fetch("/api/workers", { cache: "no-store" })).json(); }
  catch { return; }
  const workers = data.workers || [];
  const seen = new Set();
  for (const w of workers) {
    seen.add(w.name);
    let card = grid.querySelector('[data-name="' + (window.CSS && CSS.escape ? CSS.escape(w.name) : w.name) + '"]');
    if (!card) {
      card = document.createElement("article");
      card.className = "worker-card is-new";
      card.dataset.name = w.name;
      card.dataset.url = w.url;
      card.innerHTML = cardHtml(w);
      grid.appendChild(card);
    }
  }
  // Remove cards for workers that no longer exist.
  grid.querySelectorAll(".worker-card").forEach(card => {
    if (!seen.has(card.dataset.name)) card.remove();
  });
  checkHealth();
}

async function checkHealth() {
  const cards = [...grid.querySelectorAll(".worker-card")];
  await Promise.all(cards.map(async card => {
    const dot = card.querySelector(".dot");
    let up;
    try { up = await probeWorker(card.dataset.url); }
    catch { up = false; }
    card.classList.toggle("is-down", !up);
    if (dot) dot.className = "dot " + (up ? "up" : "down");
  }));
}

reconcile();
setInterval(reconcile, DISCOVERY_MS);
setInterval(checkHealth, HEALTH_MS);
`

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

// In-isolate cache so the Cloudflare API is queried at most once per hour, no matter
// how many browsers are polling /api/workers.
const DISCOVERY_TTL_MS = 60 * 60 * 1000
let discoveryCache: { at: number; workers: LiveWorker[] } | null = null

async function getLiveWorkers(env: Env): Promise<LiveWorker[]> {
  const now = Date.now()
  if (discoveryCache && now - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.workers
  }
  const workers = await discoverLiveWorkers(env)
  discoveryCache = { at: now, workers }
  return workers
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/workers") {
      try {
        const workers = await getLiveWorkers(env)
        return jsonResponse({ generatedAt: new Date().toISOString(), publicUrl: directoryConfig.publicUrl, workers })
      } catch (err) {
        return jsonResponse({ error: String(err), workers: [] })
      }
    }

    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      return new Response("Not found", { status: 404 })
    }

    return new Response(renderPage(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    })
  },
}
