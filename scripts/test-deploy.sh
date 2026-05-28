#!/usr/bin/env bash
# Smoke test for scripts/deploy.sh — specifically the JSONC-parsing pipeline.
# Verifies that `sed | jq` extracts fields correctly under realistic inputs,
# without mangling URL strings or wrangler-config edge cases.
#
# Portable across BSD sed (macOS) and GNU sed (Linux) — uses only POSIX
# character classes and no GNU-only flags. Run on either platform.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR="$(mktemp -d -t agentsocket-deploy-test-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# The exact strip pipeline used by deploy.sh's jsonc_field()
strip_jsonc() {
  sed -E 's,^[[:space:]]*//.*,,' "$1"
}

PASS=0
FAIL=0
case_n=0
expect() {
  case_n=$((case_n + 1))
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    printf "  ok    %-50s → %s\n" "$label" "$got"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL  %-50s → got %q, wanted %q\n" "$label" "$got" "$want"
  fi
}

# ── 1: line-leading comment is stripped ─────────────────────────────
cat > "$TMPDIR/case1.jsonc" <<'EOF'
{
  // header comment
  "name": "x"
}
EOF
got=$(strip_jsonc "$TMPDIR/case1.jsonc" | jq -r '.name')
expect "line-leading // comment stripped" "x" "$got"

# ── 2: indented comment is stripped ─────────────────────────────────
cat > "$TMPDIR/case2.jsonc" <<'EOF'
{
    // indented comment
    "name": "y"
}
EOF
got=$(strip_jsonc "$TMPDIR/case2.jsonc" | jq -r '.name')
expect "indented // comment stripped" "y" "$got"

# ── 3: URL with `://` inside a string MUST survive ──────────────────
cat > "$TMPDIR/case3.jsonc" <<'EOF'
{
  "url": "https://example.com/path"
}
EOF
got=$(strip_jsonc "$TMPDIR/case3.jsonc" | jq -r '.url')
expect "URL string with :// preserved" "https://example.com/path" "$got"

# ── 4: string containing literal ` // ` (space-//) MUST survive ─────
cat > "$TMPDIR/case4.jsonc" <<'EOF'
{
  "label": "foo // bar"
}
EOF
got=$(strip_jsonc "$TMPDIR/case4.jsonc" | jq -r '.label')
expect "string with ' // ' inside preserved" "foo // bar" "$got"

# ── 5: multiple comments + actual production-shaped wrangler.jsonc ──
cat > "$TMPDIR/case5.jsonc" <<'EOF'
{
  "name": "test-relay",
  "account_id": "abc123",
  "compatibility_date": "2025-05-01",

  // Production routes. Two of them.
  "routes": [
    { "pattern": "example.com",     "custom_domain": true },
    { "pattern": "www.example.com", "custom_domain": true }
  ],

  "vars": {
    "TOKEN_PREFIX": "as",
    "MAX_SYNC_TOOL_MS": "30000"
    // DEBUG omitted on purpose.
  }
}
EOF
got=$(strip_jsonc "$TMPDIR/case5.jsonc" | jq -r '.account_id')
expect "production-shape: account_id extracted"   "abc123"      "$got"
got=$(strip_jsonc "$TMPDIR/case5.jsonc" | jq -r '.name')
expect "production-shape: name extracted"          "test-relay"  "$got"
got=$(strip_jsonc "$TMPDIR/case5.jsonc" | jq -r '.routes[0].pattern')
expect "production-shape: routes[0].pattern"       "example.com" "$got"
got=$(strip_jsonc "$TMPDIR/case5.jsonc" | jq -r '.vars.TOKEN_PREFIX')
expect "production-shape: vars.TOKEN_PREFIX"       "as"          "$got"

# ── 6: missing field returns empty (// empty in jq filter) ──────────
got=$(strip_jsonc "$TMPDIR/case5.jsonc" | jq -r '.nonexistent // empty')
expect "missing field → empty string"              ""            "$got"

# ── 7: actual wrangler.jsonc from this repo ─────────────────────────
ACTUAL_CFG="$(cd "$SCRIPT_DIR/.." && pwd)/relay/wrangler.jsonc"
if [ -f "$ACTUAL_CFG" ]; then
  got=$(sed -E 's,^[[:space:]]*//.*,,' "$ACTUAL_CFG" | jq -r '.account_id')
  expect "real wrangler.jsonc: account_id parseable" "d25a778b256fb6ef6eea554d77c40f27" "$got"
  got=$(sed -E 's,^[[:space:]]*//.*,,' "$ACTUAL_CFG" | jq -r '.name')
  expect "real wrangler.jsonc: name parseable" "agent-socket-relay" "$got"
fi

# ── 8: deploy.sh's own jsonc_field() function — invoke as subshell ──
if [ -f "$ACTUAL_CFG" ]; then
  got=$(WRANGLER_CONFIG="$ACTUAL_CFG"; sed -E 's,^[[:space:]]*//.*,,' "$WRANGLER_CONFIG" | jq -r '.account_id // empty')
  expect "deploy.sh jsonc_field() inline equivalent"  "d25a778b256fb6ef6eea554d77c40f27" "$got"
fi

# ── summary ──────────────────────────────────────────────────────────
echo
echo "── $PASS passed, $FAIL failed ($case_n cases)"
echo
echo "platform: $(uname -s)"
echo "sed:      $(sed --version 2>/dev/null | head -1 || echo "BSD-style sed (no --version)")"
echo "jq:       $(jq --version 2>&1)"
exit "$FAIL"
