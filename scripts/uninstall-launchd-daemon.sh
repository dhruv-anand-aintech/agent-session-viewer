#!/usr/bin/env bash
# Remove the LaunchAgent and stop the daemon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.dhruvanand.claude-session-viewer.daemon"
LA_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

pkill -f "$ROOT/daemon/watch.mjs" 2>/dev/null || true

if [[ -f "$LA_PLIST" ]]; then
  launchctl bootout "gui/${UID_NUM}" "$LA_PLIST" 2>/dev/null || launchctl unload "$LA_PLIST" 2>/dev/null || true
  rm -f "$LA_PLIST"
  echo "Removed $LA_PLIST"
else
  echo "No plist at $LA_PLIST (nothing to uninstall)"
fi
