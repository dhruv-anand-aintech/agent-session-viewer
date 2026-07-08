#!/usr/bin/env bash
set -euo pipefail

PROJECT="${GCP_PROJECT:-}"
NAME="${GCP_ASV_VM_NAME:-asv-agent-runner}"
ZONE="${GCP_ASV_ZONE:-us-central1-a}"
MACHINE_TYPE="${GCP_ASV_MACHINE_TYPE:-e2-micro}"
DISK_SIZE="${GCP_ASV_DISK_SIZE:-30GB}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
METADATA_PAIRS=()

if [[ -n "${AGL_INSTALL_URL:-}" ]]; then
  METADATA_PAIRS+=("AGL_INSTALL_URL=${AGL_INSTALL_URL}")
fi

if [[ -n "${ASV_REPO_URL:-}" ]]; then
  METADATA_PAIRS+=("ASV_REPO_URL=${ASV_REPO_URL}")
fi

if [[ -n "${ASV_RUNNER_TOKEN:-}" ]]; then
  METADATA_PAIRS+=("ASV_RUNNER_TOKEN=${ASV_RUNNER_TOKEN}")
fi

if [[ -n "${CLOUDFLARED_TOKEN:-}" ]]; then
  METADATA_PAIRS+=("CLOUDFLARED_TOKEN=${CLOUDFLARED_TOKEN}")
fi

METADATA_ARGS=()
if (( ${#METADATA_PAIRS[@]} > 0 )); then
  METADATA_ARGS=(--metadata "$(IFS=,; echo "${METADATA_PAIRS[*]}")")
fi

if [[ -z "$PROJECT" ]]; then
  echo "Set GCP_PROJECT before running this script." >&2
  exit 2
fi

cat <<EOF
Creating ${NAME} in ${ZONE}.

Free-tier guardrails:
- machine type: ${MACHINE_TYPE}
- region must be us-west1, us-central1, or us-east1
- standard persistent disk <= ${DISK_SIZE}
- network tier: STANDARD

EOF

gcloud compute instances create "$NAME" \
  --project "$PROJECT" \
  --zone "$ZONE" \
  --machine-type "$MACHINE_TYPE" \
  --provisioning-model STANDARD \
  --image-family debian-12 \
  --image-project debian-cloud \
  --boot-disk-size "$DISK_SIZE" \
  --boot-disk-type pd-standard \
  --network-interface network-tier=STANDARD \
  --metadata-from-file startup-script="${ROOT_DIR}/scripts/gcp-agent-vm-startup.sh" \
  "${METADATA_ARGS[@]}" \
  --labels app=agent-session-viewer,role=agent-runner
