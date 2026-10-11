#!/bin/sh
# Removes the agent-socket GPU browser from this machine: its processes, the
# sudo rule, the AppArmor profile (Linux), the agent-socket-gpu-browser
# account and group, and /opt/agent-socket-gpu-browser. Leaves your settings
# in ~/.agent-socket/gpu-browser/ (delete that folder yourself if you like).
#
#   sudo sh /opt/agent-socket-gpu-browser/uninstall.sh
# (or: npx @agent-socket/gpu-browser uninstall)
#
# Touches an account, group or file only if it carries this installer's
# marker. POSIX sh.
set -eu

NAME=agent-socket-gpu-browser
DIR=/opt/agent-socket-gpu-browser
MARK="agent-socket GPU browser"
OS=$(uname -s)
say() { printf '  %s\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "run with sudo: sudo sh $0" >&2; exit 1; }

ours=false
if [ "$OS" = Darwin ]; then
  case "$(dscl . -read "/Users/$NAME" Comment 2>/dev/null)" in *"$MARK"*) ours=true ;; esac
else
  case "$(getent passwd "$NAME" 2>/dev/null | cut -d: -f5)" in "$MARK"*) ours=true ;; esac
fi

if [ "$ours" = true ]; then
  pkill -u "$NAME" 2>/dev/null || true
  sleep 1
  pkill -9 -u "$NAME" 2>/dev/null || true
fi

if [ -f "/etc/sudoers.d/zz-$NAME" ] && grep -q "$MARK" "/etc/sudoers.d/zz-$NAME"; then
  rm -f "/etc/sudoers.d/zz-$NAME"
  say "removed the sudo rule"
fi
if [ -f "/etc/apparmor.d/$NAME" ] && grep -q "$MARK" "/etc/apparmor.d/$NAME"; then
  apparmor_parser -R "/etc/apparmor.d/$NAME" 2>/dev/null || true
  rm -f "/etc/apparmor.d/$NAME"
  say "removed the AppArmor profile"
fi

if [ "$ours" = true ]; then
  if [ "$OS" = Darwin ]; then
    dscl . -delete "/Users/$NAME"
    case "$(dscl . -read "/Groups/$NAME" RealName 2>/dev/null)" in *"$MARK"*) dseditgroup -o delete "$NAME" 2>/dev/null || true ;; esac
  else
    gid=$(id -g "$NAME")
    userdel "$NAME"
    # Only the account's own group (userdel may already have removed it).
    if [ "$(getent group "$NAME" | cut -d: -f3)" = "$gid" ]; then groupdel "$NAME" 2>/dev/null || true; fi
  fi
  say "removed the account $NAME"
else
  exists=false
  if [ "$OS" = Darwin ]; then
    if dscl . -read "/Users/$NAME" >/dev/null 2>&1; then exists=true; fi
  elif getent passwd "$NAME" >/dev/null 2>&1; then exists=true
  fi
  if [ "$exists" = true ]; then say "an account named $NAME exists but wasn't made by this installer; left alone"; fi
fi

if [ -d "$DIR" ]; then
  rm -rf "$DIR"
  say "removed $DIR"
fi
say "done (your settings stay in ~/.agent-socket/gpu-browser/)"
