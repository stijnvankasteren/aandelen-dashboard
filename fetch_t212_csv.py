#!/usr/bin/env python3
"""
Trading 212 CSV ophaler – dagelijkse cron (17:00)

Haalt alle historische transacties op via de CSV export API
en slaat ze op als data/t212_history.csv

Configuratie wordt gelezen uit t212_config.json:
  {
    "api_key":          "...",
    "api_secret":       "...",
    "env":              "live",          // "live" | "demo"
    "first_order_date": "2021-03-15"    // wordt automatisch ingevuld
  }

Gebruik:
  python3 fetch_t212_csv.py              # eenmalig uitvoeren
  python3 fetch_t212_csv.py --setup      # interactief configureren
"""

import json
import base64
import time
import sys
import os
import urllib.request
import urllib.error
from datetime import date, datetime

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "t212_config.json")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "data", "t212_history.csv")

T212_BASES = {
    "demo": "https://demo.trading212.com/api/v0",
    "live": "https://live.trading212.com/api/v0",
}


# ── Configuratie ───────────────────────────────────────────────

def load_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    with open(CONFIG_FILE) as f:
        return json.load(f)

def save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"[config] Opgeslagen in {CONFIG_FILE}")

def setup():
    cfg = load_config()
    print("=== Trading 212 configuratie ===")
    cfg["api_key"]    = input(f"API-sleutel-id [{cfg.get('api_key','')[:6]}...]: ").strip() or cfg.get("api_key", "")
    cfg["api_secret"] = input(f"Geheime sleutel [{cfg.get('api_secret','')[:6]}...]: ").strip() or cfg.get("api_secret", "")
    cfg["env"]        = input(f"Omgeving (live/demo) [{cfg.get('env','live')}]: ").strip() or cfg.get("env", "live")
    save_config(cfg)


# ── HTTP helper ────────────────────────────────────────────────

def api_request(method, path, body=None, cfg=None, retries=4):
    base = T212_BASES.get(cfg.get("env", "live"), T212_BASES["live"])
    url  = base + path

    key    = cfg.get("api_key", "")
    secret = cfg.get("api_secret", "")
    if secret:
        credentials = base64.b64encode(f"{key}:{secret}".encode()).decode()
        auth_header = f"Basic {credentials}"
    else:
        auth_header = key

    data = json.dumps(body).encode() if body else None
    req  = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization":  auth_header,
            "Content-Type":   "application/json",
            "Accept":         "application/json",
            "User-Agent":     "Mozilla/5.0",
            "Origin":         "https://app.trading212.com",
            "Referer":        "https://app.trading212.com/",
        },
    )

    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                ct  = resp.headers.get("Content-Type", "")
                if "json" in ct:
                    return json.loads(raw)
                return raw.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            body_err = e.read()
            if e.code == 429 and attempt < retries - 1:
                wait = (attempt + 1) * 5
                print(f"  [429] Rate limit, wacht {wait}s...")
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP {e.code}: {body_err.decode('utf-8', errors='replace')}")
    raise RuntimeError("Max retries bereikt")


# ── Vroegste transactiedatum bepalen ──────────────────────────

def find_first_order_date(cfg):
    """Pagineert door alle orders om de vroegste datum te vinden."""
    print("[stap 1] Vroegste transactie bepalen...")
    earliest = None
    cursor   = None
    page_num = 0

    while True:
        path = f"/equity/history/orders?limit=50"
        if cursor:
            path += f"&cursor={urllib.parse.quote(cursor)}"

        page  = api_request("GET", path, cfg=cfg)
        items = page.get("items", page) if isinstance(page, dict) else page
        if not isinstance(items, list):
            break

        for tx in items:
            raw = tx.get("dateModified") or tx.get("dateCreated") or tx.get("date")
            if not raw:
                continue
            try:
                d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                if earliest is None or d < earliest:
                    earliest = d
            except ValueError:
                pass

        page_num += 1
        next_path = page.get("nextPagePath") if isinstance(page, dict) else None
        if not next_path or not isinstance(items, list) or len(items) < 50:
            break

        import re
        m = re.search(r"cursor=([^&]+)", next_path)
        if not m:
            break
        cursor = urllib.parse.unquote(m.group(1))
        print(f"  pagina {page_num}, vroegste tot nu: {earliest.date() if earliest else '—'}")
        time.sleep(2)

    return earliest


# ── CSV export aanvragen + downloaden ─────────────────────────

def request_export(cfg, time_from, time_to):
    body = {
        "dataIncluded": {
            "includeDividends":    True,
            "includeTransactions": True,
            "includeOrders":       True,
        },
        "timeFrom": time_from,
        "timeTo":   time_to,
    }
    result    = api_request("POST", "/history/exports", body=body, cfg=cfg)
    report_id = result.get("reportId") or result.get("id")
    if not report_id:
        raise RuntimeError(f"Geen reportId in antwoord: {result}")
    return report_id

def poll_export(cfg, report_id, label, timeout=120):
    """Wacht tot export klaar is, geeft downloadLink terug."""
    print(f"  [{label}] Wachten op export...", end="", flush=True)
    for _ in range(timeout // 3):
        time.sleep(3)
        exports = api_request("GET", "/history/exports", cfg=cfg)
        lst     = exports if isinstance(exports, list) else exports.get("items", [])
        for exp in lst:
            if (exp.get("reportId") or exp.get("id")) == report_id:
                link = exp.get("downloadLink") or exp.get("url")
                if link:
                    print(" klaar.")
                    return link
        print(".", end="", flush=True)
    print(" timeout!")
    return None

def download_csv(url):
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8", errors="replace")


# ── Hoofdfunctie ──────────────────────────────────────────────

# Trading 212 bestaat in NL sinds 2016; gebruik dit als vaste ondergrens.
T212_START_YEAR = 2016

def fetch_all(cfg):
    import urllib.parse

    # Bepaal startjaar: gebruik gecachte eerste transactiedatum als die bekend is,
    # anders start altijd vanaf T212_START_YEAR (2016).
    cached = cfg.get("first_order_date")
    if cached:
        start_year = min(int(cached[:4]), T212_START_YEAR)
        print(f"[stap 1] Eerste transactie bekend: {cached}. Start vanaf {start_year}.")
    else:
        start_year = T212_START_YEAR
        print(f"[stap 1] Geen gecachte datum. Start vanaf {start_year} (oprichting T212).")

    end_year = date.today().year

    # Bouw jaarperiodes
    periods = [
        (f"{y}-01-01T00:00:00Z", f"{y}-12-31T23:59:59Z", str(y))
        for y in range(start_year, end_year + 1)
    ]
    print(f"[stap 2] {len(periods)} jaar(s) op te halen: {start_year}–{end_year}")

    # Maak outputmap aan
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)

    all_lines    = []
    header_saved = None
    MAX_RETRIES  = 3

    for i, (time_from, time_to, label) in enumerate(periods):
        print(f"[stap 3] Export aanvragen voor {label}... ({i+1}/{len(periods)})")
        success = False

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                report_id = request_export(cfg, time_from, time_to)
                link      = poll_export(cfg, report_id, label)
                if not link:
                    raise RuntimeError("Geen download link na timeout.")

                csv_text = download_csv(link)
                lines    = csv_text.strip().split("\n")
                if not header_saved and lines:
                    header_saved = lines[0]
                data_lines = [l for l in lines[1:] if l.strip()]
                all_lines.extend(data_lines)
                print(f"  [{label}] {len(data_lines)} rijen opgehaald.")
                success = True
                break
            except Exception as e:
                print(f"  [{label}] Poging {attempt}/{MAX_RETRIES} mislukt: {e}")
                if attempt < MAX_RETRIES:
                    time.sleep(5 * attempt)

        if not success:
            print(f"  [{label}] Overgeslagen na {MAX_RETRIES} pogingen.")

        if i < len(periods) - 1:
            time.sleep(2)

    if not header_saved:
        print("[klaar] Geen data ontvangen.")
        return

    combined = "\n".join([header_saved] + all_lines)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(combined)

    print(f"[klaar] {len(all_lines)} rijen opgeslagen in {OUTPUT_FILE}")


# ── Entry point ────────────────────────────────────────────────

if __name__ == "__main__":
    if "--setup" in sys.argv:
        setup()
        sys.exit(0)

    cfg = load_config()
    if not cfg.get("api_key") or not cfg.get("api_secret"):
        print("Geen configuratie gevonden. Voer eerst uit: python3 fetch_t212_csv.py --setup")
        sys.exit(1)

    fetch_all(cfg)
