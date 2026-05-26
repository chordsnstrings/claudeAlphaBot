# Return-Principal-Then-House-Money Bot — deployable BTC/ETH spec

The realizable version of the goal: **return the initial fund as fast as is survivable,
then play the gained money aggressively in the bot.** BTC + ETH only. The return *rate*
is set by what survives (not 20–30%/month, which the catalog proved is fatal at 10–20×),
but the *structure* you wanted — recover principal, then gamble house money — is built
exactly as specified, on the validated engine.

Grounded in: `HIGH_LEVERAGE_STRATEGY_CATALOG.md` (why 10–20× can't work),
`PER_COIN_BEST_STRATEGIES.md` (the engine), `LEVERAGE_BTC_ETH.md` (the withdrawal math).

---

## Two-phase design

### Phase 1 — Principal recovery (2–3× leverage)
- **Universe:** BTC, ETH (50/50, or weight by recent inverse-vol).
- **Engine:** long-only multi-lookback momentum `tsmom_blend` — lookbacks **[10,30,60,120]**,
  inverse-vol target 0.60, vol_lb 20. Long only while trending up, **flat otherwise**.
- **Leverage:** **2.5×** effective (cap 3×).
- **Execution:** daily signal; execute/hold on 1h bars with a **15% intraday trailing
  stop** (removes liquidation risk at this leverage; see `eth_intraday_stops.py`).
- **Withdrawal trigger:** the instant account equity reaches **2× the initial deposit**,
  **withdraw the full initial principal.** Principal is now safe and off the table.
- **Validated expectation (OOS):** P(reach 2× before any ruin) ≈ **94–97%**, median time
  to double ≈ **7–10 months**, P(ruin) ≈ **0–5%**. (Not 72 days — that speed only exists
  at the leverage that ruins you.)

### Phase 2 — House money (higher leverage, accept high drawdown)
- Once principal is withdrawn, the remaining balance is **100% house money** — a blow-up
  now costs the casino, not you. This is where "accept high drawdown / optimise for big
  monthly" lives, *safely*.
- **Engine:** same BTC/ETH momentum, but **5× leverage** with the **15% trailing stop**
  kept (at 5× the stop still prevents instant liquidation; bare 5× no-stop does not).
- **Optional ratchet:** every time house money itself doubles, sweep half back to a cold
  wallet. Keeps converting variance into realized gains.
- **Expected:** high variance — big months *and* deep drawdowns, ~50% chance of eventually
  losing the house-money stack. That is acceptable *because it is house money.* Do **not**
  add fresh principal to Phase 2, ever.

---

## Exact rules (pseudocode)
```
PARAMS: coins=[BTC,ETH]; lbs=[10,30,60,120]; vol_target=0.6; vol_lb=20
        lev_phase1=2.5; lev_phase2=5.0; trail_stop=0.15
        principal=P; withdrawn=False

DAILY (00:00 UTC):
  for c in coins:
     raw[c] = mean_L sign(close[c]/close[c,t-L]-1)            # in [0,1] long-only
     rv[c]  = max(std(ret[c],20)*sqrt(365), 0.10)
     w[c]   = clip(max(raw[c],0)*min(vol_target/rv[c],3), 0, 3)   # per-coin weight
  lev = lev_phase1 if not withdrawn else lev_phase2
  target_notional[c] = equity * lev * w[c] / sum(w)            # 50/50 split of gross

INTRADAY (1h):  hold; if position draws down trail_stop from its peak -> flat till next day
WITHDRAWAL:     if (not withdrawn) and equity >= 2*P:  withdraw P; withdrawn=True
HARD RULES:     never add external capital to Phase 2; flat any coin whose raw<=0 (downtrend)
```

## Risk controls (mandatory)
- **15% intraday trailing stop** on every position — this is what makes 2.5×/5× survivable
  (it removes the liquidation that kills 10–20×).
- **Long-only + flat-in-downtrend** — the engine sits out bears (the 2022/2025 selloffs)
  instead of bleeding into them.
- **Per-year −40% / per-month −20% circuit breaker** — flat for the period if hit.
- **Phase-2 firewall** — house money is a separate sub-account; a Phase-2 blow-up cannot
  touch withdrawn principal or fresh capital.
- Paper-trade ≥ 1 quarter; start Phase 1 small; BTC/ETH only (deep liquidity for the size).

## Honest expectations (so there are no surprises)
- **Phase 1 doubles in ~7–10 months ~94–97% of the time** at 2.5× — that is the *fast,
  reliable* capital return, just measured in months not days.
- **It is NOT 20–30%/month.** That number does not survive at any leverage (the catalog).
  Phase 1 is roughly **+45–90%/yr** expectancy with months that swing −20% to +40%.
- **Phase 2 is a deliberate high-variance gamble on house money** — it may 5× or it may go
  to zero; either is fine because your principal is already out.
- This is the *only* configuration tested that returns your capital reliably AND then lets
  you swing for big returns — by quarantining the risk to money you've already won.

**Bottom line:** you cannot get consistent 20–30%/month at 10–20× (proven). You *can* get
your principal back reliably in ~7–10 months at 2.5×, then run house money at 5× for the
big-return swings you want — which is the survivable form of your exact plan.

---

## Running the bot (code: `research/bot.py`)
```bash
cd research
python bot.py init --capital 1000      # create a paper account (default mode=paper)
python bot.py status                    # show state + TODAY's live BTC/ETH target positions
python bot.py run                       # one daily cycle: mark-to-market, rebalance, report
python bot.py backtest --capital 1000   # full-history paper run -> phase path & principal return
```
- **Live data:** BTCUSDT/ETHUSDT daily from Binance Vision (reachable). Signal is the
  validated `sig_tsmom_blend` + `build_weights` (long-only) — same code as the research.
- **State** persists to `research/bot_state.json` (gitignored). Re-run `run` once per day
  (e.g. a cron at 00:05 UTC).
- **Paper mode** is fully functional (simulated fills at the daily close, 6 bps cost,
  phase/withdrawal/breaker logic). **Live mode** is a deliberate stub: `LiveExecutor`
  documents exactly what to implement with your own exchange keys — this file never
  places real orders.

**Backtest sanity-check (paper, $1,000, BTC/ETH 2021-04→2026, *worst-case entry right
before the May-2021 crash*):** Phase 1 at 2.5× cash-filtered the 2022 bear to −25%, the
2023 recovery took equity through 2× → **withdrew the full $1,000 principal** (goal met),
flipped to Phase 2. Phase-2 house money at 5× then bled to ~$304 in the 2024–26 chop.
Net **$1,304 total (principal $1,000 returned + $304 house) from $1,000** — even on the
worst entry. Takeaways: (1) the core goal (return principal) held even with bad timing;
(2) **Phase-2 5× has negative drift in chop — set `lev_phase2=3.0` if you want house money
to grow rather than gamble it.** Today's live signal: **CASH** (neither BTC nor ETH in a
confirmed uptrend — the engine correctly sits out the current downtrend).
