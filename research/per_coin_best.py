"""Best stand-alone strategy for each coin (BTC SOL ETH XRP DOGE), highest expected
outcome, walk-forward OOS. Each coin is optimised on its OWN data.

For each coin we walk-forward every strategy family (trend, blend, breakout, MR,
RSI-MR, regime orchestrator; long-only and long/short; spot and futures-leverage
grids), then report:
  * best risk-adjusted engine (max OOS Sharpe) with exact params + full metrics;
  * best raw-return engine (max OOS CAGR);
  * the leverage `m` that maximises the EXPECTED annual outcome (annual-reset model
    with liquidation) without entering the ruinous regime (worst year >= -55%, 0 ruin).
"highest expected outcome" = the sane-leverage configuration with the largest mean
annual return that is still survivable; raw CAGR and risk-adjusted picks are shown
alongside so the trade-off is explicit.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs
from strategies import all_families, v2_families
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["BTC", "SOL", "ETH", "XRP", "DOGE"]
COSTS = Costs(txn=0.0006, funding_daily=0.0001)


def load(coin: str) -> pd.Series:
    df = datamod.load(coin)
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def wf_params(p: pd.Series) -> dict:
    span = (p.index[-1] - p.index[0]).days
    if span >= 2200:
        return dict(train_days=540, test_days=180)
    if span >= 1400:
        return dict(train_days=420, test_days=150)
    return dict(train_days=365, test_days=120)


def year_return_lev(daily: np.ndarray, m: float) -> float:
    eq = 1.0
    for r in daily:
        step = 1.0 + m * r
        if step <= 0.0:
            return -1.0
        eq *= step
    return eq - 1.0


def lev_sweep(returns: pd.Series):
    years = {int(y): returns[returns.index.year == y].values
             for y in sorted(set(returns.index.year))
             if len(returns[returns.index.year == y]) >= 250}
    rows = []
    for m in [1, 2, 3, 5, 8, 12, 20]:
        arr = np.array([year_return_lev(v, m) for v in years.values()])
        rows.append(dict(m=m, mean=float(arr.mean()), median=float(np.median(arr)),
                         worst=float(arr.min()), ruin=int((arr <= -0.999).sum()),
                         n=len(arr)))
    sane = [r for r in rows if r["worst"] >= -0.55 and r["ruin"] == 0] or rows
    best = max(sane, key=lambda r: r["mean"])
    return rows, best


def candidates():
    fams = all_families(long_only_opts=(False, True)) + v2_families()
    return fams


def best_for(coin: str):
    p = load(coin)
    wfp = wf_params(p)
    results = []
    for fam in candidates():
        r = walk_forward(coin, p, fam, costs=COSTS, **wfp)
        if r is None or len(r.folds) < 3:
            continue
        results.append(r)
    if not results:
        return None
    by_sharpe = max(results, key=lambda r: r.oos.sharpe)
    by_cagr = max(results, key=lambda r: r.oos.cagr)
    sweep, best_lev = lev_sweep(by_cagr.oos_returns)
    # modal params across folds for the by_sharpe pick (the deployable param set)
    return {
        "coin": coin,
        "span": f"{p.index[0].date()} -> {p.index[-1].date()}",
        "n_bars": len(p),
        "best_sharpe": {
            "engine": by_sharpe.family,
            "metrics": by_sharpe.summary(),
            "modal_params": _modal_params(by_sharpe),
        },
        "best_cagr": {
            "engine": by_cagr.family,
            "metrics": by_cagr.summary(),
            "modal_params": _modal_params(by_cagr),
        },
        "leverage_sweep": sweep,
        "best_expected": best_lev,
    }


def _modal_params(r):
    """Most-frequently chosen param set across walk-forward folds."""
    from collections import Counter
    keys = Counter(tuple(sorted((k, str(v)) for k, v in f.params.items())) for f in r.folds)
    top = keys.most_common(1)[0][0]
    return dict((k, v) for k, v in top)


def main(argv):
    coins = [a.upper() for a in argv if a.upper() in COINS] or COINS
    out = {}
    print("BEST STAND-ALONE STRATEGY PER COIN (walk-forward OOS)\n")
    for c in coins:
        res = best_for(c)
        if res is None:
            print(f"{c}: no qualifying fit"); continue
        out[c] = res
        bs, bc, be = res["best_sharpe"], res["best_cagr"], res["best_expected"]
        print(f"================ {c}  ({res['span']}, {res['n_bars']} bars) ================")
        print(f"  BEST RISK-ADJUSTED: {bs['engine']:16} "
              f"OOS CAGR={bs['metrics']['oos_cagr']:+.1%}  Sharpe={bs['metrics']['oos_sharpe']}  "
              f"Sortino={bs['metrics']['oos_sortino']}  maxDD={bs['metrics']['oos_max_dd']:.1%}  "
              f"foldWin={bs['metrics']['fold_pass_rate']}")
        print(f"      params: {bs['modal_params']}")
        print(f"  BEST RAW RETURN  : {bc['engine']:16} "
              f"OOS CAGR={bc['metrics']['oos_cagr']:+.1%}  Sharpe={bc['metrics']['oos_sharpe']}  "
              f"maxDD={bc['metrics']['oos_max_dd']:.1%}")
        print(f"      params: {bc['modal_params']}")
        print(f"  HIGHEST EXPECTED OUTCOME (sane leverage, annual-reset, no ruin):")
        print(f"      m={be['m']}  mean/yr={be['mean']:+.0%}  median/yr={be['median']:+.0%}  "
              f"worst/yr={be['worst']:+.0%}  ({be['n']} yrs)")
        print()
    json.dump(out, open(os.path.join(RESULTS, "per_coin_best_results.json"), "w"),
              indent=2, default=str)
    # summary table
    print("SUMMARY")
    print(f"  {'coin':>5} {'best engine (Sharpe)':>22} {'OOS CAGR':>9} {'Sharpe':>7} "
          f"{'maxDD':>7} | {'expOutcome m':>12} {'mean/yr':>8}")
    for c in coins:
        if c not in out:
            continue
        bs, be = out[c]["best_sharpe"], out[c]["best_expected"]
        print(f"  {c:>5} {bs['engine']:>22} {bs['metrics']['oos_cagr']:>8.0%} "
              f"{bs['metrics']['oos_sharpe']:>7} {bs['metrics']['oos_max_dd']:>7.0%} | "
              f"m={be['m']:>2} {be['mean']:>10.0%}")
    print(f"\nwrote {os.path.join(RESULTS,'per_coin_best_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
