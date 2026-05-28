"""Zero-dependency dashboard server (Python stdlib only) — production-hardened.

  GET  /health         -> 200 (unauthenticated; App Platform health check)
  GET  /               -> the dashboard
  GET  /static/*       -> CSS / JS
  GET  /api/data       -> ui_data.json (the tested-engine snapshot)
  GET  /api/status     -> {"building": bool}
  POST /api/refresh    -> regenerate ui_data.json in the background (~1-2 min)

Security: if DASHBOARD_USER and DASHBOARD_PASS are set, every route except /health
requires HTTP Basic auth (set them in production). REFRESH_HOURS (optional) makes the
service self-refresh the snapshot on an interval. Single-flight refresh; security headers.

Run:  python ui/server.py [port]   (PORT env on App Platform)
"""
from __future__ import annotations

import base64
import hmac
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DATA = os.path.join(HERE, "ui_data.json")
_BUILDING = {"on": False}
_USER, _PASS = os.environ.get("DASHBOARD_USER"), os.environ.get("DASHBOARD_PASS")
_AUTH = bool(_USER and _PASS)
_CTYPE = {".html": "text/html; charset=utf-8", ".css": "text/css",
          ".js": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml"}
_SEC = {"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer", "Cache-Control": "no-store"}


def _ctype(fp):
    return _CTYPE.get(os.path.splitext(fp)[1], "application/octet-stream")


def _build():
    try:
        subprocess.run([sys.executable, os.path.join(HERE, "build_ui_data.py")], check=False)
    finally:
        _BUILDING["on"] = False


def _refresh_async():
    if not _BUILDING["on"]:
        _BUILDING["on"] = True
        threading.Thread(target=_build, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    server_version = "harvest-dash"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in _SEC.items():
            self.send_header(k, v)
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _authed(self) -> bool:
        if not _AUTH:
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                u, _, p = base64.b64decode(h[6:]).decode("utf-8", "ignore").partition(":")
                if hmac.compare_digest(u, _USER) and hmac.compare_digest(p, _PASS):
                    return True
            except Exception:
                pass
        self._send(401, b'{"error":"unauthorized"}',
                   extra={"WWW-Authenticate": 'Basic realm="harvest-dashboard"'})
        return False

    def _file(self, fp):
        with open(fp, "rb") as f:
            self._send(200, f.read(), _ctype(fp))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":                                  # unauthenticated liveness
            return self._send(200, json.dumps({"ok": True, "building": _BUILDING["on"]}).encode())
        if not self._authed():
            return
        if path == "/":
            return self._file(os.path.join(STATIC, "index.html"))
        if path == "/api/data":
            return self._file(DATA) if os.path.exists(DATA) else self._send(503, b'{"error":"no snapshot"}')
        if path == "/api/status":
            return self._send(200, json.dumps({"building": _BUILDING["on"]}).encode())
        if path.startswith("/static/"):
            fp = os.path.realpath(os.path.join(HERE, path.lstrip("/")))
            if os.path.commonpath([fp, STATIC]) == STATIC and os.path.isfile(fp):
                return self._file(fp)
        return self._send(404, b"not found", "text/plain")

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if not self._authed():
            return
        if self.path.split("?")[0] == "/api/refresh":
            _refresh_async()
            return self._send(202, b'{"started":true}')
        return self._send(404, b"not found", "text/plain")


def _periodic(hours: float):
    while True:
        time.sleep(hours * 3600)
        _refresh_async()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8080))
    if not os.path.exists(DATA):
        print("No ui_data.json — building once..."); _build()
    if not _AUTH:
        print("WARNING: DASHBOARD_USER/DASHBOARD_PASS not set — running OPEN (set them in production).")
    rh = os.environ.get("REFRESH_HOURS")
    if rh:
        threading.Thread(target=_periodic, args=(float(rh),), daemon=True).start()
        print(f"self-refresh every {rh}h enabled")
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Dashboard → http://0.0.0.0:{port}   auth={'on' if _AUTH else 'OFF'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
