"""Breadth Falsification Test (v1) — dollar-neutral cross-sectional crypto momentum.

Decides OUT-OF-SAMPLE whether a breadth edge exists, against four pass/kill criteria:
  1. 2022 calendar return > 0  (at 50 bps/side)         <- the binding constraint
  2. >= 200 independent events (coin x rebalance) in OOS
  3. top-10 events < 50% of gross positive P&L          <- not the 5-event disease
  4. OOS Sharpe >= 0.7 at 50 bps AND <=40% Sharpe decay 6bps->50bps

Construction (no beta smuggled in):
  * Universe: survivorship-FREE panel of USDT pairs incl. dead names (LUNA/FTT/...).
    Point-in-time: at each rebalance the eligible set = coins live at t (price exists)
    with >= lookback history; take the top U by trailing dollar volume.
  * Signal: trailing-return rank. Long top-k, short bottom-k, equal weight per side,
    dollar-neutral (long gross == short gross, net ~0). NO net-long tilt.
  * Hold to next rebalance. Costs: cost_bps/side on turnover + funding both sides.
  * Walk-forward: params (lookback, k, rebalance days) chosen on TRAIN fold by Sharpe
    at the judged cost (50 bps), fixed through the unseen TEST fold. Median-anchored.
  * Delisting: a held coin whose data ends is force-closed on its last bar (turnover
    cost charged); its real price path (incl. terminal crash) is used while live.
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


def build_returns(px, vol, lookback, k, rebal, univ_size, cost_bps, funding_bps=2.0):
    """Period-based dollar-neutral XS momentum. Returns (period_returns, events, rebal).

    Period return uses ratio (exit/entry - 1) per coin, which caps a short's gain at
    +100% of notional (price can't go below 0) — the realistic terminal-gap model.
    Costs = cost_bps/side on turnover (L1 weight change between rebalances) + funding
    on gross. Returns indexed by period-entry date.
    """
    dollar_vol = vol.rolling(30, min_periods=10).mean()       # liquidity, causal
    mom = px / px.shift(lookback) - 1.0                        # trailing-return signal
    dates = px.index
    rb_idx = list(range(lookback + 1, len(dates), rebal))
    events = []
    period_rets, period_dates = [], []
    prev_w = pd.Series(0.0, index=px.columns)
    for n, i in enumerate(rb_idx):
        t = dates[i]
        live = px.iloc[i].notna() & mom.iloc[i].notna() & dollar_vol.iloc[i].notna()
        if live.sum() < 2 * k + 2:
            continue
        dv = dollar_vol.iloc[i][live]
        univ = dv.sort_values(ascending=False).head(univ_size).index
        m = mom.iloc[i][univ].dropna()
        if len(m) < 2 * k + 2:
            continue
        ranked = m.sort_values(ascending=False)
        longs, shorts = ranked.head(k).index, ranked.tail(k).index
        wl, ws = 0.5 / len(longs), 0.5 / len(shorts)
        w = pd.Series(0.0, index=px.columns)
        w[longs] = wl
        w[shorts] = -ws
        # turnover cost vs previous period's weights (both sides via L1 change)
        turn = float((w - prev_w).abs().sum())
        period_cost = cost_bps * 1e-4 * turn
        # holding segment: entry close at t_i, exit close at next rebalance (or end)
        j = rb_idx[n + 1] if n + 1 < len(rb_idx) else len(dates) - 1
        entry_px = px.iloc[i]
        days = (dates[j] - dates[i]).days
        gross = 0.0
        for c, wt in list(zip(longs, [wl] * len(longs))) + list(zip(shorts, [-ws] * len(shorts))):
            col = px[c].iloc[i:j + 1].dropna()
            if len(col) < 2:
                continue
            seg_ret = float(col.iloc[-1] / col.iloc[0] - 1.0)   # ratio: short gain capped at +100%
            contrib = wt * seg_ret
            gross += contrib
            fund = funding_bps * 1e-4 * abs(wt) * (days / 365.0)
            events.append(dict(coin=c, entry=str(dates[i].date()),
                               exit=str(col.index[-1].date()), weight=round(wt, 4),
                               seg_ret=round(seg_ret, 4),
                               pnl_gross=contrib,
                               pnl_net=contrib - (cost_bps * 1e-4 * 2 * abs(wt)) - fund))
        funding = funding_bps * 1e-4 * float(w.abs().sum()) * (days / 365.0)
        period_rets.append(gross - period_cost - funding)
        period_dates.append(dates[i])
        prev_w = w
    s = pd.Series(period_rets, index=pd.DatetimeIndex(period_dates))
    return s, events, rebal


def sharpe(r, rebal):
    r = r.dropna()
    s = r.std(ddof=0)
    ppy = 365.0 / rebal
    return float(r.mean() / s * np.sqrt(ppy)) if s > 0 else 0.0


def walk_forward(px, vol, grid, cost_bps, train_days=540, test_days=180):
    """Returns (oos_period_returns, oos_events, chosen_rebal_per_fold). Period returns
    from different folds may have different rebal; we annualise each fold's Sharpe by
    its own rebal and report a turnover-weighted blend, but for the stitched series we
    record (return, rebal) pairs."""
    dates = px.index
    start, end = dates[0], dates[-1]
    oos_chunks, all_events, fold_meta = [], [], []
    t0 = start + pd.Timedelta(days=200)
    tr, te = pd.Timedelta(days=train_days), pd.Timedelta(days=test_days)
    # precompute every param's full series once (expensive part)
    cache = {tuple(sorted(p.items())): build_returns(px, vol, cost_bps=cost_bps, **p)
             for p in grid}
    while t0 + tr + te <= end + pd.Timedelta(days=1):
        lo, mid, hi = t0, t0 + tr, t0 + tr + te
        best, bsc, best_key = None, -1e9, None
        for p in grid:
            key = tuple(sorted(p.items()))
            rp, _, rb = cache[key]
            trs = rp[(rp.index >= lo) & (rp.index < mid)]
            if len(trs) < 8:
                continue
            sc = sharpe(trs, rb)
            if sc > bsc:
                bsc, best, best_key = sc, p, key
        if best is None:
            t0 += te
            continue
        rp, ev, rb = cache[best_key]
        tes = rp[(rp.index >= mid) & (rp.index < hi)]
        if len(tes) > 3:
            oos_chunks.append((tes, rb))
            for e in ev:
                ed = pd.Timestamp(e["entry"])
                if mid <= ed < hi:
                    all_events.append(e)
            fold_meta.append((str(mid.date()), best, round(bsc, 2)))
        t0 += te
    if not oos_chunks:
        return None, [], []
    oos = pd.concat([c for c, _ in oos_chunks]).sort_index()
    oos = oos[~oos.index.duplicated(keep="first")]
    # use the most common rebal for annualisation of the stitched series
    rbs = [rb for _, rb in oos_chunks]
    eff_rebal = max(set(rbs), key=rbs.count)
    return oos, all_events, (eff_rebal, fold_meta)


def year_return(r, y):
    ry = r[r.index.year == y]
    return float((1 + ry).prod() - 1) if len(ry) else float("nan")


def concentration(events):
    pos = sorted([e["pnl_net"] for e in events if e["pnl_net"] > 0], reverse=True)
    tot = sum(pos)
    if tot <= 0:
        return float("nan"), tot
    return sum(pos[:10]) / tot, tot


def main(argv):
    px, vol = load_panel()
    print(f"Universe: {px.shape[1]} coins, {px.index[0].date()} -> {px.index[-1].date()}")
    grid = [dict(lookback=lb, k=k, rebal=rb, univ_size=40)
            for lb in (30, 60, 90) for k in (3, 5, 8) for rb in (7, 14, 30)]
    out = {}
    for cost in (6, 50):
        oos, events, meta = walk_forward(px, vol, grid, cost_bps=cost)
        if oos is None:
            print(f"cost {cost}bps: no OOS"); continue
        eff_rebal, fold_meta = meta
        shp = sharpe(oos, eff_rebal)
        r2022 = year_return(oos, 2022)
        conc, _ = concentration(events)
        peryr = {int(y): round(year_return(oos, y), 4) for y in sorted(set(oos.index.year))}
        ppy = 365.0 / eff_rebal
        cagr = float((1 + oos).prod() ** (ppy / len(oos)) - 1)
        out[cost] = dict(sharpe=shp, n_events=len(events), conc_top10=conc,
                         r2022=r2022, per_year=peryr, cagr=cagr,
                         n_periods=len(oos), eff_rebal=eff_rebal,
                         median_period=float(oos.median()))
        print(f"\n=== {cost} bps/side ===  (eff rebalance {eff_rebal}d, {len(oos)} periods)")
        print(f"  OOS Sharpe={shp:.2f}  CAGR={cagr:+.1%}  median period={oos.median():+.2%}  "
              f"events={len(events)}  top10/posPnL={conc:.0%}")
        print(f"  2022 return={r2022:+.1%}")
        print("  per-year:", "  ".join(f"{y}:{v:+.0%}" for y, v in peryr.items()))
    # scoring
    if 50 in out and 6 in out:
        o, o6 = out[50], out[6]
        decay = 1 - (o["sharpe"] / o6["sharpe"]) if o6["sharpe"] > 0 else 1.0
        c1 = o["r2022"] > 0
        c2 = o["n_events"] >= 200
        c3 = (o["conc_top10"] < 0.50) if not np.isnan(o["conc_top10"]) else False
        c4 = (o["sharpe"] >= 0.7) and (decay <= 0.40)
        out["scoring"] = dict(c1_2022=bool(c1), c2_events=bool(c2),
                              c3_concentration=bool(c3), c4_cost=bool(c4),
                              sharpe_decay_6_to_50=round(decay, 3))
        verdict = "PASS" if (c1 and c2 and c3 and c4) else "KILL"
        out["verdict"] = verdict
        print(f"\n{'='*70}\nSCORING (judged at 50 bps/side, OOS)")
        print(f"  1. 2022 > 0          : {'PASS' if c1 else 'FAIL'}  ({o['r2022']:+.1%})")
        print(f"  2. >=200 events      : {'PASS' if c2 else 'FAIL'}  ({o['n_events']})")
        print(f"  3. top10 < 50% P&L   : {'PASS' if c3 else 'FAIL'}  ({o['conc_top10']:.0%})")
        print(f"  4. Sharpe>=0.7,decay<=40%: {'PASS' if c4 else 'FAIL'}  "
              f"(Sharpe {o['sharpe']:.2f}, decay {decay:.0%})")
        print(f"\n  VERDICT: {verdict}")
    json.dump(out, open(os.path.join(RESULTS, "breadth_test_results.json"), "w"),
              indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS,'breadth_test_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
