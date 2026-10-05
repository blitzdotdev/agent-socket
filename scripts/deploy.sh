#!/usr/bin/env bash
# Deploy the agent-socket relay.
#
#   deploy   load CLOUDFLARE_API_TOKEN from .env, wrangler deploy, smoke test
#   smoke    smoke-test the production URLs
#   dev      local wrangler dev (extra args are passed through)
#
# account_id lives in relay/wrangler.jsonc.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_DIR="$REPO_ROOT/relay"
ENV_FILE="$REPO_ROOT/.env"

smoke_test() {
  local fail=0 base path want got
  for base in https://agentsocket.dev https://aisocket.dev; do
    echo "── smoke test: $base"
    while read -r path want; do
      got=$(curl -s -o /dev/null -w "%{http_code}" "$base$path")
      if [ "$got" = "$want" ]; then
        printf "  ok    %-40s → %s\n" "$path" "$got"
      else
        printf "  FAIL  %-40s → %s (wanted %s)\n" "$path" "$got" "$want"
        fail=1
      fi
    done <<'CHECKS'
/v1/t/notarealtoken00000/agents.md 404
/v1/_ws 400
/ 200
/no-such-route 404
CHECKS
  done
  [ "$fail" = "0" ] || { echo "smoke test failed" >&2; return 1; }
}

case "${1:-}" in
  deploy)
    [ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy .env.example and set CLOUDFLARE_API_TOKEN)" >&2; exit 1; }
    set -a; . "$ENV_FILE"; set +a
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "CLOUDFLARE_API_TOKEN not set in $ENV_FILE" >&2; exit 1; }
    cd "$RELAY_DIR" && npx wrangler deploy
    smoke_test
    ;;
  smoke) smoke_test ;;
  dev) cd "$RELAY_DIR" && exec npx wrangler dev "${@:2}" ;;
  *) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
