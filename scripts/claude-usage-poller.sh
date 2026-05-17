#!/bin/bash
# Polls `claude /usage` every N minutes and writes parsed data to a cache file.
# Must run in a real terminal (has a TTY). Add to cron:
#   */5 * * * * /path/to/claude-usage-poller.sh
# Or run manually: bash scripts/claude-usage-poller.sh

INTERVAL="${CLAUDE_USAGE_POLL_INTERVAL:-300}"
CACHE_FILE="${HOME}/.config/agent-session-viewer/claude-usage-cache.json"
mkdir -p "$(dirname "$CACHE_FILE")"

poll_once() {
  local TMP
  TMP=$(mktemp /tmp/claude_usage_XXXX.txt)
  script -q /dev/null claude /usage > "$TMP" 2>&1
  python3 - "$TMP" "$CACHE_FILE" << 'PYEOF'
import sys, re, json, time
raw = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace')
text = re.sub(r'\x1B(?:[@-Z\\\-_]|\[[0-?]*[ -/]*[@-~])', '', raw).replace('\r', '')
result = {'fetchedAt': int(time.time() * 1000)}
m = re.search(r'Current session[\s\S]{0,400}?(\d+)%\s*used', text)
if m: result['sessionPct'] = int(m.group(1))
m2 = re.search(r'Rese[st]s?\s*([\d][\d:]+[ap]m[^\n]*)', text)
if m2: result['sessionResetsAt'] = re.sub(r'\s+', ' ', m2.group(1)).strip()
m3 = re.search(r'Current\s*week[\s\S]{0,400}?(\d+)%\s*used', text)
if m3: result['weeklyPct'] = int(m3.group(1))
m4 = re.search(r'Resets\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*\d+[^\n]{0,60})', text)
if m4: result['weeklyResetsAt'] = re.sub(r'\s+', ' ', m4.group(1)).strip()
if len(result) > 1:
    open(sys.argv[2], 'w').write(json.dumps(result))
    print(f"[claude-usage] {json.dumps(result)}")
else:
    print("[claude-usage] No data parsed — script may not have a TTY")
PYEOF
  rm -f "$TMP"
}

if [[ "${1}" == "--once" ]]; then
  poll_once
else
  echo "[claude-usage] Polling every ${INTERVAL}s. Ctrl-C to stop."
  while true; do
    poll_once
    sleep "$INTERVAL"
  done
fi
