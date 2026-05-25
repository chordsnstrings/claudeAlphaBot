"""Deployable strategy definition — operationalises the validated research.

This is the single shippable strategy the study converged on. It maps the §13
research directly to *today's target weights* given live daily data (SOL/ETH/BTC/
DOGE/XRP from data-api.binance.vision / KuCoin), so it can drive the production
bot's risk/execution layer.

Validated expectation (OOS, walk-forward; see SOFTWARE_SPEC §12.6–12.10, §13.6):
  * banks +50% in ~86% of years fully out-of-sample (allocation walk-forwarded),
    ~90% with the best static allocation; the structural miss is a 2022-type bear
    where all five coins crash together.
  * NOT a +50%-every-year guarantee — that is unattainable here without overfitting.

Components (all causal):
  A. Absolute-trend sleeve  — long-only multi-lookback momentum (tsmom_blend) per
     coin, inverse-vol sized. Carries the trend years.
  B. Cross-sectional sleeve — each day hold the top-k strongest coins (rotation).
     Carries the trendless/dispersion years (2023, 2025).
  Book weight: w_trend=0.60, w_xs=0.40 (the allocation the walk-forward converged on).
  Effective-leverage cap and the annual +50% profit-lock / −40% stop sit on top.
  Optional crash-hedge overlay (crash_hedge.py) for softer bears (tail protection,
  not a +50% source) — OFF by default.
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd

import data as datamod
from engine import realized_vol
from strategies import sig_tsmom_blend, build_weights

COINS = ["SOL", "ETH", "BTC", "DOGE", "XRP"]

# validated config
W_TREND, W_XS = 0.60, 0.40
TREND_LBS = {"SOL": (10, 30, 60, 120), "ETH": (10, 30, 60, 120),
             "BTC": (10, 30, 60, 120), "DOGE": (20, 40, 80, 120),
             "XRP": (20, 40, 80, 120)}
VOL_TARGET, VOL_LB, MAX_LEV = 0.60, 20, 3.0
XS_TOPK = 2
XS_LBS = (20, 40, 80)
EFF_LEV_CAP = 2.0           # conservative cap on book gross exposure (× equity)
TARGET, STOP = 0.50, 0.40


def load_panel() -> pd.DataFrame:
    cols = {}
    for c in COINS:
        df = datamod.load(c)
        s = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
        cols[c] = s[~s.index.duplicated(keep="first")].sort_index()
    panel = pd.DataFrame(cols).sort_index()
    # align to the last date all coins share (sources can differ by a day)
    last_common = min(panel[c].last_valid_index() for c in COINS)
    return panel.loc[:last_common]


def trend_weights(panel: pd.DataFrame) -> pd.DataFrame:
    """Per-coin long-only tsmom_blend target weights."""
    out = {}
    for c in COINS:
        p = panel[c].dropna()
        raw = sig_tsmom_blend(p, {"lbs": TREND_LBS[c]})
        w = build_weights(p, raw, dict(vol_target=VOL_TARGET, vol_lb=VOL_LB,
                                       max_lev=MAX_LEV, long_only=True))
        out[c] = w.reindex(panel.index)
    return pd.DataFrame(out)


def xs_weights(panel: pd.DataFrame) -> pd.DataFrame:
    """Cross-sectional top-k long rotation, vol-targeted at the basket level."""
    score = sum(np.sign(panel / panel.shift(L) - 1.0) * (panel / panel.shift(L) - 1.0)
                for L in XS_LBS) / float(len(XS_LBS))
    ranks = score.rank(axis=1, ascending=False, method="first")
    w = pd.DataFrame(0.0, index=panel.index, columns=panel.columns)
    w = w.mask(ranks.le(XS_TOPK) & score.notna(), 1.0)
    gross = w.sum(axis=1).replace(0.0, np.nan)
    w = w.div(gross, axis=0).fillna(0.0)          # equal-weight the held coins
    # vol-target the basket
    rets = panel.pct_change()
    basket = (w.shift(1).fillna(0.0) * rets).sum(axis=1)
    rv = realized_vol(basket, 30).clip(lower=0.10)
    scale = (VOL_TARGET / rv).clip(upper=MAX_LEV).fillna(0.0)
    return w.mul(scale, axis=0)


def book_weights(panel: pd.DataFrame) -> pd.DataFrame:
    tw = trend_weights(panel).fillna(0.0)
    xw = xs_weights(panel).fillna(0.0)
    book = W_TREND * tw + W_XS * xw
    # cap book gross exposure
    gross = book.abs().sum(axis=1).replace(0.0, np.nan)
    overcap = (gross > EFF_LEV_CAP)
    factor = pd.Series(1.0, index=book.index)
    factor[overcap] = EFF_LEV_CAP / gross[overcap]
    return book.mul(factor, axis=0).fillna(0.0)


def main(argv):
    panel = load_panel()
    book = book_weights(panel)
    today = book.index[-1]
    w_today = book.loc[today]
    gross = float(w_today.abs().sum())
    print(f"Deployable strategy — target weights for {today.date()} "
          f"(trend {W_TREND:.0%} / cross-sectional {W_XS:.0%}, eff-lev cap {EFF_LEV_CAP}×)")
    print(f"{'coin':>6} {'weight':>9} {'last_close':>12}")
    for c in COINS:
        print(f"{c:>6} {w_today[c]:>8.1%} {panel[c].iloc[-1]:>12,.4f}")
    print(f"{'GROSS':>6} {gross:>8.1%}  (book exposure as a multiple of equity)")
    print("\nAnnual wrapper at deploy time: $100k reset each Jan; apply these daily")
    print(f"target weights; bank & go flat once YTD >= +{TARGET:.0%}; stop for the year")
    print(f"at YTD <= -{STOP:.0%}; withdraw profit at year end. Paper-trade first.")
    print("\nValidated: ~86% of years bank +50% fully-OOS (90% best static); NOT every")
    print("year — a 2022-type all-coin crash is the documented structural miss.")


if __name__ == "__main__":
    main(sys.argv[1:])
