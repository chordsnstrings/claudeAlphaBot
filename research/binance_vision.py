"""Binance Vision (data-api.binance.vision) OHLCV loader.

`data-api.binance.vision` is Binance's PUBLIC market-data mirror. Unlike
`api.binance.com` (geo-blocked, HTTP 451 from this environment) it is reachable
and serves the same read-only `/api/v3/klines` endpoint — no API key, market data
only (no account/trading/signed endpoints).

This unblocks two things the earlier research could not get:
  * real **SOL** price history (Coin Metrics community tier only has a 7-row stub;
    the old harness substituted DOT). Binance SOLUSDT goes back to 2020-08-11.
  * real **intraday** (1h / 8h-by-resample) candles for finer-grained strategies.

Endpoint:
  GET https://data-api.binance.vision/api/v3/klines?symbol=SOLUSDT&interval=1d
      &startTime=<ms>&endTime=<ms>&limit=1000
  kline = [openTime, open, high, low, close, volume, closeTime, quoteVol,
           nTrades, takerBuyBase, takerBuyQuote, ignore]   ASC, max 1000/req.

Outputs:
  * daily  -> research/data/<SYM>_daily.csv   columns date,close,volume_usd
              (same slim schema the daily harness's data.load() consumes)
  * intraday -> research/data/intraday/<SYM>_<tf>.csv  full OHLCV.
"""
from __future__ import annotations

import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
INTRADAY_DIR = os.path.join(DATA_DIR, "intraday")
BASE = "https://data-api.binance.vision/api/v3/klines"

# research symbol -> Binance spot pair
PAIRS = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "SOL": "SOLUSDT",
    "DOGE": "DOGEUSDT",
    "XRP": "XRPUSDT",
}

INTERVAL_MS = {
    "1d": 86_400_000,
    "8h": 8 * 3_600_000,
    "1h": 3_600_000,
}
MAX_PER_REQ = 1000
PACE_S = 0.25


def _get(url: str, retries: int = 4) -> list:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
            with urllib.request.urlopen(req, timeout=45) as r:  # noqa: S310
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:  # noqa: PERF203
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"GET failed after {retries} tries: {url}\n  {last}")


def reachable() -> bool:
    try:
        _get("https://data-api.binance.vision/api/v3/ping", retries=1)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[binance_vision] not reachable: {e}", file=sys.stderr)
        return False


def fetch_klines(pair: str, interval: str, start_ms: int, end_ms: int | None = None) -> list[list]:
    """Paginate /klines forward from start_ms. Returns ASC rows (deduped)."""
    step = INTERVAL_MS[interval]
    if end_ms is None:
        end_ms = int(time.time() * 1000)
    rows: list[list] = []
    cursor = start_ms
    while cursor < end_ms:
        url = (f"{BASE}?symbol={pair}&interval={interval}"
               f"&startTime={cursor}&endTime={end_ms}&limit={MAX_PER_REQ}")
        batch = _get(url)
        if not batch:
            break
        rows.extend(batch)
        last_open = int(batch[-1][0])
        nxt = last_open + step
        if nxt <= cursor:
            break
        cursor = nxt
        if len(batch) < MAX_PER_REQ:
            break
        time.sleep(PACE_S)
    # dedupe by openTime
    seen = {}
    for k in rows:
        seen[int(k[0])] = k
    return [seen[t] for t in sorted(seen)]


def fetch_daily(sym: str, force: bool = False) -> str:
    """Fetch full daily history, write slim date,close,volume_usd CSV."""
    pair = PAIRS[sym]
    out_path = os.path.join(DATA_DIR, f"{sym}_daily.csv")
    if os.path.exists(out_path) and not force:
        print(f"[binance_vision] {sym} daily cached -> {out_path}", file=sys.stderr)
        return out_path
    os.makedirs(DATA_DIR, exist_ok=True)
    # 2017-07-01; Binance's earliest listings. Each pair just returns from its
    # own listing date.
    start_ms = int(datetime(2017, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
    kl = fetch_klines(pair, "1d", start_ms)
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "close", "volume_usd"])
        for k in kl:
            open_ms = int(k[0])
            close = float(k[4])
            quote_vol = float(k[7])  # quote volume ~ USD turnover
            d = datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            if close > 0:
                w.writerow([d, close, quote_vol])
    first = datetime.fromtimestamp(int(kl[0][0]) / 1000, tz=timezone.utc).date()
    last = datetime.fromtimestamp(int(kl[-1][0]) / 1000, tz=timezone.utc).date()
    print(f"[binance_vision] {sym} daily: {len(kl)} rows {first} -> {last} -> {out_path}",
          file=sys.stderr)
    return out_path


def fetch_intraday(sym: str, interval: str, years: float = 6.0, force: bool = False) -> str:
    pair = PAIRS[sym]
    os.makedirs(INTRADAY_DIR, exist_ok=True)
    out_path = os.path.join(INTRADAY_DIR, f"{sym}_{interval}.csv")
    if os.path.exists(out_path) and not force:
        print(f"[binance_vision] {sym} {interval} cached -> {out_path}", file=sys.stderr)
        return out_path
    start_ms = int((time.time() - years * 365 * 86400) * 1000)
    kl = fetch_klines(pair, interval, start_ms)
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp_ms", "date", "open", "high", "low", "close", "volume", "quote_volume"])
        for k in kl:
            open_ms = int(k[0])
            d = datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            w.writerow([open_ms, d, k[1], k[2], k[3], k[4], k[5], k[7]])
    first = datetime.fromtimestamp(int(kl[0][0]) / 1000, tz=timezone.utc)
    last = datetime.fromtimestamp(int(kl[-1][0]) / 1000, tz=timezone.utc)
    print(f"[binance_vision] {sym} {interval}: {len(kl)} candles {first} -> {last} -> {out_path}",
          file=sys.stderr)
    return out_path


def main(argv):
    if not reachable():
        return 2
    syms = [a.upper() for a in argv if a.upper() in PAIRS] or list(PAIRS)
    mode = "intraday" if "--intraday" in argv else ("daily" if "--daily" in argv else "all")
    tfs = [a for a in argv if a in ("1h", "8h")] or ["1h"]
    force = "--force" in argv
    for sym in syms:
        if mode in ("daily", "all"):
            fetch_daily(sym, force=force)
        if mode in ("intraday", "all"):
            for tf in tfs:
                fetch_intraday(sym, tf, force=force)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
