"""Walk-forward validation.

For an asset + strategy family:
  1. Pre-compute every grid param's causal return series once (weights only
     ever use past data, so the series is window-independent).
  2. Roll train/test windows forward. In each window pick the param with the
     best *train* objective, then record its performance on the *next,
     unseen* test window and append those test returns to an OOS stream.
  3. The stitched OOS stream is the headline result: it is fully out of
     sample and free of parameter-selection leakage.

A family "passes" only on OOS evidence: positive aggregate OOS return, OOS
Sharpe above a floor, controlled drawdown, and consistency across folds.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from engine import backtest, compute_metrics, Costs, Metrics, ANN
from strategies import Family


@dataclass
class Fold:
    train_start: str
    test_start: str
    test_end: str
    params: dict
    train_sharpe: float
    test_sharpe: float
    test_return: float
    test_max_dd: float
    test_days: int


@dataclass
class WFResult:
    asset: str
    family: str
    folds: list[Fold]
    oos: Metrics
    oos_equity: pd.Series = field(repr=False)
    oos_returns: pd.Series = field(repr=False)
    fold_pass_rate: float = 0.0
    avg_fold_test_sharpe: float = 0.0
    param_stability_pct: float = 0.0

    def summary(self) -> dict:
        return {
            "asset": self.asset,
            "family": self.family,
            "n_folds": len(self.folds),
            "oos_cagr": round(self.oos.cagr, 4),
            "oos_sharpe": round(self.oos.sharpe, 3),
            "oos_sortino": round(self.oos.sortino, 3),
            "oos_max_dd": round(self.oos.max_dd, 4),
            "oos_calmar": round(self.oos.calmar, 3),
            "oos_vol": round(self.oos.ann_vol, 4),
            "avg_exposure": round(self.oos.avg_exposure, 3),
            "ann_turnover": round(self.oos.ann_turnover, 2),
            "fold_pass_rate": round(self.fold_pass_rate, 3),
            "avg_fold_sharpe": round(self.avg_fold_test_sharpe, 3),
            "param_stability_pct": round(self.param_stability_pct, 2),
            "oos_days": self.oos.n_days,
        }


def _objective(m: Metrics, min_trades: int) -> float:
    """Train-window selection score. Reward risk-adjusted return, require the
    strategy to actually trade, and penalise blow-up drawdowns."""
    if m.n_days < 30 or m.n_trades < min_trades or m.avg_exposure <= 1e-6:
        return -1e9
    score = m.sharpe
    if m.max_dd < -0.5:
        score -= (abs(m.max_dd) - 0.5) * 2.0
    return score


def _param_stability(params: list[dict]) -> float:
    if len(params) < 2:
        return 0.0
    keys = {}
    for p in params:
        for k, v in p.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                keys.setdefault(k, []).append(float(v))
    max_dev = 0.0
    for k, vals in keys.items():
        if len(vals) < 2:
            continue
        mean = sum(vals) / len(vals)
        if mean == 0:
            continue
        for v in vals:
            dev = abs((v - mean) / mean) * 100.0
            max_dev = max(max_dev, dev)
    return max_dev


def walk_forward(
    asset: str,
    prices: pd.Series,
    family: Family,
    *,
    train_days: int = 540,
    test_days: int = 180,
    costs: Costs = Costs(),
    min_trades_train: int = 3,
) -> Optional[WFResult]:
    prices = prices.sort_index()
    # 1. precompute every param's full causal return series
    series: list[tuple[dict, pd.Series, pd.Series]] = []
    for p in family.grid:
        w = family.weights(prices, p)
        bt = backtest(prices, w, costs)
        series.append((p, bt["returns"], bt["held"]))
    if not series:
        return None

    idx = series[0][1].index
    if len(idx) == 0:
        return None
    start = idx[0]
    end = idx[-1]

    folds: list[Fold] = []
    oos_chunks: list[pd.Series] = []
    held_chunks: list[pd.Series] = []
    chosen_params: list[dict] = []

    train_td = pd.Timedelta(days=train_days)
    test_td = pd.Timedelta(days=test_days)
    train_start = start
    while train_start + train_td + test_td <= end + pd.Timedelta(days=1):
        train_lo = train_start
        train_hi = train_start + train_td
        test_hi = train_hi + test_td
        train_mask = (idx >= train_lo) & (idx < train_hi)
        test_mask = (idx >= train_hi) & (idx < test_hi)
        if test_mask.sum() < 20 or train_mask.sum() < 60:
            train_start += test_td
            continue

        best = None
        best_score = -np.inf
        for p, r, held in series:
            tr = r[train_mask]
            th = held[train_mask]
            m = compute_metrics(tr, th)
            sc = _objective(m, min_trades_train)
            if sc > best_score:
                best_score = sc
                best = (p, r, held, m)
        if best is None:
            train_start += test_td
            continue
        p, r, held, train_m = best
        test_r = r[test_mask]
        test_h = held[test_mask]
        test_m = compute_metrics(test_r, test_h)
        folds.append(Fold(
            train_start=str(train_lo.date()),
            test_start=str(train_hi.date()),
            test_end=str(test_hi.date()),
            params=p,
            train_sharpe=round(train_m.sharpe, 3),
            test_sharpe=round(test_m.sharpe, 3),
            test_return=round(test_m.total_return, 4),
            test_max_dd=round(test_m.max_dd, 4),
            test_days=test_m.n_days,
        ))
        oos_chunks.append(test_r)
        held_chunks.append(test_h)
        chosen_params.append(p)
        train_start += test_td

    if not oos_chunks:
        return None

    oos_returns = pd.concat(oos_chunks).sort_index()
    oos_returns = oos_returns[~oos_returns.index.duplicated(keep="first")]
    oos_held = pd.concat(held_chunks).sort_index()
    oos_held = oos_held[~oos_held.index.duplicated(keep="first")]
    oos_equity = (1.0 + oos_returns).cumprod()
    oos_m = compute_metrics(oos_returns, oos_held)

    fold_pass = np.mean([1.0 if f.test_return > 0 else 0.0 for f in folds]) if folds else 0.0
    avg_fold_sharpe = float(np.mean([f.test_sharpe for f in folds])) if folds else 0.0
    stability = _param_stability(chosen_params)

    return WFResult(
        asset=asset, family=family.name, folds=folds, oos=oos_m,
        oos_equity=oos_equity, oos_returns=oos_returns,
        fold_pass_rate=float(fold_pass), avg_fold_test_sharpe=avg_fold_sharpe,
        param_stability_pct=stability,
    )
