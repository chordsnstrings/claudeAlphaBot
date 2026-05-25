"""Does higher-frequency (1h) trading beat the daily ETH engine? Walk-forward OOS.

Tests intraday trend/breakout families on ETH 1h bars (Binance Vision), to check
whether a higher-frequency ETH futures bot improves CAGR / monthly +20% hit-rate
over the daily tsmom_blend (OOS CAGR ~56%, Sharpe ~1.2). Reuses the validated
walk-forward (Sharpe ranking is invariant to the bars/year constant); per-bar
returns + turnover costs compound correctly. Costs 6 bps/turn + per-bar funding.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

from engine import Costs, ema
from strategies import Family, sig_tsmom_blend, sig_trend_flat, sig_donchian, build_weights
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
INTRADAY_DIR = os.path.join(HERE, "data", "intraday")
COSTS = Costs(txn=0.0006, funding_daily=0.00005 / 24.0)


def load_1h() -> pd.Series:
    df = pd.read_csv(os.path.join(INTRADAY_DIR, "ETH_1h.csv"))
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    p = pd.Series(df["close"].astype(float).values, index=idx)
    return p[~p.index.duplicated(keep="first")].sort_index()


def fams():
    # lookbacks in BARS (hours): 1d..21d trend horizons
    return [
        Family("tsmom_blend_1h", sig_tsmom_blend, [
            dict(lbs=lbs, vol_target=vt, vol_lb=48, max_lev=3.0, long_only=lo)
            for lbs in ((24, 72, 168, 336), (12, 48, 120, 240), (48, 168, 336, 504))
            for vt in (0.4, 0.6, 0.9)
            for lo in (True, False)
        ]),
        Family("trend_flat_1h", sig_trend_flat, [
            dict(fast=f, slow=s, band=b, vol_target=vt, vol_lb=48, max_lev=3.0, long_only=lo)
            for (f, s) in ((48, 240), (72, 336), (24, 168))
            for b in (0.0, 0.01)
            for vt in (0.4, 0.6, 0.9)
            for lo in (True, False)
        ]),
        Family("donchian_1h", sig_donchian, [
            dict(entry=n, exit=m, vol_target=vt, vol_lb=48, max_lev=3.0, long_only=lo)
            for (n, m) in ((168, 72), (336, 120), (72, 48))
            for vt in (0.4, 0.6, 0.9)
            for lo in (True, False)
        ]),
    ]


def monthly_from_bars(per_bar: pd.Series, m: float = 1.0) -> pd.Series:
    eq = (1.0 + m * per_bar).cumprod()
    me = eq.resample("1ME").last().dropna()
    return me.pct_change().dropna()


def main(argv):
    p = load_1h()
    print(f"ETH 1h: {len(p)} bars {p.index[0]} -> {p.index[-1]}\n")
    best = None
    for fam in fams():
        r = walk_forward("ETH", p, fam, costs=COSTS, train_days=150, test_days=50,
                         min_trades_train=8)
        if r is None or len(r.folds) < 4:
            continue
        # annualise Sharpe correctly for display (1h -> yr)
        ann_sharpe = r.oos.sharpe * np.sqrt(365 * 24) / np.sqrt(365)
        per_bar = r.oos_returns
        eq = (1.0 + per_bar).cumprod()
        days = (per_bar.index[-1] - per_bar.index[0]).days
        cagr = float(eq.iloc[-1]) ** (365.0 / max(days, 1)) - 1.0
        mr = monthly_from_bars(per_bar)
        print(f"{fam.name:18} OOS CAGR={cagr:+.0%}  ann.Sharpe~{ann_sharpe:.2f}  "
              f"maxDD={r.oos.max_dd:.0%}  %mo>=20%={float((mr>=0.20).mean()):.0%}  "
              f"medMo={float(mr.median()):+.0%}")
        if best is None or ann_sharpe > best[0]:
            best = (ann_sharpe, fam.name, cagr, mr)
    if best:
        _, name, cagr, mr = best
        print(f"\nBEST intraday: {name}  CAGR={cagr:+.0%}  "
              f"%months>=20%={float((mr>=0.20).mean()):.0%}  median month={float(mr.median()):+.0%}")
        print("Compare daily tsmom_blend: OOS CAGR ~+56%, Sharpe ~1.2, ~22% months >=20%, median 0%.")


if __name__ == "__main__":
    main(sys.argv[1:])
