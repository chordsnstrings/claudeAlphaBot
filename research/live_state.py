"""LIVE STATE — what the unified bot signals on the latest available bar.

Computes, as of the most recent data, the concrete action of each sleeve:
  CORE  (daily momentum book)  : today's target weights per coin + why (trend sign).
  BTC1H (1H pullback)          : is the long trigger armed? (close>SMA50 & ADX>=30 & RSI(7)<=35)
  ETH8H (8H pullback)          : is the long trigger armed? (close>SMA50 & ADX>=20 & RSI(7)<=45)
  SPINE (L/S trend)            : current net long/short tilt + top positions.
Run: python live_state.py
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import all_weather as aw
import production_strategy as ps
from daytrade_strategies2 import adx, resample_tf
from daytrade_winrate import load_1h, rsi, sma
from strategies import sig_tsmom_blend

pd.set_option("display.width", 120)


def core_state():
    panel = ps.load_panel()
    book = ps.book_weights(panel)
    today = book.index[-1]
    w = book.loc[today]
    print(f"=== CORE — daily momentum book (as of {today.date()}) ===")
    print(f"  {'coin':>5} {'price':>12} {'vsSMA50':>8} {'vsSMA200':>9} {'trendSig':>9} {'weight':>8}")
    for c in ps.COINS:
        p = panel[c].dropna()
        px = p.iloc[-1]
        s50 = p.rolling(50).mean().iloc[-1]; s200 = p.rolling(200).mean().iloc[-1]
        trend = sig_tsmom_blend(p, {"lbs": ps.TREND_LBS[c]}).iloc[-1]   # in [-1,1]
        print(f"  {c:>5} {px:>12,.4f} {px/s50-1:>+7.0%} {px/s200-1:>+8.0%} {trend:>+9.2f} {w[c]:>7.0%}")
    gross = float(w.abs().sum())
    print(f"  -> book gross exposure {gross:.0%} of capital "
          f"({'mostly FLAT / cash' if gross < 0.15 else 'engaged'}).")
    return gross


def intraday_state(coin, tf, slow, dip, adx_thr):
    df = load_1h(coin) if tf == "1h" else resample_tf(load_1h(coin), tf)
    h, l, c = df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()
    ma = sma(c, slow); r = rsi(c, 7); ax = adx(h, l, c, 14)
    px, mav, rv, axv = c[-1], ma[-1], r[-1], ax[-1]
    up = px > mav; dip_ok = rv <= dip; strong = axv >= adx_thr
    armed = up and dip_ok and strong
    print(f"\n=== {coin}{('-'+tf).upper()} pullback (as of {df.index[-1]}) ===")
    print(f"  price {px:,.2f} | SMA{slow} {mav:,.2f} -> {'UPTREND' if up else 'DOWNtrend (no longs)'} "
          f"({px/mav-1:+.1%})")
    print(f"  RSI(7) {rv:.0f} (need <= {dip} for a dip: {'YES' if dip_ok else 'no'}) | "
          f"ADX(14) {axv:.0f} (need >= {adx_thr} for strong trend: {'YES' if strong else 'no'})")
    print(f"  -> ACTION: {'LONG (enter next bar open)' if armed else 'FLAT / no trade'}")
    return armed


def spine_state():
    px, vol = aw.load_panel()
    lbs = (10, 30, 60, 120)
    sig = aw.ts_signal(px, lbs)
    iv = 1.0 / aw.realized_vol(px, 30).clip(lower=0.20)
    dv = vol.rolling(30, min_periods=10).mean()
    i = -1
    last = px.index[i]
    valid = px.iloc[i].notna() & sig.iloc[i].notna() & dv.iloc[i].notna() & iv.iloc[i].notna()
    cols = px.columns[valid]
    dvv = dv.iloc[i][cols]
    univ = dvv.sort_values(ascending=False).index[:aw.TOP_LIQ]      # top-30 by $vol
    raw = (sig.iloc[i][univ] * iv.iloc[i][univ])
    g = raw.abs().sum()
    w = (raw / g) if g > 0 else raw * 0.0
    net, gross = float(w.sum()), float(w.abs().sum())
    print(f"\n=== SPINE — all-weather L/S trend (as of {last.date()}, cached universe) ===")
    print(f"  net exposure {net:+.0%} of gross, gross {gross:.0%} "
          f"-> {'NET SHORT (defensive / earning the downtrend)' if net < -0.05 else ('NET LONG' if net > 0.05 else 'NEAR-FLAT / chop')}")
    longs = w[w > 0].sort_values(ascending=False).head(4)
    shorts = w[w < 0].sort_values().head(4)
    print("  top longs:  " + ", ".join(f"{k} {v:+.0%}" for k, v in longs.items()))
    print("  top shorts: " + ", ".join(f"{k} {v:+.0%}" for k, v in shorts.items()))
    return net


def main():
    print("UNIFIED BOT — LIVE STATE (what it would trade right now)\n")
    g = core_state()
    b = intraday_state("BTC", "1h", 50, 35, 30)
    e = intraday_state("ETH", "8h", 50, 45, 20)
    s = spine_state()
    print("\n=== NET STANCE ===")
    longs = ("CORE" if g > 0.15 else "") + (" BTC1H" if b else "") + (" ETH8H" if e else "")
    print(f"  long sleeves armed: {longs.strip() or 'NONE'}; "
          f"SPINE {'short (hedge)' if s < -0.05 else 'flat/long'}.")
    print("  Read the percentages above as the target book; in a downtrend the long-only "
          "sleeves sit in cash and only the SPINE is active (short).")


if __name__ == "__main__":
    main()
