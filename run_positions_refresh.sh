#!/bin/sh
# Haal de cron token op en ververs posities cache via de proxy.
TOKEN=$(python3 -c "
import sqlite3, json
try:
    conn = sqlite3.connect('/app/data/users.db')
    row  = conn.execute(\"SELECT value FROM settings WHERE user_id=0 AND key='cron_token'\").fetchone()
    print(json.loads(row[0]) if row else '')
except Exception:
    print('')
")

if [ -z "$TOKEN" ]; then
  echo "[$(date)] Geen cron token gevonden." >&2
  exit 1
fi

echo "[$(date)] Posities verversen..."
curl -s -X POST http://localhost:8081/user/positions/refresh \
     -H "X-Cron-Token: $TOKEN" \
     && echo "[$(date)] Posities vernieuwd." \
     || echo "[$(date)] Posities refresh mislukt." >&2
