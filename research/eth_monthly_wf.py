"""WF-OOS validation of the best ETH monthly-ROI configs from the sweep.
Tests whether the 4h-trend-at-1x results survive walk-forward parameter selection."""
from __future__ import annotations

import sys, os, itertools
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scalp_sweep as ss
import eth_monthly_sweep as EMS

# Candidate configs found in the sweep (top by positive-month frequency + ann return)
CANDIDATES = [
    ("ema12/50",  lambda df: EMS.sig_ema_cross(df, 12, 50)),
    ("ema20/100", lambda df: EMS.sig_ema_cross(df, 20, 100)),
    ("ema50/200", lambda df: EMS.sig_ema_cross(df, 50, 200)),
    ("donch20",   lambda df: EMS.sig_donchian(df, 20)),
    ("donch50",   lambda df: EMS.sig_donchian(df, 50)),
    ("donch100",  lambda df: EMS.sig_donchian(df, 100)),
    ("roc24",     lambda df: EMS.sig_roc(df, 24)),
    ("roc48",     lambda df: EMS.sig_roc(df, 48)),
    ("roc96",     lambda df: EMS.sig_roc(df, 96)),
]


def wf_select(df, train_bars, test_bars, leverage=1.0):
    """For each fold, pick the candidate with best train Sharpe, apply OOS."""
    nets = {}
    for name, fn in CANDIDATES:
        pos = fn(df)
        net, liq = EMS.backtest_lev(df, pos, leverage=leverage)
        if liq: continue
        nets[name] = net
    n = len(df); oos = pd.Series(np.nan, index=df.index)
    picks = {}; start = train_bars
    bars_per_yr = 6 * 365
    while start + test_bars <= n:
        tr = slice(start - train_bars, start); te = slice(start, start + test_bars)
        best_s, best_n = -1e18, None
        for nm, net in nets.items():
            sub = net.iloc[tr]
            if sub.std() <= 0: continue
            sh = sub.mean() / sub.std() * np.sqrt(bars_per_yr)
            if sh > best_s:
                best_s, best_n = sh, nm
        if best_n is None: start += test_bars; continue
        oos.iloc[te] = nets[best_n].iloc[te].values
        picks[best_n] = picks.get(best_n, 0) + 1
        start += test_bars
    return oos.dropna(), picks


def main():
    leverage_levels = [1, 2, 3, 5]
    train_days = 365; test_days = 60   # 1y train, 2mo test
    print(f"WF-OOS for ETH 4h monthly sweep — train {train_days}d / test {test_days}d")
    print(f"Candidates: {len(CANDIDATES)} configs (trend, momentum, breakout) with trend filter")
    print()
    ss.set_tf("4h"); df = ss.load("4h","ETH")
    bpd = 6  # 4h bars per day
    print(f"  ETH 4h data: {df.index[0].date()} -> {df.index[-1].date()} ({len(df)} bars)\n")
    print(f"  {'leverage':>10}{'ann':>8}{'Sharpe':>8}{'maxDD':>8}{'best_mo':>10}{'med_mo':>10}{'worst_mo':>10}{'pos_mo%':>10}{'%>50%':>8}")
    for lev in leverage_levels:
        oos, picks = wf_select(df, train_bars=train_days*bpd, test_bars=test_days*bpd, leverage=lev)
        if len(oos) < 100: continue
        eq = (1 + oos).cumprod()
        # liquidation check
        if (1+oos).min() <= 0:
            print(f"  {lev:>9}x  LIQUIDATED at some point in WF-OOS"); continue
        ann = eq.iloc[-1]**(365*6/len(oos)) - 1 if eq.iloc[-1] > 0 else -1
        sh = oos.mean()/oos.std()*np.sqrt(365*6) if oos.std() > 0 else 0
        mdd = (eq/eq.cummax() - 1).min()
        mo = ((1+oos).resample("ME").prod() - 1).dropna()
        if len(mo) == 0: continue
        print(f"  {lev:>9}x{ann*100:>+7.0f}%{sh:>8.2f}{mdd*100:>+7.0f}%{mo.max()*100:>+9.0f}%{mo.median()*100:>+9.0f}%{mo.min()*100:>+9.0f}%{(mo>0).mean()*100:>+9.0f}%{(mo>0.5).mean()*100:>+7.0f}%")
        if lev == 1:
            print(f"\n  Picks (1x leverage): " + ", ".join(f"{k}={v}" for k,v in sorted(picks.items(), key=lambda x:-x[1])))
            # Year-by-year for 1x
            print(f"\n  Per-year (1x WF-OOS):")
            yr_ret = oos.groupby(oos.index.year).apply(lambda x: (1+x).prod()-1)
            for y, r in yr_ret.items():
                if (oos.index.year==y).sum() < 50: continue
                print(f"    {y}: {r*100:+.0f}%")
            # Top 5 months overall
            print(f"\n  Best months (1x WF-OOS):")
            for ts, r in mo.sort_values(ascending=False).head(5).items():
                print(f"    {ts.strftime('%Y-%m')}: {r*100:+.0f}%")
            print(f"\n  Worst months (1x WF-OOS):")
            for ts, r in mo.sort_values().head(5).items():
                print(f"    {ts.strftime('%Y-%m')}: {r*100:+.0f}%")
            print()


if __name__ == "__main__":
    main()
