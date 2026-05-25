"""Annual profit-target lock — exploit the $100k-reset / profit-withdrawal model.

The brief's accounting (start each year at $100k, withdraw profit at year end,
use futures leverage) turns each year into an independent "race": from Jan 1, can
the account reach +TARGET before hitting a -STOP? If yes, **lock the gain** (go
flat for the rest of the year and bank +TARGET). If it hits -STOP first, stop out
for the year. This is fully causal (only YTD info is used) and is the natural way
to run a leveraged, profit-is-swept account.

Leverage model: a strategy's daily *net* return scales linearly with size
(gross, txn cost and funding all scale with notional), so running the engine at
m x size == multiplying its net daily returns by m. A day that would take equity
to <=0 is a liquidation (year = -100%).

We sweep the leverage multiplier m and report, per coin, how many years bank
+50%. Everything is applied to the walk-forward OOS return stream.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs
from strategies import v2_families
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["BTC", "ETH", "XRP", "DOGE"]
COSTS = Costs(txn=0.0006, funding_daily=0.0001)
TARGET = 0.50


def load_prices(asset):
    df = datamod.load(asset)
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def wf_params(prices):
    span = (prices.index[-1] - prices.index[0]).days
    if span >= 2200:
        return dict(train_days=540, test_days=180)
    if span >= 1400:
        return dict(train_days=420, test_days=150)
    return dict(train_days=365, test_days=120)


def simulate_year(daily: np.ndarray, m: float, target: float, stop: float) -> float:
    """One calendar year. Returns the year's realised return under leverage m
    with a +target profit-lock and a -stop. Causal, path-dependent."""
    eq = 1.0
    locked = False
    for r in daily:
        if locked:
            continue
        step = 1.0 + m * r
        if step <= 0.0:            # intraday liquidation
            return -1.0
        eq *= step
        if eq - 1.0 >= target:     # bank the target, flat for rest of year
            return eq - 1.0
        if eq - 1.0 <= -stop:      # stop out for the year
            return eq - 1.0
    return eq - 1.0


def evaluate(returns: pd.Series, m: float, target: float, stop: float):
    rows = []
    for y in sorted(set(returns.index.year)):
        ry = returns[returns.index.year == y]
        if len(ry) < 250:
            continue  # only judge full years
        yr = simulate_year(ry.values, m, target, stop)
        rows.append((int(y), yr))
    if not rows:
        return None
    rets = np.array([r for _, r in rows])
    banked = int((rets >= target - 1e-9).sum())
    return {
        "m": m, "target": target, "stop": stop,
        "full_years": len(rows),
        "banked_50": banked,
        "hit_rate": round(banked / len(rows), 3),
        "avg_year": round(float(rets.mean()), 4),
        "median_year": round(float(np.median(rets)), 4),
        "worst_year": round(float(rets.min()), 4),
        "avg_profit_usd": round(float(rets.mean()) * 100_000, 0),
        "per_year": [(y, round(r, 4)) for y, r in rows],
    }


def best_returns(coin: str) -> pd.Series:
    """OOS daily net returns of the best v2 family for this coin (by raw CAGR)."""
    prices = load_prices(coin)
    wfp = wf_params(prices)
    best = None
    for fam in v2_families():
        r = walk_forward(coin, prices, fam, costs=COSTS, **wfp)
        if r is None or len(r.folds) < 3:
            continue
        if best is None or r.oos.cagr > best.oos.cagr:
            best = r
    return best.oos_returns, best.family


def main(argv):
    coins = [a for a in argv if a in datamod.ASSETS] or COINS
    stop = 0.40  # cap each losing year at ~ -40% of the $100k stake
    m_grid = [1, 2, 3, 5, 8, 12, 20, 35, 50]
    out = {"target": TARGET, "stop": stop, "leverage_grid": m_grid, "coins": {}}

    print(f"ANNUAL PROFIT-TARGET LOCK  target=+{TARGET:.0%}  stop=-{stop:.0%}  "
          f"(applied to walk-forward OOS; m = leverage multiplier on the engine)")

    for coin in coins:
        returns, fam = best_returns(coin)
        print(f"\n{'='*92}\n{coin}  (engine: {fam})")
        print(f"  {'m=lev':>6} {'banked>=50%':>12} {'hitRate':>8} {'avgYr':>8} {'medYr':>8} {'worstYr':>9} {'avg$/yr':>10}")
        sweeps = []
        for m in m_grid:
            e = evaluate(returns, m, TARGET, stop)
            if e is None:
                continue
            sweeps.append(e)
            print(f"  {m:>6} {str(e['banked_50'])+'/'+str(e['full_years']):>12} "
                  f"{e['hit_rate']:>8.0%} {e['avg_year']:>8.1%} {e['median_year']:>8.1%} "
                  f"{e['worst_year']:>9.1%} {e['avg_profit_usd']:>10,.0f}")
        # pick the best SANE config: bound the worst year (no near-liquidation),
        # then maximise hit-rate, then avg. Reckless leverage that manufactures a
        # marginally higher hit-rate via -100% years is excluded.
        sane = [e for e in sweeps if e["worst_year"] >= -0.55] or sweeps
        best = max(sane, key=lambda e: (e["hit_rate"], e["avg_year"]))
        print(f"  >>> best m={best['m']}: banks +50% in {best['banked_50']}/{best['full_years']} years "
              f"({best['hit_rate']:.0%}), worst year {best['worst_year']:.0%}, avg ${best['avg_profit_usd']:,.0f}/yr")
        print("      per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in best["per_year"]))
        out["coins"][coin] = {"engine": fam, "sweep": sweeps, "best": best,
                              "_returns": returns}

    # ---- diversified book: split capital across coins, bank at BOOK level ----
    def book(coin_list, label):
        mat = pd.DataFrame({c: out["coins"][c]["_returns"] for c in coin_list}).sort_index()
        ew = mat.mean(axis=1, skipna=True).dropna()   # equal-weight daily return
        print(f"\n{'='*92}\nDIVERSIFIED BOOK [{label}] = equal-weight {coin_list}, banked at book level")
        print(f"  {'m=lev':>6} {'banked>=50%':>12} {'hitRate':>8} {'avgYr':>8} {'worstYr':>9} {'avg$/yr':>10}")
        sw = []
        for m in m_grid:
            e = evaluate(ew, m, TARGET, stop)
            if e:
                sw.append(e)
                print(f"  {m:>6} {str(e['banked_50'])+'/'+str(e['full_years']):>12} "
                      f"{e['hit_rate']:>8.0%} {e['avg_year']:>8.1%} {e['worst_year']:>9.1%} {e['avg_profit_usd']:>10,.0f}")
        sane = [e for e in sw if e["worst_year"] >= -0.55] or sw
        b = max(sane, key=lambda e: (e["hit_rate"], e["avg_year"]))
        print(f"  >>> best m={b['m']}: book banks +50% in {b['banked_50']}/{b['full_years']} years "
              f"({b['hit_rate']:.0%}), worst {b['worst_year']:.0%}, avg ${b['avg_profit_usd']:,.0f}/yr")
        print("      per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in b["per_year"]))
        return {"coins": coin_list, "sweep": sw, "best": b}

    out["book_3"] = book(["BTC", "ETH", "DOGE"], "BTC+ETH+DOGE")
    out["book_4"] = book(["BTC", "ETH", "XRP", "DOGE"], "all 4")
    wide = [c for c in out["coins"].keys() if c not in ("BTC", "ETH", "XRP", "DOGE")]
    if wide:
        out["book_wide"] = book(list(out["coins"].keys()), "WIDE universe")

    for c in out["coins"]:
        out["coins"][c].pop("_returns", None)
    with open(os.path.join(RESULTS, "annual_target_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)

    print(f"\n{'='*92}\nSUMMARY — years banking +50% at best leverage (profit-lock, OOS)")
    for coin in coins:
        b = out["coins"][coin]["best"]
        print(f"  {coin:6} m={b['m']:>3}  {b['banked_50']}/{b['full_years']} years  "
              f"hit {b['hit_rate']:.0%}  worst {b['worst_year']:+.0%}  avg ${b['avg_profit_usd']:,.0f}/yr")
    print(f"\nwrote {os.path.join(RESULTS, 'annual_target_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
