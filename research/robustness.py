"""Robustness checks for the chosen per-asset strategies.

1. Cost sensitivity: re-run the winning family for each core asset across a
   ladder of transaction + funding costs and confirm the OOS edge survives.
2. Sub-period stability: report OOS CAGR/Sharpe per calendar year.

Reads the winning family per asset from results/research_results.json so it
always tracks the latest selection.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs, ANN, compute_metrics
from strategies import all_families
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")


def load_prices(asset: str) -> pd.Series:
    df = datamod.load(asset)
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def wf_params(prices: pd.Series) -> dict:
    span = (prices.index[-1] - prices.index[0]).days
    if span >= 2200:
        return dict(train_days=540, test_days=180)
    if span >= 1400:
        return dict(train_days=420, test_days=150)
    return dict(train_days=365, test_days=120)


def main(argv):
    with open(os.path.join(RESULTS, "research_results.json")) as f:
        bundle = json.load(f)
    assets = [a for a in argv if a in datamod.ASSETS] or datamod.CORE_ASSETS
    fams = {f.name: f for f in all_families()}

    cost_ladder = [
        ("base", Costs(txn=0.0006, funding_daily=0.00005)),
        ("2x_txn", Costs(txn=0.0012, funding_daily=0.00005)),
        ("high_all", Costs(txn=0.0015, funding_daily=0.0001)),
        ("stress", Costs(txn=0.0025, funding_daily=0.0002)),
    ]

    print("=== COST SENSITIVITY (OOS CAGR / Sharpe by cost level) ===")
    print(f"  {'asset':6} {'family':12} " + " ".join(f"{n:>14}" for n, _ in cost_ladder))
    for a in assets:
        win = bundle["assets"][a]["winner"]
        if not win:
            continue
        fam = fams[win["family"]]
        prices = load_prices(a)
        wfp = wf_params(prices)
        cells = []
        for _, c in cost_ladder:
            r = walk_forward(a, prices, fam, costs=c, **wfp)
            cells.append(f"{r.oos.cagr:+6.1%}/{r.oos.sharpe:4.2f}")
        print(f"  {a:6} {win['family']:12} " + " ".join(f"{c:>14}" for c in cells))

    print("\n=== PER-YEAR OOS (winning family, base costs) ===")
    for a in assets:
        win = bundle["assets"][a]["winner"]
        if not win:
            continue
        fam = fams[win["family"]]
        prices = load_prices(a)
        wfp = wf_params(prices)
        r = walk_forward(a, prices, fam, costs=cost_ladder[0][1], **wfp)
        rr = r.oos_returns
        years = sorted(set(rr.index.year))
        print(f"  {a} ({win['family']}):")
        for y in years:
            ry = rr[rr.index.year == y]
            if len(ry) < 20:
                continue
            eq = (1 + ry).prod() - 1
            shp = (ry.mean() / ry.std() * np.sqrt(ANN)) if ry.std() > 0 else 0
            print(f"    {y}: ret {eq:+7.1%}  sharpe {shp:5.2f}  days {len(ry)}")


if __name__ == "__main__":
    main(sys.argv[1:])
