# Agent Session Viewer

![Agent Session Viewer UI](public/screenshot.png)

A live multi-platform session viewer — browse AI coding assistant conversations across Claude Code, Codex, Cursor, OpenCode, Hermes, Antigravity, and messaging bots (nanoclaw, openclaw, picoclaw, and friends) in a unified dark-mode UI with markdown rendering, tool call cards, fuzzy thread search, and thinking blocks.

## Install

### npx (no install required)

```bash
npx agent-session-viewer
```

Downloads and runs directly. Builds the sidebar cache on first run, then opens at **http://localhost:3001**.

```bash
npx agent-session-viewer --host    # LAN access (phone, tablet)
npx agent-session-viewer --open    # auto-open browser
npx agent-session-viewer --port 4000
npx agent-session-viewer --skip-cache  # skip cache build
```

### Homebrew (macOS)

```bash
brew tap dhruv-anand-aintech/tap
brew install agent-session-viewer
agent-session-viewer
```

### From source

```bash
git clone https://github.com/dhruv-anand-aintech/agent-session-viewer
cd agent-session-viewer
npm install
npm run setup    # detects platforms, builds sidebar cache
npm run local    # starts at http://localhost:5173
```

To access from other devices on your network:

```bash
npm run local -- --host
```

## Features

- **Multi-platform** — Claude Code, Codex, Cursor, OpenCode, Hermes, Antigravity, and claw bots in one place, all auto-detected
- **Live updates** — sessions appear as you work; SSE streaming keeps the UI current
- **Pretty mode** — markdown rendering, thinking pills, tool call cards (Bash, Read, Edit, Write, Search…)
- **Platform filter** — filter the sidebar by platform
- **Sub-agent runs** — sub-agent sessions are visually distinguished with a `⤷ sub-agent` indicator and indented border
- **Flat or grouped sidebar** — all sessions sorted by last activity, or grouped by project
- **Session renaming** — give sessions memorable names via the pencil icon
- **Thread search** — fuzzy in-sidebar search across all sessions
- **Mobile-friendly** — slide-in sidebar drawer, back button, safe-area aware
- **PIN-protected** — simple cookie auth for remote access

## Platform support

All platforms are auto-detected from their standard locations — no configuration needed if the directories exist.

| Platform | Default location | Format |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | JSONL |
| **Codex** | `~/.codex/sessions/**/*.jsonl` | JSONL event stream |
| **Cursor** | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | SQLite |
| **OpenCode** | `~/.local/share/opencode/` | SQLite + JSON |
| **Hermes** | `~/.hermes/state.db` | SQLite |
| **Antigravity** | `~/.gemini/antigravity/brain/{uuid}/` | Markdown artifacts |

### Platform notes

**Codex** — rollout transcripts are read from `~/.codex/sessions/`. Structured `function_call` / `function_call_output` entries render as proper tool-use cards in Pretty mode.

**Cursor** — sessions are read from the SQLite blob store. Workspace → folder mapping is resolved via `workspaceStorage/`. macOS only (path is hardcoded to `~/Library/Application Support/Cursor/`).

**OpenCode** — reads from `~/.local/share/opencode/opencode.db` (newer releases) with fallback to the flat `storage/` directory layout.

**Antigravity** — Google's coding agent stores structured artifacts per session (`task.md`, `implementation_plan.md`, `walkthrough.md`). Each artifact is shown as an assistant message. Full conversation logs use an undisclosed protobuf schema and are not read.

**Hermes** — reads from `~/.hermes/state.db`. Sessions are grouped by source (Telegram channel, WhatsApp number, etc.).

## Claw bot integration

Agent Session Viewer supports **claw-type messaging bots** — AI agents that run via WhatsApp or Telegram and store session data locally.

Two storage layouts are supported automatically:

- **nanoclaw-style** (default): `{dir}/store/messages.db` + `{dir}/data/sessions/`
- **picoclaw-style**: `{dir}/workspace/sessions/` (JSONL directly, no SQLite DB)

Auto-detected from `~/toolname` or `~/.toolname` for each of: nanoclaw, openclaw, picoclaw, femtoclaw, attoclaw, kiloclaw, megaclaw, zeroclaw, microclaw, rawclaw.

If your installation is in a non-standard location, configure the path in the Settings panel (⚙) or set `{NAME}_DIR` as an env var override.

## Cloudflare Worker deployment (optional)

For remote access and multi-device sync via a deployed URL:

```bash
npm run setup:cloudflare
```

Requires a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier). The script creates a KV namespace, sets an auth PIN, builds and deploys the Worker.

Run the daemon to keep the Worker in sync with your local sessions:

```bash
WORKER_URL=https://agent-session-viewer.<subdomain>.workers.dev \
AUTH_PIN=<your-pin> \
npm run daemon
```

To deploy code changes after modifying the Worker:

```bash
npm run deploy
```

## Other commands

```bash
npm run build-cache   # rebuild sidebar cache manually (runs automatically during setup)
npm run dev           # Vite frontend only, no API
npm run build         # production build
npm run lint          # eslint
```

## Architecture

```
~/.claude/projects/**/*.jsonl           Claude Code sessions
~/.codex/sessions/**/*.jsonl            Codex sessions
~/Library/.../Cursor/.../state.vscdb    Cursor sessions (macOS)
~/.local/share/opencode/                OpenCode sessions
~/.hermes/state.db                      Hermes sessions
~/.gemini/antigravity/brain/            Antigravity sessions
~/nanoclaw/store/messages.db            claw bot chat history (auto-detected)
~/nanoclaw/data/sessions/**/*.jsonl     claw bot agent sessions (auto-detected)
         │
         ▼
  daemon/watch.mjs        (local file watcher + SQLite poller)
         │  PUT /api/sync (X-Auth-Pin)
         ▼
  Cloudflare Worker       (worker/index.ts — KV storage)
         │  SSE /api/stream
         ▼
  Browser (React + Vite)  (src/)

  ── or local mode (default) ──

  local-server.mjs        (reads platform dirs directly — no Cloudflare)
         │  SSE /api/stream
         ▼
  Browser (React + Vite)  (src/)
```
