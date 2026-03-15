#!/bin/sh
# Haal de cron token op uit de SQLite DB en roep de proxy CSV endpoint aan.
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
  echo "[$(date)] Geen cron token gevonden, proxy nog niet gestart?" >&2
  exit 1
fi

echo "[$(date)] Dagelijkse CSV fetch starten..."
curl -s -X POST http://localhost:8081/user/csv/daily \
     -H "X-Cron-Token: $TOKEN" \
     && echo "[$(date)] CSV fetch gestart." \
     || echo "[$(date)] CSV fetch mislukt." >&2
