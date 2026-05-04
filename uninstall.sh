#!/bin/bash

# WhatsApp Sender v3 — Uninstall
# Removes the LaunchAgent. Does NOT delete your data or campaigns.

set -e

PLIST="$HOME/Library/LaunchAgents/com.sender.whatsapp.plist"
PORT=3004

echo ""
echo "WhatsApp Sender v3 — Uninstall"
echo "─────────────────────────────────"

# Kill process on port
lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true

if [ -f "$PLIST" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm "$PLIST"
  echo "✅ LaunchAgent removed"
else
  echo "ℹ️  LaunchAgent not found — already removed"
fi

echo ""
echo "Done. Your data (data/, sessions/, uploads/) is untouched."
echo "To reinstall: run install.sh"
echo ""
