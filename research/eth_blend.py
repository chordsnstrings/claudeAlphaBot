"""ETH BLEND strategy — the deployable recommendation.

Two complementary sleeves, risk-weighted 50/50, with profit harvested to cash:
  * REGIME engine (eth_engine.recommended): long-biased committee that hedges bears -> the
    bull-catcher. Auto-flips long when a bull forms; short/defensive in bears.
  * BREAKOUT pool (eth_bracket): 4h Donchian breakouts (lengths 20/50/100), trend+ADX
    filtered, 2:1 brackets resolved on 1h, run as concurrent books -> the workhorse that
    earns in chop/bear (regime-independent).

Each sleeve is vol-targeted (causal, trailing) to VOL_TARGET so they contribute equal risk,
then blended. Profits are harvested to cash (trading base reset to BASE) when the account
makes a new high then decays HARVEST_DECAY, and at year-end. Backtest is the validated equity
engine; `now()` reports the current actionable stance of each sleeve.

Run:  python eth_blend.py            # backtest summary + per-year harvest
      python eth_blend.py --now      # current target stance (what to do today)
"""
from __future__ import annotations

import sys
import numpy as np
import pandas as pd

import scalp_sweep as ss
import eth_engine as E
import eth_bracket as B

# ---- config ----
# Weights chosen for ROBUST FORWARD return, NOT the lucky full-window score. A windfall
# decomposition (drop-the-best-K-months + post-2021 sub-period) showed the REGIME sleeve's
# edge was mostly the 2020-21 super-bull (a once-in-a-cycle windfall), while the BREAKOUT
# pool is positive in ALL 7 years (its big years are repeatable sustained trends, not a
# one-time crash bet). So the pool dominates: on 2022-2026 it returns ~+36%/Sharpe 0.97 vs
# the regime sleeve's +12%/0.49. Keeping 25% regime adds genuine diversification (best
# luck-stripped robustness) + bull-capture optionality if a real bull returns.
#
# SEARCH OUTCOME (forward 2022-26, vol-tgt 30% / cap 1.5):
#   * 100% pool        -> +36% / Sh 0.97 / DD -32%   (max raw return; no bull hedge)
#   * 25/75 (THIS)     -> +31% / Sh 0.96 / DD -28%   (best all-around: ~95% of the return,
#                                                      lower DD, + bull optionality)
#   * adding a 3rd cross-asset BTC-breakout sleeve was TESTED and REJECTED: corr to the ETH
#     pool is 0.46 (not diversifying enough) and it LOWERS forward return (28-30%) while only
#     shaving DD a little. ETH-only wins. -> 25/75 is the locked recommendation.
#
# WALK-FORWARD OOS (nested: blend weight reselected out-of-sample every fold, 365d train /
# 90d test, ~5yr OOS 2021-2026) CONFIRMED the weight is NOT overfit -- fixed 25/75 (+24% /
# Sharpe 0.80) matches the WF-selected weight (+25% / 0.80). But the honest forward number
# is the DEFLATED one: ~+24%/yr, Sharpe 0.80, -28..-32% DD at 1x  (NOT the +35%/Sharpe 1.06
# full-window in-sample figure that backtest() prints). Remaining in-sample layer: the pool/
# regime component CONFIGS were chosen from a full-sample sweep (subperiod-robust, but not
# per-fold reselected). NOTE: the Kelly leverage (~3.5x) is a full-sample estimate -> biased
# high; do not trust the specific optimum, only the shape (Kelly exists, ruin beyond it).
W_REGIME, W_POOL = 0.25, 0.75
VOL_TARGET = 0.30            # annual vol each sleeve is scaled to (the risk dial; 25-40% sane)
LEV_CAP = 1.5               # hard leverage cap per sleeve (Kelly-aligned; never over-bet)
COST_BPS = 5.0
BASE = 10000.0
HARVEST_DECAY = 0.15         # reset to BASE after a 15% decay from a new equity high
POOL = dict(lengths=(20, 50, 100), sma=200, adx_min=20, atr_mult=2.0, risk=0.02)


def _adx(df, n=14):
    h, l, c = df["high"], df["low"], df["close"]; up = h.diff(); dn = -l.diff()
    p = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    m = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    a = tr.ewm(alpha=1 / n, adjust=False).mean()
    pdi = 100 * p.ewm(alpha=1 / n, adjust=False).mean() / a
    mdi = 100 * m.ewm(alpha=1 / n, adjust=False).mean() / a
    return (100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)).ewm(alpha=1 / n, adjust=False).mean().values


def pool_exposure(df4, df1h):
    """Net exposure of the breakout pool on the 1h grid (sum of concurrent book positions).
    Causal: a 4h breakout is only actionable at the 4h CLOSE -> entry on the next 1h bar."""
    atr4 = (ss._atr(df4, 14) / df4["close"]).values * POOL["atr_mult"]
    adx4 = _adx(df4); up4 = (df4["close"] > df4["close"].rolling(POOL["sma"]).mean()).values
    fi = df1h.index.values; fo, fh, fl = (df1h[x].values for x in ("open", "high", "low"))
    fc = df1h["close"].values; H4 = np.timedelta64(4, "h"); ct = df4.index.values
    P = np.zeros(len(fi))
    for n in POOL["lengths"]:
        s = B.s_donch(df4, n=n).copy(); s[(s > 0) & ~up4] = 0; s[(s < 0) & up4] = 0; s[adx4 < POOL["adx_min"]] = 0
        flat = -1
        for i in range(len(s)):
            d = s[i]; sf = atr4[i]
            if d == 0 or not (sf > 0):
                continue
            ta = ct[i] + H4
            if ta < fi[0]:
                continue
            k = int(np.searchsorted(fi, ta, side="left"))
            if k <= flat or k >= len(fi):
                continue
            ent = fo[k]; sl = ent * (1 - sf) if d > 0 else ent * (1 + sf)
            tp = ent * (1 + 2 * sf) if d > 0 else ent * (1 - 2 * sf); ek = None
            for j in range(k, min(len(fi), k + 8000)):
                hs = (fl[j] <= sl) if d > 0 else (fh[j] >= sl)
                ht = (fh[j] >= tp) if d > 0 else (fl[j] <= tp)
                if (hs and ht) or ht or hs:
                    ek = j; break
            if ek is None:
                ek = min(len(fi) - 1, k + 7999)
            P[k:ek + 1] += d * (POOL["risk"] / sf)        # concurrent books ADD
            flat = ek
    return pd.Series(P, index=df1h.index)


def sleeve_returns():
    """Daily return streams for each sleeve over their common window."""
    ss.set_tf("1d"); d1 = ss.load("1d", "ETH")
    regime = ss.to_daily(ss.backtest(d1, E.recommended(d1), COST_BPS))
    ss.set_tf("4h"); d4 = ss.load("4h", "ETH"); ss.set_tf("1h"); d1h = ss.load("1h", "ETH")
    P = pool_exposure(d4, d1h)
    rf = d1h["close"].pct_change().fillna(0.0)
    pool = ss.to_daily(P.shift(1).fillna(0.0) * rf - COST_BPS * 1e-4 * P.diff().abs().fillna(0.0))
    df = pd.concat({"regime": regime, "pool": pool}, axis=1, sort=True).dropna()
    return df


def blend_returns():
    df = sleeve_returns()
    b = (W_REGIME * ss.vol_target(df["regime"], VOL_TARGET, cap=LEV_CAP)
         + W_POOL * ss.vol_target(df["pool"], VOL_TARGET, cap=LEV_CAP))
    return b.dropna(), df


def harvest(daily, base=BASE, decay=HARVEST_DECAY):
    """Reset trading equity to base (banking the excess as cash) on an ATH-then-decay and at
    year-end. Returns per-year rows (year, peak, cash_out, cum_cash, total_wealth)."""
    eq = base; peak = base; bank = 0.0; rows = []; yr_h = 0.0; yr_peak = base
    idx = list(daily.index)
    for i, (dt, r) in enumerate(daily.items()):
        eq *= (1 + r); peak = max(peak, eq); yr_peak = max(yr_peak, eq)
        if eq < peak * (1 - decay) and eq > base:
            h = eq - base; bank += h; yr_h += h; eq = base; peak = base
        last = (i == len(idx) - 1) or (idx[i + 1].year != dt.year)
        if last:
            if eq > base:
                h = eq - base; bank += h; yr_h += h; eq = base; peak = base
            rows.append((dt.year, yr_peak, yr_h, bank, base + bank))
            yr_h = 0.0; yr_peak = base
    return rows


def backtest():
    b, df = blend_returns()
    m = ss.daily_metrics(b)
    print(f"=== ETH BLEND backtest  {b.index[0].date()} -> {b.index[-1].date()}  "
          f"(vol-tgt {VOL_TARGET:.0%}, {W_REGIME:.0%}/{W_POOL:.0%}, {COST_BPS}bps) ===")
    print(f"  ann {m['ann']*100:+.0f}%  Sharpe {m['sharpe']:.2f}  Calmar {m['calmar']:.2f}  "
          f"maxDD {m['maxdd']*100:.0f}%  positive months {m['pos_months']*100:.0f}%")
    print(f"\n  $10k from 2023, harvested to cash (reset on {HARVEST_DECAY:.0%} decay & year-end):")
    print(f"  {'year':6}{'peak':>11}{'cash out':>11}{'cum cash':>11}{'TOTAL':>11}")
    for y, pk, h, bk, tot in harvest(b[b.index >= '2023-01-01']):
        tag = " YTD" if y == b.index[-1].year else ""
        print(f"  {y}{tag:4}{pk:>10,.0f}{h:>11,.0f}{bk:>11,.0f}{tot:>11,.0f}")


def now():
    ss.set_tf("1d"); d1 = ss.load("1d", "ETH"); c = d1["close"]
    reg = float(E.recommended(d1).iloc[-1])
    ss.set_tf("4h"); d4 = ss.load("4h", "ETH"); ss.set_tf("1h"); d1h = ss.load("1h", "ETH")
    pool_now = float(pool_exposure(d4, d1h).iloc[-1])
    print(f"=== ETH BLEND — target as of {d1.index[-1].date()} (ETH ${c.iloc[-1]:,.0f}) ===")
    sma200 = c.rolling(200).mean().iloc[-1]
    print(f"  regime: ETH {c.iloc[-1]/sma200-1:+.0%} vs 200d -> {'BULL' if c.iloc[-1]>sma200 else 'BEAR'} regime")
    sd = lambda x: "LONG" if x > 0.02 else ("SHORT" if x < -0.02 else "FLAT")
    print(f"  REGIME sleeve : {sd(reg):5} {reg:+.2f}   (long-biased committee, hedges bears)")
    print(f"  BREAKOUT pool : {sd(pool_now):5} {pool_now:+.2f}   (net of concurrent 4h-breakout books)")
    net = W_REGIME * reg + W_POOL * pool_now
    print(f"  BLEND net     : {sd(net):5} {net:+.2f} of equity (before vol-targeting to {VOL_TARGET:.0%})")
    print(f"  -> currently {'defensive/short in this bear; auto-flips long when ETH reclaims ~$%.0f (200d)' % sma200 if net<0 else 'net long'}")


if __name__ == "__main__":
    now() if "--now" in sys.argv[1:] else backtest()
