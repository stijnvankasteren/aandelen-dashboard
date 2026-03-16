#!/usr/bin/env python3
"""
Historische backfill van House PTR congress trades (2008–heden).

- Verwerkt één jaar per run, in batches van 10 PDFs
- Slaat voortgang op in data/congress_backfill.json
- Een jaar is voltooid zodra DocID van 1 jan volgend jaar bereikt is
- Stop automatisch als alle jaren klaar zijn
- Draait als cron (bijv. elk uur) totdat alles gedaan is

Gebruik: python3 backfill_congress.py
"""

import io
import json
import os
import re
import sys
import time
import zipfile
import urllib.request
from datetime import date, datetime

try:
    from pypdf import PdfReader
except ImportError:
    print("FOUT: pypdf niet geïnstalleerd. Voer uit: pip install pypdf")
    sys.exit(1)

# ── Configuratie ──────────────────────────────────────────────────────────────
DATA_DIR        = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
BACKFILL_FILE   = os.path.join(DATA_DIR, "congress_backfill.json")
CONGRESS_FILE   = os.path.join(DATA_DIR, "congress_trades.json")
UNIVERSE_FILE   = os.path.join(DATA_DIR, "universe.json")

START_YEAR      = 2008
BATCH_SIZE      = 10       # PDFs per batch
SLEEP_BETWEEN   = 1.0      # seconden tussen PDFs
SLEEP_BATCH     = 5.0      # seconden tussen batches
BASE_URL        = "https://disclosures-clerk.house.gov/public_disc"

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_tickers():
    with open(UNIVERSE_FILE) as f:
        universe = json.load(f)
    tickers = set()
    for idx_data in universe.get("indices", {}).values():
        for t in idx_data.get("tickers", []):
            # Alleen pure tickers (geen .AS, .PA etc) — die zijn relevant voor congress
            if "." not in t:
                tickers.add(t.upper())
    return tickers


def load_backfill():
    if os.path.exists(BACKFILL_FILE):
        with open(BACKFILL_FILE) as f:
            return json.load(f)
    return {"completed_years": [], "in_progress": {}}


def save_backfill(state):
    with open(BACKFILL_FILE, "w") as f:
        json.dump(state, f, indent=2)


def load_congress():
    if os.path.exists(CONGRESS_FILE):
        with open(CONGRESS_FILE) as f:
            return json.load(f)
    return {"_date": date.today().isoformat()}


def save_congress(data):
    data["_date"] = date.today().isoformat()
    data["_fetched_at"] = datetime.utcnow().isoformat()
    with open(CONGRESS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def fetch_fd_index(year):
    """Download en parse de FD index ZIP voor een jaar. Geeft lijst van (doc_id, name, filing_date)."""
    url = f"{BASE_URL}/financial-pdfs/{year}FD.zip"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        zip_data = resp.read()
    z = zipfile.ZipFile(io.BytesIO(zip_data))
    txt = z.read(f"{year}FD.txt").decode("utf-8", errors="replace")

    entries = []
    for line in txt.splitlines()[1:]:
        cols = line.strip().split("\t")
        if len(cols) < 9 or cols[4].strip() != "P":
            continue
        filing_date_raw = cols[7].strip()
        doc_id = cols[8].strip()
        try:
            m, d, y = filing_date_raw.split("/")
            filing_date = date(int(y), int(m), int(d))
        except Exception:
            continue
        name = f"{cols[2].strip()} {cols[1].strip()}"
        entries.append((doc_id, name, filing_date))

    # Sorteer op datum
    entries.sort(key=lambda x: x[2])
    return entries


PDF_PATTERN = re.compile(
    r"\(([A-Z]{1,5})\)\s*(?:\[[A-Z]+\])?\s*\n?\s*([PS])\s+(\d{1,2}/\d{1,2}/\d{4})",
    re.MULTILINE,
)


def parse_pdf(doc_id, year, rep_name, filing_date_iso):
    """Download en parse één PTR PDF. Geeft lijst van trade-dicts."""
    url = f"{BASE_URL}/ptr-pdfs/{year}/{doc_id}.pdf"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        pdf_data = resp.read()
    reader = PdfReader(io.BytesIO(pdf_data))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)

    trades = []
    for m in PDF_PATTERN.finditer(text):
        ticker  = m.group(1).upper()
        tx_type = "buy" if m.group(2) == "P" else "sell"
        try:
            mo, dy, yr = m.group(3).split("/")
            tx_date = f"{yr}-{mo.zfill(2)}-{dy.zfill(2)}"
        except Exception:
            tx_date = filing_date_iso
        trades.append({
            "ticker":   ticker,
            "type":     tx_type,
            "date":     tx_date,
            "rep":      rep_name,
            "amount":   "",
        })
    return trades


def merge_trades(congress_data, new_trades, tickers):
    """Voeg nieuwe trades toe aan congress_data (cumulatief per ticker)."""
    for trade in new_trades:
        ticker = trade["ticker"]
        if ticker not in tickers:
            continue
        if ticker not in congress_data:
            congress_data[ticker] = {"buy_count": 0, "sell_count": 0, "recent": [], "score": 50.0}
        entry = congress_data[ticker]
        if trade["type"] == "buy":
            entry["buy_count"] += 1
        else:
            entry["sell_count"] += 1
        # Voeg toe aan recent (bewaar de 10 meest recente)
        entry["recent"].append({
            "date":           trade["date"],
            "representative": trade["rep"],
            "party":          "",
            "type":           trade["type"],
            "amount":         trade["amount"],
        })
        entry["recent"] = sorted(entry["recent"], key=lambda x: x["date"], reverse=True)[:10]


def recalculate_scores(congress_data):
    """Herbereken scores op basis van buy/sell ratio."""
    for ticker, entry in congress_data.items():
        if ticker.startswith("_"):
            continue
        buys  = entry.get("buy_count", 0)
        sells = entry.get("sell_count", 0)
        total = buys + sells
        if total == 0:
            entry["score"] = 50.0
            continue
        ratio = buys / total
        if ratio >= 0.9:
            score = 90.0
        elif ratio >= 0.7:
            score = 70.0 + (ratio - 0.7) * (20.0 / 0.2)
        elif ratio >= 0.5:
            score = 45.0 + (ratio - 0.5) * (25.0 / 0.2)
        elif ratio >= 0.3:
            score = 25.0 + (ratio - 0.3) * (20.0 / 0.2)
        else:
            score = max(15.0, ratio * (25.0 / 0.3))
        entry["score"] = round(score, 1)


# ── Hoofdlogica ───────────────────────────────────────────────────────────────

def main():
    current_year = date.today().year
    all_years    = list(range(START_YEAR, current_year + 1))

    state   = load_backfill()
    tickers = load_tickers()

    completed = set(state.get("completed_years", []))
    remaining = [y for y in all_years if y not in completed]

    if not remaining:
        print("✓ Alle jaren al verwerkt. Backfill klaar.")
        return

    # Verwerk het oudste nog niet voltooide jaar
    year = remaining[0]
    print(f"=== Backfill jaar {year} ({len(completed)}/{len(all_years)} jaren klaar) ===")

    # Haal index op
    try:
        entries = fetch_fd_index(year)
    except Exception as e:
        print(f"FOUT: index ophalen voor {year}: {e}")
        return

    print(f"  {len(entries)} PTR filings gevonden in {year}")

    # Bepaal waar we gebleven waren
    in_progress = state.get("in_progress", {})
    year_state  = in_progress.get(str(year), {"processed_ids": []})
    processed   = set(year_state.get("processed_ids", []))

    to_process = [(doc_id, name, fd) for doc_id, name, fd in entries if doc_id not in processed]
    print(f"  {len(processed)} al verwerkt, {len(to_process)} nog te gaan")

    if not to_process:
        # Jaar is klaar
        completed.add(year)
        state["completed_years"] = sorted(completed)
        if str(year) in state.get("in_progress", {}):
            del state["in_progress"][str(year)]
        save_backfill(state)
        print(f"  ✓ Jaar {year} volledig verwerkt.")
        return

    # Laad bestaande congress data
    congress_data = load_congress()

    # Verwerk in batches
    batch_count = 0
    new_trades_total = 0

    for i, (doc_id, rep_name, filing_date) in enumerate(to_process):
        # Check of dit jaar voltooid is: 1 jan volgend jaar bereikt
        next_year_start = date(year + 1, 1, 1)
        if filing_date >= next_year_start:
            completed.add(year)
            state["completed_years"] = sorted(completed)
            if str(year) in state.get("in_progress", {}):
                del state["in_progress"][str(year)]
            save_backfill(state)
            save_congress(congress_data)
            print(f"  ✓ Jaar {year} volledig verwerkt (datum {filing_date} >= {next_year_start}).")
            return

        try:
            trades = parse_pdf(doc_id, year, rep_name, filing_date.isoformat())
            merge_trades(congress_data, trades, tickers)
            processed.add(doc_id)
            new_trades_total += len(trades)
        except Exception as e:
            print(f"  WAARSCHUWING: {doc_id} ({rep_name}) overgeslagen: {e}")
            processed.add(doc_id)  # sla over zodat we niet blijven hangen

        time.sleep(SLEEP_BETWEEN)
        batch_count += 1

        if batch_count % BATCH_SIZE == 0:
            # Sla voortgang op na elke batch
            year_state["processed_ids"] = list(processed)
            state.setdefault("in_progress", {})[str(year)] = year_state
            save_backfill(state)
            recalculate_scores(congress_data)
            save_congress(congress_data)
            print(f"  Batch {batch_count // BATCH_SIZE}: {batch_count}/{len(to_process)} verwerkt, {new_trades_total} trades gevonden")
            time.sleep(SLEEP_BATCH)

    # Einde van alle filings voor dit jaar
    year_state["processed_ids"] = list(processed)
    state.setdefault("in_progress", {})[str(year)] = year_state

    # Check of jaar nu voltooid is (alle filings verwerkt)
    if len(processed) >= len(entries):
        completed.add(year)
        state["completed_years"] = sorted(completed)
        if str(year) in state.get("in_progress", {}):
            del state["in_progress"][str(year)]
        print(f"  ✓ Jaar {year} volledig verwerkt ({len(entries)} filings).")

    save_backfill(state)
    recalculate_scores(congress_data)
    save_congress(congress_data)
    print(f"\nDeze run klaar: {new_trades_total} nieuwe trades toegevoegd voor jaar {year}.")


if __name__ == "__main__":
    main()
