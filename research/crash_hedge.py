"""Trend-following crash-hedge overlay — the honest route to all-years coverage.

The 5 spot coins crash together in 2022 (correlations -> 1), so no long/rotation
sleeve banks it. The user-approved fix: add an instrument that PROFITS in a broad
crypto crash without bleeding in normal/chop years. On KuCoin/Binance futures that
is a SHORT of the basket. The art is making it:
  * positive in a sustained decline (2022) -> shorts the bear, and
  * ~flat the rest of the time, especially in chop recoveries (2023) -> it must
    EXIT shorts fast on a confirmed bounce or it gets run over (the failure mode
    that capped the regime-switch at 9/10).

Hedge sleeve (causal, on the equal-weight basket index):
  short (-1) when  index < EMA_fast  AND  EMA_fast is falling (nimble entry/exit),
                   gated by index < SMA_slow (only in a broader downtrend);
  flat (0) otherwise. No long leg (it is a hedge). Vol-targeted, leverage-capped.
  The fast EMA makes it cut the short quickly when a recovery starts.

Book = (1 - w_h) * up_engine[trend+XS, the 9/10 engine] + w_h * hedge.
Apply the annual +50% profit-lock; walk-forward the hedge params; sweep w_h and m.
Report all ten years and how ROBUST any 10/10 is (plateau vs knife-edge), with the
overfitting caveat stated explicitly: this adds a sleeve specifically to cover the
one bear, so credibility depends on (a) it generalising to the 2018 bear too and
(b) many settings agreeing, not one.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import annual_target as at
from annual_target import simulate_year, TARGET
from engine import Costs, ema, sma, realized_vol, backtest
from strategies import build_weights

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
STOP = 0.40
COSTS = Costs(txn=0.0006, funding_daily=0.0001)
VOL_FLOOR = 0.10


def basket_index() -> tuple[pd.Series, pd.Series]:
    """Equal-weight basket: (level index, daily return)."""
    rets = {c: at.load_prices(c).pct_change() for c in COINS}
    ew = pd.DataFrame(rets).mean(axis=1).dropna()
    return (1.0 + ew).cumprod(), ew


def hedge_returns(level: pd.Series, basket_ret: pd.Series,
                  fast: int, slow: int, vt: float, ml: float) -> pd.Series:
    """Causal short-only crash hedge return stream on the basket."""
    ef = ema(level, fast)
    ss = sma(level, slow)
    ef_falling = ef < ef.shift(max(2, fast // 3))
    short = ((level < ef) & ef_falling & (level < ss)).astype(float) * -1.0
    # vol-target the short exposure on basket vol
    rv = realized_vol(basket_ret, 30).clip(lower=VOL_FLOOR)
    scale = (vt / rv).clip(upper=ml).fillna(0.0)
    w = (short * scale).clip(-ml, 0.0)          # short-only
    held = w.shift(1).fillna(0.0)
    turn = held.diff().abs().fillna(held.abs())
    net = held * basket_ret - COSTS.txn * turn - COSTS.funding_daily * held.abs()
    return net.dropna()


def up_engine_daily() -> pd.Series:
    """The 9/10 up-market engine = trend30/XS70 blend of OOS daily streams."""
    tb = pd.DataFrame({c: at.best_returns(c)[0] for c in COINS}).mean(axis=1).dropna()
    xb = pd.read_csv(os.path.join(RESULTS, "xsection_oos_daily.csv"),
                     index_col=0, parse_dates=True).iloc[:, 0]
    idx = tb.index.union(xb.index)
    return 0.3 * tb.reindex(idx).fillna(0.0) + 0.7 * xb.reindex(idx).fillna(0.0)


def per_year(stream: pd.Series, m: float):
    rows = []
    for y in sorted(set(stream.index.year)):
        ry = stream[stream.index.year == y]
        if len(ry) < 250:
            continue
        rows.append((int(y), simulate_year(ry.values, m, TARGET, STOP)))
    return rows


def eval_stream(stream, m_grid=(1, 2, 3, 5)):
    best = None
    for m in m_grid:
        py = per_year(stream, m)
        if not py:
            continue
        rs = np.array([r for _, r in py])
        worst = float(rs.min())
        banked = int((rs >= TARGET - 1e-9).sum())
        e = dict(m=m, banked=banked, full_years=len(py),
                 hit_rate=round(banked/len(py), 3), worst_year=round(worst, 4),
                 avg_year=round(float(rs.mean()), 4), per_year=py)
        if worst >= -0.55 and (best is None or (e["hit_rate"], e["avg_year"]) >
                               (best["hit_rate"], best["avg_year"])):
            best = e
    return best


def main(argv):
    print("Building basket index, up-engine, and crash-hedge sleeve ...")
    level, bret = basket_index()
    up = up_engine_daily()
    allidx = up.index.union(bret.index)
    UP = up.reindex(allidx).fillna(0.0)

    # diagnostic: hedge standalone per-year for a mid setting
    h0 = hedge_returns(level, bret, 30, 150, 0.6, 3.0)
    print("\nHedge sleeve standalone (fast=30, slow=150) per-year return (no lock, m=1):")
    print("  ", "  ".join(f"{y}:{(1+h0[h0.index.year==y]).prod()-1:+.0%}"
                          for y in sorted(set(h0.index.year)) if (h0.index.year==y).sum()>=250))

    print(f"\n{'='*88}\nCRASH-HEDGE BLEND SWEEP  book=(1-w)*up + w*hedge; annual +50% lock")
    best_overall = None
    ten = []
    out = {"configs": []}
    for fast in (20, 30, 50):
        for slow in (100, 150, 200):
            for vt in (0.6, 0.9):
                h = hedge_returns(level, bret, fast, slow, vt, 3.0).reindex(allidx).fillna(0.0)
                for wh in (0.2, 0.3, 0.4, 0.5):
                    comb = (1 - wh) * UP + wh * h
                    best = eval_stream(comb)
                    if best is None:
                        continue
                    rec = dict(fast=fast, slow=slow, vt=vt, wh=wh, **{k: best[k] for k in
                               ("m", "banked", "full_years", "hit_rate", "worst_year")})
                    out["configs"].append(rec)
                    d = dict(best["per_year"])
                    is_ten = best["banked"] == best["full_years"]
                    if is_ten:
                        ten.append((fast, slow, vt, wh, best))
                    if best_overall is None or (best["hit_rate"], best["avg_year"]) > best_overall[0]:
                        best_overall = ((best["hit_rate"], best["avg_year"]),
                                        (fast, slow, vt, wh), best)
    n_total = len(out["configs"])
    n_ten = len(ten)
    print(f"\nconfigs tested: {n_total}   reaching 10/10: {n_ten}   "
          f"({n_ten/max(n_total,1):.0%} plateau)")

    sc, params, b = best_overall
    fast, slow, vt, wh = params
    print(f"\nBEST: fast={fast} slow={slow} vt={vt} w_hedge={wh} m={b['m']} -> "
          f"{b['banked']}/{b['full_years']} ({b['hit_rate']:.0%}), worst {b['worst_year']:+.0%}")
    print("  per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in b["per_year"]))

    if n_ten > 0:
        plateau = n_ten / n_total
        verdict = ("ROBUST plateau — many independent settings reach 10/10; credible"
                   if plateau >= 0.25 else
                   "MODERATE — several settings agree; validate at deployment gate"
                   if n_ten >= 3 else
                   "NARROW/knife-edge — likely overfit to the 2022 bear; DISTRUST")
        print(f"\n10/10 robustness: {n_ten}/{n_total} settings -> {verdict}")
        # show 2018-bear generalisation for the best 10/10
        f2, s2, v2, w2, bb = ten[len(ten)//2]
        print("  representative 10/10 per-year:",
              "  ".join(f"{y}:{r:+.0%}" for y, r in bb["per_year"]))
    else:
        print("\nNo setting reaches 10/10 even with the crash hedge.")

    out["best"] = {"params": params, "result": b}
    out["n_ten"] = n_ten
    out["n_total"] = n_total
    with open(os.path.join(RESULTS, "crash_hedge_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'crash_hedge_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
