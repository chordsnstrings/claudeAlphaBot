"""Day-trading WIN-RATE study for BTC & ETH on 1H / 8H / 12H / 1D candles.

Goal (from the project goal): *as a day trader*, find the most profitable way to
trade BTC & ETH on intraday candles, optimised for the **highest win rate** — and
do it honestly, i.e. report win rate **alongside** the things that decide whether a
high win rate is actually worth anything: net return after costs, profit factor,
expectancy, and tail/drawdown.

Why this is its own study. The repo already proved (PATTERNS / PREDICTION docs)
that BTC/ETH *direction* is ~unpredictable at short horizons, and the prior
intraday work optimised for *Sharpe* to complement a daily trend book. Nobody
optimised for **win rate**, which is a genuinely different objective: a tight
take-profit with a wide stop wins most trades by construction — the open question
a day trader actually cares about is whether any such high-hit-rate setup keeps a
*positive expectancy after real fees*, or whether the rare big loss eats the many
small wins. This script answers that, per coin and per timeframe.

Engine (no lookahead, conservative):
  * Signal is computed on bar t's CLOSE; entry fills at bar t+1's OPEN.
  * Each trade is a bracket: take-profit and stop-loss as % of entry (or ATR mult),
    plus a time-stop after N bars (exit at close).
  * Intrabar fills use HIGH/LOW. Gaps fill at the bar OPEN. If a single bar's range
    contains BOTH the TP and the SL, we assume the **stop** filled first (worst
    case) so win rate is never optimistically inflated — this matters precisely
    because high-win-rate setups are the ones vulnerable to that bias.
  * One position at a time (a focused day-trade book). Round-trip taker cost charged.

Validation: timeline split 70% train / 30% test. Parameters are chosen ONLY on
train (by net expectancy with a trade-count floor); we then report the SAME config
on the unseen test slice. A setup only "counts" if its win rate AND profitability
survive out-of-sample.

Data: research/data/intraday/<SYM>_1h.csv (real Binance spot OHLCV), resampled to
8H/12H/1D anchored at 00:00 UTC.
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
INTRADAY_DIR = os.path.join(HERE, "data", "intraday")
RESULTS = os.path.join(HERE, "results")

COINS = ["BTC", "ETH"]
TIMEFRAMES = ["1h", "8h", "12h", "1d"]

# Realistic round-trip cost. Binance spot taker is ~10 bps; futures taker ~5 bps.
# We charge 6 bps PER SIDE (12 bps round-trip) as a conservative-but-fair taker
# assumption for a retail day trader. (Maker/limit entries would be cheaper; this
# is the pessimistic case, which is the right bar for a high-turnover book.)
COST_BPS_PER_SIDE = 6.0

TRAIN_FRAC = 0.70
MIN_TRADES_TRAIN = 30   # don't trust a param set with too few train trades
MIN_TRADES_TEST = 12


# --------------------------------------------------------------------------- data
def load_1h(sym: str) -> pd.DataFrame:
    path = os.path.join(INTRADAY_DIR, f"{sym}_1h.csv")
    df = pd.read_csv(path)
    idx = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)
    df = df.set_index(idx)[["open", "high", "low", "close", "volume"]].astype(float)
    df = df[~df.index.duplicated(keep="first")].sort_index()
    return df


def resample(df1h: pd.DataFrame, tf: str) -> pd.DataFrame:
    if tf == "1h":
        out = df1h.copy()
    else:
        rule = {"8h": "8h", "12h": "12h", "1d": "1D"}[tf]
        out = pd.DataFrame({
            "open": df1h["open"].resample(rule).first(),
            "high": df1h["high"].resample(rule).max(),
            "low": df1h["low"].resample(rule).min(),
            "close": df1h["close"].resample(rule).last(),
            "volume": df1h["volume"].resample(rule).sum(),
        }).dropna()
    return out


# --------------------------------------------------------------------- indicators
def rsi(close: np.ndarray, n: int) -> np.ndarray:
    d = np.diff(close, prepend=close[0])
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    # Wilder smoothing
    ru = np.zeros_like(close)
    rd = np.zeros_like(close)
    ru[:n] = up[:n].mean() if n > 0 else 0.0
    rd[:n] = dn[:n].mean() if n > 0 else 0.0
    a = 1.0 / n
    for i in range(n, len(close)):
        ru[i] = (1 - a) * ru[i - 1] + a * up[i]
        rd[i] = (1 - a) * rd[i - 1] + a * dn[i]
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = np.where(rd > 1e-12, ru / rd, np.inf)
    out = 100.0 - 100.0 / (1.0 + rs)
    out[:n] = 50.0
    return out


def atr(high, low, close, n: int) -> np.ndarray:
    pc = np.roll(close, 1)
    pc[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - pc), np.abs(low - pc)))
    out = np.zeros_like(close)
    out[:n] = tr[:n].mean()
    a = 1.0 / n
    for i in range(n, len(close)):
        out[i] = (1 - a) * out[i - 1] + a * tr[i]
    return out


def sma(x: np.ndarray, n: int) -> np.ndarray:
    if n <= 1:
        return x.copy()
    if n > len(x):                       # window longer than series -> all NaN
        return np.full(len(x), np.nan)
    c = np.cumsum(np.insert(x, 0, 0.0))
    out = (c[n:] - c[:-n]) / n
    return np.concatenate([np.full(n - 1, np.nan), out])


def rolling_std(x: np.ndarray, n: int) -> np.ndarray:
    s = pd.Series(x)
    return s.rolling(n).std(ddof=0).to_numpy()


# ----------------------------------------------------------------------- signals
# Each signal generator returns an int array in {+1, -1, 0}: the DESIRED entry
# direction at this bar's close (acted on next bar's open, only when flat).

def sig_zscore(o, h, l, c, p):
    lb = p["lb"]
    ma = sma(c, lb)
    sd = rolling_std(c, lb)
    z = (c - ma) / np.where(sd > 1e-12, sd, np.nan)
    s = np.zeros(len(c), dtype=int)
    s[z <= -p["z"]] = 1                      # oversold -> long
    if not p.get("long_only"):
        s[z >= p["z"]] = -1                  # overbought -> short
    s[~np.isfinite(z)] = 0
    return s


def sig_rsi(o, h, l, c, p):
    r = rsi(c, p["lb"])
    s = np.zeros(len(c), dtype=int)
    s[r <= p["lo"]] = 1
    if not p.get("long_only"):
        s[r >= p["hi"]] = -1
    return s


def sig_trend_pullback(o, h, l, c, p):
    """Buy-the-dip *in the direction of the higher trend* (continuation).
    Trend = price vs slow SMA; dip = RSI below a mid threshold. Hypothesis: the
    trend bias lifts both win rate AND expectancy vs pure mean reversion."""
    slow = sma(c, p["slow"])
    r = rsi(c, p["rsi_lb"])
    up = c > slow
    dn = c < slow
    s = np.zeros(len(c), dtype=int)
    s[up & (r <= p["dip"])] = 1              # uptrend + short-term dip -> long
    if not p.get("long_only"):
        s[dn & (r >= 100 - p["dip"])] = -1   # downtrend + short-term pop -> short
    return s


SIGNALS = {
    "zscore_mr": sig_zscore,
    "rsi_mr": sig_rsi,
    "trend_pullback": sig_trend_pullback,
}


# ------------------------------------------------------------------------ engine
@dataclass
class Trade:
    side: int          # +1 long / -1 short
    entry_i: int
    exit_i: int
    entry_px: float
    exit_px: float
    ret_net: float     # net of round-trip cost, as fraction of capital (1x)
    reason: str        # 'tp' | 'sl' | 'time'


def bracket_backtest(df: pd.DataFrame, signal: np.ndarray, tp: float, sl: float,
                     max_hold: int, cost_bps: float, atr_arr=None,
                     tp_atr: float = 0.0, sl_atr: float = 0.0) -> list[Trade]:
    """Event-driven bracket sim. tp/sl are fractional (e.g. 0.01 = 1%). If
    tp_atr/sl_atr > 0, brackets are ATR-multiples instead (overrides tp/sl).
    Conservative same-bar resolution: stop wins ties."""
    o = df["open"].to_numpy(); h = df["high"].to_numpy()
    l = df["low"].to_numpy(); c = df["close"].to_numpy()
    n = len(c)
    cost = cost_bps / 1e4
    trades: list[Trade] = []
    i = 0
    while i < n - 1:
        sdir = signal[i]
        if sdir == 0:
            i += 1
            continue
        # enter at next bar open
        ei = i + 1
        epx = o[ei]
        if not np.isfinite(epx) or epx <= 0:
            i += 1
            continue
        if tp_atr > 0 and atr_arr is not None:
            a = atr_arr[i]
            tp_lvl = epx + sdir * tp_atr * a
            sl_lvl = epx - sdir * sl_atr * a
        else:
            tp_lvl = epx * (1 + sdir * tp)
            sl_lvl = epx * (1 - sdir * sl)
        exit_i, exit_px, reason = -1, np.nan, "time"
        last = min(ei + max_hold, n - 1)
        for j in range(ei, last + 1):
            oj, hj, lj, cj = o[j], h[j], l[j], c[j]
            if sdir == 1:
                # gap through stop at open
                if oj <= sl_lvl:
                    exit_i, exit_px, reason = j, oj, "sl"; break
                if oj >= tp_lvl:
                    exit_i, exit_px, reason = j, oj, "tp"; break
                hit_sl = lj <= sl_lvl
                hit_tp = hj >= tp_lvl
                if hit_sl:                      # stop wins ties (worst case)
                    exit_i, exit_px, reason = j, sl_lvl, "sl"; break
                if hit_tp:
                    exit_i, exit_px, reason = j, tp_lvl, "tp"; break
            else:
                if oj >= sl_lvl:
                    exit_i, exit_px, reason = j, oj, "sl"; break
                if oj <= tp_lvl:
                    exit_i, exit_px, reason = j, oj, "tp"; break
                hit_sl = hj >= sl_lvl
                hit_tp = lj <= tp_lvl
                if hit_sl:
                    exit_i, exit_px, reason = j, sl_lvl, "sl"; break
                if hit_tp:
                    exit_i, exit_px, reason = j, tp_lvl, "tp"; break
            if j == last:                       # time stop
                exit_i, exit_px, reason = j, cj, "time"
        gross = sdir * (exit_px / epx - 1.0)
        ret_net = gross - 2 * cost              # entry + exit cost
        trades.append(Trade(sdir, ei, exit_i, epx, exit_px, ret_net, reason))
        i = exit_i + 1                          # flat until current trade closes
    return trades


# ----------------------------------------------------------------------- metrics
def trade_metrics(trades: list[Trade]) -> dict:
    if not trades:
        return dict(n=0, win_rate=0.0, net_total=0.0, expectancy=0.0,
                    profit_factor=0.0, avg_win=0.0, avg_loss=0.0,
                    max_dd=0.0, avg_hold=0.0, exposure_bars=0)
    rets = np.array([t.ret_net for t in trades])
    wins = rets[rets > 0]; losses = rets[rets <= 0]
    eq = np.cumprod(1 + rets)
    peak = np.maximum.accumulate(eq)
    dd = (eq / peak - 1.0).min()
    hold = np.array([t.exit_i - t.entry_i + 1 for t in trades])
    gross_w = wins.sum(); gross_l = -losses.sum()
    pf = (gross_w / gross_l) if gross_l > 1e-12 else (np.inf if gross_w > 0 else 0.0)
    return dict(
        n=len(trades),
        win_rate=float((rets > 0).mean()),
        net_total=float(eq[-1] - 1.0),          # compounded 1x return over the slice
        expectancy=float(rets.mean()),          # net per-trade
        profit_factor=float(pf),
        avg_win=float(wins.mean()) if len(wins) else 0.0,
        avg_loss=float(losses.mean()) if len(losses) else 0.0,
        max_dd=float(dd),
        avg_hold=float(hold.mean()),
        exposure_bars=int(hold.sum()),
    )


# -------------------------------------------------------------------- param grids
def grids(tf: str) -> dict[str, list[dict]]:
    """Param grids per signal family. Bracket tp/sl and max_hold scale with tf so
    a '1H trade' and a '1D trade' are both plausible day-trade horizons."""
    # max_hold in BARS, chosen so holding time is a day-trader horizon per tf.
    hold = {"1h": [6, 12, 24, 48], "8h": [3, 6, 9], "12h": [2, 4, 6], "1d": [1, 2, 3]}[tf]
    # bracket sizes (fractions). Cover the win-rate/expectancy tradeoff explicitly:
    # tight-TP/wide-SL (high hit rate) ... symmetric ... wide-TP/tight-SL (low hit rate)
    brs = [(0.005, 0.005), (0.005, 0.010), (0.005, 0.015),
           (0.010, 0.010), (0.010, 0.020), (0.010, 0.005),
           (0.015, 0.015), (0.020, 0.020), (0.020, 0.010),
           (0.030, 0.030), (0.030, 0.015)]
    # daily-scale brackets are a bit larger
    if tf in ("12h", "1d"):
        brs = [(t * 2, s * 2) for t, s in brs]

    g: dict[str, list[dict]] = {}
    g["zscore_mr"] = [
        dict(lb=lb, z=z, long_only=lo, tp=tp, sl=sl, max_hold=mh)
        for lb in (10, 20, 40)
        for z in (1.5, 2.0, 2.5)
        for lo in (False, True)
        for (tp, sl) in brs
        for mh in hold
    ]
    g["rsi_mr"] = [
        dict(lb=lb, lo=lo_t, hi=hi_t, long_only=loo, tp=tp, sl=sl, max_hold=mh)
        for lb in (7, 14, 21)
        for (lo_t, hi_t) in ((25, 75), (20, 80), (30, 70))
        for loo in (False, True)
        for (tp, sl) in brs
        for mh in hold
    ]
    g["trend_pullback"] = [
        dict(slow=sl_w, rsi_lb=rl, dip=dp, long_only=lo, tp=tp, sl=sl, max_hold=mh)
        for sl_w in (50, 100, 200)
        for rl in (7, 14)
        for dp in (35, 40, 45)
        for lo in (False, True)
        for (tp, sl) in brs
        for mh in hold
    ]
    return g


# --------------------------------------------------------------------- run / rank
def run_config(df, fam, p, cost_bps, atr_arr):
    sig = SIGNALS[fam](df["open"].to_numpy(), df["high"].to_numpy(),
                       df["low"].to_numpy(), df["close"].to_numpy(), p)
    return bracket_backtest(df, sig, p["tp"], p["sl"], p["max_hold"], cost_bps, atr_arr)


def split_idx(n: int) -> int:
    return int(n * TRAIN_FRAC)


def evaluate(sym: str, tf: str) -> dict:
    df1h = load_1h(sym)
    df = resample(df1h, tf)
    c = df["close"].to_numpy()
    a = atr(df["high"].to_numpy(), df["low"].to_numpy(), c, 14)
    sp = split_idx(len(df))
    df_tr = df.iloc[:sp]; df_te = df.iloc[sp:]
    a_tr = a[:sp]; a_te = a[sp:]

    out = {"coin": sym, "tf": tf, "bars": len(df),
           "train_span": [str(df_tr.index[0].date()), str(df_tr.index[-1].date())],
           "test_span": [str(df_te.index[0].date()), str(df_te.index[-1].date())],
           "families": {}}

    fam_grids = grids(tf)
    for fam, params in fam_grids.items():
        # single pass over the grid; track best-by-expectancy AND
        # best-by-winrate (among net-positive train configs)
        best_exp = None     # (expectancy, params, train_metrics)
        best_wr = None      # (win_rate, params, train_metrics)
        for p in params:
            tr = run_config(df_tr, fam, p, COST_BPS_PER_SIDE, a_tr)
            m = trade_metrics(tr)
            if m["n"] < MIN_TRADES_TRAIN:
                continue
            if best_exp is None or m["expectancy"] > best_exp[0]:
                best_exp = (m["expectancy"], p, m)
            if m["net_total"] > 0 and (best_wr is None or m["win_rate"] > best_wr[0]):
                best_wr = (m["win_rate"], p, m)
        if best_exp is None:
            out["families"][fam] = {"status": "no_qualifying_train_config"}
            continue
        _, bp, m_tr = best_exp
        m_te = trade_metrics(run_config(df_te, fam, bp, COST_BPS_PER_SIDE, a_te))
        wr_block = None
        if best_wr is not None:
            _, wp, mwr_tr = best_wr
            mwr_te = trade_metrics(run_config(df_te, fam, wp, COST_BPS_PER_SIDE, a_te))
            wr_block = {"params": wp, "train": mwr_tr, "test": mwr_te}
        out["families"][fam] = {
            "best_by_expectancy": {"params": bp, "train": m_tr, "test": m_te},
            "best_by_winrate_netpos": wr_block,
        }
    return out


def fmt_m(m: dict) -> str:
    if m.get("n", 0) == 0:
        return "n=0"
    return (f"n={m['n']:>4} win={m['win_rate']:>5.1%} net={m['net_total']:>+7.1%} "
            f"PF={m['profit_factor']:>4.2f} exp={m['expectancy']:>+.3%} "
            f"DD={m['max_dd']:>+6.1%} hold={m['avg_hold']:.1f}b")


def main(argv):
    coins = [a.upper() for a in argv if a.upper() in COINS] or COINS
    tfs = [a for a in argv if a in TIMEFRAMES] or TIMEFRAMES
    os.makedirs(RESULTS, exist_ok=True)
    allout = {"cost_bps_per_side": COST_BPS_PER_SIDE, "train_frac": TRAIN_FRAC,
              "results": []}
    print(f"DAY-TRADE WIN-RATE STUDY  coins={coins} tfs={tfs}  "
          f"cost={COST_BPS_PER_SIDE}bps/side  train={TRAIN_FRAC:.0%}\n"
          f"(entry=next-open, conservative same-bar stop-first, 1x, one-at-a-time)\n")
    for sym in coins:
        for tf in tfs:
            r = evaluate(sym, tf)
            allout["results"].append(r)
            print(f"\n===== {sym} {tf}  bars={r['bars']}  "
                  f"train {r['train_span'][0]}→{r['train_span'][1]}  "
                  f"test {r['test_span'][0]}→{r['test_span'][1]} =====")
            for fam, fb in r["families"].items():
                if "status" in fb:
                    print(f"  {fam:<16} {fb['status']}")
                    continue
                be = fb["best_by_expectancy"]
                print(f"  {fam:<16} [max-expectancy]")
                print(f"      params {be['params']}")
                print(f"      TRAIN  {fmt_m(be['train'])}")
                print(f"      TEST   {fmt_m(be['test'])}")
                wb = fb["best_by_winrate_netpos"]
                if wb:
                    print(f"  {fam:<16} [max-winrate, net+]")
                    print(f"      TRAIN  {fmt_m(wb['train'])}")
                    print(f"      TEST   {fmt_m(wb['test'])}")
    # ---------------- OOS leaderboard ----------------
    # An entry "survives" only if its TEST slice is net-positive AND has enough
    # test trades to be believable. Rank survivors by TEST win rate.
    board = []
    for r in allout["results"]:
        for fam, fb in r["families"].items():
            if "status" in fb:
                continue
            for tag, blk in (("exp", fb.get("best_by_expectancy")),
                             ("wr", fb.get("best_by_winrate_netpos"))):
                if not blk:
                    continue
                te = blk["test"]; trn = blk["train"]
                survived = te["n"] >= MIN_TRADES_TEST and te["net_total"] > 0
                board.append({
                    "coin": r["coin"], "tf": r["tf"], "family": fam, "select": tag,
                    "params": blk["params"],
                    "train_win": trn["win_rate"], "train_net": trn["net_total"],
                    "test_n": te["n"], "test_win": te["win_rate"],
                    "test_net": te["net_total"], "test_pf": te["profit_factor"],
                    "test_dd": te["max_dd"], "test_exp": te["expectancy"],
                    "survived": survived,
                })
    survivors = sorted([b for b in board if b["survived"]],
                       key=lambda b: b["test_win"], reverse=True)
    allout["leaderboard"] = {"survivors": survivors, "all": board}
    print("\n" + "=" * 84)
    print("OOS LEADERBOARD — configs net-positive on the UNSEEN test slice "
          f"(test n>={MIN_TRADES_TEST}), ranked by test win rate")
    print("=" * 84)
    if not survivors:
        print("  NONE. No configuration stayed net-positive out-of-sample with a "
              "trustworthy trade count.")
    else:
        print(f"  {'coin':<4} {'tf':<4} {'family':<15} {'sel':<3} "
              f"{'test_win':>8} {'test_net':>9} {'PF':>5} {'test_DD':>8} "
              f"{'n':>4}")
        for b in survivors:
            print(f"  {b['coin']:<4} {b['tf']:<4} {b['family']:<15} {b['select']:<3} "
                  f"{b['test_win']:>8.1%} {b['test_net']:>+9.1%} "
                  f"{b['test_pf']:>5.2f} {b['test_dd']:>+8.1%} {b['test_n']:>4}")

    with open(os.path.join(RESULTS, "daytrade_winrate_results.json"), "w") as f:
        json.dump(allout, f, indent=2, default=float)
    print(f"\nwrote {os.path.join(RESULTS, 'daytrade_winrate_results.json')}")


if __name__ == "__main__":
    main(sys.argv[1:])
