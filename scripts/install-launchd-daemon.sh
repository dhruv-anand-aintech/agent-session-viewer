#!/usr/bin/env bash
# Install the session viewer daemon as a user LaunchAgent (launchctl).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.dhruvanand.claude-session-viewer.daemon"
PLIST_SRC="$ROOT/scripts/${LABEL}.plist"
LA_DIR="$HOME/Library/LaunchAgents"
LA_PLIST="$LA_DIR/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
UID_NUM="$(id -u)"

chmod +x "$ROOT/scripts/run-daemon.sh"

mkdir -p "$LOG_DIR"
sed -e "s|ROOT_PLACEHOLDER|$ROOT|g" "$PLIST_SRC" | sed -e "s|LOG_PLACEHOLDER|$LOG_DIR|g" > "$LA_PLIST"

# Stop any stray manual daemon processes for this repo
pkill -f "$ROOT/daemon/watch.mjs" 2>/dev/null || true
sleep 1

if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
  launchctl bootout "gui/${UID_NUM}" "$LA_PLIST" 2>/dev/null || launchctl unload "$LA_PLIST" 2>/dev/null || true
  sleep 1
fi

launchctl bootstrap "gui/${UID_NUM}" "$LA_PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}"

echo "Installed: $LA_PLIST"
echo "Logs: $LOG_DIR/claude-session-viewer-daemon.log"
echo "Restart: launchctl kickstart -k gui/${UID_NUM}/${LABEL}"
echo "Stop:    launchctl bootout gui/${UID_NUM} $LA_PLIST"
