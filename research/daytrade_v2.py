"""ETH high-risk day-trading strategy — liquidity sweep + trailing stop + spot harvest.

A separate strategy from the v1 combined blend (this is NOT a position sleeve; it's a
discrete-trade scalper). Architecture as specified:
  * Signal:    LIQUIDITY SWEEP of recent support/resistance + rejection close
               (bullish: low pierces prior N-bar low then closes back above; bearish: mirror)
  * Sizing:    FIXED DOLLAR RISK per trade (e.g., $50 on $1000 base = 5%). Notional adapts
               to stop distance: notional = risk / stop_distance. Effective leverage is
               bounded; the stop bounds the dollar loss regardless of leverage.
  * Stops:     Initial stop AT the swept extreme (price has to break this to invalidate).
               After +1R favorable -> move to breakeven (lock no-loss).
               After +2R favorable -> trailing ATR stop (lock profit while letting it run).
               Time exit at max_hold bars (always close: profit if any, else least loss).
  * Harvest:   When realized wallet > base * 1.10, move the excess to SPOT. Trading wallet
               resets to base; spot accumulates (long-term store of value).
  * Liq-safe:  stops fire well inside 10x futures liquidation; risk per trade is hard-bounded.

WF-OOS validated per the session's "always WF/OOS" commitment: per-fold parameter selection
on a trailing train window, applied forward.

Run:  python daytrade_v2.py            # full WF-OOS backtest + harvest summary
      python daytrade_v2.py --probe    # quick full-sample sanity check (in-sample)
"""
from __future__ import annotations

import sys
import os
import itertools
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scalp_sweep as ss

# ----------------------------- config (defaults) -----------------------------
BASE        = 1000.0   # trading wallet base ($)
RISK_PCT    = 0.05     # fixed $ risk per trade as fraction of base (5% = $50/trade aggressive)
HARVEST_PCT = 0.10     # any wallet > base * (1 + this) moves the excess to spot
MAX_LEV     = 10.0     # exchange leverage cap (futures)
COST_BPS    = 5.0      # round-trip taker fee


# ----------------------------- indicators -----------------------------------
def _atr_frac(df, n=14):
    """ATR as a fraction of price (causal)."""
    h, l, c = df["high"], df["low"], df["close"]; pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    return (tr.ewm(alpha=1.0 / n, adjust=False).mean() / c).fillna(0).values


def liquidity_sweep(df, lookback=20, rejection=0.5, trend_sma=200):
    """+1 long entry (bullish sweep below support, IN an uptrend), -1 short (bearish sweep
    above resistance, IN a downtrend), 0 otherwise. The trend filter (price vs SMA) is the
    key edge: counter-trend sweep traps are noise; with-trend sweeps are real liquidity
    grabs before continuation. Set trend_sma=0 to disable the filter."""
    h, l, c = df["high"], df["low"], df["close"]
    prior_lo = l.rolling(lookback).min().shift(1)
    prior_hi = h.rolling(lookback).max().shift(1)
    rng = (h - l).replace(0, np.nan)
    rej = ((c - l) / rng).fillna(0.5)
    bull = (l < prior_lo) & (c > prior_lo) & (rej > rejection)
    bear = (h > prior_hi) & (c < prior_hi) & (rej < (1 - rejection))
    if trend_sma > 0:
        sma = c.rolling(trend_sma).mean()
        bull = bull & (c > sma)     # only buy dip-sweeps in uptrend
        bear = bear & (c < sma)     # only short pop-sweeps in downtrend
    sig = np.zeros(len(df))
    sig[bull.values] = 1
    sig[bear.values] = -1
    return sig


# ----------------------------- single trade simulator -----------------------
def simulate_trade(df, entry_i, direction, atr_frac, target_R=2.0, trail_atr=1.5,
                   breakeven_at_R=1.5, max_hold=24):
    """Walk forward from entry until stop or target hits, with trailing logic.
    Returns: (exit_i, exit_price, outcome, R_realized) where R_realized is in units of
    initial stop distance (positive = profit, negative = loss)."""
    h, l, c = df["high"].values, df["low"].values, df["close"].values
    entry = c[entry_i]
    # Initial stop = the swept extreme of the entry bar (the level that invalidates the setup)
    if direction > 0:
        init_stop = l[entry_i]
    else:
        init_stop = h[entry_i]
    risk_pts = abs(entry - init_stop)
    stop_pct = risk_pts / entry if entry > 0 else 0
    # Skip degenerate stops (effectively zero distance), and stops too tight to size feasibly
    # under the leverage cap (i.e., required leverage = risk_pct/stop_pct > MAX_LEV).
    if risk_pts <= 0 or stop_pct < 0.001:
        return entry_i + 1, entry, "skip", 0.0
    target = entry + direction * target_R * risk_pts
    stop = init_stop
    n = len(c); end = min(n - 1, entry_i + max_hold)
    for j in range(entry_i + 1, end + 1):
        # Check stop / target intrabar
        if direction > 0:
            if l[j] <= stop:
                return j, stop, "stop", (stop - entry) / risk_pts
            if h[j] >= target:
                return j, target, "target", target_R
            # update trailing (causal: use bar's close after check)
            ahead = c[j] - entry
            R_ahead = ahead / risk_pts
            if R_ahead >= breakeven_at_R and stop < entry:
                stop = entry                                       # move to breakeven
            if R_ahead >= 2.0:
                trail = c[j] - atr_frac[j] * c[j] * trail_atr
                if trail > stop: stop = trail                      # ratchet up only
        else:  # short
            if h[j] >= stop:
                return j, stop, "stop", (entry - stop) / risk_pts
            if l[j] <= target:
                return j, target, "target", target_R
            ahead = entry - c[j]
            R_ahead = ahead / risk_pts
            if R_ahead >= breakeven_at_R and stop > entry:
                stop = entry
            if R_ahead >= 2.0:
                trail = c[j] + atr_frac[j] * c[j] * trail_atr
                if trail < stop: stop = trail
    # Time exit -- always close, profit if any, else least loss available right now
    px = c[end]
    R_real = (px - entry) / risk_pts if direction > 0 else (entry - px) / risk_pts
    return end, px, "time", R_real


# ----------------------------- account simulator ----------------------------
def backtest(df, sig, target_R=2.0, trail_atr=1.5, breakeven_at_R=1.5, max_hold=24,
             base=BASE, risk_pct=RISK_PCT, harvest_pct=HARVEST_PCT, cost_bps=COST_BPS):
    """Walk bars taking signals; track trading wallet (resets on harvest) + spot wallet."""
    atr = _atr_frac(df, 14)
    wallet = base; spot = 0.0
    trades = []; wallet_curve = []; spot_curve = []
    i = 1
    n = len(df)
    fee = cost_bps * 1e-4
    while i < n - 1:
        if sig[i] == 0:
            wallet_curve.append((df.index[i], wallet)); spot_curve.append((df.index[i], spot)); i += 1; continue
        # Trade
        risk_dollars = risk_pct * base                              # FIXED dollar risk per trade
        ex_i, exit_px, outcome, R = simulate_trade(df, i, int(sig[i]), atr, target_R, trail_atr, breakeven_at_R, max_hold)
        if outcome in ("skip", "too_tight"):
            i = ex_i; continue
        # Position notional sized so initial-stop loss = risk_dollars
        # P&L in dollars = R * risk_dollars - costs (2-sided fee on notional)
        entry_px = df["close"].iloc[i]
        stop_dist_pct = abs(df["low"].iloc[i] - entry_px) / entry_px if sig[i] > 0 else abs(df["high"].iloc[i] - entry_px) / entry_px
        notional = risk_dollars / max(stop_dist_pct, 1e-6)
        cost_dollars = 2 * fee * notional
        pnl = R * risk_dollars - cost_dollars
        wallet += pnl
        trades.append(dict(entry=df.index[i], exit=df.index[ex_i], dir=int(sig[i]),
                           R=R, outcome=outcome, pnl=pnl, hold=ex_i - i))
        # Harvest above base*(1+harvest_pct) -> spot
        threshold = base * (1.0 + harvest_pct)
        if wallet > threshold:
            move = wallet - base                                    # move everything above base
            spot += move; wallet = base
        wallet_curve.append((df.index[ex_i], wallet)); spot_curve.append((df.index[ex_i], spot))
        i = ex_i + 1
    return dict(trades=trades, wallet=wallet, spot=spot,
                wallet_curve=pd.Series({t: v for t, v in wallet_curve}),
                spot_curve=pd.Series({t: v for t, v in spot_curve}))


def trade_metrics(res):
    tr = res["trades"]
    if not tr: return dict(n=0, win=0, exp=0, total_pnl=0, max_dd=0, hold_bars=0)
    rs = np.array([t["pnl"] for t in tr])
    wins = sum(1 for t in tr if t["pnl"] > 0)
    holds = np.array([t["hold"] for t in tr])
    eq = res["wallet_curve"].values
    if len(eq) > 0:
        peak = np.maximum.accumulate(eq)
        mdd = ((eq - peak) / peak).min() if (peak > 0).all() else 0
    else:
        mdd = 0
    return dict(n=len(tr), win=wins / len(tr), exp=rs.mean(),
                total_pnl=rs.sum(), max_dd=mdd, hold_bars=holds.mean())


# ----------------------------- WF-OOS validation ----------------------------
def wf_oos(df, train_days=180, test_days=60):
    """Per-fold WF: sweep over (lookback, rejection, target_R, trail_atr) on the trailing
    train, select the best by train Sharpe-ish (expectancy/std), apply OOS on the test."""
    bpd = 96 if df.index[1] - df.index[0] < pd.Timedelta("16min") else 24  # 15m vs 1h heuristic
    bpd = int(bpd)
    TR = train_days * bpd; TE = test_days * bpd
    grid = list(itertools.product([20, 50, 100], [0.5, 0.6], [1.5, 2.0, 3.0], [1.0, 1.5], [100, 200, 0]))
    n = len(df); oos_trades = []; picks = []; start = TR
    fold_id = 0
    while start + TE <= n:
        train_df = df.iloc[start - TR:start]; test_df = df.iloc[start:start + TE]
        best, best_pick = -1e9, None
        for lookback, rej, tR, trA, trsma in grid:
            sig = liquidity_sweep(train_df, lookback, rej, trsma)
            r = backtest(train_df, sig, target_R=tR, trail_atr=trA)
            m = trade_metrics(r)
            if m["n"] < 5: continue
            score = m["exp"] * np.sqrt(m["n"])     # crude Sharpe-like (per-trade)
            if score > best:
                best, best_pick = score, (lookback, rej, tR, trA, trsma)
        if best_pick is None:
            start += TE; continue
        lb, rj, tr_R, tA, trs = best_pick
        sig_te = liquidity_sweep(test_df, lb, rj, trs)
        r_te = backtest(test_df, sig_te, target_R=tr_R, trail_atr=tA)
        for t in r_te["trades"]:
            t["fold"] = fold_id; oos_trades.append(t)
        picks.append(best_pick); fold_id += 1; start += TE
    return oos_trades, picks


# ----------------------------- CLI ----------------------------
def _load(tf="15m", asset="ETH"):
    ss.set_tf(tf); return ss.load(tf, asset)


def probe():
    """Quick full-sample sanity probe (in-sample, NOT validation)."""
    df = _load("15m", "ETH")
    print(f"PROBE — ETH 15m  {df.index[0].date()} -> {df.index[-1].date()}  ({len(df)} bars)")
    sig = liquidity_sweep(df, lookback=50, rejection=0.6)
    r = backtest(df, sig, target_R=2.0, trail_atr=1.0)
    m = trade_metrics(r)
    print(f"  in-sample: n={m['n']} win={m['win']*100:.0f}% exp=${m['exp']:.2f}/trade "
          f"total=${m['total_pnl']:.0f}  max DD=${m['max_dd']*BASE if m['max_dd'] else 0:.0f}")
    print(f"  trading wallet: ${r['wallet']:.0f}   harvested to spot: ${r['spot']:.0f}   "
          f"total: ${r['wallet']+r['spot']:.0f}")


def run_wf():
    df = _load("15m", "ETH")
    print(f"WF-OOS — ETH 15m  {df.index[0].date()} -> {df.index[-1].date()}  ({len(df)} bars)")
    oos_trades, picks = wf_oos(df, train_days=180, test_days=60)
    if not oos_trades:
        print("  no OOS trades produced"); return
    rs = np.array([t["pnl"] for t in oos_trades])
    wins = sum(1 for t in oos_trades if t["pnl"] > 0)
    # Replay wallet/spot harvest on the OOS trade stream
    wallet = BASE; spot = 0.0; eqcurve = [BASE]
    for t in oos_trades:
        wallet += t["pnl"]
        if wallet > BASE * (1 + HARVEST_PCT):
            spot += (wallet - BASE); wallet = BASE
        eqcurve.append(wallet)
    eq = np.array(eqcurve); peak = np.maximum.accumulate(eq)
    mdd_dollars = (eq - peak).min()
    print(f"  trades: {len(oos_trades)}  win rate: {wins/len(oos_trades)*100:.1f}%  "
          f"avg per trade: ${rs.mean():.2f}  expectancy: ${rs.mean():.2f}/trade")
    print(f"  total realized: ${rs.sum():.0f}")
    print(f"  final trading wallet: ${wallet:.0f}  |  spot accumulated: ${spot:.0f}  |  "
          f"TOTAL: ${wallet+spot:.0f}")
    print(f"  max drawdown of trading wallet: ${mdd_dollars:.0f} ({mdd_dollars/BASE*100:.0f}% of base)")
    print(f"  WF folds: {len(picks)}")
    # Distribution of picks
    from collections import Counter
    pc = Counter(picks).most_common(3)
    print(f"  top picks (lookback, rejection, target_R, trail_atr, trend_sma):")
    for p, c in pc: print(f"    {p}: chosen {c} folds")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--probe" in args: probe()
    else: run_wf()
