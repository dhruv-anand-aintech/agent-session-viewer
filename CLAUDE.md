# Agent Session Viewer — project context

## Purpose

A **multi-platform** web UI for browsing AI coding assistant sessions: **Claude Code** (JSONL), **Cursor**, **OpenCode**, **Antigravity**, **Hermes**, plus optional **claw**-style bots (nanoclaw, openclaw, …). Two deployment modes:

1. **Cloudflare stack** — React SPA + **Worker** (`worker/index.ts`) stores sessions in **KV**; a **local daemon** (`daemon/watch.mjs`) watches filesystems and `PUT`s to `/api/sync` with `X-Auth-Pin`.
2. **Local-only** — `local-server.mjs` reads the same platform sources directly (no KV, no daemon). Use `npm run local`.

## Repo layout

| Path | Role |
|------|------|
| `src/` | React app (`App.tsx` main shell; `pretty/` = Pretty mode markdown + tool cards) |
| `worker/index.ts` | Cloudflare Worker: auth, `/api/sync`, `/api/session/...`, SSE `/api/stream`, debug ingest, todos |
| `daemon/watch.mjs` | Watches/polls platform dirs; sync cache `~/.claude/agent-session-viewer-sync-cache.json` |
| `platform-readers.mjs` | **Single source of truth** for reading non-JSONL platforms (Cursor, OpenCode, Antigravity, Hermes). Used by daemon **and** `local-server.mjs`. |
| `local-server.mjs` | Standalone HTTP server: loads projects, proxies same API shape as Worker for dev |
| `shared-utils.mjs` | Shared helpers (e.g. XML strip) for daemon |
| `deploy.mjs` | Patches `wrangler.toml` KV placeholders from env, runs `vite build` + `wrangler deploy` |
| `setup.mjs` | One-time KV + PIN setup |
| `public/` | Static assets (Vite `public/`); included in Worker static assets |

## Commands

```bash
npm run dev          # Vite only (API via vite proxy to local-server if port 3001)
npm run local        # local-server + Vite — full UI without Cloudflare
npm run build        # tsc + vite build → dist/
npm run deploy       # needs SESSIONS_KV_ID + SESSIONS_KV_PREVIEW_ID (see deploy.mjs)
npm run daemon       # needs WORKER_URL + AUTH_PIN
npm run lint         # eslint
```

## Data model (Worker KV)

- `meta/{projectPath}/{sessionId}` — session metadata (includes `source`, `lastActivity`, optional `customName`, …).
- `msgs/{projectPath}/{sessionId}` — message array (same shape as Claude JSONL-derived messages).
- `settings`, `todo/*`, `debug/buffer` — settings, todos, debug log buffer (daemon → `/api/debug-ingest`).

`projectPath` is URL-encoded in keys. External platforms use prefixes like `cursor:…`, `opencode:…`, `hermes:…`.

## Platform readers (`platform-readers.mjs`)

- **Claude Code** — Not in this file; daemon reads `~/.claude/projects/**/*.jsonl` directly in `watch.mjs`.
- **Cursor** — Reads `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (`cursorDiskKV`). Keys `composerData:{id}` and `bubbleId:{composerId}:{bubbleId}`. Workspace folder → `cursor:` project path via `workspaceStorage/*/workspace.json` + `composer.composerData`. **Important:** composer row keys must use `substr(key,14)` (first char of UUID after `composerData:`), not `13` (that included a leading `:` and broke metadata join). Newer bubbles may omit per-bubble `createdAt`; use `composerData` `createdAt` / `lastUpdatedAt` and interpolation (see code comments).
- **OpenCode / Antigravity / Hermes** — See file headers for paths and formats.

Change-detection: each reader returns `{ meta, msgs }[]`; callers pass `cacheGet`/`cacheSet` to avoid re-uploading unchanged sessions.

## Frontend conventions

- **`SessionMeta.source`** — `"claude"` \| `"cursor"` \| `"opencode"` \| `"antigravity"` \| `"hermes"` (default Claude when absent). Sidebar **platform dots** and **filter pills** use matching hues in `App.css` (`--color-*`, `.dot-*`, `.active-*`).
- **Pretty mode** — `src/pretty/PrettyMessageBlock.tsx` + `pretty.css`; raw mode — `MessageBlock.tsx`.
- **Auth** — `PinGate`; cookie `auth_pin` must match Worker `AUTH_PIN` for `/api/*` (except daemon ingest endpoints using `X-Auth-Pin`).

## Auth & CORS

Worker: daemon uses `X-Auth-Pin`; browser uses cookie after `POST /api/login`. `corsHeaders()` allow `*` for API responses used by dev + mobile.

## When editing

- Prefer **small, focused diffs**; match existing style (minimal comments unless non-obvious).
- **Platform parsing** — Add or change behavior in `platform-readers.mjs` so daemon and `local-server` stay in sync.
- **README** — May lag behind implementation (e.g. Cursor storage location); **this file** and `platform-readers.mjs` comments are better for exact paths.
- After changing Worker routes or KV shape, **deploy** with `npm run deploy` if users rely on Cloudflare.

## Testing locally

- `npm run local` — no Cloudflare account needed; exercises `local-server.mjs` + readers.
- `npm run build` — must pass before deploy.
