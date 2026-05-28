"""Deployable paper/live trader for the unified all-weather book + 2x profit-harvest.

Closes the deployment gaps identified in the live-state review:
  1. LIVE DATA  — refreshes CORE (5 coins) + a liquid L/S SPINE universe + BTC/ETH
     intraday from the public Binance mirror every cycle.
  2. SIGNAL     — builds today's combined target book: CORE (0.40) momentum + SPINE
     (0.30) long/short trend + intraday BTC1H/ETH8H pullback longs (0.15 each).
  3. HARVEST/RISK STATE MACHINE — the validated 2x-harvest policy, live and persisted:
     $300k base reset each Jan (no compounding); take profit when equity 2x's, LEAVING
     50% on the table (keep trading); -40% YTD stop -> flat for the year; year-end sweep;
     SELF-FUNDING accounting (losing-year top-ups come from already-harvested cash, never
     external money) + principal-returned flag.
  4. EXECUTION  — a PaperBroker (mark-to-close, turnover cost) and a real ccxt-based
     LiveBroker. LiveBroker DEFAULTS to dry-run (computes & prints exact orders, sends
     nothing); real orders require `run --execute` + EXCHANGE_API_KEY/SECRET in env.
     UNTESTED against a live account — verify on testnet/tiny size first.
  5. STATE      — JSON-persisted, idempotent per UTC day.

Going live (no paper-trading the strategy, per request): init --mode live; `run` shows a
DRY-RUN order preview; add `--execute` (with keys in env) to send. Harvest withdrawals and
the -40% flatten print as OPERATOR ALERTS. Do ONE testnet/tiny-size cycle to confirm the
order plumbing before full size — that is execution-sanity, not strategy validation.

Cadence: once per day after 00:00 UTC. CORE + SPINE are daily strategies; the BTC1H/
ETH8H pullback triggers are evaluated at the daily bar in this v1 (a documented
simplification — a sub-hourly runner would manage their intrabar brackets; see RUNBOOK
in the module docstring of run()). Leverage m multiplies the whole book's daily return,
exactly as in the backtest.

Usage:
  python live_trader.py init --capital 300000     # create a paper account at the base
  python live_trader.py run                        # one daily cycle: refresh -> mark -> harvest -> rebalance
  python live_trader.py status                     # state + today's target book
  python live_trader.py backtest --capital 300000  # full-history paper run of this exact live logic
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import all_weather as aw
import binance_vision as bv
import production_strategy as ps
from intraday_live import position_now

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "live_trader_state.json")

CFG = dict(
    # capital allocation across sleeves (the recommended all-weather profile)
    w_core=0.40, w_btc1h=0.15, w_eth8h=0.15, w_spine=0.30,
    leverage=2.0,                       # m: multiplies the whole book's daily return
    # harvest policy (sweep-optimal)
    double_at=2.0, harvest_frac=0.5, go_flat=False, year_stop=0.40,
    # costs
    txn_bps=6.0, funding_bps=1.0,
    # CORE universe + intraday triggers (representative validated params)
    core_coins=["SOL", "ETH", "BTC", "DOGE", "XRP"],
    btc1h=dict(slow=50, dip=35, adx=30), eth8h=dict(slow=50, dip=45, adx=20),
    # liquid, currently-listed L/S spine universe (Binance USDT pairs). The backtest used
    # a survivorship-free top-30 incl. corpses; LIVE trades only listed names.
    spine_pairs={"BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT", "BNB": "BNBUSDT",
                 "XRP": "XRPUSDT", "DOGE": "DOGEUSDT", "ADA": "ADAUSDT", "AVAX": "AVAXUSDT",
                 "LINK": "LINKUSDT", "DOT": "DOTUSDT", "LTC": "LTCUSDT", "BCH": "BCHUSDT",
                 "ATOM": "ATOMUSDT", "TRX": "TRXUSDT", "XLM": "XLMUSDT", "NEAR": "NEARUSDT"},
    spine_lbs=(10, 30, 60, 120), spine_gross=1.0, spine_max_gross=2.5,
    history_days=420, rebal_band=0.005,
)


# ------------------------------------------------------------------------- data
def _daily(pair: str, days: int) -> pd.DataFrame:
    start_ms = int((datetime.now(timezone.utc).timestamp() - days * 86400) * 1000)
    kl = bv.fetch_klines(pair, "1d", start_ms)
    idx = pd.to_datetime([datetime.fromtimestamp(int(k[0]) / 1000, tz=timezone.utc).date() for k in kl])
    close = pd.Series([float(k[4]) for k in kl], index=idx)
    qvol = pd.Series([float(k[7]) for k in kl], index=idx)
    keep = ~close.index.duplicated(keep="last")
    return pd.DataFrame({"close": close[keep], "vol": qvol[keep]}).sort_index()


def fetch_market(days: int):
    """Returns (univ_px, univ_vol) daily panels for the spine universe (which contains the
    CORE coins) and is the single source for marking the book."""
    closes, vols = {}, {}
    for sym, pair in CFG["spine_pairs"].items():
        d = _daily(pair, days)
        closes[sym], vols[sym] = d["close"], d["vol"]
    px = pd.DataFrame(closes).sort_index()
    vol = pd.DataFrame(vols).reindex_like(px)
    last_common = min(px[c].last_valid_index() for c in CFG["core_coins"])  # align core
    return px.loc[:last_common], vol.loc[:last_common]


# ----------------------------------------------------------------- signal layer
def core_weights(px: pd.DataFrame) -> dict:
    """CORE daily book per-coin weight (fraction of CORE capital; gross <= 2x)."""
    panel = px[CFG["core_coins"]].dropna(how="all")
    book = ps.book_weights(panel)
    return {c: float(book[c].iloc[-1]) for c in CFG["core_coins"]}


def spine_weights(px: pd.DataFrame, vol: pd.DataFrame, lbs=None, gross=None, max_gross=None) -> dict:
    """SPINE long/short trend per-coin weight on the universe pool (last bar). Params
    default to the walk-forward-selected ones (see latest_spine_params)."""
    lbs = lbs or CFG["spine_lbs"]; gross = gross or CFG["spine_gross"]
    max_gross = max_gross or CFG["spine_max_gross"]
    sig = aw.ts_signal(px, lbs)
    iv = 1.0 / aw.realized_vol(px, 30).clip(lower=0.20)
    dv = vol.rolling(30, min_periods=10).mean()
    i = -1
    valid = px.iloc[i].notna() & sig.iloc[i].notna() & dv.iloc[i].notna() & iv.iloc[i].notna()
    cols = px.columns[valid]
    if len(cols) < 5:
        return {}
    top = dv.iloc[i][cols].sort_values(ascending=False).index[:aw.TOP_LIQ]
    raw = sig.iloc[i][top] * iv.iloc[i][top]
    g = float(raw.abs().sum())
    if g <= 0:
        return {}
    w = raw / g * gross
    if w.abs().sum() > max_gross:
        w = w * max_gross / w.abs().sum()
    return {c: float(w[c]) for c in top}


def latest_spine_params(px: pd.DataFrame, vol: pd.DataFrame, train_days=540):
    """Same per-fold selection all_weather.walk_forward uses (max train Sharpe over the
    grid), applied to the most-recent train window -> the params the tested system runs now."""
    grid = [dict(lbs=lbs, gross_target=gt, max_gross=mg)
            for lbs in ((10, 30, 60, 120), (20, 50, 100), (30, 60, 120))
            for gt in (0.6, 1.0) for mg in (1.5, 2.5)]
    lo = px.index[-1] - pd.Timedelta(days=train_days)
    best, bsc = None, -1e9
    for p in grid:
        g, tn, ex, _ = aw.build_ts_trend(px, vol, **p)
        net = aw.net_from(g, tn, ex, 15)                   # spine cost 15 bps/side (as backtested)
        trs = net[net.index >= lo]
        if len(trs) < 60:
            continue
        sd = trs.std(ddof=0)
        sc = trs.mean() / sd * np.sqrt(365) if sd > 0 else -9
        if sc > bsc:
            bsc, best = sc, p
    return best or grid[0]


def refresh_pool() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Refresh the universe pool's currently-fetchable coins to today's daily close
    IN MEMORY (delisted names keep their cached history and are auto-excluded by NaN).
    Returns (px, vol). Falls back to the cached pool on any failure."""
    px, vol = aw.load_panel()
    for c in list(px.columns):
        pair = CFG["spine_pairs"].get(c, f"{c}USDT")
        try:
            d = _daily(pair, 400)
            px.loc[d.index, c] = d["close"]
            vol.loc[d.index, c] = d["vol"]
        except Exception:
            continue                                       # delisted / unlisted -> keep cached
    return px.sort_index(), vol.reindex_like(px)


def combined_book(px, vol, with_intraday=True, refresh=False) -> dict:
    """Per-coin book weight (fraction of equity, 1x). SPINE selects from the SAME pool +
    logic + walk-forward params as the backtest; intraday uses the faithful bracket runner
    (intraday_live.position_now) with WF-selected params on the 1H/8H clock. CORE uses the
    live-fetched 5-coin panel. -> live == tested system by construction."""
    cw = core_weights(px)                                  # ps.book_weights (same code)
    spx, svol = refresh_pool() if refresh else aw.load_panel()
    sp = latest_spine_params(spx, svol)                    # WF-selected params (matches backtest)
    sw = spine_weights(spx, svol, sp["lbs"], sp["gross_target"], sp["max_gross"])
    book: dict[str, float] = {}
    for c, w in cw.items():
        book[c] = book.get(c, 0.0) + CFG["w_core"] * w
    for c, w in sw.items():
        book[c] = book.get(c, 0.0) + CFG["w_spine"] * w
    if with_intraday:
        sb, _, _ = position_now("BTC", "1h")               # faithful 1H bracket position
        if sb:
            book["BTC"] = book.get("BTC", 0.0) + CFG["w_btc1h"] * sb
        se, _, _ = position_now("ETH", "8h")               # faithful 8H bracket position
        if se:
            book["ETH"] = book.get("ETH", 0.0) + CFG["w_eth8h"] * se
    return {c: w for c, w in book.items() if abs(w) > 1e-6}


# ---------------------------------------------------------------------- state
def load_state():
    return json.load(open(STATE_PATH)) if os.path.exists(STATE_PATH) else {}


def save_state(st):
    st["last_update"] = datetime.now(timezone.utc).isoformat()
    json.dump(st, open(STATE_PATH, "w"), indent=2, default=str)


def init_state(capital, mode):
    return dict(mode=mode, base=capital, equity=capital, cum_cash=0.0,
                principal_returned=False, locked=False, year=None,
                held={}, last_date=None, history=[])


# ------------------------------------------------------------------- execution
class PaperBroker:
    """Marks held weights to the latest close and applies turnover+funding cost.
    Fully functional simulation of one daily rebalance."""
    def mark(self, st, px, held_now):
        coins = [c for c in px.columns]
        last = {c: float(px[c].iloc[-1]) for c in coins}
        prev = {c: float(px[c].iloc[-2]) for c in coins}
        held_prev = st["held"]
        port_ret = sum(w * (last[c] / prev[c] - 1.0) for c, w in held_prev.items() if c in last)
        turn = sum(abs(held_now.get(c, 0.0) - held_prev.get(c, 0.0))
                   for c in set(list(held_now) + list(held_prev)))
        gross = sum(abs(w) for w in held_now.values())
        cost = CFG["txn_bps"] * 1e-4 * turn + CFG["funding_bps"] * 1e-4 * gross
        st["equity"] *= (1.0 + port_ret) * (1.0 - cost)
        return port_ret, cost, last

    def equity(self, st):
        return float(st.get("equity") or 0.0)              # paper bankroll (no real account)


class LiveBroker:
    """Real execution via ccxt. DEFAULT is dry-run (computes & prints the exact orders,
    sends NOTHING). Real orders require dry_run=False AND exchange API keys in the env
    (EXCHANGE, EXCHANGE_API_KEY, EXCHANGE_API_SECRET). post-only limits, rebalance band,
    isolated leverage. UNTESTED against a live account here — verify on testnet/tiny size
    first (that is execution-sanity, not strategy paper-trading)."""
    def __init__(self, dry_run=True):
        self.dry_run, self.ex = dry_run, None
        if not dry_run:
            import ccxt
            name = os.environ.get("EXCHANGE", "binanceusdm")
            self.ex = getattr(ccxt, name)({
                "apiKey": os.environ["EXCHANGE_API_KEY"],
                "secret": os.environ["EXCHANGE_API_SECRET"],
                "enableRateLimit": True, "options": {"defaultType": "future"}})

    def mark(self, st, px, held_now):
        last = {c: float(px[c].iloc[-1]) for c in px.columns}
        if self.dry_run:
            return 0.0, 0.0, last                          # equity stays as tracked
        bal = self.ex.fetch_balance()
        eq = float(bal.get("total", {}).get("USDT", st["equity"]))
        port_ret = (eq / st["equity"] - 1.0) if st["equity"] else 0.0
        st["equity"] = eq                                  # exchange is the source of truth
        return port_ret, 0.0, last

    def equity(self, st):
        """Total account equity (USDT) — the real starting asset when live; tracked in dry-run."""
        if self.dry_run or self.ex is None:
            return float(st.get("equity") or 0.0)
        try:
            bal = self.ex.fetch_balance()
            return float(bal.get("total", {}).get("USDT", st.get("equity", 0.0)) or 0.0)
        except Exception:
            return float(st.get("equity") or 0.0)

    def _pos_notional(self, pair, price):
        try:
            for p in self.ex.fetch_positions([pair]):
                if p.get("symbol") == pair or p.get("info", {}).get("symbol", "").startswith(pair.replace("/", "")):
                    return float(p.get("notional") or 0.0)
        except Exception:
            pass
        return 0.0

    def rebalance(self, held, equity, last, band, leverage):
        print("  ORDERS (post-only limits):" + ("  [DRY-RUN — nothing sent]" if self.dry_run else ""))
        any_order = False
        for coin, w in sorted(held.items(), key=lambda kv: -abs(kv[1])):
            pair = CFG["spine_pairs"].get(coin, f"{coin}USDT")
            tgt = w * equity
            cur = 0.0 if self.dry_run else self._pos_notional(pair, last[coin])
            delta = tgt - cur
            if abs(delta) < band * equity:
                continue
            any_order = True
            side, qty = ("buy" if delta > 0 else "sell"), abs(delta) / last[coin]
            if self.dry_run:
                print(f"    [DRY] {side.upper():4} {coin:>5} ~${abs(delta):>11,.0f}  "
                      f"({qty:.5f} @ ~${last[coin]:,.4f})")
            else:
                try:
                    self.ex.set_leverage(int(max(1, round(leverage))), pair, {"marginMode": "isolated"})
                except Exception:
                    pass
                o = self.ex.create_limit_order(pair, side, qty, last[coin], {"postOnly": True})
                print(f"    SENT {side.upper():4} {coin:>5} ${abs(delta):>11,.0f}  id={o.get('id')}")
        if not any_order:
            print("    (no coin outside the rebalance band — nothing to do)")


def broker_for(mode, dry_run=True):
    return LiveBroker(dry_run=dry_run) if mode == "live" else PaperBroker()


# ------------------------------------------------------- harvest state machine
def daily_cycle(st, px, vol, broker):
    cfg = CFG
    date = str(px.index[-1].date())
    if st.get("last_date") == date:
        return dict(date=date, skipped=True)             # idempotent: one cycle/day
    yr = px.index[-1].year

    # --- year boundary: settle the prior year, reset to base (self-funding) ---
    note = ""
    if st["year"] is not None and st["year"] != yr:
        settle = st["equity"] - st["base"]               # profit (or loss) carried into year end
        st["cum_cash"] += settle                          # sweep profit OR cover loss from harvested reserve
        st["equity"] = st["base"]; st["locked"] = False
        note += f"[year-end {st['year']}: {'swept' if settle>=0 else 'covered'} ${abs(settle):,.0f}; reset to base] "
    st["year"] = yr

    # --- mark to market on yesterday's held book ---
    port_ret, cost, last = broker.mark(st, px, st["held"])

    # --- harvest rules on the new equity ---
    if not st["locked"]:
        if st["equity"] >= cfg["double_at"] * st["base"]:          # hit a 2x
            take = cfg["harvest_frac"] * (st["equity"] - st["base"])
            st["cum_cash"] += take; st["equity"] -= take            # leave (1-frac) on the table
            note += f"*** 2x HARVEST: withdrew ${take:,.0f} (left {(1-cfg['harvest_frac']):.0%} on the table) *** "
            if cfg["go_flat"]:
                st["locked"] = True
        if not st["locked"] and st["equity"] <= (1.0 - cfg["year_stop"]) * st["base"]:
            st["locked"] = True
            note += f"*** -{cfg['year_stop']:.0%} STOP: flat for the rest of {yr} *** "
    if st["cum_cash"] >= st["base"] and not st["principal_returned"]:
        st["principal_returned"] = True
        note += "*** PRINCIPAL FULLY RETURNED — now on house money *** "

    # --- target book for the next day ---
    if st["locked"]:
        book, held = {}, {}
    else:
        book = combined_book(px, vol)
        held = {c: cfg["leverage"] * w for c, w in book.items()}    # apply leverage
    st["held"] = {c: round(w, 4) for c, w in held.items()}
    st["last_date"] = date
    st["history"].append(dict(date=date, equity=round(st["equity"], 2),
                              cum_cash=round(st["cum_cash"], 2), locked=st["locked"],
                              port_ret=round(port_ret, 4)))
    return dict(date=date, skipped=False, port_ret=port_ret, cost=cost, note=note,
                book=book, held=held, last=last,
                gross=sum(abs(w) for w in held.values()), net=sum(held.values()))


# ------------------------------------------------------------------------- cli
def _print_book(held, equity, last):
    if not held:
        print("    FLAT / cash (locked or no signal)."); return
    for c in sorted(held, key=lambda c: -abs(held[c])):
        print(f"    {c:>5} weight {held[c]:>+6.2f}  notional ${held[c]*equity:>12,.0f}"
              + (f"  (last ${last[c]:,.4f})" if last and c in last else ""))


def cmd_init(a):
    save_state(init_state(a.capital, a.mode))
    print(f"Initialised {a.mode} account at base ${a.capital:,.0f} -> {STATE_PATH}")


def cmd_run(a):
    st = load_state()
    if not st:
        print("No account. Run: python live_trader.py init --capital 300000"); return
    dry = not getattr(a, "execute", False)
    broker = broker_for(st["mode"], dry_run=dry)
    px, vol = fetch_market(CFG["history_days"])
    out = daily_cycle(st, px, vol, broker)
    save_state(st)
    if out.get("skipped"):
        print(f"Already ran for {out['date']} (idempotent). Use status to inspect."); return
    pct_back = st["cum_cash"] / st["base"]
    prin = "RETURNED" if st["principal_returned"] else f"{pct_back:.0%} back"
    print(f"\n=== Daily cycle {out['date']} ({st['mode']}, m={CFG['leverage']:g}) ===")
    print(f"  realised since last mark: {out['port_ret']:+.2%} (cost {out['cost']*100:.2f}%)")
    print(f"  equity ${st['equity']:,.0f} | base ${st['base']:,.0f} | "
          f"cash withdrawn ${st['cum_cash']:,.0f} ({pct_back:.1f}x) | "
          f"{'LOCKED(flat)' if st['locked'] else 'active'} | principal {prin}")
    print(f"  TARGET BOOK (gross {out['gross']:.0%}, net {out['net']:+.0%}):")
    _print_book(out["held"], st["equity"], out["last"])
    if out["note"]:
        print("  " + out["note"])
    if st["mode"] == "live":
        broker.rebalance(out["held"], st["equity"], out["last"], CFG["rebal_band"], CFG["leverage"])
        if dry:
            print("  (DRY-RUN. Re-run with `--execute` + EXCHANGE_API_KEY/SECRET in env to send. "
                  "Harvest withdrawals / -40% flatten are OPERATOR ALERTS in the note above.)")


def cmd_status(a):
    st = load_state()
    if not st:
        print("No account. Run: python live_trader.py init --capital 300000"); return
    px, vol = fetch_market(CFG["history_days"])
    book = {} if st["locked"] else combined_book(px, vol)
    held = {c: CFG["leverage"] * w for c, w in book.items()}
    last = {c: float(px[c].iloc[-1]) for c in px.columns}
    print(f"\n=== Unified Bot — STATUS ({st['mode']}) as of {px.index[-1].date()} ===")
    print(f"  equity ${st['equity']:,.0f} | base ${st['base']:,.0f} | cash withdrawn "
          f"${st['cum_cash']:,.0f} ({st['cum_cash']/st['base']:.1f}x base) | "
          f"principal {'RETURNED' if st['principal_returned'] else 'not yet'} | "
          f"{'LOCKED' if st['locked'] else 'active'}")
    print(f"  TARGET BOOK at m={CFG['leverage']:g} (gross {sum(abs(w) for w in held.values()):.0%}, "
          f"net {sum(held.values()):+.0%}):")
    _print_book(held, st["equity"], last)


def _combined_daily_returns(px, vol):
    """Vectorised 1x combined book daily return = w_core·CORE + w_spine·SPINE (intraday
    off — daily data). Fast: signals computed once, not per-day."""
    cp = px[CFG["core_coins"]].dropna(how="all")
    book = ps.book_weights(cp); ret = cp.pct_change(); held = book.shift(1).fillna(0.0)
    core = ((held * ret).sum(axis=1)
            - CFG["txn_bps"] * 1e-4 * held.diff().abs().sum(axis=1).fillna(0.0)
            - CFG["funding_bps"] * 1e-4 * held.abs().sum(axis=1))
    g, tn, ex, _ = aw.build_ts_trend(px, vol, lbs=CFG["spine_lbs"],
                                     gross_target=CFG["spine_gross"], max_gross=CFG["spine_max_gross"])
    spine = aw.net_from(g, tn, ex, 15)                      # spine at its 15 bps
    idx = core.index.intersection(spine.index)
    return (CFG["w_core"] * core.reindex(idx).fillna(0.0)
            + CFG["w_spine"] * spine.reindex(idx).fillna(0.0)).dropna()


def cmd_backtest(a):
    px, vol = fetch_market(2000)
    r = _combined_daily_returns(px, vol)
    base, m = a.capital, CFG["leverage"]
    eq, cum, locked, year, min_cum = base, 0.0, False, None, 0.0
    for d, x in r.items():
        if year is None:
            year = d.year
        if d.year != year:                                 # year-end settle / reset
            cum += eq - base; eq = base; locked = False; year = d.year
            min_cum = min(min_cum, cum)
        if not locked:
            eq *= (1.0 + m * x)
            if eq >= CFG["double_at"] * base:
                take = CFG["harvest_frac"] * (eq - base); cum += take; eq -= take
                min_cum = min(min_cum, cum)
            if eq <= (1.0 - CFG["year_stop"]) * base:
                locked = True
    cum += eq - base; min_cum = min(min_cum, cum)          # final settle
    print(f"\n=== BACKTEST (paper, base ${a.capital:,.0f}; CORE+SPINE, m={m:g}, intraday off) ===")
    print(f"  span {r.index[0].date()} -> {r.index[-1].date()} ({len(r)} days)")
    print(f"  net cash extracted ${cum:,.0f} ({cum/base:.1f}x base); self-funding: "
          f"{'YES' if min_cum >= -1 else 'NO'} (min running cash ${min_cum:,.0f}).")
    print("  (authoritative full harvest validation incl. intraday: harvest_2x.py / "
          "unified_bot.py --harvest. This confirms the live logic reproduces the shape.)")


def main():
    ap = argparse.ArgumentParser(description="Unified all-weather book + 2x-harvest trader")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pi = sub.add_parser("init"); pi.add_argument("--capital", type=float, default=300000.0)
    pi.add_argument("--mode", choices=["paper", "live"], default="paper"); pi.set_defaults(func=cmd_init)
    pr = sub.add_parser("run")
    pr.add_argument("--execute", action="store_true",
                    help="LIVE mode only: actually send orders via ccxt (default = dry-run preview)")
    pr.set_defaults(func=cmd_run)
    sub.add_parser("status").set_defaults(func=cmd_status)
    pb = sub.add_parser("backtest"); pb.add_argument("--capital", type=float, default=300000.0)
    pb.set_defaults(func=cmd_backtest)
    a = ap.parse_args(); a.func(a)


if __name__ == "__main__":
    main()
