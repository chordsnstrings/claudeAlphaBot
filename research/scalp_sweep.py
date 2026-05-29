"""Scalping strategy sweep on BTC 15m with walk-forward OOS validation.

Goal: across the established short-term strategies (trend + mean-reversion + breakout),
find the one that grows wealth most CONSISTENTLY with the LEAST drawdown, NET of realistic
costs, validated out-of-sample. Each strategy's parameters are re-selected on a trailing
TRAIN window every fold and applied forward on the TEST window (walk-forward) — so the
reported curve is genuinely OOS. Costs are charged on turnover (scalping lives or dies here).

Strategies are causal (signal shifted 1 bar before execution). Positions are in [-1, 1].

Run:  python scalp_sweep.py [--cost-bps 5] [--train-days 90] [--test-days 30]
"""
from __future__ import annotations

import argparse
import itertools
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
TF_BARS_PER_DAY = {"5m": 288, "15m": 96, "1h": 24, "4h": 6}
BARS_PER_DAY = 96
BARS_PER_YEAR = BARS_PER_DAY * 365            # set per timeframe by set_tf()


def set_tf(tf):
    global BARS_PER_DAY, BARS_PER_YEAR
    BARS_PER_DAY = TF_BARS_PER_DAY[tf]
    BARS_PER_YEAR = BARS_PER_DAY * 365


# ----------------------------------------------------------------- data
def load(tf="15m") -> pd.DataFrame:
    csv = os.path.join(HERE, "data", "intraday", f"BTC_{tf}.csv")
    df = pd.read_csv(csv, parse_dates=["date"]).set_index("date")
    return df[["open", "high", "low", "close", "volume"]].astype(float)


# ----------------------------------------------------------------- indicators
def _atr(df, n):
    h, l, c = df["high"], df["low"], df["close"]
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / n, adjust=False).mean()


def _rsi(c, n):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1.0 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1.0 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def _state(enter_long, enter_short, exit_flat) -> pd.Series:
    """Stateful mean-reversion position: enter on band, flip on opposite band, exit at flat."""
    el = enter_long.values; es = enter_short.values; fl = exit_flat.values
    pos = np.zeros(len(el)); cur = 0.0
    for i in range(len(el)):
        if cur == 0.0:
            if el[i]:
                cur = 1.0
            elif es[i]:
                cur = -1.0
        elif fl[i]:
            cur = 0.0
        elif cur > 0 and es[i]:
            cur = -1.0
        elif cur < 0 and el[i]:
            cur = 1.0
        pos[i] = cur
    return pd.Series(pos, index=enter_long.index)


# ----------------------------------------------------------------- strategies (-> target pos [-1,1])
def ema_cross(df, fast=20, slow=100):
    c = df["close"]
    return np.sign(c.ewm(span=fast).mean() - c.ewm(span=slow).mean())


def macd(df, fast=12, slow=26, signal=9):
    c = df["close"]
    m = c.ewm(span=fast).mean() - c.ewm(span=slow).mean()
    return np.sign(m - m.ewm(span=signal).mean())


def donchian(df, n=50):
    c = df["close"]
    hi = c.rolling(n).max().shift(1); lo = c.rolling(n).min().shift(1)
    pos = pd.Series(np.nan, index=c.index)
    pos[c >= hi] = 1.0; pos[c <= lo] = -1.0
    return pos.ffill().fillna(0.0)


def supertrend(df, period=10, mult=3.0):
    a = _atr(df, period); hl2 = (df["high"] + df["low"]) / 2
    up = (hl2 + mult * a).values; dn = (hl2 - mult * a).values; c = df["close"].values
    n = len(c); fu = np.zeros(n); fl = np.zeros(n); dir_ = np.ones(n)
    fu[0], fl[0] = up[0], dn[0]
    for i in range(1, n):
        fu[i] = up[i] if (up[i] < fu[i - 1] or c[i - 1] > fu[i - 1]) else fu[i - 1]
        fl[i] = dn[i] if (dn[i] > fl[i - 1] or c[i - 1] < fl[i - 1]) else fl[i - 1]
        dir_[i] = 1.0 if c[i] > fu[i - 1] else (-1.0 if c[i] < fl[i - 1] else dir_[i - 1])
    return pd.Series(dir_, index=df.index)


def roc_mom(df, n=48, thr=0.0):
    r = df["close"].pct_change(n)
    return np.sign(r.where(r.abs() > thr, 0.0)).fillna(0.0)


def boll_rev(df, n=20, k=2.0):
    c = df["close"]; m = c.rolling(n).mean(); sd = c.rolling(n).std()
    return _state(c < m - k * sd, c > m + k * sd, (c - m).abs() < 0.25 * sd)


def rsi_rev(df, period=14, lo=30, hi=70):
    r = _rsi(df["close"], period)
    return _state(r < lo, r > hi, (r > 45) & (r < 55))


def zscore_rev(df, n=50, entry=2.0, exit=0.5):
    c = df["close"]; m = c.rolling(n).mean(); sd = c.rolling(n).std()
    z = (c - m) / sd
    return _state(z < -entry, z > entry, z.abs() < exit)


def keltner_rev(df, n=20, mult=2.0):
    c = df["close"]; m = c.ewm(span=n).mean(); a = _atr(df, n)
    return _state(c < m - mult * a, c > m + mult * a, (c - m).abs() < 0.3 * a)


def stoch_rev(df, k=14, d=3, lo=20, hi=80):
    ll = df["low"].rolling(k).min(); hh = df["high"].rolling(k).max()
    kf = 100 * (df["close"] - ll) / (hh - ll).replace(0, np.nan)
    dd = kf.rolling(d).mean()
    return _state(dd < lo, dd > hi, (dd > 45) & (dd < 55))


def _grid(**kw):
    keys = list(kw)
    return [dict(zip(keys, vals)) for vals in itertools.product(*kw.values())]


STRATS = {
    "ema_cross":  (ema_cross,  [p for p in _grid(fast=[10, 20, 50], slow=[50, 100, 200]) if p["fast"] < p["slow"]]),
    "macd":       (macd,       [dict(fast=12, slow=26, signal=9), dict(fast=8, slow=21, signal=5), dict(fast=19, slow=39, signal=9)]),
    "donchian":   (donchian,   _grid(n=[20, 50, 100, 200])),
    "supertrend": (supertrend, [dict(period=10, mult=3.0), dict(period=7, mult=3.0), dict(period=14, mult=2.0), dict(period=10, mult=2.0)]),
    "roc_mom":    (roc_mom,    _grid(n=[24, 48, 96], thr=[0.0, 0.005])),
    "boll_rev":   (boll_rev,   _grid(n=[20, 50], k=[1.5, 2.0, 2.5])),
    "rsi_rev":    (rsi_rev,    [dict(period=14, lo=30, hi=70), dict(period=7, lo=20, hi=80), dict(period=14, lo=25, hi=75), dict(period=21, lo=30, hi=70)]),
    "zscore_rev": (zscore_rev, [dict(n=50, entry=2.0, exit=0.5), dict(n=100, entry=2.0, exit=0.5), dict(n=50, entry=2.5, exit=0.5), dict(n=200, entry=2.0, exit=1.0)]),
    "keltner_rev":(keltner_rev,_grid(n=[20, 50], mult=[1.5, 2.0])),
    "stoch_rev":  (stoch_rev,  [dict(k=14, d=3, lo=20, hi=80), dict(k=14, d=3, lo=25, hi=75), dict(k=28, d=3, lo=20, hi=80)]),
}


# ----------------------------------------------------------------- backtest + metrics
def backtest(df, pos, cost_bps) -> pd.Series:
    ret = df["close"].pct_change().fillna(0.0)
    ex = pos.shift(1).fillna(0.0).clip(-1, 1)
    turn = ex.diff().abs().fillna(ex.abs())
    return ex * ret - cost_bps * 1e-4 * turn


def metrics(net) -> dict:
    net = net.dropna()
    if len(net) < 10 or net.std() == 0:
        return dict(sharpe=0, sortino=0, cagr=0, maxdd=0, calmar=0, total=0, n=len(net))
    eq = (1 + net).cumprod()
    end = eq.iloc[-1]
    cagr = end ** (BARS_PER_YEAR / len(net)) - 1 if end > 0 else -1.0
    sharpe = net.mean() / net.std() * np.sqrt(BARS_PER_YEAR)
    dn = net[net < 0].std()
    sortino = net.mean() / dn * np.sqrt(BARS_PER_YEAR) if dn and dn > 0 else 0.0
    maxdd = (eq / eq.cummax() - 1).min()
    calmar = cagr / abs(maxdd) if maxdd < 0 else 0.0
    return dict(sharpe=sharpe, sortino=sortino, cagr=cagr, maxdd=maxdd,
                calmar=calmar, total=end - 1, n=len(net))


# ----------------------------------------------------------------- walk-forward
def walk_forward(df, strat_fn, grid, train_bars, test_bars, cost_bps):
    nets = [backtest(df, strat_fn(df, **p), cost_bps) for p in grid]
    n = len(df)
    oos = pd.Series(np.nan, index=df.index)
    chosen = {}
    fold_rets = []
    start = train_bars
    while start + test_bars <= n:
        tr = slice(start - train_bars, start)
        te = slice(start, start + test_bars)
        best_j, best_s = 0, -1e18
        for j, net in enumerate(nets):
            s = metrics(net.iloc[tr])["sharpe"]
            if s > best_s:
                best_s, best_j = s, j
        oos.iloc[te] = nets[best_j].iloc[te].values
        fr = float((1 + nets[best_j].iloc[te]).prod() - 1)
        fold_rets.append(fr)
        key = tuple(sorted(grid[best_j].items()))
        chosen[key] = chosen.get(key, 0) + 1
        start += test_bars
    oos = oos.dropna()
    m = metrics(oos)
    m["pos_folds"] = float(np.mean([r > 0 for r in fold_rets])) if fold_rets else 0.0
    m["n_folds"] = len(fold_rets)
    ex = None
    return oos, m, chosen, fold_rets


# ----------------------------------------------------------------- portfolio helpers (daily)
def to_daily(net) -> pd.Series:
    """Per-bar net returns -> daily compounded returns."""
    return (1 + net.dropna()).resample("1D").prod() - 1


def vol_target(daily, target_ann=0.25, lb=30, cap=3.0) -> pd.Series:
    """Scale a daily return stream to a constant target annual vol (causal trailing vol)."""
    rv = daily.rolling(lb).std() * np.sqrt(365)
    sc = (target_ann / rv).clip(upper=cap).shift(1).fillna(0.0)
    return daily * sc


def daily_metrics(d) -> dict:
    d = d.dropna()
    if len(d) < 30 or d.std() == 0:
        return dict(ann=0, vol=0, sharpe=0, maxdd=0, calmar=0, total=0, pos_months=0, n=len(d))
    eq = (1 + d).cumprod()
    ann = eq.iloc[-1] ** (365 / len(d)) - 1 if eq.iloc[-1] > 0 else -1.0
    vol = d.std() * np.sqrt(365)
    sharpe = d.mean() / d.std() * np.sqrt(365)
    mdd = (eq / eq.cummax() - 1).min()
    mon = (1 + d).resample("ME").prod() - 1
    return dict(ann=ann, vol=vol, sharpe=sharpe, maxdd=mdd,
                calmar=ann / abs(mdd) if mdd < 0 else 0.0,
                total=eq.iloc[-1] - 1, pos_months=float((mon > 0).mean()), n=len(d))


def run(cost_bps=5.0, train_days=90, test_days=30, tf="15m"):
    set_tf(tf)
    df = load(tf)
    tb, te = train_days * BARS_PER_DAY, test_days * BARS_PER_DAY
    rows = []
    oos_curves = {}
    for name, (fn, grid) in STRATS.items():
        oos, m, chosen, folds = walk_forward(df, fn, grid, tb, te, cost_bps)
        oos_curves[name] = oos
        top = max(chosen.items(), key=lambda kv: kv[1])[0] if chosen else ()
        rows.append((name, m["calmar"], m["sharpe"], m["cagr"], m["maxdd"],
                     m["total"], m["pos_folds"], m["n_folds"], dict(top)))
    res = pd.DataFrame(rows, columns=["strategy", "calmar", "sharpe", "cagr", "maxdd",
                                      "total_oos", "pos_folds", "folds", "modal_params"])
    res = res.sort_values("calmar", ascending=False).reset_index(drop=True)
    return df, res, oos_curves


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cost-bps", type=float, default=5.0)
    ap.add_argument("--train-days", type=int, default=90)
    ap.add_argument("--test-days", type=int, default=30)
    ap.add_argument("--tf", default="15m", choices=list(TF_BARS_PER_DAY))
    a = ap.parse_args()
    df, res, _ = run(a.cost_bps, a.train_days, a.test_days, a.tf)
    span_days = (df.index[-1] - df.index[0]).days
    bh = df["close"].iloc[-1] / df["close"].iloc[0] - 1
    print(f"\nBTC {a.tf}  {df.index[0].date()} -> {df.index[-1].date()} ({span_days}d, {len(df)} bars)")
    print(f"buy&hold BTC: {bh:+.0%}   |   costs {a.cost_bps} bps/side   |   WF train {a.train_days}d / test {a.test_days}d\n")
    pd.set_option("display.width", 160, "display.max_columns", 20)
    show = res.copy()
    for c in ["cagr", "maxdd", "total_oos", "pos_folds"]:
        show[c] = (show[c] * 100).round(1)
    show["calmar"] = show["calmar"].round(2); show["sharpe"] = show["sharpe"].round(2)
    print(show.to_string(index=False))
