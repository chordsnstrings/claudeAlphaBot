"""Run the unified bot from a start date with a given starting capital and report the
realised path. Reuses the orchestrator's combined daily return stream (build_panel),
restricted to the window. OOS in the walk-forward sense: the intraday sleeves' params
were chosen on data preceding each test fold.

Usage: python run_capital.py [--since YYYY-MM-DD] [--capital N] [--alloc c,b,e]
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from unified_bot import FIXED_W, build_panel, met, weighted


def lever_equity(r: pd.Series, capital: float, m: float) -> pd.Series:
    """Compound capital at m× the daily net return, with a hard liquidation guard
    (a day where 1+m·r ≤ 0 wipes the account)."""
    eq = []
    v = capital
    for x in r.values:
        step = 1.0 + m * x
        if step <= 0:
            v = 0.0
        else:
            v *= step
        eq.append(v)
    return pd.Series(eq, index=r.index)


def stats(eq: pd.Series, capital: float) -> dict:
    peak = eq.cummax()
    dd = (eq / peak - 1.0).min()
    return {"final": float(eq.iloc[-1]),
            "ret": float(eq.iloc[-1] / capital - 1.0),
            "max_dd": float(dd),
            "peak": float(eq.max())}


def main(argv):
    since, capital = "2025-08-01", 10000.0
    alloc = dict(FIXED_W)
    i = 0
    while i < len(argv):
        if argv[i] == "--since": since = argv[i + 1]; i += 2
        elif argv[i] == "--capital": capital = float(argv[i + 1]); i += 2
        elif argv[i] == "--alloc":
            c, b, e = (float(x) for x in argv[i + 1].split(","))
            alloc = {"CORE": c, "BTC1H": b, "ETH8H": e}; i += 2
        else: i += 1

    df, _ = build_panel()
    w = df.loc[since:]
    if w.empty:
        print(f"no data on/after {since}"); return
    r_comb = weighted(w, alloc)
    start_d, end_d = w.index[0].date(), w.index[-1].date()
    months = (w.index[-1] - w.index[0]).days / 30.44

    print(f"UNIFIED BOT — ${capital:,.0f} from {start_d} to {end_d} "
          f"({len(w)} days, ~{months:.1f} months)")
    print(f"allocation CORE/BTC1H/ETH8H = {alloc['CORE']:.0%}/{alloc['BTC1H']:.0%}/{alloc['ETH8H']:.0%}\n")

    # ---- per-sleeve standalone (1x) over the window ----
    print("Per-sleeve over the window (standalone, 1×):")
    print(f"  {'sleeve':<7} {'return':>9} {'maxDD':>8} {'final $ of its slice':>22}")
    for s in df.columns:
        eq_s = lever_equity(w[s], capital * alloc[s], 1.0)
        st = stats(eq_s, capital * alloc[s])
        print(f"  {s:<7} {st['ret']:>+9.1%} {st['max_dd']:>8.1%} "
              f"  ${capital*alloc[s]:>8,.0f} -> ${st['final']:>9,.0f}")

    # ---- combined book at m = 1, 2, 3 ----
    print("\nCombined book — $ path by leverage (continuous compounding, no withdrawal):")
    print(f"  {'m=lev':>6} {'final $':>12} {'total ret':>10} {'max DD':>8} {'CAGR(ann)':>10}")
    yrs = len(w) / 365.0
    eq_m1 = None
    for m in (1.0, 2.0, 3.0):
        eq = lever_equity(r_comb, capital, m)
        if m == 1.0: eq_m1 = eq
        st = stats(eq, capital)
        cagr = (st["final"] / capital) ** (1 / yrs) - 1 if st["final"] > 0 else -1.0
        print(f"  {m:>6.0f} ${st['final']:>11,.0f} {st['ret']:>+10.1%} "
              f"{st['max_dd']:>8.1%} {cagr:>+10.1%}")

    # ---- monthly equity progression (m=1, the honest unlevered path) ----
    mm = met(r_comb)
    print(f"\nUnlevered (m=1) Sharpe {mm['sharpe']:.2f}, ann vol {mm['ann_vol']:.0%}.  "
          f"Month-end equity (m=1):")
    monthly = eq_m1.resample("ME").last()
    prev = capital
    for d, v in monthly.items():
        mret = v / prev - 1.0
        bar = "+" if mret >= 0 else "-"
        print(f"  {d.strftime('%Y-%m')}  ${v:>10,.0f}  ({mret:>+6.1%}) {bar * min(int(abs(mret)*100), 40)}")
        prev = v

    print("\nNote: backtest over a recent window, OOS in the walk-forward sense (intraday "
          "params chosen on prior data). The daily CORE is the fixed validated config. "
          "Leverage amplifies both directions; the deployable spec caps m≤3 with a −40% "
          "annual stop. Past performance is not predictive.")


if __name__ == "__main__":
    main(sys.argv[1:])
