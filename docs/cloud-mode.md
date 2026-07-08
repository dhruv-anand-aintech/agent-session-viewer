# Agent Session Viewer Cloud Mode

Cloud mode makes `agent-session-viewer.ainorthstar.tech` a Google-login site backed by Cloudflare Worker, D1, and R2. Local machines or cloud runners push transcript snapshots with a machine token.

## Free-tier choices

- Cloudflare R2 stores transcript JSON. R2's Standard free tier includes 10 GB-month storage, 1 million Class A operations, 10 million Class B operations, and free egress.
- Cloudflare D1 stores users, machine tokens, and a small command queue.
- Google Cloud Compute Engine runner uses one non-preemptible `e2-micro` in `us-west1`, `us-central1`, or `us-east1`, with up to 30 GB-months standard persistent disk and 1 GB/month outbound data transfer.

## Cloudflare setup

```bash
npx wrangler d1 create agent-session-viewer-auth
npx wrangler r2 bucket create agent-session-viewer-sessions
npx wrangler d1 execute agent-session-viewer-auth --file worker/schema.sql
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

Set `GOOGLE_CLIENT_ID` and the D1/R2 bindings in `wrangler.toml`, then deploy:

```bash
npm run build
npx wrangler deploy
```

Create a Google OAuth web client with redirect URI:

```text
https://agent-session-viewer.ainorthstar.tech/api/auth/google/callback
```

## Register a machine

After signing in, call:

```bash
curl -sS -X POST https://agent-session-viewer.ainorthstar.tech/api/machines \
  -H 'content-type: application/json' \
  --cookie 'asv_session=...' \
  -d '{"label":"D MacBook"}'
```

The response includes `machineId` and `token`. Store the token locally:

```bash
export ASV_CLOUD_URL=https://agent-session-viewer.ainorthstar.tech
export ASV_MACHINE_TOKEN=asv_...
npm run cloud:broadcast -- --watch
```

The broadcaster pushes `/api/projects` plus recent message tails to R2 and polls `/api/cloud/poll` for queued commands.

## GCP e2-micro runner

The helper script keeps to the published Always Free guardrails:

```bash
export GCP_PROJECT=your-project-id
export GCP_ASV_ZONE=us-central1-a
npm run gcp:create-agent-vm
```

If `agl` is not otherwise installed on the VM, provide a private script URL:

```bash
export AGL_INSTALL_URL=https://example.com/private/agent-launch
npm run gcp:create-agent-vm
```

Install and authenticate the specific coding-agent CLIs on that VM before using it as an execution provider.

## Tunnel hostname split

Use the public Worker for:

```text
agent-session-viewer.ainorthstar.tech
```

Move this machine's direct Cloudflare Tunnel to a separate hostname such as:

```text
asv-dhruv.ainorthstar.tech
```

Then set Worker `LOCAL_AGENT_BASE_URL=https://asv-dhruv.ainorthstar.tech` only if you want the public site to proxy agent execution to this local machine.
