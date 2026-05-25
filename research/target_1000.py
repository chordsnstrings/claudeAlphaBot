"""Is ~1000%/yr reachable on SOL/ETH/BTC/DOGE/XRP? An honest OOS investigation.

The goal asks whether a 1000% annual return is attainable. This sweeps leverage on
the walk-forward OOS streams and reports, per coin and for the book, two very
different numbers that high leverage drives apart:

  * AVERAGE annual return (annual-reset / profit-withdrawal model): each Jan starts
    fresh at $100k, so a -100% (liquidation) year just loses that year's stake. The
    mean across independent years can look huge even with ruin years.
  * COMPOUNDED CAGR (no withdrawal): if you DON'T pull the money out, a single
    -100% year zeroes the account forever. This is the sustainable number.

Liquidation is modelled honestly: within a year, if any day's 1 + m*r <= 0 the year
is -100%. We report mean/median/worst annual return, the fraction of ruin years, and
the compounded multiple, so the leverage/return/ruin trade-off is explicit.

Verdict criterion: "1000%/yr" is judged reachable only if a config delivers ~+1000%
on a meaningful basis (mean AND median, not a single lucky year) without near-certain
ruin. Anything that needs ruinous leverage to print a high mean is flagged as the
gambler's-ruin artifact it is.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import annual_target as at

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]


def year_return_lev(daily: np.ndarray, m: float) -> float:
    """Leveraged annual return with intraday liquidation (annual-reset model)."""
    eq = 1.0
    for r in daily:
        step = 1.0 + m * r
        if step <= 0.0:
            return -1.0
        eq *= step
    return eq - 1.0


def sweep(returns: pd.Series, m_grid):
    years = {}
    for y in sorted(set(returns.index.year)):
        ry = returns[returns.index.year == y]
        if len(ry) >= 250:
            years[int(y)] = ry.values
    rows = []
    for m in m_grid:
        yr = {y: year_return_lev(v, m) for y, v in years.items()}
        arr = np.array(list(yr.values()))
        ruin = int((arr <= -0.999).sum())
        # compounded multiple if you held through every year (no withdrawal)
        comp = np.prod(1.0 + arr)
        rows.append({
            "m": m, "n_years": len(arr),
            "mean_yr": round(float(arr.mean()), 3),
            "median_yr": round(float(np.median(arr)), 3),
            "worst_yr": round(float(arr.min()), 3),
            "best_yr": round(float(arr.max()), 3),
            "ruin_years": ruin,
            "compounded_mult": float(comp),
            "per_year": {int(y): round(float(v), 3) for y, v in yr.items()},
        })
    return rows


def streams():
    out = {}
    for c in COINS:
        out[c] = at.best_returns(c)[0]
    tb = pd.DataFrame(out).mean(axis=1).dropna()
    xb = pd.read_csv(os.path.join(RESULTS, "xsection_oos_daily.csv"),
                     index_col=0, parse_dates=True).iloc[:, 0]
    idx = tb.index.union(xb.index)
    book = 0.6 * tb.reindex(idx).fillna(0.0) + 0.4 * xb.reindex(idx).fillna(0.0)
    out["TREND+XS_BOOK"] = book
    return out


def main(argv):
    m_grid = [1, 2, 3, 5, 8, 12, 20, 35, 50, 75, 100]
    print("Reaching for +1000%/yr — leverage sweep on walk-forward OOS streams")
    print("(annual-reset model; liquidation if intraday 1+m*r<=0)\n")
    allout = {}
    for name, r in streams().items():
        rows = sweep(r, m_grid)
        allout[name] = rows
        print(f"=== {name} ===")
        print(f"  {'m':>4} {'mean/yr':>9} {'median/yr':>10} {'worst':>7} {'best':>9} "
              f"{'ruinYrs':>8} {'compounded(no-withdraw)':>24}")
        for e in rows:
            comp = e["compounded_mult"]
            comp_s = f"{comp:.2e}" if abs(comp) >= 1e4 or (0 < abs(comp) < 1e-2) else f"{comp:.2f}"
            print(f"  {e['m']:>4} {e['mean_yr']:>8.0%} {e['median_yr']:>9.0%} "
                  f"{e['worst_yr']:>7.0%} {e['best_yr']:>8.0%} "
                  f"{str(e['ruin_years'])+'/'+str(e['n_years']):>8} {comp_s:>24}")
        # does any m reach ~1000% on BOTH mean and median without guaranteed ruin?
        ok = [e for e in rows if e["mean_yr"] >= 9.99 and e["median_yr"] >= 9.99
              and e["ruin_years"] == 0]
        ok_mean = [e for e in rows if e["mean_yr"] >= 9.99]
        if ok:
            b = min(ok, key=lambda e: e["m"])
            print(f"  -> +1000% reachable robustly at m={b['m']} (mean & median >=1000%, no ruin)")
        elif ok_mean:
            b = min(ok_mean, key=lambda e: e["m"])
            print(f"  -> mean hits +1000% at m={b['m']} but median {b['median_yr']:.0%}, "
                  f"ruin {b['ruin_years']}/{b['n_years']} -> gambler's-ruin artifact, not real")
        else:
            best = max(rows, key=lambda e: e["mean_yr"])
            print(f"  -> max mean/yr = {best['mean_yr']:.0%} at m={best['m']} "
                  f"(ruin {best['ruin_years']}/{best['n_years']}); +1000% NOT reached")
        print()
    with open(os.path.join(RESULTS, "target_1000_results.json"), "w") as f:
        json.dump(allout, f, indent=2, default=str)
    print(f"wrote {os.path.join(RESULTS, 'target_1000_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
