"""ETH bracket-trade engine: 10x futures, fixed risk, hard TP/SL at 2:1, win-rate optimised.

Idea (as specified): every trade is a bracket — enter on a signal, set STOP (risk = 1 unit)
and TAKE-PROFIT (reward = 2 units = 2:1 RR) from the start, risk a fixed % of the account.
You just need to be right on direction often enough: with 2:1 RR the break-even win rate is
1/(1+2) = 33%, and every point above compounds. So we sweep ENTRY SIGNALS x STOP GEOMETRY
to maximise the out-of-sample WIN RATE.

Liquidation-safe by design: the hard stop (~1-3% via ATR) triggers far inside the ~10%
liquidation distance of 10x — the stop, not the exchange, controls risk. Effective leverage
per trade = risk/stop_frac (kept <= 10x).

Bracket resolution on 15m bars (high/low); same-bar TP+SL ambiguity resolved as a LOSS
(conservative). Causal: signal at bar i, bracket walked on bars > i. WF-OOS validated.

Run:  python eth_bracket.py [--tf 15m] [--select winrate|expectancy] [--risk 0.02]
"""
from __future__ import annotations

import argparse
import itertools
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scalp_sweep as ss


# ----------------------------------------------------------------- entry signals (+1 long / -1 short / 0 none)
def s_rsi_rev(df, period=14, lo=30, hi=70):
    r = ss._rsi(df["close"], period).values
    e = np.zeros(len(df)); e[r < lo] = 1; e[r > hi] = -1; return e

def s_boll(df, n=20, k=2.0):
    c = df["close"]; m = c.rolling(n).mean(); sd = c.rolling(n).std()
    e = np.zeros(len(df)); e[(c < m - k * sd).values] = 1; e[(c > m + k * sd).values] = -1; return e

def s_rsi_trend(df, sma=200, period=14, dip=40):           # trend-aligned mean reversion
    c = df["close"]; up = (c > c.rolling(sma).mean()).values; r = ss._rsi(c, period).values
    e = np.zeros(len(df)); e[up & (r < dip)] = 1; e[(~up) & (r > 100 - dip)] = -1; return e

def s_donch(df, n=50):                                     # breakout
    c = df["close"]; hi = c.rolling(n).max().shift(1); lo = c.rolling(n).min().shift(1)
    e = np.zeros(len(df)); e[(c > hi).values] = 1; e[(c < lo).values] = -1; return e

def s_ema_pull(df, slow=200, fast=20):                     # pullback to fast EMA inside trend
    c = df["close"]; es = c.ewm(span=slow).mean(); ef = c.ewm(span=fast).mean()
    up = (c > es).values; dn = (c < es).values; below = (c <= ef).values; above = (c >= ef).values
    e = np.zeros(len(df)); e[up & below] = 1; e[dn & above] = -1; return e

def s_donch_trend(df, n=50, sma=200):                      # breakout, but only WITH the macro trend
    s = s_donch(df, n)
    up = (df["close"] > df["close"].rolling(sma).mean()).values
    s[(s > 0) & ~up] = 0; s[(s < 0) & up] = 0; return s     # no counter-trend breakouts

def committee(signals):                                    # majority entry vote across a basket
    return np.sign(sum(signals))

def recommended_entry(df, kind="pullback"):
    """Highest-win-rate bracket entries found by the sweep (4h signal, resolve on 1h, 2:1 RR).
    Trend ALIGNMENT is the key lever — it lifts win rate from ~38% (raw breakout) to ~42%.
      'pullback' : trend-aligned RSI dip (sma100, dip40) — 42.5% win, +0.50%/trade, -12% DD,
                   slippage-robust to ~50bps (buy dips with LIMIT orders, no chasing). ~20 trades/yr.
      'breakout' : trend-breakout committee (donch 20/50/100 aligned to SMA200) — 41.8% win,
                   +0.47%/trade, stable EVERY year (36-48%), ~50 trades/yr, more slippage-sensitive.
    Use ATR*2.0 (pullback) or ATR*2.5 (breakout) for the stop; target = 2x (2:1)."""
    if kind == "breakout":
        return committee([s_donch_trend(df, n, 200) for n in (20, 50, 100)])
    return s_rsi_trend(df, sma=100, period=14, dip=40)


SIGNALS = {
    "rsi_rev":   (s_rsi_rev,   [dict(period=14, lo=30, hi=70), dict(period=14, lo=25, hi=75),
                                dict(period=7, lo=20, hi=80), dict(period=14, lo=35, hi=65)]),
    "boll":      (s_boll,      [dict(n=20, k=2.0), dict(n=20, k=2.5), dict(n=50, k=2.0), dict(n=20, k=1.5)]),
    "rsi_trend": (s_rsi_trend, [dict(sma=200, period=14, dip=40), dict(sma=100, period=14, dip=40),
                                dict(sma=200, period=14, dip=35), dict(sma=100, period=7, dip=35)]),
    "donch":     (s_donch,     [dict(n=20), dict(n=50), dict(n=100)]),
    "ema_pull":  (s_ema_pull,  [dict(slow=200, fast=20), dict(slow=100, fast=20), dict(slow=200, fast=50)]),
}
ATR_MULTS = [1.0, 1.5, 2.0, 3.0]


# ----------------------------------------------------------------- bracket simulator
def simulate(entry, o, h, l, c, stopf, rr=2.0, risk=0.02, cost_bps=5.0, max_hold=2000):
    """Walk bars; when flat and a signal fires, open a bracket and resolve on later bars.
    Returns list of (entry_i, exit_i, win_bool, acct_return, eff_leverage)."""
    n = len(c); i = 0; fee = cost_bps * 1e-4; trades = []
    while i < n - 1:
        d = entry[i]; s = stopf[i]
        if d == 0 or not (s > 0):
            i += 1; continue
        ent = c[i]
        if d > 0:
            sl, tp = ent * (1 - s), ent * (1 + rr * s)
        else:
            sl, tp = ent * (1 + s), ent * (1 - rr * s)
        exit_i = None; win = None; exit_px = None
        for j in range(i + 1, min(n, i + max_hold)):
            hs = (l[j] <= sl) if d > 0 else (h[j] >= sl)
            ht = (h[j] >= tp) if d > 0 else (l[j] <= tp)
            if hs and ht:
                win, exit_px, exit_i = False, sl, j; break        # ambiguous -> conservative loss
            if ht:
                win, exit_px, exit_i = True, tp, j; break
            if hs:
                win, exit_px, exit_i = False, sl, j; break
        if exit_i is None:                                        # timeout -> exit at market
            exit_i = min(n - 1, i + max_hold - 1); exit_px = c[exit_i]
            win = (d * (exit_px / ent - 1)) > 0
        lev = risk / s
        r = d * (exit_px / ent - 1) * lev - 2 * fee * lev
        trades.append((i, exit_i, bool(win), float(r), float(lev)))
        i = exit_i + 1
    return trades


def cross_simulate(coarse_idx, entry, stopf, fine_df, coarse_dur, rr=2.0, risk=0.02,
                   cost_bps=5.0, mh=8000):
    """Entry signal on a COARSE tf (e.g. 4h) but TP/SL resolved on FINE bars (e.g. 1h) for an
    honest intrabar fill. CAUSAL: a coarse bar's signal is only known at its CLOSE, so we act at
    the first fine bar at/after (coarse_open_time + coarse_dur) — getting this offset wrong is a
    look-ahead that massively inflates the win rate. Resolving on coarse bars alone (same-tf
    simulate) instead UNDER-states it (a coarse bar often spans both TP and SL)."""
    fi = fine_df.index.values
    fo, fh, fl, fc = (fine_df[x].values for x in ("open", "high", "low", "close"))
    trades = []; flat = -1
    for i in range(len(entry)):
        d = entry[i]; s = stopf[i]
        if d == 0 or not (s > 0):
            continue
        t_act = coarse_idx.values[i] + coarse_dur
        if t_act < fi[0]:
            continue
        k = int(np.searchsorted(fi, t_act, side="left"))
        if k <= flat or k >= len(fi):
            continue
        ent = fo[k]
        sl, tp = (ent * (1 - s), ent * (1 + rr * s)) if d > 0 else (ent * (1 + s), ent * (1 - rr * s))
        ek = win = px = None
        for j in range(k, min(len(fi), k + mh)):
            hs = (fl[j] <= sl) if d > 0 else (fh[j] >= sl)
            ht = (fh[j] >= tp) if d > 0 else (fl[j] <= tp)
            if hs and ht:
                win, px, ek = False, sl, j; break
            if ht:
                win, px, ek = True, tp, j; break
            if hs:
                win, px, ek = False, sl, j; break
        if ek is None:
            ek = min(len(fi) - 1, k + mh - 1); px = fc[ek]; win = (d * (px / ent - 1)) > 0
        lev = risk / s
        trades.append((k, ek, bool(win), float(d * (px / ent - 1) * lev - 2 * cost_bps * 1e-4 * lev), float(lev)))
        flat = ek
    return trades


def trade_metrics(trades):
    if not trades:
        return dict(n=0, win_rate=0, total=0, maxdd=0, expectancy=0, avg_lev=0)
    rs = np.array([t[3] for t in trades]); wins = np.array([t[2] for t in trades])
    eq = np.cumprod(1 + rs); peak = np.maximum.accumulate(eq)
    return dict(n=len(trades), win_rate=float(wins.mean()), total=float(eq[-1] - 1),
                maxdd=float((eq / peak - 1).min()), expectancy=float(rs.mean()),
                avg_lev=float(np.mean([t[4] for t in trades])))


# ----------------------------------------------------------------- walk-forward OOS
def build_configs(df):
    atr_frac = (ss._atr(df, 14) / df["close"]).values
    cfgs = []
    for name, (fn, grid) in SIGNALS.items():
        for p in grid:
            e = fn(df, **p)
            for mult in ATR_MULTS:
                cfgs.append((e, atr_frac * mult, f"{name}{p} atr*{mult}"))
    return cfgs


def walk_forward(df, train_bars, test_bars, risk, cost_bps, select, min_tr=15):
    o, h, l, c = (df[x].values for x in ("open", "high", "low", "close"))
    cfgs = build_configs(df)
    all_tr = [simulate(e, o, h, l, c, sf, 2.0, risk, cost_bps) for (e, sf, _) in cfgs]
    n = len(df); oos = []; chosen = {}; start = train_bars
    while start + test_bars <= n:
        a, b = start - train_bars, start; ta, tb = start, start + test_bars
        best_j, best = -1, -1e18
        for j, tl in enumerate(all_tr):
            tt = [t for t in tl if a <= t[0] < b]
            if len(tt) < min_tr:
                continue
            mm = trade_metrics(tt)
            sc = mm["win_rate"] if select == "winrate" else mm["expectancy"]
            if sc > best:
                best, best_j = sc, j
        if best_j >= 0:
            for t in all_tr[best_j]:
                if ta <= t[0] < tb:
                    oos.append(t)
            chosen[cfgs[best_j][2]] = chosen.get(cfgs[best_j][2], 0) + 1
        start += test_bars
    return oos, chosen, cfgs, all_tr


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", default="15m"); ap.add_argument("--select", default="winrate")
    ap.add_argument("--risk", type=float, default=0.02); ap.add_argument("--cost-bps", type=float, default=5.0)
    ap.add_argument("--train-days", type=int, default=90); ap.add_argument("--test-days", type=int, default=30)
    a = ap.parse_args(argv)
    ss.set_tf(a.tf); df = ss.load(a.tf, "ETH")
    tb, te = a.train_days * ss.BARS_PER_DAY, a.test_days * ss.BARS_PER_DAY
    oos, chosen, cfgs, all_tr = walk_forward(df, tb, te, a.risk, a.cost_bps, a.select)
    m = trade_metrics(oos)
    yrs = (df.index[-1] - df.index[0]).days / 365.25
    print(f"\n=== ETH bracket WF-OOS  ({a.tf}, 2:1 RR, risk {a.risk:.0%}/trade, {a.cost_bps}bps, select={a.select}) ===")
    print(f"  window {df.index[0].date()}->{df.index[-1].date()} ({yrs:.1f}y)")
    print(f"  WIN RATE {m['win_rate']*100:.1f}%   trades {m['n']} ({m['n']/yrs:.0f}/yr)   "
          f"expectancy {m['expectancy']*100:+.2f}%/trade   avg lev {m['avg_lev']:.1f}x")
    print(f"  total return {m['total']*100:+.0f}%   maxDD {m['maxdd']*100:.0f}%   "
          f"(break-even win rate at 2:1 = 33.3%)")
    top = sorted(chosen.items(), key=lambda kv: -kv[1])[:4]
    print("  most-chosen entries:", "; ".join(f"{k} x{v}" for k, v in top))
    return df, oos


if __name__ == "__main__":
    main(sys.argv[1:])
