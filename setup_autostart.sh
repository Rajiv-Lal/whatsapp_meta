#!/bin/bash
# Anugnya WhatsApp Sender — Mac Auto-start Setup
# Run once: bash ~/Desktop/whatsapp-sender/setup_autostart.sh

PLIST="$HOME/Library/LaunchAgents/com.anugnya.whatsapp-sender.plist"
SENDER="$HOME/Desktop/whatsapp-sender"
NODE=$(which node)

echo "Setting up auto-start for Anugnya WhatsApp Sender..."

cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.anugnya.whatsapp-sender</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$SENDER/server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$SENDER</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$SENDER/launchagent.log</string>

    <key>StandardErrorPath</key>
    <string>$SENDER/launchagent_error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
PLIST

# Load the LaunchAgent
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "✅ Auto-start configured successfully."
echo ""
echo "The sender will now start automatically every time you log in."
echo "Access it at: http://localhost:3000"
echo ""
echo "To stop auto-start:"
echo "  launchctl unload $PLIST"
echo ""
echo "To start manually now:"
echo "  launchctl start com.anugnya.whatsapp-sender"
