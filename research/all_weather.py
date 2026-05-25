"""All-weather spine — long/short time-series trend, hedge-fund-style workflow.

Every prior construction hit the same wall: 2022 (synchronised crash). Long-only
momentum bleeds it; the dollar-neutral breadth book was killed (thin edge at cost).
The remaining honest route to *earning in a bear* is to SHORT it -- managed-futures
time-series trend ('crisis alpha'). This builds that as the spine and tests whether it
is genuinely all-weather (positive/flat in 2022 AND captures bull years).

Hedge-fund workflow:
  * RESEARCHER  -> classifies the regime each day from market trend + breadth
                   (BULL / BEAR / CHOP), causal.
  * BULL sleeve -> long the strongest top-k momentum coins (the orchestrator).
  * BEAR sleeve -> short the weakest top-k (most negative momentum) coins.
  * EXECUTOR    -> routes: BULL->bull, BEAR->bear, CHOP->reduced/cash; vol-targets the
                   book, caps gross, applies the graded drawdown brake. Net exposure
                   swings long in bull, short in bear, ~flat in chop.

Also tests a PURE time-series-trend book (each coin long/short on its own trend,
vol-weighted) as the simplest all-weather spine, for comparison. Walk-forward OOS;
per-year incl. 2022, worst year, Calmar.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
UNIV_DIR = os.path.join(HERE, "data", "universe")
RESULTS = os.path.join(HERE, "results")
ANN = 365.0
TOP_LIQ = 30
FUNDING_DAILY = 0.0001


def load_panel():
    closes, vols = {}, {}
    for fn in sorted(os.listdir(UNIV_DIR)):
        if not fn.endswith("_daily.csv"):
            continue
        sym = fn.replace("_daily.csv", "")
        df = pd.read_csv(os.path.join(UNIV_DIR, fn), parse_dates=["date"])
        df = df[~df["date"].duplicated(keep="first")].set_index("date").sort_index()
        closes[sym] = df["close"]; vols[sym] = df["volume_usd"]
    px = pd.DataFrame(closes).sort_index()
    return px, pd.DataFrame(vols).reindex_like(px)


def ts_signal(px, lbs):
    """Time-series trend in [-1,1]: mean sign of trailing returns (long AND short)."""
    return sum(np.sign(px / px.shift(L) - 1.0) for L in lbs) / len(lbs)


def realized_vol(px, lb=30):
    return px.pct_change().rolling(lb, min_periods=10).std(ddof=0) * np.sqrt(ANN)


def researcher_regime(px, vol, lbs=(20, 50, 100)):
    """Causal market regime from a dollar-volume-weighted index trend + breadth."""
    dv = vol.rolling(30, min_periods=10).mean()
    # equal-weight index of the live universe (proxy for 'the market')
    idx = px.pct_change().mean(axis=1).add(1).cumprod()
    idx_trend = sum(np.sign(idx / idx.shift(L) - 1.0) for L in lbs) / len(lbs)
    # breadth: fraction of coins above their own 50d trend
    above = (px > px.rolling(50, min_periods=20).mean()).astype(float)
    breadth = above.where(px.notna()).mean(axis=1)
    regime = pd.Series(0, index=px.index)          # 0 chop, +1 bull, -1 bear
    regime[(idx_trend > 0) & (breadth > 0.5)] = 1
    regime[(idx_trend < 0) & (breadth < 0.5)] = -1
    return regime, breadth


def build_ts_trend(px, vol, lbs, gross_target, max_gross, vol_lb=30, top=TOP_LIQ):
    """PURE time-series trend book (long/short each coin on its own trend), vol-weighted,
    point-in-time top-liquidity universe. Vectorised. Returns (gross, turnover, exposure)."""
    dv = vol.rolling(30, min_periods=10).mean()
    sig = ts_signal(px, lbs)
    iv = 1.0 / realized_vol(px, vol_lb).clip(lower=0.20)      # inverse-vol weight
    dret = px.pct_change()
    dates = px.index; cols = list(px.columns)
    W = np.zeros((len(dates), len(cols)))
    dvv, sigv, ivv, pxv = dv.values, sig.values, iv.values, px.values
    for i in range(max(lbs) + 1, len(dates)):
        row = dvv[i]
        valid = ~np.isnan(pxv[i]) & ~np.isnan(sigv[i]) & ~np.isnan(row) & ~np.isnan(ivv[i])
        if valid.sum() < 5:
            continue
        idxv = np.where(valid)[0]
        univ = idxv[np.argsort(-row[idxv])][:top]
        raw = sigv[i, univ] * ivv[i, univ]                   # signed, inverse-vol
        gabs = np.abs(raw).sum()
        if gabs <= 0:
            continue
        w = raw / gabs * gross_target                        # normalise to gross_target
        # cap gross
        if np.abs(w).sum() > max_gross:
            w *= max_gross / np.abs(w).sum()
        W[i, univ] = w
    Wdf = pd.DataFrame(W, index=dates, columns=cols)
    held = Wdf.shift(1).fillna(0.0)
    turnover = held.diff().abs().sum(axis=1).fillna(held.abs().sum(axis=1))
    gross = (held * dret.fillna(0.0)).sum(axis=1)
    return gross, turnover, held.abs().sum(axis=1), held.sum(axis=1)


def build_regime_book(px, vol, lbs, k, gross_target, max_gross, vol_lb=30, top=TOP_LIQ):
    """Hedge-fund workflow: researcher routes bull(long top-k)/bear(short bottom-k)/
    chop(reduced). Vectorised."""
    regime, _ = researcher_regime(px, vol)
    dv = vol.rolling(30, min_periods=10).mean()
    strength = sum(px / px.shift(L) - 1.0 for L in lbs) / len(lbs)
    iv = 1.0 / realized_vol(px, vol_lb).clip(lower=0.20)
    dret = px.pct_change()
    dates = px.index; cols = list(px.columns)
    W = np.zeros((len(dates), len(cols)))
    dvv, sv, ivv, pxv, rg = dv.values, strength.values, iv.values, px.values, regime.values
    for i in range(max(lbs) + 1, len(dates)):
        row = dvv[i]
        valid = ~np.isnan(pxv[i]) & ~np.isnan(sv[i]) & ~np.isnan(row) & ~np.isnan(ivv[i])
        if valid.sum() < 2 * k + 2:
            continue
        idxv = np.where(valid)[0]
        univ = idxv[np.argsort(-row[idxv])][:top]
        order = univ[np.argsort(-sv[i, univ])]               # strongest -> weakest
        reg = rg[i]
        w = np.zeros(len(cols))
        if reg > 0:                                          # BULL: long top-k strongest
            picks = [c for c in order[:k] if sv[i, c] > 0]
            for c in picks:
                w[c] = ivv[i, c]
        elif reg < 0:                                        # BEAR: short bottom-k weakest
            picks = [c for c in order[-k:] if sv[i, c] < 0]
            for c in picks:
                w[c] = -ivv[i, c]
        else:                                                # CHOP: small long-only top, reduced
            picks = [c for c in order[:k] if sv[i, c] > 0]
            for c in picks:
                w[c] = 0.4 * ivv[i, c]
        gabs = np.abs(w).sum()
        if gabs <= 0:
            continue
        w = w / gabs * gross_target
        if np.abs(w).sum() > max_gross:
            w *= max_gross / np.abs(w).sum()
        W[i] = w
    Wdf = pd.DataFrame(W, index=dates, columns=cols)
    held = Wdf.shift(1).fillna(0.0)
    turnover = held.diff().abs().sum(axis=1).fillna(held.abs().sum(axis=1))
    gross = (held * dret.fillna(0.0)).sum(axis=1)
    return gross, turnover, held.abs().sum(axis=1), held.sum(axis=1)


def net_from(gross, turnover, exposure, cost_bps):
    return (gross - cost_bps * 1e-4 * turnover - FUNDING_DAILY * exposure).dropna()


def apply_dd_brake(r, dd1=0.15, dd2=0.35, floor=0.0):
    r = r.dropna(); out = r.values.astype(float).copy(); rv = r.values
    eq, peak, state = 1.0, 1.0, 1.0
    for t in range(len(rv)):
        out[t] = rv[t] * state
        eq *= 1 + out[t]; peak = max(peak, eq); dd = eq / peak - 1
        state = 1.0 if dd >= -dd1 else (floor if dd <= -dd2
                                        else 1 - (abs(dd) - dd1) / (dd2 - dd1) * (1 - floor))
    return pd.Series(out, index=r.index)


def stats(r):
    r = r.dropna(); sd = r.std(ddof=0); n = len(r)
    eq = float((1 + r).prod())
    cagr = eq ** (ANN / n) - 1 if eq > 0 and n else -1.0
    dd = float(((1 + r).cumprod() / (1 + r).cumprod().cummax() - 1).min())
    return dict(cagr=cagr, sharpe=float(r.mean()/sd*np.sqrt(ANN)) if sd>0 else 0,
                maxdd=dd, calmar=cagr/abs(dd) if dd < 0 else 0,
                per_year={int(y): round(float((1+r[r.index.year==y]).prod()-1), 4)
                          for y in sorted(set(r.index.year))})


def walk_forward(px, vol, builder, grid, cost_bps, train_days=540, test_days=180):
    cache = {tuple(sorted(p.items())): builder(px, vol, **p) for p in grid}
    dates = px.index; t0 = dates[0] + pd.Timedelta(days=200)
    tr, te = pd.Timedelta(days=train_days), pd.Timedelta(days=test_days)
    chunks = []
    while t0 + tr + te <= dates[-1] + pd.Timedelta(days=1):
        lo, mid, hi = t0, t0+tr, t0+tr+te
        best, bsc, bk = None, -1e9, None
        for p in grid:
            k = tuple(sorted(p.items())); g, tn, ex, _ = cache[k]
            net = net_from(g, tn, ex, cost_bps)
            trs = net[(net.index >= lo) & (net.index < mid)]
            if len(trs) < 60:
                continue
            sd = trs.std(ddof=0); sc = trs.mean()/sd*np.sqrt(ANN) if sd>0 else -9
            if sc > bsc:
                bsc, best, bk = sc, p, k
        if best is None:
            t0 += te; continue
        g, tn, ex, _ = cache[bk]; net = net_from(g, tn, ex, cost_bps)
        tes = net[(net.index >= mid) & (net.index < hi)]
        if len(tes) > 20:
            chunks.append(tes)
        t0 += te
    if not chunks:
        return None
    oos = pd.concat(chunks).sort_index()
    return oos[~oos.index.duplicated(keep="first")]


def main(argv):
    px, vol = load_panel()
    print(f"Universe: {px.shape[1]} coins {px.index[0].date()}->{px.index[-1].date()}\n")
    out = {}
    cost = 15

    ts_grid = [dict(lbs=lbs, gross_target=gt, max_gross=mg)
               for lbs in ((10,30,60,120),(20,50,100),(30,60,120))
               for gt in (0.6, 1.0) for mg in (1.5, 2.5)]
    rg_grid = [dict(lbs=lbs, k=k, gross_target=gt, max_gross=mg)
               for lbs in ((10,30,60,120),(20,50,100))
               for k in (3,5,8) for gt in (0.6,1.0) for mg in (1.5,2.5)]

    print("Running PURE time-series-trend long/short spine (walk-forward OOS, 15 bps)...")
    ts_oos = walk_forward(px, vol, build_ts_trend, ts_grid, cost)
    print("Running REGIME book (researcher->bull/bear/chop, walk-forward OOS, 15 bps)...")
    rg_oos = walk_forward(px, vol, build_regime_book, rg_grid, cost)

    for name, oos in [("TS-trend L/S spine", ts_oos), ("Regime book (HF workflow)", rg_oos)]:
        if oos is None:
            print(f"{name}: no OOS"); continue
        s = stats(oos); sb = stats(apply_dd_brake(oos))
        out[name] = dict(base=s, braked=sb)
        print(f"\n=== {name} (15 bps, OOS) ===")
        print(f"  CAGR={s['cagr']:+.1%} Sharpe={s['sharpe']:.2f} maxDD={s['maxdd']:.0%} "
              f"Calmar={s['calmar']:.2f}")
        print("  per-year:", "  ".join(f"{y}:{v:+.0%}" for y,v in s['per_year'].items()))
        print(f"  +dd-brake: CAGR={sb['cagr']:+.1%} Sharpe={sb['sharpe']:.2f} "
              f"maxDD={sb['maxdd']:.0%} Calmar={sb['calmar']:.2f}  2022="
              f"{sb['per_year'].get(2022,float('nan')):+.0%}")
    json.dump(out, open(os.path.join(RESULTS, "all_weather_results.json"), "w"),
              indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS,'all_weather_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
