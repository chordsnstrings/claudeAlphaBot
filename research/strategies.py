"""Strategy families.

Each family exposes:
  * ``raw_signal(prices, p) -> Series`` in [-1, +1] (causal direction), and
  * a ``grid()`` of parameter dicts to search.

``build_weights`` wraps any raw signal with a volatility-targeting overlay and
optional long-only / leverage caps, producing the final target weight series
consumed by ``engine.backtest``.

The families are deliberately simple and few-parameter so that walk-forward
optimisation has a real chance of generalising rather than curve-fitting.
"""
from __future__ import annotations

import itertools
from typing import Callable, Iterable

import numpy as np
import pandas as pd

from engine import ema, sma, rolling_std, realized_vol, rsi, ANN

VOL_FLOOR = 0.10  # annualised; avoids explosive leverage in dead-calm periods


# --------------------------------------------------------------------------
# Overlay: turn a directional raw signal into a sized target weight
# --------------------------------------------------------------------------
def build_weights(prices: pd.Series, raw: pd.Series, p: dict) -> pd.Series:
    raw = raw.reindex(prices.index).fillna(0.0).clip(-1.0, 1.0)
    vt = p.get("vol_target", 0.0)
    max_lev = p.get("max_lev", 2.0)
    if vt and vt > 0:
        ret = prices.pct_change()
        rv = realized_vol(ret, p.get("vol_lb", 30)).clip(lower=VOL_FLOOR)
        scale = (vt / rv).clip(upper=max_lev)
        w = raw * scale
    else:
        w = raw * max_lev
    if p.get("long_only", False):
        w = w.clip(lower=0.0)
    return w.clip(-max_lev, max_lev).fillna(0.0)


# --------------------------------------------------------------------------
# Families
# --------------------------------------------------------------------------
def sig_tsmom(prices: pd.Series, p: dict) -> pd.Series:
    """Time-series momentum: sign of trailing L-day return."""
    L = p["lookback"]
    mom = prices / prices.shift(L) - 1.0
    return np.sign(mom)


def sig_macross(prices: pd.Series, p: dict) -> pd.Series:
    """EMA crossover trend."""
    f = ema(prices, p["fast"])
    s = ema(prices, p["slow"])
    return np.sign(f - s)


def sig_donchian(prices: pd.Series, p: dict) -> pd.Series:
    """Donchian-style breakout on closes. Long when close breaks above the
    prior N-day high, short when it breaks below the prior M-day low; holds
    the position in between (stateful)."""
    n, m = p["entry"], p["exit"]
    hi = prices.shift(1).rolling(n, min_periods=n).max()
    lo = prices.shift(1).rolling(m, min_periods=m).min()
    long_sig = (prices > hi).astype(float)
    short_sig = (prices < lo).astype(float) * -1.0
    raw = pd.Series(np.nan, index=prices.index)
    raw[long_sig > 0] = 1.0
    raw[short_sig < 0] = -1.0
    return raw.ffill().fillna(0.0)


def sig_mr_z(prices: pd.Series, p: dict) -> pd.Series:
    """Mean reversion on a z-score, gated off during strong trends.

    Crypto mean reversion is profitable in chop but lethal in trends, so we
    only fade when the fast/slow EMA spread (a trend-strength proxy) is small.
    """
    lb = p["lb"]
    mu = sma(prices, lb)
    sd = rolling_std(prices, lb).replace(0.0, np.nan)
    z = (prices - mu) / sd
    raw = pd.Series(np.nan, index=prices.index)
    raw[z > p["z_entry"]] = -1.0          # too high -> short
    raw[z < -p["z_entry"]] = 1.0          # too low  -> long
    raw[z.abs() < p["z_exit"]] = 0.0      # back to mean -> flat
    raw = raw.ffill().fillna(0.0)
    # trend gate
    spread = (ema(prices, 20) / ema(prices, 100) - 1.0).abs()
    gate = (spread < p.get("trend_gate", 0.10)).astype(float)
    return raw * gate


def sig_tsmom_blend(prices: pd.Series, p: dict) -> pd.Series:
    """Multi-lookback momentum consensus. Averages the sign of trailing
    returns over several horizons -> a [-1,1] conviction score. Far fewer
    free parameters than a single-lookback model, so it generalises better."""
    lbs = p.get("lbs", (20, 40, 80, 120))
    sig = sum(np.sign(prices / prices.shift(L) - 1.0) for L in lbs) / float(len(lbs))
    return sig


def sig_trend_flat(prices: pd.Series, p: dict) -> pd.Series:
    """Regime-gated trend: take the EMA-cross direction only when the
    fast/slow spread exceeds a band (a clear trend); otherwise stand flat.
    Designed to harvest sustained moves while sitting out the chop that
    whipsaws always-on trend models on high-beta alts."""
    f = ema(prices, p["fast"])
    s = ema(prices, p["slow"])
    spread = f / s - 1.0
    raw = pd.Series(0.0, index=prices.index)
    raw[spread > p["band"]] = 1.0
    raw[spread < -p["band"]] = -1.0
    return raw


def sig_rsi_mr(prices: pd.Series, p: dict) -> pd.Series:
    """RSI mean reversion: long oversold, short overbought, gated by trend."""
    r = rsi(prices, p["lb"])
    raw = pd.Series(np.nan, index=prices.index)
    raw[r < p["lo"]] = 1.0
    raw[r > p["hi"]] = -1.0
    raw[(r > 45) & (r < 55)] = 0.0
    raw = raw.ffill().fillna(0.0)
    spread = (ema(prices, 20) / ema(prices, 100) - 1.0).abs()
    gate = (spread < p.get("trend_gate", 0.12)).astype(float)
    return raw * gate


# --------------------------------------------------------------------------
# Family registry: signal fn + parameter grid
# --------------------------------------------------------------------------
def _grid(base: dict, **axes) -> list[dict]:
    keys = list(axes.keys())
    out = []
    for combo in itertools.product(*[axes[k] for k in keys]):
        d = dict(base)
        d.update(dict(zip(keys, combo)))
        out.append(d)
    return out


# common overlay axes shared by every family
_OVERLAY = dict(vol_lb=[30], max_lev=[2.5])
_VT = [0.30, 0.45, 0.60]
_VT2 = [0.20, 0.30, 0.45, 0.65, 0.85]   # trend families: low for risk-control assets, high for hot ones


class Family:
    def __init__(self, name: str, fn: Callable[[pd.Series, dict], pd.Series], grid: list[dict]):
        self.name = name
        self.fn = fn
        self.grid = grid

    def weights(self, prices: pd.Series, p: dict) -> pd.Series:
        return build_weights(prices, self.fn(prices, p), p)


def all_families(long_only_opts: Iterable[bool] = (False, True)) -> list[Family]:
    fams: list[Family] = []

    fams.append(Family("tsmom", sig_tsmom, [
        dict(lookback=lb, vol_target=vt, vol_lb=30, max_lev=3.0, long_only=lo)
        for lb in (20, 40, 60, 90, 120)
        for vt in _VT2
        for lo in long_only_opts
    ]))

    fams.append(Family("tsmom_blend", sig_tsmom_blend, [
        dict(lbs=lbs, vol_target=vt, vol_lb=30, max_lev=3.0, long_only=lo)
        for lbs in ((20, 40, 80, 120), (10, 30, 60, 120), (30, 60, 120, 200))
        for vt in _VT2
        for lo in long_only_opts
    ]))

    fams.append(Family("trend_flat", sig_trend_flat, [
        dict(fast=f, slow=s, band=b, vol_target=vt, vol_lb=30, max_lev=3.0, long_only=lo)
        for (f, s) in ((20, 100), (30, 150), (20, 200))
        for b in (0.0, 0.02, 0.05)
        for vt in _VT2
        for lo in long_only_opts
    ]))

    fams.append(Family("macross", sig_macross, [
        dict(fast=f, slow=s, vol_target=vt, vol_lb=30, max_lev=2.5, long_only=lo)
        for (f, s) in ((10, 50), (20, 100), (20, 200), (50, 200), (30, 150))
        for vt in _VT
        for lo in long_only_opts
    ]))

    fams.append(Family("donchian", sig_donchian, [
        dict(entry=n, exit=m, vol_target=vt, vol_lb=30, max_lev=2.5, long_only=lo)
        for (n, m) in ((20, 10), (40, 20), (55, 20), (90, 30))
        for vt in _VT
        for lo in long_only_opts
    ]))

    fams.append(Family("mr_z", sig_mr_z, [
        dict(lb=lb, z_entry=ze, z_exit=zx, trend_gate=tg, vol_target=vt, vol_lb=20, max_lev=2.0, long_only=lo)
        for lb in (10, 20, 30)
        for ze in (1.5, 2.0)
        for zx in (0.3, 0.5)
        for tg in (0.08, 0.15)
        for vt in (0.30, 0.45)
        for lo in long_only_opts
    ]))

    fams.append(Family("rsi_mr", sig_rsi_mr, [
        dict(lb=lb, lo=lo_th, hi=hi_th, trend_gate=tg, vol_target=vt, vol_lb=20, max_lev=2.0, long_only=lo)
        for lb in (7, 14)
        for (lo_th, hi_th) in ((30, 70), (25, 75), (35, 65))
        for tg in (0.10, 0.18)
        for vt in (0.30, 0.45)
        for lo in long_only_opts
    ]))

    return fams


def family_by_name(name: str) -> Family:
    for f in all_families():
        if f.name == name:
            return f
    raise KeyError(name)
