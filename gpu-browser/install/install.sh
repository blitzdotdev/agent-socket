#!/bin/sh
# Installs or updates the agent-socket GPU browser. Run as root by the CLI,
# after it asked you (npx @agent-socket/gpu-browser):
#   sudo /bin/sh install.sh --user NAME --home DIR --pkg DIR --version V --hash H
# What it creates and why: README.md in this folder. Undo everything with
#   sudo sh /opt/agent-socket-gpu-browser/uninstall.sh
#
# POSIX sh: macOS runs /bin/sh as bash 3.2, Debian/Ubuntu as dash.
set -eu

NAME=agent-socket-gpu-browser
DIR=/opt/agent-socket-gpu-browser
MARK="agent-socket GPU browser"
COMMENT="$MARK - created by npx @agent-socket/gpu-browser - remove with sudo sh $DIR/uninstall.sh"
OS=$(uname -s)

say() { printf '  %s\n' "$*"; }
die() { printf 'install failed: %s\n' "$*" >&2; exit 1; }
event() { printf '@@install %s\n' "$*"; }

USER_NAME="" USER_HOME="" PKG="" VERSION="" HASH=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "missing value for $1"
  case "$1" in
    --user) USER_NAME=$2 ;;
    --home) USER_HOME=$2 ;;
    --pkg) PKG=$2 ;;
    --version) VERSION=$2 ;;
    --hash) HASH=$2 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift 2
done
[ "$(id -u)" = 0 ] || die "run as root (the CLI runs it with sudo)"
case "$OS" in Darwin|Linux) ;; *) die "macOS and Linux only" ;; esac
case "$USER_NAME" in ""|*[!A-Za-z0-9._-]*) die "--user must be a plain user name" ;; esac
id -u "$USER_NAME" >/dev/null 2>&1 || die "no user $USER_NAME"
[ "$(id -u "$USER_NAME")" != 0 ] || die "install for your own user, not root"
[ -d "$USER_HOME" ] || die "--home must be a directory"
if [ ! -f "$PKG/app/server.mjs" ] || [ ! -f "$PKG/install/node.txt" ]; then die "--pkg must be the @agent-socket/gpu-browser package"; fi
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' || die "bad --version"
printf '%s' "$HASH" | grep -Eq '^[0-9a-f]{64}$' || die "bad --hash"

# One owner per machine: the sudo rule names the user who installed it.
if [ -f "$DIR/install.env" ]; then
  owner=$(sed -n 's/^user=//p' "$DIR/install.env")
  if [ -n "$owner" ] && [ "$owner" != "$USER_NAME" ]; then
    die "already installed for $owner on this machine; they can remove it with: sudo sh $DIR/uninstall.sh"
  fi
fi

# A failed first install leaves nothing behind: whatever this run created
# (account, group, AppArmor profile, $DIR) is removed again on any exit
# that isn't success. A failed update keeps the working install it had.
FRESH=true
[ -f "$DIR/install.env" ] && FRESH=false
made_acct=false made_group=false made_dir=false made_aa=false done_ok=false
cleanup() {
  [ "$done_ok" = true ] && return
  rm -rf "$DIR/.staging" "$DIR/.new" 2>/dev/null || true
  [ "$FRESH" = true ] || return 0
  if [ "$made_aa" = true ]; then
    apparmor_parser -R "/etc/apparmor.d/$NAME" 2>/dev/null || true
    rm -f "/etc/apparmor.d/$NAME"
  fi
  if [ "$made_acct" = true ]; then
    pkill -9 -u "$NAME" 2>/dev/null || true
    if [ "$OS" = Darwin ]; then dscl . -delete "/Users/$NAME" 2>/dev/null || true; else userdel "$NAME" 2>/dev/null || true; fi
  fi
  if [ "$made_group" = true ]; then
    if [ "$OS" = Darwin ]; then dseditgroup -o delete "$NAME" 2>/dev/null || true
    elif getent group "$NAME" >/dev/null 2>&1; then groupdel "$NAME" 2>/dev/null || true; fi
  fi
  if [ "$made_dir" = true ]; then rm -rf "$DIR"; fi
  echo "  undone: this install's account and files are removed again" >&2
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

ROOTGROUP=root
[ "$OS" = Darwin ] && ROOTGROUP=wheel
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# Everything downloaded is fetched and unpacked by the account, never by root.
as_acct() { (cd / && sudo -u "$NAME" -H /bin/sh -c "$1"); }

# ── 1. The account ───────────────────────────────────────────────────
if [ "$OS" = Darwin ]; then
  if dscl . -read "/Users/$NAME" >/dev/null 2>&1; then
    case "$(dscl . -read "/Users/$NAME" Comment 2>/dev/null)" in
      *"$MARK"*) say "account $NAME: exists" ;;
      *) die "an account named $NAME exists that this installer didn't create; not touching it" ;;
    esac
  else
    say "account $NAME: creating (no password, can't log in; the way MacPorts makes its macports user)"
    if dscl . -read "/Groups/$NAME" >/dev/null 2>&1; then
      case "$(dscl . -read "/Groups/$NAME" RealName 2>/dev/null)" in
        *"$MARK"*) ;;
        *) die "a group named $NAME exists that this installer didn't create; not touching it" ;;
      esac
    else
      dseditgroup -o create -r "$MARK" "$NAME" || die "could not create the group $NAME"
      made_group=true
    fi
    gid=$(dscl . -read "/Groups/$NAME" PrimaryGroupID | awk '{print $2}')
    uid=501
    while dscl /Search -search /Users UniqueID "$uid" 2>/dev/null | grep -q .; do uid=$((uid + 1)); done
    made_acct=true
    if ! err=$(dscl . -create "/Users/$NAME" 2>&1); then
      case "$err" in
        *14120*) die "macOS refused to create the account (eDSPermissionError -14120). If a prompt asked to let your terminal administer this computer, allow it (System Settings > Privacy & Security > App Management), then run the command again." ;;
        *) die "dscl: $err" ;;
      esac
    fi
    dscl . -create "/Users/$NAME" UniqueID "$uid"
    dscl . -create "/Users/$NAME" PrimaryGroupID "$gid"
    dscl . -create "/Users/$NAME" UserShell /usr/bin/false
    dscl . -create "/Users/$NAME" NFSHomeDirectory "$DIR/home"
    dscl . -create "/Users/$NAME" RealName "$MARK"
    dscl . -create "/Users/$NAME" Comment "$COMMENT"
    dscl . -create "/Users/$NAME" Password '*'
    # macOS adds these on its own; without them the account can't log in
    # and stays out of Users & Groups and the login window.
    for a in AuthenticationAuthority PasswordPolicyOptions dsAttrTypeNative:KerberosKeys dsAttrTypeNative:ShadowHashData; do
      dscl . -delete "/Users/$NAME" "$a" 2>/dev/null || true
    done
  fi
else
  if getent passwd "$NAME" >/dev/null 2>&1; then
    case "$(getent passwd "$NAME" | cut -d: -f5)" in
      "$MARK"*) say "account $NAME: exists" ;;
      *) die "an account named $NAME exists that this installer didn't create; not touching it" ;;
    esac
  else
    # A group with this name and no account is someone else's (a group has
    # no comment to carry the marker); the account must not join it.
    if getent group "$NAME" >/dev/null 2>&1; then
      die "a group named $NAME exists that this installer didn't create; not touching it (if it is left from an interrupted install: sudo groupdel $NAME)"
    fi
    say "account $NAME: creating (system account, no login)"
    nologin=/usr/sbin/nologin
    [ -x "$nologin" ] || nologin=/sbin/nologin
    groupadd --system "$NAME"
    made_group=true
    made_acct=true
    useradd --system --gid "$NAME" --home-dir "$DIR/home" --no-create-home --shell "$nologin" --comment "$COMMENT" "$NAME"
  fi
  # The GPU device nodes (/dev/dri/*) belong to these groups.
  for g in render video; do
    if getent group "$g" >/dev/null 2>&1; then usermod -aG "$g" "$NAME"; fi
  done
fi
ACCT_UID=$(id -u "$NAME")

# ── 2. Directories ───────────────────────────────────────────────────
[ -d "$DIR" ] || made_dir=true
mkdir -p "$DIR"
chown "root:$ROOTGROUP" "$DIR"
chmod 755 "$DIR"
mkdir -p "$DIR/home"
chown "$NAME:$NAME" "$DIR/home"
chmod 700 "$DIR/home"
cp "$PKG/install/home-README.md" "$DIR/home/README.md"
chmod 644 "$DIR/home/README.md"
rm -rf "$DIR/.staging" "$DIR/.new" "$DIR/.old"
mkdir "$DIR/.staging"
chown "$NAME:$NAME" "$DIR/.staging"

# ── 3. Node, the app's dependency and Chromium, fetched as the account ──
case "$OS-$(uname -m)" in
  Darwin-arm64) plat=darwin-arm64 ;;
  Darwin-x86_64) plat=darwin-x64 ;;
  Linux-x86_64) plat=linux-x64 ;;
  Linux-aarch64|Linux-arm64) plat=linux-arm64 ;;
  *) die "unsupported machine: $OS $(uname -m)" ;;
esac
node_v=$(sed -n 's/^version //p' "$PKG/install/node.txt")
node_sha=$(sed -n "s/^$plat //p" "$PKG/install/node.txt")
if [ -z "$node_v" ] || [ -z "$node_sha" ]; then die "no pinned Node.js for $plat"; fi
command -v curl >/dev/null 2>&1 || die "curl is needed"
say "Node.js $node_v: downloading"
as_acct "cd '$DIR/.staging' && curl -fsSL --retry 2 -o node.tar.gz 'https://nodejs.org/dist/v$node_v/node-v$node_v-$plat.tar.gz'" \
  || die "could not download Node.js (no internet, or a proxy this installer can't use)"
[ "$(sha256 "$DIR/.staging/node.tar.gz")" = "$node_sha" ] || die "the Node.js download doesn't match its pinned SHA-256"
as_acct "cd '$DIR/.staging' && tar xzf node.tar.gz && mv 'node-v$node_v-$plat' node && rm node.tar.gz"

mkdir "$DIR/.staging/app"
cp -R "$PKG/app/server.mjs" "$PKG/app/policy.mjs" "$PKG/app/package.json" "$PKG/app/README.md" "$PKG/app/lib" "$DIR/.staging/app/"
chown -R "$NAME:$NAME" "$DIR/.staging/app"
say "playwright-core: installing (no install scripts run)"
as_acct "cd '$DIR/.staging/app' && npm_config_update_notifier=false ../node/bin/node ../node/lib/node_modules/npm/bin/npm-cli.js install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock --loglevel=error" \
  || die "npm install failed"
say "Chromium: downloading (a few minutes, ~200 MB)"
as_acct "cd '$DIR/.staging/app' && PLAYWRIGHT_BROWSERS_PATH='$DIR/.staging/browsers' ../node/bin/node node_modules/playwright-core/cli.js install --no-shell chromium" \
  || die "the Chromium download failed"

# ── 4. A fresh root-owned copy: the account can run it, not change it ──
mkdir "$DIR/.new"
cp -R "$DIR/.staging/node" "$DIR/.staging/app" "$DIR/.staging/browsers" "$DIR/.new/"
rm -rf "$DIR/.staging"
printf '%s %s\n' "$VERSION" "$HASH" > "$DIR/.new/VERSION"
chown -R "root:$ROOTGROUP" "$DIR/.new"
chmod -R go-w,a+rX "$DIR/.new"

# ── 5. Self-test the new copy, started the way every run starts it ─────
self_test() { (cd / && sudo -u "$NAME" "$DIR/.new/node/bin/node" "$DIR/.new/app/server.mjs" --self-test 2>&1); }
say "self-test: starting Chromium as $NAME"
st=0
out=$(self_test) || st=$?
if [ "$st" != 0 ] && [ "$OS" = Linux ]; then
  # Ubuntu 23.10+ lets only profiled programs create the user namespaces
  # Chromium's sandbox needs; give this Chromium such a profile.
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] && command -v apparmor_parser >/dev/null 2>&1; then
    say "AppArmor: allowing this Chromium its sandbox (user namespaces)"
    [ -e "/etc/apparmor.d/$NAME" ] || made_aa=true
    cat > "/etc/apparmor.d/$NAME" <<EOF
# $COMMENT
# Lets this install's Chromium create the user namespaces its sandbox needs
# (Ubuntu 23.10+ restricts them), as Ubuntu's own profile does for Chrome.
abi <abi/4.0>,
include <tunables/global>
profile $NAME $DIR/**/chrome flags=(unconfined) {
  userns,
  include if exists <local/$NAME>
}
EOF
    apparmor_parser -r "/etc/apparmor.d/$NAME" || die "apparmor_parser could not load /etc/apparmor.d/$NAME"
    first=$out
    st=0
    out=$(self_test) || st=$?
  fi
  case "$out" in
    *"missing dependencies"*|*"error while loading shared libraries"*)
      cmd=$(as_acct "cd '$DIR/.new/app' && ../node/bin/node node_modules/playwright-core/cli.js install-deps --dry-run chromium" 2>/dev/null \
        | grep -E '^(sudo -- )?(sh -c ")?apt-get install' | head -1 | sed -e 's/^sudo -- //' -e 's/^sh -c "//' -e 's/"$//')
      printf '%s\n' "$out" | tail -5 >&2
      if [ -n "$cmd" ]; then
        die "Chromium needs system libraries. Install them with: sudo $cmd ; then run npx @agent-socket/gpu-browser again"
      fi
      die "Chromium needs system libraries that this installer doesn't know how to install here (see above)"
      ;;
  esac
fi
if [ "$st" != 0 ]; then
  if [ -n "${first:-}" ]; then printf 'before the AppArmor profile:\n%s\nwith it:\n' "$(printf '%s\n' "$first" | tail -15)" >&2; fi
  printf '%s\n' "$out" | tail -15 >&2
  die "the self-test failed (above); nothing was changed"
fi
result=$(printf '%s\n' "$out" | grep '^{' | tail -1)
case "$result" in *'"ok":true'*) ;; *) printf '%s\n' "$out" | tail -15 >&2; die "the self-test failed (above); nothing was changed" ;; esac
renderer=$(printf '%s' "$result" | sed -n 's/.*"renderer":"\([^"]*\)".*/\1/p')
say "self-test: Chromium starts with its sandbox; GPU: ${renderer:-unknown}"
event "gpu ${renderer:-unknown}"
case "$result" in *'"software":true'*) event "software-rendering" ;; esac

# ── 6. Swap it in ────────────────────────────────────────────────────
mkdir "$DIR/.old"
for d in node app browsers VERSION; do
  if [ -e "$DIR/$d" ]; then mv "$DIR/$d" "$DIR/.old/"; fi
done
for d in node app browsers VERSION; do mv "$DIR/.new/$d" "$DIR/"; done
rm -rf "$DIR/.new" "$DIR/.old"
cp "$PKG/install/uninstall.sh" "$DIR/uninstall.sh"
cp "$PKG/install/system-README.md" "$DIR/README.md"
chmod 755 "$DIR/uninstall.sh"
chmod 644 "$DIR/README.md"
cat > "$DIR/install.env" <<EOF
user=$USER_NAME
version=$VERSION
hash=$HASH
account_uid=$ACCT_UID
gpu=$renderer
EOF
chmod 644 "$DIR/install.env"
chown -R "root:$ROOTGROUP" "$DIR/uninstall.sh" "$DIR/README.md" "$DIR/install.env"

# ── 7. The sudo rule: start the server as the account, nothing else ────
# sudo applies the LAST rule that matches, reading sudoers.d in name order,
# so the file sorts last ("zz-"): a broader rule of yours for the same
# command (e.g. "you ALL=(ALL) ALL" in /etc/sudoers.d/you) would otherwise
# win and ask for the password again.
SUDOERS="/etc/sudoers.d/zz-$NAME"
NODE="$DIR/node/bin/node"
SERVER="$DIR/app/server.mjs"
if grep -Eq '^[#@]includedir[[:space:]]+(/private)?/etc/sudoers\.d' /etc/sudoers 2>/dev/null; then
  mkdir -p /etc/sudoers.d
  tmp=$(mktemp /etc/sudoers.d/.agent-socket-XXXXXX)   # a name with a dot: sudo skips it until it's moved
  {
    echo "# $COMMENT"
    echo "# Lets $USER_NAME start the GPU browser server as $NAME without a password."
    echo "# Exactly this command, with exactly these arguments; nothing else."
    echo "# Named zz-... to come last: sudo applies the last rule that matches."
    echo "$USER_NAME ALL=($NAME) NOPASSWD: $NODE $SERVER"
  } > "$tmp"
  if visudo -cf "$tmp" >/dev/null 2>&1; then
    chown "root:$ROOTGROUP" "$tmp"
    chmod 0440 "$tmp"
    mv -f "$tmp" "$SUDOERS"
    say "sudo rule: $SUDOERS (starts the server without a password)"
    event "sudo-rule installed"
  else
    rm -f "$tmp"
    say "sudo rule: didn't validate; each start will ask for your password"
    event "sudo-rule skipped"
  fi
else
  say "sudo rule: /etc/sudoers doesn't read /etc/sudoers.d; each start will ask for your password"
  event "sudo-rule skipped"
fi

# ── 8. Can the account see into your home? ───────────────────────────
if sudo -u "$NAME" test -x "$USER_HOME" 2>/dev/null; then event "home-open"; fi
done_ok=true
event "done"
