"""Walk-forward PREDICTION accuracy for BTC & ETH over the last 4 years (2022->2026).

Turns 'are there patterns?' into 'how accurately can we actually predict, out-of-sample?'
Causal features only; a logistic model is RETRAINED each month on strictly-past data
(labels used for training are only those whose future is already realised — no leakage);
predictions are scored on the unseen month. Reported over the last 4 years.

Targets:
  * DIRECTION at h = 1, 5, 20 days  -> hit rate vs an 'always-up' baseline (crypto drifts up)
  * VOLATILITY (next-20d realised vol) -> correlation & R^2 of the forecast (the easy one)

Honest expectation from the pattern study: volatility is highly predictable; medium-term
direction weakly (~55%); next-day direction ~coin-flip.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
TEST_START = pd.Timestamp("2022-05-26")     # last ~4 years


def load_daily(sym):
    df = pd.read_csv(os.path.join(HERE, "data", f"{sym}_daily.csv"), parse_dates=["date"])
    s = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return s[~s.index.duplicated()].sort_index()


def features(close):
    ret = close.pct_change()
    f = pd.DataFrame(index=close.index)
    for L in (5, 20, 60, 120):
        f[f"mom{L}"] = close / close.shift(L) - 1.0
    f["vol20"] = ret.rolling(20).std()
    f["vol60"] = ret.rolling(60).std()
    # RSI(14)
    up = ret.clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
    dn = (-ret.clip(upper=0)).ewm(alpha=1/14, adjust=False).mean()
    f["rsi"] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    f["dist_ma"] = close / close.rolling(50).mean() - 1.0
    f["accel"] = f["mom5"] - f["mom20"]
    return f


def fit_logistic(X, y, iters=400, lr=0.3, l2=1e-3):
    """Tiny standardized logistic regression (numpy). y in {0,1}."""
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Xs = (X - mu) / sd
    Xs = np.hstack([np.ones((len(Xs), 1)), Xs])
    w = np.zeros(Xs.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Xs @ w))
        g = Xs.T @ (p - y) / len(y) + l2 * np.r_[0, w[1:]]
        w -= lr * g
    return w, mu, sd


def predict_logistic(w, mu, sd, X):
    Xs = (X - mu) / sd
    Xs = np.hstack([np.ones((len(Xs), 1)), Xs])
    return 1 / (1 + np.exp(-Xs @ w))


def walk_forward_direction(close, feats, h):
    ret_fwd = close.shift(-h) / close - 1.0            # future h-day return (label)
    df = feats.copy()
    df["y"] = (ret_fwd > 0).astype(float)
    df["fwd"] = ret_fwd
    df = df.dropna()
    cols = [c for c in feats.columns]
    preds, actuals, dates = [], [], []
    months = pd.date_range(TEST_START, close.index[-1], freq="MS")
    for m0 in months:
        m1 = m0 + pd.offsets.MonthBegin(1)
        # train: rows whose future is realised before the test month starts (no leak)
        tr = df[df.index < (m0 - pd.Timedelta(days=h))]
        te = df[(df.index >= m0) & (df.index < m1)]
        if len(tr) < 250 or len(te) == 0:
            continue
        w, mu, sd = fit_logistic(tr[cols].values, tr["y"].values)
        p = predict_logistic(w, mu, sd, te[cols].values)
        preds += list((p > 0.5).astype(int))
        actuals += list(te["y"].values.astype(int))
        dates += list(te.index)
    preds, actuals = np.array(preds), np.array(actuals)
    if len(preds) == 0:
        return None
    hit = float((preds == actuals).mean())
    base_up = float((actuals == 1).mean())              # always-up baseline accuracy
    return dict(n=len(preds), hit=hit, base_up=base_up, dates=dates, preds=preds, actuals=actuals)


def walk_forward_vol(close):
    """Persistence (clustering) forecast: trailing realised vol predicts FUTURE realised
    vol. This is the natural test of the volatility-clustering pattern, h=1/5/20, on the
    last-4-years window. Causal; no fitting needed."""
    ret = close.pct_change()
    vol_now = ret.rolling(20).std()                          # trailing 20d vol (the forecast)
    mask = close.index >= TEST_START
    out = {}
    # h=1: does trailing variance predict next-day squared return? (GARCH-style)
    fwd_sq = (ret.shift(-1) ** 2)
    a = pd.concat([vol_now ** 2, fwd_sq], axis=1).dropna()
    a = a[a.index >= TEST_START]
    out[1] = float(np.corrcoef(a.iloc[:, 0], a.iloc[:, 1])[0, 1])
    # h=5,20: trailing vol vs next-h realised vol
    for h in (5, 20):
        fwd_vol = ret.shift(-h).rolling(h).std()
        b = pd.concat([vol_now, fwd_vol], axis=1).dropna()
        b = b[b.index >= TEST_START]
        corr = float(np.corrcoef(b.iloc[:, 0], b.iloc[:, 1])[0, 1])
        # R^2 of the persistence forecast (predict next-h vol = current 20d vol)
        pred = b.iloc[:, 0].values; act = b.iloc[:, 1].values
        r2 = 1 - np.sum((act - pred) ** 2) / np.sum((act - act.mean()) ** 2)
        out[h] = (corr, float(r2))
    return out


def main(argv):
    syms = [a.upper() for a in argv if a.upper() in ("BTC", "ETH")] or ["BTC", "ETH"]
    for sym in syms:
        close = load_daily(sym)
        feats = features(close)
        print(f"\n{'='*72}\n{sym} — walk-forward prediction accuracy, {TEST_START.date()}->{close.index[-1].date()}\n{'='*72}")
        print("DIRECTION (next h-day up/down), monthly-retrained logistic, OOS:")
        print(f"  {'horizon':>8} {'hit rate':>9} {'always-up':>10} {'edge vs base':>13} {'n':>6}")
        for h in (1, 5, 20):
            r = walk_forward_direction(close, feats, h)
            if r:
                edge = r["hit"] - max(r["base_up"], 1 - r["base_up"])
                tag = "  <-- real edge" if r["hit"] > max(r["base_up"], 1-r["base_up"]) + 0.02 else ""
                print(f"  {h:>6}d {r['hit']:>9.1%} {r['base_up']:>10.1%} {edge:>+12.1%} {r['n']:>6}{tag}")
        v = walk_forward_vol(close)
        if v:
            print(f"\nVOLATILITY persistence forecast (trailing 20d vol -> future vol), OOS:")
            print(f"  h=1d : corr(trailing var, next-day ret^2) = {v[1]:+.2f}  "
                  f"-> {'PREDICTABLE' if v[1]>0.2 else 'weak'}")
            for h in (5, 20):
                c, r2 = v[h]
                print(f"  h={h:>2}d: corr = {c:+.2f}, R^2 = {r2:+.2f}  "
                      f"-> {'PREDICTABLE' if c>0.4 else ('partial' if c>0.2 else 'weak')}")
    print(f"\n{'='*72}\nREAD: direction hit-rate must beat the larger of (always-up, always-down) by a")
    print("clear margin to be a real edge; volatility forecast is judged by correlation/R^2.")


if __name__ == "__main__":
    main(sys.argv[1:])
