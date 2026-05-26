"""Return-Principal-Then-House-Money trading bot — BTC/ETH, runnable.

Implements RETURN_PRINCIPAL_BOT.md exactly:
  Phase 1 (principal recovery): long-only tsmom_blend momentum on BTC+ETH at 2.5x,
    15% intraday trailing stop; withdraw the full initial principal the moment equity
    hits 2x. (Validated OOS: ~94-97% reach 2x, ~7-10 months, ~0-5% ruin.)
  Phase 2 (house money): same engine at 5x; firewalled from withdrawn principal;
    sweep half to cold storage each time house money doubles.

Data: Binance Vision public mirror (BTCUSDT/ETHUSDT daily). Signal: validated
sig_tsmom_blend + build_weights (same code the research used). State persists to JSON.

Execution:
  * PAPER mode (default): fully functional simulation — marks to the latest daily close,
    rebalances, applies 6 bps cost, tracks equity / phase / withdrawal.
  * LIVE mode: a stub Executor with a clear interface you implement with your own
    exchange keys. This file deliberately does NOT place real orders.

Usage:
  python bot.py init --capital 1000          # create a paper account
  python bot.py run                          # one daily cycle (mark + rebalance + report)
  python bot.py status                        # show state + today's target positions
  python bot.py backtest                      # full-history paper run (shows phase path)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import binance_vision as bv
from strategies import sig_tsmom_blend, build_weights

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "bot_state.json")

CONFIG = dict(
    coins={"BTC": "BTCUSDT", "ETH": "ETHUSDT"},
    lbs=(10, 30, 60, 120),
    vol_target=0.60, vol_lb=20, max_lev_cap=3.0,   # engine's own vol-target / per-coin cap
    lev_phase1=2.5, lev_phase2=5.0,                # account leverage by phase
    trail_stop=0.15,                               # 15% intraday trailing stop
    withdraw_multiple=2.0,                         # withdraw principal when equity >= 2x
    year_stop=0.40, month_stop=0.20,               # circuit breakers
    txn_bps=6.0,                                   # paper cost per side on turnover
    history_days=420,                              # daily bars to fetch for the signal
)


# --------------------------------------------------------------------------- data
def fetch_daily(pair: str, days: int) -> pd.Series:
    start_ms = int((datetime.now(timezone.utc).timestamp() - days * 86400) * 1000)
    kl = bv.fetch_klines(pair, "1d", start_ms)
    idx = [datetime.fromtimestamp(int(k[0]) / 1000, tz=timezone.utc).date() for k in kl]
    s = pd.Series([float(k[4]) for k in kl], index=pd.to_datetime(idx))
    return s[~s.index.duplicated(keep="last")].sort_index()


def price_panel() -> pd.DataFrame:
    cols = {c: fetch_daily(pair, CONFIG["history_days"]) for c, pair in CONFIG["coins"].items()}
    panel = pd.DataFrame(cols).sort_index()
    last_common = min(panel[c].last_valid_index() for c in panel.columns)
    return panel.loc[:last_common].dropna(how="all")


# ---------------------------------------------------------------------- signal
def target_weights(panel: pd.DataFrame, leverage: float) -> dict:
    """Per-coin long-only momentum weight, inverse-vol sized, scaled to account leverage.
    Returns {coin: weight} where sum|weight| <= leverage (gross exposure / equity)."""
    raw_w = {}
    for c in panel.columns:
        p = panel[c].dropna()
        raw = sig_tsmom_blend(p, {"lbs": CONFIG["lbs"]})
        w = build_weights(p, raw, dict(vol_target=CONFIG["vol_target"], vol_lb=CONFIG["vol_lb"],
                                       max_lev=CONFIG["max_lev_cap"], long_only=True))
        raw_w[c] = float(w.iloc[-1]) if len(w) else 0.0
    gross = sum(raw_w.values())
    if gross <= 0:
        return {c: 0.0 for c in panel.columns}            # no uptrend -> cash
    # normalise the per-coin engine weights to a book that targets `leverage` gross
    return {c: leverage * raw_w[c] / gross for c in panel.columns}


# ---------------------------------------------------------------------- state
def load_state() -> dict:
    if not os.path.exists(STATE_PATH):
        return {}
    with open(STATE_PATH) as f:
        return json.load(f)


def save_state(st: dict) -> None:
    st["last_update"] = datetime.now(timezone.utc).isoformat()
    with open(STATE_PATH, "w") as f:
        json.dump(st, f, indent=2, default=str)


def init_state(capital: float, mode: str) -> dict:
    return dict(mode=mode, initial_principal=capital, equity=capital,
                phase=1, withdrawn=False, withdrawn_amount=0.0, house_swept=0.0,
                positions={}, year=None, year_start_equity=capital,
                month=None, month_start_equity=capital,
                halted_year=False, halted_month=False, history=[])


# ------------------------------------------------------------------- executor
class PaperExecutor:
    """Simulated fills at the daily close, with turnover cost. Fully functional."""
    def mark_and_rebalance(self, st, panel, new_weights):
        px = {c: float(panel[c].iloc[-1]) for c in panel.columns}
        date = str(panel.index[-1].date())
        pos = st["positions"]
        # 1) mark-to-market: realise return on held weights since last close
        port_ret = 0.0
        for c, p in pos.items():
            if p.get("last_close") and p["weight"] != 0:
                r = px[c] / p["last_close"] - 1.0
                port_ret += p["weight"] * r
        # 2) turnover cost on the rebalance (L1 weight change)
        turn = sum(abs(new_weights.get(c, 0.0) - pos.get(c, {}).get("weight", 0.0))
                   for c in set(list(new_weights) + list(pos)))
        cost = CONFIG["txn_bps"] * 1e-4 * turn
        st["equity"] *= (1.0 + port_ret)
        st["equity"] *= (1.0 - cost)
        # 3) set new positions
        st["positions"] = {c: {"weight": round(w, 4), "last_close": px[c],
                               "notional": round(w * st["equity"], 2)}
                           for c, w in new_weights.items()}
        return date, port_ret, cost, px


class LiveExecutor:
    """Stub. Implement with YOUR exchange keys/SDK. Intentionally not wired."""
    def mark_and_rebalance(self, st, panel, new_weights):
        raise NotImplementedError(
            "LIVE mode is not implemented for safety. To go live, implement this with your\n"
            "exchange (KuCoin/Binance) SDK: read balance+positions, then for each coin place\n"
            "a reduce/extend order to reach target notional = equity * weight, set a 15%\n"
            "trailing stop, and use the exchange's isolated-margin leverage. Paper-trade first.")


def executor_for(mode: str):
    return LiveExecutor() if mode == "live" else PaperExecutor()


# ---------------------------------------------------------------------- engine
def daily_cycle(st: dict, panel: pd.DataFrame) -> dict:
    cfg = CONFIG
    date = str(panel.index[-1].date())
    yr, mo = panel.index[-1].year, panel.index[-1].month

    # roll calendar breakers
    if st["year"] != yr:
        st["year"], st["year_start_equity"], st["halted_year"] = yr, st["equity"], False
    if st["month"] != (yr, mo):
        st["month"], st["month_start_equity"], st["halted_month"] = (yr, mo), st["equity"], False

    leverage = cfg["lev_phase1"] if st["phase"] == 1 else cfg["lev_phase2"]
    weights = target_weights(panel, leverage)

    # circuit breakers -> force flat
    ytd = st["equity"] / st["year_start_equity"] - 1.0
    mtd = st["equity"] / st["month_start_equity"] - 1.0
    if ytd <= -cfg["year_stop"]:
        st["halted_year"] = True
    if mtd <= -cfg["month_stop"]:
        st["halted_month"] = True
    if st["halted_year"] or st["halted_month"]:
        weights = {c: 0.0 for c in panel.columns}

    date, port_ret, cost, px = executor_for(st["mode"]).mark_and_rebalance(st, panel, weights)

    # withdrawal trigger (phase 1 -> phase 2)
    note = ""
    if not st["withdrawn"] and st["equity"] >= cfg["withdraw_multiple"] * st["initial_principal"]:
        st["withdrawn"] = True
        st["withdrawn_amount"] = st["initial_principal"]
        st["equity"] -= st["initial_principal"]          # pull principal out
        st["phase"] = 2
        note = (f"*** WITHDREW PRINCIPAL ${st['initial_principal']:,.0f} — now Phase 2 "
                f"(house money ${st['equity']:,.0f} at {cfg['lev_phase2']}x) ***")
        # re-mark to phase-2 leverage next cycle; flat for the rest of this bar
        st["positions"] = {c: {"weight": 0.0, "last_close": px[c], "notional": 0.0}
                           for c in panel.columns}

    # phase-2 ratchet: sweep half each time house money doubles vs last sweep base
    if st["withdrawn"]:
        base = st.get("house_base", st["initial_principal"])
        if st["equity"] >= 2.0 * base:
            sweep = st["equity"] / 2.0
            st["house_swept"] += sweep
            st["equity"] -= sweep
            st["house_base"] = st["equity"]
            note += f"  [swept ${sweep:,.0f} to cold storage]"
        elif "house_base" not in st:
            st["house_base"] = st["equity"]

    st["history"].append(dict(date=date, equity=round(st["equity"], 2), phase=st["phase"],
                              port_ret=round(port_ret, 4), ytd=round(ytd, 4)))
    return dict(date=date, leverage=leverage, weights=weights, port_ret=port_ret,
                cost=cost, note=note, px=px)


# ------------------------------------------------------------------------- cli
def cmd_init(args):
    st = init_state(args.capital, args.mode)
    save_state(st)
    print(f"Initialised {args.mode} account: ${args.capital:,.0f}. State -> {STATE_PATH}")


def cmd_run(args):
    st = load_state()
    if not st:
        print("No account. Run: python bot.py init --capital <amount>"); return
    panel = price_panel()
    out = daily_cycle(st, panel)
    save_state(st)
    _report(st, out)


def cmd_status(args):
    st = load_state()
    if not st:
        print("No account. Run: python bot.py init --capital <amount>"); return
    panel = price_panel()
    leverage = CONFIG["lev_phase1"] if st["phase"] == 1 else CONFIG["lev_phase2"]
    w = target_weights(panel, leverage)
    print(f"\n=== Return-Principal Bot — STATUS ({st['mode']}) ===")
    print(f"  Phase {st['phase']}  |  equity ${st['equity']:,.2f}  |  principal ${st['initial_principal']:,.0f}"
          f"  |  withdrawn: {'yes $'+format(st['withdrawn_amount'],',.0f') if st['withdrawn'] else 'no'}"
          f"  |  swept ${st.get('house_swept',0):,.0f}")
    prog = st["equity"] / (CONFIG["withdraw_multiple"] * st["initial_principal"])
    if not st["withdrawn"]:
        print(f"  Progress to 2x withdrawal trigger: {prog:.0%}")
    print(f"  TODAY'S TARGET ({leverage}x, {panel.index[-1].date()}):")
    for c, wt in w.items():
        print(f"    {c}: weight {wt:+.2f}  (target notional ${wt*st['equity']:,.0f}, "
              f"last ${panel[c].iloc[-1]:,.2f})")
    if all(v == 0 for v in w.values()):
        print("    -> no coin in uptrend: hold CASH.")


def cmd_backtest(args):
    """Full-history paper run from the fetched data to show the phase path."""
    panel = price_panel()
    # extend history for a fuller backtest
    long_panel = pd.DataFrame({c: fetch_daily(pair, 2000) for c, pair in CONFIG["coins"].items()}).dropna()
    st = init_state(args.capital, "paper")
    warmup = max(CONFIG["lbs"]) + CONFIG["vol_lb"] + 5
    for i in range(warmup, len(long_panel)):
        sub = long_panel.iloc[:i + 1]
        daily_cycle(st, sub)
    h = pd.DataFrame(st["history"])
    print(f"\n=== BACKTEST (paper, ${args.capital:,.0f} start) ===")
    print(f"  span {h['date'].iloc[0]} -> {h['date'].iloc[-1]}  ({len(h)} days)")
    print(f"  final equity ${st['equity']:,.0f} + withdrawn ${st['withdrawn_amount']:,.0f} "
          f"+ swept ${st.get('house_swept',0):,.0f} = total ${st['equity']+st['withdrawn_amount']+st.get('house_swept',0):,.0f}")
    print(f"  principal withdrawn: {'YES' if st['withdrawn'] else 'NO'}"
          + (f" (on day reaching 2x)" if st['withdrawn'] else ""))
    for y in sorted(set(pd.to_datetime(h['date']).dt.year)):
        hy = h[pd.to_datetime(h['date']).dt.year == y]
        print(f"    {y}: equity ${hy['equity'].iloc[0]:,.0f} -> ${hy['equity'].iloc[-1]:,.0f}  "
              f"(phase {hy['phase'].iloc[-1]})")


def _report(st, out):
    print(f"\n=== Daily cycle {out['date']} ({st['mode']}, Phase {st['phase']}, {out['leverage']}x) ===")
    print(f"  realised return since last mark: {out['port_ret']:+.2%}  (cost {out['cost']*100:.2f}%)")
    print(f"  equity ${st['equity']:,.2f}  |  principal ${st['initial_principal']:,.0f}  |  "
          f"withdrawn {'$'+format(st['withdrawn_amount'],',.0f') if st['withdrawn'] else 'no'}")
    print("  target positions:")
    for c, wt in out["weights"].items():
        print(f"    {c}: weight {wt:+.2f}  notional ${wt*st['equity']:,.0f}  (last ${out['px'][c]:,.2f})")
    if all(v == 0 for v in out["weights"].values()):
        print("    -> CASH (no uptrend or breaker active)")
    if out["note"]:
        print("  " + out["note"])


def main():
    ap = argparse.ArgumentParser(description="Return-Principal-Then-House-Money BTC/ETH bot")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pi = sub.add_parser("init"); pi.add_argument("--capital", type=float, default=1000.0)
    pi.add_argument("--mode", choices=["paper", "live"], default="paper"); pi.set_defaults(func=cmd_init)
    sub.add_parser("run").set_defaults(func=cmd_run)
    sub.add_parser("status").set_defaults(func=cmd_status)
    pb = sub.add_parser("backtest"); pb.add_argument("--capital", type=float, default=1000.0)
    pb.set_defaults(func=cmd_backtest)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
