type StudyEntry = {
  slug: string
  title: string
  summary: string
  href: string
  kind?: string
  updatedAt?: string
  bytes?: number
}

type StudiesManifest = {
  generatedAt: string
  studies: StudyEntry[]
}

type Env = {
  STUDIES_KV: KVNamespace
}

const MANIFEST_KEY = "manifest.json"

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function htmlPage(title: string, body: string, description = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f6f1e7;
      --panel: #fffdfa;
      --panel-2: #f2e9dc;
      --border: rgba(56, 49, 40, 0.14);
      --text: #242018;
      --dim: #6a6257;
      --accent: #1e3a5f;
      --accent-2: #c2410c;
      --accent-3: #059669;
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #15130f;
        --panel: #201d18;
        --panel-2: #2b2721;
        --border: rgba(255, 248, 236, 0.14);
        --text: #f5efe3;
        --dim: #b8ae9f;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      color: var(--text);
      background:
        linear-gradient(90deg, rgba(30, 58, 95, 0.04) 1px, transparent 1px),
        linear-gradient(rgba(30, 58, 95, 0.04) 1px, transparent 1px),
        radial-gradient(circle at 20% 0%, rgba(194, 65, 12, 0.12), transparent 30rem),
        radial-gradient(circle at 80% 10%, rgba(5, 150, 105, 0.10), transparent 28rem),
        var(--bg);
      background-size: 34px 34px, 34px 34px, auto, auto, auto;
    }
    main {
      width: min(1240px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 52px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 20px;
      align-items: end;
      margin-bottom: 20px;
    }
    h1 {
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(42px, 7vw, 82px);
      line-height: 0.94;
      margin: 0 0 14px;
      font-weight: 400;
      letter-spacing: 0;
    }
    .lead {
      margin: 0;
      max-width: 68ch;
      color: var(--dim);
      font-size: 18px;
      line-height: 1.55;
    }
    .meta {
      border-left: 1px solid var(--border);
      padding-left: 18px;
      color: var(--dim);
      display: grid;
      gap: 10px;
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 20px 0 18px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: color-mix(in srgb, var(--panel) 90%, transparent);
      color: var(--dim);
      font-size: 13px;
      text-decoration: none;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .card {
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 16px 36px rgba(32, 26, 18, 0.08);
      padding: 18px;
      min-height: 180px;
      display: grid;
      gap: 12px;
    }
    .card h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }
    .card p {
      margin: 0;
      color: var(--dim);
      line-height: 1.55;
    }
    .card .stats {
      font-size: 12px;
      color: var(--accent);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
    }
    .card a {
      align-self: start;
      text-decoration: none;
      color: var(--text);
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--panel-2);
      width: fit-content;
    }
    .section-title {
      margin: 28px 0 12px;
      font-size: 12px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    @media (max-width: 860px) {
      .hero, .cards { grid-template-columns: 1fr; }
      .meta { border-left: 0; padding-left: 0; border-top: 1px solid var(--border); padding-top: 14px; }
    }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`
}

function renderIndex(manifest: StudiesManifest): string {
  const cards = manifest.studies
    .map(study => {
      const stats = [
        study.kind ? `<span>${escapeHtml(study.kind)}</span>` : "",
        study.updatedAt ? `<span>${escapeHtml(study.updatedAt)}</span>` : "",
        study.bytes ? `<span>${Math.round(study.bytes / 1024)} KB</span>` : "",
      ]
        .filter(Boolean)
        .join("")
      return `
        <article class="card">
          <div class="stats">${stats}</div>
          <h2>${escapeHtml(study.title)}</h2>
          <p>${escapeHtml(study.summary)}</p>
          <a href="${escapeHtml(study.href)}">Open study</a>
        </article>`
    })
    .join("")

  return htmlPage(
    "Study Atlas",
    `
      <section class="hero">
        <div>
          <h1>Study Atlas</h1>
          <p class="lead">A single parent page for all published analyses. Each study is stored as a static HTML file in Cloudflare KV and linked from here.</p>
        </div>
        <aside class="meta">
          <span>${manifest.studies.length} published studies</span>
          <span>generated ${escapeHtml(manifest.generatedAt)}</span>
          <span>served from Workers + KV</span>
        </aside>
      </section>
      <div class="toolbar">
        <span class="chip">Parent page</span>
        <a class="chip" href="/api/manifest">Manifest JSON</a>
        <a class="chip" href="/studies">Study listing</a>
      </div>
      <div class="section-title">Published Studies</div>
      <section class="cards">${cards}</section>
    `,
    "Parent page for all published studies"
  )
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  })
}

function textResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      ...headers,
    },
  })
}

function slugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/studies\/([^/]+?)(?:\.html)?\/?$/) ?? pathname.match(/^\/([^/]+?)(?:\.html)?\/?$/)
  if (!match) return null
  const slug = decodeURIComponent(match[1]).toLowerCase()
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const manifestRaw = await env.STUDIES_KV.get(MANIFEST_KEY, "json")
    const manifest = (manifestRaw && typeof manifestRaw === "object" ? manifestRaw : { generatedAt: new Date().toISOString(), studies: [] }) as StudiesManifest

    if (url.pathname === "/api/manifest") {
      return jsonResponse(manifest)
    }

    if (url.pathname === "/" || url.pathname === "/studies" || url.pathname === "/studies/") {
      return textResponse(renderIndex(manifest))
    }

    const slug = slugFromPath(url.pathname)
    if (slug) {
      const html = await env.STUDIES_KV.get(`pages/${slug}.html`)
      if (html) return textResponse(html)
      return textResponse(
        htmlPage(
          "Study not found",
          `<section class="hero"><div><h1>Study not found</h1><p class="lead">No static page exists for <code>${escapeHtml(slug)}</code>. Return to the atlas and choose another study.</p></div></section><a class="chip" href="/">Back to atlas</a>`,
          `Missing study ${slug}`
        ),
        404
      )
    }

    return textResponse(
      htmlPage(
        "Not found",
        `<section class="hero"><div><h1>Not found</h1><p class="lead">The requested path is not part of the study atlas.</p></div></section><a class="chip" href="/">Back to atlas</a>`,
        "Unknown path"
      ),
      404
    )
  },
}
