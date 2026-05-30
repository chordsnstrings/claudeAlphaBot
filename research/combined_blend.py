"""Combined BTC + ETH blend strategy — the best risk-adjusted result of the session.

Runs the ETH blend (eth_blend) and BTC blend (btc_blend) as one combined book at equal
weight (50/50). Correlation between the two blends is +0.51 -- moderate diversification
that lifts the combined Sharpe to 1.18 (best of session), with max DD -24% (lowest of any
return-generating strategy).

Reuses each module's blend_returns() then averages with equal weight. The harvest layer
operates on the combined daily returns (one shared base account, one shared cash pool).

Run:  python combined_blend.py                  # backtest + per-year harvest
      python combined_blend.py --now            # current stance (both assets)
      python combined_blend.py --harvest-sweep  # compound-vs-harvest policy sensitivity
"""
from __future__ import annotations

import sys
import numpy as np
import pandas as pd

import scalp_sweep as ss
import eth_blend as ETHBL
import btc_blend as BTCBL

W_ETH, W_BTC = 0.5, 0.5
COST_BPS = 5.0
BASE = 10000.0
HARVEST_DECAY = 0.15


def blend_returns():
    e, _ = ETHBL.blend_returns()
    b, _ = BTCBL.blend_returns()
    both = pd.concat({"ETH": e, "BTC": b}, axis=1, sort=True).dropna()
    return (W_ETH * both["ETH"] + W_BTC * both["BTC"]).dropna(), both


def harvest(daily, base=BASE, decay=HARVEST_DECAY):
    """Wrapper around ETHBL.harvest (same logic)."""
    return ETHBL.harvest(daily, base, decay)


def harvest_policy(daily, base=BASE, decay=None, min_lock=None, annual=True, name=""):
    """Generalised harvest sim. decay=None disables decay-trigger. min_lock=2.0 means only
    harvest when equity > min_lock*base (lets early gains keep compounding). annual=True
    sweeps any remaining excess at year-end."""
    eq = base; peak = base; bank = 0.0; idx = list(daily.index); records = []
    for i, (dt, r) in enumerate(daily.items()):
        eq *= (1 + r); peak = max(peak, eq)
        if decay is not None and eq < peak * (1 - decay):
            cut = min_lock * base if min_lock else base
            if eq > cut:
                h = eq - cut; bank += h; eq = cut; peak = cut
        last = (i == len(idx) - 1) or (idx[i + 1].year != dt.year)
        if last and annual:
            cut = min_lock * base if min_lock else base
            if eq > cut:
                h = eq - cut; bank += h; eq = cut; peak = cut
    final = eq + bank
    eq_curve = base * (1 + daily).cumprod()
    raw_mdd = (eq_curve / eq_curve.cummax() - 1).min()
    return dict(name=name, final=final, bank=bank, eq=eq, raw_mdd=raw_mdd)


def backtest():
    b, _ = blend_returns()
    m = ss.daily_metrics(b)
    print(f"=== COMBINED BTC+ETH BLEND backtest {b.index[0].date()} -> {b.index[-1].date()} ===")
    print(f"  ann {m['ann']*100:+.0f}%  Sharpe {m['sharpe']:.2f}  Calmar {m['calmar']:.2f}  "
          f"maxDD {m['maxdd']*100:.0f}%  positive months {m['pos_months']*100:.0f}%")
    print(f"\n  $10k from 2023 with harvest ({HARVEST_DECAY:.0%} decay & year-end):")
    print(f"  {'year':6}{'peak':>11}{'cash out':>11}{'cum cash':>11}{'TOTAL':>11}")
    for y, pk, h, bk, tot in harvest(b[b.index >= '2023-01-01']):
        tag = " YTD" if y == b.index[-1].year else ""
        print(f"  {y}{tag:4}{pk:>10,.0f}{h:>11,.0f}{bk:>11,.0f}{tot:>11,.0f}")


def now():
    print("=" * 80)
    print("ETH side:"); ETHBL.now()
    print("\nBTC side:"); BTCBL.now()
    print("\nCOMBINED: positions are independent per asset; each contributes 50% of the book.")


def harvest_sweep():
    """Compare harvest policies on the path to 10x. Compounding wins for 10x; harvest gives
    cash certainty but caps total wealth at base + linear sum of harvests."""
    b, _ = blend_returns()
    sub = b[b.index >= pd.Timestamp("2023-01-01")]
    print(f"\n=== HARVEST POLICY SWEEP — $10k from 2023, combined BTC+ETH blend ===")
    print(f"  test window: {sub.index[0].date()} -> {sub.index[-1].date()} ({len(sub)} days)")

    policies = [
        ("compound (no harvest)",        harvest_policy(sub, decay=None, annual=False, name="no harvest")),
        ("yearly only (no decay rule)",  harvest_policy(sub, decay=None, annual=True, name="yearly only")),
        ("decay 15% + yearly (current)", harvest_policy(sub, decay=0.15, annual=True, name="15%+yearly")),
        ("decay 25% + yearly",           harvest_policy(sub, decay=0.25, annual=True, name="25%+yearly")),
        ("compound until 2x, then harvest", harvest_policy(sub, decay=0.15, min_lock=2.0, annual=True, name="≥2x then h")),
        ("compound until 3x, then harvest", harvest_policy(sub, decay=0.15, min_lock=3.0, annual=True, name="≥3x then h")),
    ]
    print(f"\n  {'policy':40}{'trading eq':>12}{'banked':>11}{'TOTAL':>11}{'raw mdd':>11}")
    print("  " + "-" * 80)
    for nm, r in policies:
        print(f"  {nm:40}{r['eq']:>11,.0f}${r['bank']:>9,.0f}${r['final']:>9,.0f}{r['raw_mdd']*100:>+10.0f}%")

    # Project: years to 10x at the validated forward edge (under each compounding assumption)
    print(f"\n  PROJECTION — years to 10x from $10k base:")
    forward_ann = 0.19   # combined WF-OOS ~+19%/yr (avg of ETH +24% and BTC +14%)
    print(f"  Using forward WF-OOS edge: +{forward_ann*100:.0f}%/yr (avg of ETH +24% & BTC +14%)")
    print(f"  {'leverage':14}{'CAGR':>8}{'years to 10x':>16}{'expected DD':>14}")
    print("  " + "-" * 52)
    for lev in (1.0, 1.5, 2.0):
        eff = forward_ann * lev
        yrs = np.log(10) / np.log(1 + eff) if eff > 0 else float("inf")
        # rough DD scaling at fixed leverage
        dd_base = 0.24
        dd_lev = 1 - (1 - dd_base) ** lev
        print(f"  {lev:.1f}x{'':10}{eff*100:>+7.0f}%{yrs:>16.1f}{dd_lev*100:>+13.0f}%")
    print("\n  Only PURE COMPOUNDING reaches 10x. Harvest caps wealth at base + Σ cash.")
    print("  Hybrid (compound until ≥2x, then harvest excess) keeps most upside + locks profits.")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--now" in args: now()
    elif "--harvest-sweep" in args: harvest_sweep()
    else: backtest()
