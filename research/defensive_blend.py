"""Three-sleeve blend: absolute-trend + cross-sectional + regime orchestrator.

The trend+XS blend (xs_blend.py) reaches 9/10 years >=+50%; the lone miss is 2022,
the deep bear. Banking a year like 2022 structurally requires being SHORT — both
momentum sleeves are long-biased and sit flat/lose in a broad crash. The v2
`orchestrator` is the one pre-existing engine that SHORTS classified downtrends,
so it is the honest candidate for a "defensive" third sleeve.

CAUTION (stated up front): 2022 is now the single holdout, so any sleeve added
"to fix 2022" risks overfitting to one year. To keep this honest we (a) use the
orchestrator as-is (a general regime engine, not tuned to 2022), (b) report the
orchestrator book's FULL per-year record, and (c) require the 3-way blend to hold
its other years, not just rescue 2022. If a blend banks 2022 only by breaking
another year, the honest ceiling stays 9/10.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import annual_target as at
from annual_target import simulate_year, TARGET
from engine import Costs
from strategies import v2_families
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]
STOP = 0.40
COSTS = Costs(txn=0.0006, funding_daily=0.0001)


def orchestrator_book_daily() -> pd.Series:
    orch = [f for f in v2_families() if f.name == "orchestrator"][0]
    streams = {}
    for c in COINS:
        p = at.load_prices(c)
        wfp = at.wf_params(p)
        r = walk_forward(c, p, orch, costs=COSTS, **wfp)
        if r is not None and len(r.folds) >= 3:
            streams[c] = r.oos_returns
    return pd.DataFrame(streams).mean(axis=1).dropna()


def trend_book_daily() -> pd.Series:
    streams = {c: at.best_returns(c)[0] for c in COINS}
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


def eval_stream(stream: pd.Series, m_grid=(1, 2, 3, 5)):
    rows = []
    for m in m_grid:
        py = per_year(stream, m)
        if not py:
            continue
        rs = np.array([r for _, r in py])
        banked = int((rs >= TARGET - 1e-9).sum())
        rows.append(dict(m=m, banked=banked, full_years=len(py),
                         hit_rate=round(banked/len(py), 3),
                         avg_year=round(float(rs.mean()), 4),
                         worst_year=round(float(rs.min()), 4), per_year=py))
    sane = [e for e in rows if e["worst_year"] >= -0.55] or rows
    best = max(sane, key=lambda e: (e["hit_rate"], e["avg_year"])) if sane else None
    return rows, best


def main(argv):
    print("Building trend, XS, orchestrator books (walk-forward OOS) ...")
    tb = trend_book_daily()
    xb = xs_daily()
    ob = orchestrator_book_daily()

    _, ob_best = eval_stream(ob)
    print(f"\nOrchestrator book standalone — best m={ob_best['m']}: "
          f"{ob_best['banked']}/{ob_best['full_years']} ({ob_best['hit_rate']:.0%}), "
          f"worst {ob_best['worst_year']:+.0%}")
    print("   per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in ob_best["per_year"]))

    # correlations
    idx = tb.index.intersection(xb.index).intersection(ob.index)
    def corr(a, b):
        return float(np.corrcoef(a.reindex(idx).fillna(0), b.reindex(idx).fillna(0))[0, 1])
    print(f"\ncorr trend/XS={corr(tb,xb):+.2f}  trend/orch={corr(tb,ob):+.2f}  "
          f"XS/orch={corr(xb,ob):+.2f}")

    # 3-way blend grid (coarse weights summing to 1; defensive sleeve kept modest)
    print(f"\n{'='*84}\n3-WAY BLEND  w=(trend, XS, orch); annual +50% lock")
    out = {"orch_best": ob_best, "blends": {}}
    best_overall = None
    grid = [
        (1.0, 0.0, 0.0), (0.5, 0.5, 0.0), (0.3, 0.7, 0.0),
        (0.5, 0.3, 0.2), (0.4, 0.4, 0.2), (0.3, 0.5, 0.2),
        (0.4, 0.3, 0.3), (0.3, 0.4, 0.3), (0.34, 0.33, 0.33),
        (0.25, 0.45, 0.30), (0.2, 0.5, 0.3),
    ]
    allidx = tb.index.union(xb.index).union(ob.index)
    for (wt, wx, wo) in grid:
        comb = (wt * tb.reindex(allidx).fillna(0.0)
                + wx * xb.reindex(allidx).fillna(0.0)
                + wo * ob.reindex(allidx).fillna(0.0))
        rows, best = eval_stream(comb)
        key = f"T{int(wt*100)}/X{int(wx*100)}/O{int(wo*100)}"
        out["blends"][key] = {"sweep": rows, "best": best}
        if best:
            print(f"\n  [{key}] best m={best['m']}: {best['banked']}/{best['full_years']} "
                  f"({best['hit_rate']:.0%}), worst {best['worst_year']:+.0%}, avg {best['avg_year']:+.0%}")
            print("     per-year:", "  ".join(f"{y}:{r:+.0%}" for y, r in best["per_year"]))
            score = (best["hit_rate"], best["avg_year"])
            if best_overall is None or score > best_overall[0]:
                best_overall = (score, key, best)

    if best_overall:
        _, key, b = best_overall
        print(f"\n{'='*84}\nBEST 3-WAY: [{key}] m={b['m']} -> {b['banked']}/{b['full_years']} "
              f"({b['hit_rate']:.0%}), worst {b['worst_year']:+.0%}")
        miss = [y for y, r in b["per_year"] if r < TARGET - 1e-9]
        print(f"missed years: {miss}")
    with open(os.path.join(RESULTS, "defensive_blend_results.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'defensive_blend_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
