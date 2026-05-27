"""Sweep the harvest-policy space for the best cash-harvest with the LEAST drawdown,
subject to two hard constraints from the goal:
  (1) self-funding  — you put in the $300k base ONCE; every losing-year top-up must come
      from already-harvested profit (cumulative net cash never goes negative, no
      liquidation). You never inject external cash to survive.
  (2) investment returned — cumulative harvested cash must reach the full $300k base
      (you get your money back); we also report HOW FAST.

Then we want max ROI (cash/base) with the least account drawdown. We sweep the book
defensiveness (spine weight), leverage m, the profit-lock trigger (+50%/+100%), the
stop, and the profit-taking policy (lock-flat / harvest-continue / leave 25-50% on the
table), and report the Pareto frontier (best ROI at each drawdown ceiling) + the best
risk-adjusted, self-funding, principal-returning config.

Run: python harvest_sweep.py
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

from unified_bot import build_panel, harvest_run, weighted

BASE = 300_000.0

SPINES = [0.00, 0.15, 0.30, 0.45, 0.60]          # 0 = growth; 0.60 = all-weather-max
M = [1.0, 1.5, 2.0, 2.5, 3.0]
LOCKS = [1.5, 2.0]                                # take profit at +50% or +100% (2x)
STOPS = [0.20, 0.30, 0.40]
POLICIES = [(1.0, True, "lock-flat"), (1.0, False, "harvest-cont"),
            (0.75, False, "leave25"), (0.50, False, "leave50")]


def book_w(spine: float) -> dict:
    return {"CORE": round(1.0 - 0.30 - spine, 4), "BTC1H": 0.15, "ETH8H": 0.15, "SPINE": spine}


def evaluate(r, m, lock, stop, frac, flat) -> dict:
    d = harvest_run(r, base=BASE, m=m, double_at=lock, stop=stop,
                    harvest_frac=frac, go_flat=flat)
    cum, eq = d["cum_cash"], d["equity"]
    total = float(cum.iloc[-1])
    # TRUE drawdown = drawdown of total wealth (at-risk account + cash pocketed).
    # Withdrawals/resets just move money to the pocket -> the wealth curve is continuous,
    # so this is the real peak-to-trough the investor experiences.
    wealth = eq + cum
    maxdd = float((wealth / wealth.cummax() - 1.0).min())
    liq = bool(d["event"].str.contains("LIQ").any())
    self_fund = (float(cum.min()) >= -1.0) and not liq          # never net out-of-pocket
    rec = cum[cum >= BASE]
    rec_days = int((rec.index[0] - d.index[0]).days) if len(rec) else None
    yr = d.groupby(d.index.year)["cash"].sum()
    return {"roi": total / BASE, "total": total, "maxdd": maxdd, "self_fund": self_fund,
            "rec_days": rec_days, "worst_yr": float(yr.min()),
            "score": (total / BASE) / abs(maxdd) if maxdd < 0 else total / BASE}


def main(argv):
    df, _ = build_panel()
    books = {s: weighted(df, book_w(s)) for s in SPINES}
    rows = []
    for s, r in books.items():
        for m in M:
            for lock in LOCKS:
                for stop in STOPS:
                    for frac, flat, pol in POLICIES:
                        e = evaluate(r, m, lock, stop, frac, flat)
                        e.update(spine=s, m=m, lock=lock, stop=stop, pol=pol)
                        rows.append(e)
    print(f"HARVEST SWEEP — base ${BASE:,.0f}, {df.index[0].date()}->{df.index[-1].date()}, "
          f"{len(rows)} configs.\nConstraints: self-funding (no external top-up ever) AND "
          f"investment fully returned.\n")

    ok = [e for e in rows if e["self_fund"] and e["rec_days"] is not None]
    print(f"  {len(ok)}/{len(rows)} configs are self-funding AND return the full $300k.\n")

    def desc(e):
        return (f"spine {e['spine']:.0%}, m={e['m']:g}, lock +{(e['lock']-1)*100:.0f}%, "
                f"stop -{e['stop']:.0%}, {e['pol']}")

    print("  PARETO FRONTIER — best ROI (self-funding) at each wealth-drawdown ceiling")
    print("  (drawdown = peak-to-trough of total wealth = at-risk account + cash pocketed):")
    print(f"    {'wlthDD<=':>8} {'ROI':>6} {'cash$':>11} {'wlthDD':>7} {'$back in':>9}  config")
    for ceil in (0.15, 0.20, 0.25, 0.30, 0.40, 1.00):
        cands = [e for e in ok if abs(e["maxdd"]) <= ceil + 1e-9]
        if not cands:
            print(f"    {'-'+format(ceil,'.0%'):>8}  (none)")
            continue
        b = max(cands, key=lambda e: e["roi"])
        print(f"    {'-'+format(ceil,'.0%'):>8} {b['roi']:>5.1f}x ${b['total']:>10,.0f} "
              f"{b['maxdd']:>7.0%} {str(b['rec_days'])+'d':>9}  {desc(b)}")

    best = max(ok, key=lambda e: e["score"])
    print(f"\n  BEST RISK-ADJUSTED (max ROI per unit wealth-drawdown): {desc(best)}")
    print(f"    ROI {best['roi']:.1f}x  (${best['total']:,.0f} cash on ${BASE:,.0f}), "
          f"wealth maxDD {best['maxdd']:.0%}, principal back in {best['rec_days']} days, "
          f"worst year ${best['worst_yr']:,.0f}, self-funding ✔")

    print("\n  Top 8 self-funding configs by ROI-per-wealth-drawdown:")
    print(f"    {'ROI':>6} {'cash$':>11} {'wlthDD':>7} {'score':>6} {'$back':>7}  config")
    for e in sorted(ok, key=lambda e: e["score"], reverse=True)[:8]:
        print(f"    {e['roi']:>5.1f}x ${e['total']:>10,.0f} {e['maxdd']:>7.0%} "
              f"{e['score']:>6.2f} {str(e['rec_days'])+'d':>7}  {desc(e)}")
    print("\n  Backtest, OOS in the walk-forward sense; 2021/2026 partial; 4.5 lumpy "
          "years; leverage gap-risk real. Not predictive.")


if __name__ == "__main__":
    main(sys.argv[1:])
