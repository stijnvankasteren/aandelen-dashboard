#!/bin/sh
# Kopieer standaard inputbestanden naar data volume (alleen als ze nog niet bestaan)
cp -n /app/defaults/universe.json /app/data/universe.json
cp -n /app/defaults/portfolio.json /app/data/portfolio.json

# Start cron daemon op de achtergrond
cron

# Haal data op bij opstarten
python3 fetch_data.py

# Start de proxy op de voorgrond (zodat Docker de container draaiende houdt)
exec python3 fetch_t212_proxy.py
