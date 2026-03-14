#!/usr/bin/env bash
# ─────────────────────────────────────────────
# Portfolio Analyser – Dagelijks uitvoeren
# ─────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Activeer virtual environment als het bestaat
if [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
fi

# Data ophalen
echo "Data ophalen..."
python3 fetch_data.py

# Webapp openen in browser
echo ""
echo "Webapp starten op http://localhost:8080 ..."
echo "Druk Ctrl+C om te stoppen."
echo ""

# Eventueel al draaiende servers stoppen
pkill -f "python3 -m http.server 8080" 2>/dev/null || true
pkill -f "fetch_t212_proxy.py" 2>/dev/null || true
sleep 0.5

# Trading 212 proxy starten (poort 8081)
echo "Trading 212 proxy starten op http://localhost:8081 ..."
python3 fetch_t212_proxy.py &
PROXY_PID=$!

# Dashboard server starten (poort 8080)
echo "Dashboard starten op http://localhost:8080 ..."
python3 -m http.server 8080 &
SERVER_PID=$!
sleep 1
open "http://localhost:8080"

# Wacht op Ctrl+C en stop beide servers
trap "kill $SERVER_PID $PROXY_PID 2>/dev/null; echo 'Servers gestopt.'" EXIT
wait $SERVER_PID
