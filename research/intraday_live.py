"""Faithful intraday position runner — makes the live BTC1H / ETH8H sleeves hold the SAME
position the tested system would, on the proper 1H/8H clock (not the daily-bar proxy).

`position_now(coin, tf)` returns the current signed sleeve position in {-1, 0, +1} by:
  1. selecting params on the most-recent train window with the SAME rule the backtest's
     walk-forward uses (max net expectancy, >= 15 train trades) -> the params the tested
     system would run now; and
  2. running the SAME `bracket_ext` over recent bars and reading whether the last trade is
     still OPEN — i.e. forced to close only by the data edge (held < max_hold and not a
     TP/SL hit), which is exactly a live open position.

Reuses the backtest's own functions (`STRATS`, `bracket_ext`, grids, `bracket` rules), so
it is faithful by construction. Signals on spot 1H (matches the backtest's data); the
execution venue is futures (handled by the caller).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from daytrade_strategies2 import (STRATS, _entry_grid, _exit_grid, bracket_ext,
                                  resample_tf)
from daytrade_winrate import atr, load_1h, trade_metrics

BPD = {"1h": 24, "4h": 6, "8h": 3}
MIN_TRAIN_TRADES = 15


def _arrays(df: pd.DataFrame) -> dict:
    return {"o": df["open"].to_numpy(), "h": df["high"].to_numpy(),
            "l": df["low"].to_numpy(), "c": df["close"].to_numpy(),
            "v": df["volume"].to_numpy(), "idx": df.index, "pc": None}


def _frame(coin: str, tf: str) -> pd.DataFrame:
    d = load_1h(coin)
    return d if tf == "1h" else resample_tf(d, tf)


def select_params(coin: str, tf: str, strat="regime_pullback", train_days=365):
    """Same selection the walk-forward uses, applied to the most-recent train window:
    max net expectancy over the (entry × exit) grid with a >= 15-trade floor."""
    sigfn = STRATS[strat][0]
    df = _frame(coin, tf)
    tb = train_days * BPD[tf]
    tr = df.iloc[-tb:] if len(df) > tb else df
    A = _arrays(tr)
    atr_tr = atr(A["h"], A["l"], A["c"], 14)
    best = None
    for ep in _entry_grid(strat, tf):
        sig = sigfn(A, ep)
        for xp in _exit_grid(tf):
            m = trade_metrics(bracket_ext(tr, sig, xp, atr_tr))
            if m["n"] < MIN_TRAIN_TRADES:
                continue
            if best is None or m["expectancy"] > best[0]:
                best = (m["expectancy"], ep, xp)
    return (best[1], best[2]) if best else (None, None)


def position_now(coin: str, tf: str, strat="regime_pullback", lookback_days=240):
    """Current signed sleeve position in {-1,0,+1}, plus the (entry,exit) params used."""
    ep, xp = select_params(coin, tf, strat)
    if ep is None:
        return 0, None, None
    df = _frame(coin, tf)
    lb = lookback_days * BPD[tf]
    df = df.iloc[-lb:] if len(df) > lb else df
    A = _arrays(df)
    sig = STRATS[strat][0](A, ep)
    trades = bracket_ext(df, sig, xp, atr(A["h"], A["l"], A["c"], 14))
    if not trades:
        return 0, ep, xp
    t = trades[-1]
    n = len(df)
    held = t.exit_i - t.entry_i
    # OPEN iff the last trade was force-closed by the data edge (not a genuine TP/SL/time)
    open_now = (t.exit_i == n - 1 and held < xp["max_hold"] and t.reason not in ("tp", "sl"))
    return (int(t.side) if open_now else 0), ep, xp


def _selftest(coin="BTC", tf="1h"):
    """Replay consistency: position_now is derived from the same bracket_ext trade list,
    so its open/flat state must agree with bracket_ext's last-trade status."""
    side, ep, xp = position_now(coin, tf)
    df = _frame(coin, tf)
    A = _arrays(df.iloc[-(240 * BPD[tf]):])
    sig = STRATS["regime_pullback"][0](A, ep)
    trades = bracket_ext(df.iloc[-(240 * BPD[tf]):], sig, xp, atr(A["h"], A["l"], A["c"], 14))
    last = trades[-1] if trades else None
    print(f"{coin}-{tf}: position={side:+d}  params(entry={ep}, exit={xp})  "
          f"last_trade=({last.reason if last else None}, "
          f"held={last.exit_i-last.entry_i if last else None}/{xp['max_hold']})")


if __name__ == "__main__":
    _selftest("BTC", "1h")
    _selftest("ETH", "8h")
