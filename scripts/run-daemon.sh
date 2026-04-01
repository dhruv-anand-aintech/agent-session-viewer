#!/usr/bin/env bash
# Session viewer sync daemon — used by launchd and can be run manually.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  . "$HOME/.nvm/nvm.sh"
fi
exec node "$ROOT/daemon/watch.mjs"
