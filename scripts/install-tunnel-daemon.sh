#!/usr/bin/env bash
# Install cloudflared named tunnel as a user LaunchAgent (http2 edge protocol).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.dhruvanand.agent-session-viewer.tunnel"
PLIST_SRC="$ROOT/scripts/${LABEL}.plist"
LA_DIR="$HOME/Library/LaunchAgents"
LA_PLIST="$LA_DIR/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
UID_NUM="$(id -u)"

CLOUDFLARED="$(command -v cloudflared || true)"
if [[ -z "$CLOUDFLARED" ]]; then
  echo "cloudflared not found — install: brew install cloudflared" >&2
  exit 1
fi

mkdir -p "$LA_DIR" "$LOG_DIR"

sed -e "s|CLOUDFLARED_PLACEHOLDER|$CLOUDFLARED|g" \
    -e "s|LOG_PLACEHOLDER|$LOG_DIR|g" \
    "$PLIST_SRC" > "$LA_PLIST"

if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
  launchctl bootout "gui/${UID_NUM}" "$LA_PLIST" 2>/dev/null || launchctl unload "$LA_PLIST" 2>/dev/null || true
  sleep 1
fi

launchctl bootstrap "gui/${UID_NUM}" "$LA_PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}"

echo "Installed: $LA_PLIST"
echo "Tunnel:  agent-session-viewer (protocol http2)"
echo "Logs:    $LOG_DIR/agent-session-viewer-tunnel.err.log"
echo "Restart: launchctl kickstart -k gui/${UID_NUM}/${LABEL}"
