#!/bin/bash
# Double-clickable launcher for the arbhar library editor (macOS).
# Runs the local Node server, which opens the app in your browser.

cd "$(dirname "$0")" || exit 1

# Finder launches scripts with a minimal PATH — add the usual Node locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# If Node was installed via nvm, load it.
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found."
  echo "Install it from https://nodejs.org (LTS), then double-click this file again."
  read -n 1 -s -r -p "Press any key to close…"
  exit 1
fi

echo "Starting arbhar library editor…  (close this window to quit)"
node server.js
