# Agent Session Viewer Cloud Mode

Cloud mode makes `agent-session-viewer.ainorthstar.tech` a Google-login site backed by Cloudflare Worker, D1, and Google Cloud Storage. Local machines or cloud runners push transcript snapshots with a machine token.

## Free-tier choices

- Google Cloud Storage stores transcript JSON. The free tier includes 5 GB-month regional storage in `us-east1`, `us-west1`, or `us-central1`, 5,000 Class A operations/month, 50,000 Class B operations/month, and 100 GB/month outbound transfer from North America excluding China and Australia.
- Cloudflare D1 stores users, machine tokens, and a small command queue.
- Google Cloud Compute Engine runner uses one non-preemptible `e2-micro` in `us-west1`, `us-central1`, or `us-east1`, with up to 30 GB-months standard persistent disk and 1 GB/month outbound data transfer.

## Cloudflare setup

```bash
npx wrangler d1 create agent-session-viewer-auth
npx wrangler d1 execute agent-session-viewer-auth --file worker/schema.sql
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GCP_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GCP_PRIVATE_KEY
```

Create a regional GCS bucket and service account:

```bash
gcloud storage buckets create gs://agent-session-viewer-sessions-<project> --location=us-central1 --uniform-bucket-level-access
gcloud iam service-accounts create asv-storage-writer --display-name="ASV storage writer"
gcloud storage buckets add-iam-policy-binding gs://agent-session-viewer-sessions-<project> \
  --member=serviceAccount:asv-storage-writer@<project>.iam.gserviceaccount.com \
  --role=roles/storage.objectAdmin
gcloud iam service-accounts keys create /tmp/asv-storage-writer.json \
  --iam-account=asv-storage-writer@<project>.iam.gserviceaccount.com
```

Set `GOOGLE_CLIENT_ID`, `GCS_BUCKET`, and the D1 binding in `wrangler.toml`, then deploy:

```bash
npm run build
npx wrangler deploy
```

Create a Google OAuth web client with redirect URI:

```text
https://agent-session-viewer.ainorthstar.tech/api/auth/google/callback
```

## Connect the macOS app

The normal setup path is:

1. Open `https://agent-session-viewer.ainorthstar.tech/setup/mac` and sign in with Google.
2. Download and open the macOS companion.
3. Create a ten-minute pairing code on the website.
4. Open the `asv://connect#...` link. The app claims the code once, stores the returned machine credential in an owner-only config file, and installs its per-user LaunchAgent.
5. The website waits for that specific new Mac to complete its first ingest, then opens `/sessions`.

The long-lived machine token never appears in the browser URL, local LaunchAgent plist, or daemon process arguments. Pairing codes are stored only as SHA-256 hashes in D1 and cannot be replayed.

The beta release ZIP is served at:

```text
https://agent-session-viewer.ainorthstar.tech/downloads/AgentSessionViewer-macOS.zip
```

The current beta is ad-hoc signed and locally verified. Public Apple notarization still requires a Developer ID Application identity and notarization credentials.

## Register a machine manually

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
