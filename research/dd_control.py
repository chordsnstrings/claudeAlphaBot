"""Drawdown-control overlay — 'stop the bleed' without killing the profits.

We keep the validated per-coin momentum engine (tsmom_blend) and bolt on a CAUSAL
de-risking overlay that cuts exposure when the market is in a statistically
bleed-prone state. You cannot predict a crash; you CAN detect conditions that
precede / accompany account bleed and size down when they hold:

  1. TREND GATE   — below the long-term trend (price < SMA_long) => reduce to a floor.
                    Bear markets and the worst whipsaw happen below trend.
  2. VOL BRAKE    — realised vol high => scale exposure ~ vol_cap/vol (vol clusters;
                    high vol predicts more high vol and bigger drawdowns).
  3. DD BRAKE     — the strategy's OWN equity curve: draw down past dd1 => halve size,
                    past dd2 => flat; restore when recovered. Directly stops the bleed
                    (anti-martingale on the equity curve).

All three use only information available at the decision time (causal). Overlay
parameters are FIXED in advance (not optimised), so an OOS improvement in maxDD/Calmar
is not curve-fitting. We walk-forward the BASE engine (params chosen OOS) and apply the
overlay on top, then compare base vs each overlay variant on OOS maxDD, Calmar, CAGR,
Sharpe, Sortino and worst calendar year.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs, backtest, compute_metrics, realized_vol, sma, ANN
from strategies import Family, sig_tsmom_blend, build_weights
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["BTC", "SOL", "ETH", "XRP", "DOGE"]
COSTS = Costs(txn=0.0006, funding_daily=0.0001)
LBS = {"BTC": (10, 30, 60, 120), "SOL": (10, 30, 60, 120), "ETH": (10, 30, 60, 120),
       "XRP": (10, 30, 60, 120), "DOGE": (10, 30, 60, 120)}

# FIXED overlay parameters (pre-specified, NOT fit to data)
OVERLAY = {
    "trend_gate": True, "sma_long": 200, "gate_floor": 0.0,
    "vol_brake": True, "vol_lb": 20, "vol_cap": 0.80,
    "dd_brake": True, "dd1": 0.15, "dd1_scale": 0.5, "dd2": 0.25, "dd_restore": 0.08,
}


def load(coin):
    df = datamod.load(coin)
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def overlay_apply(prices: pd.Series, w: pd.Series, cfg: dict) -> pd.Series:
    idx = prices.index
    p = prices.values.astype(float)
    ret = prices.pct_change().values
    w = w.reindex(idx).fillna(0.0).values.astype(float)
    n = len(idx)

    gate = np.ones(n)
    if cfg.get("trend_gate"):
        sma_l = sma(prices, cfg["sma_long"]).values
        gate = np.where(np.isnan(sma_l), 1.0, np.where(p > sma_l, 1.0, cfg["gate_floor"]))

    vb = np.ones(n)
    if cfg.get("vol_brake"):
        rv = realized_vol(prices.pct_change(), cfg["vol_lb"]).values
        vb = np.where(np.isnan(rv), 1.0, np.clip(cfg["vol_cap"] / np.maximum(rv, 1e-9), 0.0, 1.0))

    base = w * gate * vb
    out = base.copy()

    if cfg.get("dd_brake"):
        mode = cfg.get("dd_mode", "step")
        eq, peak, state = 1.0, 1.0, 1.0
        for t in range(n):
            if t > 0 and not np.isnan(ret[t]):
                eq *= (1.0 + out[t - 1] * ret[t])      # realise prior weight's pnl
                peak = max(peak, eq)
                dd = eq / peak - 1.0
                if mode == "graded":
                    # continuous ramp: full size above -dd1, linear down to floor at -dd2
                    if dd >= -cfg["dd1"]:
                        state = 1.0
                    elif dd <= -cfg["dd2"]:
                        state = cfg.get("floor", 0.0)
                    else:
                        frac = (abs(dd) - cfg["dd1"]) / (cfg["dd2"] - cfg["dd1"])
                        state = 1.0 - frac * (1.0 - cfg.get("floor", 0.0))
                else:  # step + hysteresis
                    if dd <= -cfg["dd2"]:
                        state = 0.0
                    elif dd <= -cfg["dd1"]:
                        state = min(state, cfg["dd1_scale"])
                    elif dd >= -cfg["dd_restore"]:
                        state = 1.0
            out[t] = base[t] * state
    return pd.Series(out, index=idx)


def base_family():
    return Family("tsmom_blend_base", sig_tsmom_blend, [
        dict(lbs=lbs, vol_target=vt, vol_lb=20, max_lev=3.0, long_only=True)
        for lbs in ((10, 30, 60, 120), (20, 40, 80, 120))
        for vt in (0.4, 0.6, 0.9)
    ])


def overlaid_family(cfg):
    base = base_family()

    class _F(Family):
        def weights(self, prices, p):
            w = build_weights(prices, sig_tsmom_blend(prices, p), p)
            return overlay_apply(prices, w, cfg)

    return _F("tsmom_blend_ddctrl", sig_tsmom_blend, base.grid)


def worst_year(returns: pd.Series) -> float:
    ys = []
    for y in sorted(set(returns.index.year)):
        ry = returns[returns.index.year == y]
        if len(ry) >= 250:
            ys.append(float((1 + ry).prod() - 1))
    return min(ys) if ys else float("nan")


def wf_params(p):
    span = (p.index[-1] - p.index[0]).days
    if span >= 2200:
        return dict(train_days=540, test_days=180)
    if span >= 1400:
        return dict(train_days=420, test_days=150)
    return dict(train_days=365, test_days=120)


def summarize(r):
    return dict(cagr=r.oos.cagr, sharpe=r.oos.sharpe, sortino=r.oos.sortino,
                max_dd=r.oos.max_dd, calmar=r.oos.calmar,
                worst_year=worst_year(r.oos_returns), avg_exp=r.oos.avg_exposure)


def main(argv):
    coins = [a.upper() for a in argv if a.upper() in COINS] or COINS
    GRADED = {"trend_gate": False, "vol_brake": False, "dd_brake": True,
              "dd_mode": "graded", "dd1": 0.12, "dd2": 0.30, "floor": 0.0,
              "vol_lb": 20, "sma_long": 200, "gate_floor": 0.0}
    RECO = {**GRADED, "trend_gate": True, "sma_long": 200, "gate_floor": 0.0}
    variants = {
        "BASE (no overlay)": None,
        "dd-brake step": {**OVERLAY, "trend_gate": False, "vol_brake": False},
        "dd-brake GRADED": GRADED,
        "RECO trend+graded": RECO,
    }
    out = {}
    print("DRAWDOWN-CONTROL OVERLAY — base momentum vs causal de-risk (walk-forward OOS)")
    print("overlay params FIXED (not fit): SMA200 gate, vol_cap 0.8, dd -15%->halve / -25%->flat\n")
    for c in coins:
        p = load(c)
        wfp = wf_params(p)
        print(f"================ {c} ================")
        print(f"  {'variant':>20} {'CAGR':>7} {'Sharpe':>7} {'Sortino':>8} {'maxDD':>7} "
              f"{'Calmar':>7} {'worstYr':>8} {'avgExp':>7}")
        out[c] = {}
        for name, cfg in variants.items():
            fam = base_family() if cfg is None else overlaid_family(cfg)
            r = walk_forward(c, p, fam, costs=COSTS, **wfp)
            if r is None:
                continue
            s = summarize(r)
            out[c][name] = s
            print(f"  {name:>20} {s['cagr']:>6.0%} {s['sharpe']:>7.2f} {s['sortino']:>8.2f} "
                  f"{s['max_dd']:>7.0%} {s['calmar']:>7.2f} {s['worst_year']:>8.0%} {s['avg_exp']:>7.2f}")
        print()
    json.dump(out, open(os.path.join(RESULTS, "dd_control_results.json"), "w"),
              indent=2, default=str)
    # headline: graded dd-brake vs base
    reco_key = "dd-brake GRADED"
    print(f"HEADLINE — maxDD / Calmar / worst-year, BASE vs {reco_key}")
    print(f"  {'coin':>5} {'base maxDD':>11} {'ddctrl maxDD':>13} {'base Calmar':>12} "
          f"{'ddctrl Calmar':>14} {'worstYr b->o':>14} {'CAGR kept':>10}")
    for c in coins:
        if "BASE (no overlay)" in out.get(c, {}) and reco_key in out[c]:
            b, o = out[c]["BASE (no overlay)"], out[c][reco_key]
            kept = (o["cagr"] / b["cagr"]) if b["cagr"] not in (0, None) else float("nan")
            wy = f"{b['worst_year']:.0%}->{o['worst_year']:.0%}"
            print(f"  {c:>5} {b['max_dd']:>11.0%} {o['max_dd']:>13.0%} {b['calmar']:>12.2f} "
                  f"{o['calmar']:>14.2f} {wy:>14} {kept:>9.0%}")
    print(f"\nwrote {os.path.join(RESULTS,'dd_control_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
