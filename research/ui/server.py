"""Zero-dependency dashboard server (Python stdlib only).

Serves the SPA + a tiny JSON API over the precomputed snapshot:
  GET  /                -> the dashboard (static/index.html)
  GET  /static/*        -> CSS / JS
  GET  /api/data        -> ui_data.json (the tested-engine snapshot)
  GET  /api/status      -> {"building": bool}
  POST /api/refresh     -> regenerate ui_data.json in the background (~1-2 min)

Run:  python ui/server.py [port]   (default 8000)   then open http://localhost:8000
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DATA = os.path.join(HERE, "ui_data.json")
_BUILDING = {"on": False}
_CTYPE = {".html": "text/html; charset=utf-8", ".css": "text/css",
          ".js": "application/javascript", ".json": "application/json",
          ".svg": "image/svg+xml"}


def _ctype(fp: str) -> str:
    return _CTYPE.get(os.path.splitext(fp)[1], "application/octet-stream")


def _build():
    try:
        subprocess.run([sys.executable, os.path.join(HERE, "build_ui_data.py")], check=False)
    finally:
        _BUILDING["on"] = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code: int, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _file(self, fp: str):
        with open(fp, "rb") as f:
            self._send(200, f.read(), _ctype(fp))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            return self._file(os.path.join(STATIC, "index.html"))
        if path == "/api/data":
            if os.path.exists(DATA):
                return self._file(DATA)
            return self._send(503, b'{"error":"no snapshot yet; POST /api/refresh"}')
        if path == "/api/status":
            return self._send(200, json.dumps({"building": _BUILDING["on"]}).encode())
        if path.startswith("/static/"):
            fp = os.path.realpath(os.path.join(HERE, path.lstrip("/")))
            if os.path.commonpath([fp, STATIC]) == STATIC and os.path.isfile(fp):
                return self._file(fp)
        return self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if self.path.split("?")[0] == "/api/refresh":
            if not _BUILDING["on"]:
                _BUILDING["on"] = True
                threading.Thread(target=_build, daemon=True).start()
            return self._send(202, b'{"started":true}')
        return self._send(404, b"not found", "text/plain")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8000))
    if not os.path.exists(DATA):
        print("No ui_data.json yet — building once...")
        _build()
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Dashboard → http://localhost:{port}   (Ctrl-C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
