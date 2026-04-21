# Crypto Perpetual Futures Trading Bot — Complete Build Specification

## 0. How to Read This Document

This is a complete specification for building a systematic trading bot. Every rule, threshold, formula, and edge case is defined. No prior context is needed. You (the implementer) choose the tech stack, libraries, and architecture.

- All times are UTC unless otherwise specified
- All prices in USD (or USDT)
- All percentages are expressed as percentages (e.g., 2% = 2.0, not 0.02) unless the formula explicitly shows division by 100
- When this spec says "SKIP", it means do not take the trade and log the reason

The bot trades four session-based strategies plus an optional fifth (mean reversion). Build in the order listed in Section 10.

---

## 1. System Overview

### 1.1 What the bot does
- Trades on **1-hour timeframe** (primary)
- Trades three perpetual futures: **BTCUSDT, ETHUSDT, SOLUSDT**
- Exchange: **Binance Futures**
- Four time-based strategies + one optional technical strategy
- Enforces strict risk management and circuit breakers
- Runs 24/7 automated

### 1.2 Three operational modes

**Backtest mode:** Replay historical candles from local database, simulate fills, produce performance metrics. Used for strategy validation before any deployment.

**Paper trading mode:** Stream real-time candles from exchange public feeds, run identical decision logic as live, simulate fills against incoming prices, record all trades to database. **No exchange connection for orders, no real capital.** Runs indefinitely as a shadow/dev environment.

**Live trading mode:** Stream real-time candles, place real orders on Binance Futures, manage real positions with real capital.

**All three modes use identical decision logic.** Only the execution layer differs:
- Backtest: synthesized fills against historical OHLC
- Paper: synthesized fills against live streaming prices
- Live: actual exchange orders and fills

This is a hard architectural requirement. If the three modes diverge in decision logic, you get different results in live than backtest, making the backtest worthless.

**Deployment sequence (ENFORCED, not optional):**

The system must enforce this sequence. There is no "deploy directly" path. Every deployment — paper or live — must reference a specific completed backtest run that passed all acceptance criteria.

```
[1] Run backtest with parameter sweep (ranges defined in config)
         │
         ▼
[2] Run Monte Carlo simulation on the backtest results
         │
         ▼
[3] Run walk-forward validation on the best parameter set
         │
         ▼
[4] Automatically select the "best performing" parameter set
    based on objective criteria (see Section 8.11)
         │
         ▼
[5] System produces a deployable artifact: validated_config.json
    containing the winning parameters + validation metrics
         │
         ▼
[6] Operator invokes deploy command with validated_config.json
         │
         ▼
[7] Deploy to paper mode OR live mode (operator's choice at this point)
```

**Hard rules the system enforces:**
- No deployment without a `validated_config.json` that was produced by the validation pipeline
- The artifact must contain a hash/checksum of the exact code version used during backtest (prevents drift between tested code and deployed code)
- Artifact must be less than 30 days old (stale validations re-run before deploying)
- If any validation step failed, the artifact is not created — deployment is impossible

### 1.3 The five strategies

| # | Strategy | Time Window | Frequency | Priority |
|---|---|---|---|---|
| A | Asian Range Breakout | 07:00–11:00 UTC | ~1/symbol/day max | Build first |
| B | NY Open Momentum | 13:00–15:00 UTC | ~1/symbol/day max | Build second |
| C | Weekend Mean Reversion | Monday 00:00 UTC | ~1/symbol/week max | Build third |
| D | Funding Settlement Fade | 00:00, 08:00, 16:00 UTC | Up to 3/symbol/day | Build fourth |
| E | Bollinger Band Mean Reversion | Any hour | Variable | Optional, build last |

---

## 2. STRATEGY A: Asian Range Breakout (ARB)

### 2.1 Plain-English description
During Asian hours (00:00–07:00 UTC), crypto tends to trade in a compressed range because Asian session volume is lower than European or American sessions. When London traders become active around 07:00 UTC, they frequently break this range with momentum. We trade the first genuine breakout with volume confirmation.

### 2.2 Entry logic — step by step

**Step 1: Wait for Asian session to complete**
- Asian session = candles with open time between 00:00 UTC and 06:59 UTC (7 hourly candles for the day)
- Once 07:00 UTC has passed, the Asian range is "locked in"
- Record the session's highest high, lowest low, opening price, and total volume

**Step 2: Calculate the range size**
```
asian_range_pct = (asian_high - asian_low) / asian_open * 100
```

**Step 3: Apply range-quality filter**
- If `asian_range_pct < 0.4`: SKIP — too tight, likely fake breakout
- If `asian_range_pct > 2.5`: SKIP — already trending, not compressing
- Otherwise: proceed

**Step 4: Monitor breakout window (07:00 UTC to 10:59 UTC inclusive)**

For each 1-hour candle that CLOSES in this window:
- If `candle.close > asian_high`: candidate LONG breakout
- If `candle.close < asian_low`: candidate SHORT breakout

**Step 5: Require first breakout only**
- Look at every candle from 07:00 UTC to just before the current candle
- If any earlier candle already closed beyond the range: SKIP
- This ensures we only trade the first break, not re-breaks

**Step 6: Volume confirmation**
- Calculate average volume of the previous 20 one-hour candles (excluding current)
- If current candle's volume < `1.3 × average_volume`: SKIP

**Step 7: Weekend filter**
- If current day is Saturday or Sunday (UTC): SKIP
- London session thin on weekends, signals less reliable

**Step 8: Existing position check**
- If you already have an open position on this symbol: SKIP (no pyramiding)

If all 8 steps pass: GENERATE SIGNAL.

### 2.3 Exit logic

**Calculate stop loss:**
1. Compute ATR(14) using the Wilder smoothing method on last 14+ candles
2. For LONG: `stop_price = asian_low − (0.5 × ATR14)`
3. For SHORT: `stop_price = asian_high + (0.5 × ATR14)`

**Calculate risk distance:**
```
risk_distance = abs(entry_price - stop_price)
```

**Calculate take profits:**
- **TP1** (close 50% of position) at `entry ± 1.5 × risk_distance`
- **TP2** (close remaining 50%) at `entry ± 3.0 × risk_distance`

For LONG: TP1 = entry + 1.5×RD, TP2 = entry + 3.0×RD
For SHORT: TP1 = entry − 1.5×RD, TP2 = entry − 3.0×RD

**Breakeven stop movement:**
- When price reaches `entry ± 1.0 × risk_distance` in favor (i.e., +1R profit)
- Move stop from its original level to entry price
- This protects the remaining 50% from turning into a loss after TP1 hits

**Time stop:**
- If neither TP nor SL hit by 20:00 UTC same day: close at market
- No exceptions — don't hold overnight from an ARB trade

### 2.4 Complete worked example

**Setup:** Tuesday, October 15, 2024. Account equity $5,000. Trading BTCUSDT.

**Asian session (00:00–06:59 UTC) summary:**
- Open (00:00): $67,200
- Highest high: $67,450
- Lowest low: $66,900
- Range: ($67,450 − $66,900) / $67,200 = **0.82%** — passes filter (0.4 < 0.82 < 2.5) ✓

**At 08:00 UTC, the candle 07:00–08:00 UTC closes at $67,520:**
- $67,520 > $67,450 → LONG breakout candidate ✓
- Previous 20-candle avg volume: 5,200 BTC. This candle: 8,500 BTC. Ratio: 1.63 ≥ 1.3 ✓
- Earlier candle (07:00–08:00 was the first hour of window — nothing earlier) ✓
- Not weekend ✓
- No existing BTC position ✓

**SIGNAL: LONG at $67,520**

**Calculate ATR(14):** $420 (hypothetical)

**Stop:** $66,900 − (0.5 × $420) = **$66,690**
**Risk distance:** $67,520 − $66,690 = **$830**

**TP1:** $67,520 + (1.5 × $830) = **$68,765** (close 50%)
**TP2:** $67,520 + (3.0 × $830) = **$70,010** (close 50%)
**Breakeven trigger:** when BTC touches $68,350, move stop to $67,520
**Time stop:** Oct 15, 2024 at 20:00:00 UTC

**Position sizing** (see Section 6 for full math):
- Risk in USD: 2% × $5,000 = **$100**
- Position quantity: $100 / $830 = **0.1205 BTC**
- Notional: 0.1205 × $67,520 = **$8,136**
- Margin at 20x leverage: $8,136 / 20 = **$407** locked up

**Possible outcomes:**
- Full win (both TPs hit): +$75 + $150 = **+$225 gross** (~$215 net of fees)
- Partial win (TP1 hit, breakeven stop on rest): **+$75 gross** (~$68 net)
- Full loss (stop hit before TP1): **−$100 gross** (~−$108 net)

---

## 3. STRATEGY B: NY Open Momentum

### 3.1 Plain-English description
Between 13:00 and 13:30 UTC, the New York stock market opens. This drives the largest volume spike of the crypto trading day. We define a "pre-NY range" during 11:00–13:00 UTC, then trade the breakout during the first two hours of NY session (13:00–15:00 UTC).

### 3.2 Entry logic — step by step

**Step 1: Wait for pre-NY range to complete**
- Pre-NY window = candles with open time between 11:00 UTC and 12:59 UTC (2 hourly candles)
- Record high, low, and open during this 2-hour window

**Step 2: Calculate range**
```
pre_range_pct = (pre_high - pre_low) / pre_open * 100
```

**Step 3: Range-quality filter**
- If `pre_range_pct < 0.3`: SKIP
- If `pre_range_pct > 2.0`: SKIP
- Otherwise: proceed

**Step 4: Monitor breakout window (13:00 UTC to 14:59 UTC)**
- Same logic as ARB: close beyond pre-range triggers signal

**Step 5: First breakout only** (same as ARB Step 5)

**Step 6: Volume confirmation**
- Current candle volume must be ≥ `1.4 × 20-candle average`
- Note: stricter than ARB (1.4 vs 1.3) because NY open has naturally higher baseline volume

**Step 7: Weekend filter** (skip Sat/Sun UTC)

**Step 8: Existing position check**

### 3.3 Exit logic

**Stop:**
- LONG: `stop_price = pre_low − (0.4 × ATR14)`
- SHORT: `stop_price = pre_high + (0.4 × ATR14)`

Note: Stop buffer tighter than ARB (0.4 vs 0.5) because NY breakouts are higher-conviction and we don't need as much whipsaw protection.

**Targets:**
- TP1 at `entry ± 1.5 × risk_distance` (close 50%)
- TP2 at `entry ± 2.5 × risk_distance` (close 50%)

Note: TP2 tighter than ARB (2.5 vs 3.0) because NY momentum fades faster than London momentum.

**Breakeven:** move stop to entry at 1.0R profit (same as ARB)

**Time stop:** close at 20:00 UTC same day

### 3.4 Worked example

**Setup:** Wednesday, October 16, 2024. Account equity $5,180 (after previous ARB win). ETHUSDT.

**Pre-NY window (11:00–13:00 UTC):**
- Open: $2,612
- High: $2,620
- Low: $2,595
- Range: $25 / $2,612 = **0.96%** — passes filter ✓

**At 14:00 UTC, the candle 13:00–14:00 UTC closes at $2,590:**
- $2,590 < $2,595 → SHORT breakout ✓
- Volume: 45,000 ETH vs 20-candle avg 28,000. Ratio 1.61 ≥ 1.4 ✓

**SIGNAL: SHORT at $2,590**

**ATR(14): $12**

**Stop:** $2,620 + (0.4 × $12) = **$2,624.80**
**Risk distance:** $34.80

**TP1:** $2,590 − (1.5 × $34.80) = **$2,537.80** (close 50%)
**TP2:** $2,590 − (2.5 × $34.80) = **$2,503.00** (close 50%)
**Breakeven trigger:** when ETH drops to $2,555.20, move stop to $2,590
**Time stop:** Oct 16, 2024 at 20:00 UTC

**Sizing:**
- Risk: 2% × $5,180 = $103.60
- Quantity: $103.60 / $34.80 = **2.977 ETH**
- Notional: $7,710
- Margin at 20x: $385

---

## 4. STRATEGY C: Weekend Mean Reversion

### 4.1 Plain-English description
Crypto trades 24/7 but weekend volume is dramatically lower (60-70% less than weekdays). Large moves during the weekend are often driven by thin liquidity rather than real flow. When Asia opens on Monday with full liquidity, these weekend moves frequently reverse. We fade extreme weekend moves at the Monday open.

### 4.2 Entry logic

**Step 1: Record Friday close**
- At 23:59:59 UTC on Friday, record each symbol's closing price as `friday_close`

**Step 2: Track weekend extremes**
- Saturday 00:00 UTC through Sunday 23:59 UTC
- For each symbol: record `weekend_high` and `weekend_low`
- Record `sunday_close` at Sunday 23:59 UTC

**Step 3: At Monday 00:00 UTC, evaluate**
```
weekend_move_pct = (sunday_close - friday_close) / friday_close * 100
```

**Step 4: Signal conditions**
- If `weekend_move_pct > +3.0`: take SHORT signal (fade the pump)
- If `weekend_move_pct < −3.0`: take LONG signal (fade the dump)
- Otherwise: SKIP (move was not extreme enough)

**Step 5: Additional filter**
- If the Monday 00:00 UTC candle's opening price is more than 1% beyond `sunday_close`: SKIP (gap risk, thin liquidity persists)

### 4.3 Exit logic

**Entry price:** Monday 00:00 UTC candle open price

**Stop:**
- SHORT (fading a pump): `stop = weekend_high × 1.005` (0.5% above weekend high)
- LONG (fading a dump): `stop = weekend_low × 0.995` (0.5% below weekend low)

**Target 1** (close 70% of position): 50% retracement of the weekend move
```
target1_short = friday_close + 0.5 × (sunday_close - friday_close)  // if sunday > friday
target1_long  = friday_close + 0.5 × (sunday_close - friday_close)  // if sunday < friday (will be below friday)
```

**Target 2** (close remaining 30%): `friday_close` (full retracement)

**Breakeven:** after 1R profit, move stop to entry

**Time stop:** Tuesday 08:00 UTC (32 hours after entry)

### 4.4 Worked example

**Setup:** ETHUSDT weekend of Oct 12-13, 2024.
- Friday Oct 11 close (23:59 UTC): $2,600
- Saturday-Sunday extremes: high $2,720, low $2,580
- Sunday Oct 13 close (23:59 UTC): $2,705

**Calculation:**
- Weekend move: ($2,705 − $2,600) / $2,600 = **+4.04%**
- 4.04% > 3.0% → SHORT signal ✓

**At Monday Oct 14 00:00 UTC:** ETH opens at $2,706.

- Not a gap (opened within 1% of $2,705) ✓

**Entry:** $2,706
**Stop:** $2,720 × 1.005 = **$2,733.60**
**Risk distance:** $27.60
**Target 1:** $2,600 + 0.5 × ($2,705 − $2,600) = **$2,652.50** (close 70%)
**Target 2:** **$2,600** (close 30%)
**Time stop:** Tuesday Oct 15 at 08:00 UTC

---

## 5. STRATEGY D: Funding Settlement Fade

### 5.1 Plain-English description
Binance perpetual futures settle funding payments every 8 hours (00:00, 08:00, 16:00 UTC). When funding is extreme, it indicates crowded positioning. After settlement, the crowded side often moves against them as leveraged positions unwind. We fade extreme funding after settlement.

### 5.2 Data requirements
Funding rate history must be fetched separately from candles:
- Binance endpoint: `/fapi/v1/fundingRate`
- Rates published every 8 hours
- Store with timestamp for lookup during backtest

### 5.3 Entry logic

**At each settlement time (00:00, 08:00, 16:00 UTC):**

**Step 1: Check funding rate**
- Retrieve the funding rate that just settled
- If `abs(funding_rate) < 0.0005` (i.e., less than 0.05%): SKIP
- Otherwise: proceed

**Step 2: Determine direction**
- If `funding_rate > +0.0005` (positive funding): longs are paying heavily → crowded long → SHORT signal
- If `funding_rate < −0.0005` (negative funding): shorts are paying → crowded short → LONG signal

**Step 3: Wait for confirmation**
- Do NOT enter immediately at settlement time (too much noise)
- Wait 30 minutes after settlement
- Check that price has moved in our favor by at least 0.2%
  - For SHORT signal: price should be lower than settlement price by 0.2%+
  - For LONG signal: price should be higher than settlement price by 0.2%+
- If no confirmation: SKIP

**Step 4: Minimum account equity filter**
- If account equity < $3,000: SKIP this strategy entirely (position sizes too small relative to stop distance)

**Step 5: Max trades per day**
- Maximum 3 trades per symbol per day from this strategy (one per settlement)

### 5.4 Exit logic

**Entry price:** price at confirmation time (30 min post-settlement)

**Stop:** fixed percentage (not ATR-based, because this strategy targets a specific dynamic, not technical structure)
- LONG: `stop = entry × 0.992` (0.8% below entry)
- SHORT: `stop = entry × 1.008` (0.8% above entry)

**Target:** fixed 1.5% move in favor
- LONG: `target = entry × 1.015`
- SHORT: `target = entry × 0.985`

Close 100% at target (no scaling for this strategy — it's a short-duration momentum-against-crowd trade).

**Breakeven:** move stop to entry after +0.8% favorable move (1R).

**Time stop:** next funding settlement (8 hours after entry). Close at market regardless of P&L.

### 5.5 Worked example

**Setup:** BTCUSDT at 16:00 UTC settlement on Oct 20, 2024.
- Funding rate settled: +0.08% (highly positive, longs paying)
- Price at 16:00 UTC: $67,800
- 0.08% > 0.05% → SHORT candidate ✓

**Wait 30 minutes. At 16:30 UTC:**
- BTC price: $67,650
- Move: ($67,650 − $67,800) / $67,800 = −0.22% (in favor of SHORT) ✓
- Confirmation achieved

**Entry:** $67,650
**Stop:** $67,650 × 1.008 = **$68,191** (risk $541)
**Target:** $67,650 × 0.985 = **$66,635** (reward $1,015)
**Risk/reward:** 1.88 (TP is 1.88× the risk)
**Time stop:** Oct 20, 2024 at 24:30 UTC (next settlement at 00:00 + 30 min buffer)

---

## 6. Risk Management (ALL Strategies)

### 6.1 Per-trade risk
```
risk_per_trade_usd = account_equity × 0.02
```
Example: $5,000 equity → $100 max loss per trade.

### 6.2 Position sizing formula (for stop-based strategies A, B, C, E)
```
stop_distance = abs(entry_price - stop_price)
position_notional = risk_per_trade_usd / (stop_distance / entry_price)
position_quantity = position_notional / entry_price
margin_required_at_20x = position_notional / 20
```

### 6.3 Position sizing for Strategy D (fixed-percentage stop)
```
position_notional = risk_per_trade_usd / 0.008   // 0.8% stop
position_quantity = position_notional / entry_price
```

### 6.4 Leverage setting
- Set exchange leverage to **20x** for BTC, ETH, SOL
- This is the capital efficiency setting, not the risk knob
- Actual risk is determined by position size × stop distance
- Never adjust leverage dynamically — always size via quantity

### 6.5 Exposure caps
- **Max total notional across all positions:** `2.5 × account_equity`
- **Max positions per correlation bucket:** 2 (BTC/ETH/SOL are ONE bucket)
- **Max total open positions:** 3

When a new signal would exceed caps:
- Calculate remaining headroom: `headroom = (2.5 × equity) − sum(open_notionals)`
- If `desired_notional ≤ headroom`: enter at full size
- If `desired_notional > headroom`:
  - If `headroom / desired_notional ≥ 0.2`: enter at partial size equal to headroom
  - If `headroom / desired_notional < 0.2`: REJECT trade (not worth it)

### 6.6 Minimum notional
Binance requires ≥$5 notional per order. If calculated position would fall below this: SKIP trade.

---

## 7. Circuit Breakers

### 7.1 Daily loss cap
- Threshold: **−5% daily P&L** (measured in UTC day)
- When triggered:
  1. Immediately close all open positions at market
  2. Block all new entries until 00:00 UTC next calendar day
  3. Log event with full account state

### 7.2 Weekly loss cap
- Threshold: **−12% weekly P&L** (ISO week starting Monday 00:00 UTC)
- When triggered:
  1. Close all open positions at market
  2. **Full system halt** — requires manual reset by operator
  3. Log event, send alert

### 7.3 Consecutive loss cooldown
- Track consecutive stop-outs per symbol
- At **3 consecutive losses on same symbol**:
  1. Block new entries on that symbol for **12 hours**
  2. Other symbols continue trading normally
  3. Counter resets after first win on that symbol
- Only "stopped out" trades count (TP1-only exits do not increment)

### 7.4 Pre-trade check order
Before any order, check in this exact order. Block if any fail:
1. System halted manually? → block
2. Daily P&L ≤ −5%? → block
3. Weekly P&L ≤ −12%? → block
4. This symbol in 12h cooldown? → block
5. Existing open position on this symbol? → block
6. Max 3 total positions already? → block
7. Exposure caps → scale or block

---

## 8. Backtest Engine Specification

### 8.1 Purpose
Replay historical candles through the exact same decision logic used live, simulate realistic fills, and produce performance metrics. The backtest tells you whether the system has a real edge before risking capital.

### 8.2 Data requirements

**Historical candles needed:**
- 1-hour klines for BTCUSDT, ETHUSDT, SOLUSDT (Binance Futures perpetuals)
- Minimum **18 months** of history
- Source: Binance public REST API (free)
- Fields per candle: open_time (epoch ms), open, high, low, close, volume, close_time

**Fetching procedure:**
1. Binance limits single API call to 1000 candles
2. 18 months ≈ 13,000 hourly candles per symbol
3. Paginate with 100ms delays between calls
4. Store raw data locally (file or database)
5. Validate: no unexpected gaps, consistent hourly intervals
6. If gap > 1 hour detected: re-fetch that range

**Funding rate history:**
- Endpoint: `/fapi/v1/fundingRate` (public)
- Published every 8 hours
- Fetch full history for each symbol
- Store with timestamp for point-in-time lookup

### 8.3 Backtest replay engine — step by step

**Step 1: Load and prepare data**
- Load all candles into memory, sorted by timestamp
- Load funding history for Strategy D
- Verify no gaps

**Step 2: Initialize simulated account**
```
account = {
  equity: 5000.00,
  starting_equity: 5000.00,
  open_positions: [],
  daily_pnl_by_utc_date: {},
  weekly_pnl_by_iso_week: {},
  consecutive_losses_by_symbol: { BTC: 0, ETH: 0, SOL: 0 },
  cooldown_until_by_symbol: { BTC: 0, ETH: 0, SOL: 0 },
  halted: false,
  trade_log: []
}
```

**Step 3: Main replay loop**

For each unique timestamp T in the timeline (hourly steps from earliest to latest):

  **Phase 1: Update open positions**
  - For each open position, check if stop/TP/time_stop was hit during the candle at time T
  - If hit: close position, record trade, update account state
  - See Section 8.4 for exit simulation details

  **Phase 2: Evaluate entries**
  - For each symbol in [BTC, ETH, SOL]:
    - Get all candles for this symbol with open_time ≤ T (CRITICAL: never access future data)
    - For each strategy enabled (A, B, C, D):
      - Run strategy detection logic with the current candles
      - If signal generated:
        - Run pre-trade checks (Section 7.4)
        - If passes: calculate position size, simulate fill, open position
        - Log decision regardless of outcome

  **Phase 3: Update circuit breaker state**
  - Reset daily P&L at each new UTC date
  - Reset weekly P&L at each new ISO Monday
  - Check if any breaker should trigger

### 8.4 Order fill simulation

**Entry fills:**
- Assumed fill price = candle close price (for market orders)
- Apply slippage: multiply entry by `(1 + 0.0002)` for BUY, `(1 − 0.0002)` for SELL
- That's 2 basis points = 0.02% slippage
- Apply taker fee: notional × 0.0004 (0.04% Binance Futures taker)
- Deduct fees from account equity on entry

**Exit fill simulation:**
Check the NEXT candle (time T+1) after entry to determine if stops/TPs were hit:

```
if direction == LONG:
    if next_candle.low <= stop_price:
        exit_reason = "STOP"
        exit_price = stop_price × (1 - 0.0002)  // slippage against us
    elif next_candle.high >= tp2_price:
        // Both TP1 and TP2 hit if high ≥ TP2
        // Conservative: assume TP1 hit first, then TP2
        exit_reason = "TP2"
        exit_price_50pct = tp1_price × (1 - 0.0002)
        exit_price_50pct = tp2_price × (1 - 0.0002)
    elif next_candle.high >= tp1_price:
        exit_reason = "TP1"
        exit_price_50pct = tp1_price × (1 - 0.0002)
        // Rest stays open, stop moves to entry (breakeven)
    else:
        // Check subsequent candles in same way
        continue checking until time_stop reached
```

**CRITICAL rules:**
- If BOTH stop and TP hit in same candle (by OHLC): assume STOP hit first (conservative worst-case)
- When TP1 hits, move stop to entry price for remaining 50%
- Time stop: at configured UTC hour, close at that candle's close price
- No look-ahead: when deciding to enter at candle T, use only candles ≤ T. When simulating exit, use future candles only to detect price hits.

**Funding payments during position:**
- If a position is open across a funding settlement (00:00, 08:00, 16:00 UTC):
  - LONG pays: `notional × funding_rate` if funding positive (reduces P&L)
  - LONG receives: `notional × abs(funding_rate)` if funding negative
  - SHORT inverse
- Apply as incremental P&L adjustment at each settlement crossed

### 8.5 Trade journal
For every trade, log these fields:

| Field | Description |
|---|---|
| trade_id | Sequential integer |
| strategy | ARB, NY_OPEN, WEEKEND_MR, FUNDING_FADE, BB_MR |
| symbol | BTCUSDT, ETHUSDT, SOLUSDT |
| direction | LONG or SHORT |
| entry_time | UTC timestamp |
| entry_price | After slippage |
| quantity | Base asset units |
| notional_usd | Position size in USD |
| stop_price | Original stop |
| tp1_price, tp2_price | Targets |
| exit_time | UTC timestamp |
| exit_price | After slippage (weighted average if multi-stage exit) |
| exit_reason | STOP, TP1, TP2, TIME_STOP, BREAKEVEN, CIRCUIT_BREAKER |
| pnl_usd | Net of fees |
| pnl_r | P&L in R-multiples |
| fees_paid | Total fees |
| account_equity_before | Before this trade |
| account_equity_after | After this trade |

### 8.6 Metrics to calculate and output

**Summary metrics:**
- Total return (%): `(final_equity − starting_equity) / starting_equity × 100`
- Number of trades
- Win rate (%): trades with pnl > 0 ÷ total trades
- Profit factor: sum of wins ÷ abs(sum of losses)
- Average win in R, average loss in R
- Expectancy per trade in R
- Maximum drawdown (%): largest peak-to-trough equity decline
- Max drawdown duration (days underwater)
- Sharpe ratio (annualized, assume risk-free rate = 0)
- Sortino ratio (annualized, downside deviation only)
- Calmar ratio: annualized_return / abs(max_drawdown)

**Time-segmented tables:**
- Monthly P&L: for each month, show start equity, end equity, return %, trades count, win rate
- Weekly P&L: same but weekly
- Identify best month and worst month

**Strategy-segmented:**
- For each of [ARB, NY_OPEN, WEEKEND_MR, FUNDING_FADE, BB_MR]:
  - Trade count, win rate, total P&L, expectancy, profit factor
- Tells you which strategies actually contribute alpha

**Symbol-segmented:**
- For each of [BTC, ETH, SOL]: same metrics
- Reveals if one symbol dominates (risk concentration)

**Exit reason breakdown:**
- % stopped out
- % hit TP1 only (partial win)
- % hit TP2 (full win)
- % closed at time_stop
- % closed at breakeven

**Fee drag:**
- Total fees paid across all trades
- Fees as % of gross P&L (high fees = narrow edge)

### 8.7 Acceptance criteria (pass/fail)

The system passes backtest validation if ALL of these hold:

1. **Total return > 40% annualized** over test period
2. **Max drawdown < 20%**
3. **Profit factor > 1.4**
4. **Win rate between 50% and 70%** (below = strategy broken, above = overfit)
5. **Sharpe ratio > 1.2**
6. **At least 100 trades** in sample (statistical significance)
7. **No single month contributes more than 40%** of total return (robustness)
8. **All three symbols positive** (not carried by one symbol)
9. **Each enabled strategy positive** (not carried by one strategy)

If any criterion fails: tune or reject. Do not deploy a system that fails any single criterion.

### 8.8 Walk-forward validation

After initial backtest passes acceptance criteria:

**Step 1: Split data into rolling windows**
- Use 6-month training window, 2-month test window
- Roll forward in 2-month increments

Example with 18 months of data:
- Window 1: train months 1-6, test months 7-8
- Window 2: train months 3-8, test months 9-10
- Window 3: train months 5-10, test months 11-12
- ... continue through all data

**Step 2: Per window**
- On training data: sweep key parameters over reasonable ranges:
  - ARB volume multiplier: 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5
  - ARB range min %: 0.3, 0.35, 0.4, 0.45, 0.5
  - ARB range max %: 2.0, 2.25, 2.5, 2.75, 3.0
  - Similar sweeps for NY_OPEN
- Find parameter set with highest Sharpe on training data
- Apply those exact parameters to the test window (never seen before)
- Record test-window performance

**Step 3: Analyze stability**
- Collect best parameters from each window
- If parameters swing wildly (e.g., volume multiplier goes 1.1 → 1.5 → 1.2 → 1.4): strategy is UNSTABLE, do not deploy
- If parameters stable within ±15%: robust, proceed
- If average test-window Sharpe is less than 60% of average train-window Sharpe: OVERFITTING, do not deploy

### 8.9 Out-of-sample holdout

- Before any optimization begins, set aside the **most recent 3 months** of data
- Do NOT use this data in any backtest or walk-forward
- After walk-forward shows stability, run the final parameter set on this 3-month holdout ONCE
- If performance degrades sharply (>50% worse than walk-forward average): system learned noise, iterate
- If performance holds: ready for deployment (paper or live, operator's choice)

### 8.10 Paper trading mode (optional deployment target)

Paper trading mode is a deployment target the operator can choose after backtest passes. It is NOT a required validation gate — operator may deploy straight to live if they choose.

**What paper mode does:**
- Connects to Binance public WebSocket feeds (no API keys required for public data)
- Streams real-time 1-hour candles for BTC/ETH/SOL
- Runs exactly the same decision logic as backtest and live
- When a signal fires: simulate the fill at the current market price (with configured slippage)
- Record every simulated trade in the database with same schema as live trades
- Runs continuously — no 4-week cap, no trade count target

**What paper mode is useful for:**
- Validating that real-time data flow matches backtest assumptions
- Catching bugs in signal timing (e.g., candle close handling, timestamp issues)
- Running a shadow environment alongside live to compare actual fills vs expected
- Long-term tracking of strategy performance without risking capital

**Fill simulation in paper mode:**
- Entry: at current mark price × (1 + slippage) for BUY, × (1 − slippage) for SELL
- Exits: monitor streaming price; if price crosses stop/TP level during a second, trigger simulated exit
- Fees applied at same rate as live (taker 0.04%)
- Funding payments simulated at each settlement

**Database schema:**
- Paper trades and live trades stored in separate tables (or with a `mode` column)
- Never mix paper and live P&L in reporting

**Mode switching:**
- The bot reads its mode from a config/environment variable at startup
- Changing modes requires restart
- State in database is mode-scoped — paper restart resumes paper state, live restart resumes live state

---

### 8.11 Validation Pipeline (MANDATORY GATE TO DEPLOYMENT)

No paper or live deployment is permitted without a successful validation run that produces a `validated_config.json` artifact. This section defines the pipeline exactly.

#### 8.11.1 Pipeline stages

**Stage 1: Parameter sweep backtest**

Define parameter ranges in config. For each strategy, sweep across the defined ranges, run a full backtest for every combination.

Default parameter ranges to sweep (operator can widen/narrow):

*Strategy A — Asian Range Breakout:*
- `arb_volume_multiplier`: 1.1, 1.2, 1.3, 1.4, 1.5
- `arb_min_range_pct`: 0.3, 0.4, 0.5
- `arb_max_range_pct`: 2.0, 2.5, 3.0
- `arb_stop_buffer_atr`: 0.3, 0.5, 0.7
- `arb_tp1_r`: 1.0, 1.5, 2.0
- `arb_tp2_r`: 2.5, 3.0, 3.5

*Strategy B — NY Open Momentum:*
- `ny_volume_multiplier`: 1.2, 1.3, 1.4, 1.5, 1.6
- `ny_min_range_pct`: 0.2, 0.3, 0.4
- `ny_max_range_pct`: 1.5, 2.0, 2.5
- `ny_stop_buffer_atr`: 0.3, 0.4, 0.5
- `ny_tp1_r`: 1.0, 1.5, 2.0
- `ny_tp2_r`: 2.0, 2.5, 3.0

*Strategy C — Weekend Mean Reversion:*
- `wmr_min_weekend_move_pct`: 2.0, 2.5, 3.0, 3.5, 4.0
- `wmr_stop_buffer_pct`: 0.3, 0.5, 0.7
- `wmr_tp1_retracement_pct`: 40, 50, 60

*Strategy D — Funding Settlement Fade:*
- `ff_min_abs_funding`: 0.0003, 0.0005, 0.0007, 0.001
- `ff_stop_pct`: 0.5, 0.8, 1.0
- `ff_target_pct`: 1.0, 1.5, 2.0

Total combinations can be large. Use parallel execution and cache intermediate computations. For a full sweep across all four strategies, expect 5,000-50,000 combinations. If runtime is excessive, reduce range granularity but keep the endpoints.

**Stage 2: Monte Carlo simulation**

For the top 20 parameter sets from Stage 1 (ranked by Sharpe ratio):

1. Take the list of trades produced by that parameter set in the backtest
2. Randomize the trade order 1,000 times
3. For each randomization, compute final equity, max drawdown, and Sharpe
4. Record the distribution of outcomes

Output per parameter set:
- Median final equity
- 5th percentile final equity (the "bad luck" scenario)
- 95th percentile final equity
- Median max drawdown
- 95th percentile max drawdown (the "worst case")
- Probability of negative return (% of simulations ending below starting capital)

A parameter set passes Monte Carlo if:
- Probability of negative return < 10%
- 5th percentile return > 0 (strategy profitable even in bad-luck scenarios)
- 95th percentile max drawdown < 30%

**Stage 3: Walk-forward validation**

For the top 10 parameter sets that passed Monte Carlo:

Run walk-forward per Section 8.8: rolling 6-month train / 2-month test windows. For each parameter set, record:
- Average test-window Sharpe
- Train-to-test performance ratio (test Sharpe / train Sharpe)
- Parameter stability across windows (max deviation of winning params from overall best)

A parameter set passes walk-forward if:
- Average test Sharpe > 1.0
- Train-to-test ratio > 0.6 (no severe overfit)
- Parameter stability within ±15% across windows

**Stage 4: Out-of-sample test**

For the remaining candidates (typically 3-5 parameter sets):

Run each against the held-out 3-month out-of-sample period (see Section 8.9). Record final Sharpe, max DD, and total return.

A parameter set passes out-of-sample if:
- Out-of-sample Sharpe ≥ 60% of walk-forward test average
- Out-of-sample max DD ≤ 1.3 × walk-forward average max DD

**Stage 5: Best-performer selection**

From all parameter sets that passed stages 1-4, select the single best using this composite score:

```
score = (test_sharpe × 0.35)
      + (oos_sharpe × 0.25)
      + (monte_carlo_5th_pct_return_pct × 0.002)
      + (1 - (max_drawdown_pct / 100)) × 0.15
      + (parameter_stability_score × 0.15)
      + (trade_count_score × 0.10)
```

Where:
- `parameter_stability_score` = 1 − (max_param_deviation_pct / 100), capped to [0, 1]
- `trade_count_score` = min(1, total_trades / 200) — rewards statistically significant samples

Higher score wins. If multiple parameter sets are within 2% of each other, prefer the simpler one (fewer extreme parameter values).

#### 8.11.2 Validation artifact (`validated_config.json`)

The pipeline produces this artifact only if a winning parameter set is found. Structure:

```json
{
  "artifact_version": "1.0",
  "created_at": "2026-04-20T15:32:11Z",
  "code_hash": "sha256:abc123...",
  "data_window": {
    "start": "2024-04-01T00:00:00Z",
    "end": "2026-03-31T23:59:59Z",
    "months_covered": 24
  },
  "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  "winning_parameters": {
    "arb_volume_multiplier": 1.3,
    "arb_min_range_pct": 0.4,
    "arb_max_range_pct": 2.5,
    "arb_stop_buffer_atr": 0.5,
    "arb_tp1_r": 1.5,
    "arb_tp2_r": 3.0,
    "ny_volume_multiplier": 1.4,
    "...": "..."
  },
  "validation_results": {
    "backtest": {
      "total_return_pct": 82.4,
      "sharpe": 1.87,
      "max_dd_pct": 14.2,
      "trade_count": 347,
      "win_rate_pct": 58.2,
      "profit_factor": 1.64
    },
    "monte_carlo": {
      "runs": 1000,
      "median_return_pct": 79.1,
      "p5_return_pct": 41.3,
      "p95_return_pct": 118.5,
      "p95_max_dd_pct": 22.7,
      "prob_negative_return_pct": 3.8
    },
    "walk_forward": {
      "windows_tested": 7,
      "avg_test_sharpe": 1.42,
      "train_to_test_ratio": 0.76,
      "param_stability_max_deviation_pct": 8.3
    },
    "out_of_sample": {
      "period": "2026-01-01 to 2026-03-31",
      "sharpe": 1.31,
      "max_dd_pct": 15.8,
      "return_pct": 18.4
    }
  },
  "composite_score": 0.738,
  "deployment_allowed": true
}
```

If `deployment_allowed` is `false`, the artifact still records why (which stage failed, which criteria). This helps operators understand what's preventing deployment.

#### 8.11.3 Deployment enforcement

The deployment command (whether targeting paper or live mode) must:

1. Load the `validated_config.json` artifact from a specified path
2. Verify `deployment_allowed === true`. If false: abort with error message.
3. Verify `created_at` is within 30 days of current time. If stale: abort, require re-run.
4. Verify `code_hash` matches the hash of the currently-deployed code. If mismatch: abort, require re-validation with current code.
5. Load `winning_parameters` into the bot's runtime config
6. Log the full artifact to database (immutable record of what was deployed)
7. Only then start the execution engine

Any attempt to start the bot in paper or live mode without a valid, current, matching artifact must fail loudly at startup with a clear error.

#### 8.11.4 Re-validation triggers

Re-run the full validation pipeline when any of these occur:
- Core strategy logic changed (any file under the core decision logic)
- Risk management rules changed
- 30 days since last validation (staleness)
- Meaningful regime change observed (e.g., BTC enters a 50%+ drawdown or rally, volatility regime shift)
- Any live deployment underperforming backtest by >30% over a 30-day window

Until re-validation passes, live deployments continue running with the existing artifact, but new deployments are blocked.

---

### 8.12 Regime Drift Monitoring (MANDATORY runtime component)

Purpose: detect when market conditions have changed enough that existing validated parameters may no longer be optimal. Operates as a two-tier system — a cheap daily health check for fast signal, and a full scheduled re-validation every 14 days as a safety net.

This component must run automatically in both paper and live modes. It is not optional.

#### 8.12.1 Validation snapshot (baseline reference)

At the moment a `validated_config.json` is produced (Section 8.11), the system must also capture and store a **validation snapshot** — a point-in-time picture of market conditions at validation. This snapshot is the baseline all future drift checks compare against.

Snapshot fields (per symbol):
- `regime_at_validation`: RANGING, TRENDING_UP, TRENDING_DOWN, SQUEEZE, TRANSITION
- `confidence_at_validation`: the regime confidence score, 0–1
- `bb_width_percentile_at_validation`: BB width vs trailing 100-candle distribution
- `ema99_slope_at_validation`: % per candle
- `atr_pct_at_validation`: ATR as % of close price

Plus global fields:
- `btc_realized_vol_30d_at_validation`: annualized realized vol of BTC over 30 days preceding validation
- `validation_timestamp_utc`

The snapshot is stored alongside the artifact and referenced by drift monitoring from that point forward until a new artifact is produced.

#### 8.12.2 Daily regime health check

**When:** runs automatically at 00:30 UTC every day.

**What it does:** for each of BTCUSDT, ETHUSDT, SOLUSDT, calls the regime classifier on current candles and compares to the validation snapshot. Produces one outcome per symbol, then aggregates to a portfolio-level outcome.

**Per-symbol outcomes:**

**UNCHANGED** — all of:
- Current regime matches `regime_at_validation`
- Current confidence is within 30% of `confidence_at_validation` (e.g., if validation confidence was 0.85, current must be between 0.60 and 1.00)
- Current BB width percentile is within 25 percentile points of validation
- EMA99 slope has not changed sign

**DRIFTED** — current regime matches validation regime BUT one or more of:
- Confidence has dropped more than 30% from validation-time value
- BB width percentile has moved more than 25 percentile points
- EMA99 slope has changed sign but magnitude remains below trending threshold (i.e., still RANGING but heading toward trending)

**FLIPPED** — any of:
- Current regime is different from `regime_at_validation` AND this has been true for 3+ consecutive days
- Any symbol transitions RANGING → TRENDING (either direction) sustained 3+ days
- Any symbol enters SQUEEZE from non-squeeze sustained 2+ days

**Portfolio-level aggregation:**

After all three symbols are classified, produce portfolio outcome:
- **PORTFOLIO_UNCHANGED:** all three symbols UNCHANGED
- **PORTFOLIO_DRIFTED:** any symbol DRIFTED, but no FLIPPED
- **PORTFOLIO_FLIPPED:** 2 or more symbols FLIPPED, OR 1 symbol FLIPPED on 2+ consecutive daily checks

**Actions by portfolio outcome:**

| Outcome | Logging | Alert | Trading | Re-validation |
|---|---|---|---|---|
| UNCHANGED | Audit log only | None | Continue normally | None |
| DRIFTED | Log with flag | Telegram/email alert to operator | Continue normally | None triggered — but increase monitoring (log hourly instead of daily) |
| FLIPPED | Log with severity HIGH | Urgent alert | **Pause new entries on symbols that flipped** (others continue) | Trigger full pipeline within 24 hours |

**Important:** FLIPPED outcome does NOT close existing positions. Open positions continue to be managed by their own stops, TPs, and time stops. Only new entries are paused on affected symbols.

#### 8.12.3 Fortnightly scheduled re-validation

**When:** every 14 days at 02:00 UTC (low-activity window, reduces overlap with session-based trade windows).

**What:** runs the full Section 8.11 validation pipeline against fresh data including the most recent 14 days. Produces a candidate `validated_config.json`.

**Swap logic:**

Compare candidate parameters to currently-deployed parameters using mean percentage deviation across all winning parameters:

```
mean_deviation = mean(abs(new_param - old_param) / old_param × 100) for each parameter
```

- If `mean_deviation < 10%`: keep existing artifact. Log "fortnightly check, no meaningful change." No operator action needed.
- If `mean_deviation 10–15%`: **auto-swap** to new artifact at next top-of-hour. Alert operator with diff summary.
- If `mean_deviation > 15%`: **require manual approval.** Alert operator with full diff. New artifact does not take effect until operator runs `--approve-artifact <hash>` command.

Fortnightly runs do NOT pause trading while running. The pipeline runs in background; the new artifact is only swapped into the runtime at a clean boundary (top-of-hour or bot restart).

#### 8.12.4 Other re-validation triggers

Beyond FLIPPED daily outcome and scheduled fortnightly, immediate re-validation is triggered by:

**Trigger: Live performance decay**
- Condition: rolling 30-day live P&L in R-multiples is less than 50% of backtest-predicted expectation for the same period
- Check frequency: daily, piggybacks on regime check
- Rationale: strategy alpha may be decaying even if regime technically unchanged

**Trigger: Volatility regime shift**
- Condition: BTC 30-day realized volatility moves ±50% from `btc_realized_vol_30d_at_validation`
- Check frequency: daily
- Rationale: position sizing and stop distances were tuned to a specific volatility regime; major shifts invalidate assumptions

**Trigger: Code change**
- Condition: hash of any file in core decision logic differs from `code_hash` in current artifact
- Check frequency: at every bot startup
- Rationale: deployed code must match validated code. Catches accidental edits or deployment drift.

**Trigger: Manual operator trigger**
- Condition: operator invokes `--force-revalidate` command
- Rationale: operator response to news, fundamentals, exchange events, or other signals not visible in price data (regulatory announcements, exchange hacks, major protocol events)

#### 8.12.5 Re-validation window behavior

From the moment any re-validation is triggered until a new `validated_config.json` is produced and swapped in:

**Existing open positions:**
- Continue to be managed per original rules (stops, TPs, breakeven moves, time stops)
- Circuit breakers remain fully active

**New entries:**
- If trigger was FLIPPED on specific symbols: new entries PAUSED on those symbols only. Other symbols continue normally.
- If trigger was performance decay or volatility shift: new entries PAUSED on all symbols until new artifact produced.
- If trigger was code change: FULL SYSTEM HALT — operator must approve new artifact before anything resumes.
- If trigger was fortnightly scheduled: no pause. Pipeline runs in background.

**Logging:**
- All trade decisions during re-validation window tagged with `revalidation_pending: true`
- Makes post-hoc analysis easy: compare behavior during re-validation vs. normal operation

**When new artifact produced:**
- Operator receives summary diff: old params → new params, old metrics → new metrics, composite score delta
- Auto-swap applied or awaiting manual approval per Section 8.12.3 rules
- After swap takes effect: clear `revalidation_pending` flags, resume normal new-entry flow on all symbols

#### 8.12.6 Database schema additions

Extend storage with these tables:

**`regime_check_log`** — one row per symbol per daily check:
- `id`, `timestamp_utc`, `symbol`
- `outcome` (UNCHANGED / DRIFTED / FLIPPED)
- `current_regime`, `validation_regime`
- `confidence_current`, `confidence_at_validation`, `confidence_delta_pct`
- `bb_width_pct_current`, `bb_width_pct_at_validation`, `bb_width_delta_points`
- `ema99_slope_current`, `ema99_slope_at_validation`
- `consecutive_days_same_outcome`

**`revalidation_events`** — one row per re-validation run:
- `id`, `trigger_reason` (FLIPPED / PERFORMANCE_DECAY / VOL_SHIFT / CODE_CHANGE / MANUAL / FORTNIGHTLY)
- `started_at_utc`, `completed_at_utc`, `duration_seconds`
- `previous_artifact_hash`, `new_artifact_hash`
- `mean_parameter_deviation_pct`
- `auto_swap_applied` (bool)
- `operator_approved` (bool, null if not required)
- `approved_at_utc`, `notes`

**`validation_snapshot`** — one row per validation pipeline run (Section 8.11):
- `artifact_hash`, `created_at_utc`
- Per-symbol: `regime`, `confidence`, `bb_width_pct`, `ema99_slope`, `atr_pct` (as JSON or separate rows)
- `btc_realized_vol_30d`
- `overall_market_conditions_notes` (free-text, optional)

#### 8.12.7 Configuration values

```
# Daily regime check schedule
DAILY_CHECK_UTC_HOUR = 0
DAILY_CHECK_UTC_MINUTE = 30

# Drift detection thresholds
DRIFT_CONFIDENCE_DROP_PCT = 30
DRIFT_BB_WIDTH_DELTA_POINTS = 25

# Flip detection thresholds
FLIP_CONSECUTIVE_DAYS_REGIME_CHANGE = 3
FLIP_CONSECUTIVE_DAYS_RANGING_TO_TRENDING = 3
FLIP_CONSECUTIVE_DAYS_SQUEEZE_ENTRY = 2
FLIP_SYMBOLS_REQUIRED_FOR_PORTFOLIO_FLIP = 2

# Fortnightly schedule
FORTNIGHTLY_INTERVAL_DAYS = 14
FORTNIGHTLY_UTC_HOUR = 2

# Artifact swap behavior
AUTO_SWAP_NOCHANGE_DELTA_PCT = 10
AUTO_SWAP_MAX_DELTA_PCT = 15

# Performance decay trigger
LIVE_PERF_DECAY_THRESHOLD_PCT = 50
LIVE_PERF_ROLLING_DAYS = 30

# Volatility shift trigger
VOL_SHIFT_THRESHOLD_PCT = 50
```

---

## 9. Edge Cases and Error Handling

### 9.1 Missing or stale data
- If a candle gap > 1 hour is detected: re-fetch from API
- If API fails persistently: log error, skip signal evaluation for that symbol
- If most recent candle is > 5 minutes stale (live mode): do not generate new signals

### 9.2 NaN values in indicators
- If ATR, EMA, or RSI calculation returns NaN (insufficient history): skip signal
- Require minimum 100 candles loaded before any signal evaluation

### 9.3 Exchange downtime (live mode)
- On API errors: retry 3 times with exponential backoff (1s, 2s, 4s)
- If still failing: halt new entries, keep monitoring open positions
- Persist all state to disk so restart recovers cleanly

### 9.4 Order reconciliation (live mode)
- On startup: fetch all actual open positions from exchange
- Compare to expected state from local database
- If mismatch: log discrepancy, send alert, halt new entries until resolved

### 9.5 Partial fills
- If market order partial-fills: accept whatever filled, log shortfall
- Place stop/TP orders on actual filled quantity, not intended
- Continue monitoring the partial position normally

### 9.6 Minimum notional violation
- Some SOL signals may calculate to < $5 notional at small account sizes
- Action: skip the trade, log as "below minimum notional"
- This becomes less common as account grows

### 9.7 Scheduled maintenance
- Binance posts maintenance windows in advance via API
- Before placing order: check `/fapi/v1/ping` or status endpoint
- If in maintenance: skip entry, retry next candle

### 9.8 Abrupt volatility spikes
- If a single candle has |move| > 10%: treat as anomaly
- Do not enter new positions for 2 hours after such a candle
- Existing positions manage normally through their stops

---

## 10. Recommended Build Order

Build in this sequence. Do not skip ahead — each step builds on the last.

1. **Data fetcher**: pull Binance klines for 3 symbols, 18+ months, store locally. Validate integrity.
2. **Indicator library**: implement ATR(14), EMA(7/25/99), RSI(14), Bollinger Bands(14, 2), ADX(14). Unit test each.
3. **Session utilities**: functions for "what session is this timestamp in", "compute Asian range for date X", "compute pre-NY range for date X".
4. **Strategy A (ARB)**: implement per Section 2. Unit test with synthetic data.
5. **Strategy B (NY Open)**: implement per Section 3.
6. **Position sizing module**: implement per Section 6.
7. **Circuit breaker logic**: implement per Section 7.
8. **Backtest replay engine**: implement per Section 8.3 and 8.4. Test on 1 month of data first to verify no look-ahead bugs.
9. **Metrics module**: implement per Section 8.6.
10. **Run Strategy A backtest**: 18 months, all 3 symbols. Check acceptance criteria.
11. **Run Strategy B backtest**: same.
12. **Run A+B combined backtest**: verify correlation cap doesn't break anything.
13. **Walk-forward harness**: implement per Section 8.8.
14. **Add Strategy C (Weekend MR)**: per Section 4.
15. **Add Strategy D (Funding Fade)**: per Section 5. Requires funding rate data.
16. **Combined 4-strategy backtest + walk-forward**.
17. **Out-of-sample test on last 3 months**: per Section 8.9.
18. **Monte Carlo simulation module**: per Section 8.11.1 Stage 2. Must accept a trade list and produce distribution statistics.
19. **Validation pipeline orchestrator**: implement Section 8.11.1 end-to-end. Takes parameter ranges, runs all five stages, produces `validated_config.json` artifact (or fails with reason).
20. **Validation artifact storage**: database table or file system path for storing artifacts, with versioning and retrieval by ID.
21. **Execution layer abstraction**: define a common interface used by backtest, paper, and live. Methods: `submit_entry`, `check_exits`, `close_position`. The core decision logic calls this interface; each mode provides its own implementation.
22. **Paper mode execution adapter**: WebSocket connection to Binance public streams, real-time candle subscription, simulated fill logic against live prices, database persistence.
23. **Live mode execution adapter**: Binance Futures REST + WebSocket, authenticated order placement, stop/TP bracket orders, state reconciliation on startup.
24. **Deployment gate enforcement**: implement Section 8.11.3. The bot startup code must check for a valid, current artifact matching current code hash before it allows any non-backtest mode to launch.
25. **Regime drift monitoring module**: implement Section 8.12. Includes validation snapshot capture, daily regime health check with per-symbol and portfolio outcomes, and the FLIPPED/DRIFTED/UNCHANGED classification.
26. **Scheduler infrastructure**: cron-like component that triggers daily regime check at 00:30 UTC, fortnightly re-validation at 02:00 UTC, and any other scheduled jobs. Must survive bot restarts without missing scheduled runs.
27. **Other re-validation triggers**: implement performance decay check, volatility shift check, code hash check at startup, manual operator trigger command.
28. **Auto-swap mechanism**: implement parameter diff calculation and the three-tier swap logic (no-change, auto-swap, manual-approval) per Section 8.12.3.
29. **Mode switch**: startup config determines which adapter is used. Verify all three modes (backtest, paper, live) can run without code changes — only config.
30. **Deploy**: operator runs validation pipeline, which produces a `validated_config.json` plus validation snapshot. Operator then invokes deployment command targeting paper or live mode, passing the artifact. No other deployment path exists.

At each step, write tests. When a bug appears in production, trace it back to a test you should have had — add the test, then fix the bug.

---

## 11. Final Deployment Checklist

Do not deploy (paper or live) until every box is checked:

- [ ] 18+ months of clean historical data loaded for all 3 symbols
- [ ] Funding rate history loaded for all 3 symbols
- [ ] All 4 strategies implemented per spec (Section 2-5)
- [ ] Risk management enforced on every entry (Section 6)
- [ ] All circuit breakers tested manually (Section 7)
- [ ] Backtest replay engine verified no-look-ahead via synthetic data test
- [ ] Parameter sweep runs end-to-end across all defined ranges
- [ ] Monte Carlo simulation module produces sensible distributions
- [ ] Walk-forward harness produces per-window results
- [ ] Out-of-sample evaluator runs on holdout period
- [ ] Best-performer selection logic produces a single winning config
- [ ] `validated_config.json` artifact successfully generated with all required fields (Section 8.11.2)
- [ ] Deployment gate enforcement verified: attempting to start bot without valid artifact fails with clear error
- [ ] Deployment gate verified: stale artifact (>30 days) or mismatched code_hash blocks startup
- [ ] Validation snapshot captured alongside every `validated_config.json` (per Section 8.12.1)
- [ ] Daily regime check verified end-to-end: runs at 00:30 UTC, classifies each symbol, produces correct UNCHANGED/DRIFTED/FLIPPED outcome
- [ ] Portfolio-level aggregation verified: FLIPPED outcome only triggers when 2+ symbols flipped or persistent on 1 symbol
- [ ] Fortnightly scheduled re-validation verified: runs every 14 days at 02:00 UTC, produces candidate artifact
- [ ] Auto-swap logic tested: parameter delta <10% keeps existing, 10-15% auto-swaps, >15% requires manual approval
- [ ] All four non-flip triggers verified (performance decay, volatility shift, code hash mismatch, manual command)
- [ ] Re-validation window behavior tested: existing positions continue, new entries pause on affected symbols, resume after swap
- [ ] Execution layer abstraction verified: same core code runs in backtest, paper, and live modes
- [ ] Paper mode tested end-to-end: WebSocket stream receives candles, signals fire, simulated fills recorded in database
- [ ] Monitoring/alerting integrated (Telegram, email, or equivalent)
- [ ] State persistence verified: stop the bot, restart, verify it recovers correctly
- [ ] Exchange reconciliation on startup verified (Section 9.4)
- [ ] Manual emergency stop mechanism tested
- [ ] Ledger exported to CSV/database for tax/audit records

When all boxes checked and validation pipeline has produced a winning artifact:
- **Paper mode:** operator deploys with `--mode=paper --artifact=validated_config.json`. Bot runs indefinitely with zero capital risk.
- **Live mode:** operator deploys with `--mode=live --artifact=validated_config.json --capital=5000`. Bot runs with real capital using the validated parameters.

**There is no deployment path that bypasses the validation pipeline. The bot refuses to start in any non-backtest mode without a valid current artifact.**

---

## 12. Default Configuration Values (Reference Table)

Copy these into a config file in your implementation. Every value is tunable during walk-forward.

```
RISK_PER_TRADE_PCT = 2.0
MAX_EXCHANGE_LEVERAGE = 20
NET_EXPOSURE_CAP_MULTIPLE = 2.5
MAX_POSITIONS_PER_BUCKET = 2
MAX_TOTAL_POSITIONS = 3
CORRELATED_BUCKET = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

DAILY_LOSS_CAP_PCT = 5.0
WEEKLY_LOSS_CAP_PCT = 12.0
CONSECUTIVE_LOSS_THRESHOLD = 3
SYMBOL_COOLDOWN_HOURS = 12

TAKER_FEE_RATE = 0.0004
SLIPPAGE_BPS = 2

ATR_PERIOD = 14
EMA_FAST = 7
EMA_MID = 25
EMA_SLOW = 99
RSI_PERIOD = 14
BB_PERIOD = 14
BB_STDDEV = 2
ADX_PERIOD = 14

# Strategy A: Asian Range Breakout
ARB_BREAKOUT_WINDOW_START_HOUR_UTC = 7
ARB_BREAKOUT_WINDOW_END_HOUR_UTC = 11
ARB_MIN_RANGE_PCT = 0.4
ARB_MAX_RANGE_PCT = 2.5
ARB_VOLUME_MULTIPLIER = 1.3
ARB_VOLUME_LOOKBACK = 20
ARB_STOP_BUFFER_ATR = 0.5
ARB_TP1_R = 1.5
ARB_TP2_R = 3.0
ARB_TP1_ALLOCATION_PCT = 50
ARB_BREAKEVEN_AT_R = 1.0
ARB_TIME_STOP_HOUR_UTC = 20
ARB_SKIP_WEEKENDS = true

# Strategy B: NY Open Momentum
NY_PRE_RANGE_START_HOUR_UTC = 11
NY_PRE_RANGE_END_HOUR_UTC = 13
NY_BREAKOUT_START_HOUR_UTC = 13
NY_BREAKOUT_END_HOUR_UTC = 15
NY_MIN_RANGE_PCT = 0.3
NY_MAX_RANGE_PCT = 2.0
NY_VOLUME_MULTIPLIER = 1.4
NY_STOP_BUFFER_ATR = 0.4
NY_TP1_R = 1.5
NY_TP2_R = 2.5
NY_TP1_ALLOCATION_PCT = 50
NY_BREAKEVEN_AT_R = 1.0
NY_TIME_STOP_HOUR_UTC = 20

# Strategy C: Weekend Mean Reversion
WMR_MIN_WEEKEND_MOVE_PCT = 3.0
WMR_STOP_BUFFER_PCT = 0.5
WMR_TP1_RETRACEMENT_PCT = 50
WMR_TP1_ALLOCATION_PCT = 70
WMR_MAX_MONDAY_GAP_PCT = 1.0
WMR_TIME_STOP_HOURS = 32

# Strategy D: Funding Settlement Fade
FF_MIN_ABS_FUNDING = 0.0005
FF_CONFIRMATION_WAIT_MINUTES = 30
FF_MIN_CONFIRMATION_MOVE_PCT = 0.2
FF_STOP_PCT = 0.8
FF_TARGET_PCT = 1.5
FF_MIN_ACCOUNT_EQUITY_USD = 3000
FF_MAX_TRADES_PER_DAY_PER_SYMBOL = 3
```

---

End of specification. Implement in the order given in Section 10. Ask no questions that are answered here — every rule is defined. Questions about tech stack, libraries, architecture, or hosting are yours to decide.
