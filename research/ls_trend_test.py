"""Pure long/short slow-trend CTA — the cleanest 'short the bear, long the bull' test.

This isolates the most direct candidate for banking the 2022 bear: a per-asset
long/short trend that is SHORT below a slow EMA and LONG above it (vol-targeted,
no mean-reversion, no chop-flat). A slow filter is stable enough to be short for
most of a sustained bear and long for most of a sustained bull, so if ANY single
directional engine could bank both 2022 and 2023 it is this one.

Finding (see the sweep): it banks 2022 (+50..+63%) in nearly every setting but
MISSES 2023 (-40..-45%) in EVERY setting — 2023 was a chop-with-net-up year that
whipsaws directional trend; it is bankable only via cross-sectional dispersion.
This is the fourth independent confirmation (after the dense simplex blend, the
3-sleeve defensive blend, and the causal regime switch) that no causal engine on
this universe banks +50% in both 2022 and 2023: the postures required are opposite.
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import annual_target as at
from annual_target import simulate_year, TARGET
from engine import Costs, backtest, ema
from strategies import build_weights

COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
STOP = 0.40
COSTS = Costs(txn=0.0006, funding_daily=0.0001)


def ls_trend_weights(prices, slow, band, vt, ml):
    f = ema(prices, max(10, slow // 4))
    s = ema(prices, slow)
    spread = f / s - 1.0
    raw = pd.Series(0.0, index=prices.index)
    raw[spread > band] = 1.0
    raw[spread < -band] = -1.0
    return build_weights(prices, raw, dict(vol_target=vt, vol_lb=30, max_lev=ml, long_only=False))


def book_per_year(slow, band, vt, ml, m):
    streams = {}
    for c in COINS:
        p = at.load_prices(c)
        streams[c] = backtest(p, ls_trend_weights(p, slow, band, vt, ml), COSTS)["returns"]
    bk = pd.DataFrame(streams).mean(axis=1).dropna()
    py = []
    for y in sorted(set(bk.index.year)):
        ry = bk[bk.index.year == y]
        if len(ry) < 250:
            continue
        py.append((int(y), simulate_year(ry.values, m, TARGET, STOP)))
    rs = np.array([r for _, r in py])
    return int((rs >= TARGET - 1e-9).sum()), len(py), float(rs.min()), dict(py)


def main(argv):
    print("PURE LONG/SHORT SLOW-TREND book — does any setting bank BOTH 2022 and 2023?")
    print(f"{'slow':>5}{'band':>6}{'vt':>5}{'m':>3}  banked  worst   2022    2023    2025")
    any_both = False
    for slow in (100, 150, 200):
        for band in (0.0, 0.02):
            for vt in (0.4, 0.6):
                for m in (2, 3):
                    b, n, worst, d = book_per_year(slow, band, vt, 3.0, m)
                    both = d.get(2022, -1) >= TARGET and d.get(2023, -1) >= TARGET
                    any_both = any_both or both
                    flag = "  <-- BOTH" if both else ""
                    print(f"{slow:>5}{band:>6}{vt:>5}{m:>3}  {b}/{n}  {worst:>5.0%}  "
                          f"{d.get(2022,0):>5.0%}  {d.get(2023,0):>6.0%}  {d.get(2025,0):>6.0%}{flag}")
    print(f"\nAny setting banks BOTH 2022 and 2023? {'YES' if any_both else 'NO'} "
          f"-> confirms the opposite-posture tension.")


if __name__ == "__main__":
    main(sys.argv[1:])
