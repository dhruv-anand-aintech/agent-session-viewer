#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y ca-certificates curl git python3 python3-venv

install -d -m 0755 /opt/asv-agent/bin /opt/asv-agent/work

AGL_INSTALL_URL="$(
  curl -fsS -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/attributes/AGL_INSTALL_URL' 2>/dev/null || true
)"

if [[ -n "${AGL_INSTALL_URL:-}" ]]; then
  curl -fsSL "$AGL_INSTALL_URL" -o /opt/asv-agent/bin/agent-launch
  chmod +x /opt/asv-agent/bin/agent-launch
  ln -sf /opt/asv-agent/bin/agent-launch /usr/local/bin/agl
fi

cat >/opt/asv-agent/README.txt <<'EOF'
This VM is intentionally minimal for the Google Cloud Always Free e2-micro tier.

Install the coding-agent CLIs you want, authenticate them manually, then run:
  agl --help

Recommended: keep long-lived session data synced to Agent Session Viewer through
the local broadcaster rather than storing large archives on the VM boot disk.
EOF
