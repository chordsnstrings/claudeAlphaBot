"""Cross-sectional (relative-value) momentum on the 5-coin panel.

A structurally different return source from the absolute time-series trend book:
instead of "is THIS coin trending up?", ask "which coins are strongest RIGHT NOW?"
and rotate into them. This can earn in years where the market is flat *in
aggregate* but has dispersion (e.g. 2023: SOL ran while others lagged), which is
exactly when the absolute-trend book sits in cash.

Design (daily, causal, walk-forward OOS):
  * panel = aligned daily closes of SOL ETH BTC DOGE XRP.
  * score[i,t] = blended trailing return over `lbs` lookbacks (rank signal).
  * long-only-top-k: hold the top-k coins (equal weight); cash otherwise.
    long/short-k: long top-k, short bottom-k (market-neutral-ish).
  * vol-target the resulting basket return to `vol_target` annualised, cap `max_lev`.
  * costs: 6 bps/turnover + funding; turnover from daily weight changes.
  * walk-forward: pick (lbs, k, mode, vol_target) on each train window by Sharpe,
    apply on the next unseen test window, stitch the OOS return stream.
  * apply the annual +50% profit-lock and report calendar-year hit-rate.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import ANN, realized_vol
from annual_target import simulate_year, TARGET

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
STOP = 0.40
TXN = 0.0006
FUNDING = 0.0001
VOL_FLOOR = 0.10


def panel() -> pd.DataFrame:
    cols = {}
    for c in COINS:
        df = datamod.load(c)
        s = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
        cols[c] = s[~s.index.duplicated(keep="first")].sort_index()
    p = pd.DataFrame(cols).sort_index()
    return p


def xs_returns(prices: pd.DataFrame, lbs, k: int, mode: str,
               vol_target: float, max_lev: float) -> pd.Series:
    """Causal cross-sectional momentum daily net return series."""
    rets = prices.pct_change()
    # blended momentum score across lookbacks
    score = sum(np.sign(prices / prices.shift(L) - 1.0) * (prices / prices.shift(L) - 1.0)
                for L in lbs) / float(len(lbs))
    # ranks per day among coins that have a valid score
    ranks = score.rank(axis=1, ascending=False, method="first")
    n_valid = score.notna().sum(axis=1)
    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    long_mask = ranks.le(k) & score.notna()
    w = w.mask(long_mask, 1.0)
    if mode == "ls":
        short_mask = ranks.gt(n_valid.values[:, None] - k) & score.notna()
        w = w.mask(short_mask, -1.0)
    # normalise to gross 1 across active legs
    gross = w.abs().sum(axis=1).replace(0.0, np.nan)
    w = w.div(gross, axis=0).fillna(0.0)
    # basket daily gross return (weights set at close t, earned t+1)
    held = w.shift(1).fillna(0.0)
    basket = (held * rets).sum(axis=1)
    # vol-target the basket
    rv = realized_vol(basket, 30).clip(lower=VOL_FLOOR)
    scale = (vol_target / rv).clip(upper=max_lev).fillna(0.0)
    # turnover cost on the (scaled) weights
    sw = w.mul(scale, axis=0)
    held_s = sw.shift(1).fillna(0.0)
    turn = held_s.diff().abs().sum(axis=1).fillna(held_s.abs().sum(axis=1))
    net = (held_s * rets).sum(axis=1) - TXN * turn - FUNDING * held_s.abs().sum(axis=1)
    return net.dropna()


def grid():
    out = []
    for lbs in ((20, 40, 80), (10, 30, 60), (30, 60, 120)):
        for k in (1, 2):
            for mode in ("long", "ls"):
                for vt in (0.4, 0.6, 0.9):
                    out.append(dict(lbs=lbs, k=k, mode=mode, vol_target=vt, max_lev=3.0))
    return out


def sharpe(r: pd.Series) -> float:
    r = r.dropna()
    if len(r) < 30 or r.std(ddof=0) == 0:
        return -1e9
    return float(r.mean() / r.std(ddof=0) * np.sqrt(ANN))


def walk_forward_xs(prices: pd.DataFrame, train_days=540, test_days=180) -> pd.Series:
    params = grid()
    series = {id(p): xs_returns(prices, **p) for p in params}
    idx = next(iter(series.values())).index
    for s in series.values():
        idx = idx.union(s.index)
    idx = idx.sort_values()
    start, end = idx[0], idx[-1]
    chunks = []
    train_td = pd.Timedelta(days=train_days)
    test_td = pd.Timedelta(days=test_days)
    t0 = start
    while t0 + train_td + test_td <= end + pd.Timedelta(days=1):
        tr_lo, tr_hi, te_hi = t0, t0 + train_td, t0 + train_td + test_td
        best, best_sc = None, -np.inf
        for p in params:
            r = series[id(p)]
            tr = r[(r.index >= tr_lo) & (r.index < tr_hi)]
            sc = sharpe(tr)
            if sc > best_sc:
                best_sc, best = sc, p
        if best is not None:
            r = series[id(best)]
            te = r[(r.index >= tr_hi) & (r.index < te_hi)]
            if len(te) > 10:
                chunks.append(te)
        t0 += test_td
    if not chunks:
        return pd.Series(dtype=float)
    oos = pd.concat(chunks).sort_index()
    return oos[~oos.index.duplicated(keep="first")]


def main(argv):
    p = panel()
    print(f"Cross-sectional momentum panel: {list(p.columns)}  "
          f"{p.index[0].date()} -> {p.index[-1].date()}")
    oos = walk_forward_xs(p)
    if oos.empty:
        print("no OOS stream produced")
        return 1
    eq = (1.0 + oos).prod()
    cagr = eq ** (ANN / len(oos)) - 1.0
    shp = sharpe(oos)
    print(f"OOS: CAGR={cagr:+.1%}  Sharpe={shp:.2f}  days={len(oos)}")

    m_grid = [1, 2, 3, 5]
    print(f"\n{'m':>4} {'banked>=50%':>12} {'hit':>6} {'avgYr':>7} {'worstYr':>8}")
    best = None
    rows = []
    for m in m_grid:
        per_year = []
        for y in sorted(set(oos.index.year)):
            ry = oos[oos.index.year == y]
            if len(ry) < 250:
                continue
            per_year.append((int(y), simulate_year(ry.values, m, TARGET, STOP)))
        if not per_year:
            continue
        rs = np.array([r for _, r in per_year])
        banked = int((rs >= TARGET - 1e-9).sum())
        e = dict(m=m, banked=banked, full_years=len(per_year),
                 hit_rate=round(banked/len(per_year), 3),
                 avg_year=round(float(rs.mean()), 4),
                 worst_year=round(float(rs.min()), 4),
                 per_year=per_year)
        rows.append(e)
        print(f"{m:>4} {str(banked)+'/'+str(len(per_year)):>12} {e['hit_rate']:>6.0%} "
              f"{e['avg_year']:>7.0%} {e['worst_year']:>8.0%}")
        if best is None or (e["hit_rate"], e["avg_year"]) > (best["hit_rate"], best["avg_year"]):
            if e["worst_year"] >= -0.55:
                best = e
    if best:
        print(f"\n>>> best m={best['m']}: {best['banked']}/{best['full_years']} years "
              f"({best['hit_rate']:.0%}), worst {best['worst_year']:+.0%}")
        print("    per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in best["per_year"]))
    with open(os.path.join(RESULTS, "xsection_results.json"), "w") as f:
        json.dump({"cagr": cagr, "sharpe": shp, "sweep": rows, "best": best},
                  f, indent=2, default=str)
    oos.to_csv(os.path.join(RESULTS, "xsection_oos_daily.csv"))
    print(f"\nwrote {os.path.join(RESULTS, 'xsection_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
