"""Confirmed-bear regime switch, swept over all years.

Lesson from regime_switch_bot.py: switching on the bot's OWN equity drawdown whipsaws
(sells V-shaped dips). This switches on a CONFIRMED market bear instead: defense kicks
in only when a broad crypto index sits below its long-term trend (SMA-L) for N
consecutive days (hysteresis both ways), and lifts when it reclaims the trend for N
days. Defense = ALL-WEATHER-MAX (60% spine); otherwise GROWTH (best CAGR). Causal
(regime for day t uses the index through t-1).

Swept over the full combined-OOS window (2021-2026); reports per-year and picks the
best config by Calmar and by bounded-drawdown return.

Run: python confirmed_bear_switch.py
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import all_weather as aw
from regime_switch_bot import ALLWX, GROWTH
from unified_bot import build_panel, weighted

CAP = 10000.0
ANN = 365.0


def market_index() -> pd.Series:
    """Broad, survivorship-free equal-weight crypto index from the top-30 universe."""
    px, _ = aw.load_panel()
    ew = px.pct_change().mean(axis=1)            # equal-weight daily return of live coins
    return (1.0 + ew.fillna(0.0)).cumprod()


def regime_modes(idx: pd.Series, dates: pd.DatetimeIndex, L: int, confirm: int) -> pd.Series:
    """GROWTH/DEFENSE per day. Causal: the index value through t-1 sets the mode for t.
    Hysteresis: flip only after `confirm` consecutive days of the new condition."""
    sma = idx.rolling(L, min_periods=L).mean()
    below = (idx < sma).shift(1).reindex(dates).fillna(False)
    state, cnt, out = "GROWTH", 0, []
    for d in dates:
        b = bool(below[d])
        if state == "GROWTH":
            cnt = cnt + 1 if b else 0
            if cnt >= confirm:
                state, cnt = "DEFENSE", 0
        else:
            cnt = cnt + 1 if not b else 0
            if cnt >= confirm:
                state, cnt = "GROWTH", 0
        out.append(state)
    return pd.Series(out, index=dates)


def chosen_returns(rg, rd, modes) -> pd.Series:
    return pd.Series([rg[d] if modes[d] == "GROWTH" else rd[d] for d in rg.index],
                     index=rg.index)


def summarize(r: pd.Series, cap=CAP) -> dict:
    eq = cap * (1 + r).cumprod()
    n = len(r); yrs = n / ANN
    cagr = (eq.iloc[-1] / cap) ** (1 / yrs) - 1 if eq.iloc[-1] > 0 else -1.0
    dd = float((eq / eq.cummax() - 1).min())
    sd = r.std(ddof=0)
    sharpe = float(r.mean() / sd * np.sqrt(ANN)) if sd > 0 else 0.0
    py = {int(y): float((1 + r[r.index.year == y]).prod() - 1) for y in sorted(set(r.index.year))}
    return {"final": float(eq.iloc[-1]), "cagr": cagr, "max_dd": dd, "sharpe": sharpe,
            "calmar": cagr / abs(dd) if dd < 0 else 0.0, "per_year": py}


def py_str(py: dict) -> str:
    return " ".join(f"{str(y)[2:]}:{v:>+5.0%}" for y, v in py.items())


def main(argv):
    df, _ = build_panel()
    rg, rd = weighted(df, GROWTH), weighted(df, ALLWX)
    idx = market_index()
    print(f"CONFIRMED-BEAR SWITCH — full window {df.index[0].date()} -> {df.index[-1].date()} "
          f"({len(df)} days), m=1, ${CAP:,.0f}\n")

    bench = {"static GROWTH": summarize(rg), "static ALL-WEATHER-MAX": summarize(rd)}
    print(f"  {'book':<26} {'final$':>9} {'CAGR':>7} {'maxDD':>7} {'Shrp':>6} {'Calmar':>7}  per-year")
    for label, s in bench.items():
        print(f"  {label:<26} ${s['final']:>8,.0f} {s['cagr']:>+7.0%} {s['max_dd']:>+7.0%} "
              f"{s['sharpe']:>6.2f} {s['calmar']:>7.2f}  {py_str(s['per_year'])}")

    print("\n  Confirmed-bear switch (defense=ALL-WEATHER-MAX when index<SMA(L) for `confirm` days):")
    print(f"  {'L':>4} {'cfm':>4} {'final$':>9} {'CAGR':>7} {'maxDD':>7} {'Shrp':>6} {'Calmar':>7} {'%def':>5}  per-year")
    results = []
    for L in (100, 150, 200):
        for confirm in (1, 5, 10, 20):
            modes = regime_modes(idx, df.index, L, confirm)
            r = chosen_returns(rg, rd, modes)
            s = summarize(r); s["L"], s["confirm"] = L, confirm
            s["pdef"] = float((modes == "DEFENSE").mean())
            results.append(s)
            print(f"  {L:>4} {confirm:>4} ${s['final']:>8,.0f} {s['cagr']:>+7.0%} {s['max_dd']:>+7.0%} "
                  f"{s['sharpe']:>6.2f} {s['calmar']:>7.2f} {s['pdef']:>5.0%}  {py_str(s['per_year'])}")

    best_calmar = max(results, key=lambda s: s["calmar"])
    best_ret_bdd = max([s for s in results if s["max_dd"] > -0.35] or results,
                       key=lambda s: s["final"])
    print(f"\n  BEST by Calmar:  L={best_calmar['L']} confirm={best_calmar['confirm']} "
          f"-> ${best_calmar['final']:,.0f}, CAGR {best_calmar['cagr']:+.0%}, "
          f"maxDD {best_calmar['max_dd']:+.0%}, Calmar {best_calmar['calmar']:.2f}")
    print(f"  BEST return @ maxDD>-35%:  L={best_ret_bdd['L']} confirm={best_ret_bdd['confirm']} "
          f"-> ${best_ret_bdd['final']:,.0f}, CAGR {best_ret_bdd['cagr']:+.0%}, "
          f"maxDD {best_ret_bdd['max_dd']:+.0%}, Calmar {best_ret_bdd['calmar']:.2f}")
    print(f"\n  vs static GROWTH ${bench['static GROWTH']['final']:,.0f} (Calmar "
          f"{bench['static GROWTH']['calmar']:.2f}) / static ALL-WEATHER-MAX "
          f"${bench['static ALL-WEATHER-MAX']['final']:,.0f} (Calmar {bench['static ALL-WEATHER-MAX']['calmar']:.2f}).")
    print("  Note: causal regime gate (index through t-1). 2021-partial & 2026-partial are "
          "stub years. Backtest, OOS in the walk-forward sense; past performance not predictive.")


if __name__ == "__main__":
    main(sys.argv[1:])
