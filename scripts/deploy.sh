#!/usr/bin/env bash
# packages/agent-socket/scripts/deploy.sh
#
# Single entry point for ALL wrangler operations on the agent-socket relay.
# Use this script for first deploys, redeploys, log tailing, rollback —
# anything that would otherwise be a wrangler command. Do NOT invoke
# `wrangler` directly elsewhere.
#
# Credentials come from packages/teenybase/backend/.env (CLOUDFLARE_API_TOKEN
# + CLOUDFLARE_ACCOUNT_ID). No interactive login is required.
#
# Subcommands:
#   deploy    Push current source to production. Idempotent — handles both
#             first deploy and updates. Runs a smoke test on completion.
#   tail      Stream live production logs.
#   rollback  Revert the relay to the previous deployed version, then
#             smoke-test that the rollback is serving.
#   status    Show recent deployments + smoke-test the production URL.
#   smoke     Smoke-test the production URL without touching deploys.
#   whoami    Verify CF credentials resolve to the expected account.
#   dev       Local `wrangler dev` (port 8787). Useful for manual testing.
#
# Production URL: https://aisocket.dev
#   (agentsocket.dev will be added as a second route once acquired.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(cd "$SCRIPT_DIR/../relay" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/packages/teenybase/backend/.env"
PROD_URL="https://agentsocket.dev"
PROD_URL_ALIAS="https://aisocket.dev"
EXPECTED_ACCOUNT_ID="d25a778b256fb6ef6eea554d77c40f27"

# ── helpers ───────────────────────────────────────────────────────────

usage() {
  awk '/^# Subcommands:/,/^# Production URL/' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
  exit "${1:-0}"
}

load_creds() {
  [ -f "$ENV_FILE" ] || { echo "missing creds file: $ENV_FILE" >&2; exit 1; }
  CLOUDFLARE_API_TOKEN=$(awk -F= '/^CLOUDFLARE_API_TOKEN=/ {sub(/^[^=]*=/, ""); print}' "$ENV_FILE")
  CLOUDFLARE_ACCOUNT_ID=$(awk -F= '/^CLOUDFLARE_ACCOUNT_ID=/ {sub(/^[^=]*=/, ""); print}' "$ENV_FILE")
  if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    echo "missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID in $ENV_FILE" >&2
    exit 1
  fi
  if [ "$CLOUDFLARE_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then
    echo "account mismatch — env has $CLOUDFLARE_ACCOUNT_ID, expected $EXPECTED_ACCOUNT_ID" >&2
    echo "(refusing to proceed in case the creds file was swapped)" >&2
    exit 1
  fi
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
}

smoke_test() {
  local fail=0
  smoke_one() {
    local base="$1"
    echo
    echo "── smoke test: $base"
    check() {
      local label="$1" path="$2" want="$3"
      local got
      got=$(curl -s -o /dev/null -w "%{http_code}" "$base$path")
      if [ "$got" = "$want" ]; then
        printf "  ok    %-32s → %s\n" "$label" "$got"
      else
        printf "  FAIL  %-32s → %s (wanted %s)\n" "$label" "$got" "$want"
        fail=1
      fi
    }
    check "unknown token /agents.md"   "/v1/t/notarealtoken00000/agents.md"   "404"
    check "/v1/_ws no upgrade headers" "/v1/_ws"                              "400"
    check "/ (landing page)"           "/"                                    "200"
    check "/not-a-route"               "/no-such-route"                       "404"
  }
  smoke_one "$PROD_URL"
  smoke_one "$PROD_URL_ALIAS"
  echo
  [ "$fail" = "0" ] || { echo "smoke test failed" >&2; return 1; }
}

# ── dispatch ──────────────────────────────────────────────────────────

cmd="${1:-}"
case "$cmd" in
  deploy)
    load_creds
    echo "── deploying agent-socket-relay → $PROD_URL"
    cd "$RELAY_DIR" && npx wrangler deploy
    smoke_test
    echo "── deploy done"
    ;;

  tail)
    load_creds
    cd "$RELAY_DIR" && exec npx wrangler tail "${@:2}"
    ;;

  rollback)
    load_creds
    echo "── rolling back agent-socket-relay"
    cd "$RELAY_DIR" && npx wrangler rollback "${@:2}"
    smoke_test
    echo "── rollback done"
    ;;

  status)
    load_creds
    cd "$RELAY_DIR" && npx wrangler deployments list 2>&1 | head -20
    smoke_test || true
    ;;

  smoke)
    smoke_test
    ;;

  whoami)
    load_creds
    cd "$RELAY_DIR" && npx wrangler whoami
    ;;

  dev)
    cd "$RELAY_DIR" && exec npx wrangler dev "${@:2}"
    ;;

  -h|--help|"")
    usage 0
    ;;

  *)
    echo "unknown subcommand: $cmd" >&2
    usage 2
    ;;
esac
