# Claude Session Viewer

A live viewer for your local Claude Code sessions — browse conversations, see tool calls, thinking blocks, and markdown-rendered assistant responses in a faithful dark-mode UI.

Sessions are streamed to a Cloudflare Worker (KV storage) by a local daemon that watches your `~/.claude/projects/` directory. Works on desktop and mobile.

## Features

- **Live updates** — sessions appear as you work; SSE streaming keeps the UI current
- **Pretty mode** — markdown rendering, thinking pills, tool call cards (Bash, Read, Edit, Write, Search…)
- **Sub-agent runs marked** — messages from Claude Code sub-agents (sidechain sessions) are visually distinguished with a `⤷ sub-agent` indicator and indented left border
- **Flat or grouped sidebar** — all sessions sorted by last activity, or grouped by project
- **Session renaming** — give sessions memorable names via the pencil icon
- **Mobile-friendly** — slide-in sidebar drawer, back button, responsive layout
- **PIN-protected** — simple cookie auth so you can expose the viewer remotely
- **Claw bot support** *(optional)* — syncs WhatsApp/Telegram Claude agent sessions from any supported claw tool installation

## Claw bot integration

Claude Session Viewer supports the full family of **claw-type messaging bots** — local AI agents that run Claude via WhatsApp or Telegram and store their session data in a standard directory layout.

Supported tools (auto-detected from `~/toolname`):

| Tool | Env var override |
|---|---|
| **nanoclaw** *(primary)* | `NANOCLAW_DIR` |
| openclaw | `OPENCLAW_DIR` |
| picoclaw | `PICOCLAW_DIR` |
| femtoclaw | `FEMTOCLAW_DIR` |
| attoclaw | `ATTOCLAW_DIR` |
| kiloclaw | `KILOCLAW_DIR` |
| megaclaw | `MEGACLAW_DIR` |
| zeroclaw | `ZEROCLAW_DIR` |
| microclaw | `MICROCLAW_DIR` |
| rawclaw | `RAWCLAW_DIR` |

Each detected tool syncs two types of data:

- **Chat sessions** — flat message history from the SQLite database (`store/messages.db`), surfaced as a `toolname-telegram` or `toolname-whatsapp` project
- **Agent sessions** — rich Claude Code JSONL files from `data/sessions/`, including thinking blocks, tool calls, and full agent reasoning, surfaced as `toolname-agent-telegram` etc.

Path overrides can also be set via the **Settings** panel (⚙ in the top bar) without editing env vars.

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

### With claw tool support

```bash
# Auto-detected if ~/nanoclaw exists — or specify explicitly:
WORKER_URL=... AUTH_PIN=... NANOCLAW_DIR=/path/to/nanoclaw npm run daemon

# Multiple tools at once:
WORKER_URL=... AUTH_PIN=... \
  NANOCLAW_DIR=/path/to/nanoclaw \
  OPENCLAW_DIR=/path/to/openclaw \
  npm run daemon
```

The daemon polls each tool's SQLite DB every 5 seconds and file-watches the agent JSONL sessions for instant updates.

## Local development

```bash
npm run dev        # Vite dev server (frontend only)
npm run dev:api    # Local API proxy (optional)
```

## Deploying changes

```bash
SESSIONS_KV_ID=<id> SESSIONS_KV_PREVIEW_ID=<preview_id> npm run deploy
```

`deploy.mjs` patches `wrangler.toml` with your KV IDs, runs the build and deploy, then restores the placeholders — keeping the repo clean for sharing.

Store these in your shell profile or a local env file:

```bash
export SESSIONS_KV_ID=e61e79fc...
export SESSIONS_KV_PREVIEW_ID=e5f103b9...
```

Then just run `npm run deploy`.

## Architecture

```
~/.claude/projects/**/*.jsonl       (Claude Code sessions + sub-agent sidechains)
~/nanoclaw/store/messages.db        (claw bot chat history)
~/nanoclaw/data/sessions/**/*.jsonl (claw bot agent sessions)
         │
         ▼
  daemon/watch.mjs          (local file watcher + SQLite poller)
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
| `NANOCLAW_DIR` | `--nanoclaw` | Path to nanoclaw repo *(primary claw tool)* |
| `OPENCLAW_DIR` | `--openclaw` | Path to openclaw repo |
| `PICOCLAW_DIR` | `--picoclaw` | Path to picoclaw repo |
| *(any `{NAME}_DIR`)* | `--{name}` | Any other supported claw tool |
