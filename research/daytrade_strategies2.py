"""Round 2 of the day-trade study: the strategy families the first pass MISSED.

The first study (daytrade_winrate.py / daytrade_walkforward.py) tested three entry
families (z-score MR, RSI MR, trend-pullback) with FIXED-% brackets, and found a
single rolling-walk-forward survivor: BTC 1H trend-pullback. This module rigorously
walk-forward-tests the families that pass did NOT cover, so the "only one edge"
verdict is an exhaustive result rather than an artefact of a narrow search:

  #1 breakout / momentum-continuation  (Donchian channel break, +/- trend filter)
  #2 volatility-adaptive & trailing exits (ATR brackets, trailing stop)   [exit dim]
  #3 regime gate (ADX trend-strength) on the pullback                     [entry filter]
  #5 time-of-day / session filter on the pullback                          [entry filter]
  #6 VWAP / volume entries (VWAP-anchored pullback)
  #4 CROSS-ASSET BTC->ETH lead-lag / relative strength  (the ETH rescue)  [emphasis]
  #7 trade management: partial scale-out + trail the runner                [exit dim]

Same honest harness as the gold-standard pass:
  * signal on bar t close, fill at t+1 open; conservative same-bar stop-first; gaps
    fill at the open; 1x, one position at a time; 6 bps/side round-trip cost.
  * ROLLING walk-forward: train 365d -> unseen 120d, NON-overlapping test windows,
    params chosen on train ONLY by net expectancy (>=15 train trades), OOS stitched.
  * exit geometry (fixed-% / ATR / trailing / scale-out) is part of the searched
    grid, so "best exit" is itself chosen out-of-sample.

Run:  python research/daytrade_strategies2.py            # full sweep (background it)
      python research/daytrade_strategies2.py ETH 1h eth_btc_gated   # one cell (smoke)
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

from daytrade_winrate import (COST_BPS_PER_SIDE, RESULTS, Trade, atr, load_1h,
                              rsi, sma, trade_metrics)

# ----------------------------------------------------------------- config / scales
TFS = ["1h", "4h", "8h"]                       # 1h = proven day-trade home; 4h/8h fresh
BARS_PER_DAY = {"1h": 24, "4h": 6, "8h": 3}
RESAMPLE_RULE = {"1h": None, "4h": "4h", "8h": "8h"}
TRAIN_DAYS = 365
TEST_DAYS = 120
MIN_TRADES_TRAIN_FOLD = 15
HOLDS = {"1h": [24, 48], "4h": [12, 24], "8h": [6, 12]}


def resample_tf(df1h: pd.DataFrame, tf: str) -> pd.DataFrame:
    rule = RESAMPLE_RULE[tf]
    if rule is None:
        return df1h.copy()
    return pd.DataFrame({
        "open": df1h["open"].resample(rule).first(),
        "high": df1h["high"].resample(rule).max(),
        "low": df1h["low"].resample(rule).min(),
        "close": df1h["close"].resample(rule).last(),
        "volume": df1h["volume"].resample(rule).sum(),
    }).dropna()


# ----------------------------------------------------------------------- indicators
def _wilder(x: np.ndarray, n: int) -> np.ndarray:
    out = np.zeros(len(x), dtype=float)
    if len(x) == 0:
        return out
    out[:n] = np.nanmean(x[:n]) if n > 0 else 0.0
    a = 1.0 / n
    for i in range(n, len(x)):
        out[i] = (1 - a) * out[i - 1] + a * x[i]
    return out


def adx(high, low, close, n: int = 14) -> np.ndarray:
    up = high - np.roll(high, 1); up[0] = 0.0
    dn = np.roll(low, 1) - low; dn[0] = 0.0
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    pc = np.roll(close, 1); pc[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - pc), np.abs(low - pc)))
    atr_ = _wilder(tr, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi = 100.0 * _wilder(plus_dm, n) / np.where(atr_ > 1e-12, atr_, np.nan)
        mdi = 100.0 * _wilder(minus_dm, n) / np.where(atr_ > 1e-12, atr_, np.nan)
        dx = 100.0 * np.abs(pdi - mdi) / np.where((pdi + mdi) > 1e-12, pdi + mdi, np.nan)
    return np.nan_to_num(_wilder(np.nan_to_num(dx, nan=0.0), n), nan=0.0)


def roll_max_prior(x: np.ndarray, n: int) -> np.ndarray:
    """Max over the n bars BEFORE the current bar (excludes current -> no lookahead)."""
    return pd.Series(x).rolling(n).max().shift(1).to_numpy()


def roll_min_prior(x: np.ndarray, n: int) -> np.ndarray:
    return pd.Series(x).rolling(n).min().shift(1).to_numpy()


def vwap(high, low, close, vol, n: int) -> np.ndarray:
    tp = (high + low + close) / 3.0
    num = pd.Series(tp * vol).rolling(n).sum().to_numpy()
    den = pd.Series(vol).rolling(n).sum().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den > 1e-12, num / den, np.nan)


def pct_return_k(close: np.ndarray, k: int) -> np.ndarray:
    prev = np.roll(close, k)
    out = close / np.where(prev > 1e-12, prev, np.nan) - 1.0
    out[:k] = 0.0
    return out


# ------------------------------------------------------------------------- signals
# build(A, p) -> int array in {+1,-1,0}; A holds aligned arrays for this coin (+ 'pc'
# = partner/BTC close for cross-asset families). Everything is causal (bar t only).

def sig_breakout(A, p):
    c = A["c"]
    ph = roll_max_prior(A["h"], p["don"])
    pl = roll_min_prior(A["l"], p["don"])
    s = np.zeros(len(c), dtype=int)
    long_ok = c > ph
    short_ok = c < pl
    if p["trend"] > 0:
        ma = sma(c, p["trend"])
        long_ok = long_ok & (c > ma)
        short_ok = short_ok & (c < ma)
    s[np.nan_to_num(long_ok, nan=False)] = 1
    s[np.nan_to_num(short_ok, nan=False)] = -1
    return s


def sig_vwap_pullback(A, p):
    c = A["c"]
    vw = vwap(A["h"], A["l"], c, A["v"], p["vwap"])
    r = rsi(c, 7)
    s = np.zeros(len(c), dtype=int)
    up = c > vw; dn = c < vw
    s[np.nan_to_num(up & (r <= p["dip"]), nan=False)] = 1
    s[np.nan_to_num(dn & (r >= 100 - p["dip"]), nan=False)] = -1
    return s


def sig_regime_pullback(A, p):
    c = A["c"]
    ma = sma(c, p["slow"]); r = rsi(c, 7); ax = adx(A["h"], A["l"], c, 14)
    strong = ax >= p["adx"]
    up = c > ma; dn = c < ma
    s = np.zeros(len(c), dtype=int)
    s[np.nan_to_num(up & (r <= p["dip"]) & strong, nan=False)] = 1
    s[np.nan_to_num(dn & (r >= 100 - p["dip"]) & strong, nan=False)] = -1
    return s


_SESSIONS = {  # UTC hour windows [start, end)
    "all": None, "us": (13, 21), "eu": (7, 15), "asia": (0, 8),
}


def sig_tod_pullback(A, p):
    c = A["c"]
    ma = sma(c, 100); r = rsi(c, 7)
    hours = A["idx"].hour.to_numpy()
    win = _SESSIONS[p["sess"]]
    mask = np.ones(len(c), dtype=bool) if win is None else \
        (hours >= win[0]) & (hours < win[1])
    up = c > ma; dn = c < ma
    s = np.zeros(len(c), dtype=int)
    s[up & (r <= p["dip"]) & mask] = 1
    s[dn & (r >= 100 - p["dip"]) & mask] = -1
    return s


# ---- #4 cross-asset BTC -> ETH (partner close = A['pc']) -----------------------
def sig_eth_btc_gated(A, p):
    """Borrow BTC's trend for ETH: long ETH on an ETH dip only while BTC is in an
    uptrend (BTC close > BTC SMA); mirror short."""
    c = A["c"]; pc = A["pc"]
    bma = sma(pc, p["bslow"]); r = rsi(c, 7)
    bt_up = pc > bma; bt_dn = pc < bma
    s = np.zeros(len(c), dtype=int)
    s[np.nan_to_num(bt_up & (r <= p["dip"]), nan=False)] = 1
    s[np.nan_to_num(bt_dn & (r >= 100 - p["dip"]), nan=False)] = -1
    return s


def sig_eth_btc_momo(A, p):
    """Lead-lag: ETH follows BTC. Long ETH when BTC's last-k-bar return > thr."""
    c = A["c"]; pc = A["pc"]
    bret = pct_return_k(pc, p["k"])
    s = np.zeros(len(c), dtype=int)
    s[bret > p["thr"]] = 1
    s[bret < -p["thr"]] = -1
    return s


def sig_eth_btc_rs(A, p):
    """Relative strength: long ETH when the ETH/BTC ratio is in an uptrend (ETH
    outperforming) AND BTC itself is in an uptrend (both confirm)."""
    c = A["c"]; pc = A["pc"]
    ratio = c / np.where(pc > 1e-12, pc, np.nan)
    rma = sma(ratio, p["rsn"]); bma = sma(pc, p["bslow"])
    rs_up = ratio > rma; bt_up = pc > bma
    s = np.zeros(len(c), dtype=int)
    s[np.nan_to_num(rs_up & bt_up, nan=False)] = 1
    s[np.nan_to_num((~rs_up) & (pc < bma), nan=False)] = -1
    return s


# --------------------------------------------------------------- exit engine (#2/#7)
def _exit_grid(tf: str):
    base = [
        {"mode": "pct", "tp": 0.01, "sl": 0.01},
        {"mode": "pct", "tp": 0.02, "sl": 0.02},
        {"mode": "pct", "tp": 0.03, "sl": 0.03},
        {"mode": "pct", "tp": 0.02, "sl": 0.01},
        {"mode": "pct", "tp": 0.03, "sl": 0.015},
        {"mode": "atr", "tp_atr": 2.0, "sl_atr": 2.0},
        {"mode": "atr", "tp_atr": 3.0, "sl_atr": 1.5},
        {"mode": "trail", "trail": 0.02},
        {"mode": "trail", "trail": 0.03},
        {"mode": "scaleout", "tp1": 0.015, "sl": 0.02, "trail": 0.02},
    ]
    out = []
    for mh in HOLDS[tf]:
        for e in base:
            d = dict(e); d["max_hold"] = mh
            out.append(d)
    return out


def bracket_ext(df, signal, xp, atr_arr, cost_bps=COST_BPS_PER_SIDE):
    """Event-driven bracket with selectable exit geometry. Conservative: same-bar
    stop wins ties; gaps fill at the open; entry at next-open. Returns Trades whose
    ret_net is net of round-trip cost (scale-out charges entry once + two half exits
    ~= one round trip)."""
    o = df["open"].to_numpy(); h = df["high"].to_numpy()
    lo = df["low"].to_numpy(); c = df["close"].to_numpy()
    n = len(c); cost = cost_bps / 1e4; mode = xp["mode"]; mh = xp["max_hold"]
    trades: list[Trade] = []
    i = 0
    while i < n - 1:
        sdir = signal[i]
        if sdir == 0:
            i += 1; continue
        ei = i + 1; epx = o[ei]
        if not np.isfinite(epx) or epx <= 0:
            i += 1; continue
        last = min(ei + mh, n - 1)

        if mode in ("pct", "atr"):
            if mode == "atr":
                a = atr_arr[i] if atr_arr is not None else np.nan
                if not np.isfinite(a) or a <= 0:
                    i += 1; continue
                tp_lvl = epx + sdir * xp["tp_atr"] * a
                sl_lvl = epx - sdir * xp["sl_atr"] * a
            else:
                tp_lvl = epx * (1 + sdir * xp["tp"])
                sl_lvl = epx * (1 - sdir * xp["sl"])
            ej, epx_out, reason = _resolve_fixed(o, h, lo, c, sdir, ei, last, tp_lvl, sl_lvl)
            gross = sdir * (epx_out / epx - 1.0)

        elif mode == "trail":
            ej, epx_out, reason = _resolve_trail(o, h, lo, c, sdir, ei, last, epx, xp["trail"])
            gross = sdir * (epx_out / epx - 1.0)

        else:  # scaleout
            ej, epx_out, reason, gross = _resolve_scaleout(o, h, lo, c, sdir, ei, last, epx, xp)

        ret_net = gross - 2 * cost
        trades.append(Trade(int(sdir), ei, ej, epx, epx_out, ret_net, reason))
        i = ej + 1
    return trades


def _resolve_fixed(o, h, lo, c, sdir, ei, last, tp_lvl, sl_lvl):
    for j in range(ei, last + 1):
        oj, hj, lj, cj = o[j], h[j], lo[j], c[j]
        if sdir == 1:
            if oj <= sl_lvl: return j, oj, "sl"
            if oj >= tp_lvl: return j, oj, "tp"
            if lj <= sl_lvl: return j, sl_lvl, "sl"
            if hj >= tp_lvl: return j, tp_lvl, "tp"
        else:
            if oj >= sl_lvl: return j, oj, "sl"
            if oj <= tp_lvl: return j, oj, "tp"
            if hj >= sl_lvl: return j, sl_lvl, "sl"
            if lj <= tp_lvl: return j, tp_lvl, "tp"
        if j == last:
            return j, cj, "time"
    return last, c[last], "time"


def _resolve_trail(o, h, lo, c, sdir, ei, last, epx, trail):
    if sdir == 1:
        stop = epx * (1 - trail); peak = epx
        for j in range(ei, last + 1):
            oj, hj, lj, cj = o[j], h[j], lo[j], c[j]
            if oj <= stop: return j, oj, "trail"
            if lj <= stop: return j, stop, "trail"
            peak = max(peak, hj); stop = max(stop, peak * (1 - trail))
            if j == last: return j, cj, "time"
    else:
        stop = epx * (1 + trail); trough = epx
        for j in range(ei, last + 1):
            oj, hj, lj, cj = o[j], h[j], lo[j], c[j]
            if oj >= stop: return j, oj, "trail"
            if hj >= stop: return j, stop, "trail"
            trough = min(trough, lj); stop = min(stop, trough * (1 + trail))
            if j == last: return j, cj, "time"
    return last, c[last], "time"


def _resolve_scaleout(o, h, lo, c, sdir, ei, last, epx, xp):
    """Take half off at +tp1, move the stop to breakeven, trail the runner. Blended
    gross = 0.5*half1 + 0.5*runner."""
    tp1 = epx * (1 + sdir * xp["tp1"])
    sl0 = epx * (1 - sdir * xp["sl"])
    trail = xp["trail"]
    phase = 1; stop = sl0; g1 = 0.0
    peak = epx  # favourable extreme for the runner's trail
    for j in range(ei, last + 1):
        oj, hj, lj, cj = o[j], h[j], lo[j], c[j]
        if phase == 1:
            if sdir == 1:
                if oj <= stop: return j, oj, "sl", (oj / epx - 1.0)
                if lj <= stop: return j, stop, "sl", (-xp["sl"])
                if oj >= tp1 or hj >= tp1:
                    px1 = oj if oj >= tp1 else tp1
                    g1 = px1 / epx - 1.0
                    phase = 2; stop = epx; peak = max(epx, hj)
                    stop = max(stop, peak * (1 - trail))
                    if j == last:
                        return j, cj, "scaleout", 0.5 * g1 + 0.5 * (cj / epx - 1.0)
                    continue
                if j == last:
                    return j, cj, "time", (cj / epx - 1.0)
            else:
                if oj >= stop: return j, oj, "sl", -(oj / epx - 1.0)
                if hj >= stop: return j, stop, "sl", (-xp["sl"])
                if oj <= tp1 or lj <= tp1:
                    px1 = oj if oj <= tp1 else tp1
                    g1 = -(px1 / epx - 1.0)
                    phase = 2; stop = epx; peak = min(epx, lj)
                    stop = min(stop, peak * (1 + trail))
                    if j == last:
                        return j, cj, "scaleout", 0.5 * g1 + 0.5 * (-(cj / epx - 1.0))
                    continue
                if j == last:
                    return j, cj, "time", -(cj / epx - 1.0)
        else:  # phase 2: runner, trailing from breakeven
            if sdir == 1:
                if oj <= stop: return j, oj, "scaleout", 0.5 * g1 + 0.5 * (oj / epx - 1.0)
                if lj <= stop: return j, stop, "scaleout", 0.5 * g1 + 0.5 * (stop / epx - 1.0)
                peak = max(peak, hj); stop = max(stop, peak * (1 - trail))
                if j == last:
                    return j, cj, "scaleout", 0.5 * g1 + 0.5 * (cj / epx - 1.0)
            else:
                if oj >= stop: return j, oj, "scaleout", 0.5 * g1 + 0.5 * (-(oj / epx - 1.0))
                if hj >= stop: return j, stop, "scaleout", 0.5 * g1 + 0.5 * (-(stop / epx - 1.0))
                peak = min(peak, lj); stop = min(stop, peak * (1 + trail))
                if j == last:
                    return j, cj, "scaleout", 0.5 * g1 + 0.5 * (-(cj / epx - 1.0))
    return last, c[last], "time", sdir * (c[last] / epx - 1.0)


# --------------------------------------------------------------------- strategy reg
def _entry_grid(name, tf):
    if name == "breakout":
        return [dict(don=d, trend=t) for d in (20, 40, 55) for t in (0, 100, 200)]
    if name == "vwap_pullback":
        return [dict(vwap=v, dip=dp) for v in (20, 50, 100) for dp in (35, 45)]
    if name == "regime_pullback":
        return [dict(slow=s, dip=dp, adx=ax)
                for s in (50, 100) for dp in (35, 45) for ax in (20, 25, 30)]
    if name == "tod_pullback":
        return [dict(dip=dp, sess=se)
                for dp in (35, 45) for se in ("all", "us", "eu", "asia")]
    if name == "eth_btc_gated":
        return [dict(bslow=b, dip=dp) for b in (50, 100, 200) for dp in (35, 45)]
    if name == "eth_btc_momo":
        return [dict(k=k, thr=t) for k in (3, 6, 12) for t in (0.0, 0.01)]
    if name == "eth_btc_rs":
        return [dict(rsn=r, bslow=b) for r in (20, 50) for b in (100, 200)]
    raise ValueError(name)


STRATS = {
    "breakout": (sig_breakout, ["BTC", "ETH"], False),
    "vwap_pullback": (sig_vwap_pullback, ["BTC", "ETH"], False),
    "regime_pullback": (sig_regime_pullback, ["BTC", "ETH"], False),
    "tod_pullback": (sig_tod_pullback, ["BTC", "ETH"], False),
    "eth_btc_gated": (sig_eth_btc_gated, ["ETH"], True),
    "eth_btc_momo": (sig_eth_btc_momo, ["ETH"], True),
    "eth_btc_rs": (sig_eth_btc_rs, ["ETH"], True),
}


def _build_arrays(sym, tf, needs_partner):
    df = resample_tf(load_1h(sym), tf)
    if needs_partner:
        btc = resample_tf(load_1h("BTC"), tf)
        idx = df.index.intersection(btc.index)
        df = df.loc[idx]; pc = btc.loc[idx, "close"].to_numpy()
    else:
        pc = None
    A = {
        "o": df["open"].to_numpy(), "h": df["high"].to_numpy(),
        "l": df["low"].to_numpy(), "c": df["close"].to_numpy(),
        "v": df["volume"].to_numpy(), "idx": df.index, "pc": pc,
    }
    a = atr(A["h"], A["l"], A["c"], 14)
    return df, A, a


def _slice_A(A, s, e):
    out = {k: (v[s:e] if isinstance(v, np.ndarray) else v[s:e])
           for k, v in A.items() if k != "pc"}
    out["pc"] = None if A["pc"] is None else A["pc"][s:e]
    out["idx"] = A["idx"][s:e]
    return out


def walk_forward(sym, tf, name):
    sigfn, _, needs_partner = STRATS[name]
    df, A, atr_full = _build_arrays(sym, tf, needs_partner)
    n = len(df)
    bpd = BARS_PER_DAY[tf]
    train_bars = TRAIN_DAYS * bpd; test_bars = TEST_DAYS * bpd
    if n < train_bars + test_bars + 5:
        return {"status": "insufficient_bars", "bars": n}
    entries = _entry_grid(name, tf); exits = _exit_grid(tf)

    oos_trades, fold_nets, fold_wins, picks = [], [], [], []
    start = 0
    while start + train_bars + test_bars <= n:
        tr = df.iloc[start:start + train_bars]
        A_tr = _slice_A(A, start, start + train_bars)
        atr_tr = atr_full[start:start + train_bars]
        best = None  # (expectancy, ep, xp)
        for ep in entries:
            sig = sigfn(A_tr, ep)
            for xp in exits:
                t = bracket_ext(tr, sig, xp, atr_tr)
                m = trade_metrics(t)
                if m["n"] < MIN_TRADES_TRAIN_FOLD:
                    continue
                if best is None or m["expectancy"] > best[0]:
                    best = (m["expectancy"], ep, xp)
        if best is not None:
            e0, e1 = start, start + train_bars + test_bars
            ctx = df.iloc[e0:e1]
            A_ctx = _slice_A(A, e0, e1)
            atr_ctx = atr_full[e0:e1]
            sig = sigfn(A_ctx, best[1]).copy()
            sig[:train_bars] = 0                      # entries only in the OOS window
            te = bracket_ext(ctx, sig, best[2], atr_ctx)
            if te:
                rets = [x.ret_net for x in te]
                oos_trades.extend(rets)
                fold_nets.append(float(np.prod([1 + r for r in rets]) - 1))
                fold_wins.append(float(np.mean([r > 0 for r in rets])))
                picks.append((best[1], best[2]))
        start += test_bars

    if not oos_trades:
        return {"status": "no_oos_trades", "folds": 0}
    rets = np.array(oos_trades)
    wins = rets[rets > 0]; losses = rets[rets <= 0]
    eq = np.cumprod(1 + rets); peak = np.maximum.accumulate(eq)
    gw = wins.sum(); gl = -losses.sum()
    pf = (gw / gl) if gl > 1e-12 else float("inf")
    return {
        "status": "ok",
        "folds": len(fold_nets),
        "oos_n_trades": int(len(rets)),
        "oos_win_rate": float((rets > 0).mean()),
        "oos_net": float(eq[-1] - 1.0),
        "oos_profit_factor": float(pf),
        "oos_expectancy": float(rets.mean()),
        "oos_max_dd": float((eq / peak - 1.0).min()),
        "fold_win_rate": float(np.mean([x > 0 for x in fold_nets])),
        "fold_winrate_min": float(np.min(fold_wins)),
        "fold_winrate_med": float(np.median(fold_wins)),
        "fold_winrate_max": float(np.max(fold_wins)),
        "fold_nets": [float(x) for x in fold_nets],
        "picks": picks,
        "oos_returns": rets.tolist(),
    }


def main(argv):
    sel_coins = [a.upper() for a in argv if a.upper() in ("BTC", "ETH")]
    sel_tfs = [a for a in argv if a in TFS]
    sel_names = [a for a in argv if a in STRATS]
    tfs = sel_tfs or TFS
    names = sel_names or list(STRATS)
    out = {"train_days": TRAIN_DAYS, "test_days": TEST_DAYS,
           "cost_bps_per_side": COST_BPS_PER_SIDE, "results": {}}
    print(f"ROUND-2 WALK-FORWARD  tfs={tfs}  strategies={names}  "
          f"train={TRAIN_DAYS}d test={TEST_DAYS}d (non-overlapping)  "
          f"cost={COST_BPS_PER_SIDE}bps/side\n")
    print(f"  {'coin':<4} {'tf':<4} {'strategy':<16} {'folds':>5} {'OOSn':>5} "
          f"{'win':>6} {'net':>9} {'PF':>5} {'exp':>8} {'foldWin':>7} "
          f"{'foldWR(min/med/max)':>20}")
    for name in names:
        _, coins, _ = STRATS[name]
        run_coins = [c for c in coins if (not sel_coins or c in sel_coins)]
        for sym in run_coins:
            out["results"].setdefault(sym, {})
            for tf in tfs:
                r = walk_forward(sym, tf, name)
                out["results"][sym].setdefault(tf, {})
                out["results"][sym][tf][name] = {k: v for k, v in r.items()
                                                 if k != "oos_returns"}
                if r.get("status") != "ok":
                    print(f"  {sym:<4} {tf:<4} {name:<16} {r.get('status')}")
                    continue
                print(f"  {sym:<4} {tf:<4} {name:<16} {r['folds']:>5} "
                      f"{r['oos_n_trades']:>5} {r['oos_win_rate']:>6.1%} "
                      f"{r['oos_net']:>+9.1%} {r['oos_profit_factor']:>5.2f} "
                      f"{r['oos_expectancy']:>+8.3%} {r['fold_win_rate']:>7.1%} "
                      f"{r['fold_winrate_min']:>5.0%}/{r['fold_winrate_med']:>4.0%}"
                      f"/{r['fold_winrate_max']:>4.0%}")
                if r["oos_net"] > 0 and r["oos_n_trades"] >= 30:
                    eqc = np.cumprod(1 + np.array(r["oos_returns"]))
                    pd.Series(eqc).to_csv(
                        os.path.join(RESULTS, f"dt2_{sym}_{tf}_{name}_oos_eq.csv"),
                        index_label="trade", header=["equity"])
    path = os.path.join(RESULTS, "daytrade_strategies2_results.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2, default=float)
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main(sys.argv[1:])
