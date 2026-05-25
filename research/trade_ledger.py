"""Trade-by-trade ledger for BTC, SOL, ETH — each starting at $100,000.

Strategy = the validated per-coin engine: long-only multi-lookback momentum
(`tsmom_blend`, lbs=[10,30,60,120], vol_target 0.6, vol_lb 20, max_lev 3), costs
6 bps/side + 1 bp/day funding, no extra account leverage (m=1). Fixed validated
parameters applied across full history to illustrate trade-by-trade behaviour;
out-of-sample performance is documented separately (PER_COIN_BEST_STRATEGIES.md).

A "trade" = one contiguous in-market episode: the position turns on when momentum
goes positive and closes when momentum returns to flat (long-only). Exposure can
vary within an episode (inverse-vol sizing); we report entry/exit dates & prices,
holding days, average exposure (× equity), the asset's move, the strategy's realised
return on the episode, P&L in $, and running equity. Generates a markdown ledger.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs
from strategies import sig_tsmom_blend, build_weights

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
COINS = ["BTC", "SOL", "ETH"]
START = 100_000.0
LBS = (10, 30, 60, 120)
PARAMS = dict(vol_target=0.6, vol_lb=20, max_lev=3.0, long_only=True)
COSTS = Costs(txn=0.0006, funding_daily=0.0001)


def load(coin):
    df = datamod.load(coin)
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def run(coin):
    p = load(coin)
    raw = sig_tsmom_blend(p, {"lbs": LBS})
    w = build_weights(p, raw, PARAMS)                 # target weight at close t
    ret = p.pct_change()
    held = w.shift(1).fillna(0.0)                     # exposure in force during day t
    turn = held.diff().abs().fillna(held.abs())
    r_p = held * ret - COSTS.txn * turn - COSTS.funding_daily * held.abs()
    r_p = r_p.fillna(0.0)
    equity = START * (1.0 + r_p).cumprod()

    # identify contiguous in-market episodes (held > 0)
    inpos = held > 1e-9
    trades = []
    eq_prev_close = START
    i = 0
    idx = held.index
    n = len(idx)
    # equity at close of each day:
    eq = equity
    while i < n:
        if not inpos.iloc[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and inpos.iloc[j + 1]:
            j += 1
        # episode spans days i..j (inclusive), held>0
        entry_date = idx[i]
        exit_date = idx[j]
        eq_start = float(eq.iloc[i - 1]) if i > 0 else START
        eq_end = float(eq.iloc[j])
        entry_px = float(p.loc[entry_date])
        exit_px = float(p.loc[exit_date])
        avg_exp = float(held.iloc[i:j + 1].mean())
        days = (exit_date - entry_date).days + 1
        asset_move = exit_px / entry_px - 1.0
        trade_ret = eq_end / eq_start - 1.0
        pnl = eq_end - eq_start
        open_flag = (j == n - 1) and inpos.iloc[n - 1]
        trades.append(dict(
            entry=entry_date.date(), exit=exit_date.date(), days=days,
            entry_px=entry_px, exit_px=exit_px, avg_exp=avg_exp,
            asset_move=asset_move, trade_ret=trade_ret, pnl=pnl, equity=eq_end,
            open=open_flag,
        ))
        i = j + 1
    return p, eq, trades


def fmt_money(x):
    return f"${x:,.0f}"


def write_doc():
    lines = []
    lines.append("# Trade-by-Trade Ledger — BTC, SOL, ETH (each starting $100,000)\n")
    lines.append("**Strategy:** validated per-coin engine — long-only multi-lookback "
                 "momentum (`tsmom_blend`, lookbacks [10,30,60,120]), inverse-vol sizing "
                 "(vol-target 0.60, cap 3×), costs **6 bps/side + 1 bp/day funding**, "
                 "no extra account leverage. A *trade* = one contiguous in-market episode "
                 "(position opens when momentum turns positive, closes when it returns to "
                 "flat). `avg exp` = average exposure as a multiple of equity during the "
                 "trade (the engine sizes by inverse volatility, so it is < 1× most of the "
                 "time). Fixed validated parameters applied across full history to show "
                 "trade behaviour; out-of-sample performance is in "
                 "`PER_COIN_BEST_STRATEGIES.md`.\n")
    lines.append("> **Read the final-equity numbers with care.** This compounds $100k "
                 "through the full history at the strategy's own sizing, with no capacity "
                 "limit. The huge ending balances (e.g. BTC → nine figures) are a "
                 "**frictionless-compounding artifact**: at that size your own orders move "
                 "the market and the 6 bps cost assumption breaks down — real capacity caps "
                 "this by orders of magnitude. The **realistic, transferable parts are the "
                 "per-trade mechanics**: win rate (~30–38%, typical of momentum — many small "
                 "losses, few large wins), profit factor (~2), average exposure (< 1× most of "
                 "the time), and max drawdown. Illustrative of the mechanics, **not** a record "
                 "of live fills; slippage beyond 6 bps, funding variation and outages are not "
                 "modelled. Past performance is not predictive.\n")

    summary_rows = []
    for coin in COINS:
        p, eq, trades = run(coin)
        final = float(eq.iloc[-1])
        # max drawdown of the equity curve
        dd = (eq / eq.cummax() - 1.0).min()
        rets = np.array([t["trade_ret"] for t in trades])
        wins = int((rets > 0).sum())
        n = len(trades)
        win_rate = wins / n if n else 0.0
        gross_win = sum(t["pnl"] for t in trades if t["pnl"] > 0)
        gross_loss = -sum(t["pnl"] for t in trades if t["pnl"] < 0)
        pf = (gross_win / gross_loss) if gross_loss > 0 else float("inf")
        span = f"{p.index[0].date()} → {p.index[-1].date()}"
        yrs = (p.index[-1] - p.index[0]).days / 365.25
        cagr = (final / START) ** (1 / yrs) - 1 if yrs > 0 else 0.0
        summary_rows.append((coin, span, n, win_rate, final, cagr, dd, pf))

        lines.append(f"\n---\n\n## {coin}USDT — start $100,000\n")
        lines.append(f"- **Period:** {span}  ·  **Trades:** {n}  ·  "
                     f"**Win rate:** {win_rate:.0%}  ·  **Profit factor:** "
                     f"{pf:.2f}\n")
        lines.append(f"- **Final equity:** {fmt_money(final)}  ·  **CAGR:** {cagr:+.1%}  "
                     f"·  **Max drawdown:** {dd:.1%}\n")
        lines.append("\n| # | Entry | Exit | Days | Entry px | Exit px | Avg exp | "
                     "Asset move | Trade P&L% | P&L $ | Equity |")
        lines.append("|--:|---|---|--:|--:|--:|--:|--:|--:|--:|--:|")
        for k, t in enumerate(trades, 1):
            tag = " (OPEN)" if t["open"] else ""
            lines.append(
                f"| {k} | {t['entry']} | {t['exit']}{tag} | {t['days']} | "
                f"{t['entry_px']:,.4f} | {t['exit_px']:,.4f} | {t['avg_exp']:.2f}× | "
                f"{t['asset_move']:+.1%} | {t['trade_ret']:+.1%} | "
                f"{t['pnl']:+,.0f} | {fmt_money(t['equity'])} |")

    # front summary
    head = ["\n## Summary\n",
            "| Coin | Period | Trades | Win rate | Final equity | CAGR | MaxDD | Profit factor |",
            "|---|---|--:|--:|--:|--:|--:|--:|"]
    for coin, span, n, wr, final, cagr, dd, pf in summary_rows:
        head.append(f"| {coin} | {span} | {n} | {wr:.0%} | {fmt_money(final)} | "
                    f"{cagr:+.1%} | {dd:.1%} | {pf:.2f} |")
    out = [lines[0], lines[1], lines[2]] + head + lines[3:]
    path = os.path.join(ROOT, "TRADE_LEDGER_BTC_SOL_ETH.md")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")
    print("wrote", path)
    for coin, span, n, wr, final, cagr, dd, pf in summary_rows:
        print(f"  {coin}: {n} trades, win {wr:.0%}, final {fmt_money(final)}, "
              f"CAGR {cagr:+.1%}, maxDD {dd:.1%}, PF {pf:.2f}")


if __name__ == "__main__":
    write_doc()
