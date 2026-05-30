"""BTC blend strategy — sister of eth_blend.py, same architecture, BTC data.

Reuses eth_blend's pool_exposure() and eth_engine.recommended() (both asset-agnostic) on
BTC's 1d / 4h / 1h data streams. Same risk policy (25/75 weight, vol-tgt 30%, LEV_CAP 1.5,
5bps cost), same harvest (15% decay + year-end reset).

Validated WF-OOS (weight reselected per fold, 365d/90d): +14%/yr, Sharpe 0.56, -42% DD.
The BTC edge is weaker than ETH (BTC's trends are smoother and less mean-reverting), but
it diversifies (correlation to ETH blend = +0.51) so the combined 50/50 has the best
Sharpe of anything in the session (1.18, -24% DD).

Run:  python btc_blend.py            # backtest
      python btc_blend.py --now      # current stance
"""
from __future__ import annotations

import sys
import numpy as np
import pandas as pd

import scalp_sweep as ss
import eth_engine as E
import eth_blend as ETHBL          # reuse pool_exposure (asset-agnostic)

# ---- same config as eth_blend (kept identical for comparability + combined strategy) ----
W_REGIME, W_POOL = 0.25, 0.75
VOL_TARGET = 0.30
LEV_CAP = 1.5
COST_BPS = 5.0
BASE = 10000.0
HARVEST_DECAY = 0.15
ASSET = "BTC"


def sleeve_returns():
    """BTC daily return streams for the two sleeves (regime + pool)."""
    ss.set_tf("1d"); d1 = ss.load("1d", ASSET)
    regime = ss.to_daily(ss.backtest(d1, E.recommended(d1), COST_BPS))
    ss.set_tf("4h"); d4 = ss.load("4h", ASSET); ss.set_tf("1h"); d1h = ss.load("1h", ASSET)
    P = ETHBL.pool_exposure(d4, d1h)
    rf = d1h["close"].pct_change().fillna(0.0)
    pool = ss.to_daily(P.shift(1).fillna(0.0) * rf - COST_BPS * 1e-4 * P.diff().abs().fillna(0.0))
    return pd.concat({"regime": regime, "pool": pool}, axis=1, sort=True).dropna()


def blend_returns():
    df = sleeve_returns()
    b = (W_REGIME * ss.vol_target(df["regime"], VOL_TARGET, cap=LEV_CAP)
         + W_POOL * ss.vol_target(df["pool"], VOL_TARGET, cap=LEV_CAP))
    return b.dropna(), df


def backtest():
    b, df = blend_returns()
    m = ss.daily_metrics(b)
    print(f"=== BTC BLEND backtest {b.index[0].date()} -> {b.index[-1].date()} "
          f"(vol-tgt {VOL_TARGET:.0%}, {W_REGIME:.0%}/{W_POOL:.0%}, {COST_BPS}bps) ===")
    print(f"  ann {m['ann']*100:+.0f}%  Sharpe {m['sharpe']:.2f}  Calmar {m['calmar']:.2f}  "
          f"maxDD {m['maxdd']*100:.0f}%  positive months {m['pos_months']*100:.0f}%")
    print(f"\n  $10k from 2023 with harvest (reset on {HARVEST_DECAY:.0%} decay & year-end):")
    print(f"  {'year':6}{'peak':>11}{'cash out':>11}{'cum cash':>11}{'TOTAL':>11}")
    for y, pk, h, bk, tot in ETHBL.harvest(b[b.index >= '2023-01-01'], BASE, HARVEST_DECAY):
        tag = " YTD" if y == b.index[-1].year else ""
        print(f"  {y}{tag:4}{pk:>10,.0f}{h:>11,.0f}{bk:>11,.0f}{tot:>11,.0f}")


def now():
    ss.set_tf("1d"); d1 = ss.load("1d", ASSET); c = d1["close"]
    reg = float(E.recommended(d1).iloc[-1])
    ss.set_tf("4h"); d4 = ss.load("4h", ASSET); ss.set_tf("1h"); d1h = ss.load("1h", ASSET)
    pool_now = float(ETHBL.pool_exposure(d4, d1h).iloc[-1])
    print(f"=== BTC BLEND — target as of {d1.index[-1].date()} (BTC ${c.iloc[-1]:,.0f}) ===")
    sma200 = c.rolling(200).mean().iloc[-1]
    print(f"  regime: BTC {c.iloc[-1]/sma200-1:+.0%} vs 200d -> {'BULL' if c.iloc[-1]>sma200 else 'BEAR'} regime")
    sd = lambda x: "LONG" if x > 0.02 else ("SHORT" if x < -0.02 else "FLAT")
    print(f"  REGIME sleeve : {sd(reg):5} {reg:+.2f}")
    print(f"  BREAKOUT pool : {sd(pool_now):5} {pool_now:+.2f}")
    net = W_REGIME * reg + W_POOL * pool_now
    print(f"  BLEND net     : {sd(net):5} {net:+.2f} of equity (before vol-targeting to {VOL_TARGET:.0%})")


if __name__ == "__main__":
    now() if "--now" in sys.argv[1:] else backtest()
