"""Walk-forward the ALLOCATION itself — the last in-sample choice, removed.

The 90% headline came from picking the trend/XS blend weight and leverage by
inspecting the whole OOS period (a mild meta-level in-sample choice). This closes
that gap: an expanding-window walk-forward at the annual-allocation level.

For each test year Y (from the 4th full year on):
  * using ONLY years < Y, pick the (w, m) that maximises banked-years on that
    history (tie-break: average locked return);
  * apply that (w, m) to year Y (unseen) and record whether it banks +50%.

The stitched record is the fully out-of-sample, allocation-walk-forward hit-rate:
no hindsight remains anywhere in the pipeline (sleeve params were already
walk-forward OOS; now the allocation is too). This is the most honest number the
study can produce. It will typically be <= the hindsight 90%, which is expected
and correct.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import annual_target as at
from annual_target import simulate_year, TARGET

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
STOP = 0.40
W_GRID = [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0]
M_GRID = [1, 2, 3]


def streams():
    tb = pd.DataFrame({c: at.best_returns(c)[0] for c in COINS}).mean(axis=1).dropna()
    xb = pd.read_csv(os.path.join(RESULTS, "xsection_oos_daily.csv"),
                     index_col=0, parse_dates=True).iloc[:, 0]
    idx = tb.index.union(xb.index)
    return tb.reindex(idx).fillna(0.0), xb.reindex(idx).fillna(0.0)


def year_lock_return(T, X, w, m, year) -> float:
    comb = (1 - w) * T + w * X
    ry = comb[comb.index.year == year]
    if len(ry) < 250:
        return None
    return simulate_year(ry.values, m, TARGET, STOP)


def main(argv):
    print("Building trend & XS OOS streams ...")
    T, X = streams()
    years = [y for y in sorted(set(T.index.year))
             if (T.index.year == y).sum() >= 250]
    print(f"full years available: {years}")

    records = []
    for i, Y in enumerate(years):
        train_years = years[:i]
        if len(train_years) < 3:
            continue  # need a few years of history to choose an allocation
        # choose (w, m) on TRAIN years only
        best, best_key = None, None
        for w in W_GRID:
            for m in M_GRID:
                rs = [year_lock_return(T, X, w, m, ty) for ty in train_years]
                rs = [r for r in rs if r is not None]
                banked = sum(1 for r in rs if r >= TARGET - 1e-9)
                key = (banked, round(float(np.mean(rs)), 4))  # banked, then avg
                if best_key is None or key > best_key:
                    best_key, best = key, (w, m)
        w, m = best
        # apply to the UNSEEN test year Y
        test_r = year_lock_return(T, X, w, m, Y)
        if test_r is None:
            continue
        banked = test_r >= TARGET - 1e-9
        records.append({"year": Y, "chosen_w": w, "chosen_m": m,
                        "test_return": round(test_r, 4), "banked": bool(banked)})
        print(f"  {Y}: chose w={w} m={m}  -> {test_r:+.0%}  {'BANK' if banked else 'miss'}")

    n = len(records)
    nb = sum(1 for r in records if r["banked"])
    print(f"\n{'='*70}")
    print(f"ALLOCATION-WALK-FORWARD (fully OOS, no hindsight): {nb}/{n} years "
          f"banked +50% ({nb/max(n,1):.0%})")
    print("  (compare: hindsight-best static blend = 9/10 = 90%)")
    out = {"records": records, "banked": nb, "n": n,
           "hit_rate": round(nb / max(n, 1), 3)}
    with open(os.path.join(RESULTS, "alloc_wf_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'alloc_wf_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
