#!/usr/bin/env bash
# Install the centralized rate-limit watcher as a user LaunchAgent (launchctl).
set -euo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
LABEL="com.dhruvanand.agent-session-viewer.rate-limit-watch"
PLIST_SRC="$ROOT/scripts/${LABEL}.plist"
RUNNER_DIR="$HOME/.config/agent-session-viewer/rate-limit"
LA_DIR="$HOME/Library/LaunchAgents"
LA_PLIST="$LA_DIR/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
UID_NUM="$(id -u)"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"

mkdir -p "$RUNNER_DIR" "$LOG_DIR"
install -m 755 "$ROOT/scripts/rate-limit-transcript-watcher.py" "$RUNNER_DIR/rate-limit-transcript-watcher.py"
install -m 755 "$ROOT/scripts/rate-limit-alarm.py" "$RUNNER_DIR/rate-limit-alarm.py"
install -m 755 "$ROOT/scripts/gemini-transcript-archive-hook.py" "$RUNNER_DIR/gemini-transcript-archive-hook.py"
"$PYTHON_BIN" "$ROOT/scripts/install-gemini-transcript-archive-hook.py"
sed -e "s|RUNNER_DIR_PLACEHOLDER|$RUNNER_DIR|g" "$PLIST_SRC" \
  | sed -e "s|LOG_PLACEHOLDER|$LOG_DIR|g" \
  | sed -e "s|PYTHON_BIN_PLACEHOLDER|$PYTHON_BIN|g" > "$LA_PLIST"

if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
  launchctl bootout "gui/${UID_NUM}" "$LA_PLIST" 2>/dev/null || launchctl unload "$LA_PLIST" 2>/dev/null || true
  sleep 1
fi

launchctl bootstrap "gui/${UID_NUM}" "$LA_PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}"

echo "Installed: $LA_PLIST"
echo "Runner: $RUNNER_DIR"
echo "Python: $PYTHON_BIN"
echo "Logs: $LOG_DIR/agent-session-viewer-rate-limit-watch.log"
echo "Restart: launchctl kickstart -k gui/${UID_NUM}/${LABEL}"
echo "Stop:    launchctl bootout gui/${UID_NUM} $LA_PLIST"
