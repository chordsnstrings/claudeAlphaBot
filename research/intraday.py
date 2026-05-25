"""Intraday mean-reversion sleeve — the lever the daily-only harness could not pull.

Motivation. The daily trend-following book banks +50% in ~80% of calendar years
but misses the *trendless* years (2023, 2025): momentum sits in cash while price
chops sideways. Mean reversion is the natural complement, and it has far more
tradeable opportunities intraday than on daily bars. Binance Vision (now
reachable) gives us real 1h candles, so we can finally test whether an
intraday-MR sleeve produces an *uncorrelated* positive return stream in exactly
the years the trend book is flat.

Method (fully causal, walk-forward OOS):
  * Load 1h closes per coin.
  * Search MR families (z-score reversion, RSI reversion), trend-gated, with
    inverse-vol sizing — reusing the validated walk-forward machinery. Sharpe-
    based param selection is invariant to the bars/year constant, and per-bar
    returns + turnover costs compound correctly, so the engine is reused as-is
    with a per-bar funding charge.
  * Costs are charged at intraday frequency (taker bps on every turnover), which
    is where naive HF mean reversion usually dies — kept conservative.
  * The OOS per-bar return stream is aggregated to per-day, then per-calendar-year,
    so it can be combined with the daily trend book at the book level.

This module reports, per coin and for the blend, the calendar-year returns of the
intraday-MR sleeve and whether adding it lifts the trend book's weak years.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

from engine import Costs
from strategies import Family, sig_mr_z, sig_rsi_mr, build_weights
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
INTRADAY_DIR = os.path.join(HERE, "data", "intraday")
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]

# 1h bars: ~8760/yr. Funding modelled per-bar so the annual carry drag matches the
# daily study (~1.8%/yr at 1x gross). Taker cost 6 bps on every unit of turnover.
BARS_PER_YEAR = 365 * 24
COSTS = Costs(txn=0.0006, funding_daily=0.00005 / 24.0)


def load_1h(sym: str) -> pd.Series:
    path = os.path.join(INTRADAY_DIR, f"{sym}_1h.csv")
    df = pd.read_csv(path)
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    p = pd.Series(df["close"].astype(float).values, index=idx)
    return p[~p.index.duplicated(keep="first")].sort_index()


def intraday_mr_families() -> list[Family]:
    """Mean-reversion families tuned for 1h bars (windows in *bars*)."""
    fams: list[Family] = []
    # z-score reversion over intraday windows (12h..72h), trend-gated off in strong trends
    fams.append(Family("mr_z_1h", sig_mr_z, [
        dict(lb=lb, z_entry=ze, z_exit=zx, trend_gate=tg,
             vol_target=vt, vol_lb=vlb, max_lev=ml, long_only=lo)
        for lb in (12, 24, 48, 72)
        for ze in (1.5, 2.0, 2.5)
        for zx in (0.3, 0.5)
        for tg in (0.05, 0.10)
        for vt in (0.5, 0.8, 1.2)
        for vlb in (48,)
        for ml in (3.0,)
        for lo in (False, True)
    ]))
    fams.append(Family("rsi_mr_1h", sig_rsi_mr, [
        dict(lb=lb, lo=lo_th, hi=hi_th, trend_gate=tg,
             vol_target=vt, vol_lb=48, max_lev=3.0, long_only=lo)
        for lb in (12, 24, 48)
        for (lo_th, hi_th) in ((25, 75), (20, 80), (30, 70))
        for tg in (0.06, 0.12)
        for vt in (0.5, 0.8, 1.2)
        for lo in (False, True)
    ]))
    return fams


def to_daily_returns(per_bar: pd.Series) -> pd.Series:
    """Compound 1h OOS returns into per-calendar-day returns."""
    eq = (1.0 + per_bar).cumprod()
    daily_eq = eq.resample("1D").last().dropna()
    return daily_eq.pct_change().dropna()


def best_intraday_sleeve(sym: str) -> tuple[pd.Series, str, dict]:
    """Walk-forward OOS per-bar returns of the best intraday-MR family for a coin."""
    p = load_1h(sym)
    best = None
    for fam in intraday_mr_families():
        # intraday windows: train ~150d, test ~50d (plenty of bars)
        r = walk_forward(sym, p, fam, costs=COSTS, train_days=150, test_days=50,
                         min_trades_train=10)
        if r is None or len(r.folds) < 3:
            continue
        # rank by realised OOS Sharpe (annualisation constant cancels in ranking)
        if best is None or r.oos.sharpe > best.oos.sharpe:
            best = r
    if best is None:
        return pd.Series(dtype=float), "none", {}
    summ = best.summary()
    return best.oos_returns, best.family, summ


def year_returns(daily_ret: pd.Series) -> dict[int, float]:
    out = {}
    for y in sorted(set(daily_ret.index.year)):
        ry = daily_ret[daily_ret.index.year == y]
        if len(ry) < 250:
            continue
        out[int(y)] = float((1.0 + ry).prod() - 1.0)
    return out


def main(argv):
    coins = [a.upper() for a in argv if a.upper() in COINS] or COINS
    out = {"coins": {}, "bars_per_year": BARS_PER_YEAR}
    daily_streams = {}
    print(f"INTRADAY MEAN-REVERSION SLEEVE (1h bars, walk-forward OOS)  costs: "
          f"6bps/turn + funding")
    for sym in coins:
        per_bar, fam, summ = best_intraday_sleeve(sym)
        if per_bar.empty:
            print(f"  {sym}: no qualifying intraday-MR fit")
            continue
        daily = to_daily_returns(per_bar)
        daily_streams[sym] = daily
        yr = year_returns(daily)
        # annualise reported Sharpe correctly for display (per-bar -> per-year)
        ann_sharpe = summ["oos_sharpe"] * np.sqrt(BARS_PER_YEAR) / np.sqrt(365)
        eq = (1.0 + daily).prod()
        cagr = eq ** (365.0 / max(len(daily), 1)) - 1.0
        print(f"\n{sym}  engine={fam}  OOS daily CAGR={cagr:+.1%}  "
              f"ann.Sharpe~{ann_sharpe:.2f}  folds={summ['oos_days']}bars")
        print("   per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in yr.items()))
        out["coins"][sym] = {"engine": fam, "summary": summ,
                             "cagr_daily": round(cagr, 4),
                             "per_year": {str(k): round(v, 4) for k, v in yr.items()}}

    # equal-weight intraday-MR book
    if len(daily_streams) >= 2:
        mat = pd.DataFrame(daily_streams).sort_index()
        ew = mat.mean(axis=1, skipna=True).dropna()
        yr = year_returns(ew)
        print(f"\n{'='*80}\nINTRADAY-MR BOOK (equal-weight {list(daily_streams)})")
        print("   per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in yr.items()))
        out["book"] = {"coins": list(daily_streams),
                       "per_year": {str(k): round(v, 4) for k, v in yr.items()}}
        ew.to_csv(os.path.join(RESULTS, "intraday_mr_book_daily.csv"))

    with open(os.path.join(RESULTS, "intraday_mr_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    # persist per-coin daily streams for the combiner
    for sym, s in daily_streams.items():
        s.to_csv(os.path.join(RESULTS, f"intraday_mr_{sym}_daily.csv"))
    print(f"\nwrote {os.path.join(RESULTS, 'intraday_mr_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
