"""Does funding-pressure / OI / order-flow lift BTC-ETH prediction at the 1-HOUR horizon?

The daily test (FUNDING_OI_VERDICT.md) found positioning adds ~0 to direction. Intraday is
where it *should* matter most: open interest and taker buy/sell flow are natively 5-min, and
the premium index (what funding is derived from) updates every bar -- unlike the 8h realised
funding. So this re-runs the controlled ablation on 1h bars.

Two things change versus daily and both are reported:
  * n is huge (~30-50k bars) -> standard error ~0.25%, so even a +0.5% edge is "significant".
  * BUT a 1h directional edge only matters if it clears costs. Taker round-trip on Binance
    perps ~4-8 bps, while mean |1h return| is ~30-45 bps -- so we report the GROSS mean signed
    return per bar (bps) alongside accuracy. An edge that is real but < ~5 bps/bar is untradeable.

Signals (causal; all known at the close of bar H, predicting H -> H+h):
  premium index 1h  (continuous funding pressure)         2020 -> 2026  (full)
  OI 1h, global/top long-short 1h, taker buy/sell vol 1h  2021/23 -> 2026 (2022 gaps)
Method identical in spirit to the daily harness: standardized logistic, retrained monthly on a
trailing window of strictly-past bars, scored OOS; controlled so baseline and augmented use the
SAME bars (all features non-NaN), differing only in feature columns.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

from pattern_features import fit_logistic, pred

HERE = os.path.dirname(os.path.abspath(__file__))
TEST_START = pd.Timestamp("2022-06-01")


def load_1h(sym: str) -> pd.DataFrame:
    px = pd.read_csv(os.path.join(HERE, "data", "intraday", f"{sym}_1h.csv"),
                     parse_dates=["date"]).set_index("date").sort_index()
    pr = pd.read_csv(os.path.join(HERE, "data", "futures", f"{sym}_premium_1h.csv"),
                     parse_dates=["date"]).set_index("date")
    me = pd.read_csv(os.path.join(HERE, "data", "futures", f"{sym}_metrics_1h.csv"),
                     parse_dates=["date"]).set_index("date")
    df = pd.DataFrame({"close": px["close"], "qvol": px["quote_volume"]}).join(pr).join(me)
    return df[~df.index.duplicated()].sort_index()


def build(df: pd.DataFrame):
    f = pd.DataFrame(index=df.index)
    c = df["close"]; ret = c.pct_change()
    for L in (3, 6, 12, 24, 72):
        f[f"mom{L}"] = c / c.shift(L) - 1.0
    f["ret1"] = ret
    f["vol24"] = ret.rolling(24).std(); f["vol72"] = ret.rolling(72).std()
    f["volratio"] = ret.rolling(6).std() / (ret.rolling(72).std() + 1e-12)
    up = ret.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    dn = (-ret.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    f["rsi"] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    f["dist_ma"] = c / c.rolling(48).mean() - 1.0
    f["accel"] = f["mom6"] - f["mom24"]
    price = ["mom3", "mom6", "mom12", "mom24", "mom72", "vol24", "vol72",
             "volratio", "rsi", "dist_ma", "accel"]
    # funding pressure (premium index)
    p = df["premium"]
    f["prem"] = p
    f["prem_ma8"] = p.rolling(8).mean(); f["prem_ma24"] = p.rolling(24).mean()
    f["prem_z"] = (p - p.rolling(72).mean()) / (p.rolling(72).std() + 1e-12)
    f["prem_chg"] = p - p.rolling(8).mean()
    fund = ["prem", "prem_ma8", "prem_ma24", "prem_z", "prem_chg"]
    # open interest + order flow / positioning
    oi = df["oi"]
    for L in (1, 6, 24):
        f[f"oi_chg{L}"] = oi / oi.shift(L) - 1.0
    f["oi_z"] = (oi - oi.rolling(72).mean()) / (oi.rolling(72).std() + 1e-12)
    tl = df["taker_ls"]   # raw taker_ls / ls_global / ls_top stay in df; add only derived cols
    f["taker_ls_ma6"] = tl.rolling(6).mean()
    f["taker_ls_z"] = (tl - tl.rolling(72).mean()) / (tl.rolling(72).std() + 1e-12)
    f["ls_div"] = df["ls_top"] - df["ls_global"]
    g = df["ls_global"]
    f["ls_global_z"] = (g - g.rolling(72).mean()) / (g.rolling(72).std() + 1e-12)
    oi_flow = ["oi_chg1", "oi_chg6", "oi_chg24", "oi_z", "taker_ls", "taker_ls_ma6",
               "taker_ls_z", "ls_global", "ls_top", "ls_div", "ls_global_z"]
    return f, price, fund, oi_flow


def walk_forward(df, cols, ycol, *, h, eval_index, train_days=120, train_min=800):
    """Monthly retrain on a trailing window of strictly-past bars; OOS on the next month.
    Returns accuracy, base rate, n, and GROSS mean signed return per bar (bps)."""
    sub = df[df.index.isin(eval_index)].replace([np.inf, -np.inf], np.nan)
    P, A, F = [], [], []
    for m0 in pd.date_range(TEST_START, df.index[-1], freq="MS"):
        m1 = m0 + pd.offsets.MonthBegin(1)
        lo = m0 - pd.Timedelta(days=train_days)
        tr = sub[(sub.index >= lo) & (sub.index < m0 - pd.Timedelta(hours=h + 1))] \
            .dropna(subset=cols + [ycol])
        te = sub[(sub.index >= m0) & (sub.index < m1)].dropna(subset=cols + [ycol, "fwd"])
        if len(tr) < train_min or len(te) == 0:
            continue
        w, mu, sd = fit_logistic(tr[cols].values, tr[ycol].values)
        pl = (pred(w, mu, sd, te[cols].values) > 0.5).astype(int)
        P += list(pl); A += list(te[ycol].values.astype(int)); F += list(te["fwd"].values)
    P, A, F = np.array(P), np.array(A), np.array(F)
    if len(P) == 0:
        return None
    base = max((A == 1).mean(), (A == 0).mean())
    signed = float(((2 * P - 1) * F).mean())   # gross return of trading the predicted side
    return dict(acc=float((P == A).mean()), base=float(base), n=len(P), signed_bps=signed * 1e4)


def common_index(df, colgroups, ycol):
    allcols = sorted({c for g in colgroups for c in g} | {ycol, "fwd"})
    return df.replace([np.inf, -np.inf], np.nan).dropna(subset=allcols).index


def run_direction(df, sym, price, fund, oi_flow):
    print(f"\n{'='*80}\n{sym} — NEXT-bar DIRECTION at 1h: does funding/OI/flow lift OOS accuracy?\n{'='*80}")
    c = df["close"]
    for h in (1, 4, 24):
        df["fwd"] = c.shift(-h) / c - 1.0
        df["y"] = (df["fwd"] > 0).astype(float)
        groups = {
            "price baseline": price,
            "+ funding(premium)": price + fund,
            "+ OI / flow": price + oi_flow,
            "+ funding + OI/flow": price + fund + oi_flow,
            "funding ONLY": fund,
            "OI/flow ONLY": oi_flow,
        }
        ev = common_index(df, list(groups.values()), "y")
        se = (0.25 / max(len(ev), 1)) ** 0.5 * 100
        print(f"\n  h={h}h  (controlled rows {ev.min().date()}->{ev.max().date()}; "
              f"SE~{se:.2f}% -> need ~+{2*se:.1f}% to be real; cost ~5-8 bps/bar)")
        print(f"    {'feature set':>22} {'OOS acc':>8} {'base':>7} {'d_base':>7} "
              f"{'gross bps/bar':>13} {'n':>7}")
        base_acc = None
        for name, cols in groups.items():
            r = walk_forward(df, cols, "y", h=h, eval_index=ev)
            if r is None:
                print(f"    {name:>22} (insufficient)"); continue
            if name == "price baseline":
                base_acc = r["acc"]
            d = "" if base_acc is None else f"{r['acc']-base_acc:+.2%}"
            tag = "  <-- clears noise+cost" if (base_acc is not None and r["acc"] - base_acc > 2 * se / 100
                                                and r["signed_bps"] > 8) else ""
            print(f"    {name:>22} {r['acc']:>7.2%} {r['base']:>6.1%} {d:>7} "
                  f"{r['signed_bps']:>+12.2f} {r['n']:>7}{tag}")


def run_premium_full(df, sym, price, fund):
    print(f"\n  [{sym}] funding(premium) on its FULL 1h window (no OI-gap restriction):")
    c = df["close"]
    for h in (1, 4, 24):
        df["fwd"] = c.shift(-h) / c - 1.0
        df["y"] = (df["fwd"] > 0).astype(float)
        ev = common_index(df, [price, price + fund], "y")
        rb = walk_forward(df, price, "y", h=h, eval_index=ev)
        rf = walk_forward(df, price + fund, "y", h=h, eval_index=ev)
        if rb and rf:
            print(f"    h={h:>2}h  price {rb['acc']:.2%} -> price+funding {rf['acc']:.2%} "
                  f"(d={rf['acc']-rb['acc']:+.2%}, base {rb['base']:.1%}, "
                  f"gross {rf['signed_bps']:+.1f} bps/bar, n={rb['n']})")


def run_flow_signals(df, sym):
    """Direct, no-fit order-flow / funding-pressure rules at 1h (causal z-scores)."""
    print(f"\n  [{sym}] direct 1h signals (OOS {TEST_START.date()}->):")
    c = df["close"]; fwd = c.shift(-1) / c - 1.0
    win = df.index >= TEST_START
    tl = df["taker_ls"]; tlz = (tl - tl.rolling(72).mean()) / (tl.rolling(72).std() + 1e-12)
    p = df["premium"]; pz = (p - p.rolling(72).mean()) / (p.rolling(72).std() + 1e-12)
    oichg = df["oi"] / df["oi"].shift(6) - 1.0
    mom6 = c / c.shift(6) - 1.0

    def rep(name, sig):
        m = win & sig.notna() & fwd.notna()
        s = np.sign(sig[m]); r = fwd[m]
        nz = s != 0; n = int(nz.sum())
        if n < 200:
            print(f"      {name:>36}: (n={n})"); return
        hit = float((np.sign(r[nz]) == s[nz]).mean())
        gross = float((s[nz] * r[nz]).mean()) * 1e4
        print(f"      {name:>36}: hit {hit:.2%}  gross {gross:+.2f} bps/bar  n={n}")

    rep("follow taker flow (buy when buyers aggr)", np.sign(tlz.where(tlz.abs() > 1.0)))
    rep("fade taker flow (contrarian)", -np.sign(tlz.where(tlz.abs() > 1.0)))
    rep("fade premium extreme (contrarian)", -np.sign(pz.where(pz.abs() > 1.5)))
    rep("OI-confirmed 6h momentum", np.sign(mom6).where((oichg > 0)))


def main(argv):
    syms = [a.upper() for a in argv if a.upper() in ("BTC", "ETH")] or ["BTC", "ETH"]
    for sym in syms:
        df = load_1h(sym)
        feats, price, fund, oi_flow = build(df)
        df = df.join(feats)
        run_direction(df, sym, price, fund, oi_flow)
        run_premium_full(df, sym, price, fund)
        run_flow_signals(df, sym)
    print(f"\n{'='*80}\nREAD: 'd_base' = lift over the price baseline on identical bars. At 1h an edge must\n"
          "(a) exceed ~2*SE to be statistically real AND (b) exceed ~5-8 bps/bar GROSS to beat\n"
          "costs. Both bars must clear for a tradeable intraday edge.\n")


if __name__ == "__main__":
    main(sys.argv[1:])
