#!/bin/sh
# Start cron daemon op de achtergrond
cron

# Start de proxy op de voorgrond (zodat Docker de container draaiende houdt)
exec python3 fetch_t212_proxy.py
