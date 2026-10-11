#!/usr/bin/env bash
# Copy the compiled SDK into gpu-browser/app/lib/sdk/, so what the server runs
# (and the harness tests) is exactly this repo's SDK, installed with the app
# and pinned with it. Same file list and rules as the Chrome extension's
# chrome-extension/scripts/vendor-sdk.sh; run after `npm run build -w sdk`
# (or just `npm run build`). CI fails on a diff.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # gpu-browser/
SDK_DIST="$HERE/../sdk/dist"
DEST="$HERE/app/lib/sdk"

if [ ! -d "$SDK_DIST" ]; then
  echo "vendor-sdk: SDK dist not found at $SDK_DIST — run 'npm run build -w sdk' first" >&2
  exit 1
fi

files=(index.js session.js transport.js backoff.js agents-md.js preamble.js heartbeat.js types.js)
for f in "${files[@]}"; do
  if [ ! -f "$SDK_DIST/$f" ]; then
    echo "vendor-sdk: expected $SDK_DIST/$f missing — SDK build incomplete?" >&2
    exit 1
  fi
done

mkdir -p "$DEST"
rm -f "$DEST"/*.js
for f in "${files[@]}"; do
  cp "$SDK_DIST/$f" "$DEST/$f"
done

cat > "$DEST/VENDORED.md" <<MD
# Vendored SDK

Files in this directory are mechanically copied from \`../../../sdk/dist/\`
(the \`@agent-socket/sdk\` in this repo), so the GPU browser server runs the
SDK it was tested with.

**Do not edit them directly** — changes will be overwritten next time
\`gpu-browser/scripts/vendor-sdk.sh\` runs.

To refresh after changing the SDK source:

\`\`\`
npm run build      # builds the SDK and vendors it here and into the extension
\`\`\`

CI fails if the vendored files drift from \`sdk/dist/\`.
MD

echo "vendor-sdk: copied ${#files[@]} files into $DEST/"
