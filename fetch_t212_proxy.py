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
import urllib.request
import urllib.error
import urllib.parse
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
    server = HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print(f"Portfolio proxy draait op http://0.0.0.0:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nProxy gestopt.")
