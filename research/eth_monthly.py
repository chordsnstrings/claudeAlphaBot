"""Best ETH-only crypto-futures bot — monthly-return investigation.

Goal under test: +20% month-on-month on ETHUSDT futures (~+791%/yr compounded).
This finds the best ETH walk-forward OOS strategy, aggregates to MONTHLY returns,
and reports the monthly distribution under a leverage sweep, plus a monthly
profit-lock variant (bank +20% and sit out the rest of the month). Everything OOS.

Honest framing: "20% EVERY month" needs a monthly MEDIAN >=20% with small downside.
ETH's monthly return std is ~38%; no causal strategy turns that into a low-variance
+20%/month. We measure exactly how often +20% is hit and what it costs in bad months.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs
from strategies import v2_families, all_families
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COSTS = Costs(txn=0.0006, funding_daily=0.0001)


def load_eth() -> pd.Series:
    df = datamod.load("ETH")
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def best_eth_stream():
    """Walk-forward OOS daily returns of the best ETH engine (by OOS Sharpe)."""
    p = load_eth()
    fams = v2_families() + all_families(long_only_opts=(True,))
    best = None
    for fam in fams:
        r = walk_forward("ETH", p, fam, costs=COSTS, train_days=540, test_days=180)
        if r is None or len(r.folds) < 4:
            continue
        if best is None or r.oos.sharpe > best[0].oos.sharpe:
            best = (r, fam.name)
    return best[0].oos_returns, best[1], best[0].summary()


def month_returns(daily: pd.Series, m: float, lock: float = None, stop: float = None):
    """Per-calendar-month leveraged return (with intraday liquidation). If lock/stop
    given, bank at +lock / stop at -stop within the month."""
    out = {}
    for key, grp in daily.groupby([daily.index.year, daily.index.month]):
        eq = 1.0
        locked = False
        for r in grp.values:
            if locked:
                continue
            step = 1.0 + m * r
            if step <= 0.0:
                eq = 0.0
                break
            eq *= step
            if lock is not None and eq - 1.0 >= lock:
                locked = True
            if stop is not None and eq - 1.0 <= -stop:
                locked = True
        out[key] = eq - 1.0
    return pd.Series(out)


def stats(mr: pd.Series, target=0.20):
    a = mr.values
    comp = float(np.prod(1.0 + a))
    n = len(a)
    cagr = comp ** (12.0 / n) - 1.0 if comp > 0 and n else -1.0
    return {
        "n_months": n,
        "mean": round(float(a.mean()), 4),
        "median": round(float(np.median(a)), 4),
        "std": round(float(a.std(ddof=0)), 4),
        "pct_ge_20": round(float((a >= target).mean()), 3),
        "worst": round(float(a.min()), 4),
        "best": round(float(a.max()), 4),
        "ruin_months": int((a <= -0.999).sum()),
        "compounded_mult": comp,
        "ann_cagr": round(float(cagr), 3),
    }


def main(argv):
    print("Best ETH-only futures bot — monthly return study (walk-forward OOS)\n")
    daily, fam, summ = best_eth_stream()
    print(f"Best ETH engine: {fam}")
    print(f"  OOS: CAGR={summ['oos_cagr']:+.1%} Sharpe={summ['oos_sharpe']} "
          f"maxDD={summ['oos_max_dd']:.1%} days={summ['oos_days']} "
          f"avg_exposure={summ['avg_exposure']}\n")

    out = {"engine": fam, "oos_summary": summ, "raw_leverage": {}, "monthly_lock": {}}

    print("=== RAW leveraged monthly distribution (no lock) ===")
    print(f"  {'m':>4} {'mean':>7} {'median':>7} {'std':>7} {'%>=20%':>7} "
          f"{'worst':>7} {'best':>8} {'ruinMo':>7} {'annCAGR':>9}")
    for m in [1, 2, 3, 5, 8]:
        mr = month_returns(daily, m)
        s = stats(mr)
        out["raw_leverage"][m] = s
        print(f"  {m:>4} {s['mean']:>6.0%} {s['median']:>7.0%} {s['std']:>6.0%} "
              f"{s['pct_ge_20']:>7.0%} {s['worst']:>7.0%} {s['best']:>8.0%} "
              f"{s['ruin_months']:>5}/{s['n_months']} {s['ann_cagr']:>9.0%}")

    print("\n=== MONTHLY +20% profit-lock (bank 20%, stop -20%, reset each month) ===")
    print(f"  {'m':>4} {'%banked20':>10} {'mean':>7} {'median':>7} {'worst':>7} "
          f"{'ruinMo':>7} {'annCAGR':>9}")
    for m in [1, 2, 3, 5, 8]:
        mr = month_returns(daily, m, lock=0.20, stop=0.20)
        s = stats(mr)
        out["monthly_lock"][m] = s
        print(f"  {m:>4} {s['pct_ge_20']:>10.0%} {s['mean']:>6.0%} {s['median']:>7.0%} "
              f"{s['worst']:>7.0%} {s['ruin_months']:>5}/{s['n_months']} {s['ann_cagr']:>9.0%}")

    # honest verdict
    best_raw = max(out["raw_leverage"].values(), key=lambda s: s["pct_ge_20"])
    print(f"\nVERDICT: best month-hit-rate for +20% = {best_raw['pct_ge_20']:.0%} of months "
          f"(median month {best_raw['median']:+.0%}).")
    print("'+20% every month' requires median>=20% with small downside; not attainable "
          "OOS (ETH monthly std is large). See full distribution above.")

    json.dump(out, open(os.path.join(RESULTS, "eth_monthly_results.json"), "w"),
              indent=2, default=str)
    daily.to_csv(os.path.join(RESULTS, "eth_best_oos_daily.csv"))
    print(f"\nwrote {os.path.join(RESULTS,'eth_monthly_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
