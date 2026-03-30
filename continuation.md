# Continuation: Claude Session Viewer

**Date:** 2026-03-26
**Working directory:** /Users/dhruvanand/Code/claude-session-viewer

---

## What This Project Is

A viewer for Claude Code session logs stored in `~/.claude/projects/`. Runs in two modes: local (Node.js server reading JSONL files directly) and remote (Cloudflare Worker + KV storage, synced by a daemon). React frontend with sidebar of sessions and pretty/raw message viewer.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, marked (markdown)
- **Local server:** Node.js ESM (`local-server.mjs`)
- **Remote:** Cloudflare Worker (`worker/index.ts`), Cloudflare KV
- **Daemon:** Node.js watcher (`daemon/watch.mjs`) — syncs JSONL files to worker
- **Shared utils:** `shared-utils.mjs` — `stripXml()` used by both local-server and daemon

## How to Build & Run

```bash
npm run local        # local-server.mjs + vite (hot reload)
npm run deploy       # build + deploy to Cloudflare
WORKER_URL=https://... AUTH_PIN=1234 npm run daemon
```

## Key Files

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main React app — sidebar, session pane, all hooks |
| `src/App.css` | All styles |
| `src/pretty/PrettyMessageBlock.tsx` | Pretty mode renderer |
| `src/pretty/pretty.css` | Pretty mode styles |
| `local-server.mjs` | Local Node.js API server |
| `worker/index.ts` | Cloudflare Worker |
| `daemon/watch.mjs` | File watcher → syncs to worker |
| `shared-utils.mjs` | Shared `stripXml()` for local-server + daemon |

## What Was Done This Session

- **Session names in sidebar**: `firstName` (first user message) now properly extracted in `local-server.mjs` — was missing entirely, causing hash fallbacks
- **`stripXml` unified**: extracted to `shared-utils.mjs`, imported in both `local-server.mjs` and `daemon/watch.mjs`; daemon uses the more comprehensive version (strips paired tags with content first)
- **Sidebar tooltip**: replaced slow browser `title` with instant CSS `data-tooltip` + `::after` pseudo-element
- **Pretty mode hover**: subtle background on hover for all message row types; timestamp overlay now has background + border so it's readable
- **Top padding**: `messages-scroll` increased from 8px to 28px so first message timestamp isn't hidden behind session header
- **File path button (local only)**: `📄 {id}.jsonl` button in session header opens JSONL in Finder; gated behind `capabilities.openPath` from `/api/capabilities` endpoint (local returns `{openPath:true}`, worker 404s → false); `Capabilities` interface is the extension point for future local-only features

## Pending Task (FIRST PRIORITY)

**Fix group/project display names in sidebar.**

The user said: *"the groups names in the sidebar are getting mixed up / and - perhaps as that is how they are stored in .claude/projects. but try to make them resemble the actual working directories as much as possible. do the truncation on the initial part of the string as the meaningful part is the end. of course, on hover it should show the full path"*

### Root Cause

`normProjectDir()` in `daemon/watch.mjs` (line ~122) encodes filesystem paths by replacing `/` with `-`:
```js
function normProjectDir(absDir) {
  return absDir.replace(homedir(), "").replace(/\//g, "-").replace(/^-/, "")
}
```

So `/Users/dhruvanand/Code/my-cool-project` becomes `Users-dhruvanand-Code-my-cool-project`.

The current `displayName` transform in `local-server.mjs` (line ~98) and `worker/index.ts` (line ~38):
```js
dir.replace(/^-Users-[^-]+-Code-/, "").replace(/-/g, "/")
```

This **incorrectly** replaces ALL hyphens with slashes, so `my-cool-project` becomes `my/cool/project`.

### Fix Required

In **both** `local-server.mjs` and `worker/index.ts` (and `sync-sessions.ts` if relevant):

1. **Better decode**: Strip the home dir prefix properly. The stored key is the home-relative path with `/` → `-`. Need to recover something readable. Since we can't reliably distinguish path-separator hyphens from name hyphens, the best approach is:
   - Strip a known prefix like `Users-{username}-` from the start
   - Display the remainder with `-` as-is (don't convert to `/`) OR try to reconstruct by matching against known patterns
   - Actually the cleanest fix: just strip the leading `Users-{username}-` and display the rest with `-` kept as hyphens — still readable, no false slashes

2. **Truncate from the LEFT** — the end of the path is most meaningful. If the display name is long, show `…foo-bar-baz` not `foo-bar-baz…`. CSS `text-overflow: ellipsis` truncates from the right; need a different approach (compute truncation in JS or use `direction: rtl`).

3. **Full path on hover** — the `title` attribute on `.sidebar-project-name` already exists but shows `project.path` (the encoded key). Should show the decoded/reconstructed path, ideally the actual filesystem path.

### Where to Edit

- `local-server.mjs` line ~98: the `displayName` field in `projects.push({...})`
- `worker/index.ts` line ~38: the `displayName` field in `getProjects()`
- `src/App.css` `.sidebar-project-name`: add left-truncation support
- `src/App.tsx` `Sidebar` component: pass full path as tooltip on project header

## Key Technical Decisions

- **`shared-utils.mjs`**: plain ESM at repo root; local-server imports `./shared-utils.mjs`, daemon imports `../shared-utils.mjs`
- **Capabilities pattern**: `useCapabilities()` fetches `/api/capabilities` once on mount; local opts in, worker 404s → false. To add a new local-only feature: add field to `Capabilities` interface + return from local server + gate UI on flag
- **`firstName`**: XML-stripped first real user message, max 100 chars (daemon uses 80 — minor inconsistency). `displayName` = `customName || firstName || id.slice(0,8)`
- **Project path encoding**: lossy — hyphens in dir names are indistinguishable from encoded slashes. Do NOT attempt lossless decode; best effort display is sufficient

## Gotchas & Traps

- **Hyphen/slash ambiguity**: `-` in stored project keys could be either a path separator or a literal hyphen in a directory name. Never do `.replace(/-/g, "/")` blindly.
- **`displayName` must be updated in both places**: `local-server.mjs` AND `worker/index.ts`. They currently have the same broken transform.
- **CSS `text-overflow: ellipsis` truncates right, not left**. For left-truncation use `direction: rtl; text-overflow: ellipsis` on the element, but this reverses text rendering. A safer approach: truncate in JS (compute a shortened string) or use a `<span>` with the full string and CSS `direction: rtl` trick carefully.
- **`.sidebar-project-name` already has `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`** — just needs direction fix for left-truncation.
- **Tooltip on project headers**: currently uses `title={project.path}` which is the encoded key. Should show decoded/human-readable path.
- **`messages-scroll` top padding is 28px intentionally** — don't reduce it; the first message timestamp sits at `top: -20px` and would be hidden by the session header otherwise.
