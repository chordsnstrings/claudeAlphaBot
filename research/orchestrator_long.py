"""Long-only momentum ORCHESTRATOR over the top-30 Binance coins (fast, vectorised).

Automatically picks the right asset at the right time to go long:
  * Universe: point-in-time top-30 by trailing dollar volume (from the 55-coin
    survivorship-free panel). Live coins only; dead names drop out as they die.
  * Signal: per-coin tsmom_blend conviction (mean sign of trailing returns over
    several lookbacks) in [0,1], and a continuous momentum strength for ranking.
  * Selection: among coins with conviction >= gate, go long the top-N by strength.
    If fewer than N qualify (bear -> few uptrends) hold fewer; the rest is CASH.
    This cash filter is the 'right time' -- it stands aside in 2022-type regimes.
  * Sizing: equal-weight the picks, then portfolio vol-target (inverse-vol), capped.
  * Walk-forward OOS; params (lookbacks, N, gate, rebal, vol_target) fixed on train.

Engine is daily-vectorised: build a weight matrix, compute held*ret in one pass.
gross daily return + daily turnover are computed ONCE per config; the three cost
levels (6/15/30 bps/side) are applied analytically. Also answers 'trade more to get
more?' by sweeping rebalance frequency & N and reporting NET CAGR/Sharpe.
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
FUNDING_DAILY = 0.0001          # ~1 bp/day on gross exposure (perp carry), conservative


def load_panel():
    closes, vols = {}, {}
    for fn in sorted(os.listdir(UNIV_DIR)):
        if not fn.endswith("_daily.csv"):
            continue
        sym = fn.replace("_daily.csv", "")
        df = pd.read_csv(os.path.join(UNIV_DIR, fn), parse_dates=["date"])
        df = df[~df["date"].duplicated(keep="first")].set_index("date").sort_index()
        closes[sym] = df["close"]
        vols[sym] = df["volume_usd"]
    px = pd.DataFrame(closes).sort_index()
    vol = pd.DataFrame(vols).reindex_like(px)
    return px, vol


def signals(px, lbs):
    strength = sum(px / px.shift(L) - 1.0 for L in lbs) / len(lbs)
    conviction = sum((px / px.shift(L) - 1.0 > 0).astype(float) for L in lbs) / len(lbs)
    return strength, conviction


def build(px, vol, lbs, n_pos, gate, rebal, vol_target, max_lev=2.0):
    """Return (gross_daily, turnover_daily, gross_exposure_daily, events). Vectorised P&L."""
    dollar_vol = vol.rolling(30, min_periods=10).mean()
    strength, conviction = signals(px, lbs)
    dret = px.pct_change()
    dret_np = dret.values
    dates = px.index
    cols = list(px.columns)
    W = np.zeros((len(dates), len(cols)))
    rb_idx = list(range(max(lbs) + 1, len(dates), rebal))
    events = []
    sv = strength.values
    cv = conviction.values
    dv = dollar_vol.values
    pxv = px.values
    for n, i in enumerate(rb_idx):
        row_dv = dv[i]
        valid = ~np.isnan(pxv[i]) & ~np.isnan(sv[i]) & ~np.isnan(row_dv)
        if valid.sum() < 5:
            continue
        # top-30 by dollar volume among valid
        idx_valid = np.where(valid)[0]
        order = idx_valid[np.argsort(-row_dv[idx_valid])][:TOP_LIQ]
        # eligibility: conviction >= gate; rank by strength
        elig = [c for c in order if cv[i, c] >= gate and not np.isnan(sv[i, c])]
        elig.sort(key=lambda c: -sv[i, c])
        picks = elig[:n_pos]
        j = rb_idx[n + 1] if n + 1 < len(rb_idx) else len(dates) - 1
        if not picks:
            continue
        # portfolio vol estimate from trailing equal-weight basket of picks
        lo = max(0, i - 30)
        basket = np.nanmean(dret_np[lo:i][:, picks], axis=1)
        rv = np.nanstd(basket) * np.sqrt(ANN) if len(basket) > 5 else 0.5
        scale = min(vol_target / max(rv, 0.10), max_lev)
        wv = scale / len(picks)
        W[i:j, picks] = wv                       # target weight set at close i, held i+1..j
        for c in picks:
            col = px.iloc[i:j + 1, c].dropna()
            if len(col) >= 2:
                seg = float(col.iloc[-1] / col.iloc[0] - 1.0)
                events.append(dict(coin=cols[c], entry=str(dates[i].date()),
                                   exit=str(col.index[-1].date()),
                                   weight=round(wv, 4), pnl=wv * seg))
    Wdf = pd.DataFrame(W, index=dates, columns=cols)
    held = Wdf.shift(1).fillna(0.0)
    turnover = held.diff().abs().sum(axis=1).fillna(held.abs().sum(axis=1))
    gross = (held * dret.fillna(0.0)).sum(axis=1)
    exposure = held.abs().sum(axis=1)
    return gross, turnover, exposure, events


def net_from(gross, turnover, exposure, cost_bps):
    return (gross - cost_bps * 1e-4 * turnover - FUNDING_DAILY * exposure).dropna()


def sharpe(r):
    r = r.dropna(); sd = r.std(ddof=0)
    return float(r.mean() / sd * np.sqrt(ANN)) if sd > 0 else 0.0


def cagr(r):
    r = r.dropna(); n = len(r)
    if n == 0:
        return -1.0
    eq = float((1 + r).prod())
    return eq ** (ANN / n) - 1 if eq > 0 else -1.0


def maxdd(r):
    eq = (1 + r.dropna()).cumprod()
    return float((eq / eq.cummax() - 1).min()) if len(eq) else 0.0


def year_ret(r, y):
    ry = r[r.index.year == y]
    return float((1 + ry).prod() - 1) if len(ry) else float("nan")


def apply_dd_brake(r, dd1=0.12, dd2=0.30, floor=0.0):
    """Graded equity-curve drawdown brake (from DRAWDOWN_CONTROL.md), causal: ramp
    exposure from 1.0 above -dd1 down to floor at -dd2; restore on recovery."""
    r = r.dropna()
    out = r.copy().values.astype(float)
    rv = r.values
    eq, peak, state = 1.0, 1.0, 1.0
    for t in range(len(rv)):
        out[t] = rv[t] * state
        eq *= (1.0 + out[t]); peak = max(peak, eq)
        dd = eq / peak - 1.0
        if dd >= -dd1:
            state = 1.0
        elif dd <= -dd2:
            state = floor
        else:
            state = 1.0 - (abs(dd) - dd1) / (dd2 - dd1) * (1.0 - floor)
    return pd.Series(out, index=r.index)


def walk_forward(px, vol, grid, cost_bps, train_days=540, test_days=180):
    cache = {tuple(sorted(p.items())): build(px, vol, **p) for p in grid}
    dates = px.index
    t0 = dates[0] + pd.Timedelta(days=200)
    tr, te = pd.Timedelta(days=train_days), pd.Timedelta(days=test_days)
    chunks, evs = [], []
    while t0 + tr + te <= dates[-1] + pd.Timedelta(days=1):
        lo, mid, hi = t0, t0 + tr, t0 + tr + te
        best, bsc, bk = None, -1e9, None
        for p in grid:
            k = tuple(sorted(p.items()))
            g, tn, ex, _ = cache[k]
            net = net_from(g, tn, ex, cost_bps)
            trs = net[(net.index >= lo) & (net.index < mid)]
            if len(trs) < 60:
                continue
            sc = sharpe(trs)
            if sc > bsc:
                bsc, best, bk = sc, p, k
        if best is None:
            t0 += te; continue
        g, tn, ex, ev = cache[bk]
        net = net_from(g, tn, ex, cost_bps)
        tes = net[(net.index >= mid) & (net.index < hi)]
        if len(tes) > 20:
            chunks.append(tes)
            for e in ev:
                if mid <= pd.Timestamp(e["entry"]) < hi:
                    evs.append(e)
        t0 += te
    if not chunks:
        return None, []
    oos = pd.concat(chunks).sort_index()
    return oos[~oos.index.duplicated(keep="first")], evs


def report(px, vol, cost, grid):
    oos, evs = walk_forward(px, vol, grid, cost_bps=cost)
    if oos is None:
        return None
    pos = sorted([e["pnl"] for e in evs if e["pnl"] > 0], reverse=True)
    conc = (sum(pos[:10]) / sum(pos)) if sum(pos) > 0 else float("nan")
    peryr = {int(y): round(year_ret(oos, y), 4) for y in sorted(set(oos.index.year))}
    res = dict(cost=cost, sharpe=sharpe(oos), cagr=cagr(oos), maxdd=maxdd(oos),
               n_events=len(evs), conc_top10=conc, r2022=year_ret(oos, 2022),
               per_year=peryr, n_days=len(oos))
    print(f"\n=== ORCHESTRATOR long-only ({cost} bps) ===  {len(oos)} OOS days")
    print(f"  CAGR={res['cagr']:+.1%}  Sharpe={res['sharpe']:.2f}  maxDD={res['maxdd']:.0%}  "
          f"events={res['n_events']}  top10={conc:.0%}  2022={res['r2022']:+.1%}")
    print("  per-year:", "  ".join(f"{y}:{v:+.0%}" for y, v in peryr.items()))
    return res


def freq_sweep(px, vol, cost):
    print(f"\n{'='*70}\nTRADE-MORE STUDY ({cost} bps): NET CAGR/Sharpe vs rebalance freq & N")
    print(f"  {'rebal':>6} {'N':>3} {'CAGR':>8} {'Sharpe':>7} {'maxDD':>7} {'rebals/yr':>9}")
    rows = []
    for rb in (3, 7, 14, 30, 60):
        for n in (3, 5, 8):
            g, tn, ex, _ = build(px, vol, lbs=(10, 30, 60, 120), n_pos=n, gate=0.5,
                                 rebal=rb, vol_target=0.6)
            net = net_from(g, tn, ex, cost)
            net = net[net.index >= (px.index[0] + pd.Timedelta(days=400))]
            print(f"  {rb:>5}d {n:>3} {cagr(net):>7.0%} {sharpe(net):>7.2f} "
                  f"{maxdd(net):>7.0%} {365.0/rb:>8.0f}x")
            rows.append(dict(rebal=rb, n=n, cagr=cagr(net), sharpe=sharpe(net), maxdd=maxdd(net)))
    return rows


def live_picks(px, vol, lbs=(10, 30, 60, 120), n_pos=5, gate=0.5):
    dollar_vol = vol.rolling(30, min_periods=10).mean()
    strength, conviction = signals(px, lbs)
    i = len(px) - 1
    valid = px.iloc[i].notna() & strength.iloc[i].notna() & dollar_vol.iloc[i].notna()
    univ = dollar_vol.iloc[i][valid].sort_values(ascending=False).head(TOP_LIQ).index
    conv, strg = conviction.iloc[i][univ], strength.iloc[i][univ]
    elig = strg[conv >= gate].dropna().sort_values(ascending=False).head(n_pos)
    print(f"\n{'='*70}\nLIVE ORCHESTRATOR PICKS for {px.index[-1].date()} "
          f"(top-{TOP_LIQ} liquid, gate {gate}, N={n_pos})")
    if len(elig) == 0:
        print("  -> NO coins in qualifying uptrend; orchestrator holds 100% CASH.")
        return []
    for c in elig.index:
        print(f"  LONG {c:6}  momentum={elig[c]:+.1%}  conviction={conv[c]:.2f}")
    if len(elig) < n_pos:
        print(f"  (only {len(elig)}/{n_pos} qualify; rest = CASH)")
    return list(elig.index)


def main(argv):
    px, vol = load_panel()
    print(f"Universe: {px.shape[1]} coins, {px.index[0].date()} -> {px.index[-1].date()}; "
          f"orchestrator ranks top-{TOP_LIQ} by dollar volume each rebalance")
    grid = [dict(lbs=lbs, n_pos=n, gate=g, rebal=rb, vol_target=vt)
            for lbs in ((10, 30, 60, 120), (20, 40, 80), (30, 60, 120))
            for n in (3, 5, 8) for g in (0.5, 0.75) for rb in (7, 14, 30)
            for vt in (0.4, 0.6)]
    out = {}
    for cost in (6, 15, 30):
        r = report(px, vol, cost, grid)
        if r:
            out[str(cost)] = r
    out["freq_sweep_15bps"] = freq_sweep(px, vol, 15)

    # genuine optimization 'to get more': add the graded drawdown brake (15 bps)
    oos, evs = walk_forward(px, vol, grid, cost_bps=15)
    braked = apply_dd_brake(oos)
    print(f"\n{'='*70}\nOPTIMIZATION — orchestrator + graded drawdown brake (15 bps, OOS)")
    print(f"  {'variant':>16} {'CAGR':>7} {'Sharpe':>7} {'maxDD':>7} {'2022':>7} {'Calmar':>7}")
    for name, s in [("orchestrator", oos), ("+ dd-brake", braked)]:
        cal = cagr(s) / abs(maxdd(s)) if maxdd(s) < 0 else 0
        print(f"  {name:>16} {cagr(s):>6.0%} {sharpe(s):>7.2f} {maxdd(s):>7.0%} "
              f"{year_ret(s,2022):>7.0%} {cal:>7.2f}")
    out["dd_brake"] = dict(base=dict(cagr=cagr(oos), sharpe=sharpe(oos), maxdd=maxdd(oos),
                                     r2022=year_ret(oos, 2022)),
                           braked=dict(cagr=cagr(braked), sharpe=sharpe(braked),
                                       maxdd=maxdd(braked), r2022=year_ret(braked, 2022),
                                       per_year={int(y): round(year_ret(braked, y), 4)
                                                 for y in sorted(set(braked.index.year))}))
    out["live_picks"] = live_picks(px, vol)
    json.dump(out, open(os.path.join(RESULTS, "orchestrator_long_results.json"), "w"),
              indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS,'orchestrator_long_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
