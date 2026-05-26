"""The win-rate trap, demonstrated: win rate vs expectancy as you vary TP:SL.

A day trader chasing "highest win rate" needs to internalise one mechanical fact:
**win rate is almost a free dial.** Hold the entry rule fixed and only change the
take-profit / stop-loss geometry, and the hit rate moves wherever you point it — a
tight TP with a wide SL wins the large majority of trades. What does NOT move with
it is *expectancy after costs*: the rare wide-SL loss pays for all the small wins.

This isolates that effect. One fixed, canonical day-trade entry (buy the 1H dip:
RSI(14) < 30, the textbook oversold trigger), identical on both coins and over the
whole sample, with ONLY the TP:SL geometry swept. We tabulate win rate beside net
return, profit factor and expectancy so the trade-off is unambiguous.

Same lookahead-free, conservative-fill engine as daytrade_winrate.py.
"""
from __future__ import annotations

import numpy as np

from daytrade_winrate import (COST_BPS_PER_SIDE, bracket_backtest, load_1h, rsi,
                              trade_metrics)


def fixed_dip_signal(close: np.ndarray) -> np.ndarray:
    r = rsi(close, 14)
    s = np.zeros(len(close), dtype=int)
    s[r < 30] = 1                     # canonical oversold dip-buy, long-only
    return s


def main():
    # TP, SL in %; ordered from tight-TP/wide-SL (high hit rate) to the reverse.
    combos = [
        (0.005, 0.030), (0.005, 0.020), (0.005, 0.010),
        (0.010, 0.030), (0.010, 0.020), (0.010, 0.010),
        (0.020, 0.020), (0.020, 0.010), (0.030, 0.030),
        (0.030, 0.010), (0.040, 0.010),
    ]
    max_hold = 24                     # 1 day on 1H bars
    print(f"WIN-RATE-vs-EXPECTANCY TRAP  (1H, entry=RSI14<30 dip-buy long, "
          f"hold<={max_hold}b, cost={COST_BPS_PER_SIDE}bps/side, full sample)\n"
          f"  Win rate rises as TP shrinks / SL widens — but watch net & PF.\n")
    for sym in ("BTC", "ETH"):
        df = load_1h(sym)
        sig = fixed_dip_signal(df["close"].to_numpy())
        print(f"=== {sym}  ({len(df):,} 1H bars) ===")
        print(f"  {'TP%':>5} {'SL%':>5} {'RR':>5} | {'win':>6} {'net':>9} "
              f"{'PF':>5} {'exp/trade':>10} {'n':>5} {'avgWin':>8} {'avgLoss':>8}")
        for tp, sl in combos:
            tr = bracket_backtest(df, sig, tp, sl, max_hold, COST_BPS_PER_SIDE)
            m = trade_metrics(tr)
            rr = tp / sl
            print(f"  {tp:>5.1%} {sl:>5.1%} {rr:>5.2f} | {m['win_rate']:>6.1%} "
                  f"{m['net_total']:>+9.1%} {m['profit_factor']:>5.2f} "
                  f"{m['expectancy']:>+10.3%} {m['n']:>5} "
                  f"{m['avg_win']:>+8.2%} {m['avg_loss']:>+8.2%}")
        print()


if __name__ == "__main__":
    main()
