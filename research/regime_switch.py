"""Causal regime-switch allocator: up-market engine vs down-market engine.

The static-blend proof (§12.9) shows averaging can't bank both 2022 and 2023/2025,
because the rescuing sleeves are mutually exclusive *in those years*. A *conditional*
allocator escapes that trap if (and only if) a CAUSAL market-regime signal can tell
"broad bear" from "trendless chop" early enough:

  regime[t] (decided at close t, causal) from an equal-weight market index:
    DOWN  if index below its SMA_n AND blended index momentum < 0
    else  RISK-ON
  book[t+1] = orchestrator_book[t+1]      if regime[t] == DOWN   (shorts the bear)
            = (trend+XS) blend[t+1]        otherwise              (the 9/10 engine)

This is a standard risk-on/risk-off overlay, NOT a fit to 2022. To guard against
the thin-evidence trap (only ~2 bears in the sample), we sweep the regime window
over a wide grid and report how MANY settings reach 10/10: a single knife-edge
threshold = overfit and should be distrusted; a broad plateau = a real effect.

All inputs are walk-forward OOS daily streams; the only added decision is the
causal regime label. The +50% annual profit-lock is then applied to the switched
stream. Honest caveats reported alongside the number.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import annual_target as at
from annual_target import simulate_year, TARGET
from engine import Costs, ema, sma
from strategies import v2_families
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
STOP = 0.40
COSTS = Costs(txn=0.0006, funding_daily=0.0001)


def market_index() -> pd.Series:
    """Equal-weight buy&hold index of the 5 coins (causal level series)."""
    rets = {}
    for c in COINS:
        p = at.load_prices(c)
        rets[c] = p.pct_change()
    ew = pd.DataFrame(rets).mean(axis=1).dropna()
    return (1.0 + ew).cumprod()


def trend_book_daily() -> pd.Series:
    return pd.DataFrame({c: at.best_returns(c)[0] for c in COINS}).mean(axis=1).dropna()


def orch_book_daily() -> pd.Series:
    orch = [f for f in v2_families() if f.name == "orchestrator"][0]
    s = {}
    for c in COINS:
        p = at.load_prices(c)
        r = walk_forward(c, p, orch, costs=COSTS, **at.wf_params(p))
        if r is not None and len(r.folds) >= 3:
            s[c] = r.oos_returns
    return pd.DataFrame(s).mean(axis=1).dropna()


def xs_daily() -> pd.Series:
    df = pd.read_csv(os.path.join(RESULTS, "xsection_oos_daily.csv"),
                     index_col=0, parse_dates=True)
    return df.iloc[:, 0]


def regime_down(index: pd.Series, n: int, mom_lb: int) -> pd.Series:
    """Causal DOWN flag: index below SMA_n AND trailing mom_lb return < 0."""
    below = index < sma(index, n)
    mom = index / index.shift(mom_lb) - 1.0
    down = (below & (mom < 0)).astype(float)
    return down.shift(1).fillna(0.0)  # decided on prior close -> applied next day


def per_year(stream: pd.Series, m: float):
    rows = []
    for y in sorted(set(stream.index.year)):
        ry = stream[stream.index.year == y]
        if len(ry) < 250:
            continue
        rows.append((int(y), simulate_year(ry.values, m, TARGET, STOP)))
    return rows


def eval_stream(stream: pd.Series, m_grid=(1, 2, 3, 5)):
    best = None
    for m in m_grid:
        py = per_year(stream, m)
        if not py:
            continue
        rs = np.array([r for _, r in py])
        banked = int((rs >= TARGET - 1e-9).sum())
        worst = float(rs.min())
        e = dict(m=m, banked=banked, full_years=len(py),
                 hit_rate=round(banked / len(py), 3),
                 avg_year=round(float(rs.mean()), 4), worst_year=round(worst, 4),
                 per_year=py)
        if worst >= -0.55 and (best is None or (e["hit_rate"], e["avg_year"]) >
                               (best["hit_rate"], best["avg_year"])):
            best = e
    return best


def main(argv):
    print("Building books + market index (walk-forward OOS) ...")
    idxlvl = market_index()
    tb, ob, xb = trend_book_daily(), orch_book_daily(), xs_daily()
    allidx = tb.index.union(xb.index).union(ob.index)
    T = tb.reindex(allidx).fillna(0.0)
    O = ob.reindex(allidx).fillna(0.0)
    X = xb.reindex(allidx).fillna(0.0)

    # the up-market engine = best static trend+XS blend (trend30/XS70)
    up_engine = 0.3 * T + 0.7 * X

    print(f"\n{'='*84}\nREGIME-SWITCH SWEEP  (DOWN -> orchestrator; else trend30/XS70)")
    print(f"  {'SMA_n':>6} {'mom_lb':>7} {'best_m':>6} {'banked':>8} {'hit':>6} {'worst':>7} "
          f"{'%days DOWN':>10}")
    results = []
    ten_configs = []
    for n in (50, 75, 100, 125, 150, 200):
        for mom_lb in (30, 60, 90, 120):
            down = regime_down(idxlvl, n, mom_lb).reindex(allidx).fillna(0.0)
            switched = np.where(down > 0, O, up_engine)
            stream = pd.Series(switched, index=allidx)
            best = eval_stream(stream)
            if best is None:
                continue
            frac_down = float((down > 0).mean())
            results.append({"sma_n": n, "mom_lb": mom_lb, "best": best,
                            "frac_down": round(frac_down, 3)})
            print(f"  {n:>6} {mom_lb:>7} {best['m']:>6} "
                  f"{str(best['banked'])+'/'+str(best['full_years']):>8} "
                  f"{best['hit_rate']:>6.0%} {best['worst_year']:>7.0%} {frac_down:>10.1%}")
            if best["banked"] == best["full_years"]:
                ten_configs.append((n, mom_lb, best))

    n_total = len(results)
    n_ten = len(ten_configs)
    n_nine = sum(1 for r in results if r["best"]["banked"] >= r["best"]["full_years"] - 1)
    print(f"\n{'='*84}")
    print(f"configs reaching 10/10: {n_ten}/{n_total}   |   reaching >=9/10: {n_nine}/{n_total}")
    if ten_configs:
        # show a representative 10/10 and judge robustness
        n, mom_lb, b = ten_configs[len(ten_configs) // 2]
        print(f"\nExample 10/10 [SMA_n={n}, mom_lb={mom_lb}, m={b['m']}], worst {b['worst_year']:+.0%}:")
        print("  per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in b["per_year"]))
        plateau = n_ten / n_total
        verdict = ("ROBUST plateau (many settings agree) — credible" if plateau >= 0.30
                   else "NARROW (few settings) — treat as fragile/possible overfit"
                   if plateau > 0 else "none")
        print(f"\nRobustness: {n_ten}/{n_total} of regime settings reach 10/10 -> {verdict}")
    else:
        print("\nNo regime setting reaches 10/10; conditional switching does not break the 9/10 ceiling.")

    with open(os.path.join(RESULTS, "regime_switch_results.json"), "w") as f:
        json.dump({"results": results, "n_ten": n_ten, "n_total": n_total},
                  f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'regime_switch_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
