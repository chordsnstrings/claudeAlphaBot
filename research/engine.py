"""Vectorised daily backtest engine + metrics.

Conventions (no look-ahead):
  * A strategy produces a *target weight* ``w[t]`` (signed leverage) using
    only information available at the close of day ``t``.
  * That weight is held over day ``t+1`` and earns ``ret[t+1]``.
  * Transaction cost is charged when the held weight changes, i.e. at the
    close of the day the new weight is established.

So the realised portfolio return on day ``t`` is::

    held[t]   = w[t-1]                      # weight set at close of t-1
    r_p[t]    = held[t]*ret[t]
                - cost_bps * |held[t]-held[t-1]|   # turnover cost
                - funding_daily * |held[t]|        # carry / funding drag

Everything is annualised with 365 (crypto trades every day).
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Optional

import numpy as np
import pandas as pd

ANN = 365.0


# --------------------------------------------------------------------------
# Indicators (all causal: value at t uses prices[:t+1] only)
# --------------------------------------------------------------------------
def ema(x: pd.Series, span: int) -> pd.Series:
    return x.ewm(span=span, adjust=False, min_periods=span).mean()


def sma(x: pd.Series, n: int) -> pd.Series:
    return x.rolling(n, min_periods=n).mean()


def rolling_std(x: pd.Series, n: int) -> pd.Series:
    return x.rolling(n, min_periods=n).std(ddof=0)


def realized_vol(ret: pd.Series, n: int) -> pd.Series:
    """Annualised realised vol from daily returns over a trailing window."""
    return ret.rolling(n, min_periods=max(5, n // 2)).std(ddof=0) * np.sqrt(ANN)


def rsi(x: pd.Series, n: int) -> pd.Series:
    delta = x.diff()
    up = delta.clip(lower=0.0)
    dn = (-delta).clip(lower=0.0)
    roll_up = up.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    roll_dn = dn.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    rs = roll_up / roll_dn.replace(0.0, np.nan)
    return 100.0 - 100.0 / (1.0 + rs)


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------
@dataclass
class Metrics:
    cagr: float
    ann_vol: float
    sharpe: float
    sortino: float
    max_dd: float
    calmar: float
    total_return: float
    avg_exposure: float
    ann_turnover: float
    n_trades: int
    win_rate_days: float
    n_days: int
    final_equity: float

    def as_dict(self) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in asdict(self).items()}


def compute_metrics(r_p: pd.Series, held: pd.Series) -> Metrics:
    r = r_p.dropna()
    n = len(r)
    if n < 5:
        return Metrics(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, n, 1.0)
    equity = (1.0 + r).cumprod()
    final_equity = float(equity.iloc[-1])
    total_return = final_equity - 1.0
    years = n / ANN
    cagr = final_equity ** (1.0 / years) - 1.0 if final_equity > 0 and years > 0 else -1.0
    mean = r.mean()
    std = r.std(ddof=0)
    ann_vol = std * np.sqrt(ANN)
    sharpe = (mean / std * np.sqrt(ANN)) if std > 0 else 0.0
    downside = r[r < 0].std(ddof=0)
    sortino = (mean / downside * np.sqrt(ANN)) if downside and downside > 0 else 0.0
    roll_max = equity.cummax()
    dd = equity / roll_max - 1.0
    max_dd = float(dd.min())
    calmar = (cagr / abs(max_dd)) if max_dd < 0 else 0.0
    h = held.reindex(r.index).fillna(0.0)
    avg_exposure = float(h.abs().mean())
    turn = h.diff().abs().fillna(h.abs())
    ann_turnover = float(turn.sum() / years) if years > 0 else 0.0
    # a "trade" = a change in the rounded sign/size bucket of the position
    sign_changes = int((np.sign(h).diff().fillna(0) != 0).sum())
    win_rate_days = float((r > 0).mean())
    return Metrics(
        cagr=cagr, ann_vol=ann_vol, sharpe=sharpe, sortino=sortino,
        max_dd=max_dd, calmar=calmar, total_return=total_return,
        avg_exposure=avg_exposure, ann_turnover=ann_turnover, n_trades=sign_changes,
        win_rate_days=win_rate_days, n_days=n, final_equity=final_equity,
    )


# --------------------------------------------------------------------------
# Backtest
# --------------------------------------------------------------------------
@dataclass
class Costs:
    # one-way transaction cost as a fraction of notional traded (turnover).
    # Binance perp taker ~0.04% + slippage. 0.0006 = 6 bps one-way is a
    # conservative default for these liquid pairs at modest size.
    txn: float = 0.0006
    # symmetric daily carry/funding drag per unit gross exposure. Crypto perp
    # funding averages a small positive number paid by the side that is with
    # the trend; modelled as a symmetric drag to stay conservative.
    funding_daily: float = 0.00005  # ~1.8%/yr at 1x gross


def backtest(prices: pd.Series, target_w: pd.Series, costs: Costs = Costs()) -> dict:
    """Run the engine. ``target_w`` is indexed like ``prices`` and is the
    weight decided at each day's close. Returns dict with equity, returns,
    held weights and Metrics."""
    prices = prices.astype(float)
    ret = prices.pct_change()
    w = target_w.reindex(prices.index).astype(float).fillna(0.0)
    held = w.shift(1).fillna(0.0)          # weight in force during day t
    turnover = held.diff().abs().fillna(held.abs())
    gross_ret = held * ret
    cost = costs.txn * turnover + costs.funding_daily * held.abs()
    r_p = (gross_ret - cost)
    # first row has no prior price -> drop NaN return day
    valid = ret.notna()
    r_p = r_p[valid]
    held_v = held[valid]
    equity = (1.0 + r_p).cumprod()
    m = compute_metrics(r_p, held_v)
    return {"equity": equity, "returns": r_p, "held": held_v, "metrics": m}


def apply_annual_breaker(returns: pd.Series, dd_stop: float = 0.25) -> pd.Series:
    """Within-year circuit breaker for the annual-reset / profit-withdrawal model.

    Each calendar year starts fresh at equity 1.0. If the year-to-date equity
    falls more than ``dd_stop`` below its running intra-year peak, the account
    goes flat for the remainder of that year (returns zeroed). Causal: the
    decision on day t uses only YTD information through t. This converts the
    catastrophic leveraged ruin years (e.g. XRP -100%) into capped small losses
    so the $100k base survives to the next year."""
    out = returns.copy()
    for y in sorted(set(returns.index.year)):
        idx = returns.index[returns.index.year == y]
        eq = 1.0
        peak = 1.0
        stopped = False
        for t in idx:
            if stopped:
                out.loc[t] = 0.0
                continue
            eq *= (1.0 + returns.loc[t])
            peak = max(peak, eq)
            if eq / peak - 1.0 <= -dd_stop:
                stopped = True  # flat for the rest of the year (today's loss kept)
    return out


def buy_hold_metrics(prices: pd.Series) -> Metrics:
    w = pd.Series(1.0, index=prices.index)
    return backtest(prices, w, Costs(txn=0.0006, funding_daily=0.0))["metrics"]
