#!/usr/bin/env python3
"""
Haalt dagelijks de actuele S&P 500 top 100 op via marktkapitalisatie (yfinance)
en werkt universe.json bij als de lijst is veranderd.
"""

import json
import os
import sys
import time

try:
    import yfinance as yf
except ImportError:
    print("Installeer eerst: pip install yfinance")
    sys.exit(1)

BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
UNIVERSE_FILE = os.path.join(BASE_DIR, "data", "universe.json")

# Volledige S&P 500 tickerlijst (statisch — samenstelling verandert zelden)
SP500_ALL = [
    "AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","BRK-B","LLY","JPM",
    "XOM","V","UNH","JNJ","AVGO","MA","TSLA","PG","COST","MRK",
    "HD","ABBV","CVX","KO","PEP","ADBE","WMT","BAC","CRM","ACN",
    "TMO","MCD","CSCO","LIN","ABT","ORCL","NKE","DHR","NEE","TXN",
    "PM","AMD","QCOM","RTX","GE","NOW","LOW","UPS","AMGN","ISRG",
    "MDT","SPGI","GS","CAT","AXP","BLK","SYK","VRTX","GILD","MMC",
    "PLD","CB","TJX","MO","C","BSX","ADP","SO","ETN","ZTS",
    "CME","BMY","REGN","SCHW","DE","CI","AON","DUK","ITW","MCO",
    "WM","HCA","MMM","NOC","FI","EMR","CL","GD","APD","SHW",
    "TGT","ICE","PSA","USB","NSC","FDX","EQIX","PNC","KLAC","LRCX",
    "PANW","MELI","SNPS","CDNS","MCK","EOG","MPC","PH","ECL","MSI",
    "HUM","CTAS","WELL","ADI","FTNT","WMB","APH","FICO","TDG","ROP",
    "ODFL","IDXX","FAST","VRSK","CTSH","ANSS","KEYS","DXCM","BIIB","ILMN",
    "ALGN","WAT","MTCH","IQV","BALL","BIO","HOLX","FSLR","TER","ETSY",
]

TOP_N = 100


def fetch_market_caps(tickers, batch=50, sleep=0.3):
    """Haal marktkapitalisatie op via yfinance, in batches."""
    caps = {}
    for i in range(0, len(tickers), batch):
        batch_tickers = tickers[i:i + batch]
        for ticker in batch_tickers:
            try:
                info = yf.Ticker(ticker).fast_info
                mc = getattr(info, "market_cap", None)
                if mc and mc > 0:
                    caps[ticker] = mc
            except Exception:
                pass
        time.sleep(sleep)
        print(f"  {min(i + batch, len(tickers))}/{len(tickers)} verwerkt...")
    return caps


def get_top100():
    """Geeft gesorteerde top 100 tickers op marktkapitalisatie."""
    print(f"  Marktkapitalisatie ophalen voor {len(SP500_ALL)} aandelen...")
    caps = fetch_market_caps(SP500_ALL)
    sorted_tickers = sorted(caps, key=lambda t: caps[t], reverse=True)
    return sorted_tickers[:TOP_N]


def main():
    print("=" * 50)
    print("  S&P 500 Top 100 updater")
    print("=" * 50)

    with open(UNIVERSE_FILE) as f:
        universe = json.load(f)

    current = universe["indices"]["SP500"]["tickers"]
    print(f"  Huidige lijst: {len(current)} tickers")

    new_top100 = get_top100()
    print(f"  Nieuwe top 100 opgehaald: {len(new_top100)} tickers")

    added   = [t for t in new_top100 if t not in current]
    removed = [t for t in current   if t not in new_top100]

    if not added and not removed:
        print("  Geen wijzigingen — lijst is up-to-date.")
        return

    print(f"  Wijzigingen: +{len(added)} toegevoegd, -{len(removed)} verwijderd")
    if added:
        print(f"  Toegevoegd: {added}")
    if removed:
        print(f"  Verwijderd: {removed}")

    universe["indices"]["SP500"]["tickers"] = new_top100
    with open(UNIVERSE_FILE, "w") as f:
        json.dump(universe, f, indent=2)

    print("  universe.json bijgewerkt.")
    print("  Voer daarna fetch_data.py uit om nieuwe data op te halen.")


if __name__ == "__main__":
    main()
