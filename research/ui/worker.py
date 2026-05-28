"""Private trading WORKER for the unified harvest bot — the only component that holds
exchange keys and can place orders. Deploy with NO public ingress (internal only); the
public dashboard reaches it over the platform's internal network to issue commands.

Safety model (defense in depth):
  * PAPER by default. Live requires ALL of: MODE=live, EXCHANGE_API_KEY/SECRET in env,
    and LIVE_CONFIRMED=yes. Any missing -> stays paper.
  * HARD CAPS the UI cannot exceed: MAX_LEVERAGE (default 1.5 — the OOS-safe knee),
    MAX_GROSS, DAILY_LOSS_LIMIT. set_leverage is clamped to MAX_LEVERAGE.
  * Kill-switch (`flatten`) zeroes the book and pauses.
  * Command API is token-authenticated and internal-only.
  * Every command + cycle is written to an audit log (SQLite).

State persists to SQLite. NOTE: on ephemeral hosts (App Platform local disk) point
DB_PATH at a managed/persistent store, or reconcile from the exchange on boot — otherwise
the harvest baseline/cash-floor are lost on restart.

Commands (POST /cmd, bearer token):  pause | resume | flatten | set_mode {mode} | set_leverage {m}
Read:  GET /state   GET /health
Run:   python worker.py            # loop, one cycle / CYCLE_SECONDS
       python worker.py --once      # single cycle then exit (for tests/cron)
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # research/
import live_trader as lt

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(HERE, "worker_state.db"))
TOKEN = os.environ.get("WORKER_TOKEN", "")
CYCLE_SECONDS = float(os.environ.get("CYCLE_SECONDS", 86400))     # daily
MAX_LEVERAGE = float(os.environ.get("MAX_LEVERAGE", 1.5))         # the OOS-safe knee
MAX_GROSS = float(os.environ.get("MAX_GROSS", 3.0))
DAILY_LOSS_LIMIT = float(os.environ.get("DAILY_LOSS_LIMIT", 0.15))
LIVE_OK = (os.environ.get("MODE") == "live"
           and os.environ.get("LIVE_CONFIRMED") == "yes"
           and bool(os.environ.get("EXCHANGE_API_KEY") and os.environ.get("EXCHANGE_API_SECRET")))


def _db():
    c = sqlite3.connect(DB_PATH)
    c.execute("CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS audit(ts TEXT, msg TEXT)")
    return c


def audit(msg: str):
    with _db() as c:
        c.execute("INSERT INTO audit VALUES(?,?)", (datetime.now(timezone.utc).isoformat(), msg))
    print("[audit]", msg)


def get_state() -> dict:
    with _db() as c:
        row = c.execute("SELECT v FROM state WHERE k='bot'").fetchone()
    if row:
        return json.loads(row[0])
    st = lt.init_state(float(os.environ.get("BASE", 300000)), "paper")
    st.update(paused=True, leverage=min(1.5, MAX_LEVERAGE))       # start PAUSED + safe leverage
    return st


def put_state(st: dict):
    with _db() as c:
        c.execute("INSERT OR REPLACE INTO state VALUES('bot',?)", (json.dumps(st, default=str),))


def capture_base(st: dict, broker, live: bool):
    """Lock the harvest baseline to the ACTUAL starting asset the first time the bot trades
    (and again the first time it goes live), then log that number. Live -> the real account
    equity read from the exchange; paper -> the configured paper bankroll (BASE). Every
    harvest threshold (2x / year-stop / daily-loss / leave-on-the-table) is a PERCENTAGE of
    this number — nothing downstream is a hard-coded dollar amount."""
    if st.get("base_source") == "live":
        return                                             # real baseline already locked
    if not live and st.get("base_source") == "paper":
        return                                             # paper baseline already logged
    if live:
        eq = broker.equity(st)
        if eq and eq > 0:                                  # start the harvest fresh from the real balance
            st.update(base=eq, equity=eq, cum_cash=0.0, principal_returned=False,
                      locked=False, history=[])
        st["base_source"] = "live"
    else:
        st["base_source"] = "paper"
    d2x, stop = lt.CFG["double_at"], lt.CFG["year_stop"]
    audit(f"STARTING ASSET ${st['base']:,.2f} ({st['base_source']}) — baseline locked; "
          f"2x=${st['base'] * d2x:,.0f}, year-stop -{stop:.0%}, daily-loss -{DAILY_LOSS_LIMIT:.0%}")
    put_state(st)


def apply_command(st: dict, action: str, params: dict) -> str:
    if action == "pause":
        st["paused"] = True; return "paused"
    if action == "resume":
        st["paused"] = False; return "resumed"
    if action == "flatten":                                       # kill-switch
        st["held"] = {}; st["paused"] = True; st["_flatten"] = True; return "FLATTEN + paused"
    if action == "set_leverage":
        m = max(0.0, min(float(params.get("m", 1.0)), MAX_LEVERAGE))
        st["leverage"] = m; return f"leverage={m} (cap {MAX_LEVERAGE})"
    if action == "set_mode":
        want = params.get("mode", "paper")
        if want == "live" and not LIVE_OK:
            return "REJECTED set_mode live — needs MODE=live + LIVE_CONFIRMED=yes + keys in env"
        st["mode"] = want; return f"mode={st['mode']}"
    return f"unknown action {action}"


def run_cycle(st: dict):
    """One trading cycle. PAPER unless st['mode']=='live' AND LIVE_OK."""
    if st.get("paused"):
        audit("cycle skipped (paused)"); return
    lt.CFG["leverage"] = max(0.0, min(st.get("leverage", 1.5), MAX_LEVERAGE))   # enforce cap
    live = (st.get("mode") == "live" and LIVE_OK)
    broker = lt.broker_for("live" if live else "paper", dry_run=not live)
    capture_base(st, broker, live)                                # lock baseline to the real starting asset
    px, vol = lt.fetch_market(lt.CFG["history_days"])
    pre = st["equity"]
    out = lt.daily_cycle(st, px, vol, broker)
    if out.get("skipped"):
        return
    # daily loss guard (on top of the engine's -40% annual stop)
    if st["equity"] < pre * (1 - DAILY_LOSS_LIMIT) and pre > 0:
        st["held"] = {}; st["paused"] = True
        audit(f"DAILY-LOSS-LIMIT hit ({st['equity']/pre-1:+.1%}) -> flatten + pause")
        out["held"] = {}
    gross = sum(abs(w) for w in out.get("held", {}).values())
    if gross > MAX_GROSS:                                         # final exposure cap
        out["held"] = {c: w * MAX_GROSS / gross for c, w in out["held"].items()}
        st["held"] = out["held"]
    if live:
        broker.rebalance(out.get("held", {}), st["equity"], out.get("last", {}),
                         lt.CFG["rebal_band"], lt.CFG["leverage"])
    audit(f"cycle {out.get('date')} mode={st.get('mode')} eq=${st['equity']:,.0f} "
          f"gross={gross:.0%} {out.get('note','')}".strip())
    put_state(st)


# ----------------------------------------------------- internal command API
class Cmd(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _ok_token(self):
        if not TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "live_capable": LIVE_OK})
        if not self._ok_token():
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/state":
            st = get_state()
            st.pop("history", None)
            return self._send(200, {"state": st, "caps": {"max_leverage": MAX_LEVERAGE,
                              "max_gross": MAX_GROSS, "daily_loss_limit": DAILY_LOSS_LIMIT},
                              "live_capable": LIVE_OK})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._ok_token():
            return self._send(401, {"error": "unauthorized"})
        if self.path != "/cmd":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        st = get_state()
        res = apply_command(st, body.get("action", ""), body.get("params", {}))
        put_state(st); audit(f"cmd {body.get('action')} {body.get('params','')} -> {res}")
        return self._send(200, {"result": res})


def _loop():
    while True:
        try:
            run_cycle(get_state())
        except Exception as e:
            audit(f"cycle ERROR: {e}")
        time.sleep(CYCLE_SECONDS)


def main(argv):
    st0 = get_state()
    audit(f"worker start — starting asset ${st0['base']:,.2f} "
          f"(source={st0.get('base_source', 'pending first cycle')}), "
          f"live_capable={LIVE_OK}, max_lev={MAX_LEVERAGE}, db={DB_PATH}")
    if "--once" in argv:
        run_cycle(get_state()); return
    threading.Thread(target=_loop, daemon=True).start()
    port = int(os.environ.get("WORKER_PORT", 8090))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Cmd)
    print(f"worker command API on :{port} (internal only) — live_capable={LIVE_OK}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main(sys.argv[1:])
