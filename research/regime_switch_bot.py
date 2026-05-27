"""Dynamic regime-switching unified bot.

Default to the aggressive best-CAGR profile; de-risk to all-weather-max (60% spine)
when a drawdown breaches a threshold; re-risk only after a confirmed recovery.

State machine (causal — the mode for day t is decided from equity realised through t-1):
  * start in GROWTH (best CAGR).
  * GROWTH -> DEFENSE  when equity falls <= -DD_TRIGGER from its running ATH.
  * DEFENSE -> GROWTH  when equity climbs back to (frozen ATH at the trigger) * (1+RECOVER).
DEFENSE runs ALL-WEATHER-MAX (60% spine, the crisis-alpha-heavy book).

Run: python regime_switch_bot.py [--since YYYY-MM-DD] [--capital N] [--dd 0.15] [--recover 0.05] [--m 1]
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from unified_bot import build_panel, weighted

GROWTH = {"CORE": 0.70, "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": 0.00}   # best CAGR
ALLWX = {"CORE": 0.15, "BTC1H": 0.125, "ETH8H": 0.125, "SPINE": 0.60}  # all-weather-max


def simulate(rg: pd.Series, rd: pd.Series, capital, dd_trigger, recover, m):
    """rg/rd = daily returns of the GROWTH / DEFENSE books. Returns equity series,
    per-day mode, and the list of switch events."""
    idx = rg.index
    eq, peak = capital, capital
    state, frozen = "GROWTH", None
    equity, mode, switches = [], [], []
    for d in idx:
        r = rg[d] if state == "GROWTH" else rd[d]
        step = 1.0 + m * r
        eq = 0.0 if step <= 0 else eq * step
        peak = max(peak, eq)
        equity.append(eq); mode.append(state)
        # decide the mode for the NEXT day from equity realised through d (causal)
        if state == "GROWTH" and peak > 0 and eq / peak - 1.0 <= -dd_trigger:
            state, frozen = "DEFENSE", peak
            switches.append((d, "GROWTH->DEFENSE", eq, eq / peak - 1.0))
        elif state == "DEFENSE" and frozen and eq >= frozen * (1.0 + recover):
            state = "GROWTH"
            switches.append((d, "DEFENSE->GROWTH", eq, eq / frozen - 1.0))
    return pd.Series(equity, index=idx), pd.Series(mode, index=idx), switches


def stats(eq: pd.Series, capital: float) -> dict:
    peak = eq.cummax(); dd = float((eq / peak - 1.0).min())
    n = len(eq); yrs = n / 365.0
    cagr = (eq.iloc[-1] / capital) ** (1 / yrs) - 1 if eq.iloc[-1] > 0 and yrs > 0 else -1.0
    return {"final": float(eq.iloc[-1]), "ret": float(eq.iloc[-1] / capital - 1.0),
            "max_dd": dd, "cagr": cagr}


def main(argv):
    since, capital, dd, rec, m = "2024-01-01", 10000.0, 0.15, 0.05, 1.0
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--since": since = argv[i + 1]; i += 2
        elif a == "--capital": capital = float(argv[i + 1]); i += 2
        elif a == "--dd": dd = float(argv[i + 1]); i += 2
        elif a == "--recover": rec = float(argv[i + 1]); i += 2
        elif a == "--m": m = float(argv[i + 1]); i += 2
        else: i += 1

    df, _ = build_panel()
    w = df.loc[since:]
    rg, rd = weighted(w, GROWTH), weighted(w, ALLWX)

    print(f"REGIME-SWITCH BOT — ${capital:,.0f} from {w.index[0].date()} to {w.index[-1].date()} "
          f"({len(w)} days), m={m:g}")
    print(f"  rule: GROWTH (best CAGR) -> ALL-WEATHER-MAX on -{dd:.0%} drawdown from ATH; "
          f"back to GROWTH at ATH+{rec:.0%}\n")

    eq_sw, mode, switches = simulate(rg, rd, capital, dd, rec, m)
    eq_g, _, _ = simulate(rg, rg, capital, 1.0, 0.0, m)   # static GROWTH (never triggers)
    eq_d, _, _ = simulate(rd, rd, capital, 1.0, 0.0, m)   # static ALL-WEATHER-MAX

    print(f"  {'book':<22} {'final $':>10} {'return':>9} {'maxDD':>8} {'CAGR':>8}")
    for label, eq in (("static GROWTH", eq_g), ("static ALL-WEATHER-MAX", eq_d),
                      ("DYNAMIC switch", eq_sw)):
        s = stats(eq, capital)
        print(f"  {label:<22} ${s['final']:>9,.0f} {s['ret']:>+9.1%} {s['max_dd']:>8.1%} {s['cagr']:>+8.1%}")

    days_def = int((mode == "DEFENSE").sum())
    print(f"\n  switches ({len(switches)}); {days_def}/{len(mode)} days "
          f"({days_def/len(mode):.0%}) in defense:")
    for d, ev, e, lvl in switches:
        print(f"    {d.date()}  {ev:<16} equity ${e:>9,.0f}  ({'DD '+format(lvl,'+.0%') if 'DEFENSE' in ev.split('->')[1] else 'vs ATH '+format(lvl,'+.0%')})")

    print("\n  Month-end equity (DYNAMIC, * = in defense that month-end):")
    me = eq_sw.resample("ME").last(); mm = mode.resample("ME").last()
    prev = capital
    for d, v in me.items():
        flag = "*" if mm[d] == "DEFENSE" else " "
        print(f"    {d.strftime('%Y-%m')}{flag} ${v:>10,.0f}  ({v/prev-1:>+6.1%})")
        prev = v
    print("\n  Note: causal switch (mode for day t set from equity through t-1). Backtest, "
          "OOS in the walk-forward sense. Thresholds (--dd/--recover) are tunable; defense "
          "= 60% all-weather spine. Past performance is not predictive.")


if __name__ == "__main__":
    main(sys.argv[1:])
