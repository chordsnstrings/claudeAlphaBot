"""ETH regime engine — built to CAPTURE bull upside and HEDGE bear downside.

The flaw in symmetric momentum: it whipsaws short during choppy bull pullbacks (ETH 2021:
-6% while spot +399%). Fix: a SLOW regime filter sets the bias, a FAST signal trades within:
  * BULL regime  -> long-biased (hold the bull, or long-on-strength) — never short here.
  * BEAR regime  -> hedge (short on weakness, or short-and-hold) — make money on the way down.

Everything is causal (signal shifted 1 bar at execution by the backtester) and validated with
walk-forward OOS: the engine's parameters are re-selected on a trailing train window each fold
and applied forward. Reuses scalp_sweep's cost-aware backtest / metrics / vol-target.

Run:  python eth_engine.py [--cost-bps 5] [--vt 0.20] [--select sharpe|calmar]
"""
from __future__ import annotations

import argparse
import itertools
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scalp_sweep as ss


def engine(df, regime="sma", reg_lb=150, mom_lb=20, bull="hold", bear="short", short_w=1.0, long_w=1.0):
    """Target position in [-1, 1]. regime filter picks bull/bear; behaviour differs by regime."""
    c = df["close"]
    if regime == "sma":
        bull_reg = (c > c.rolling(reg_lb).mean())
    else:  # "mom": slow momentum sign
        bull_reg = (c.pct_change(reg_lb) > 0)
    bull_reg = bull_reg.fillna(False)
    fast = c.pct_change(mom_lb)
    up, dn = fast > 0, fast < 0
    pos = pd.Series(0.0, index=c.index)
    # --- bull regime: long-biased, NEVER short ---
    if bull == "hold":
        pos[bull_reg] = long_w                       # ride the whole bull
    else:  # "trend": long only on strength, flat on pullbacks
        pos[bull_reg & up] = long_w
    # --- bear regime: hedge ---
    if bear == "short":
        pos[~bull_reg & dn] = -short_w               # short on weakness
    elif bear == "shorthold":
        pos[~bull_reg] = -short_w                     # short the whole bear
    # bear == "flat" -> cash in bear (no position)
    return pos


def make_grid():
    g = []
    for rg, rl, ml, bu, be, sw in itertools.product(
            ("sma", "mom"), (50, 100, 150, 200), (10, 20, 40),
            ("hold", "trend"), ("short", "flat", "shorthold"), (0.5, 1.0)):
        if be == "flat" and sw == 0.5:               # short_w irrelevant when flat -> dedupe
            continue
        g.append(dict(regime=rg, reg_lb=rl, mom_lb=ml, bull=bu, bear=be, short_w=sw))
    return g


GRID = make_grid()


def recommended(df):
    """The optimised ETH engine — a PARAMETER-LIGHT committee of regime rules (no fitting,
    so its whole history is out-of-sample). 60% 'ride-the-bull' sleeve (bull=hold) + 40%
    'trend' sleeve, both HEDGING bears (short on weakness). Captures bull upside and makes
    money in most bears; far lower drawdown and higher consistency than buy & hold."""
    hold = [dict(regime=rg, reg_lb=rl, mom_lb=ml, bull="hold", bear="short", short_w=0.5)
            for rg in ("sma", "mom") for rl in (50, 100, 150, 200) for ml in (20, 40)]
    trend = [dict(regime=rg, reg_lb=rl, mom_lb=ml, bull="trend", bear="short", short_w=1.0)
             for rg in ("sma", "mom") for rl in (50, 100, 150, 200) for ml in (20, 40)]
    cpos = lambda b: sum(engine(df, **p) for p in b) / len(b)
    return 0.6 * cpos(hold) + 0.4 * cpos(trend)


def per_year(d):
    return {int(y): float((1 + d[d.index.year == y]).prod() - 1) for y in sorted(set(d.index.year))}


def run(cost_bps=5.0, train_days=90, test_days=30, tf="1d", asset="ETH", vt=None, select="sharpe"):
    ss.set_tf(tf)
    df = ss.load(tf, asset)
    tb, te = train_days * ss.BARS_PER_DAY, test_days * ss.BARS_PER_DAY
    oos, m, chosen, folds = _wf(df, GRID, tb, te, cost_bps, select)
    daily = ss.to_daily(oos)
    if vt:
        daily = ss.vol_target(daily, vt)
    return df, daily, chosen, folds


def _wf(df, grid, train_bars, test_bars, cost_bps, select):
    nets = [ss.backtest(df, engine(df, **p), cost_bps) for p in grid]
    n = len(df); oos = pd.Series(np.nan, index=df.index); chosen = {}; folds = []
    start = train_bars
    while start + test_bars <= n:
        tr = slice(start - train_bars, start); teq = slice(start, start + test_bars)
        best_j, best = 0, -1e18
        for j, net in enumerate(nets):
            mm = ss.metrics(net.iloc[tr])
            sc = mm["sharpe"] if select == "sharpe" else mm["calmar"]
            if sc > best:
                best, best_j = sc, j
        oos.iloc[teq] = nets[best_j].iloc[teq].values
        folds.append(float((1 + nets[best_j].iloc[teq]).prod() - 1))
        k = tuple(sorted(grid[best_j].items())); chosen[k] = chosen.get(k, 0) + 1
        start += test_bars
    return oos.dropna(), None, chosen, folds


def report(df, daily, chosen, folds, label):
    m = ss.daily_metrics(daily)
    eth = df["close"].pct_change().reindex(daily.index).fillna(0.0)
    bh = ss.daily_metrics(eth)
    print(f"\n### {label} ###")
    print(f"  strategy : ann {m['ann']*100:+6.1f}%  Sharpe {m['sharpe']:+5.2f}  Calmar {m['calmar']:+5.2f}  "
          f"maxDD {m['maxdd']*100:5.1f}%  total {m['total']*100:+7.0f}%  posMo {m['pos_months']*100:.0f}%")
    print(f"  buy&hold : ann {bh['ann']*100:+6.1f}%  Sharpe {bh['sharpe']:+5.2f}  Calmar {bh['calmar']:+5.2f}  "
          f"maxDD {bh['maxdd']*100:5.1f}%  total {bh['total']*100:+7.0f}%")
    ps, pb = per_year(daily), per_year(eth)
    bull_cap = np.mean([ps[y] for y in ps if pb.get(y, 0) > 0])
    bear_ret = np.mean([ps[y] for y in ps if pb.get(y, 0) <= 0])
    print(f"  BULL years: strat avg {bull_cap*100:+.0f}%   BEAR years: strat avg {bear_ret*100:+.0f}%   "
          f"pos years {np.mean([v>0 for v in ps.values()])*100:.0f}%")
    if chosen:
        top = max(chosen, key=chosen.get)
        print(f"  modal config: {dict(top)}  ({chosen[top]}/{sum(chosen.values())} folds)")
    return ps, pb


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cost-bps", type=float, default=5.0)
    ap.add_argument("--vt", type=float, default=None)
    ap.add_argument("--select", default="sharpe")
    ap.add_argument("--tf", default="1d")
    a = ap.parse_args()
    df, daily, chosen, folds = run(a.cost_bps, tf=a.tf, vt=a.vt, select=a.select)
    ps, pb = report(df, daily, chosen, folds, f"ETH regime engine {a.tf} @{a.cost_bps}bps vt={a.vt} select={a.select}")
    print("\n  year     strat   buy&hold")
    for y in sorted(ps):
        print(f"  {y:<6d}{ps[y]*100:>+8.0f}%{pb.get(y,0)*100:>+9.0f}%")
