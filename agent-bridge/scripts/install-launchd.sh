#!/usr/bin/env bash
# Install agent-bridge as a launchd LaunchAgent (runs on user login, stays up).
#
# Usage:
#   bash scripts/install-launchd.sh         # install + load
#   bash scripts/install-launchd.sh restart # reload (after config / code changes)
#   bash scripts/install-launchd.sh status  # show launchctl print output
#
# After install, logs go to ~/Library/Logs/agent-bridge.log.

set -euo pipefail

LABEL="dev.blitz.agent-bridge"
BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=$(command -v node)
LOG="$HOME/Library/Logs/agent-bridge.log"

if [[ -z "$NODE" ]]; then
  echo "✗ node not found in PATH"
  exit 1
fi

if [[ "${1:-install}" == "status" ]]; then
  launchctl print "gui/$(id -u)/$LABEL" 2>&1 | head -30 || echo "not loaded"
  exit 0
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$BRIDGE_DIR/index.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BRIDGE_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin</string>
    </dict>
</dict>
</plist>
EOF

mkdir -p "$(dirname "$LOG")"
touch "$LOG"

# Reload (unload if already loaded, then load).
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "✓ installed $LABEL"
echo "  plist: $PLIST"
echo "  logs:  $LOG"
echo ""
echo "tail logs with: tail -f $LOG"
echo "stop with:      bash scripts/uninstall-launchd.sh"
