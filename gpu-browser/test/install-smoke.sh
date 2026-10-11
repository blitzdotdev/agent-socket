#!/bin/sh
# Installs the GPU browser for real, starts it, uses the link like an agent,
# stops it and uninstalls it, checking that nothing is left. For CI runners
# (passwordless sudo, throwaway machines); don't run it on a machine where you
# use the GPU browser, since it ends with an uninstall.
#   sh gpu-browser/test/install-smoke.sh
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
CLI="node $HERE/bin/agent-socket-gpu-browser.mjs"
NAME=agent-socket-gpu-browser
LOG=$(mktemp)
fail() {
  echo "FAIL: $*" >&2
  echo "--- CLI output:" >&2; cat "$LOG" >&2 || true
  [ -z "${cli:-}" ] || kill -INT "$cli" 2>/dev/null || true
  exit 1
}

echo "== install"
$CLI install --yes
$CLI install --yes | grep -q "already installed" || fail "a second install should be a no-op"

echo "== status"
$CLI status | tee "$LOG"
grep -q "sudo rule: active" "$LOG" || fail "the sudo rule isn't active"
[ "$(sudo grep -c NOPASSWD "/etc/sudoers.d/zz-$NAME")" = 1 ] || fail "the sudo rule should hold exactly one command"

echo "== start, and use the link like an agent"
$CLI --for 5m > "$LOG" 2>&1 &
cli=$!
i=0
until grep -q "/v1/t/as_" "$LOG"; do
  i=$((i + 1)); [ "$i" -lt 180 ] || fail "no link after 3 minutes"
  kill -0 "$cli" 2>/dev/null || fail "the CLI exited"
  sleep 1
done
link=$(grep -o 'https://[^ ]*/v1/t/as_[^ ]*/agents.md' "$LOG" | head -1)
echo "link: $link"
node - "$link" <<'EOF' || fail "an agent call failed (above)"
const base = process.argv[2].replace(/\/agents\.md$/, "")
const call = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })
  return { s: r.status, j: await r.json() }
}
const ok = (c, what, extra) => { if (!c) { console.error("FAIL:", what, JSON.stringify(extra)); process.exit(1) } console.log("ok:", what) }
const info = await call("GET", "/info")
ok(info.s === 200 && info.j.isolation.installed && info.j.isolation.chromium_sandbox && info.j.isolation.account === "agent-socket-gpu-browser",
  "runs installed, as the account, with Chromium's sandbox", info.j.isolation)
console.log("GPU:", info.j.gpu.renderer, info.j.gpu.software ? "(software)" : "")
await call("POST", "/files", { files: [{ path: "index.html", data: "<canvas id=c width=320 height=200></canvas><script>const g=document.getElementById('c').getContext('webgl2');g.clearColor(0,.5,1,1);g.clear(g.COLOR_BUFFER_BIT)</script>" }] })
const pg = await call("POST", "/page", { width: 320, height: 200 })
ok(pg.s === 200 && pg.j.http_status === 200, "opens an uploaded page", pg.j)
const shot = await call("POST", "/screenshot", { page: pg.j.page })
ok(shot.s === 200 && shot.j.bytes > 100, "takes a screenshot", { s: shot.s, bytes: shot.j.bytes })
const lo = await call("POST", "/eval", { page: pg.j.page, js: "try { await fetch('http://127.0.0.1/', { mode: 'no-cors' }); return 'reached' } catch { return 'blocked' }" })
ok((lo.j.blocked || []).some((b) => b.host === "127.0.0.1"), "loopback is blocked", lo.j)
EOF

echo "== stop"
kill -INT "$cli"
i=0
while kill -0 "$cli" 2>/dev/null; do i=$((i + 1)); [ "$i" -lt 20 ] || fail "the CLI didn't stop"; sleep 1; done
sleep 2
node -e 'fetch(process.argv[1].replace(/agents\.md$/, "info")).then(async (r) => { const t = await r.text(); if (!/not connected/.test(t)) { console.error("FAIL: link still alive:", r.status, t.slice(0, 200)); process.exit(1) } console.log("ok: the link is dead") })' "$link"
pgrep -f "/opt/$NAME/app/server.mjs" >/dev/null && fail "the server is still running"

echo "== uninstall"
$CLI uninstall --yes
id "$NAME" >/dev/null 2>&1 && fail "the account is still there"
[ ! -e "/opt/$NAME" ] || fail "/opt/$NAME is still there"
[ ! -e "/etc/sudoers.d/zz-$NAME" ] || fail "the sudo rule is still there"
[ ! -e "/etc/apparmor.d/$NAME" ] || fail "the AppArmor profile is still there"
rm -f "$LOG"
echo "PASS"
