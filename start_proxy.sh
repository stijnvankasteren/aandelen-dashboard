#!/bin/sh
# Kopieer standaard inputbestanden naar data volume (alleen als ze nog niet bestaan)
cp -n /app/defaults/universe.json /app/data/universe.json
cp -n /app/defaults/portfolio.json /app/data/portfolio.json

# Zorg dat het cron script uitvoerbaar is
chmod +x /app/run_csv_daily.sh

# Start cron daemon op de achtergrond
cron

# Haal marktdata op bij opstarten alleen als scores.json nog niet bestaat
if [ ! -f /app/data/scores.json ]; then
  echo "[start] scores.json niet gevonden — eerste keer opstarten, data ophalen..."
  python3 fetch_data.py
else
  echo "[start] scores.json aanwezig, data ophalen overgeslagen (wacht op cron 8:00/12:00/17:00)."
fi

# Haal insider/congress trades op als die ontbreken of te oud zijn
echo "[start] Insider/congress trades controleren..."
python3 fetch_trades.py

# Start de proxy op de voorgrond (zodat Docker de container draaiende houdt)
exec python3 fetch_t212_proxy.py
