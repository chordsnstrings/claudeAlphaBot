"""V2 research driver — futures, leverage, regime orchestrator.

Target (per the goal): for BTC / XRP / DOGE / ETH, find a per-coin strategy (or
the regime orchestrator) that earns >= 50% in EACH year, on a $100k account that
is reset every year (profit withdrawn at year end). Leverage up to ~10x effective
(the exchange's 10-50x facility permits notional > equity); sizing is vol-managed.

All evaluation is walk-forward out-of-sample. Per-year returns are computed on the
stitched OOS stream with annual reset, so each year stands on its own $100k.
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs, ANN, buy_hold_metrics, apply_annual_breaker, compute_metrics
from strategies import v2_families
from walkforward import walk_forward, WFResult

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["BTC", "ETH", "XRP", "DOGE"]
START_CAPITAL = 100_000.0
TARGET = 0.50
# Futures cost model: taker ~4bps + slippage, applied per side on turnover,
# plus a daily funding/carry drag (perp funding, symmetric & conservative).
COSTS = Costs(txn=0.0006, funding_daily=0.0001)


def load_prices(asset: str) -> pd.Series:
    df = datamod.load(asset)
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def wf_params(prices: pd.Series) -> dict:
    span = (prices.index[-1] - prices.index[0]).days
    if span >= 2200:
        return dict(train_days=540, test_days=180)
    if span >= 1400:
        return dict(train_days=420, test_days=150)
    return dict(train_days=365, test_days=120)


def per_year_table(returns: pd.Series, held: pd.Series | None) -> list[dict]:
    rows = []
    for y in sorted(set(returns.index.year)):
        ry = returns[returns.index.year == y]
        n = len(ry)
        yr = float((1 + ry).prod() - 1)
        full = n >= 250
        lev = None
        if held is not None:
            hy = held[held.index.year == y]
            lev = {"avg": round(float(hy.abs().mean()), 2),
                   "max": round(float(hy.abs().max()), 2)} if len(hy) else None
        rows.append({
            "year": int(y), "days": n, "full_year": full,
            "return": round(yr, 4),
            "profit_usd": round(START_CAPITAL * yr, 0),
            "hit_50": bool(full and yr >= TARGET),
            "leverage": lev,
        })
    return rows


def consistency_score(rows: list[dict]) -> tuple:
    """Rank families by per-year consistency at the 50% bar.
    Maximise (#full years >=50%, then the worst full-year return, then median)."""
    full = [r for r in rows if r["full_year"]]
    if not full:
        return (-1, -1e9, -1e9)
    hits = sum(1 for r in full if r["hit_50"])
    worst = min(r["return"] for r in full)
    med = float(np.median([r["return"] for r in full]))
    return (hits / len(full), worst, med)


def run_coin(coin: str) -> dict:
    prices = load_prices(coin)
    wfp = wf_params(prices)
    bh = buy_hold_metrics(prices)
    results: list[WFResult] = []
    for fam in v2_families():
        r = walk_forward(coin, prices, fam, costs=COSTS, **wfp)
        if r is not None and len(r.folds) >= 3:
            results.append(r)

    scored = []
    for r in results:
        rows = per_year_table(r.oos_returns, r.oos_held)
        scored.append((consistency_score(rows), r, rows))
    scored.sort(key=lambda t: t[0], reverse=True)

    print(f"\n{'='*104}\n{coin}  span {prices.index[0].date()}..{prices.index[-1].date()} "
          f"({len(prices)}d)  buy&hold CAGR {bh.cagr:+.1%}")
    print(f"  {'family':16} {'OOScagr':>8} {'Sharpe':>7} {'maxDD':>7} {'yrs>=50%':>9} "
          f"{'worstYr':>8} {'medYr':>7} {'avgLev':>7}")
    for (score, r, rows) in scored:
        full = [x for x in rows if x["full_year"]]
        hit = f"{sum(x['hit_50'] for x in full)}/{len(full)}"
        worst = min((x["return"] for x in full), default=0)
        med = np.median([x["return"] for x in full]) if full else 0
        avglev = r.oos_held.abs().mean() if r.oos_held is not None else 0
        print(f"  {r.family:16} {r.oos.cagr:+8.1%} {r.oos.sharpe:7.2f} {r.oos.max_dd:7.1%} "
              f"{hit:>9} {worst:+8.1%} {med:+7.1%} {avglev:7.2f}")

    best_score, best_r, best_rows = scored[0]
    # robustness overlay: within-year circuit breaker (annual-reset aware)
    br_returns = apply_annual_breaker(best_r.oos_returns, dd_stop=0.35)
    br_rows = per_year_table(br_returns, best_r.oos_held)
    br_m = compute_metrics(br_returns, best_r.oos_held if best_r.oos_held is not None
                           else pd.Series(0.0, index=br_returns.index))

    print(f"\n  >>> best for {coin}: {best_r.family}  (per-year OOS, $100k reset each year)")
    print(f"      {'year':>6} {'raw':>9} {'+breaker':>9}   profit($, breaker)")
    br_by_year = {x["year"]: x for x in br_rows}
    for x in best_rows:
        b = br_by_year.get(x["year"], x)
        tag = "" if x["full_year"] else "  (partial)"
        flag = "  ✅" if b["hit_50"] else ("" if not x["full_year"] else "  ✗")
        print(f"      {x['year']:>6} {x['return']:+9.1%} {b['return']:+9.1%}   "
              f"${b['profit_usd']:>12,.0f}{flag}{tag}")
    raw_worst = min((x["return"] for x in best_rows if x["full_year"]), default=0)
    br_worst = min((x["return"] for x in br_rows if x["full_year"]), default=0)
    print(f"      worst full year: raw {raw_worst:+.1%}  ->  +breaker {br_worst:+.1%}   "
          f"(breaker OOS CAGR {br_m.cagr:+.1%}, Sharpe {br_m.sharpe:.2f}, maxDD {br_m.max_dd:.1%})")

    return {
        "coin": coin, "wf_params": wfp, "buy_hold_cagr": round(bh.cagr, 4),
        "best_family": best_r.family,
        "modal_params": Counter(json.dumps(f.params, sort_keys=True, default=str)
                                for f in best_r.folds).most_common(1)[0][0],
        "oos": best_r.summary(),
        "per_year": best_rows,
        "per_year_with_breaker": br_rows,
        "breaker_dd_stop": 0.35,
        "worst_year_raw": round(raw_worst, 4),
        "worst_year_breaker": round(br_worst, 4),
        "years_full": sum(1 for x in best_rows if x["full_year"]),
        "years_hit_50": sum(1 for x in best_rows if x["hit_50"]),
        "ranking": [{"family": r.family, "score_hitrate": round(s[0], 3),
                     "worst_year": round(s[1], 4), "median_year": round(s[2], 4)}
                    for (s, r, _) in scored],
    }


def main(argv):
    os.makedirs(RESULTS, exist_ok=True)
    coins = [a for a in argv if a in datamod.ASSETS] or COINS
    print(f"V2 futures/leverage/orchestrator search  costs txn={COSTS.txn*1e4:.0f}bps "
          f"funding={COSTS.funding_daily*1e4:.1f}bps/day  target>={TARGET:.0%}/yr (reset ${START_CAPITAL:,.0f})")
    out = {"coins": {}, "target": TARGET, "start_capital": START_CAPITAL,
           "cost_model": {"txn_bps": COSTS.txn * 1e4, "funding_bps_day": COSTS.funding_daily * 1e4}}
    for c in coins:
        out["coins"][c] = run_coin(c)

    print(f"\n{'='*104}\nSUMMARY — per-coin best (years clearing 50% / full years)")
    for c in coins:
        r = out["coins"][c]
        print(f"  {c:6} {r['best_family']:16} yrs>=50%: {r['years_hit_50']}/{r['years_full']}  "
              f"OOS CAGR {r['oos']['oos_cagr']:+.1%}  Sharpe {r['oos']['oos_sharpe']:.2f}")

    with open(os.path.join(RESULTS, "v2_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'v2_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
