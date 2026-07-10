# Agent Session Viewer for macOS

Native setup and background sync companion for Agent Session Viewer.

The app accepts a one-time `asv://connect#cloud=...&pairing=...` link from the signed-in website, claims a machine token, and installs a per-user LaunchAgent. The helper reads the existing local ASV API and falls back to Claude/Codex transcript files when the local viewer is closed.

```bash
swift test
./script/build_and_run.sh --verify
./script/package_release.sh
```

Configuration and status live in `~/Library/Application Support/AgentSessionViewer/` with owner-only permissions. The token is never placed in the URL handler registration, LaunchAgent plist, or process arguments.

The package script signs the nested helper and app with stable ad-hoc identifiers, verifies the resulting bundle, and writes `public/downloads/AgentSessionViewer-macOS.zip`.
