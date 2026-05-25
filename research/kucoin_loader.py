"""KuCoin 1H / 8H OHLCV loader.

IMPORTANT: this sandbox's network allowlist blocks api.kucoin.com (403 "Host not
in allowlist"), so this script cannot fetch here. It is written to run the moment
KuCoin is reachable — i.e. when either:
  * `api.kucoin.com` is added to the Claude Code web environment's network policy, or
  * it is run outside the sandbox (locally / on the deployed bot).

KuCoin spot candles API (no key needed for market data):
  GET https://api.kucoin.com/api/v1/market/candles
      ?type=1hour|8hour&symbol=BTC-USDT&startAt=<sec>&endAt=<sec>
  - returns data as [time(sec), open, close, high, low, volume, turnover], DESC
  - max 1500 candles per request -> paginate backwards by time

Output: research/data/intraday/<SYM>_<tf>.csv with columns
  timestamp(ms),date(UTC),open,high,low,close,volume
which the research harness can load directly (1h) or resample (1h->8h).
"""
from __future__ import annotations

import csv
import os
import sys
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "data", "intraday")
BASE = "https://api.kucoin.com/api/v1/market/candles"

SYMBOLS = ["BTC-USDT", "ETH-USDT", "XRP-USDT", "DOGE-USDT"]
TF = {"1h": ("1hour", 3600), "8h": ("8hour", 8 * 3600)}
MAX_PER_REQ = 1500
PAGE_PACE_S = 0.4


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
        import json
        return json.loads(r.read().decode("utf-8"))


def reachable() -> bool:
    try:
        _get("https://api.kucoin.com/api/v1/timestamp")
        return True
    except urllib.error.HTTPError as e:
        print(f"[kucoin] HTTP {e.code} from KuCoin — host likely blocked: {e.reason}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"[kucoin] cannot reach KuCoin: {e}", file=sys.stderr)
    return False


def fetch(symbol: str, tf: str, years: float = 6.0) -> int:
    kc_type, step_s = TF[tf]
    end_at = int(time.time())
    start_floor = end_at - int(years * 365 * 86400)
    rows: list[list] = []
    cursor = end_at
    while cursor > start_floor:
        start_at = max(start_floor, cursor - MAX_PER_REQ * step_s)
        url = f"{BASE}?type={kc_type}&symbol={symbol}&startAt={start_at}&endAt={cursor}"
        resp = _get(url)
        data = resp.get("data") or []
        if not data:
            break
        rows.extend(data)
        oldest = min(int(x[0]) for x in data)
        if oldest <= start_floor:
            break
        cursor = oldest - 1
        time.sleep(PAGE_PACE_S)

    # de-dup, sort ascending, write
    seen = {}
    for x in rows:
        t = int(x[0])
        seen[t] = x
    ordered = [seen[t] for t in sorted(seen)]
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{symbol.replace('-', '')}_{tf}.csv")
    from datetime import datetime, timezone
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp_ms", "date", "open", "high", "low", "close", "volume"])
        for t, o, c, h, l, v, *_ in ordered:
            ts = int(t)
            dt = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            w.writerow([ts * 1000, dt, o, h, l, c, v])  # note KuCoin order: o,c,h,l,v
    print(f"[kucoin] {symbol} {tf}: {len(ordered)} candles -> {path}", file=sys.stderr)
    return len(ordered)


def main(argv):
    if not reachable():
        print("KuCoin is NOT reachable from here. Add api.kucoin.com to the "
              "environment network allowlist, or run this outside the sandbox.",
              file=sys.stderr)
        return 2
    tfs = [a for a in argv if a in TF] or ["1h", "8h"]
    for sym in SYMBOLS:
        for tf in tfs:
            try:
                fetch(sym, tf)
            except Exception as e:  # noqa: BLE001
                print(f"[kucoin] {sym} {tf} FAILED: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
