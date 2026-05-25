"""Blend the absolute-trend book with the cross-sectional momentum book.

The two momentum sleeves each bank +50% in ~80% of years but MISS DIFFERENT years:
  * absolute trend (TS-mom): misses the trendless 2023 & 2025
  * cross-sectional (XS-mom): banks 2023 & 2025, misses 2016 & 2022
So their "win sets" are complementary. The open question is whether a *static*
capital split can capture the union — or whether averaging dilutes the
one-wins/one-loses years below the +50% profit-lock threshold. This measures it
honestly: blend the daily OOS streams, sweep weight w and leverage m, apply the
annual +50% lock, report calendar-year hit-rate. No per-year fitting.
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


def trend_book_daily() -> pd.Series:
    streams = {}
    for c in COINS:
        r, _ = at.best_returns(c)
        streams[c] = r
    return pd.DataFrame(streams).mean(axis=1).dropna()


def xs_daily() -> pd.Series:
    df = pd.read_csv(os.path.join(RESULTS, "xsection_oos_daily.csv"),
                     index_col=0, parse_dates=True)
    return df.iloc[:, 0]


def per_year(stream: pd.Series, m: float):
    rows = []
    for y in sorted(set(stream.index.year)):
        ry = stream[stream.index.year == y]
        if len(ry) < 250:
            continue
        rows.append((int(y), simulate_year(ry.values, m, TARGET, STOP)))
    return rows


def main(argv):
    print("Building trend book (walk-forward OOS) ...")
    tb = trend_book_daily()
    xb = xs_daily()
    common = tb.index.intersection(xb.index)
    corr = float(np.corrcoef(tb.reindex(common).fillna(0),
                             xb.reindex(common).fillna(0))[0, 1])
    print(f"trend-book vs XS-book daily-return correlation: {corr:+.3f}")

    m_grid = [1, 2, 3, 5]
    weights = [0.0, 0.3, 0.5, 0.7, 1.0]
    out = {"corr": corr, "blends": {}}
    best_overall = None
    print(f"\n{'='*84}\nTREND + XS BLEND  (book = (1-w)*trend + w*XS); annual +50% lock")
    for w in weights:
        idx = tb.index.union(xb.index)
        comb = (1 - w) * tb.reindex(idx).fillna(0.0) + w * xb.reindex(idx).fillna(0.0)
        rows = []
        for m in m_grid:
            py = per_year(comb, m)
            if not py:
                continue
            rs = np.array([r for _, r in py])
            banked = int((rs >= TARGET - 1e-9).sum())
            rows.append(dict(m=m, banked=banked, full_years=len(py),
                             hit_rate=round(banked/len(py), 3),
                             avg_year=round(float(rs.mean()), 4),
                             worst_year=round(float(rs.min()), 4),
                             per_year=py))
        sane = [e for e in rows if e["worst_year"] >= -0.55] or rows
        best = max(sane, key=lambda e: (e["hit_rate"], e["avg_year"])) if sane else None
        out["blends"][str(w)] = {"sweep": rows, "best": best}
        if best:
            tag = ("trend-only" if w == 0 else "XS-only" if w == 1.0
                   else f"trend{int((1-w)*100)}/XS{int(w*100)}")
            print(f"\n  [{tag}]  best m={best['m']}: {best['banked']}/{best['full_years']} "
                  f"years >=+50% ({best['hit_rate']:.0%}), worst {best['worst_year']:+.0%}, "
                  f"avg {best['avg_year']:+.0%}")
            print("     per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in best["per_year"]))
            if best_overall is None or (best["hit_rate"], best["avg_year"]) > best_overall[0]:
                best_overall = ((best["hit_rate"], best["avg_year"]), tag, best)

    if best_overall:
        _, tag, b = best_overall
        print(f"\n{'='*84}\nBEST BLEND: [{tag}] m={b['m']} -> {b['banked']}/{b['full_years']} "
              f"years >=+50% ({b['hit_rate']:.0%}), worst {b['worst_year']:+.0%}")
    with open(os.path.join(RESULTS, "xs_blend_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'xs_blend_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
