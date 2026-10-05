#!/usr/bin/env bash
# Deploy the agent-socket relay.
#
#   deploy   load .env, wrangler deploy --env production, smoke test
#   smoke    smoke-test the production URLs
#   dev      local wrangler dev (extra args are passed through)
#
# .env needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. SMOKE_URLS
# (space-separated) overrides the URLs the smoke test checks.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_DIR="$REPO_ROOT/relay"
ENV_FILE="$REPO_ROOT/.env"

load_env() {
  [ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy .env.example and fill it in)" >&2; exit 1; }
  set -a; . "$ENV_FILE"; set +a
  local v
  for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
    [ -n "${!v:-}" ] || { echo "$v not set in $ENV_FILE" >&2; exit 1; }
  done
}

smoke_test() {
  local fail=0 base path want got
  for base in ${SMOKE_URLS:-https://agentsocket.dev https://aisocket.dev}; do
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
    load_env
    (cd "$RELAY_DIR" && npx wrangler deploy --env production)
    smoke_test
    ;;
  smoke)
    if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
    smoke_test
    ;;
  dev) cd "$RELAY_DIR" && exec npx wrangler dev "${@:2}" ;;
  *) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
