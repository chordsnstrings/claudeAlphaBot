"""ETH high-risk monthly-ROI sweep — finds the best monthly returns achievable on ETH
across signal archetypes × timeframes × leverage. Focus is the MONTHLY return distribution
(best, median, % positive, % > 50% / 100%), not lifetime ratio metrics.

Casts a wide net: trend (Donchian, EMA cross), momentum (ROC), mean-reversion (Bollinger),
liquidity sweep (v2), each with various lookbacks, on 1h and 4h, at leverage 1x/3x/5x/10x.
"""
from __future__ import annotations

import sys, os, itertools
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scalp_sweep as ss
import daytrade_v2 as DT2

COST_BPS = 5.0


def _ema(s, n): return s.ewm(span=n, adjust=False).mean()


# Signal generators — each returns a position series in [-1, 1]
def sig_donchian(df, n=50, trend_sma=200):
    c = df["close"]; hi = c.rolling(n).max().shift(1); lo = c.rolling(n).min().shift(1)
    pos = pd.Series(np.nan, index=c.index)
    pos[c >= hi] = 1.0; pos[c <= lo] = -1.0
    pos = pos.ffill().fillna(0.0)
    if trend_sma > 0:
        sma = c.rolling(trend_sma).mean()
        pos[(pos > 0) & (c < sma)] = 0
        pos[(pos < 0) & (c > sma)] = 0
    return pos


def sig_ema_cross(df, fast=12, slow=50, trend_sma=200):
    c = df["close"]; ef = _ema(c, fast); es = _ema(c, slow)
    pos = pd.Series(0.0, index=c.index)
    pos[ef > es] = 1.0; pos[ef < es] = -1.0
    if trend_sma > 0:
        sma = c.rolling(trend_sma).mean()
        pos[(pos > 0) & (c < sma)] = 0; pos[(pos < 0) & (c > sma)] = 0
    return pos


def sig_roc(df, n=48, thr=0.01, trend_sma=200):
    c = df["close"]; r = c.pct_change(n)
    pos = pd.Series(0.0, index=c.index)
    pos[r > thr] = 1.0; pos[r < -thr] = -1.0
    if trend_sma > 0:
        sma = c.rolling(trend_sma).mean()
        pos[(pos > 0) & (c < sma)] = 0; pos[(pos < 0) & (c > sma)] = 0
    return pos


def sig_boll(df, n=20, k=2.0):  # mean reversion (NO trend filter — counter-trend by design)
    c = df["close"]; m = c.rolling(n).mean(); sd = c.rolling(n).std()
    pos = pd.Series(np.nan, index=c.index)
    pos[c < m - k * sd] = 1.0  # buy oversold
    pos[c > m + k * sd] = -1.0  # sell overbought
    pos[(c - m).abs() < 0.2 * sd] = 0  # exit near mean
    return pos.ffill().fillna(0.0)


def sig_sweep(df, lookback=50, rejection=0.5, trend_sma=200):
    s = DT2.liquidity_sweep(df, lookback, rejection, trend_sma)
    # Hold for N bars (since liq sweep is a discrete trigger, not a position)
    pos = pd.Series(s, index=df.index)
    # Convert to "hold for 12 bars" position by forward-filling for 12 bars
    pos = pos.replace(0, np.nan).ffill(limit=12).fillna(0.0)
    return pos


# Bracket-style backtest at fixed leverage L
def backtest_lev(df, pos, leverage=1.0, cost_bps=COST_BPS):
    ret = df["close"].pct_change().fillna(0.0)
    ex = (pos * leverage).shift(1).fillna(0.0)
    turn = ex.diff().abs().fillna(ex.abs())
    net = ex * ret - cost_bps * 1e-4 * turn
    # Liquidation check: if any bar's net return <= -1, account zeroed
    eq_path = (1 + net).cumprod()
    if (1 + net).min() <= 0:
        return pd.Series(0.0, index=df.index), True
    return net, False


def monthly_returns(net):
    return ((1 + net.dropna()).resample("ME").prod() - 1).dropna()


def report(net, liq, label):
    if liq or net.std() == 0 or len(net) < 30:
        return None
    eq = (1 + net).cumprod()
    ann = eq.iloc[-1] ** (365 * 24 / len(net)) - 1 if (df_freq := True) else 0  # placeholder
    mo = monthly_returns(net)
    mdd = (eq / eq.cummax() - 1).min()
    sh = net.mean() / net.std() * np.sqrt(365 * 24)  # assume hourly; fixed later
    return dict(label=label, n=len(net), total=eq.iloc[-1] - 1, ann=ann,
                sharpe=sh, mdd=mdd,
                best_mo=mo.max() if len(mo) > 0 else 0,
                med_mo=mo.median() if len(mo) > 0 else 0,
                worst_mo=mo.min() if len(mo) > 0 else 0,
                pos_mo=float((mo > 0).mean()) if len(mo) > 0 else 0,
                over_50=float((mo > 0.50).mean()) if len(mo) > 0 else 0,
                over_100=float((mo > 1.00).mean()) if len(mo) > 0 else 0,
                n_mo=len(mo))


def sweep(tfs=("1h", "4h"), leverages=(1, 3, 5, 10), out_top_n=15):
    rows = []
    for tf in tfs:
        ss.set_tf(tf); df = ss.load(tf, "ETH")
        bars_per_year = 24 * 365 if tf == "1h" else 6 * 365 if tf == "4h" else 96 * 365
        # Signal configs
        configs = []
        for n in (20, 50, 100): configs.append((f"donchian{n}", sig_donchian(df, n)))
        for fast, slow in ((12, 50), (20, 100), (50, 200)):
            configs.append((f"ema{fast}/{slow}", sig_ema_cross(df, fast, slow)))
        for n in (24, 48, 96):
            configs.append((f"roc{n}", sig_roc(df, n)))
        for n, k in ((20, 2.0), (50, 2.0), (20, 1.5)):
            configs.append((f"boll{n}/{k}", sig_boll(df, n, k)))
        for n in (50, 100):
            configs.append((f"sweep{n}", sig_sweep(df, n)))
        for label, pos in configs:
            for lev in leverages:
                net, liq = backtest_lev(df, pos, leverage=lev)
                if liq:
                    rows.append(dict(label=f"{tf} {label} {lev}x", liq=True))
                    continue
                eq = (1 + net).cumprod()
                ann = eq.iloc[-1] ** (bars_per_year / len(net)) - 1 if eq.iloc[-1] > 0 else -1
                mo = monthly_returns(net)
                mdd = (eq / eq.cummax() - 1).min()
                sh = net.mean() / net.std() * np.sqrt(bars_per_year) if net.std() > 0 else 0
                if len(mo) == 0: continue
                rows.append(dict(
                    label=f"{tf} {label} {lev}x", liq=False,
                    ann=ann, sharpe=sh, mdd=mdd, total=eq.iloc[-1] - 1,
                    best_mo=mo.max(), med_mo=mo.median(), worst_mo=mo.min(),
                    pos_mo=(mo > 0).mean(), over_50=(mo > 0.5).mean(), over_100=(mo > 1.0).mean(),
                    n_mo=len(mo)))
    df_res = pd.DataFrame(rows)
    return df_res


def main():
    print("ETH HIGH-RISK MONTHLY ROI SWEEP — finding best monthly returns")
    print(f"  Universe: ETH 1h and 4h, signals × leverages, fixed-risk bracket style")
    print(f"  Looking for: highest single-month ROI, % positive months, lifetime survival\n")
    res = sweep(tfs=("1h", "4h"), leverages=(1, 3, 5, 10))

    # Liquidations
    liq_count = int(res["liq"].sum())
    print(f"  Total configs: {len(res)}, liquidated: {liq_count} ({liq_count/len(res)*100:.0f}%)\n")

    alive = res[~res["liq"]].copy()
    if len(alive) == 0:
        print("  NO surviving configs found!"); return

    # Top by best single-month ROI (the "highest possible" question)
    print("=" * 100)
    print("TOP 15 BY BEST SINGLE-MONTH ROI (the 'highest possible' for ETH):")
    print("=" * 100)
    top1 = alive.sort_values("best_mo", ascending=False).head(15)
    print(f"  {'config':28}{'best_mo':>10}{'med_mo':>10}{'pos_mo':>10}{'>50%':>8}{'>100%':>8}{'ann':>10}{'mdd':>10}")
    for _, r in top1.iterrows():
        print(f"  {r['label']:26}{r['best_mo']*100:>+8.0f}% {r['med_mo']*100:>+8.0f}% "
              f"{r['pos_mo']*100:>+7.0f}% {r['over_50']*100:>+5.0f}% {r['over_100']*100:>+5.0f}% "
              f"{r['ann']*100:>+8.0f}% {r['mdd']*100:>+8.0f}%")

    print(f"\n" + "=" * 100)
    print("TOP 15 BY POSITIVE-MONTH FREQUENCY (the 'consistent positive' question):")
    print("=" * 100)
    # require min n_mo to avoid tiny samples
    alive2 = alive[alive["n_mo"] >= 12].copy()
    top2 = alive2.sort_values(["pos_mo", "med_mo"], ascending=[False, False]).head(15)
    print(f"  {'config':28}{'pos_mo':>10}{'med_mo':>10}{'best_mo':>10}{'worst_mo':>10}{'ann':>10}")
    for _, r in top2.iterrows():
        print(f"  {r['label']:26}{r['pos_mo']*100:>+8.0f}% {r['med_mo']*100:>+8.0f}% "
              f"{r['best_mo']*100:>+7.0f}% {r['worst_mo']*100:>+7.0f}% {r['ann']*100:>+8.0f}%")

    print(f"\n" + "=" * 100)
    print("TOP 15 BY ANNUAL RETURN (alive only, no liq):")
    print("=" * 100)
    top3 = alive.sort_values("ann", ascending=False).head(15)
    print(f"  {'config':28}{'ann':>10}{'sharpe':>9}{'mdd':>10}{'best_mo':>10}{'worst_mo':>10}")
    for _, r in top3.iterrows():
        print(f"  {r['label']:26}{r['ann']*100:>+8.0f}% {r['sharpe']:>8.2f} "
              f"{r['mdd']*100:>+8.0f}% {r['best_mo']*100:>+8.0f}% {r['worst_mo']*100:>+8.0f}%")


if __name__ == "__main__":
    main()
