#!/usr/bin/env bash
# Ping the public tunnel URL so cloudflared + origin stay warm (no auth required).
set -euo pipefail
URL="${TUNNEL_URL:-https://agent-session-viewer.ainorthstar.tech}/api/health"
/usr/bin/curl -sf -m 15 -o /dev/null "$URL"
