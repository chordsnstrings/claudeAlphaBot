"""Does FUNDING / OPEN-INTEREST / POSITIONING lift BTC-ETH prediction? — measured, OOS.

The prediction study (PREDICTION_TO_80_BTC_ETH.md) found next-day direction is a coin-flip
(~50-53%) on every *reachable* variable, and flagged positioning data (funding / OI /
long-short) as the one informative external lever it could not fetch (expected +2-4% ->
~55%, not 80%). data.binance.vision is now reachable, so this tests it directly.

Data (research/binance_vision_futures.py):
  funding  2020-01 -> 2026-04 (complete)         funding_sum/mean per UTC day
  metrics  2021/2023 -> 2026-05 (big 2022 gaps)  end-of-day OI, OI-value, global &
           top-trader long/short ratio, taker buy/sell vol ratio

Method (identical to the committed harness): causal features only; a standardized logistic
is RETRAINED monthly on strictly-past rows (labels realised before the test month); scored
on the unseen month; OOS hit-rate vs the always-up/down base rate. Funding/OI metrics align
to the spot 'date' whose close is end-of-day-D; funding settles <=16:00 UTC, the metrics
snapshot is ~23:55 UTC -> both known at close[D], no look-ahead.

CONTROL: because OI has big 2022 gaps, each ablation group is evaluated on the SAME rows
(all features in the group non-NaN) and BOTH baseline and augmented models train/test on
that identical row set -- so any delta is the feature effect, not a sample-size artifact.
Funding (no gaps) is additionally tested on its full window.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

from pattern_features import build_features, fit_logistic, pred

HERE = os.path.dirname(os.path.abspath(__file__))
TEST_START = pd.Timestamp("2022-05-26")


# ----------------------------------------------------------------- loading ---
def load_all(sym: str) -> pd.DataFrame:
    px = pd.read_csv(os.path.join(HERE, "data", f"{sym}_daily.csv"), parse_dates=["date"])
    px = px[~px["date"].duplicated()].set_index("date").sort_index()
    fund = pd.read_csv(os.path.join(HERE, "data", "futures", f"{sym}_funding.csv"),
                       parse_dates=["date"]).set_index("date")
    met = pd.read_csv(os.path.join(HERE, "data", "futures", f"{sym}_metrics.csv"),
                      parse_dates=["date"]).set_index("date")
    return px.join(fund, how="left").join(met, how="left")


def add_funding_features(f: pd.DataFrame, df: pd.DataFrame) -> list[str]:
    """Causal funding features. Returns the list of column names added."""
    fm = df["funding_mean"]
    f["fund"] = fm
    f["fund_ma7"] = fm.rolling(7).mean()
    f["fund_ma30"] = fm.rolling(30).mean()
    f["fund_chg"] = fm - fm.rolling(7).mean()
    f["fund_cum7"] = df["funding_sum"].rolling(7).sum()
    f["fund_cum30"] = df["funding_sum"].rolling(30).sum()
    mu = fm.rolling(30).mean(); sd = fm.rolling(30).std()
    f["fund_z"] = (fm - mu) / (sd + 1e-12)               # funding extreme (contrarian)
    f["fund_pos_frac"] = (fm > 0).rolling(7).mean()       # persistence of positive carry
    return ["fund", "fund_ma7", "fund_ma30", "fund_chg", "fund_cum7", "fund_cum30",
            "fund_z", "fund_pos_frac"]


def add_oi_features(f: pd.DataFrame, df: pd.DataFrame) -> list[str]:
    """Causal open-interest / positioning features. Returns column names added."""
    oi = df["oi"]
    for L in (1, 5, 20):
        f[f"oi_chg{L}"] = oi / oi.shift(L) - 1.0
    mu = oi.rolling(30).mean(); sd = oi.rolling(30).std()
    f["oi_z"] = (oi - mu) / (sd + 1e-12)
    ret = df["close"].pct_change()
    f["oi_x_ret"] = (oi / oi.shift(1) - 1.0) * ret         # OI build with/against price
    f["oi_x_mom5"] = (oi / oi.shift(5) - 1.0) * (df["close"] / df["close"].shift(5) - 1.0)
    f["ls_global"] = df["ls_global"]
    f["ls_top"] = df["ls_top"]
    f["ls_div"] = df["ls_top"] - df["ls_global"]           # smart-money vs crowd
    g = df["ls_global"]
    f["ls_global_z"] = (g - g.rolling(30).mean()) / (g.rolling(30).std() + 1e-12)
    t = df["ls_top"]
    f["ls_top_z"] = (t - t.rolling(30).mean()) / (t.rolling(30).std() + 1e-12)
    f["taker_ls"] = df["taker_ls"]
    f["taker_ls_ma5"] = df["taker_ls"].rolling(5).mean()
    return ["oi_chg1", "oi_chg5", "oi_chg20", "oi_z", "oi_x_ret", "oi_x_mom5",
            "ls_global", "ls_top", "ls_div", "ls_global_z", "ls_top_z",
            "taker_ls", "taker_ls_ma5"]


# ------------------------------------------------------- walk-forward (OOS) ---
def walk_forward(df: pd.DataFrame, cols: list[str], ycol: str, *, h: int,
                 eval_index: pd.Index, train_min: int = 300):
    """Monthly-retrained logistic. Train + test restricted to eval_index (controlled);
    train rows must have their h-day forward label realised before the test month."""
    sub = df[df.index.isin(eval_index)].replace([np.inf, -np.inf], np.nan)
    P, A = [], []
    for m0 in pd.date_range(TEST_START, df.index[-1], freq="MS"):
        m1 = m0 + pd.offsets.MonthBegin(1)
        tr = sub[sub.index < (m0 - pd.Timedelta(days=h + 1))].dropna(subset=cols + [ycol])
        te = sub[(sub.index >= m0) & (sub.index < m1)].dropna(subset=cols + [ycol])
        if len(tr) < train_min or len(te) == 0:
            continue
        w, mu, sd = fit_logistic(tr[cols].values, tr[ycol].values)
        P += list((pred(w, mu, sd, te[cols].values) > 0.5).astype(int))
        A += list(te[ycol].values.astype(int))
    P, A = np.array(P), np.array(A)
    if len(P) == 0:
        return None
    base = max((A == 1).mean(), (A == 0).mean())
    return dict(acc=float((P == A).mean()), base=float(base), n=len(P))


def common_index(df: pd.DataFrame, colgroups: list[list[str]], ycol: str) -> pd.Index:
    """Rows where every feature in every group (plus the label) is non-NaN."""
    allcols = sorted({c for g in colgroups for c in g} | {ycol})
    return df.replace([np.inf, -np.inf], np.nan).dropna(subset=allcols).index


# --------------------------------------------------------------- experiments --
PRICE = ["mom5", "mom20", "mom60", "mom120", "vol20", "vol60", "volratio",
         "rsi", "dist_ma", "accel"]


def run_direction(df: pd.DataFrame, sym: str, fund_cols, oi_cols):
    print(f"\n{'='*78}\n{sym} — NEXT-DAY DIRECTION: does funding / OI lift OOS accuracy?\n{'='*78}")
    ret = df["close"].pct_change()
    for h in (1, 5):
        df["y"] = (df["close"].shift(-h) / df["close"] - 1.0 > 0).astype(float)
        groups = {
            "price baseline": PRICE,
            "+ funding": PRICE + fund_cols,
            "+ OI/positioning": PRICE + oi_cols,
            "+ funding + OI": PRICE + fund_cols + oi_cols,
            "funding ONLY": fund_cols,
            "OI/positioning ONLY": oi_cols,
        }
        # controlled: identical evaluation rows across all sets (all features non-NaN)
        ev = common_index(df, list(groups.values()), "y")
        print(f"\n  h={h}d  (controlled window: {ev.min().date()}->{ev.max().date()}, "
              f"all sets on identical rows)")
        print(f"    {'feature set':>22} {'OOS acc':>8} {'base':>7} {'edge':>7} {'n':>6}")
        base_acc = None
        for name, cols in groups.items():
            r = walk_forward(df, cols, "y", h=h, eval_index=ev)
            if r is None:
                print(f"    {name:>22} {'(insufficient)':>8}")
                continue
            edge = r["acc"] - r["base"]
            if name == "price baseline":
                base_acc = r["acc"]
            delta = "" if base_acc is None else f"  d_base={r['acc']-base_acc:+.1%}"
            tag = "  <-- edge" if edge > 0.02 else ""
            print(f"    {name:>22} {r['acc']:>7.1%} {r['base']:>6.1%} {edge:>+6.1%} "
                  f"{r['n']:>6}{delta}{tag}")


def run_funding_full(df: pd.DataFrame, sym: str, fund_cols):
    """Funding has no gaps -> test price vs price+funding on the FULL 2022-05 window."""
    print(f"\n  [{sym}] funding on its FULL window (no OI gap restriction):")
    for h in (1, 5):
        df["y"] = (df["close"].shift(-h) / df["close"] - 1.0 > 0).astype(float)
        ev = common_index(df, [PRICE, PRICE + fund_cols], "y")
        rb = walk_forward(df, PRICE, "y", h=h, eval_index=ev)
        rf = walk_forward(df, PRICE + fund_cols, "y", h=h, eval_index=ev)
        if rb and rf:
            print(f"    h={h}d  price {rb['acc']:.1%}  ->  price+funding {rf['acc']:.1%}  "
                  f"(d={rf['acc']-rb['acc']:+.1%}, base {rb['base']:.1%}, n={rb['n']}, "
                  f"{ev.min().date()}->{ev.max().date()})")


def run_sign_rules(df: pd.DataFrame, sym: str):
    """Direct, no-fit contrarian/confirmation rules (causal z-scores), OOS hit-rate and
    next-day mean return. Tests the *economic* hypotheses directly, not just via ML."""
    print(f"\n  [{sym}] direct positioning signals (OOS {TEST_START.date()}->):")
    ret_fwd = df["close"].shift(-1) / df["close"] - 1.0
    win = df.index >= TEST_START
    fm = df["funding_mean"]
    fz = (fm - fm.rolling(30).mean()) / (fm.rolling(30).std() + 1e-12)
    g = df["ls_global"]
    gz = (g - g.rolling(30).mean()) / (g.rolling(30).std() + 1e-12)
    oichg = df["oi"] / df["oi"].shift(5) - 1.0
    mom5 = df["close"] / df["close"].shift(5) - 1.0

    def report(name, sig):
        m = win & sig.notna() & ret_fwd.notna()
        s = np.sign(sig[m]); r = ret_fwd[m]
        n = int((s != 0).sum())
        if n < 50:
            print(f"      {name:>34}: (n={n}, too few)"); return
        hit = float((np.sign(r[s != 0]) == s[s != 0]).mean())
        avg = float((s[s != 0] * r[s != 0]).mean())
        print(f"      {name:>34}: dir-hit {hit:.1%}  avg signed next-day ret {avg:+.3%}  n={n}")

    # contrarian: fade crowded funding / long-short; confirmation: OI-backed momentum
    report("fade high funding (short hi/long lo)", -np.sign(fz.where(fz.abs() > 1.0)))
    report("fade extreme global L/S", -np.sign(gz.where(gz.abs() > 1.0)))
    report("OI-confirmed 5d momentum", np.sign(mom5).where((oichg > 0) & (mom5.abs() > 0.0)))
    report("raw funding sign (carry persistence)", np.sign(fm))


def run_volatility(df: pd.DataFrame, sym: str, fund_cols, oi_cols):
    """The honestly-predictable target: does funding/OI improve next-day BIG-move / vol-up
    classification beyond price-only?"""
    print(f"\n  [{sym}] VOLATILITY target — does funding/OI help the *predictable* one?")
    ret = df["close"].pct_change()
    med = ret.abs().rolling(20).median()
    df["yv"] = (ret.abs().shift(-1) > med).astype(float)         # balanced vol-up
    volprice = ["vol20", "vol60", "volratio", "rsi", "mom5", "mom20"]
    groups = {"price-vol baseline": volprice,
              "+ funding": volprice + fund_cols,
              "+ OI": volprice + oi_cols,
              "+ funding + OI": volprice + fund_cols + oi_cols}
    ev = common_index(df, list(groups.values()), "yv")
    print(f"    (controlled {ev.min().date()}->{ev.max().date()}; target=next-day |ret|>20d median)")
    base_acc = None
    for name, cols in groups.items():
        r = walk_forward(df, cols, "yv", h=1, eval_index=ev)
        if r:
            if base_acc is None:
                base_acc = r["acc"]
            print(f"      {name:>22}: OOS {r['acc']:.1%}  (base {r['base']:.1%}, "
                  f"d_base {r['acc']-base_acc:+.1%}, n={r['n']})")


def main(argv):
    syms = [a.upper() for a in argv if a.upper() in ("BTC", "ETH")] or ["BTC", "ETH"]
    btc_close = load_all("BTC")["close"]
    for sym in syms:
        df = load_all(sym)
        feats = build_features(df["close"], df.get("volume_usd"),
                               btc_close if sym == "ETH" else None)
        df = df.join(feats)
        fund_cols = add_funding_features(df, df)
        oi_cols = add_oi_features(df, df)
        run_direction(df, sym, fund_cols, oi_cols)
        run_funding_full(df, sym, fund_cols)
        run_sign_rules(df, sym)
        run_volatility(df, sym, fund_cols, oi_cols)
    print(f"\n{'='*78}\nREAD: 'edge' = OOS acc - base rate; 'd_base' = lift over price baseline on the\n"
          "same rows. A real directional lift needs d_base clearly > 0 AND acc > base.\n")


if __name__ == "__main__":
    main(sys.argv[1:])
