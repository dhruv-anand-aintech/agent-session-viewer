#!/usr/bin/env bash
# Install a LaunchAgent that GETs /api/health every 3 minutes through the public tunnel.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.dhruvanand.agent-session-viewer.tunnel-warm"
PLIST_SRC="$ROOT/scripts/${LABEL}.plist"
LA_DIR="$HOME/Library/LaunchAgents"
LA_PLIST="$LA_DIR/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
UID_NUM="$(id -u)"

chmod +x "$ROOT/scripts/tunnel-warm.sh"
mkdir -p "$LA_DIR" "$LOG_DIR"

sed -e "s|ROOT_PLACEHOLDER|$ROOT|g" \
    -e "s|LOG_PLACEHOLDER|$LOG_DIR|g" \
    "$PLIST_SRC" > "$LA_PLIST"

if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
  launchctl bootout "gui/${UID_NUM}" "$LA_PLIST" 2>/dev/null || launchctl unload "$LA_PLIST" 2>/dev/null || true
  sleep 1
fi

launchctl bootstrap "gui/${UID_NUM}" "$LA_PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}"

echo "Installed: $LA_PLIST"
echo "Warmup:  curl https://agent-session-viewer.ainorthstar.tech/api/health every 180s"
echo "Logs:    $LOG_DIR/agent-session-viewer-tunnel-warm.log"
