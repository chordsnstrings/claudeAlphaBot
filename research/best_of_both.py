"""Best-of-both-worlds engine: regime-routed long-only (bull) + short trend (bear).

Combines the two validated engines under a hedge-fund 'researcher' that nowcasts the
market regime and routes:
  * BULL  -> long-only momentum orchestrator (captures the +45% bull upside)
  * BEAR  -> short the weakest (crisis alpha; earns in 2022 where long-only bleeds)
  * CHOP  -> reduced long-only (small risk-on; crypto drifts up in chop, but de-risked)

RESEARCHER (regime nowcast, causal, with HYSTERESIS to avoid the whipsaw that wrecked
the raw regime book): combines
  * market trend  -- multi-lookback sign of a dollar-volume-weighted index,
  * breadth       -- fraction of coins above their own 50d trend,
  * volatility    -- index realised vol percentile (high vol = risk-off sentiment).
A regime only flips when the trend crosses a +/-band AND breadth confirms; otherwise
it persists (sticky), so the router does not flip-flop on noise.

Not forecasting -- this is regime *classification* (nowcasting) from price/breadth/vol,
the causal proxy for sentiment. External feeds (funding, social) are not reachable here.

EXECUTOR: vol-targets the routed book, caps gross, optional graded drawdown brake.
Walk-forward OOS; compares per-year (esp. 2022) to long-only-alone and spine-alone.
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


def researcher(px, vol, trend_lbs=(20, 50, 100), band=0.0, vol_lookback=30, vol_pct=0.85):
    """Causal regime nowcast with hysteresis. Returns int series: +1 bull, 0 chop, -1 bear."""
    idx = px.pct_change().mean(axis=1).add(1.0).cumprod()
    idx_trend = sum(np.sign(idx / idx.shift(L) - 1.0) for L in trend_lbs) / len(trend_lbs)
    above = (px > px.rolling(50, min_periods=20).mean()).astype(float).where(px.notna())
    breadth = above.mean(axis=1)
    iv = idx.pct_change().rolling(vol_lookback, min_periods=10).std(ddof=0)
    iv_hi = iv > iv.rolling(365, min_periods=60).quantile(vol_pct)    # vol spike = risk-off
    n = len(px)
    it, bl, vh = idx_trend.values, breadth.values, iv_hi.values
    reg = np.zeros(n)
    state = 0
    for t in range(n):
        if np.isnan(it[t]) or np.isnan(bl[t]):
            reg[t] = state; continue
        # sticky transitions with confirmation
        if it[t] > band and bl[t] > 0.55 and not vh[t]:
            state = 1
        elif it[t] < -band and bl[t] < 0.45:
            state = -1
        elif vh[t] and bl[t] < 0.5:
            state = -1                       # vol spike + weak breadth => risk-off/bear
        elif -band <= it[t] <= band or (0.45 <= bl[t] <= 0.55):
            if state == 1 and (it[t] < -band or bl[t] < 0.40):
                state = 0
            elif state == -1 and (it[t] > band or bl[t] > 0.60):
                state = 0
            # else keep state (hysteresis)
        reg[t] = state
    return pd.Series(reg, index=px.index), breadth


def realized_vol(px, lb=30):
    return px.pct_change().rolling(lb, min_periods=10).std(ddof=0) * np.sqrt(ANN)


def build_best_of_both(px, vol, sig_lbs, k, gross_target, max_gross, rebal,
                       chop_scale=0.4, trend_lbs=(20, 50, 100), band=0.0):
    reg, _ = researcher(px, vol, trend_lbs=trend_lbs, band=band)
    dv = vol.rolling(30, min_periods=10).mean()
    strength = sum(px / px.shift(L) - 1.0 for L in sig_lbs) / len(sig_lbs)
    iv = 1.0 / realized_vol(px, 30).clip(lower=0.20)
    dret = px.pct_change()
    dates = px.index; cols = list(px.columns)
    W = np.zeros((len(dates), len(cols)))
    dvv, sv, ivv, pxv, rg = dv.values, strength.values, iv.values, px.values, reg.values
    for i in range(max(max(sig_lbs), 100) + 1, len(dates), rebal):
        row = dvv[i]
        valid = ~np.isnan(pxv[i]) & ~np.isnan(sv[i]) & ~np.isnan(row) & ~np.isnan(ivv[i])
        if valid.sum() < 2 * k + 2:
            continue
        idxv = np.where(valid)[0]
        univ = idxv[np.argsort(-row[idxv])][:TOP_LIQ]
        order = univ[np.argsort(-sv[i, univ])]               # strongest..weakest
        j = min(i + rebal, len(dates))
        reg_i = rg[i]
        w = np.zeros(len(cols))
        if reg_i > 0:                                        # BULL: long-only orchestrator
            picks = [c for c in order[:k] if sv[i, c] > 0]
            for c in picks:
                w[c] = ivv[i, c]
        elif reg_i < 0:                                      # BEAR: short the weakest
            picks = [c for c in order[-k:] if sv[i, c] < 0]
            for c in picks:
                w[c] = -ivv[i, c]
        else:                                                # CHOP: reduced long-only
            picks = [c for c in order[:k] if sv[i, c] > 0]
            for c in picks:
                w[c] = chop_scale * ivv[i, c]
        gabs = np.abs(w).sum()
        if gabs <= 0:
            continue
        w = w / gabs * (gross_target if reg_i != 0 else gross_target * chop_scale)
        if np.abs(w).sum() > max_gross:
            w *= max_gross / np.abs(w).sum()
        W[i:j] = w
    Wdf = pd.DataFrame(W, index=dates, columns=cols)
    held = Wdf.shift(1).fillna(0.0)
    turnover = held.diff().abs().sum(axis=1).fillna(held.abs().sum(axis=1))
    gross = (held * dret.fillna(0.0)).sum(axis=1)
    return gross, turnover, held.abs().sum(axis=1), held.sum(axis=1)


def build_soft_blend(px, vol, sig_lbs, k, gross_spine, gross_long, max_gross, rebal,
                     trend_lbs=(20, 50, 100), band=0.0):
    """SOFT blend (no hard switch): always run the L/S trend spine; ADD a long-only
    overlay scaled by bull conviction. tilt = 1 in BULL, 0.5 in CHOP, 0 in BEAR.
    Spine keeps it all-weather (2022 positive, no whipsaw); overlay amplifies bull years."""
    reg, _ = researcher(px, vol, trend_lbs=trend_lbs, band=band)
    dv = vol.rolling(30, min_periods=10).mean()
    ts = sum(np.sign(px / px.shift(L) - 1.0) for L in sig_lbs) / len(sig_lbs)   # L/S spine signal
    strength = sum(px / px.shift(L) - 1.0 for L in sig_lbs) / len(sig_lbs)       # for long ranking
    iv = 1.0 / realized_vol(px, 30).clip(lower=0.20)
    dret = px.pct_change()
    dates = px.index; cols = list(px.columns)
    W = np.zeros((len(dates), len(cols)))
    dvv, tsv, sv, ivv, pxv, rg = dv.values, ts.values, strength.values, iv.values, px.values, reg.values
    tilt_map = {1: 1.0, 0: 0.5, -1: 0.0}
    for i in range(max(max(sig_lbs), 100) + 1, len(dates), rebal):
        row = dvv[i]
        valid = ~np.isnan(pxv[i]) & ~np.isnan(tsv[i]) & ~np.isnan(row) & ~np.isnan(ivv[i])
        if valid.sum() < 2 * k + 2:
            continue
        idxv = np.where(valid)[0]
        univ = idxv[np.argsort(-row[idxv])][:TOP_LIQ]
        # spine: L/S trend, inverse-vol, normalised to gross_spine
        spine = np.zeros(len(cols))
        raw = tsv[i, univ] * ivv[i, univ]
        if np.abs(raw).sum() > 0:
            spine[univ] = raw / np.abs(raw).sum() * gross_spine
        # long overlay: top-k strongest with positive momentum, scaled by bull tilt
        tilt = tilt_map[int(rg[i])]
        longw = np.zeros(len(cols))
        if tilt > 0:
            order = univ[np.argsort(-sv[i, univ])]
            picks = [c for c in order[:k] if sv[i, c] > 0]
            for c in picks:
                longw[c] = ivv[i, c]
            if np.abs(longw).sum() > 0:
                longw = longw / np.abs(longw).sum() * gross_long * tilt
        w = spine + longw
        if np.abs(w).sum() > max_gross:
            w *= max_gross / np.abs(w).sum()
        j = min(i + rebal, len(dates))
        W[i:j] = w
    Wdf = pd.DataFrame(W, index=dates, columns=cols)
    held = Wdf.shift(1).fillna(0.0)
    turnover = held.diff().abs().sum(axis=1).fillna(held.abs().sum(axis=1))
    gross = (held * dret.fillna(0.0)).sum(axis=1)
    return gross, turnover, held.abs().sum(axis=1), held.sum(axis=1)


def net_from(g, tn, ex, cost):
    return (g - cost * 1e-4 * tn - FUNDING_DAILY * ex).dropna()


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
    cg = eq ** (ANN / n) - 1 if eq > 0 and n else -1.0
    dd = float(((1 + r).cumprod() / (1 + r).cumprod().cummax() - 1).min())
    return dict(cagr=cg, sharpe=float(r.mean()/sd*np.sqrt(ANN)) if sd>0 else 0,
                maxdd=dd, calmar=cg/abs(dd) if dd < 0 else 0,
                per_year={int(y): round(float((1+r[r.index.year==y]).prod()-1),4)
                          for y in sorted(set(r.index.year))})


def walk_forward(px, vol, grid, cost, builder=build_best_of_both, train_days=540, test_days=180):
    cache = {tuple(sorted(p.items())): builder(px, vol, **p) for p in grid}
    dates = px.index; t0 = dates[0] + pd.Timedelta(days=200)
    tr, te = pd.Timedelta(days=train_days), pd.Timedelta(days=test_days)
    chunks = []
    while t0 + tr + te <= dates[-1] + pd.Timedelta(days=1):
        lo, mid, hi = t0, t0+tr, t0+tr+te
        best, bsc, bk = None, -1e9, None
        for p in grid:
            k = tuple(sorted(p.items())); g, tn, ex, _ = cache[k]
            net = net_from(g, tn, ex, cost)
            trs = net[(net.index >= lo) & (net.index < mid)]
            if len(trs) < 60:
                continue
            sd = trs.std(ddof=0); sc = trs.mean()/sd*np.sqrt(ANN) if sd>0 else -9
            if sc > bsc:
                bsc, best, bk = sc, p, k
        if best is None:
            t0 += te; continue
        g, tn, ex, _ = cache[bk]; net = net_from(g, tn, ex, cost)
        tes = net[(net.index >= mid) & (net.index < hi)]
        if len(tes) > 20:
            chunks.append(tes)
        t0 += te
    if not chunks:
        return None
    oos = pd.concat(chunks).sort_index()
    return oos[~oos.index.duplicated(keep="first")]


def live(px, vol, sig_lbs=(10, 30, 60, 120), k=5):
    reg, breadth = researcher(px, vol)
    rn = {1: "BULL", 0: "CHOP", -1: "BEAR"}[int(reg.iloc[-1])]
    dv = vol.rolling(30, min_periods=10).mean()
    strength = sum(px / px.shift(L) - 1.0 for L in sig_lbs) / len(sig_lbs)
    i = len(px) - 1
    valid = px.iloc[i].notna() & strength.iloc[i].notna() & dv.iloc[i].notna()
    univ = dv.iloc[i][valid].sort_values(ascending=False).head(TOP_LIQ).index
    s = strength.iloc[i][univ].sort_values(ascending=False)
    print(f"\n{'='*70}\nRESEARCHER says: {rn} (breadth {breadth.iloc[-1]:.2f})  -> ", end="")
    if int(reg.iloc[-1]) > 0:
        picks = s[s > 0].head(k)
        print("route LONG-ONLY; longs:", "  ".join(f"{c}:{picks[c]:+.0%}" for c in picks.index))
    elif int(reg.iloc[-1]) < 0:
        picks = s[s < 0].tail(k)
        print("route SHORT (bear sleeve); shorts:",
              "  ".join(f"{c}:{picks[c]:+.0%}" for c in picks.index))
    else:
        picks = s[s > 0].head(k)
        print("route REDUced long; small longs:",
              "  ".join(f"{c}:{picks[c]:+.0%}" for c in picks.index))


def main(argv):
    px, vol = load_panel()
    print(f"Universe: {px.shape[1]} coins {px.index[0].date()}->{px.index[-1].date()}")
    cost = 15
    grid = [dict(sig_lbs=lbs, k=k, gross_target=gt, max_gross=mg, rebal=rb, chop_scale=cs)
            for lbs in ((10,30,60,120),(20,40,80))
            for k in (3,5,8) for gt in (0.8,1.0) for mg in (1.5,2.0)
            for rb in (7,14) for cs in (0.3,0.5)]
    print(f"Walk-forward best-of-both (regime-routed), {len(grid)} configs, {cost} bps...")
    oos = walk_forward(px, vol, grid, cost)
    out = {}
    if oos is not None:
        s = stats(oos); sb = stats(apply_dd_brake(oos))
        out["best_of_both"] = dict(base=s, braked=sb)
        print(f"\n=== BEST-OF-BOTH (regime-routed, {cost} bps, OOS) ===")
        print(f"  CAGR={s['cagr']:+.1%} Sharpe={s['sharpe']:.2f} maxDD={s['maxdd']:.0%} "
              f"Calmar={s['calmar']:.2f}")
        print("  per-year:", "  ".join(f"{y}:{v:+.0%}" for y,v in s['per_year'].items()))
        print(f"  +dd-brake: CAGR={sb['cagr']:+.1%} Sharpe={sb['sharpe']:.2f} "
              f"maxDD={sb['maxdd']:.0%} Calmar={sb['calmar']:.2f} "
              f"2022={sb['per_year'].get(2022,float('nan')):+.0%}")
    # SOFT BLEND: spine + bull-scaled long overlay (no hard switch)
    sb_grid = [dict(sig_lbs=lbs, k=k, gross_spine=gs, gross_long=gl, max_gross=mg, rebal=rb)
               for lbs in ((10,30,60,120),(20,40,80))
               for k in (3,5,8) for gs in (0.6,1.0) for gl in (0.5,1.0)
               for mg in (2.0,2.5) for rb in (7,14)]
    print(f"\nWalk-forward SOFT-BLEND (spine + bull-tilt long overlay), {len(sb_grid)} configs...")
    oos2 = walk_forward(px, vol, sb_grid, cost, builder=build_soft_blend)
    if oos2 is not None:
        s2 = stats(oos2); sb2 = stats(apply_dd_brake(oos2))
        out["soft_blend"] = dict(base=s2, braked=sb2)
        print(f"\n=== SOFT-BLEND (spine + bull overlay, {cost} bps, OOS) ===")
        print(f"  CAGR={s2['cagr']:+.1%} Sharpe={s2['sharpe']:.2f} maxDD={s2['maxdd']:.0%} "
              f"Calmar={s2['calmar']:.2f}")
        print("  per-year:", "  ".join(f"{y}:{v:+.0%}" for y,v in s2['per_year'].items()))
        print(f"  +dd-brake: CAGR={sb2['cagr']:+.1%} Sharpe={sb2['sharpe']:.2f} "
              f"maxDD={sb2['maxdd']:.0%} Calmar={sb2['calmar']:.2f} "
              f"2022={sb2['per_year'].get(2022,float('nan')):+.0%}")

    print("\nReference (from prior docs, 15 bps OOS):")
    print("  long-only orchestrator: CAGR +45% Sharpe 1.15  2022 -38%")
    print("  TS-trend L/S spine    : CAGR +24% Sharpe 0.71  2022 +22%  worstYr -3%")
    live(px, vol)
    json.dump(out, open(os.path.join(RESULTS, "best_of_both_results.json"), "w"),
              indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS,'best_of_both_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
