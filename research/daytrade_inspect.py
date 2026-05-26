"""Per-year inspection of the headline day-trade configs (single config, no sweep).

Sanity-checks the survivor from the leaderboard: does its win rate / profitability
hold across regimes (2022 bear, 2025 selloff), and do individual trades look
lookahead-free and sane?
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from daytrade_winrate import (COST_BPS_PER_SIDE, SIGNALS, bracket_backtest,
                              load_1h, resample, trade_metrics)

CONFIGS = [
    ("BTC", "1h", "trend_pullback",
     dict(slow=50, rsi_lb=7, dip=35, long_only=True, tp=0.03, sl=0.03, max_hold=48)),
    ("BTC", "1h", "trend_pullback",
     dict(slow=200, rsi_lb=14, dip=40, long_only=True, tp=0.03, sl=0.03, max_hold=24)),
    ("ETH", "8h", "trend_pullback",
     dict(slow=100, rsi_lb=7, dip=40, long_only=True, tp=0.03, sl=0.015, max_hold=9)),
]


def run(sym, tf, fam, p):
    df = resample(load_1h(sym), tf)
    o = df["open"].to_numpy(); h = df["high"].to_numpy()
    lo = df["low"].to_numpy(); c = df["close"].to_numpy()
    sig = SIGNALS[fam](o, h, lo, c, p)
    trades = bracket_backtest(df, sig, p["tp"], p["sl"], p["max_hold"],
                              COST_BPS_PER_SIDE, None)
    m = trade_metrics(trades)
    # per-year
    idx = df.index
    rows = {}
    for t in trades:
        y = idx[t.entry_i].year
        rows.setdefault(y, []).append(t.ret_net)
    print(f"\n=== {sym} {tf} {fam}  {p}")
    print(f"  FULL: n={m['n']} win={m['win_rate']:.1%} net={m['net_total']:+.1%} "
          f"PF={m['profit_factor']:.2f} exp={m['expectancy']:+.3%} DD={m['max_dd']:+.1%}")
    print(f"  per-year:")
    for y in sorted(rows):
        r = np.array(rows[y])
        comp = float(np.prod(1 + r) - 1)
        print(f"     {y}: n={len(r):>3} win={ (r>0).mean():>5.1%} "
              f"net={comp:>+7.1%} exp={r.mean():>+.3%}")
    # show first 3 trades to verify entry=next-open, exit logic
    print(f"  sample trades (first 3):")
    for t in trades[:3]:
        print(f"     {idx[t.entry_i]} side={t.side:+d} entry={t.entry_px:.2f} "
              f"-> {idx[t.exit_i]} exit={t.exit_px:.2f} [{t.reason}] "
              f"ret_net={t.ret_net:+.3%}")


if __name__ == "__main__":
    for cfg in CONFIGS:
        run(*cfg)
