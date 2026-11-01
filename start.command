#!/bin/bash
# NEON CITIES starten (macOS: Doppelklick, Linux: ./start.command)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js ist nicht installiert."
  echo "  Bitte die LTS-Version von https://nodejs.org installieren."
  echo ""
  (open "https://nodejs.org/de/download" || xdg-open "https://nodejs.org/de/download") >/dev/null 2>&1
  read -r -p "Enter zum Beenden …"
  exit 1
fi
node server.js --open
