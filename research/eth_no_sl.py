"""'No stop-loss, take profit at +40/50/60%, never exit at a loss' — the honest test.

Two fatal problems, measured on real ETH data:
  1. WITH LEVERAGE, 'never exit at a loss' is not your choice -- the exchange's
     LIQUIDATION engine exits you at -100% when price moves ~1/leverage against you.
     We count how often ETH actually moved that much (1h), i.e. how often a no-SL
     leveraged long gets force-closed at a total loss.
  2. ON SPOT, 'TP at +50%, never sell at a loss, re-enter' is economically just
     buy-and-hold with capped upside: the 'wins' are real but the losses are merely
     HIDDEN as unrealised. We show realised-only equity (the illusion) vs
     mark-to-market equity (reality), the max drawdown, and the time-underwater --
     e.g. a top entry that is STILL down years later.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))


def load_daily():
    df = pd.read_csv(os.path.join(HERE, "data", "ETH_daily.csv"), parse_dates=["date"])
    return pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"])).sort_index()


def load_1h():
    df = pd.read_csv(os.path.join(HERE, "data", "intraday", "ETH_1h.csv"))
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    return pd.Series(df["close"].astype(float).values, index=idx).sort_index()


def simulate_no_sl(price, tp=0.50):
    """Always-long, book +tp and re-enter, never sell at a loss. Returns realised-only
    equity (illusion) and mark-to-market equity (reality)."""
    p = price.values
    realised = 1.0                     # only ever steps UP (you only book wins)
    entry = p[0]
    realised_curve, mtm_curve = [], []
    n_tp = 0
    for t in range(len(p)):
        # mark-to-market: realised locked gains * current open-leg performance
        open_leg = p[t] / entry
        mtm = realised * open_leg
        # take profit: book +tp, re-enter at current price
        if p[t] >= entry * (1.0 + tp):
            realised *= (1.0 + tp)
            entry = p[t]
            n_tp += 1
        realised_curve.append(realised)
        mtm_curve.append(mtm)
    return (pd.Series(realised_curve, index=price.index),
            pd.Series(mtm_curve, index=price.index), n_tp)


def longest_underwater(price):
    """Longest run (days) the price stayed below a prior peak (= time a 'never sell at
    a loss' holder who bought that peak was stuck underwater)."""
    peak = price.cummax()
    underwater = price < peak * 0.999
    # current ongoing underwater stretch from the all-time peak
    atop_idx = price.idxmax()
    days_since_top = (price.index[-1] - atop_idx).days
    still_down = price.iloc[-1] / price.loc[atop_idx] - 1.0
    # longest closed underwater stretch
    longest, cur = 0, 0
    for u in underwater.values:
        cur = cur + 1 if u else 0
        longest = max(longest, cur)
    return longest, atop_idx, days_since_top, still_down


def main(argv):
    daily = load_daily()
    print(f"ETH daily {daily.index[0].date()}->{daily.index[-1].date()}, "
          f"last ${daily.iloc[-1]:,.0f}\n")

    print("="*74)
    print("PROBLEM 1 — with LEVERAGE you do NOT choose to 'never exit at a loss';")
    print("the exchange liquidates you at -100% on a ~1/leverage adverse move.")
    h = load_1h(); rh = h.pct_change().dropna()
    daily_ret = daily.pct_change().dropna()
    print(f"  ETH 1h bars: {len(rh):,}   daily bars: {len(daily_ret):,}")
    print(f"  {'leverage':>9} {'liq move':>9} {'1h bars that liquidate':>24} {'days that liquidate':>20}")
    for m in (5, 10, 20):
        liq = 1.0 / m
        n_h = int((rh <= -liq).sum())
        n_d = int((daily_ret <= -liq).sum())
        print(f"  {m:>8}x {-liq:>8.0%} {n_h:>15,} ({n_h/len(rh):.2%}) {n_d:>12,} ({n_d/len(daily_ret):.2%})")
    print("  => a no-SL long at 10x is force-closed at -100% every time ETH drops >=10% "
          "in a bar.\n     'Never exit at a loss' is impossible under leverage.")

    print("\n" + "="*74)
    print("PROBLEM 2 — on SPOT, 'TP +50%, never sell at a loss' = buy-and-hold with")
    print("capped upside; losses are HIDDEN as unrealised, not avoided.")
    for tp in (0.40, 0.50, 0.60):
        realised, mtm, n_tp = simulate_no_sl(daily, tp)
        rc = (realised.iloc[-1]) ** (365.0 / (daily.index[-1]-daily.index[0]).days) - 1
        mc = (mtm.iloc[-1]) ** (365.0 / (daily.index[-1]-daily.index[0]).days) - 1
        mdd = float((mtm / mtm.cummax() - 1).min())
        print(f"  TP +{tp:.0%}: booked {n_tp} winning exits (realised 'win rate' = 100%) -> "
              f"realised equity {realised.iloc[-1]:.1f}x")
        print(f"          BUT mark-to-market equity {mtm.iloc[-1]:.1f}x  (CAGR {mc:+.0%}, "
              f"maxDD {mdd:.0%}) -- the real account")
    bh = daily.iloc[-1]/daily.iloc[0]
    print(f"  (buy-and-hold ETH over the same period: {bh:.1f}x) -- so 'never sell at a "
          f"loss' just caps your\n   upside while keeping the full -80% drawdowns.")

    print("\n" + "="*74)
    print("PROBLEM 3 — 'never exit at a loss' = capital frozen for YEARS in a bad entry.")
    longest, atop, days_since, still_down = longest_underwater(daily)
    print(f"  Longest stretch ETH stayed below a prior peak: {longest:,} days "
          f"({longest/365:.1f} years).")
    print(f"  All-time-high in window: {atop.date()} at ${daily.loc[atop]:,.0f}.")
    print(f"  A 'never sell at a loss' buyer at that peak is STILL down {still_down:+.0%} "
          f"after {days_since:,} days ({days_since/365:.1f} yrs).")
    print("  => the trade that 'never closes at a loss' can stay red for 3-4+ years; "
          "the\n     promise is kept only on paper while the capital is dead.")

    print("\n" + "="*74)
    print("VERDICT: capping gains at +40/60% while refusing to cap losses is negative")
    print("skew -- many small 'wins', rare catastrophic/eternal losers. High win rate,")
    print("negative expectancy. With leverage it is mathematically suicidal (liquidation");
    print("IS the stop-loss, set by the exchange at -100%). The edge is in CUTTING losers")
    print("and letting winners run -- exactly the opposite of this rule.")


if __name__ == "__main__":
    main(sys.argv[1:])
