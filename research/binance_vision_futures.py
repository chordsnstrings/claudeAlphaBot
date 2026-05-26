"""Binance Vision FUTURES loader — funding rate + open-interest / positioning metrics.

`data.binance.vision` (the static dump bucket; sibling of the `data-api.binance.vision`
klines mirror used by `binance_vision.py`) publishes USDT-margined (UM) perpetual-futures
history as zipped CSVs — no API key, and reachable from this environment even though the
live `fapi.binance.com` is geo-blocked (HTTP 451).

This unblocks the single external lever the prediction study flagged but could not test:
positioning data (funding / open interest / long-short ratios). Honest expectation from
PREDICTION_TO_80_BTC_ETH.md is a few % of direction lift (~55% ceiling, NOT 80%).

Sources (UM = USDT-margined perp):
  funding (monthly):  /futures/um/monthly/fundingRate/<PAIR>/<PAIR>-fundingRate-YYYY-MM.zip
      cols: calc_time(ms), funding_interval_hours, last_funding_rate   (3 settlements/day @ 8h)
  metrics (daily):    /futures/um/daily/metrics/<PAIR>/<PAIR>-metrics-YYYY-MM-DD.zip
      cols: create_time, symbol, sum_open_interest, sum_open_interest_value,
            count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio,
            count_long_short_ratio, sum_taker_long_short_vol_ratio   (5-min snapshots)

Availability (verified 2026-05): funding 2020-01 -> last *complete* month (no daily-funding
dumps exist, so the current partial month is absent); metrics 2021-01-01 -> yesterday.

Causality: every daily aggregate uses only within-day data and aligns to the spot 'date'
row whose close is end-of-day-D. Funding settles by 16:00 UTC (<= close[D]); the metrics
end-of-day snapshot is ~23:55 UTC (~ close[D]). No look-ahead.

Outputs (slim daily CSV, one row per UTC date):
  research/data/futures/<SYM>_funding.csv  date,funding_sum,funding_mean,funding_n
  research/data/futures/<SYM>_metrics.csv  date,oi,oi_value,oi_mean,ls_global,ls_top,taker_ls
"""
from __future__ import annotations

import csv
import io
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
FUT_DIR = os.path.join(HERE, "data", "futures")
BASE = "https://data.binance.vision/data/futures/um"

# research symbol -> Binance UM perpetual pair
PAIRS = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "SOL": "SOLUSDT",
    "DOGE": "DOGEUSDT",
    "XRP": "XRPUSDT",
}

FUNDING_START = (2020, 1)        # earliest monthly funding dump
METRICS_START = date(2021, 1, 1)  # earliest daily metrics dump
WORKERS = 16                      # concurrent downloads for the ~2k daily metrics files


def _download(url: str, retries: int = 4) -> bytes | None:
    """Return raw bytes, None on 404 (missing file). Retry transient network errors."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
            with urllib.request.urlopen(req, timeout=45) as r:  # noqa: S310
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError) as e:  # noqa: PERF203
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"download failed after {retries} tries: {url}\n  {last}")


def _csv_rows(zbytes: bytes):
    """Yield CSV rows (list[str]) from the single CSV inside a zip's bytes."""
    with zipfile.ZipFile(io.BytesIO(zbytes)) as z:
        name = z.namelist()[0]
        with z.open(name) as f:
            yield from csv.reader(io.TextIOWrapper(f, encoding="utf-8"))


# ---------------------------------------------------------------- funding ----
def fetch_funding(sym: str, force: bool = False) -> str:
    """Download monthly funding dumps, aggregate to one row per UTC day."""
    pair = PAIRS[sym]
    out = os.path.join(FUT_DIR, f"{sym}_funding.csv")
    if os.path.exists(out) and not force:
        print(f"[fut] {sym} funding cached -> {out}", file=sys.stderr)
        return out
    os.makedirs(FUT_DIR, exist_ok=True)
    day_rates: dict[str, list[float]] = {}
    y, m = FUNDING_START
    now = datetime.now(timezone.utc)
    n_files = 0
    while (y, m) <= (now.year, now.month):
        url = f"{BASE}/monthly/fundingRate/{pair}/{pair}-fundingRate-{y:04d}-{m:02d}.zip"
        data = _download(url)
        if data is not None:
            n_files += 1
            for row in _csv_rows(data):
                if len(row) < 3:
                    continue
                try:
                    ts = int(row[0])
                    rate = float(row[2])
                except ValueError:
                    continue  # header row ("calc_time")
                d = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                day_rates.setdefault(d, []).append(rate)
        m += 1
        if m > 12:
            m, y = 1, y + 1
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "funding_sum", "funding_mean", "funding_n"])
        for d in sorted(day_rates):
            r = day_rates[d]
            w.writerow([d, f"{sum(r):.10f}", f"{sum(r) / len(r):.10f}", len(r)])
    days = sorted(day_rates)
    print(f"[fut] {sym} funding: {len(days)} days {days[0]}->{days[-1]} "
          f"({n_files} monthly files) -> {out}", file=sys.stderr)
    return out


# ---------------------------------------------------------------- metrics ----
def _agg_metrics_day(pair: str, d: date) -> tuple[str, dict | None]:
    """Download one daily metrics file and reduce to end-of-day + daily-mean fields."""
    url = f"{BASE}/daily/metrics/{pair}/{pair}-metrics-{d.isoformat()}.zip"
    data = _download(url)
    if data is None:
        return d.isoformat(), None
    last_t = ""
    eod = {"oi": None, "oi_value": None, "ls_global": None, "ls_top": None}
    sums = {"oi": 0.0, "taker_ls": 0.0}
    n = 0
    for row in _csv_rows(data):
        if len(row) < 8 or row[0] == "create_time":
            continue
        try:
            oi = float(row[2]); oi_val = float(row[3])
            ls_top = float(row[5]); ls_global = float(row[6]); taker_ls = float(row[7])
        except ValueError:
            continue
        t = row[0]
        sums["oi"] += oi
        sums["taker_ls"] += taker_ls
        n += 1
        if t >= last_t:  # latest snapshot of the day = end-of-day state (causal at close)
            last_t = t
            eod = {"oi": oi, "oi_value": oi_val, "ls_global": ls_global, "ls_top": ls_top}
    if n == 0:
        return d.isoformat(), None
    return d.isoformat(), {
        "oi": eod["oi"], "oi_value": eod["oi_value"], "oi_mean": sums["oi"] / n,
        "ls_global": eod["ls_global"], "ls_top": eod["ls_top"],
        "taker_ls": sums["taker_ls"] / n,
    }


def fetch_metrics(sym: str, force: bool = False) -> str:
    """Download daily metrics dumps concurrently, one row per UTC day."""
    pair = PAIRS[sym]
    out = os.path.join(FUT_DIR, f"{sym}_metrics.csv")
    if os.path.exists(out) and not force:
        print(f"[fut] {sym} metrics cached -> {out}", file=sys.stderr)
        return out
    os.makedirs(FUT_DIR, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    days = []
    d = METRICS_START
    while d <= today:
        days.append(d)
        d += timedelta(days=1)
    rows: dict[str, dict] = {}
    missing = 0
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(_agg_metrics_day, pair, dd): dd for dd in days}
        for fut in as_completed(futs):
            ds, agg = fut.result()
            done += 1
            if agg is None:
                missing += 1
            else:
                rows[ds] = agg
            if done % 250 == 0:
                print(f"[fut] {sym} metrics {done}/{len(days)} ...", file=sys.stderr)
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "oi", "oi_value", "oi_mean", "ls_global", "ls_top", "taker_ls"])
        for ds in sorted(rows):
            r = rows[ds]
            w.writerow([ds, f"{r['oi']:.4f}", f"{r['oi_value']:.4f}", f"{r['oi_mean']:.4f}",
                        f"{r['ls_global']:.6f}", f"{r['ls_top']:.6f}", f"{r['taker_ls']:.6f}"])
    ds_sorted = sorted(rows)
    print(f"[fut] {sym} metrics: {len(ds_sorted)} days {ds_sorted[0]}->{ds_sorted[-1]} "
          f"({missing} missing/404) -> {out}", file=sys.stderr)
    return out


def main(argv):
    syms = [a.upper() for a in argv if a.upper() in PAIRS] or ["BTC", "ETH"]
    mode = ("funding" if "--funding" in argv else
            "metrics" if "--metrics" in argv else "all")
    force = "--force" in argv
    for sym in syms:
        if mode in ("funding", "all"):
            fetch_funding(sym, force=force)
        if mode in ("metrics", "all"):
            fetch_metrics(sym, force=force)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
