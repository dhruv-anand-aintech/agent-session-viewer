#!/usr/bin/env bash
# Persistent local-server daemon — serves the session viewer UI + API.
# Used by launchd; can also be run manually.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  . "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

export PORT="${PORT:-3001}"
export HOST="${HOST:-127.0.0.1}"
# Perf / trace logging: DEBUG=1 node local-server.mjs  (or set in launchd plist EnvironmentVariables)
exec node --max-old-space-size=1024 "$ROOT/local-server.mjs"
