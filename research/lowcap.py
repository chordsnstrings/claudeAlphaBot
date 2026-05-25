"""'Snipe the strongest low-caps, long' — systematic cross-sectional momentum on a
mid/low-cap basket, with the survivorship / slippage / delisting traps made explicit.

Basket (20 mid/low caps, data via Binance Vision) deliberately includes coins that
CRASHED 90-99% (FTT, LUNA, GALA, ROSE, AXS) and ones that were DELISTED (MATIC ends
2024-09, FTM 2025-01, WAVES 2024-06), so the sample is less survivorship-biased than
pure survivors. (It is still biased: only coins that reached Binance are here; the
hundreds of rugs that never listed, or delisted before our window, are absent. So
even these results are an UPPER bound on what was achievable.)

Strategy: each day rank the live coins by blended trailing return, hold the top-k
equal-weight (long-only = "snipe what's pumping"), rotate. Causal; a coin that
delists (price series ends -> score NaN) automatically drops out of the ranking and
the position exits (no look-ahead). Walk-forward the (lbs, k, vt) on train.

The decisive test is COST: low-caps have thin books, so we report the SAME strategy
under 6 bps (the large-cap assumption, unrealistic here), 50 bps, and 100 bps per
side, plus an optional delisting-gap penalty. This quantifies how much of the
headline low-cap return is real edge vs. frictionless-backtest fiction.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

from engine import ANN, realized_vol
from annual_target import simulate_year, TARGET

HERE = os.path.dirname(os.path.abspath(__file__))
LOWCAP_DIR = os.path.join(HERE, "data", "lowcap")
RESULTS = os.path.join(HERE, "results")
STOP = 0.40
SYMS = ["AVAX", "NEAR", "ATOM", "ALGO", "SAND", "MANA", "GALA", "ROSE", "MATIC",
        "FTM", "WAVES", "LUNA", "FTT", "AXS", "CHZ", "ENJ", "GRT", "ONE", "EGLD", "ZIL"]


def panel() -> pd.DataFrame:
    cols = {}
    for s in SYMS:
        p = os.path.join(LOWCAP_DIR, f"{s}_daily.csv")
        if not os.path.exists(p):
            continue
        df = pd.read_csv(p, parse_dates=["date"])
        cols[s] = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return pd.DataFrame(cols).sort_index()


def xs_long_returns(prices: pd.DataFrame, lbs, k, vt, txn, funding=0.0001,
                    delist_penalty=0.0) -> pd.Series:
    rets = prices.pct_change()
    score = sum(prices / prices.shift(L) - 1.0 for L in lbs) / float(len(lbs))
    ranks = score.rank(axis=1, ascending=False, method="first")
    valid = score.notna() & prices.notna()
    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    w = w.mask(ranks.le(k) & valid, 1.0)
    gross = w.sum(axis=1).replace(0.0, np.nan)
    w = w.div(gross, axis=0).fillna(0.0)
    # delisting penalty: if a held coin has a price today but NaN next day (last bar
    # before delisting), apply a one-off haircut to that coin's return.
    if delist_penalty:
        last_bar = prices.notna() & prices.shift(-1).isna()
        pen = (w.shift(1).fillna(0.0) * last_bar.astype(float)) * (-delist_penalty)
        delist_drag = pen.sum(axis=1)
    else:
        delist_drag = pd.Series(0.0, index=prices.index)
    basket = (w.shift(1).fillna(0.0) * rets.fillna(0.0)).sum(axis=1)
    rv = realized_vol(basket, 30).clip(lower=0.10)
    scale = (vt / rv).clip(upper=3.0).fillna(0.0)
    sw = w.mul(scale, axis=0)
    held = sw.shift(1).fillna(0.0)
    turn = held.diff().abs().sum(axis=1).fillna(held.abs().sum(axis=1))
    net = (held * rets.fillna(0.0)).sum(axis=1) - txn * turn \
        - funding * held.abs().sum(axis=1) + delist_drag * scale.shift(1).fillna(0.0)
    return net.dropna()


def wf(prices, txn, delist_penalty, train_days=540, test_days=180) -> pd.Series:
    grid = [dict(lbs=lbs, k=k, vt=vt)
            for lbs in ((20, 40, 80), (10, 30, 60), (30, 60, 120))
            for k in (2, 3, 5)
            for vt in (0.4, 0.6, 0.9)]
    series = [(p, xs_long_returns(prices, txn=txn, delist_penalty=delist_penalty, **p))
              for p in grid]
    idx = series[0][1].index
    for _, s in series:
        idx = idx.union(s.index)
    idx = idx.sort_values()
    start, end = idx[0], idx[-1]
    chunks = []
    t0 = start
    tr, te = pd.Timedelta(days=train_days), pd.Timedelta(days=test_days)
    while t0 + tr + te <= end + pd.Timedelta(days=1):
        lo, mid, hi = t0, t0 + tr, t0 + tr + te
        best, bsc = None, -np.inf
        for p, r in series:
            trs = r[(r.index >= lo) & (r.index < mid)]
            if len(trs) < 60 or trs.std(ddof=0) == 0:
                continue
            sc = trs.mean() / trs.std(ddof=0) * np.sqrt(ANN)
            if sc > bsc:
                bsc, best = sc, r
        if best is not None:
            tes = best[(best.index >= mid) & (best.index < hi)]
            if len(tes) > 10:
                chunks.append(tes)
        t0 += te
    if not chunks:
        return pd.Series(dtype=float)
    oos = pd.concat(chunks).sort_index()
    return oos[~oos.index.duplicated(keep="first")]


def annual(oos, m=1):
    out = {}
    for y in sorted(set(oos.index.year)):
        ry = oos[oos.index.year == y]
        if len(ry) >= 250:
            out[int(y)] = round(simulate_year(ry.values, m, 99.0, STOP), 3)  # no +50 lock; just leveraged yr
    return out


def main(argv):
    pr = panel()
    print(f"Low-cap basket: {list(pr.columns)}")
    print(f"span {pr.index[0].date()} -> {pr.index[-1].date()}; "
          f"delisted/ended-early: " +
          ", ".join(f"{c}({pr[c].last_valid_index().date()})" for c in pr.columns
                    if pr[c].last_valid_index() < pr.index[-1] - pd.Timedelta(days=30)))
    print()
    scenarios = [("naive 6bps (UNREALISTIC for low-caps)", 0.0006, 0.0),
                 ("realistic 50bps + 15% delist gap", 0.0050, 0.15),
                 ("harsh 100bps + 25% delist gap", 0.0100, 0.25)]
    summary = {}
    for label, txn, dp in scenarios:
        oos = wf(pr, txn, dp)
        if oos.empty:
            print(f"{label}: no OOS"); continue
        cagr = (1 + oos).prod() ** (ANN / len(oos)) - 1
        shp = oos.mean() / oos.std(ddof=0) * np.sqrt(ANN) if oos.std(ddof=0) else 0
        yr = annual(oos, m=1)
        print(f"=== {label} ===")
        print(f"  OOS CAGR={cagr:+.0%}  Sharpe={shp:.2f}  days={len(oos)}")
        print("  per-year (m=1):", "  ".join(f"{y}:{r:+.0%}" for y, r in yr.items()))
        # leverage sweep for the 1000% question (annual-reset mean)
        levs = {}
        for m in (1, 2, 3, 5):
            ys = [simulate_year(oos[oos.index.year == y].values, m, 99.0, STOP)
                  for y in yr]
            levs[m] = (round(float(np.mean(ys)), 2), round(float(np.median(ys)), 2),
                       round(float(np.min(ys)), 2), int(sum(1 for v in ys if v <= -0.999)))
        print("  leverage (mean/median/worst/ruinYrs):",
              "  ".join(f"m{m}:{v[0]:+.1f}/{v[1]:+.1f}/{v[2]:+.1f}/{v[3]}" for m, v in levs.items()))
        summary[label] = {"cagr": round(float(cagr), 3), "sharpe": round(float(shp), 2),
                          "per_year": yr, "leverage": {str(k): v for k, v in levs.items()}}
        print()
    json.dump(summary, open(os.path.join(RESULTS, "lowcap_results.json"), "w"),
              indent=2, default=str)
    print(f"wrote {os.path.join(RESULTS,'lowcap_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
