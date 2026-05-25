import { directoryConfig, type DirectoryWorker } from "./workers-directory.data"

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
  return `<article class="worker-card">
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
    }
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
    <section class="grid">${cards}</section>
  </main>
</body>
</html>`
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/workers") {
      return jsonResponse({
        ...directoryConfig,
        workers: directoryConfig.workers.filter((worker) => worker.enabled),
      })
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
