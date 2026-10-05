#!/usr/bin/env bash
# Build the Chrome Web Store / GitHub release zip at
# chrome-extension/dist/agent-socket-extension.zip (fixed name: release
# "latest/download" links depend on it). Rebuilds and re-vendors the SDK
# first, then zips only what the extension loads at runtime.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # chrome-extension/
ROOT="$HERE/.."
OUT="$HERE/dist/agent-socket-extension.zip"

npm run build -w sdk --prefix "$ROOT" >/dev/null
bash "$HERE/scripts/vendor-sdk.sh"

mkdir -p "$HERE/dist"
rm -f "$OUT"
cd "$HERE"
zip -qr "$OUT" manifest.json background.js pill.js popup.html popup.css popup.js icons lib tools-lib \
  -x "lib/sdk/VENDORED.md" "*.DS_Store"
echo "build-zip: $(unzip -Z1 "$OUT" | wc -l | tr -d ' ') files → $OUT"
