# Claude Session Viewer

A live viewer for your local Claude Code sessions — browse conversations, see tool calls, thinking blocks, and markdown-rendered assistant responses in a faithful dark-mode UI.

Sessions are streamed to a Cloudflare Worker (KV storage) by a local daemon that watches your `~/.claude/projects/` directory.

## Features

- **Live updates** — sessions appear as you work; SSE streaming keeps the UI current
- **Pretty mode** — markdown rendering, thinking pills, tool call cards (Bash, Read, Edit, Write, Search…)
- **Flat or grouped sidebar** — all sessions sorted by last activity, or grouped by project
- **Session renaming** — give sessions memorable names via the pencil icon
- **PIN-protected** — simple cookie auth so you can expose the viewer remotely
- **Nanoclaw support** *(optional)* — syncs WhatsApp/Telegram Claude agent sessions from a [nanoclaw](https://github.com/your/nanoclaw) install

## Requirements

- Node.js ≥ 18
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- `wrangler` CLI — installed automatically as a dev dependency

## One-command setup

```bash
git clone https://github.com/your/claude-session-viewer
cd claude-session-viewer
npm install
node setup.mjs
```

The setup script will:

1. Create a KV namespace in your Cloudflare account
2. Patch `wrangler.toml` with the real namespace IDs
3. Prompt you to choose a PIN (used to log in to the viewer)
4. Build and deploy the Worker

After setup, the script prints your Worker URL and the exact command to start the daemon.

## Running the daemon

```bash
WORKER_URL=https://claude-session-viewer.<subdomain>.workers.dev \
AUTH_PIN=<your-pin> \
npm run daemon
```

Or pass flags directly:

```bash
node daemon/watch.mjs --worker <url> --pin <pin>
```

The daemon does an initial sync of all existing sessions, then watches `~/.claude/projects/**/*.jsonl` for live changes.

## Nanoclaw integration (optional)

If you run [nanoclaw](https://github.com/your/nanoclaw) (a WhatsApp/Telegram Claude agent), the daemon can also sync those conversations:

```bash
WORKER_URL=... AUTH_PIN=... NANOCLAW_DIR=/path/to/nanoclaw npm run daemon
```

This syncs both the flat chat messages and the rich agent sessions (thinking blocks, tool calls) stored as Claude Code JSONL files inside your nanoclaw directory.

## Local development

```bash
npm run dev        # Vite dev server (frontend only)
npm run dev:api    # Local API proxy (optional)
```

## Deploying changes

```bash
npm run deploy     # tsc + vite build + wrangler deploy
```

## Architecture

```
~/.claude/projects/**/*.jsonl
         │
         ▼
  daemon/watch.mjs          (local file watcher)
         │  PUT /api/sync (X-Auth-Pin header)
         ▼
  Cloudflare Worker          (worker/index.ts)
     KV: meta/* + msgs/*
         │
         ▼  SSE /api/stream
  Browser (React + Vite)     (src/)
```

## Configuration

| Variable | Flag | Description |
|---|---|---|
| `WORKER_URL` | `--worker` | URL of your deployed Cloudflare Worker |
| `AUTH_PIN` | `--pin` | PIN set during `node setup.mjs` |
| `NANOCLAW_DIR` | `--nanoclaw` | Path to nanoclaw repo (optional) |
