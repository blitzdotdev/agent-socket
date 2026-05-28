#!/usr/bin/env bash
# packages/agent-socket/scripts/deploy.sh
#
# Single entry point for ALL wrangler operations on the agent-socket relay.
# Use this script for first deploys, redeploys, log tailing, rollback —
# anything that would otherwise be a wrangler command. Do NOT invoke
# `wrangler` directly elsewhere.
#
# Credentials come from `.env` at the repo root (CLOUDFLARE_API_TOKEN).
# Copy `.env.example` to `.env` and fill in. No interactive wrangler-login
# is required. account_id lives in relay/wrangler.jsonc (single source of
# truth); the env var is not used.
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
# Production URL: https://agentsocket.dev (also aliased to aisocket.dev)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELAY_DIR="$REPO_ROOT/relay"
ENV_FILE="$REPO_ROOT/.env"
WRANGLER_CONFIG="$RELAY_DIR/wrangler.jsonc"
PROD_URL="https://agentsocket.dev"
PROD_URL_ALIAS="https://aisocket.dev"

# Optional safety check: if .env sets EXPECTED_ACCOUNT_ID, it must match
# the account_id in wrangler.jsonc — prevents an accidentally-edited
# wrangler config from deploying to a wrong account. Forks should set
# this to their own account-id once past their first deploy.
EXPECTED_ACCOUNT_ID="${EXPECTED_ACCOUNT_ID:-}"

# Strip // comments (only line-leading ones, so we don't munge URL strings
# that contain `://`) from wrangler.jsonc, then jq for the field. Portable
# across BSD sed (macOS) and GNU sed (Linux): uses POSIX character classes
# only, no GNU-isms (\s, \d, \b, --posix). Multi-line /* */ comments and
# trailing commas are not supported — switch to `jsonc-parser` via Node
# if you ever need them.
jsonc_field() {
  local field="$1"
  sed -E 's,^[[:space:]]*//.*,,' "$WRANGLER_CONFIG" | jq -r ".$field // empty"
}

# ── helpers ───────────────────────────────────────────────────────────

usage() {
  awk '/^# Subcommands:/,/^# Production URL/' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
  exit "${1:-0}"
}

load_creds() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "missing creds file: $ENV_FILE" >&2
    echo "  copy .env.example to .env and fill in CLOUDFLARE_API_TOKEN" >&2
    exit 1
  fi
  CLOUDFLARE_API_TOKEN=$(awk -F= '/^CLOUDFLARE_API_TOKEN=/ {sub(/^[^=]*=/, ""); print}' "$ENV_FILE")
  if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "missing CLOUDFLARE_API_TOKEN in $ENV_FILE" >&2
    exit 1
  fi

  # The account_id lives in wrangler.jsonc (single source of truth).
  # Parse it for the safety check below; wrangler itself reads it
  # directly from wrangler.jsonc when running deploy.
  local cfg_account_id
  cfg_account_id=$(jsonc_field "account_id")
  if [ -z "$cfg_account_id" ]; then
    echo "wrangler.jsonc has no account_id field" >&2
    exit 1
  fi

  # Optional safety: if .env sets EXPECTED_ACCOUNT_ID, the config must match.
  local expectedFromEnv
  expectedFromEnv=$(awk -F= '/^EXPECTED_ACCOUNT_ID=/ {sub(/^[^=]*=/, ""); print}' "$ENV_FILE")
  [ -n "$expectedFromEnv" ] && EXPECTED_ACCOUNT_ID="$expectedFromEnv"
  if [ -n "$EXPECTED_ACCOUNT_ID" ] && [ "$cfg_account_id" != "$EXPECTED_ACCOUNT_ID" ]; then
    echo "account mismatch — wrangler.jsonc has $cfg_account_id, expected $EXPECTED_ACCOUNT_ID" >&2
    echo "(refusing to proceed; either edit wrangler.jsonc or unset EXPECTED_ACCOUNT_ID in .env)" >&2
    exit 1
  fi

  export CLOUDFLARE_API_TOKEN
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
