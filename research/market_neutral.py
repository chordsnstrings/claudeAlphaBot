"""Dollar-neutral cross-sectional long/short (stat-arb) — the market-neutral posture.

The 2022 wall exists because every directional sleeve must be net-long (loses the
crash) or net-short (loses the 2023 recovery). A DOLLAR-NEUTRAL book escapes that:
equal long and short legs, so it is indifferent to market direction and earns from
*dispersion* among the five coins. In 2022 SOL fell ~94% while BTC fell ~64%, so a
neutral book (short the weak, long the strong — or the reverse) could be positive in
the crash AND not get run over by the 2023 recovery. This is a standard quant
approach, not a fit to 2022, so it is the honest last posture to test.

Two cross-sectional signals (causal, walk-forward OOS):
  * momentum:  long highest trailing-return coins, short lowest  (trend in the cross-section)
  * reversal:  long lowest, short highest                        (mean-rev in the cross-section)
Legs are dollar-neutral (sum of weights = 0), gross normalised to 1, then
vol-targeted. We report per-year returns (esp. 2022) and the profit-lock hit-rate,
and whether blending a neutral sleeve with the 9/10 up-engine banks 2022 too.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import annual_target as at
from annual_target import simulate_year, TARGET
from engine import ANN, realized_vol, Costs
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
STOP = 0.40
TXN, FUNDING = 0.0006, 0.0001


def panel() -> pd.DataFrame:
    cols = {}
    for c in COINS:
        p = at.load_prices(c)
        cols[c] = p
    return pd.DataFrame(cols).sort_index()


def mn_returns(prices: pd.DataFrame, lbs, k: int, sign: float, vt: float, ml: float) -> pd.Series:
    """Dollar-neutral long/short. sign=+1 momentum (long winners), -1 reversal."""
    rets = prices.pct_change()
    score = sum(prices / prices.shift(L) - 1.0 for L in lbs) / float(len(lbs)) * sign
    ranks_hi = score.rank(axis=1, ascending=False, method="first")   # 1 = best score
    ranks_lo = score.rank(axis=1, ascending=True, method="first")
    valid = score.notna()
    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    w = w.mask(ranks_hi.le(k) & valid, 1.0)     # long top-k
    w = w.mask(ranks_lo.le(k) & valid, -1.0)    # short bottom-k
    # dollar-neutral: demean across active names each day, then gross-normalise to 1
    active = w.abs().sum(axis=1).replace(0.0, np.nan)
    w = w.sub(w.mean(axis=1), axis=0).where(w != 0, 0.0)
    gross = w.abs().sum(axis=1).replace(0.0, np.nan)
    w = w.div(gross, axis=0).fillna(0.0)
    held = w.shift(1).fillna(0.0)
    basket = (held * rets).sum(axis=1)
    rv = realized_vol(basket, 30).clip(lower=0.10)
    scale = (vt / rv).clip(upper=ml).fillna(0.0)
    sw = w.mul(scale, axis=0)
    held_s = sw.shift(1).fillna(0.0)
    turn = held_s.diff().abs().sum(axis=1).fillna(held_s.abs().sum(axis=1))
    net = (held_s * rets).sum(axis=1) - TXN * turn - FUNDING * held_s.abs().sum(axis=1)
    return net.dropna()


def wf_mn(prices, sign, train_days=540, test_days=180) -> pd.Series:
    grid = [dict(lbs=lbs, k=k, sign=sign, vt=vt, ml=3.0)
            for lbs in ((20, 40, 80), (10, 30, 60), (30, 60, 120))
            for k in (1, 2)
            for vt in (0.3, 0.5, 0.8)]
    series = {i: mn_returns(prices, **{kk: vv for kk, vv in p.items()}) for i, p in enumerate(grid)}
    idx = None
    for s in series.values():
        idx = s.index if idx is None else idx.union(s.index)
    idx = idx.sort_values()
    start, end = idx[0], idx[-1]
    chunks = []
    t0 = start
    tr = pd.Timedelta(days=train_days); te = pd.Timedelta(days=test_days)
    while t0 + tr + te <= end + pd.Timedelta(days=1):
        lo, mid, hi = t0, t0 + tr, t0 + tr + te
        best, bsc = None, -np.inf
        for i, p in enumerate(grid):
            r = series[i]
            trs = r[(r.index >= lo) & (r.index < mid)]
            if len(trs) < 60 or trs.std(ddof=0) == 0:
                continue
            sc = trs.mean() / trs.std(ddof=0) * np.sqrt(ANN)
            if sc > bsc:
                bsc, best = sc, i
        if best is not None:
            r = series[best]
            tes = r[(r.index >= mid) & (r.index < hi)]
            if len(tes) > 10:
                chunks.append(tes)
        t0 += te
    if not chunks:
        return pd.Series(dtype=float)
    oos = pd.concat(chunks).sort_index()
    return oos[~oos.index.duplicated(keep="first")]


def year_table(stream, m):
    out = []
    for y in sorted(set(stream.index.year)):
        ry = stream[stream.index.year == y]
        if len(ry) < 250:
            continue
        out.append((int(y), simulate_year(ry.values, m, TARGET, STOP)))
    return out


def main(argv):
    pr = panel()
    print("DOLLAR-NEUTRAL CROSS-SECTIONAL LONG/SHORT (walk-forward OOS)")
    streams = {}
    for sign, name in ((1.0, "xs_momentum_ls"), (-1.0, "xs_reversal_ls")):
        oos = wf_mn(pr, sign)
        streams[name] = oos
        # raw yearly (no lock) to see 2022 directly
        raw = {y: float((1 + oos[oos.index.year == y]).prod() - 1)
               for y in sorted(set(oos.index.year)) if (oos.index.year == y).sum() >= 250}
        shp = oos.mean() / oos.std(ddof=0) * np.sqrt(ANN) if oos.std(ddof=0) else 0
        print(f"\n{name}: OOS Sharpe={shp:.2f}")
        print("  raw per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in raw.items()))
        # best lock hit-rate
        best = None
        for m in (1, 2, 3, 5):
            ys = year_table(oos, m)
            rs = np.array([r for _, r in ys])
            banked = int((rs >= TARGET - 1e-9).sum())
            if rs.min() >= -0.55 and (best is None or banked > best[0]):
                best = (banked, len(ys), m, ys)
        if best:
            print(f"  +50% lock best m={best[2]}: {best[0]}/{best[1]} years; "
                  f"2022={dict(best[3]).get(2022,0):+.0%}")

    # blend the better neutral sleeve with the up-engine, check 2022
    up = pd.DataFrame({c: at.best_returns(c)[0] for c in COINS}).mean(axis=1).dropna()
    xb = pd.read_csv(os.path.join(RESULTS, "xsection_oos_daily.csv"),
                     index_col=0, parse_dates=True).iloc[:, 0]
    ui = up.index.union(xb.index)
    up_engine = 0.6 * up.reindex(ui).fillna(0) + 0.4 * xb.reindex(ui).fillna(0)
    print(f"\n{'='*78}\nBLEND up-engine + neutral sleeve (check if 2022 banks)")
    best_blend = None
    for name, s in streams.items():
        allidx = up_engine.index.union(s.index)
        U = up_engine.reindex(allidx).fillna(0.0)
        N = s.reindex(allidx).fillna(0.0)
        for w in (0.2, 0.3, 0.4, 0.5):
            comb = (1 - w) * U + w * N
            for m in (1, 2, 3):
                ys = year_table(comb, m)
                rs = np.array([r for _, r in ys])
                if rs.min() < -0.55:
                    continue
                banked = int((rs >= TARGET - 1e-9).sum())
                if best_blend is None or banked > best_blend[0]:
                    best_blend = (banked, len(ys), name, w, m, ys)
    if best_blend:
        b, n, name, w, m, ys = best_blend
        print(f"best: {name} w={w} m={m} -> {b}/{n} years; "
              f"2022={dict(ys).get(2022,0):+.0%}")
        print("  per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in ys))
    json.dump({"best_blend_banked": best_blend[0] if best_blend else None,
               "n": best_blend[1] if best_blend else None},
              open(os.path.join(RESULTS, "market_neutral_results.json"), "w"), indent=2)


if __name__ == "__main__":
    main(sys.argv[1:])
