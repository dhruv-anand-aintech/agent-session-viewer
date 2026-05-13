#!/usr/bin/env bash
# Remove the centralized rate-limit watcher and stop the LaunchAgent.
set -euo pipefail
LABEL="com.dhruvanand.agent-session-viewer.rate-limit-watch"
LA_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
RUNNER_DIR="$HOME/.config/agent-session-viewer/rate-limit"
UID_NUM="$(id -u)"

if [[ -f "$LA_PLIST" ]]; then
  launchctl bootout "gui/${UID_NUM}" "$LA_PLIST" 2>/dev/null || launchctl unload "$LA_PLIST" 2>/dev/null || true
  rm -f "$LA_PLIST"
  echo "Removed $LA_PLIST"
else
  echo "No plist at $LA_PLIST (nothing to uninstall)"
fi

if [[ -d "$RUNNER_DIR" ]]; then
  rm -rf "$RUNNER_DIR"
  echo "Removed $RUNNER_DIR"
fi
