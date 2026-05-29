"""Dual-leg Bollinger-band "short-gamma" harvester on ETH 8H.

Spec (as requested): hold a LONG and a SHORT leg on the SAME asset at once. Each time
price tags the band that favours a leg (upper -> long, lower -> short), realise (harvest)
that leg's gain to cash and re-arm the leg at the new price; a leg may only re-harvest
after price has returned to the mid band (so every harvest is a genuine swing). The
opposite leg is LEFT OPEN ("stays negative") until price reverses to its band. No stop —
the banked harvests cushion the stuck leg. This is short gamma: it prints in chop and
bleeds the stuck leg in a sustained trend.

Run:  python bb_harvest_eth.py [--days 365] [--leg 0.5] [--n 20] [--k 2] [--cost-bps 5]
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import binance_vision as bv


def fetch_8h(pair: str, days: int) -> pd.DataFrame:
    start_ms = int((datetime.now(timezone.utc).timestamp() - days * 86400) * 1000)
    kl = bv.fetch_klines(pair, "8h", start_ms)
    idx = pd.to_datetime([datetime.fromtimestamp(int(k[0]) / 1000, tz=timezone.utc) for k in kl])
    df = pd.DataFrame({"open": [float(k[1]) for k in kl], "high": [float(k[2]) for k in kl],
                       "low": [float(k[3]) for k in kl], "close": [float(k[4]) for k in kl]},
                      index=idx)
    return df[~df.index.duplicated(keep="last")].sort_index()


def backtest(df: pd.DataFrame, days: int, n=20, k=2.0, leg_frac=0.5,
             cost_bps=5.0, start=10000.0):
    px = df["close"]
    mid = px.rolling(n).mean()
    sd = px.rolling(n).std(ddof=0)
    d = df.assign(mid=mid, up=mid + k * sd, lo=mid - k * sd).dropna()
    run_lo = d.index[-1] - pd.Timedelta(days=days)
    d = d[d.index >= run_lo]                                   # warm BB, then 1y window

    L = leg_frac * start                                       # fixed $ notional per leg
    c = cost_bps * 1e-4
    cash = -2 * L * c                                          # open both legs
    long_entry = short_entry = float(d["close"].iloc[0])
    long_ready = short_ready = False                           # must touch mid to re-arm
    nharv = {"long": 0, "short": 0}
    rows = []
    for ts, p, m, u, lo in zip(d.index, d["close"], d["mid"], d["up"], d["lo"]):
        if p <= m:
            long_ready = True
        if p >= m:
            short_ready = True
        if p >= u and long_ready:                              # up-swing: harvest the long
            cash += L * (p / long_entry - 1.0) - 2 * L * c
            long_entry = p; long_ready = False; nharv["long"] += 1
        if p <= lo and short_ready:                            # down-swing: harvest the short
            cash += L * (1.0 - p / short_entry) - 2 * L * c
            short_entry = p; short_ready = False; nharv["short"] += 1
        long_mtm = L * (p / long_entry - 1.0)
        short_mtm = L * (1.0 - p / short_entry)
        rows.append((ts, p, start + cash + long_mtm + short_mtm, cash, long_mtm, short_mtm))
    res = pd.DataFrame(rows, columns=["ts", "px", "equity", "cash", "long_mtm", "short_mtm"]).set_index("ts")
    return res, nharv, L


def report(res, nharv, L, leg_frac, start=10000.0):
    eq = res["equity"]
    ret = eq.iloc[-1] / start - 1.0
    peak = eq.cummax(); dd = (eq / peak - 1.0).min()
    yrs = (res.index[-1] - res.index[0]).days / 365.25
    cagr = (eq.iloc[-1] / start) ** (1 / yrs) - 1 if yrs > 0 and eq.iloc[-1] > 0 else float("nan")
    print(f"  window      {res.index[0].date()} -> {res.index[-1].date()}  ({len(res)} 8H bars, {yrs:.2f}y)")
    print(f"  ETH price   ${res['px'].iloc[0]:,.0f} -> ${res['px'].iloc[-1]:,.0f}  ({res['px'].iloc[-1]/res['px'].iloc[0]-1:+.1%} buy&hold)")
    print(f"  leg size    ${L:,.0f} each  (gross ${2*L:,.0f} = {2*leg_frac:.1f}x of ${start:,.0f})")
    print(f"  FINAL EQ    ${eq.iloc[-1]:,.0f}   return {ret:+.1%}   CAGR {cagr:+.1%}")
    print(f"  max DD      {dd:.1%}   min equity ${eq.min():,.0f}" + ("   *** RUINED ***" if eq.min() <= 0 else ""))
    print(f"  harvests    long {nharv['long']}  short {nharv['short']}  (banked cash ${res['cash'].iloc[-1]:,.0f})")
    print(f"  open legs   long MTM ${res['long_mtm'].iloc[-1]:,.0f}   short MTM ${res['short_mtm'].iloc[-1]:,.0f}")


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--leg", type=float, default=0.5)          # notional per leg, x of capital
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--k", type=float, default=2.0)
    ap.add_argument("--cost-bps", type=float, default=5.0)
    ap.add_argument("--pair", default="ETHUSDT")
    a = ap.parse_args(argv)
    df = fetch_8h(a.pair, a.days + 40)
    res, nharv, L = backtest(df, a.days, a.n, a.k, a.leg, a.cost_bps)
    print(f"\n=== Dual-leg BB harvester — {a.pair} 8H, BB({a.n},{a.k}) ===")
    report(res, nharv, L, a.leg)
    res.to_csv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "bb_harvest_eth.csv"))
    return res


if __name__ == "__main__":
    main(sys.argv[1:])
