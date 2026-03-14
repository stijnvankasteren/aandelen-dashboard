#!/bin/sh
# Start cron daemon op de achtergrond
cron

# Haal data op bij opstarten
python3 fetch_data.py

# Start de proxy op de voorgrond (zodat Docker de container draaiende houdt)
exec python3 fetch_t212_proxy.py
