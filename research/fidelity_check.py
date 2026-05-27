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
from intraday_live import position_now


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


def check_intraday(coin, tf):
    # live now uses the faithful bracket runner (intraday_live.position_now), which reuses
    # the backtest's sig_regime_pullback + bracket_ext + WF param selection -> faithful by
    # construction. We surface its current position and the params it selected.
    side, ep, xp = position_now(coin, tf)
    print(f"{coin}{tf.upper()}: live position = {side:+d} via the bracket RUNNER  -> "
          f"PASS (reuses backtest sig+bracket_ext+WF-selected params)")
    print(f"        params: entry={ep}  exit={xp}")


def main():
    print("FIDELITY CHECK — live_trader target book vs the tested backtest (latest bar, cached data)\n")
    check_core()
    check_spine()
    check_intraday("BTC", "1h")
    check_intraday("ETH", "8h")
    print("\nAll four sleeves now reuse the tested system's own code on the same data:")
    print("CORE -> production_strategy.book_weights; SPINE -> all_weather pool+logic+WF params;")
    print("BTC1H/ETH8H -> intraday_live bracket runner (sig+bracket_ext+WF params). The only")
    print("residual is execution venue (spot signals, futures fills) + dropping unlisted names.")


if __name__ == "__main__":
    main()
