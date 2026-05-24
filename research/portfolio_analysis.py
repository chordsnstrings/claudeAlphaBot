"""Final portfolio analysis + deployable config export.

- Recomputes each asset's winning family WF (base costs) to get OOS returns.
- Builds equal-weight portfolios (all-universe and PASS-only) and reports
  per-year consistency + full metrics.
- Exports strategy_configs.json: per-asset family + a single robust parameter
  set (the modal choice across walk-forward folds) + headline OOS metrics.
"""
from __future__ import annotations

import json
import os
from collections import Counter

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs, ANN, compute_metrics
from strategies import all_families
from walkforward import walk_forward

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
COSTS = Costs(txn=0.0006, funding_daily=0.00005)


def load_prices(asset):
    df = datamod.load(asset)
    p = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return p[~p.index.duplicated(keep="first")].sort_index()


def wf_params(prices):
    span = (prices.index[-1] - prices.index[0]).days
    if span >= 2200:
        return dict(train_days=540, test_days=180)
    if span >= 1400:
        return dict(train_days=420, test_days=150)
    return dict(train_days=365, test_days=120)


def modal_params(folds):
    """Most frequently selected param set across folds (deployable single config)."""
    keys = Counter(json.dumps(f.params, sort_keys=True, default=str) for f in folds)
    return json.loads(keys.most_common(1)[0][0])


def per_year(returns):
    out = {}
    for y in sorted(set(returns.index.year)):
        ry = returns[returns.index.year == y]
        if len(ry) < 20:
            continue
        out[int(y)] = round((1 + ry).prod() - 1, 4)
    return out


def main():
    with open(os.path.join(RESULTS, "research_results.json")) as f:
        bundle = json.load(f)
    fams = {f.name: f for f in all_families()}
    assets = list(datamod.ASSETS.keys())

    winner_rets = {}
    configs = {}
    pass_assets = []
    for a in assets:
        win = bundle["assets"][a]["winner"]
        if not win:
            continue
        fam = fams[win["family"]]
        prices = load_prices(a)
        wfp = wf_params(prices)
        r = walk_forward(a, prices, fam, costs=COSTS, **wfp)
        winner_rets[a] = r.oos_returns
        passes = bundle["assets"][a]["winner_passes_gate"]
        if passes:
            pass_assets.append(a)
        configs[a] = {
            "family": fam.name,
            "params": modal_params(r.folds),
            "passes_30pct_gate": bool(passes),
            "oos": {k: win[k] for k in ("oos_cagr", "oos_sharpe", "oos_calmar", "oos_max_dd",
                                        "fold_pass_rate", "oos_days")},
            "buy_hold_cagr": bundle["assets"][a]["buy_hold"]["cagr"],
            "per_year_oos": per_year(r.oos_returns),
            "wf": wfp,
        }

    def portfolio(names, label):
        mat = pd.DataFrame({n: winner_rets[n] for n in names}).sort_index()
        ew = mat.mean(axis=1, skipna=True).dropna()
        proxy = pd.Series(1.0, index=ew.index)
        m = compute_metrics(ew, proxy)
        py = per_year(ew)
        print(f"\n=== PORTFOLIO [{label}] equal-weight {names}")
        print(f"  OOS: CAGR {m.cagr:+.1%}  Sharpe {m.sharpe:.2f}  Sortino {m.sortino:.2f}  "
              f"maxDD {m.max_dd:.1%}  Calmar {m.calmar:.2f}  vol {m.ann_vol:.1%}  days {m.n_days}")
        pos_years = sum(1 for v in py.values() if v > 0)
        print(f"  per-year OOS: " + "  ".join(f"{y}:{v:+.0%}" for y, v in py.items()))
        print(f"  positive years: {pos_years}/{len(py)}   "
              f">=30% years: {sum(1 for v in py.values() if v>=0.30)}/{len(py)}")
        return {"assets": names, "metrics": m.as_dict(), "per_year": py}

    all_port = portfolio(assets, "ALL-9")
    pass_port = portfolio(pass_assets, "PASS-only")

    out = {
        "cost_model": {"txn_bps": COSTS.txn * 1e4, "funding_bps_day": COSTS.funding_daily * 1e4},
        "configs": configs,
        "portfolio_all": all_port,
        "portfolio_pass_only": pass_port,
    }
    with open(os.path.join(RESULTS, "strategy_configs.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'strategy_configs.json')}")


if __name__ == "__main__":
    main()
