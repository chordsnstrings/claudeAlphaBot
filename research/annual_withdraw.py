"""Annual profit-withdrawal model: every year starts fresh at the base stake and ALL
profit is swept at year end -> no year-over-year compounding. This re-ranks the books,
because GROWTH's runaway bull-year compounding (the $106k terminal in the continuous
model) no longer accrues; what matters now is the per-year return profile.

Two withdrawal policies (both reset each Jan, -40% intra-year stop, leverage m):
  * TAKE-ALL : withdraw everything above base at year end (no upside cap).
  * +50% LOCK: bank +50% and go flat for the rest of the year (the deployable model,
               DEPLOYABLE_STRATEGY_BUILD.md) -> you stop taking profit past +50%.

Reports, per book × leverage: total cash withdrawn on a $10k base, avg/worst year,
and the per-year banked returns. Full calendar years only (2022-2025 overlap the
intraday/spine OOS). Reuses annual_target.simulate_year (causal year race).

Run: python annual_withdraw.py
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import annual_target as at
from confirmed_bear_switch import chosen_returns, market_index, regime_modes
from regime_switch_bot import ALLWX, GROWTH
from unified_bot import PROFILES, build_panel, weighted

BASE = 10000.0
STOP = 0.40


def annual_returns(r: pd.Series, m: float, target: float) -> dict:
    """Per-calendar-year realised return under the reset/withdraw race (full years)."""
    out = {}
    for y in sorted(set(r.index.year)):
        ry = r[r.index.year == y]
        if len(ry) < 250:
            continue
        out[int(y)] = at.simulate_year(ry.values, m, target, STOP)
    return out


def report(streams: dict, target: float, label: str):
    print(f"\n=== {label} (annual reset, -{STOP:.0%} stop) ===")
    print(f"  {'book':<22} {'m':>2} {'total$ on 10k':>13} {'avg/yr':>7} {'worst':>7} {'+yrs':>5}  per-year")
    best = None
    for name, r in streams.items():
        for m in (1.0, 2.0, 3.0):
            yr = annual_returns(r, m, target)
            tot = sum(yr.values())                     # cash multiple of base over the years
            cash = BASE * tot
            avg = float(np.mean(list(yr.values())))
            worst = min(yr.values())
            npos = sum(1 for v in yr.values() if v > 1e-9)
            row = (cash, name, m, avg, worst, npos, yr)
            if best is None or cash > best[0]:
                best = row
            py = " ".join(f"{str(y)[2:]}:{v:>+5.0%}" for y, v in yr.items())
            print(f"  {name:<22} {m:>2.0f} ${cash:>11,.0f} {avg:>+7.0%} {worst:>+7.0%} "
                  f"{npos}/{len(yr):>1}  {py}")
    print(f"  >>> best total cash: {best[1]} @ m={best[2]:.0f} -> ${best[0]:,.0f} "
          f"(avg {best[3]:+.0%}/yr, worst {best[4]:+.0%})")
    return best


def main(argv):
    df, _ = build_panel()
    idx = market_index()
    modes = regime_modes(idx, df.index, 100, 5)
    rg, rd = weighted(df, GROWTH), weighted(df, ALLWX)
    streams = {
        "GROWTH": rg,
        "ALL-WEATHER(30%)": weighted(df, PROFILES["all_weather"]),
        "ALL-WEATHER-MAX(60%)": rd,
        "SWITCH(SMA100/5d)": chosen_returns(rg, rd, modes),
    }
    yrs = sorted({y for y in set(df.index.year) if (df.index.year == y).sum() >= 250})
    print(f"ANNUAL PROFIT-WITHDRAWAL — base ${BASE:,.0f}, full years {yrs} "
          f"(each year reset; no compounding)")

    b_takeall = report(streams, 99.0, "TAKE-ALL profit (no upside cap)")
    b_lock = report(streams, 0.50, "+50% PROFIT-LOCK (deployable model)")

    print("\nVERDICT")
    print(f"  - Take-all (no cap): {b_takeall[1]} m={b_takeall[2]:.0f} extracts the most "
          f"(${b_takeall[0]:,.0f}) — uncapped bull years dominate even without compounding.")
    print(f"  - +50% lock: {b_lock[1]} m={b_lock[2]:.0f} extracts the most "
          f"(${b_lock[0]:,.0f}) — capping upside rewards CONSISTENCY (fewer/' smaller down years).")
    print("  Backtest, OOS in the walk-forward sense; -40% stop bounds bad years; "
          "leverage m amplifies but the stop/​liquidation guards the downside. Not predictive.")


if __name__ == "__main__":
    main(sys.argv[1:])
