#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y ca-certificates curl git python3 python3-venv nodejs npm
npm install -g n
n 22
hash -r

install -d -m 0755 /opt/asv-agent/bin /opt/asv-agent/work

if ! id asvagent >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash asvagent
fi

metadata() {
  curl -fsS -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true
}

AGL_INSTALL_URL="$(metadata AGL_INSTALL_URL)"
ASV_REPO_URL="$(metadata ASV_REPO_URL)"
ASV_RUNNER_TOKEN="$(metadata ASV_RUNNER_TOKEN)"
CLOUDFLARED_TOKEN="$(metadata CLOUDFLARED_TOKEN)"

if [[ -n "${AGL_INSTALL_URL:-}" ]]; then
  curl -fsSL "$AGL_INSTALL_URL" -o /opt/asv-agent/bin/agent-launch
  chmod +x /opt/asv-agent/bin/agent-launch
  ln -sf /opt/asv-agent/bin/agent-launch /usr/local/bin/agl
else
  npm install -g github:dhruv-anand-aintech/agent-launch
fi

npm install -g @anthropic-ai/claude-code

if [[ -z "${ASV_REPO_URL:-}" ]]; then
  ASV_REPO_URL="https://github.com/dhruv-anand-aintech/agent-session-viewer.git"
fi

if [[ ! -d /opt/asv-agent/agent-session-viewer/.git ]]; then
  git clone "$ASV_REPO_URL" /opt/asv-agent/agent-session-viewer
else
  git -C /opt/asv-agent/agent-session-viewer pull --ff-only
fi

chown -R asvagent:asvagent /opt/asv-agent

cat >/etc/systemd/system/asv-agent-runner.service <<EOF
[Unit]
Description=Agent Session Viewer AGL runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=asvagent
WorkingDirectory=/opt/asv-agent/agent-session-viewer
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=ASV_RUNNER_HOST=127.0.0.1
Environment=ASV_RUNNER_PORT=3002
Environment=ASV_RUNNER_TOKEN=${ASV_RUNNER_TOKEN}
ExecStart=/usr/bin/env node /opt/asv-agent/agent-session-viewer/scripts/asv-agent-runner.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now asv-agent-runner.service

if [[ -n "${CLOUDFLARED_TOKEN:-}" ]]; then
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  install -d -m 0700 /etc/cloudflared
  printf '%s' "$CLOUDFLARED_TOKEN" >/etc/cloudflared/asv-gcp-runner.token
  chmod 0600 /etc/cloudflared/asv-gcp-runner.token

  cat >/etc/systemd/system/cloudflared.service <<EOF
[Unit]
Description=cloudflared tunnel for ASV GCP runner
After=network-online.target asv-agent-runner.service
Wants=network-online.target
Requires=asv-agent-runner.service

[Service]
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --url http://127.0.0.1:3002 run --token-file /etc/cloudflared/asv-gcp-runner.token
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now cloudflared.service
fi

cat >/opt/asv-agent/README.txt <<'EOF'
This VM is intentionally minimal for the Google Cloud Always Free e2-micro tier.

Claude Code, agent-launch/agl, and the ASV runner service are installed.

Authenticate Claude Code once as the asvagent user, then verify:
  agl -a claude -n -m ask -C /opt/asv-agent/work -p "say ok"
  systemctl status asv-agent-runner
  curl -H "authorization: Bearer $ASV_RUNNER_TOKEN" http://127.0.0.1:3002/api/agent/providers
  curl https://asv-gcp-runner.ainorthstar.tech/api/health

Recommended: keep long-lived session data synced to Agent Session Viewer through
the local broadcaster rather than storing large archives on the VM boot disk.
EOF
