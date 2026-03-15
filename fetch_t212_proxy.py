#!/usr/bin/env python3
"""
Portfolio Analyser proxy + auth server
Poort 8081 — CORS proxy naar T212/DEGIRO + gebruikersbeheer via SQLite
"""

import json
import base64
import time
import subprocess
import threading
import hashlib
import secrets
import sqlite3
import os
import io
import re
import urllib.request
import urllib.error
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import pyotp
    import qrcode
    TOTP_AVAILABLE = True
except ImportError:
    TOTP_AVAILABLE = False

_refresh_lock   = threading.Lock()
_refresh_running = False

PORT       = 8081
DB_PATH    = "/app/data/users.db"
T212_BASES = {
    "demo": "https://demo.trading212.com/api/v0",
    "live": "https://live.trading212.com/api/v0",
}
DEGIRO_BASE = "https://trader.degiro.nl"

MIN_EXPORT_POST_INTERVAL = 60
MIN_EXPORT_GET_INTERVAL  = 20
_last_export_post_time   = 0
_last_export_get_time    = 0
_throttle_lock           = threading.Lock()

# ── SQLite database ───────────────────────────────────────────

_db_lock = threading.Lock()

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                username     TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at   TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS settings (
                user_id INTEGER NOT NULL,
                key     TEXT NOT NULL,
                value   TEXT,
                PRIMARY KEY (user_id, key),
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS transactions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                data        TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS dividends (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                data        TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS reset_tokens (
                token      TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS totp (
                user_id      INTEGER PRIMARY KEY,
                secret       TEXT NOT NULL,
                confirmed    INTEGER DEFAULT 0,
                backup_codes TEXT NOT NULL DEFAULT '[]',
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        """)

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()


# ── T212 CSV fetch helpers ────────────────────────────────────

T212_BASES_CSV = {
    "demo": "https://demo.trading212.com/api/v0",
    "live": "https://live.trading212.com/api/v0",
}
T212_START_YEAR = 2016

def _t212_auth_header(api_key, api_secret):
    if api_secret:
        creds = base64.b64encode(f"{api_key}:{api_secret}".encode()).decode()
        return f"Basic {creds}"
    return api_key

def _t212_request(method, path, body, api_key, api_secret, env, retries=4):
    base = T212_BASES_CSV.get(env, T212_BASES_CSV["live"])
    url  = base + path
    data = json.dumps(body).encode() if body else None
    req  = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": _t212_auth_header(api_key, api_secret),
        "Content-Type":  "application/json",
        "Accept":        "application/json",
        "User-Agent":    "Mozilla/5.0",
        "Origin":        "https://app.trading212.com",
        "Referer":       "https://app.trading212.com/",
    })
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
                wait = (attempt + 1) * 10
                print(f"[csv] Rate limit 429, wacht {wait}s...")
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP {e.code}: {body_err.decode('utf-8', errors='replace')[:200]}")
    raise RuntimeError("Max retries bereikt")

def _t212_request_export(api_key, api_secret, env, time_from, time_to):
    body = {
        "dataIncluded": {
            "includeDividends":    True,
            "includeTransactions": True,
            "includeOrders":       True,
        },
        "timeFrom": time_from,
        "timeTo":   time_to,
    }
    result = _t212_request("POST", "/history/exports", body, api_key, api_secret, env)
    report_id = result.get("reportId") or result.get("id")
    if not report_id:
        raise RuntimeError(f"Geen reportId: {str(result)[:100]}")
    return report_id

def _t212_poll_export(api_key, api_secret, env, report_id, label, timeout=180):
    print(f"[csv] Wachten op export {label}...", flush=True)
    for _ in range(timeout // 5):
        time.sleep(5)
        exports = _t212_request("GET", "/history/exports", None, api_key, api_secret, env)
        lst = exports if isinstance(exports, list) else exports.get("items", [])
        for exp in lst:
            if (exp.get("reportId") or exp.get("id")) == report_id:
                link = exp.get("downloadLink") or exp.get("url")
                if link:
                    return link
    return None

def _t212_download_csv(url):
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8", errors="replace")

def _get_user_t212_settings(user_id):
    """Haal T212 API key/secret/env op uit de settings tabel."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT key, value FROM settings WHERE user_id = ? AND key IN ('t212_key','t212_secret','t212_env')",
            (user_id,)
        ).fetchall()
    cfg = {r["key"]: json.loads(r["value"]) for r in rows}
    return cfg.get("t212_key",""), cfg.get("t212_secret",""), cfg.get("t212_env","live")

def _save_csv_for_user(user_id, csv_text):
    """Sla CSV op in de settings tabel per gebruiker (key = t212_csv)."""
    with _db_lock:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO settings (user_id, key, value) VALUES (?, 't212_csv', ?) "
                "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                (user_id, json.dumps(csv_text))
            )

def _load_csv_for_user(user_id):
    """Laad opgeslagen CSV voor een gebruiker."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE user_id = ? AND key = 't212_csv'",
            (user_id,)
        ).fetchone()
    return json.loads(row["value"]) if row else ""

def _merge_csv(existing_csv, new_csv):
    """Voeg nieuwe CSV rijen toe aan bestaande CSV, dedupliceert op basis van inhoud."""
    existing_lines = existing_csv.strip().split("\n") if existing_csv.strip() else []
    new_lines      = new_csv.strip().split("\n") if new_csv.strip() else []

    if not new_lines:
        return existing_csv

    header = new_lines[0]
    new_data = [l for l in new_lines[1:] if l.strip()]

    if existing_lines:
        existing_data = set(existing_lines[1:])
        to_add = [l for l in new_data if l not in existing_data]
        combined = existing_lines + to_add
    else:
        combined = [header] + new_data

    return "\n".join(combined)

def fetch_csv_full(user_id):
    """Haal alle historische CSV data op (alle jaren vanaf T212_START_YEAR). Bedoeld voor eerste keer."""
    api_key, api_secret, env = _get_user_t212_settings(user_id)
    if not api_key:
        raise RuntimeError("Geen T212 API sleutel geconfigureerd.")

    end_year   = date.today().year
    all_lines  = []
    header     = None

    for year in range(T212_START_YEAR, end_year + 1):
        time_from = f"{year}-01-01T00:00:00Z"
        time_to   = f"{year}-12-31T23:59:59Z"
        print(f"[csv/full] Export aanvragen voor {year}...")
        try:
            report_id = _t212_request_export(api_key, api_secret, env, time_from, time_to)
            link      = _t212_poll_export(api_key, api_secret, env, report_id, str(year))
            if not link:
                print(f"[csv/full] {year}: timeout, overgeslagen.")
                continue
            csv_text  = _t212_download_csv(link)
            lines     = csv_text.strip().split("\n")
            if not header and lines:
                header = lines[0]
            data_lines = [l for l in lines[1:] if l.strip()]
            all_lines.extend(data_lines)
            print(f"[csv/full] {year}: {len(data_lines)} rijen.")
        except Exception as e:
            print(f"[csv/full] {year}: fout — {e}")
        if year < end_year:
            time.sleep(2)

    if not header:
        raise RuntimeError("Geen data ontvangen van T212.")

    combined = "\n".join([header] + all_lines)
    _save_csv_for_user(user_id, combined)
    print(f"[csv/full] Klaar: {len(all_lines)} rijen opgeslagen voor user {user_id}.")
    return len(all_lines)

def fetch_csv_daily(user_id):
    """Haal alleen de transacties van vandaag op en merge met bestaande data."""
    api_key, api_secret, env = _get_user_t212_settings(user_id)
    if not api_key:
        raise RuntimeError("Geen T212 API sleutel geconfigureerd.")

    today     = date.today()
    time_from = f"{today.isoformat()}T00:00:00Z"
    time_to   = f"{today.isoformat()}T23:59:59Z"

    print(f"[csv/daily] Export aanvragen voor {today}...")
    report_id = _t212_request_export(api_key, api_secret, env, time_from, time_to)
    link      = _t212_poll_export(api_key, api_secret, env, report_id, str(today))
    if not link:
        raise RuntimeError(f"Timeout bij ophalen export voor {today}.")

    new_csv      = _t212_download_csv(link)
    existing_csv = _load_csv_for_user(user_id)
    merged       = _merge_csv(existing_csv, new_csv)
    _save_csv_for_user(user_id, merged)

    new_lines = len([l for l in new_csv.strip().split("\n")[1:] if l.strip()])
    print(f"[csv/daily] {today}: {new_lines} nieuwe rijen gemerged voor user {user_id}.")
    return new_lines

def create_session(user_id):
    token = secrets.token_hex(32)
    with _db_lock:
        with get_db() as conn:
            conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    return token

def get_user_from_token(token):
    if not token:
        return None
    with get_db() as conn:
        row = conn.execute(
            "SELECT u.id, u.username FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?",
            (token,)
        ).fetchone()
    return dict(row) if row else None

# ── HTTP handler ──────────────────────────────────────────────

class ProxyHandler(BaseHTTPRequestHandler):

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type,X-T212-Key,X-T212-Secret,X-T212-Env,"
                         "X-Degiro-Session,X-Auth-Token")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length > 0 else b""

    def _auth_user(self):
        token = self.headers.get("X-Auth-Token", "").strip()
        return get_user_from_token(token)

    # ── Auth endpoints ────────────────────────────────────────

    def _handle_register(self):
        body = json.loads(self._read_body())
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not username or not password:
            self._json(400, {"error": "Gebruikersnaam en wachtwoord zijn verplicht."})
            return
        if len(password) < 6:
            self._json(400, {"error": "Wachtwoord moet minimaal 6 tekens zijn."})
            return
        try:
            with _db_lock:
                with get_db() as conn:
                    conn.execute(
                        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                        (username, hash_password(password))
                    )
                    user_id = conn.execute(
                        "SELECT id FROM users WHERE username = ?", (username,)
                    ).fetchone()["id"]
            token = create_session(user_id)
            self._json(200, {"token": token, "username": username, "userId": user_id})
        except sqlite3.IntegrityError:
            self._json(409, {"error": "Gebruikersnaam is al in gebruik."})

    def _handle_login(self):
        body = json.loads(self._read_body())
        username   = (body.get("username") or "").strip()
        password   = body.get("password") or ""
        totp_code  = (body.get("totpCode") or "").strip()
        backup_code = (body.get("backupCode") or "").strip()
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, username FROM users WHERE username = ? AND password_hash = ?",
                (username, hash_password(password))
            ).fetchone()
        if not row:
            self._json(401, {"error": "Onjuiste gebruikersnaam of wachtwoord."})
            return
        # Controleer of 2FA actief is
        with get_db() as conn:
            totp_row = conn.execute(
                "SELECT secret, confirmed, backup_codes FROM totp WHERE user_id = ? AND confirmed = 1",
                (row["id"],)
            ).fetchone()
        if totp_row:
            if not totp_code and not backup_code:
                self._json(200, {"totp_required": True})
                return
            if backup_code:
                codes = json.loads(totp_row["backup_codes"])
                if backup_code not in codes:
                    self._json(401, {"error": "Ongeldige backup code."})
                    return
                # Verwijder gebruikte backup code
                codes.remove(backup_code)
                with _db_lock:
                    with get_db() as conn:
                        conn.execute("UPDATE totp SET backup_codes = ? WHERE user_id = ?",
                                     (json.dumps(codes), row["id"]))
            else:
                totp = pyotp.TOTP(totp_row["secret"])
                if not totp.verify(totp_code, valid_window=1):
                    self._json(401, {"error": "Ongeldige authenticator code."})
                    return
        token = create_session(row["id"])
        self._json(200, {"token": token, "username": row["username"], "userId": row["id"]})

    def _handle_logout(self):
        token = self.headers.get("X-Auth-Token", "").strip()
        if token:
            with _db_lock:
                with get_db() as conn:
                    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        self._json(200, {"status": "ok"})

    def _handle_totp_setup(self):
        """Genereer een nieuw TOTP-geheim en stuur QR-code terug als data-URL."""
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        if not TOTP_AVAILABLE:
            self._json(500, {"error": "pyotp/qrcode niet geïnstalleerd."}); return
        secret = pyotp.random_base32()
        totp   = pyotp.TOTP(secret)
        uri    = totp.provisioning_uri(name=user["username"], issuer_name="Portfolio Analyser")
        # Genereer QR als PNG data-URL
        img    = qrcode.make(uri)
        buf    = io.BytesIO()
        img.save(buf, format="PNG")
        qr_b64 = base64.b64encode(buf.getvalue()).decode()
        # Sla geheim op (nog niet bevestigd)
        with _db_lock:
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO totp (user_id, secret, confirmed, backup_codes) VALUES (?, ?, 0, '[]') "
                    "ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, confirmed = 0",
                    (user["id"], secret)
                )
        self._json(200, {"qr": f"data:image/png;base64,{qr_b64}", "secret": secret})

    def _handle_totp_confirm(self):
        """Bevestig 2FA met een code uit de authenticator-app en genereer backup codes."""
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        body = json.loads(self._read_body())
        code = (body.get("code") or "").strip()
        with get_db() as conn:
            row = conn.execute(
                "SELECT secret FROM totp WHERE user_id = ? AND confirmed = 0", (user["id"],)
            ).fetchone()
        if not row:
            self._json(400, {"error": "Geen 2FA setup gevonden. Start opnieuw."}); return
        totp = pyotp.TOTP(row["secret"])
        if not totp.verify(code, valid_window=1):
            self._json(401, {"error": "Ongeldige code. Probeer opnieuw."}); return
        # Genereer 8 backup codes
        backup_codes = [secrets.token_hex(4) for _ in range(8)]
        with _db_lock:
            with get_db() as conn:
                conn.execute(
                    "UPDATE totp SET confirmed = 1, backup_codes = ? WHERE user_id = ?",
                    (json.dumps(backup_codes), user["id"])
                )
        self._json(200, {"status": "ok", "backupCodes": backup_codes})

    def _handle_totp_disable(self):
        """Schakel 2FA uit (vereist wachtwoord)."""
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        body     = json.loads(self._read_body())
        password = body.get("password") or ""
        with get_db() as conn:
            row = conn.execute(
                "SELECT id FROM users WHERE id = ? AND password_hash = ?",
                (user["id"], hash_password(password))
            ).fetchone()
        if not row:
            self._json(401, {"error": "Wachtwoord klopt niet."}); return
        with _db_lock:
            with get_db() as conn:
                conn.execute("DELETE FROM totp WHERE user_id = ?", (user["id"],))
        self._json(200, {"status": "ok"})

    def _handle_totp_status(self):
        """Geeft terug of 2FA actief is voor de ingelogde gebruiker."""
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        with get_db() as conn:
            row = conn.execute(
                "SELECT confirmed FROM totp WHERE user_id = ?", (user["id"],)
            ).fetchone()
        self._json(200, {"enabled": bool(row and row["confirmed"])})

    def _handle_request_reset(self):
        """Stap 1: genereer een reset-code en log hem in de proxy-output."""
        body     = json.loads(self._read_body())
        username = (body.get("username") or "").strip()
        if not username:
            self._json(400, {"error": "Gebruikersnaam is verplicht."}); return
        with get_db() as conn:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            # Geef geen info prijs of de gebruiker bestaat
            self._json(200, {"status": "ok"}); return
        token   = secrets.token_hex(4)   # bijv. "4h8f9n2h"
        expires = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 600))  # 10 min geldig
        with _db_lock:
            with get_db() as conn:
                conn.execute("DELETE FROM reset_tokens WHERE user_id = ?", (row["id"],))
                conn.execute("INSERT INTO reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)",
                             (token, row["id"], expires))
        print(f"\n{'='*40}")
        print(f"  WACHTWOORD RESET CODE voor '{username}'")
        print(f"  Code: {token}  (geldig 10 minuten)")
        print(f"{'='*40}\n", flush=True)
        self._json(200, {"status": "ok"})

    def _handle_reset_password(self):
        """Wachtwoord wijzigen — vereist huidig wachtwoord of reset-code."""
        body         = json.loads(self._read_body())
        username     = (body.get("username") or "").strip()
        old_password = body.get("oldPassword") or ""
        new_password = body.get("newPassword") or ""
        reset_token  = (body.get("resetToken") or "").strip()

        if not username or not new_password:
            self._json(400, {"error": "Gebruikersnaam en nieuw wachtwoord zijn verplicht."}); return
        if len(new_password) < 6:
            self._json(400, {"error": "Nieuw wachtwoord moet minimaal 6 tekens zijn."}); return

        with get_db() as conn:
            user = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not user:
            self._json(401, {"error": "Gebruiker niet gevonden."}); return

        if reset_token:
            # Verifieer reset-code
            now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            with get_db() as conn:
                row = conn.execute(
                    "SELECT token FROM reset_tokens WHERE token = ? AND user_id = ? AND expires_at > ?",
                    (reset_token, user["id"], now)
                ).fetchone()
            if not row:
                self._json(401, {"error": "Ongeldige of verlopen code."}); return
            # Verwijder gebruikte token
            with _db_lock:
                with get_db() as conn:
                    conn.execute("DELETE FROM reset_tokens WHERE token = ?", (reset_token,))
        else:
            # Verifieer oud wachtwoord
            with get_db() as conn:
                row = conn.execute(
                    "SELECT id FROM users WHERE username = ? AND password_hash = ?",
                    (username, hash_password(old_password))
                ).fetchone()
            if not row:
                self._json(401, {"error": "Huidig wachtwoord klopt niet."}); return

        with _db_lock:
            with get_db() as conn:
                conn.execute("UPDATE users SET password_hash = ? WHERE username = ?",
                             (hash_password(new_password), username))
        self._json(200, {"status": "ok"})

    def _handle_me(self):
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."})
            return
        self._json(200, user)

    # ── Settings endpoints ────────────────────────────────────

    def _handle_settings_get(self):
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        with get_db() as conn:
            rows = conn.execute(
                "SELECT key, value FROM settings WHERE user_id = ?", (user["id"],)
            ).fetchall()
        self._json(200, {r["key"]: json.loads(r["value"]) for r in rows})

    def _handle_settings_post(self):
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        body = json.loads(self._read_body())
        with _db_lock:
            with get_db() as conn:
                for key, value in body.items():
                    conn.execute(
                        "INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) "
                        "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                        (user["id"], key, json.dumps(value))
                    )
        self._json(200, {"status": "ok"})

    # ── Transacties endpoints ─────────────────────────────────

    def _handle_transactions_get(self):
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        with get_db() as conn:
            rows = conn.execute(
                "SELECT data FROM transactions WHERE user_id = ?", (user["id"],)
            ).fetchall()
        self._json(200, [json.loads(r["data"]) for r in rows])

    def _handle_transactions_post(self):
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        transactions = json.loads(self._read_body())
        with _db_lock:
            with get_db() as conn:
                conn.execute("DELETE FROM transactions WHERE user_id = ?", (user["id"],))
                for tx in transactions:
                    conn.execute(
                        "INSERT INTO transactions (user_id, data) VALUES (?, ?)",
                        (user["id"], json.dumps(tx))
                    )
        self._json(200, {"status": "ok", "count": len(transactions)})

    # ── Dividenden endpoints ──────────────────────────────────

    def _handle_dividends_get(self):
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        with get_db() as conn:
            rows = conn.execute(
                "SELECT data FROM dividends WHERE user_id = ?", (user["id"],)
            ).fetchall()
        self._json(200, [json.loads(r["data"]) for r in rows])

    def _handle_dividends_post(self):
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        dividends = json.loads(self._read_body())
        with _db_lock:
            with get_db() as conn:
                conn.execute("DELETE FROM dividends WHERE user_id = ?", (user["id"],))
                for d in dividends:
                    conn.execute(
                        "INSERT INTO dividends (user_id, data) VALUES (?, ?)",
                        (user["id"], json.dumps(d))
                    )
        self._json(200, {"status": "ok", "count": len(dividends)})

    # ── Posities cache endpoints ──────────────────────────────

    def _handle_positions_cache_get(self):
        """Geeft gecachede posities + cash terug uit DB."""
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE user_id = ? AND key = 'positions_cache'",
                (user["id"],)
            ).fetchone()
        if not row:
            self._json(404, {"error": "Nog geen gecachede posities. Wacht op de volgende cron (8:00, 12:00 of 17:00)."}); return
        self._json(200, json.loads(row["value"]))

    def _handle_positions_cache_refresh(self):
        """Haalt posities + cash live op van T212 en slaat op in DB (alleen via cron)."""
        remote = self.headers.get("X-Forwarded-For") or self.client_address[0]
        token  = self.headers.get("X-Cron-Token", "")
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE user_id = 0 AND key = 'cron_token'"
            ).fetchone()
        cron_token = json.loads(row["value"]) if row else ""

        if token != cron_token and remote not in ("127.0.0.1", "::1"):
            self._json(403, {"error": "Niet toegestaan."}); return

        with get_db() as conn:
            users = conn.execute("SELECT id FROM users").fetchall()

        def _run():
            for u in users:
                try:
                    api_key, api_secret, env = _get_user_t212_settings(u["id"])
                    if not api_key:
                        continue
                    base = T212_BASES_CSV.get(env, T212_BASES_CSV["live"])

                    def _get(path):
                        return _t212_request("GET", path, None, api_key, api_secret, env)

                    all_positions = []
                    portfolio_path = "/equity/portfolio"
                    while portfolio_path:
                        page = _get(portfolio_path)
                        if isinstance(page, dict):
                            items = page.get("items", [])
                            all_positions.extend(items if isinstance(items, list) else [])
                            next_path = page.get("nextPagePath")
                            portfolio_path = next_path if next_path else None
                        elif isinstance(page, list):
                            all_positions.extend(page)
                            portfolio_path = None
                        else:
                            portfolio_path = None
                    positions = all_positions

                    cash = _get("/equity/account/cash")

                    payload = {
                        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "positions":  positions if isinstance(positions, list) else [],
                        "cash":       cash if isinstance(cash, dict) else {},
                    }
                    with _db_lock:
                        with get_db() as conn:
                            conn.execute(
                                "INSERT INTO settings (user_id, key, value) VALUES (?, 'positions_cache', ?) "
                                "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                                (u["id"], json.dumps(payload))
                            )
                    print(f"[positions] Cache bijgewerkt voor user {u['id']}: {len(payload['positions'])} posities.")
                except Exception as e:
                    print(f"[positions] Fout voor user {u['id']}: {e}")

        threading.Thread(target=_run, daemon=True).start()
        self._json(200, {"status": "gestart", "message": f"Posities ophalen gestart voor {len(users)} gebruiker(s)."})

    # ── CSV endpoints ─────────────────────────────────────────

    def _handle_csv_get(self):
        """Geeft de opgeslagen CSV terug als tekst."""
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        csv_text = _load_csv_for_user(user["id"])
        body = csv_text.encode("utf-8")
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def _handle_csv_full(self):
        """Start volledige historische CSV fetch (achtergrond-thread)."""
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        api_key, _, _ = _get_user_t212_settings(user["id"])
        if not api_key:
            self._json(400, {"error": "Geen T212 API sleutel ingesteld."}); return

        def _run():
            try:
                fetch_csv_full(user["id"])
                # Sla sync tijdstip op
                with _db_lock:
                    with get_db() as conn:
                        conn.execute(
                            "INSERT INTO settings (user_id, key, value) VALUES (?, 't212_last_sync', ?) "
                            "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                            (user["id"], json.dumps(datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")))
                        )
            except Exception as e:
                print(f"[csv/full] Fout voor user {user['id']}: {e}")

        threading.Thread(target=_run, daemon=True).start()
        self._json(200, {"status": "gestart", "message": "Volledige CSV fetch gestart op achtergrond."})

    def _handle_csv_sync_status(self):
        """Geeft laatste sync tijdstip terug."""
        user = self._auth_user()
        if not user:
            self._json(401, {"error": "Niet ingelogd."}); return
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE user_id = ? AND key = 't212_last_sync'",
                (user["id"],)
            ).fetchone()
        last_sync = json.loads(row["value"]) if row else None
        self._json(200, {"last_sync": last_sync})

    def _handle_csv_daily(self):
        """Start dagelijkse CSV fetch voor alle gebruikers (aangeroepen door cron)."""
        # Beveiligd met een interne cron-token of alleen vanaf localhost
        remote = self.headers.get("X-Forwarded-For") or self.client_address[0]
        token  = self.headers.get("X-Cron-Token", "")
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE user_id = 0 AND key = 'cron_token'"
            ).fetchone()
        cron_token = json.loads(row["value"]) if row else ""

        if token != cron_token and remote not in ("127.0.0.1", "::1"):
            self._json(403, {"error": "Niet toegestaan."}); return

        with get_db() as conn:
            users = conn.execute("SELECT id FROM users").fetchall()

        def _run():
            for u in users:
                try:
                    fetch_csv_daily(u["id"])
                except Exception as e:
                    print(f"[csv/daily] Fout voor user {u['id']}: {e}")

        threading.Thread(target=_run, daemon=True).start()
        self._json(200, {"status": "gestart", "message": f"Dagelijkse CSV fetch gestart voor {len(users)} gebruiker(s)."})

    # ── Refresh endpoint ──────────────────────────────────────

    def _handle_refresh(self):
        global _refresh_running
        with _refresh_lock:
            if _refresh_running:
                self._json(409, {"status": "busy", "message": "Refresh draait al"}); return
            _refresh_running = True
        try:
            print("[proxy/refresh] fetch_data.py gestart...")
            subprocess.run(["python3", "/app/fetch_data.py"],
                           capture_output=True, text=True, timeout=300)
            print("[proxy/refresh] fetch_data.py klaar")
            self._json(200, {"status": "ok"})
        except subprocess.TimeoutExpired:
            self._json(504, {"status": "error", "message": "Timeout"})
        except Exception as e:
            self._json(500, {"status": "error", "message": str(e)})
        finally:
            with _refresh_lock:
                _refresh_running = False

    # ── Routing ───────────────────────────────────────────────

    def _handle(self, method):
        p = self.path.split("?")[0]

        if   p == "/auth/register":       self._handle_register()
        elif p == "/auth/login":          self._handle_login()
        elif p == "/auth/logout":         self._handle_logout()
        elif p == "/auth/me":             self._handle_me()
        elif p == "/user/settings"  and method == "GET":  self._handle_settings_get()
        elif p == "/user/settings"  and method == "POST": self._handle_settings_post()
        elif p == "/user/transactions" and method == "GET":  self._handle_transactions_get()
        elif p == "/user/transactions" and method == "POST": self._handle_transactions_post()
        elif p == "/user/dividends" and method == "GET":  self._handle_dividends_get()
        elif p == "/user/dividends" and method == "POST": self._handle_dividends_post()
        elif p == "/user/csv"                and method == "GET":  self._handle_csv_get()
        elif p == "/user/csv/full"           and method == "POST": self._handle_csv_full()
        elif p == "/user/csv/daily"          and method == "POST": self._handle_csv_daily()
        elif p == "/user/csv/sync-status"    and method == "GET":  self._handle_csv_sync_status()
        elif p == "/user/positions"          and method == "GET":  self._handle_positions_cache_get()
        elif p == "/user/positions/refresh"  and method == "POST": self._handle_positions_cache_refresh()
        elif p == "/auth/totp/setup"     and method == "POST": self._handle_totp_setup()
        elif p == "/auth/totp/confirm"   and method == "POST": self._handle_totp_confirm()
        elif p == "/auth/totp/disable"   and method == "POST": self._handle_totp_disable()
        elif p == "/auth/totp/status"    and method == "GET":  self._handle_totp_status()
        elif p == "/auth/request-reset"  and method == "POST": self._handle_request_reset()
        elif p == "/auth/reset-password" and method == "POST": self._handle_reset_password()
        elif p == "/refresh":             self._handle_refresh()
        elif self.path.startswith("/degiro"):    self._handle_degiro(method, self.path[7:])
        elif self.path.startswith("/s3download"): self._handle_s3download()
        else:
            path = self.path[5:] if self.path.startswith("/t212") else self.path
            self._handle_t212(method, path)

    # ── Throttle ──────────────────────────────────────────────

    def _throttle(self, is_export_post=False, is_export_get=False):
        global _last_export_post_time, _last_export_get_time
        with _throttle_lock:
            now = time.time()
            if is_export_post:
                wait = MIN_EXPORT_POST_INTERVAL - (now - _last_export_post_time)
                if wait > 0:
                    print(f"[proxy] Export POST throttle: wacht {wait:.1f}s...")
                    time.sleep(wait)
                _last_export_post_time = time.time()
            elif is_export_get:
                wait = MIN_EXPORT_GET_INTERVAL - (now - _last_export_get_time)
                if wait > 0:
                    print(f"[proxy] Export GET throttle: wacht {wait:.1f}s...")
                    time.sleep(wait)
                _last_export_get_time = time.time()

    # ── S3 download ───────────────────────────────────────────

    def _handle_s3download(self):
        qs     = urllib.parse.urlparse(self.path).query
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        url    = urllib.parse.unquote(params.get("url", ""))
        if not url.startswith("https://"):
            self._json(400, {"error": "Ongeldige URL"}); return
        print(f"[proxy/s3] GET {url[:80]}...")
        try:
            with urllib.request.urlopen(url) as resp:
                data = resp.read()
                self.send_response(200)
                self._cors_headers()
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── DEGIRO ────────────────────────────────────────────────

    def _handle_degiro(self, method, path):
        session_id     = self.headers.get("X-Degiro-Session", "").strip()
        url            = DEGIRO_BASE + path
        content_length = int(self.headers.get("Content-Length", 0))
        body           = self.rfile.read(content_length) if content_length > 0 else None
        print(f"[proxy/degiro] {method} {url}")
        req = urllib.request.Request(url, data=body, method=method, headers={
            "Content-Type":    "application/json",
            "User-Agent":      "Mozilla/5.0",
            "Accept":          "application/json, text/plain, */*",
            "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
            "Origin":          "https://trader.degiro.nl",
            "Referer":         "https://trader.degiro.nl/",
            **({"Cookie": f"JSESSIONID={session_id}"} if session_id else {}),
        })
        self._forward(req)

    # ── Trading 212 ───────────────────────────────────────────

    def _handle_t212(self, method, path):
        api_key    = self.headers.get("X-T212-Key",    "").strip()
        api_secret = self.headers.get("X-T212-Secret", "").strip()
        env        = self.headers.get("X-T212-Env",    "demo").strip()
        base       = T212_BASES.get(env, T212_BASES["demo"])
        url        = base + path

        if api_secret:
            credentials = base64.b64encode(f"{api_key}:{api_secret}".encode()).decode()
            auth_header = f"Basic {credentials}"
        else:
            auth_header = api_key

        is_export      = "history/exports" in path
        self._throttle(is_export_post=(is_export and method == "POST"),
                       is_export_get=(is_export and method == "GET"))
        print(f"[proxy/t212] {method} {url}")

        content_length = int(self.headers.get("Content-Length", 0))
        body           = self.rfile.read(content_length) if content_length > 0 else None

        req = urllib.request.Request(url, data=body, method=method, headers={
            "Authorization":   auth_header,
            "Content-Type":    "application/json",
            "User-Agent":      "Mozilla/5.0",
            "Accept":          "application/json",
            "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
            "Origin":          "https://app.trading212.com",
            "Referer":         "https://app.trading212.com/",
        })
        self._forward(req)

    # ── Forward ───────────────────────────────────────────────

    def _forward(self, req):
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req) as resp:
                    data         = resp.read()
                    content_type = resp.headers.get("Content-Type", "application/json")
                    self.send_response(resp.status)
                    self._cors_headers()
                    self.send_header("Content-Type", content_type)
                    self.end_headers()
                    self.wfile.write(data)
                    return
            except urllib.error.HTTPError as e:
                body_err = e.read()
                if e.code == 429 and attempt < 5:
                    wait = (attempt + 1) * 10
                    print(f"[proxy] Rate limit (429), wacht {wait}s... (poging {attempt+1}/5)")
                    time.sleep(wait)
                    continue
                self.send_response(e.code)
                self._cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body_err)
                return
            except Exception as exc:
                self._json(500, {"error": str(exc)})
                return

    def do_GET(self):    self._handle("GET")
    def do_POST(self):   self._handle("POST")
    def do_DELETE(self): self._handle("DELETE")

    def log_message(self, fmt, *args):
        print(f"[proxy] {fmt % args}")


if __name__ == "__main__":
    init_db()
    # Genereer cron token als die nog niet bestaat
    with _db_lock:
        with get_db() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (0, 'cron_token', ?)",
                (json.dumps(secrets.token_hex(16)),)
            )
            row = conn.execute(
                "SELECT value FROM settings WHERE user_id = 0 AND key = 'cron_token'"
            ).fetchone()
    cron_token = json.loads(row["value"])
    print(f"[proxy] Cron token: {cron_token}")
    print(f"[proxy] Dagelijkse CSV cron gebruikt: curl -s -X POST http://localhost:{PORT}/user/csv/daily -H 'X-Cron-Token: {cron_token}'")

    server = HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print(f"Portfolio proxy draait op http://0.0.0.0:{PORT}")

    # Ververs posities bij opstarten als er nog geen cache is
    def _startup_positions_refresh():
        time.sleep(3)  # wacht tot proxy volledig gestart is
        with get_db() as conn:
            any_cache = conn.execute(
                "SELECT 1 FROM settings WHERE key = 'positions_cache' LIMIT 1"
            ).fetchone()
        if any_cache:
            print("[start] Positie-cache aanwezig, refresh overgeslagen.")
            return
        print("[start] Geen positie-cache gevonden — posities ophalen bij opstarten...")
        try:
            req = urllib.request.Request(
                f"http://localhost:{PORT}/user/positions/refresh",
                method="POST",
                headers={"X-Cron-Token": cron_token},
            )
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            print(f"[start] Posities refresh fout: {e}")
    threading.Thread(target=_startup_positions_refresh, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nProxy gestopt.")
