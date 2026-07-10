#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
DOWNLOAD_DIR="$REPO_ROOT/public/downloads"
ARCHIVE="$DOWNLOAD_DIR/AgentSessionViewer-macOS.zip"

"$ROOT_DIR/script/build_and_run.sh" --package
mkdir -p "$DOWNLOAD_DIR"
rm -f "$ARCHIVE"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$ROOT_DIR/dist/AgentSessionViewer.app" "$ARCHIVE"
/usr/bin/ditto -x -k "$ARCHIVE" "$ROOT_DIR/dist/archive-check"
/usr/bin/codesign --verify --deep --strict --verbose=1 "$ROOT_DIR/dist/archive-check/AgentSessionViewer.app"
rm -rf "$ROOT_DIR/dist/archive-check"
echo "$ARCHIVE"
