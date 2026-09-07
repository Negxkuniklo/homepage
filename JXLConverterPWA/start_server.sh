#!/bin/bash
cd "$(dirname "$0")"

echo "======================================================"
echo "  Starting JXL Converter PWA Server on Linux/macOS..."
echo "======================================================"

if command -v node >/dev/null 2>&1; then
    node server.js
    exit 0
elif command -v python3 >/dev/null 2>&1; then
    echo "Starting with Python 3 HTTP Server..."
    python3 -m http.server 8080
    exit 0
elif command -v python >/dev/null 2>&1; then
    echo "Starting with Python HTTP Server..."
    python -m http.server 8080
    exit 0
else
    echo "[ERROR] Neither Node.js nor Python was found."
    echo "Please install Node.js (e.g. sudo apt install nodejs) or Python."
    exit 1
fi
