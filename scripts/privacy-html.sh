#!/usr/bin/env bash
# Regenerate relay/public/privacy.html from PRIVACY.md (served at /privacy).
set -euo pipefail
cd "$(dirname "$0")/.."
out=relay/public/privacy.html
{
  sed -n '1,/^<h1>/p' "$out"
  sed 1d PRIVACY.md | npx -y marked@14
  printf '</body>\n</html>\n'
} > "$out.tmp"
mv "$out.tmp" "$out"
