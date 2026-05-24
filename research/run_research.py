"""Per-asset strategy research driver.

For every asset: run walk-forward on every strategy family, rank families by
out-of-sample evidence, and pick the asset-specific winner. Writes a JSON
result bundle and per-asset OOS equity curves under ``results/``.

Usage:
    python run_research.py                # core assets (BTC ETH DOT)
    python run_research.py --all          # full universe
    python run_research.py BTC ETH        # explicit list
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import Costs, buy_hold_metrics, ANN
from strategies import all_families
from walkforward import walk_forward, WFResult

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")

# OOS acceptance gate for a per-asset strategy.
GATE = dict(min_oos_sharpe=0.8, min_fold_pass=0.55, min_cagr=0.30, max_dd_floor=-0.55)


def wf_params(prices: pd.Series) -> dict:
    """Shorter windows for shorter histories so we still get >=3 folds."""
    span_days = (prices.index[-1] - prices.index[0]).days
    if span_days >= 2200:
        return dict(train_days=540, test_days=180)
    if span_days >= 1400:
        return dict(train_days=420, test_days=150)
    return dict(train_days=365, test_days=120)


def composite(s: dict) -> float:
    sc = s["oos_sharpe"]
    sc += 0.6 * s["fold_pass_rate"]
    sc += 0.5 * float(np.clip(s["oos_cagr"] / 0.30, 0.0, 2.0))
    if s["oos_max_dd"] < -0.45:
        sc -= (abs(s["oos_max_dd"]) - 0.45) * 1.5
    sc -= 0.01 * max(0.0, s["param_stability_pct"] - 40.0)
    return sc


def passes_gate(s: dict) -> bool:
    return (
        s["oos_sharpe"] >= GATE["min_oos_sharpe"]
        and s["fold_pass_rate"] >= GATE["min_fold_pass"]
        and s["oos_cagr"] >= GATE["min_cagr"]
        and s["oos_max_dd"] >= GATE["max_dd_floor"]
    )


def run_asset(asset: str, costs: Costs) -> dict:
    df = datamod.load(asset)
    prices = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    prices = prices[~prices.index.duplicated(keep="first")].sort_index()
    wfp = wf_params(prices)
    bh = buy_hold_metrics(prices)

    results: list[WFResult] = []
    for fam in all_families():
        r = walk_forward(asset, prices, fam, costs=costs, **wfp)
        if r is not None and len(r.folds) >= 3:
            results.append(r)

    summaries = sorted((r.summary() for r in results), key=composite, reverse=True)
    by_name = {r.family: r for r in results}

    winner = summaries[0] if summaries else None
    gated = [s for s in summaries if passes_gate(s)]

    print(f"\n{'='*100}\n{asset}  ({wfp})  span {prices.index[0].date()}..{prices.index[-1].date()} "
          f"({len(prices)} days)")
    print(f"  buy&hold: CAGR {bh.cagr:+.1%}  Sharpe {bh.sharpe:.2f}  maxDD {bh.max_dd:.1%}")
    print(f"  {'family':10} {'OOScagr':>8} {'Sharpe':>7} {'Calmar':>7} {'maxDD':>7} "
          f"{'foldwin':>7} {'avgfold':>7} {'stab%':>6} {'expo':>5} {'comp':>6} gate")
    for s in summaries:
        mark = "PASS" if passes_gate(s) else ""
        print(f"  {s['family']:10} {s['oos_cagr']:+8.1%} {s['oos_sharpe']:7.2f} "
              f"{s['oos_calmar']:7.2f} {s['oos_max_dd']:7.1%} {s['fold_pass_rate']:7.2f} "
              f"{s['avg_fold_sharpe']:7.2f} {s['param_stability_pct']:6.1f} "
              f"{s['avg_exposure']:5.2f} {composite(s):6.2f} {mark}")

    out = {
        "asset": asset,
        "wf_params": wfp,
        "buy_hold": bh.as_dict(),
        "summaries": summaries,
        "winner": winner,
        "winner_passes_gate": bool(winner and passes_gate(winner)),
        "n_gated": len(gated),
    }
    # winner fold detail + persisted OOS curve
    winner_returns = None
    if winner:
        wr = by_name[winner["family"]]
        out["winner_folds"] = [f.__dict__ for f in wr.folds]
        eq = wr.oos_equity
        eq.to_csv(os.path.join(RESULTS, f"{asset}_oos_equity.csv"), header=["equity"])
        winner_returns = wr.oos_returns
    return out, winner_returns


def build_portfolio(winner_returns: dict[str, pd.Series], target_vol: float = 0.30) -> dict:
    """Combine the per-asset OOS return streams into one portfolio. Each
    stream is already fully out-of-sample, so this is pure allocation, not
    re-fitting. Equal-weight across whichever assets are live on a given day,
    then scale the whole book to a target annualised vol (single constant
    computed from the *full* OOS window -> reported as in-sample-vol-scaled;
    the unscaled equal-weight result is reported too)."""
    if not winner_returns:
        return {}
    mat = pd.DataFrame(winner_returns).sort_index()
    ew = mat.mean(axis=1, skipna=True)        # equal weight among active assets
    ew = ew.dropna()
    from engine import compute_metrics
    held_proxy = (mat.notna().sum(axis=1) > 0).astype(float).reindex(ew.index).fillna(0.0)
    ew_m = compute_metrics(ew, held_proxy)
    # constant vol scaling to target
    realized = ew.std() * (ANN ** 0.5)
    scale = (target_vol / realized) if realized > 0 else 1.0
    scaled = ew * scale
    sc_m = compute_metrics(scaled, held_proxy * scale)
    return {
        "assets": list(mat.columns),
        "equal_weight": ew_m.as_dict(),
        "vol_scaled": {"target_vol": target_vol, "scale": round(scale, 3), **sc_m.as_dict()},
        "_ew_returns": ew,
    }


def main(argv: list[str]) -> None:
    os.makedirs(RESULTS, exist_ok=True)
    costs = Costs()
    if "--all" in argv:
        assets = list(datamod.ASSETS.keys())
        argv = [a for a in argv if a != "--all"]
    else:
        explicit = [a for a in argv if a in datamod.ASSETS]
        assets = explicit or datamod.CORE_ASSETS

    print(f"cost model: txn={costs.txn*1e4:.1f}bps/side  funding={costs.funding_daily*1e4:.2f}bps/day")
    bundle = {"cost_model": {"txn_bps": costs.txn * 1e4, "funding_bps_day": costs.funding_daily * 1e4},
              "gate": GATE, "assets": {}}
    winner_rets: dict[str, pd.Series] = {}
    for a in assets:
        res, wret = run_asset(a, costs)
        bundle["assets"][a] = res
        if wret is not None:
            winner_rets[a] = wret

    print(f"\n{'='*100}\nSUMMARY — asset-specific winners (out-of-sample, walk-forward)")
    print(f"  {'asset':6} {'family':12} {'OOScagr':>8} {'Sharpe':>7} {'Calmar':>7} {'maxDD':>7} "
          f"{'foldwin':>7} {'B&Hcagr':>8} {'gate':>6}")
    for a in assets:
        w = bundle["assets"][a]["winner"]
        bh = bundle["assets"][a]["buy_hold"]
        if w:
            g = "PASS" if bundle["assets"][a]["winner_passes_gate"] else "fail"
            print(f"  {a:6} {w['family']:12} {w['oos_cagr']:+8.1%} {w['oos_sharpe']:7.2f} "
                  f"{w['oos_calmar']:7.2f} {w['oos_max_dd']:7.1%} {w['fold_pass_rate']:7.2f} "
                  f"{bh['cagr']:+8.1%} {g:>6}")

    # ---- portfolio of the per-asset strategies (all-OOS allocation) ----
    port = build_portfolio(winner_rets, target_vol=0.30)
    if port:
        ew = port["equal_weight"]; sc = port["vol_scaled"]
        bundle["portfolio"] = {k: v for k, v in port.items() if k != "_ew_returns"}
        port["_ew_returns"].pipe(lambda s: (1+s).cumprod()).to_csv(
            os.path.join(RESULTS, "PORTFOLIO_oos_equity.csv"), header=["equity"])
        print(f"\n{'='*100}\nPORTFOLIO — equal-weight across {port['assets']} (all returns OOS)")
        print(f"  equal-weight : CAGR {ew['cagr']:+.1%}  Sharpe {ew['sharpe']:.2f}  "
              f"Sortino {ew['sortino']:.2f}  maxDD {ew['max_dd']:.1%}  Calmar {ew['calmar']:.2f}  vol {ew['ann_vol']:.1%}")
        print(f"  vol-targeted : CAGR {sc['cagr']:+.1%}  Sharpe {sc['sharpe']:.2f}  "
              f"maxDD {sc['max_dd']:.1%}  (target {sc['target_vol']:.0%}, lev x{sc['scale']})")

    with open(os.path.join(RESULTS, "research_results.json"), "w") as f:
        json.dump(bundle, f, indent=2, default=str)
    print(f"\nwrote {os.path.join(RESULTS, 'research_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
