"""Rolling walk-forward validation of the day-trade families (the honest test).

The single 70/30 split in daytrade_winrate.py can flatter a strategy if the one
test window happens to be a friendly regime. This module applies the repo's gold
standard instead: a ROLLING walk-forward with many *non-overlapping* test windows
that span multiple regimes (2021 bull, 2022 bear, 2023 chop, 2024 bull, 2025
selloff). In every fold we choose parameters on the train window ONLY and score on
the next unseen window; all OOS trades are stitched into one record.

Reported per (coin, timeframe, family):
  * pooled OOS win rate, net return, profit factor, expectancy  (all net of cost)
  * fold-win-rate: fraction of test windows that were net-positive (an edge spread
    across regimes, not one lucky fold)
  * the per-fold OOS win-rate spread.

A high win rate only "counts" if it is high *and* net-positive across folds. This
is the test that separates a real edge (trend-filtered pullback) from the in-sample
mirage (naive mean reversion, which wins often in-sample then dies OOS).
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

from daytrade_winrate import (COINS, COST_BPS_PER_SIDE, RESULTS, SIGNALS,
                              TIMEFRAMES, bracket_backtest, grids, load_1h,
                              resample, run_config, trade_metrics)

BARS_PER_DAY = {"1h": 24, "8h": 3, "12h": 2, "1d": 1}
# calendar-day windows (same wall-clock horizon across timeframes)
TRAIN_DAYS = 365
TEST_DAYS = 120
MIN_TRADES_TRAIN_FOLD = 15


def walk_forward(df: pd.DataFrame, tf: str, fam: str) -> dict:
    bpd = BARS_PER_DAY[tf]
    train_bars = TRAIN_DAYS * bpd
    test_bars = TEST_DAYS * bpd
    params = grids(tf)[fam]
    n = len(df)
    if n < train_bars + test_bars + 5:
        return {"status": "insufficient_bars", "bars": n}

    sigfn = SIGNALS[fam]

    def eval_window(ctx: pd.DataFrame, p: dict, entry_start: int):
        """Run a config on ctx but only allow ENTRIES at/after entry_start, so the
        bars before it serve purely as indicator warmup (causal, no leakage)."""
        o = ctx["open"].to_numpy(); h = ctx["high"].to_numpy()
        lo = ctx["low"].to_numpy(); c = ctx["close"].to_numpy()
        sig = sigfn(o, h, lo, c, p).copy()
        if entry_start > 0:
            sig[:entry_start] = 0
        return bracket_backtest(ctx, sig, p["tp"], p["sl"], p["max_hold"],
                                COST_BPS_PER_SIDE, None)

    oos_trades = []          # pooled OOS trade net returns
    fold_nets = []           # per-fold compounded net
    fold_wins = []           # per-fold OOS win rate
    fold_n = []
    start = 0
    while start + train_bars + test_bars <= n:
        tr = df.iloc[start:start + train_bars]
        # choose params on TRAIN by expectancy with a trade floor
        best = None
        for p in params:
            t = run_config(tr, fam, p, COST_BPS_PER_SIDE, None)
            m = trade_metrics(t)
            if m["n"] < MIN_TRADES_TRAIN_FOLD:
                continue
            if best is None or m["expectancy"] > best[0]:
                best = (m["expectancy"], p)
        if best is not None:
            # test ctx = train+test bars; entries restricted to the test portion
            ctx = df.iloc[start:start + train_bars + test_bars]
            te_trades = eval_window(ctx, best[1], entry_start=train_bars)
            if te_trades:
                rets = [x.ret_net for x in te_trades]
                oos_trades.extend(rets)
                comp = float(np.prod([1 + r for r in rets]) - 1)
                fold_nets.append(comp)
                fold_wins.append(float(np.mean([r > 0 for r in rets])))
                fold_n.append(len(rets))
        start += test_bars   # non-overlapping test windows

    if not oos_trades:
        return {"status": "no_oos_trades", "folds": 0}
    rets = np.array(oos_trades)
    wins = rets[rets > 0]; losses = rets[rets <= 0]
    eq = np.cumprod(1 + rets)
    peak = np.maximum.accumulate(eq)
    gross_w = wins.sum(); gross_l = -losses.sum()
    pf = (gross_w / gross_l) if gross_l > 1e-12 else float("inf")
    return {
        "status": "ok",
        "folds": len(fold_nets),
        "oos_n_trades": int(len(rets)),
        "oos_win_rate": float((rets > 0).mean()),
        "oos_net": float(eq[-1] - 1.0),
        "oos_profit_factor": float(pf),
        "oos_expectancy": float(rets.mean()),
        "oos_max_dd": float((eq / peak - 1.0).min()),
        "fold_win_rate": float(np.mean([x > 0 for x in fold_nets])),
        "fold_winrate_min": float(np.min(fold_wins)),
        "fold_winrate_med": float(np.median(fold_wins)),
        "fold_winrate_max": float(np.max(fold_wins)),
        "median_fold_net": float(np.median(fold_nets)),
        "oos_returns": rets.tolist(),
    }


def main(argv):
    coins = [a.upper() for a in argv if a.upper() in COINS] or COINS
    tfs = [a for a in argv if a in TIMEFRAMES] or TIMEFRAMES
    fams = list(SIGNALS)
    out = {"train_days": TRAIN_DAYS, "test_days": TEST_DAYS,
           "cost_bps_per_side": COST_BPS_PER_SIDE, "results": {}}
    print(f"ROLLING WALK-FORWARD  coins={coins} tfs={tfs}  "
          f"train={TRAIN_DAYS}d test={TEST_DAYS}d (non-overlapping)  "
          f"cost={COST_BPS_PER_SIDE}bps/side\n")
    print(f"  {'coin':<4} {'tf':<4} {'family':<15} {'folds':>5} {'OOSn':>5} "
          f"{'win':>6} {'net':>9} {'PF':>5} {'exp':>8} {'foldWin':>7} "
          f"{'foldWR(min/med/max)':>20}")
    for sym in coins:
        df1h = load_1h(sym)
        out["results"].setdefault(sym, {})
        for tf in tfs:
            df = resample(df1h, tf)
            out["results"][sym][tf] = {}
            for fam in fams:
                r = walk_forward(df, tf, fam)
                out["results"][sym][tf][fam] = {k: v for k, v in r.items()
                                                if k != "oos_returns"}
                if r.get("status") != "ok":
                    print(f"  {sym:<4} {tf:<4} {fam:<15} {r.get('status')}")
                    continue
                print(f"  {sym:<4} {tf:<4} {fam:<15} {r['folds']:>5} "
                      f"{r['oos_n_trades']:>5} {r['oos_win_rate']:>6.1%} "
                      f"{r['oos_net']:>+9.1%} {r['oos_profit_factor']:>5.2f} "
                      f"{r['oos_expectancy']:>+8.3%} {r['fold_win_rate']:>7.1%} "
                      f"{r['fold_winrate_min']:>5.0%}/{r['fold_winrate_med']:>4.0%}"
                      f"/{r['fold_winrate_max']:>4.0%}")
                # persist OOS trade-equity for the strong intraday survivors
                if r["oos_net"] > 0 and r["oos_n_trades"] >= 30:
                    eqc = np.cumprod(1 + np.array(r["oos_returns"]))
                    pd.Series(eqc).to_csv(
                        os.path.join(RESULTS, f"dtwf_{sym}_{tf}_{fam}_oos_eq.csv"),
                        index_label="trade", header=["equity"])
    with open(os.path.join(RESULTS, "daytrade_walkforward_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=float)
    print(f"\nwrote {os.path.join(RESULTS, 'daytrade_walkforward_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
