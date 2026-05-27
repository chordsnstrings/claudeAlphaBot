"""2x profit-harvest model on a $300k base, annual reset (no compounding).

Rule: "take 100% profit out at any point it 2x, and sweep profit at year end."
Two readings (both reset to base each Jan, -40% intra-year stop, leverage m):
  LOCK-2x  : when YTD hits +100% (2x), bank it and go FLAT for the rest of the year;
             otherwise sweep whatever profit at year end. (= annual_target target=1.0)
  HARVEST  : every time equity hits 2x, withdraw the 100% profit and CONTINUE trading
             from base (can harvest several doubles in a strong year), + year-end sweep.

Reports total cash withdrawn on $300k over the full years (2022-2025), per-year, and
the number of 2x harvests. Books: GROWTH / ALL-WEATHER(30%) / ALL-WEATHER-MAX(60%) /
confirmed-bear SWITCH.

Run: python harvest_2x.py
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import annual_target as at
from confirmed_bear_switch import chosen_returns, market_index, regime_modes
from regime_switch_bot import ALLWX, GROWTH
from unified_bot import PROFILES, build_panel, weighted

BASE = 300_000.0
STOP = 0.40


def sim_harvest_year(daily: np.ndarray, m: float, stop=STOP) -> tuple[float, int]:
    """HARVEST reading: withdraw 100% profit each time equity doubles, continue from
    base; -40% YTD stop flattens the year. Returns (net $ profit for the year, #harvests)."""
    eq, harvested, n, locked = BASE, 0.0, 0, False
    for r in daily:
        if locked:
            continue
        eq *= (1.0 + m * r)
        if eq <= 0:
            return harvested - BASE, n          # liquidation: base lost
        if eq >= 2.0 * BASE:
            harvested += eq - BASE; eq = BASE; n += 1
        if eq <= (1.0 - stop) * BASE:
            locked = True
    return harvested + (eq - BASE), n           # + year-end sweep (eq-BASE may be <0)


def per_year(r: pd.Series, m: float, mode: str):
    """mode 'lock' -> +100% lock via annual_target; 'harvest' -> repeat-harvest."""
    out, harvests = {}, {}
    for y in sorted(set(r.index.year)):
        ry = r[r.index.year == y]
        if len(ry) < 250:
            continue
        if mode == "lock":
            out[int(y)] = BASE * at.simulate_year(ry.values, m, 1.00, STOP)
            harvests[int(y)] = 1 if out[int(y)] >= BASE - 1 else 0
        else:
            p, n = sim_harvest_year(ry.values, m)
            out[int(y)] = p; harvests[int(y)] = n
    return out, harvests


def report(streams: dict, mode: str, label: str):
    print(f"\n=== {label} — $300k base, annual reset, -{STOP:.0%} stop ===")
    print(f"  {'book':<22} {'m':>2} {'total profit':>13} {'avg/yr':>9} {'worst yr':>9} {'#2x':>4}  per-year profit ($k)")
    best = None
    for name, r in streams.items():
        for m in (1.0, 2.0, 3.0):
            yr, hv = per_year(r, m, mode)
            tot = sum(yr.values()); n2x = sum(hv.values())
            avg = float(np.mean(list(yr.values()))); worst = min(yr.values())
            if best is None or tot > best[0]:
                best = (tot, name, m, avg, worst, n2x)
            py = " ".join(f"{str(y)[2:]}:{v/1000:>+5.0f}" for y, v in yr.items())
            print(f"  {name:<22} {m:>2.0f} ${tot:>12,.0f} ${avg:>8,.0f} ${worst:>8,.0f} {n2x:>4}  {py}")
    print(f"  >>> best: {best[1]} @ m={best[2]:.0f} -> ${best[0]:,.0f} total "
          f"(avg ${best[3]:,.0f}/yr, worst ${best[4]:,.0f}, {best[5]} doublings)")
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
    print(f"2x PROFIT-HARVEST — base ${BASE:,.0f}, full years {yrs} (no compounding; "
          f"profit out at 2x and at year end)")
    b_lock = report(streams, "lock", "LOCK at 2x then flat (= +100% annual lock)")
    b_harv = report(streams, "harvest", "HARVEST every 2x and keep trading")
    print("\nVERDICT")
    print(f"  - LOCK-at-2x: best is {b_lock[1]} m={b_lock[2]:.0f} -> ${b_lock[0]:,.0f} profit "
          f"on $300k over {len(yrs)} yrs (worst yr ${b_lock[4]:,.0f}).")
    print(f"  - HARVEST-every-2x: best is {b_harv[1]} m={b_harv[2]:.0f} -> ${b_harv[0]:,.0f} "
          f"({b_harv[5]} doublings; worst yr ${b_harv[4]:,.0f}).")
    print("  Only 4 full years; leveraged bull years are lumpy & 2023-24-driven; -40% stop "
          "assumes no catastrophic intraday gap. Backtest, not predictive.")


if __name__ == "__main__":
    main(sys.argv[1:])
