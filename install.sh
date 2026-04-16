#!/bin/bash
# Anugnya WhatsApp Sender — Mac Install Script
# Run: curl -s https://raw.githubusercontent.com/Rajiv-Lal/anugnya-whatsapp-sender/main/install.sh | bash

set -e
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Anugnya WhatsApp Sender — Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org (v20 LTS)"
  exit 1
fi
echo "✅ Node.js $(node --version)"

# Check Python
if ! command -v python3 &> /dev/null; then
  echo "❌ Python 3 not found. Install from https://python.org"
  exit 1
fi
echo "✅ Python $(python3 --version)"

# Install Python packages
echo "📦 Installing Python packages..."
pip3 install pandas openpyxl --quiet --break-system-packages 2>/dev/null || pip3 install pandas openpyxl --quiet

# Create folder
DEST="$HOME/Desktop/whatsapp-sender"
if [ -d "$DEST" ]; then
  echo "📁 Folder already exists: $DEST"
else
  echo "📁 Creating $DEST"
  mkdir -p "$DEST"
fi

# Clone or pull repo
cd "$DEST"
if [ -d ".git" ]; then
  echo "🔄 Updating existing installation..."
  git pull
else
  echo "📥 Downloading sender..."
  git clone https://github.com/Rajiv-Lal/anugnya-whatsapp-sender.git . 2>/dev/null || {
    echo "⚠️  Could not clone. Please download files manually from GitHub."
  }
fi

# Install Node packages
echo "📦 Installing Node packages..."
npm install --quiet

# Create folders
mkdir -p media session public

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Copy your whatsapp_final.xlsx to:"
echo "     $DEST/"
echo ""
echo "  2. Copy anugnya_video.mp4 to:"
echo "     $DEST/media/"
echo ""
echo "  3. Start the sender:"
echo "     cd $DEST && node server.js"
echo ""
echo "  4. Open: http://localhost:3000"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
