#!/bin/bash

# ============================================================================
# WhatsApp Sender v3 — Install Script
# Registers com.sender.whatsapp LaunchAgent on port 3004
# Run once from the whatsapp-sender folder
# ============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/com.sender.whatsapp.plist"
PORT=3004

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   WhatsApp Sender v3 — Install                   ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# macOS only
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo -e "${RED}❌ macOS only.${NC}"; exit 1
fi

# Node check
NODE_PATH=""
for candidate in "$(which node 2>/dev/null)" "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_PATH="$candidate"; break
  fi
done

if [ -z "$NODE_PATH" ]; then
  echo -e "${RED}❌ Node.js not found. Install from https://nodejs.org/${NC}"; exit 1
fi

NODE_VER=$("$NODE_PATH" -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${RED}❌ Node.js 18+ required. Found $("$NODE_PATH" -v)${NC}"; exit 1
fi
echo -e "${GREEN}  ✓ Node.js $("$NODE_PATH" -v)${NC}"

# npm check
NPM_PATH="$(dirname "$NODE_PATH")/npm"
[ ! -x "$NPM_PATH" ] && NPM_PATH="$(which npm 2>/dev/null)"
[ -z "$NPM_PATH" ] && { echo -e "${RED}❌ npm not found${NC}"; exit 1; }
echo -e "${GREEN}  ✓ npm found${NC}"

# Kill any existing process on port 3004
echo -e "${YELLOW}› Clearing port ${PORT}...${NC}"
lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true
sleep 1

# npm install
echo -e "${YELLOW}› Installing dependencies...${NC}"
cd "$SCRIPT_DIR"
"$NPM_PATH" install
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

# Create required folders
mkdir -p "$SCRIPT_DIR/data"
mkdir -p "$SCRIPT_DIR/uploads"
mkdir -p "$SCRIPT_DIR/sessions"
echo -e "${GREEN}  ✓ Folders created${NC}"

# Remove old plist if exists
mkdir -p "$LAUNCH_AGENTS"
[ -f "$PLIST" ] && launchctl unload "$PLIST" 2>/dev/null || true

# Write plist
cat > "$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sender.whatsapp</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${SCRIPT_DIR}/server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>${SCRIPT_DIR}/wa.log</string>

    <key>StandardErrorPath</key>
    <string>${SCRIPT_DIR}/wa_error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>${PORT}</string>
    </dict>
</dict>
</plist>
PLIST_EOF

# Load service
launchctl load -w "$PLIST"
echo -e "${GREEN}  ✓ LaunchAgent registered${NC}"

# Wait and check
sleep 5
if lsof -i :${PORT} -sTCP:LISTEN &>/dev/null; then
  echo -e "${GREEN}  ✓ Server running on port ${PORT}${NC}"
else
  echo -e "${YELLOW}  ⏳ Server still starting...${NC}"
fi

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  ✅ Installation Complete                        ║${NC}"
echo -e "${BOLD}║                                                  ║${NC}"
echo -e "${BOLD}║  Dashboard: http://localhost:${PORT}             ║${NC}"
echo -e "${BOLD}║  Service:   com.sender.whatsapp                  ║${NC}"
echo -e "${BOLD}║                                                  ║${NC}"
echo -e "${BOLD}║  Auto-starts on login. Restarts on crash.        ║${NC}"
echo -e "${BOLD}║  To uninstall: run uninstall.sh                  ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Open in Chrome
sleep 2
open -a "Google Chrome" "http://localhost:${PORT}" 2>/dev/null || \
open "http://localhost:${PORT}" 2>/dev/null || true
