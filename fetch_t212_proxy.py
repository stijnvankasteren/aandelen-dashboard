#!/usr/bin/env python3
"""
Portfolio Analyser lokale proxy
Draait op poort 8081 en stuurt verzoeken door naar Trading 212 en DEGIRO
zodat de browser geen CORS-fout krijgt.

Start:  python3 fetch_t212_proxy.py
"""

import json
import base64
import time
import subprocess
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

_refresh_lock = threading.Lock()
_refresh_running = False

PORT = 8081
T212_BASES = {
    "demo": "https://demo.trading212.com/api/v0",
    "live": "https://live.trading212.com/api/v0",
}
DEGIRO_BASE = "https://trader.degiro.nl"

# Throttle alleen voor /history/exports endpoints
MIN_EXPORT_POST_INTERVAL = 60   # seconden tussen export POST requests
MIN_EXPORT_GET_INTERVAL  = 20   # seconden tussen export GET (poll) requests
_last_export_post_time   = 0
_last_export_get_time    = 0
_throttle_lock           = __import__("threading").Lock()


class ProxyHandler(BaseHTTPRequestHandler):

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type,X-T212-Key,X-T212-Secret,X-T212-Env,X-Degiro-Session")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

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

    def _handle_refresh(self):
        global _refresh_running
        with _refresh_lock:
            if _refresh_running:
                self.send_response(409)
                self._cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"busy","message":"Refresh draait al"}')
                return
            _refresh_running = True
        try:
            print("[proxy/refresh] fetch_data.py gestart...")
            result = subprocess.run(
                ["python3", "/app/fetch_data.py"],
                capture_output=True, text=True, timeout=300
            )
            print("[proxy/refresh] fetch_data.py klaar")
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode())
        except subprocess.TimeoutExpired:
            self.send_response(504)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"error","message":"Timeout"}')
        except Exception as e:
            self.send_response(500)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode())
        finally:
            with _refresh_lock:
                _refresh_running = False

    def _handle(self, method):
        raw_path = self.path

        if raw_path == "/refresh":
            self._handle_refresh()
            return
        elif raw_path.startswith("/degiro"):
            self._handle_degiro(method, raw_path[7:])
        elif raw_path.startswith("/s3download"):
            self._handle_s3download()
        else:
            self._handle_t212(method, raw_path[5:] if raw_path.startswith("/t212") else raw_path)

    def _handle_s3download(self):
        """Download een presigned S3-URL en geef de inhoud terug (omzeilt CORS)."""
        import urllib.parse as up
        qs  = up.urlparse(self.path).query
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        url = up.unquote(params.get("url", ""))
        if not url.startswith("https://"):
            self.send_response(400)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(b'{"error":"Ongeldige URL"}')
            return
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
            self.send_response(500)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _handle_degiro(self, method, path):
        session_id = self.headers.get("X-Degiro-Session", "").strip()
        url        = DEGIRO_BASE + path

        print(f"[proxy/degiro] {method} {url}")

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        req = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Content-Type":  "application/json",
                "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept":        "application/json, text/plain, */*",
                "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
                "Origin":        "https://trader.degiro.nl",
                "Referer":       "https://trader.degiro.nl/",
                **({"Cookie": f"JSESSIONID={session_id}"} if session_id else {}),
            },
        )
        self._forward(req)

    def _handle_t212(self, method, path):
        api_key    = self.headers.get("X-T212-Key",    "").strip()
        api_secret = self.headers.get("X-T212-Secret", "").strip()
        env        = self.headers.get("X-T212-Env",    "demo").strip()
        base       = T212_BASES.get(env, T212_BASES["demo"])
        url        = base + path

        # Basic Auth: base64(key:secret)
        if api_secret:
            credentials = base64.b64encode(f"{api_key}:{api_secret}".encode()).decode()
            auth_header = f"Basic {credentials}"
        else:
            auth_header = api_key

        is_export      = "history/exports" in path
        is_export_post = is_export and method == "POST"
        is_export_get  = is_export and method == "GET"
        self._throttle(is_export_post=is_export_post, is_export_get=is_export_get)
        print(f"[proxy/t212] {method} {url}")
        print(f"[proxy/t212] env={env} key={api_key[:6] if api_key else 'leeg'}... secret={'ja' if api_secret else 'leeg'}")

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        req = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Authorization": auth_header,
                "Content-Type":  "application/json",
                "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept":        "application/json",
                "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
                "Origin":        "https://app.trading212.com",
                "Referer":       "https://app.trading212.com/",
            },
        )
        self._forward(req)

    def _forward(self, req):

        for attempt in range(6):
            try:
                with urllib.request.urlopen(req) as resp:
                    data = resp.read()
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
                print(f"[proxy] HTTP {e.code} response: {body_err.decode('utf-8', errors='replace')}")
                self.send_response(e.code)
                self._cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body_err)
                return
            except Exception as exc:
                self.send_response(500)
                self._cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(exc)}).encode())
                return

    def do_GET(self):    self._handle("GET")
    def do_POST(self):   self._handle("POST")
    def do_DELETE(self): self._handle("DELETE")

    def log_message(self, fmt, *args):
        print(f"[proxy] {fmt % args}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print(f"Trading 212 proxy draait op http://0.0.0.0:{PORT}")
    print("Stop met Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nProxy gestopt.")
