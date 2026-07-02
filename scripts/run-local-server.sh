#!/usr/bin/env bash
# Persistent local-server daemon — serves the session viewer UI + API.
# Used by launchd; can also be run manually.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" && -x "$HOME/.nvm/versions/node/v22.22.0/bin/node" ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/v22.22.0/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node)"
fi

export PORT="${PORT:-3001}"
export HOST="${HOST:-127.0.0.1}"
# Perf / trace logging: DEBUG=1 node local-server.mjs  (or set in launchd plist EnvironmentVariables)
exec "$NODE_BIN" --max-old-space-size=1024 "$ROOT/local-server.mjs"
