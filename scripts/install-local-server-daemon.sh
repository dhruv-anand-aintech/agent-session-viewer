#!/usr/bin/env bash
# Install the local-server as a user LaunchAgent (persistent, restart on failure).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.dhruvanand.agent-session-viewer.local-server"
PLIST_SRC="$ROOT/scripts/${LABEL}.plist"
LA_DIR="$HOME/Library/LaunchAgents"
LA_PLIST="$LA_DIR/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
UID_NUM="$(id -u)"

chmod +x "$ROOT/scripts/run-local-server.sh"
mkdir -p "$LA_DIR" "$LOG_DIR"

sed -e "s|ROOT_PLACEHOLDER|$ROOT|g" \
    -e "s|LOG_PLACEHOLDER|$LOG_DIR|g" \
    "$PLIST_SRC" > "$LA_PLIST"

# Unload if already loaded
if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
  launchctl bootout "gui/${UID_NUM}" "$LA_PLIST" 2>/dev/null || launchctl unload "$LA_PLIST" 2>/dev/null || true
  sleep 1
fi

launchctl bootstrap "gui/${UID_NUM}" "$LA_PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}"

echo "Installed: $LA_PLIST"
echo "Server:  http://localhost:3001"
echo "Logs:    $LOG_DIR/agent-session-viewer-local-server.log"
echo "Restart: launchctl kickstart -k gui/${UID_NUM}/${LABEL}"
echo "Stop:    launchctl bootout gui/${UID_NUM} $LA_PLIST"
