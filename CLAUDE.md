# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Agent Session Viewer — project context

## Purpose

A **multi-platform** web UI for browsing AI coding assistant sessions locally: **Claude Code** (JSONL), **Cursor**, **OpenCode**, **Antigravity**, **Hermes**, plus **claw**-style bots (nanoclaw, openclaw, …). Runs entirely on localhost — no cloud account needed. Remote access is via LAN, Cloudflare quick tunnel, or ngrok modes built into the CLI.

> **Note:** `worker/index.ts` and the older Cloudflare/deprecated deployment path are **deprecated**. The Worker returns HTTP 410. Do not add new features there.

## Repo layout

| Path | Role |
|------|------|
| `src/` | React app (`App.tsx` main shell; `pretty/` = Pretty mode markdown + tool cards) |
| `local-server.mjs` | HTTP server: reads platform dirs directly, SSE `/api/stream`, same API shape used by the frontend |
| `platform-readers.mjs` | **Single source of truth** for reading non-JSONL platforms (Cursor, OpenCode, Antigravity, Hermes). Used by `local-server.mjs` and `build-cache.mjs`. |
| `bin/agent-session-viewer.mjs` | npx CLI entry point — TUI menu, sharing modes (local/LAN/Cloudflare quick tunnel/ngrok), port selection |
| `build-cache.mjs` | Pre-builds the sidebar session cache on first run |
| `shared-utils.mjs` | Shared helpers (e.g. XML strip) |
| `lib/chunker.mjs` | Session chunking utilities |
| `lib/model-exporter.mjs` | Model export utilities |
| `setup-local.mjs` | One-time local setup (`npm run setup`) |
| `public/` | Static assets |

## Commands

```bash
npm run dev          # Vite only (frontend, no API)
npm run dev:api      # dev-server.mjs (API only)
npm run local        # local-server + Vite — full local UI
npm run build        # tsc + vite build → dist/
npm run build-cache  # rebuild sidebar cache manually
npm run lint         # eslint
npm run setup        # one-time local setup (detects platforms, builds cache)
```

## Sharing / remote access

The CLI (`bin/agent-session-viewer.mjs`) presents a TUI menu at startup:

| Mode | How |
|------|-----|
| local | `http://localhost:PORT` (default) |
| LAN | binds to `0.0.0.0`, prints LAN IP |
| Cloudflare quick tunnel | temporary `trycloudflare.com` URL, no account required |
| ngrok | permanent URL, requires free ngrok account |

Flags skip the menu: `--lan`, `--cf`, `--ngrok`, `--port`, `--open`, `--skip-cache`.

## Platform readers (`platform-readers.mjs`)

- **Claude Code** — `local-server.mjs` reads `~/.claude/projects/**/*.jsonl` directly (not in `platform-readers.mjs`).
- **Cursor** — Reads `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (`cursorDiskKV`). Keys `composerData:{id}` and `bubbleId:{composerId}:{bubbleId}`. **Important:** composer row keys must use `substr(key,14)` (not `13` — that included a leading `:` and broke metadata join). Newer bubbles may omit per-bubble `createdAt`; use `composerData` `createdAt`/`lastUpdatedAt` and interpolation.
- **OpenCode / Antigravity / Hermes** — See file headers for paths and formats.

Change-detection: each reader returns `{ meta, msgs }[]`; callers pass `cacheGet`/`cacheSet` to avoid reprocessing unchanged sessions.

## Frontend conventions

- **`SessionMeta.source`** — `"claude"` \| `"cursor"` \| `"opencode"` \| `"antigravity"` \| `"hermes"` (default Claude when absent). Sidebar **platform dots** and **filter pills** use matching hues in `App.css` (`--color-*`, `.dot-*`, `.active-*`).
- **Pretty mode** — `src/pretty/PrettyMessageBlock.tsx` + `pretty.css`; raw mode — `MessageBlock.tsx`.
- **Auth** — `PinGate`; PIN stored in localStorage, checked by `local-server.mjs`.

## When editing

- Prefer **small, focused diffs**; match existing style (minimal comments unless non-obvious).
- **Platform parsing** — changes go in `platform-readers.mjs` so `local-server.mjs` and `build-cache.mjs` stay in sync.
- Do not add features to `worker/index.ts` — it is deprecated.
- **Do not add debounce** — search inputs and other reactive UI already handle this or the user will ask explicitly. Do not reach for debounce as a default fix for "too many requests."

## Testing locally

- `npm run local` — full stack without any cloud account.
- `npm run build` — must pass before publishing.

## Publishing a new npm/npx package version

Publishing is triggered by pushing a git tag — **do not run `npm publish` manually**.

1. Bump `"version"` in `package.json`.
2. Commit all changes.
3. Tag: `git tag v<version>` (e.g. `git tag v0.1.12`).
4. Push: `git push origin main && git push origin v<version>`.

The GitHub Actions workflow picks up the tag and runs `npm publish`. The `prepare` script runs `npm run build` automatically on publish, so `npm run build` must pass before tagging.
