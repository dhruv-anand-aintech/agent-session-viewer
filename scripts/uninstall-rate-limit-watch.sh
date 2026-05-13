#!/usr/bin/env bash
# Remove the centralized rate-limit watcher and stop the LaunchAgent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.dhruvanand.agent-session-viewer.rate-limit-watch"
LA_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

if [[ -f "$LA_PLIST" ]]; then
  launchctl bootout "gui/${UID_NUM}" "$LA_PLIST" 2>/dev/null || launchctl unload "$LA_PLIST" 2>/dev/null || true
  rm -f "$LA_PLIST"
  echo "Removed $LA_PLIST"
else
  echo "No plist at $LA_PLIST (nothing to uninstall)"
fi
