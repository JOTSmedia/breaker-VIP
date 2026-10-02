#!/bin/bash
# Double-click this file (Mac) to start the Breaker Billiards rewards app.
# First time: macOS may say it's from an unidentified developer —
# right-click it, choose Open, then Open again.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # Finder doesn't load your shell PATH
pause(){ read -r -p "Press Enter to close this window..."; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS installer from https://nodejs.org,"
  echo "install it, then double-click start.command again."
  pause; exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing (one time only)..."
  npm install --omit=dev --no-audit --no-fund || { echo "Install failed."; pause; exit 1; }
fi
if [ ! -f server/.env ]; then
  npm run setup || { echo "Setup failed."; pause; exit 1; }
fi
PORT=$(grep -E '^PORT=' server/.env | cut -d= -f2); PORT=${PORT:-4400}
( sleep 2; open "http://127.0.0.1:${PORT}/admin.html" ) &
echo "Starting... leave this window open while the bar is using the app. Close it (or press Ctrl+C) to stop."
npm start
pause
