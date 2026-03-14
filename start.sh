#!/usr/bin/env bash
# ─────────────────────────────────────────────
# Portfolio Analyser – Alleen servers starten
# (zonder data opnieuw op te halen)
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
fi

# Eventueel al draaiende servers stoppen
pkill -f "python3 -m http.server 8080" 2>/dev/null || true
pkill -f "fetch_t212_proxy.py" 2>/dev/null || true
sleep 0.5

echo "Trading 212 proxy starten op http://localhost:8081 ..."
python3 fetch_t212_proxy.py &
PROXY_PID=$!

echo "Dashboard starten op http://localhost:8080 ..."
python3 -m http.server 8080 &
SERVER_PID=$!
sleep 1
open "http://localhost:8080"

echo "Beide servers draaien. Druk Ctrl+C om te stoppen."
trap "kill $SERVER_PID $PROXY_PID 2>/dev/null; echo 'Servers gestopt.'" EXIT
wait $SERVER_PID
