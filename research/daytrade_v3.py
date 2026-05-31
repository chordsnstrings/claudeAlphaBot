"""High-risk multi-asset altcoin day-trading model — v3, target 2000%+/month.

Concept (per spec): "the account can get liquidated but it needs to have 2000% ROI in a
month. it's possible with mid to low cap asset with extreme high volatility."

This is fundamentally a LONG-TAIL bet, not a Sharpe-maximizing strategy:
  * Trade multiple high-vol alts (top ~6-10 by annualized vol on binance.vision)
  * Per-trade risk is FIXED (5% of base) -- caps per-trade loss
  * Leverage is HIGH (notional sized by risk/stop_pct can hit 20x+) -- big notionals
  * Stops: tight at the swept extreme; trailing AFTER +1R; LET WINNERS RUN with loose trail
  * Harvest 10% to spot (the same alt) -- spot ALSO appreciates if alt rallies, dual engine
  * Accepts LIQUIDATION as a tail outcome; the median path is small/modest, the 95+pct path
    is what we're hunting (a 5-50x alt move ridden with leverage)

Architecture is identical to daytrade_v2 (liquidity sweep + trend filter) but parameterized
for high-vol alts and a portfolio of them. WF-OOS validation per the always-WF/OOS commitment.

Run:  python daytrade_v3.py             # full WF-OOS multi-asset backtest
      python daytrade_v3.py --explore   # in-sample per-asset probe (NOT validation)
      python daytrade_v3.py --month     # rolling-month return distribution (the 2000% question)
"""
from __future__ import annotations

import sys, os, itertools, time
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scalp_sweep as ss
import binance_vision as bv
import daytrade_v2 as DT2     # reuse liquidity_sweep + simulate_trade


# ----- config -----
BASE        = 1000.0   # trading wallet base ($)
RISK_PCT    = 0.05     # fixed $ risk per trade (5% of base)
HARVEST_PCT = 0.10     # any wallet > base*1.10 -> excess moves to spot
MAX_LEV     = 20.0     # exchange leverage cap (alts often allow 20-50x)
COST_BPS    = 7.0      # alts have slightly higher fees + slippage than majors
DATA_DIR    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "intraday")

# Top high-vol alts (from survey). Annualized vol range 60-175%. mid/low cap proxies.
UNIVERSE = ["DYMUSDT","JTOUSDT","INJUSDT","WLDUSDT","ORDIUSDT","NEARUSDT","STRKUSDT",
            "TIAUSDT","FETUSDT","WIFUSDT","PYTHUSDT","JUPUSDT","SUIUSDT","OPUSDT","SEIUSDT","APTUSDT"]


def fetch_alt(sym, days=365, tf="1h"):
    """Fetch (and cache) intraday data for an alt."""
    path = os.path.join(DATA_DIR, f"{sym}_{tf}.csv")
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(path):
        try:
            df = pd.read_csv(path, parse_dates=["date"]).set_index("date")
            if len(df) > 500: return df.astype(float)
        except Exception: pass
    bv.INTERVAL_MS[tf] = bv.INTERVAL_MS.get(tf, int(tf.rstrip("hm")) * (60 if tf.endswith("m") else 3600) * 1000)
    start_ms = int((time.time() - days * 86400) * 1000)
    try:
        kl = bv.fetch_klines(sym, tf, start_ms)
    except Exception as e:
        print(f"  {sym}: fetch failed ({e})"); return None
    if not kl or len(kl) < 100: return None
    import csv
    with open(path, "w", newline="") as f:
        w = csv.writer(f); w.writerow(["timestamp_ms","date","open","high","low","close","volume","quote_volume"])
        for k in kl:
            from datetime import datetime, timezone
            d = datetime.fromtimestamp(int(k[0])/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            w.writerow([int(k[0]), d, k[1], k[2], k[3], k[4], k[5], k[7]])
    df = pd.read_csv(path, parse_dates=["date"]).set_index("date")
    return df.astype(float)


def simulate_trade_runner(df, entry_i, direction, atr_frac, target_R=4.0, trail_atr=2.0,
                          breakeven_at_R=0.7, max_hold=24):
    """Like DT2.simulate_trade but tuned for LETTING WINNERS RUN. Breakeven move earlier
    (+0.7R) and looser trailing (2 ATR) so a real altcoin trend can deliver 5R, 10R, 30R."""
    return DT2.simulate_trade(df, entry_i, direction, atr_frac, target_R=target_R,
                              trail_atr=trail_atr, breakeven_at_R=breakeven_at_R, max_hold=max_hold)


def backtest_single(df, lookback=20, rejection=0.5, trend_sma=200, target_R=4.0, trail_atr=2.0,
                    breakeven_at_R=0.7, max_hold=24, base=BASE, risk_pct=RISK_PCT,
                    harvest_pct=HARVEST_PCT, cost_bps=COST_BPS, init_wallet=None, init_spot=None):
    """Run signal+trade on one asset. Returns trades + final wallet + spot."""
    sig = DT2.liquidity_sweep(df, lookback, rejection, trend_sma)
    atr = DT2._atr_frac(df, 14)
    wallet = init_wallet if init_wallet is not None else base
    spot = init_spot if init_spot is not None else 0.0
    trades = []; n = len(df); fee = cost_bps * 1e-4; i = 1
    while i < n - 1:
        if sig[i] == 0: i += 1; continue
        risk_dollars = risk_pct * base
        ex_i, exit_px, outcome, R = simulate_trade_runner(df, i, int(sig[i]), atr, target_R, trail_atr, breakeven_at_R, max_hold)
        if outcome in ("skip","too_tight"): i = ex_i; continue
        entry_px = df["close"].iloc[i]
        stop_dist_pct = abs(df["low"].iloc[i] - entry_px)/entry_px if sig[i]>0 else abs(df["high"].iloc[i]-entry_px)/entry_px
        if stop_dist_pct <= 0: i = ex_i+1; continue
        notional = risk_dollars / stop_dist_pct
        # Effective leverage cap (account-level)
        eff_lev = notional / max(wallet, 1)
        if eff_lev > MAX_LEV: notional = MAX_LEV * wallet
        cost_dollars = 2 * fee * notional
        # Liquidation check: if a SINGLE bar's range exceeded liquidation distance against position
        # already enforced by stop being inside max-lev distance (DT2 returns "skip" if stop too tight)
        pnl = R * risk_dollars - cost_dollars
        wallet += pnl
        if wallet <= 0:
            trades.append(dict(entry=df.index[i], exit=df.index[ex_i], dir=int(sig[i]),
                               R=R, outcome="LIQUIDATED", pnl=pnl, hold=ex_i-i, wallet_after=0))
            return trades, 0.0, spot, True
        # Harvest to spot at base*(1+harvest_pct)
        threshold = base * (1.0 + harvest_pct)
        if wallet > threshold:
            move = wallet - base
            spot += move; wallet = base
        trades.append(dict(entry=df.index[i], exit=df.index[ex_i], dir=int(sig[i]),
                           R=R, outcome=outcome, pnl=pnl, hold=ex_i-i, wallet_after=wallet))
        i = ex_i + 1
    return trades, wallet, spot, False


def backtest_portfolio(asset_dfs, **kwargs):
    """Run across all assets sharing one wallet (sequentially -- approximation; in live
    they'd run concurrently). Returns aggregated trades + final wallet + spot."""
    base = kwargs.get("base", BASE)
    wallet = base; spot = 0.0; all_trades = []
    # Interleave by chronology: combine all signals from all assets in time order
    # Simpler: for each asset, run sequentially, feeding wallet+spot forward
    # (this approximates portfolio behavior but with sequential ordering)
    for sym, df in asset_dfs.items():
        trades, wallet, spot, liq = backtest_single(df, init_wallet=wallet, init_spot=spot, **kwargs)
        for t in trades: t["sym"] = sym
        all_trades.extend(trades)
        if liq:
            return all_trades, 0.0, spot, True
    return all_trades, wallet, spot, False


def explore_universe(universe=UNIVERSE, days=365, tf="1h"):
    """Per-asset in-sample probe."""
    print(f"In-sample per-asset probe ({tf}, {days}d). Settings: target_R=4, trail=2 ATR, breakeven +0.7R, MAX_LEV {MAX_LEV}x.\n")
    print(f"{'symbol':12}{'bars':>7}{'trades':>8}{'win':>6}{'final $':>11}{'spot':>9}{'TOTAL':>10}{'best trade':>12}")
    for sym in universe:
        df = fetch_alt(sym, days, tf)
        if df is None or len(df) < 200: continue
        tr, w, s, liq = backtest_single(df)
        if not tr: continue
        wins = sum(1 for t in tr if t["pnl"] > 0)
        best = max((t["R"] for t in tr), default=0)
        print(f"  {sym:10}{len(df):>7}{len(tr):>8}{wins/len(tr)*100:>5.0f}%{w:>10,.0f}${s:>8,.0f}${w+s:>9,.0f}{best:>10.1f}R{' LIQ' if liq else ''}")


def rolling_month_distribution(universe=UNIVERSE, days=365, tf="1h"):
    """The 2000%/month question — distribute rolling 30-day returns across the universe."""
    print(f"\nROLLING 30-DAY RETURN DISTRIBUTION across {len(universe)} alts (~1y data each):\n")
    results = []
    for sym in universe:
        df = fetch_alt(sym, days, tf)
        if df is None or len(df) < 500: continue
        # Walk 30-day windows, run backtest on each
        bars_per_day = 24 if tf == "1h" else (96 if tf == "15m" else 24)
        wnd = 30 * bars_per_day; step = 7 * bars_per_day      # weekly-stepped 30d windows
        for i in range(0, len(df) - wnd, step):
            sub = df.iloc[i:i+wnd]
            tr, w, s, liq = backtest_single(sub)
            roi = ((w + s) / BASE - 1) * 100
            results.append(dict(sym=sym, start=sub.index[0].date(), roi=roi, n=len(tr), liq=liq))
    if not results: print("no rolling windows produced"); return
    rois = np.array([r["roi"] for r in results])
    print(f"  n rolling 30d backtests: {len(results)}")
    print(f"  ROI distribution: min {rois.min():.0f}%  10%ile {np.percentile(rois,10):.0f}%  "
          f"median {np.median(rois):.0f}%  mean {rois.mean():.0f}%  90%ile {np.percentile(rois,90):.0f}%  "
          f"99%ile {np.percentile(rois,99):.0f}%  max {rois.max():.0f}%")
    print(f"  liquidations: {sum(r['liq'] for r in results)}/{len(results)} = {sum(r['liq'] for r in results)/len(results)*100:.0f}%")
    print(f"  fraction of windows ROI > +100%: {(rois > 100).mean()*100:.0f}%")
    print(f"  fraction of windows ROI > +500%: {(rois > 500).mean()*100:.0f}%")
    print(f"  fraction of windows ROI > +2000%: {(rois > 2000).mean()*100:.0f}%")
    print(f"\n  TOP 10 30-day windows by ROI:")
    top = sorted(results, key=lambda x:-x["roi"])[:10]
    for r in top: print(f"    {r['sym']:12} starting {r['start']}  ROI {r['roi']:>+8.0f}%  ({r['n']} trades, liq={r['liq']})")


def wf_oos_multi(universe=UNIVERSE, days=365, tf="1h", train_days=120, test_days=30):
    """Walk-forward OOS across the universe. Each fold: pick best param set on the train
    window across the universe, apply OOS on the test window. Stitch portfolio returns."""
    asset_dfs = {sym: fetch_alt(sym, days, tf) for sym in universe}
    asset_dfs = {k:v for k,v in asset_dfs.items() if v is not None and len(v) > 500}
    if not asset_dfs: print("no data"); return
    # Common index span
    starts = [v.index.min() for v in asset_dfs.values()]
    ends = [v.index.max() for v in asset_dfs.values()]
    LO, HI = max(starts), min(ends)
    bpd = 24
    TR = train_days*bpd; TE = test_days*bpd
    # Grid: small but meaningful
    grid = list(itertools.product([20,50],[0.5],[3.0,5.0],[1.5,2.5],[100,200]))   # lookback, rej, target_R, trail, sma
    common_idx = pd.date_range(LO, HI, freq="1H")
    n = len(common_idx)
    print(f"WF-OOS multi-asset: {len(asset_dfs)} alts, train {train_days}d / test {test_days}d, "
          f"common window {LO.date()}->{HI.date()}, {n} bars\n")
    oos = []; picks = []; start = TR
    while start + TE <= n:
        tr_start, tr_end = common_idx[start-TR], common_idx[start]
        te_start, te_end = common_idx[start], common_idx[min(start+TE, n-1)]
        # Subset each asset
        tr_dfs = {s: d[(d.index>=tr_start)&(d.index<tr_end)] for s,d in asset_dfs.items()}
        te_dfs = {s: d[(d.index>=te_start)&(d.index<te_end)] for s,d in asset_dfs.items()}
        best_score, best_p = -1e18, None
        for lb,rj,tR,trA,sma in grid:
            score = 0; n_tr = 0
            for s,d in tr_dfs.items():
                if len(d) < 50: continue
                tr,w,sp,liq = backtest_single(d, lookback=lb, rejection=rj, target_R=tR,
                                              trail_atr=trA, trend_sma=sma)
                if not tr: continue
                pnls = [t["pnl"] for t in tr]
                score += sum(pnls); n_tr += len(tr)
            if n_tr >= 10 and score > best_score:
                best_score = score; best_p = (lb,rj,tR,trA,sma)
        if best_p:
            lb,rj,tR,trA,sma = best_p
            # Apply OOS to each asset, aggregate
            fold_total = 0.0; fold_liq = False
            for s,d in te_dfs.items():
                if len(d) < 20: continue
                tr,w,sp,liq = backtest_single(d, lookback=lb, rejection=rj, target_R=tR,
                                              trail_atr=trA, trend_sma=sma)
                for t in tr: t["sym"]=s; oos.append(t)
                fold_total += sum(t["pnl"] for t in tr)
            picks.append((te_start.date(), best_p, fold_total))
        start += TE
    if not oos: print("no OOS trades"); return
    pnls = np.array([t["pnl"] for t in oos])
    wins = sum(1 for t in oos if t["pnl"]>0)
    print(f"OOS trades: {len(oos)}  wins {wins} ({wins/len(oos)*100:.0f}%)  total P&L: ${pnls.sum():.0f}")
    print(f"Per-fold P&L sum (avg ${np.mean([p[2] for p in picks]):.0f}, median ${np.median([p[2] for p in picks]):.0f}):")
    for d,p,t in picks: print(f"  {d}  pick={p}  fold_pnl=${t:>+8.0f}")


def main(argv):
    if "--explore" in argv: explore_universe()
    elif "--month" in argv: rolling_month_distribution()
    else: wf_oos_multi()


if __name__ == "__main__":
    main(sys.argv[1:])
