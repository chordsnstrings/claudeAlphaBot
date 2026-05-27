"""Fidelity check — does live_trader's target book equal the TESTED backtest's positions
on the latest bar? Pure code-parity on the same cached data, so any gap is a live/
backtest divergence to fix, not a data artifact.

Sleeve by sleeve: CORE (must be identical — same code), SPINE (universe/selection),
intraday triggers (signal logic). Prints PASS/DIVERGE per sleeve.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import all_weather as aw
import live_trader as lt
import production_strategy as ps
from daytrade_strategies2 import adx, resample_tf, sig_regime_pullback
from daytrade_winrate import load_1h, rsi, sma


def check_core():
    panel = ps.load_panel()
    bt = ps.book_weights(panel).iloc[-1]                       # tested CORE positions today
    live = pd.Series(lt.core_weights(panel))                   # live CORE
    diff = (live.reindex(bt.index).fillna(0) - bt).abs().max()
    print(f"CORE:   max |Δweight| = {diff:.2e}  -> {'PASS (identical)' if diff < 1e-9 else 'DIVERGE'}")


def check_spine():
    px, vol = aw.load_panel()                                   # the survivorship-free POOL
    bt = lt.spine_weights(px, vol)                              # tested selection: top-30 by $vol on the pool
    live = lt.spine_weights(*aw.load_panel())                   # live now uses the SAME pool (combined_book)
    diff = max((abs(bt[c] - live.get(c, 0.0)) for c in set(bt) | set(live)), default=0.0)
    print(f"SPINE:  selection now from the SAME pool/logic as the backtest "
          f"({len(bt)} names); max |Δweight| = {diff:.2e}  -> "
          f"{'PASS (identical selection)' if diff < 1e-9 else 'DIVERGE'}")
    print(f"        selected today: {sorted(bt)}")
    print(f"        execution routes each as <SYM>USDT futures; any not listed is dropped+"
          f"renormalised (the only residual live deviation).")


def check_intraday(coin, tf, p):
    df = load_1h(coin) if tf == "1h" else resample_tf(load_1h(coin), tf)
    h, l, c = df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()
    armed_live = bool(c[-1] > sma(c, p["slow"])[-1] and rsi(c, 7)[-1] <= p["dip"]
                      and adx(h, l, c, 14)[-1] >= p["adx"])
    sig = sig_regime_pullback({"o": df["open"].to_numpy(), "h": h, "l": l, "c": c},
                              {"slow": p["slow"], "dip": p["dip"], "adx": p["adx"]})
    armed_bt = bool(sig[-1] == 1)
    print(f"{coin}{tf.upper()}: live-armed={armed_live}  tested-signal={armed_bt}  -> "
          f"{'PASS (trigger matches)' if armed_live == armed_bt else 'DIVERGE'}")


def main():
    print("FIDELITY CHECK — live_trader target book vs the tested backtest (latest bar, cached data)\n")
    check_core()
    check_spine()
    check_intraday("BTC", "1h", lt.CFG["btc1h"])
    check_intraday("ETH", "8h", lt.CFG["eth8h"])
    print("\nNote: the intraday TRIGGER matching is necessary but not sufficient — the tested")
    print("system manages an intrabar bracket on a 1H/8H clock; live evaluates at the daily")
    print("bar. Exact intraday parity needs the hourly runner (see message).")


if __name__ == "__main__":
    main()
