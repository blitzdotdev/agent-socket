#!/usr/bin/env bash
# Copy compiled SDK ES modules into chrome-extension/lib/sdk/ so the
# extension can import them directly from a load-unpacked checkout
# (no build step at install time). Run after `npm run build -w sdk`.
#
# Files vendored are checked into git so the extension is self-contained;
# CI runs this script and fails on a diff (drift guard — see ci.yml).

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # chrome-extension/
SDK_DIST="$HERE/../sdk/dist"
DEST="$HERE/lib/sdk"

if [ ! -d "$SDK_DIST" ]; then
  echo "vendor-sdk: SDK dist not found at $SDK_DIST — run 'npm run build -w sdk' first" >&2
  exit 1
fi

# Pin the file list — vendor only the runtime .js files, skip .d.ts.
files=(index.js session.js transport.js backoff.js agents-md.js preamble.js types.js)
for f in "${files[@]}"; do
  if [ ! -f "$SDK_DIST/$f" ]; then
    echo "vendor-sdk: expected $SDK_DIST/$f missing — SDK build incomplete?" >&2
    exit 1
  fi
done

mkdir -p "$DEST"
# Clear stale files first so removals in SDK propagate.
rm -f "$DEST"/*.js
for f in "${files[@]}"; do
  cp "$SDK_DIST/$f" "$DEST/$f"
done

# Record provenance.
src_sha="$(git -C "$HERE/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$DEST/VENDORED.md" <<EOF
# Vendored SDK

Files in this directory are mechanically copied from \`../../sdk/dist/\`.

**Do not edit them directly** — changes will be overwritten next time
\`chrome-extension/scripts/vendor-sdk.sh\` runs.

To refresh after changing the SDK source:

\`\`\`
npm run build -w sdk
bash chrome-extension/scripts/vendor-sdk.sh
\`\`\`

CI fails if the vendored files drift from \`sdk/dist/\`.

Last vendored from repo SHA \`$src_sha\`.
EOF

echo "vendor-sdk: copied ${#files[@]} files into $DEST/"
