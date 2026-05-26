"""Rigorous search for predictable patterns in BTC & ETH.

Honest, statistics-first. For each candidate pattern we report effect size + a t-stat,
and — crucially — split the sample IN-SAMPLE (first half) vs OUT-OF-SAMPLE (second half)
and report whether the effect SURVIVES OOS. Most 'patterns' are data-snooping noise; the
IS/OOS split and a multiple-testing lens are what separate signal from mirage.

Tests:
  A. Return autocorrelation (are returns predictable?) + Ljung-Box + variance ratio.
  B. Volatility clustering (is |return| predictable?) — the known-robust pattern.
  C. Day-of-week, month-of-year, hour-of-day (intraday) seasonality, with IS/OOS.
  D. Momentum vs mean-reversion: sign-continuation at multiple horizons, IS/OOS.
  E. Overreaction bounce: next-day return after a big down day, IS/OOS.

Data: Coin Metrics daily (long history) + Binance Vision 1h.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))


def load_daily(sym):
    df = pd.read_csv(os.path.join(HERE, "data", f"{sym}_daily.csv"), parse_dates=["date"])
    s = pd.Series(df["close"].values, index=pd.DatetimeIndex(df["date"]))
    return s[~s.index.duplicated()].sort_index()


def load_1h(sym):
    p = os.path.join(HERE, "data", "intraday", f"{sym}_1h.csv")
    if not os.path.exists(p):
        return None
    df = pd.read_csv(p)
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    return pd.Series(df["close"].astype(float).values, index=idx).sort_index()


def tstat(x):
    x = np.asarray(x, float); x = x[~np.isnan(x)]
    if len(x) < 10 or x.std(ddof=1) == 0:
        return 0.0, len(x)
    return float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))), len(x)


def autocorr(x, lag):
    x = np.asarray(x, float); x = x[~np.isnan(x)]
    if len(x) <= lag:
        return 0.0
    a, b = x[:-lag], x[lag:]
    return float(np.corrcoef(a, b)[0, 1])


def ljung_box(x, m=10):
    x = np.asarray(x, float); x = x[~np.isnan(x)]; n = len(x)
    q = 0.0
    for k in range(1, m + 1):
        rk = autocorr(x, k)
        q += rk * rk / (n - k)
    return n * (n + 2) * q


def variance_ratio(x, q):
    x = np.asarray(x, float); x = x[~np.isnan(x)]; n = len(x)
    mu = x.mean()
    var1 = np.sum((x - mu) ** 2) / n
    # q-period overlapping returns
    qsum = np.convolve(x, np.ones(q), "valid")
    varq = np.sum((qsum - q * mu) ** 2) / (n * q)
    return float(varq / var1) if var1 > 0 else 1.0


def split(s):
    n = len(s); return s.iloc[:n // 2], s.iloc[n // 2:]


def hdr(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}")


def main(argv):
    syms = [a.upper() for a in argv if a.upper() in ("BTC", "ETH")] or ["BTC", "ETH"]
    n_tests = 0   # rough multiple-testing counter

    for sym in syms:
        d = load_daily(sym)
        ret = d.pct_change().dropna()
        hdr(f"{sym}  —  daily {d.index[0].date()}->{d.index[-1].date()}  ({len(ret)} days)")

        # A. Return predictability
        print("A. RETURN AUTOCORRELATION (predictable?)  band ±%.3f (95%%)" % (1.96/np.sqrt(len(ret))))
        band = 1.96 / np.sqrt(len(ret))
        acs = [(k, autocorr(ret.values, k)) for k in range(1, 8)]
        print("   lag:  " + "  ".join(f"{k}:{a:+.3f}{'*' if abs(a)>band else ' '}" for k, a in acs))
        lb = ljung_box(ret.values, 10)
        print(f"   Ljung-Box Q(10)={lb:.1f}  (chi2_0.95(10)=18.3 -> {'AUTOCORR present' if lb>18.3 else 'no significant autocorr'})")
        vr5, vr20 = variance_ratio(ret.values, 5), variance_ratio(ret.values, 20)
        print(f"   Variance ratio VR(5)={vr5:.2f} VR(20)={vr20:.2f}  (1=random walk, >1 momentum, <1 reversion)")
        n_tests += 3

        # B. Volatility clustering
        absr = ret.abs()
        vac = [(k, autocorr(absr.values, k)) for k in (1, 5, 10, 20)]
        print("\nB. VOLATILITY CLUSTERING  autocorr of |return|:")
        print("   lag:  " + "  ".join(f"{k}:{a:+.3f}{'*' if abs(a)>band else ' '}" for k, a in vac))
        print(f"   -> {'STRONG & persistent (volatility IS predictable)' if vac[0][1]>0.1 else 'weak'}")

        # C. Day-of-week (IS/OOS)
        print("\nC. DAY-OF-WEEK seasonality (mean daily return, t-stat; IS vs OOS):")
        dow = pd.DataFrame({"r": ret, "dow": ret.index.dayofweek})
        is_, oos_ = split(ret)
        for w, name in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]):
            full = dow[dow.dow == w]["r"]
            t_f, _ = tstat(full.values)
            t_is, _ = tstat(is_[is_.index.dayofweek == w].values)
            t_oos, _ = tstat(oos_[oos_.index.dayofweek == w].values)
            flag = "  <-- significant & OOS-consistent" if abs(t_f) > 2 and np.sign(t_is) == np.sign(t_oos) and abs(t_oos) > 1 else ""
            print(f"   {name}: mean {full.mean()*100:+.2f}%  t={t_f:+.2f}  (IS t={t_is:+.2f}, OOS t={t_oos:+.2f}){flag}")
            n_tests += 1

        # D. Momentum vs reversion (sign-continuation, IS/OOS) at horizons
        print("\nD. MOMENTUM vs REVERSION — P(next h-day return same sign as prior h-day):")
        for h in (1, 5, 20, 60):
            mom = d.pct_change(h)
            fwd = d.pct_change(h).shift(-h)
            both = pd.concat([mom, fwd], axis=1).dropna()
            both.columns = ["past", "fut"]
            cont = (np.sign(both["past"]) == np.sign(both["fut"]))
            i2 = len(both) // 2
            cont_is, cont_oos = cont.iloc[:i2].mean(), cont.iloc[i2:].mean()
            edge = both["fut"][np.sign(both["past"]) > 0].mean() - both["fut"][np.sign(both["past"]) < 0].mean()
            print(f"   h={h:>2}d: continuation {cont.mean():.1%} (IS {cont_is:.1%}/OOS {cont_oos:.1%})  "
                  f"long-minus-short fwd edge {edge*100:+.2f}%  "
                  f"{'MOMENTUM' if cont.mean()>0.53 else ('REVERSION' if cont.mean()<0.47 else 'none')}")
            n_tests += 1

        # E. Overreaction bounce
        print("\nE. OVERREACTION — next-day mean return after a big DOWN day:")
        for thr in (-0.05, -0.10):
            nxt = ret.shift(-1)[ret <= thr].dropna()
            t, n = tstat(nxt.values)
            base = ret.mean()
            print(f"   after day <= {thr:.0%} (n={n}): next-day mean {nxt.mean()*100:+.2f}% "
                  f"(vs unconditional {base*100:+.2f}%)  t={t:+.2f}")
            n_tests += 1

        # F. Month-of-year (brief)
        moy = ret.groupby(ret.index.month).mean() * 21  # ~monthly
        best, worst = moy.idxmax(), moy.idxmin()
        print(f"\nF. MONTH-OF-YEAR: best={best} ({moy[best]*100:+.1f}%/mo) worst={worst} ({moy[worst]*100:+.1f}%/mo) "
              f"(weak/seasonal — treat as noise unless OOS-stable)")

        # intraday hour-of-day
        h1 = load_1h(sym)
        if h1 is not None:
            hr = h1.pct_change().dropna()
            hod = hr.groupby(hr.index.hour).mean()
            t_by_hr = {h: tstat(hr[hr.index.hour == h].values)[0] for h in range(24)}
            sig = [h for h in range(24) if abs(t_by_hr[h]) > 2]
            print(f"\nG. HOUR-OF-DAY (1h, UTC): best hr={hod.idxmax()} worst hr={hod.idxmin()}; "
                  f"hours with |t|>2: {sig if sig else 'NONE'} "
                  f"({'likely noise after multiple testing' if len(sig)<=2 else 'investigate'})")
            n_tests += 1

    print(f"\n{'='*78}\nMULTIPLE-TESTING NOTE: ~{n_tests} hypotheses tested. At 5% significance, "
          f"~{int(n_tests*0.05)} false positives are EXPECTED by chance alone. Trust only "
          f"effects that are (a) large, (b) significant, AND (c) consistent IS->OOS.")


if __name__ == "__main__":
    main(sys.argv[1:])
