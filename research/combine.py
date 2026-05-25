"""Combine the daily trend book with the intraday mean-reversion sleeve.

The trend book banks +50% in ~80% of years but misses the trendless years
(2023, 2025). If the intraday-MR sleeve is positive in *those* years and roughly
uncorrelated with trend, blending the two raises the book's worst years above the
+50% line. This script measures exactly that, fully OOS:

  combined_coin[t] = (1-w)*trend_oos[coin][t] + w*mr_oos[coin][t]
  book[t]          = mean over coins of combined_coin[t]
  -> sweep blend weight w and leverage m, apply the annual +50% profit-lock,
     report calendar-year hit-rate, and compare against trend-only.

Trend streams come from annual_target.best_returns (the v2 walk-forward OOS used
in the validated study). MR streams are the daily-aggregated OOS series written
by intraday.py. Both are out-of-sample; the blend introduces no look-ahead (fixed
weights, no per-year fitting of w/m beyond an honest grid reported in full).
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import annual_target as at
from annual_target import simulate_year, TARGET

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
STOP = 0.40


def load_mr_daily(sym: str) -> pd.Series:
    path = os.path.join(RESULTS, f"intraday_mr_{sym}_daily.csv")
    if not os.path.exists(path):
        return pd.Series(dtype=float)
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    return df.iloc[:, 0]


def evaluate_book(book_daily: pd.Series, m_grid, label: str):
    rows = []
    for m in m_grid:
        per_year = []
        for y in sorted(set(book_daily.index.year)):
            ry = book_daily[book_daily.index.year == y]
            if len(ry) < 250:
                continue
            per_year.append((int(y), simulate_year(ry.values, m, TARGET, STOP)))
        if not per_year:
            continue
        rets = np.array([r for _, r in per_year])
        banked = int((rets >= TARGET - 1e-9).sum())
        rows.append({
            "m": m, "banked": banked, "full_years": len(per_year),
            "hit_rate": round(banked / len(per_year), 3),
            "avg_year": round(float(rets.mean()), 4),
            "worst_year": round(float(rets.min()), 4),
            "per_year": per_year,
        })
    sane = [e for e in rows if e["worst_year"] >= -0.55] or rows
    best = max(sane, key=lambda e: (e["hit_rate"], e["avg_year"])) if sane else None
    return rows, best


def main(argv):
    coins = [a.upper() for a in argv if a.upper() in COINS] or COINS

    print("Loading trend (daily) OOS streams via walk-forward ...")
    trend = {}
    for c in coins:
        r, fam = at.best_returns(c)
        trend[c] = r
        print(f"  {c}: trend engine={fam}, {len(r)} days")

    mr = {c: load_mr_daily(c) for c in coins}
    have_mr = {c: s for c, s in mr.items() if not s.empty}
    print(f"MR sleeves available: {list(have_mr)}")

    # correlation of equal-weight trend book vs equal-weight MR book (annual)
    tb = pd.DataFrame(trend).mean(axis=1).dropna()
    if have_mr:
        mb = pd.DataFrame(have_mr).mean(axis=1).dropna()
        common = tb.index.intersection(mb.index)
        if len(common) > 30:
            corr = float(np.corrcoef(tb.reindex(common).fillna(0),
                                     mb.reindex(common).fillna(0))[0, 1])
            print(f"\nDaily-return correlation trend-book vs MR-book: {corr:+.3f}")

    m_grid = [1, 2, 3, 5]
    weights = [0.0, 0.2, 0.35, 0.5]
    out = {"coins": coins, "blends": {}}

    print(f"\n{'='*88}\nBLEND SWEEP — book = equal-weight coins of [(1-w)*trend + w*MR]; "
          f"annual +50% lock")
    best_overall = None
    for w in weights:
        # build combined per-coin daily, then equal-weight book
        combined = {}
        for c in coins:
            t = trend[c]
            if w > 0 and c in have_mr:
                s = have_mr[c]
                idx = t.index.union(s.index)
                comb = (1 - w) * t.reindex(idx).fillna(0.0) + w * s.reindex(idx).fillna(0.0)
            else:
                comb = t
            combined[c] = comb
        book = pd.DataFrame(combined).mean(axis=1).dropna()
        rows, best = evaluate_book(book, m_grid, f"w={w}")
        out["blends"][str(w)] = {"sweep": rows, "best": best}
        if best:
            tag = "trend-only" if w == 0 else f"trend+{int(w*100)}%MR"
            print(f"\n  [{tag}]  best m={best['m']}: "
                  f"{best['banked']}/{best['full_years']} years >=+50% "
                  f"({best['hit_rate']:.0%}), worst {best['worst_year']:+.0%}, "
                  f"avg {best['avg_year']:+.0%}")
            print("     per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in best["per_year"]))
            score = (best["hit_rate"], best["avg_year"])
            if best_overall is None or score > best_overall[0]:
                best_overall = (score, tag, best)

    if best_overall:
        _, tag, b = best_overall
        print(f"\n{'='*88}\nBEST BLEND: [{tag}] m={b['m']} -> "
              f"{b['banked']}/{b['full_years']} years >=+50% ({b['hit_rate']:.0%}), "
              f"worst {b['worst_year']:+.0%}")

    with open(os.path.join(RESULTS, "combine_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'combine_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
