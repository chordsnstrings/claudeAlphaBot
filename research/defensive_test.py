"""Does adding a DEFENSIVE sleeve protect the unified bot in a bear?

Adds the validated all-weather long/short time-series-trend spine (all_weather.py,
ALL_WEATHER_SPINE.md: +24% CAGR OOS, +22% in the 2022 crash, worst yr -3%) as a 4th
sleeve to the orchestrator (CORE + BTC1H + ETH8H). The spine SHORTS confirmed
downtrends -> crisis alpha that should earn in a bear.

Honest test (not bear-cherry-picking): for each allocation we report BOTH
  (a) full-window OOS metrics 2021-2026 (Sharpe / maxDD / worst calendar year) — the
      spine must improve the risk profile over the WHOLE sample to earn its place, and
  (b) the Aug-2025 -> date $10k bear-window result — the protection question asked.

Spine at its validated 15 bps/side (top-30, less liquid); other sleeves at 6 bps.
Run: python defensive_test.py
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import all_weather as aw
import unified_bot as ub
from unified_bot import met, weighted

CORE, BTC1H, ETH8H, SPINE = "CORE", "BTC1H", "ETH8H", "SPINE"
SPINE_COST_BPS = 15

# grid for the spine walk-forward (same as all_weather.main)
TS_GRID = [dict(lbs=lbs, gross_target=gt, max_gross=mg)
           for lbs in ((10, 30, 60, 120), (20, 50, 100), (30, 60, 120))
           for gt in (0.6, 1.0) for mg in (1.5, 2.5)]

ALLOCS = {
    "3-sleeve (no spine)":  {CORE: 0.70, BTC1H: 0.15, ETH8H: 0.15, SPINE: 0.00},
    "+15% spine":           {CORE: 0.55, BTC1H: 0.15, ETH8H: 0.15, SPINE: 0.15},
    "+30% spine":           {CORE: 0.40, BTC1H: 0.15, ETH8H: 0.15, SPINE: 0.30},
    "spine-led (45%)":      {CORE: 0.25, BTC1H: 0.15, ETH8H: 0.15, SPINE: 0.45},
    "all-weather (60% spine)": {CORE: 0.15, BTC1H: 0.125, ETH8H: 0.125, SPINE: 0.60},
}


def spine_returns() -> pd.Series:
    """Stitched walk-forward OOS spine returns, extended with one final OOS fold (best
    config on the trailing 540d, applied to the remaining tail) so coverage reaches the
    data end rather than stopping at the last complete 180d test window."""
    px, vol = aw.load_panel()
    nets = {}
    for p in TS_GRID:
        g, tn, ex, _ = aw.build_ts_trend(px, vol, **p)
        nets[tuple(sorted(p.items()))] = aw.net_from(g, tn, ex, SPINE_COST_BPS)
    oos = aw.walk_forward(px, vol, aw.build_ts_trend, TS_GRID, SPINE_COST_BPS).sort_index()
    last = oos.index[-1]
    lo = last - pd.Timedelta(days=540)
    best, bsc = None, -1e9
    for net in nets.values():
        trs = net[(net.index > lo) & (net.index <= last)]
        if len(trs) < 60:
            continue
        sd = trs.std(ddof=0)
        sc = trs.mean() / sd * np.sqrt(365) if sd > 0 else -9
        if sc > bsc:
            bsc, best = sc, net
    tail = best[best.index > last] if best is not None else pd.Series(dtype=float)
    return pd.concat([oos, tail]).sort_index()


def worst_year(r: pd.Series) -> tuple[int, float]:
    by = {int(y): float((1 + r[r.index.year == y]).prod() - 1)
          for y in sorted(set(r.index.year)) if (r.index.year == y).sum() >= 250}
    if not by:
        return (0, float("nan"))
    y = min(by, key=by.get)
    return y, by[y]


def lever_equity(r, capital, m=1.0):
    v, out = capital, []
    for x in r.values:
        step = 1 + m * x
        v = 0.0 if step <= 0 else v * step
        out.append(v)
    return pd.Series(out, index=r.index)


def build_4panel():
    r_core = ub.core_daily_returns()
    r_btc, _ = ub.intraday_daily_returns("BTC", "1h", "regime_pullback")
    r_eth, _ = ub.intraday_daily_returns("ETH", "8h", "regime_pullback")
    r_spine = spine_returns()
    start = max(r_btc.index.min(), r_eth.index.min(), r_spine.index.min())
    end = min(r_core.index.max(), r_spine.index.max())
    idx = r_core.loc[start:end].index
    return pd.DataFrame({
        CORE: r_core.reindex(idx).fillna(0.0),
        BTC1H: r_btc.reindex(idx).fillna(0.0),
        ETH8H: r_eth.reindex(idx).fillna(0.0),
        SPINE: r_spine.reindex(idx).fillna(0.0),
    })


def main(argv):
    df = build_4panel()
    win_start = "2025-08-01"
    print(f"DEFENSIVE-SLEEVE TEST  full window {df.index[0].date()} -> {df.index[-1].date()} "
          f"({len(df)} days)\n")

    # spine standalone + correlations
    sp = met(df[SPINE]); wy_sp = worst_year(df[SPINE])
    bear = df.loc[win_start:]
    sp_bear = float((1 + bear[SPINE]).prod() - 1)
    print(f"SPINE sleeve standalone (1x, OOS, 15bps): CAGR {sp['cagr']:+.1%}, Sharpe "
          f"{sp['sharpe']:.2f}, maxDD {sp['max_dd']:.1%}, worst yr {wy_sp[0]}:{wy_sp[1]:+.0%}")
    print(f"  Aug-2025 bear window return: {sp_bear:+.1%}   (the protection source)")
    corr = df.corr()
    print(f"  corr(SPINE, CORE)={corr.loc[SPINE,CORE]:+.2f}  "
          f"corr(SPINE,BTC1H)={corr.loc[SPINE,BTC1H]:+.2f}  "
          f"corr(SPINE,ETH8H)={corr.loc[SPINE,ETH8H]:+.2f}\n")

    print(f"{'allocation':<24} | full-window OOS 2021-26          | Aug-2025 bear ($10k)")
    print(f"{'(CORE/B1H/E8H/SPINE)':<24} |  CAGR   Shrp   maxDD  worstYr | final$    return   maxDD")
    print("-" * 92)
    rows = {}
    for label, w in ALLOCS.items():
        r_full = weighted(df, w)
        m = met(r_full); wy = worst_year(r_full)
        r_bear = weighted(bear, w)
        eq = lever_equity(r_bear, 10000.0, 1.0)
        peak = eq.cummax(); dd = float((eq / peak - 1).min())
        fin = float(eq.iloc[-1])
        rows[label] = dict(cagr=m["cagr"], sharpe=m["sharpe"], maxdd=m["max_dd"],
                           worst_yr=wy, bear_final=fin, bear_ret=fin/10000-1, bear_dd=dd)
        tag = f"{w[CORE]:.0%}/{w[BTC1H]:.0%}/{w[ETH8H]:.0%}/{w[SPINE]:.0%}"
        print(f"{label:<24} | {m['cagr']:>+5.0%} {m['sharpe']:>5.2f} {m['max_dd']:>6.0%} "
              f"{wy[0]}:{wy[1]:>+4.0%} | ${fin:>7,.0f} {fin/10000-1:>+7.1%} {dd:>6.0%}")
    print(f"\n  (alloc tag = {tag and 'CORE/BTC1H/ETH8H/SPINE'})")
    print("\nReading: more SPINE -> better worst-year / bear protection, lower bull CAGR "
          "(all-weather costs upside). The spine earns its place if it lifts Sharpe and "
          "shrinks worst-year/bear loss without giving up too much CAGR.")


if __name__ == "__main__":
    main(sys.argv[1:])
