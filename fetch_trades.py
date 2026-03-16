#!/usr/bin/env python3
"""
Form 4 insider trades & Congress trades fetcher.
Draait bij opstarten (als data ontbreekt) en daarna elk kwartier via cron.
Hergebruikt functies uit fetch_data.py.
"""

import sys
import os
import json
import time
from datetime import datetime

# Voeg de app-map toe aan het pad zodat we fetch_data kunnen importeren
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_data import (
    load_universe,
    fetch_cik_map,
    fetch_insider_trades,
    fetch_congress_trades,
    INSIDER_FILE,
    CONGRESS_FILE,
)

CACHE_MAX_MINUTES = 15


def _cache_age_minutes(filepath):
    """Geeft de leeftijd van het cachebestand in minuten terug, of None als het niet bestaat of leeg is."""
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath) as f:
            data = json.load(f)
        ts = data.get("_fetched_at")
        if not ts:
            return None
        # Beschouw cache als verlopen als er geen enkele ticker met trades in zit
        has_data = any(
            isinstance(v, dict) and (v.get("buy_count", 0) + v.get("sell_count", 0)) > 0
            for k, v in data.items() if not k.startswith("_")
        )
        if not has_data:
            return None
        age = (datetime.utcnow() - datetime.fromisoformat(ts)).total_seconds() / 60
        return age
    except Exception:
        return None


def main():
    print("=" * 50)
    print("  Trades fetcher")
    print(f"  {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}")
    print("=" * 50)

    insider_age  = _cache_age_minutes(INSIDER_FILE)
    congress_age = _cache_age_minutes(CONGRESS_FILE)

    insider_fresh  = insider_age  is not None and insider_age  < CACHE_MAX_MINUTES
    congress_fresh = congress_age is not None and congress_age < CACHE_MAX_MINUTES

    if insider_fresh and congress_fresh:
        print(f"  Beide caches zijn vers (insider: {insider_age:.0f}m, congress: {congress_age:.0f}m). Niets te doen.")
        return

    tickers, ticker_to_index, _ = load_universe()

    if not insider_fresh:
        print(f"\n[1/2] Insider trades ophalen (cache: {f'{insider_age:.0f}m oud' if insider_age is not None else 'ontbreekt'})...")
        cik_map = fetch_cik_map()
        insider = fetch_insider_trades(tickers, cik_map)
        # Schrijf fetch-tijdstip terug in het bestand
        insider["_fetched_at"] = datetime.utcnow().isoformat()
        with open(INSIDER_FILE, "w") as f:
            json.dump(insider, f, indent=2)
    else:
        print(f"\n[1/2] Insider trades: cache vers ({insider_age:.0f}m oud), overgeslagen.")

    if not congress_fresh:
        print(f"\n[2/2] Congress trades ophalen (cache: {f'{congress_age:.0f}m oud' if congress_age is not None else 'ontbreekt'})...")
        congress = fetch_congress_trades(tickers)
        congress["_fetched_at"] = datetime.utcnow().isoformat()
        with open(CONGRESS_FILE, "w") as f:
            json.dump(congress, f, indent=2)
    else:
        print(f"\n[2/2] Congress trades: cache vers ({congress_age:.0f}m oud), overgeslagen.")

    print("\nKlaar.")


if __name__ == "__main__":
    main()
