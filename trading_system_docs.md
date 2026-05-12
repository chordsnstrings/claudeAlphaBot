# Trading System — Project Documentation v3

**Builder:** Replit Power Mode (Opus) agent
**Deployment:** DigitalOcean droplet via GitHub push
**Database:** PostgreSQL + TimescaleDB (pre-provisioned)
**Broker:** Pepperstone via cTrader Open API (demo 5286746 for dev, live for production)
**Official cTrader API docs:** https://help.ctrader.com/open-api/ — REQUIRED reading before Phases 15-16
**Scope:** 25 phases, est. 80-160 hours agent runtime

---

## What This Is

A systematic trading system with two modes selected at startup:

- **Backtest mode**: replays historical data from TimescaleDB, simulates execution with realistic friction
- **Live mode**: connects to Pepperstone via cTrader Open API, executes real orders on demo or live account

Same strategy code, orchestrator, risk manager, metrics module run in both modes. Only data feed and execution adapter differ — chosen via configuration.

**All testing uses real data and real Pepperstone demo account.** No mocks, no synthetic test data, no fake broker.

---

## How To Use

**Architect (you):** Read sections 1-9 once. For each session: paste the phase's Agent Brief into Replit, run verification, resolve issues before next phase.

**Replit agent:** Read sections 1-9 at session start. Read the specific phase being implemented. Reference sections 10-14 as needed.

---

## Infrastructure & Build Order

**The build proceeds in two stages:**

**Stage 1 — Backtest engine (Phases 1-14):** Build the full backtest infrastructure. No broker connection needed. Strategies run against historical data from the database. By Phase 14 the backtest engine is fully validated.

**Stage 2 — Live engine (Phases 15-24):** Connect to Pepperstone via cTrader Open API, build live execution, UI, and production deployment. Requires cTrader credentials and infrastructure ready.

### Prerequisites BEFORE Phase 1 starts

The agent assumes these exist when Phase 1 begins:

- **DigitalOcean droplet provisioned** (minimum: CPU-Optimized 4 vCPU / 8 GB RAM, Ubuntu 22.04 LTS, Frankfurt/Amsterdam region for low Pepperstone latency)
- **Subdomain pointed at droplet** (suggested: `bot.<your-domain>` — A record at registrar pointing to droplet IP, TTL 300)
- **GitHub repository created** for the codebase (Replit will connect to it)
- **Replit secrets configured** with: `DATABASE_URL`, `DO_API_TOKEN` (for deployment), `GITHUB_TOKEN`, SSH key for droplet access

If any of these isn't ready, the agent should pause and alert the architect rather than proceeding.

### Build-first, connect-second sequencing

The cTrader integration follows a specific order:

1. **Agent builds cTrader infrastructure first** (Phases 15-17): data feed adapter, execution adapter, OAuth callback endpoint, system clock, live composition root. All built and deployed to DO, but NOT yet connected to cTrader. The code is ready and the callback endpoint is reachable at `https://bot.<your-domain>/oauth/callback`.

2. **Architect creates cTrader application** at id.ctrader.com using the now-deployed callback URL:
   - Application name: `ARKS Trading System`
   - Description: brief professional description
   - Redirect URL: `https://bot.<your-domain>/oauth/callback` (the real deployed endpoint)
   - Scope: `trading`
   - Submit, capture Client ID + Client Secret immediately

3. **Architect adds credentials to Replit secrets**:
   - `CTRADER_CLIENT_ID`
   - `CTRADER_CLIENT_SECRET`
   - `CTRADER_ACCOUNT_ID=5286746` (the demo account)
   - `CTRADER_ACCOUNT_TYPE=demo`

4. **Agent runs the one-time OAuth authorization flow**: bot generates auth URL, architect approves in browser, cTrader redirects to the deployed callback endpoint with auth code, bot exchanges code for access/refresh tokens, tokens automatically saved to Replit secrets as `CTRADER_ACCESS_TOKEN` and `CTRADER_REFRESH_TOKEN`.

5. **Agent verifies live connection**: queries account info, subscribes to a test instrument, places a small test order on demo. Confirms full integration works.

### Why this order

Creating the cTrader application earlier means:
- Redirect URL would be a placeholder (localhost) that doesn't match where the bot actually runs
- OAuth flow can't actually complete because cTrader redirects to a URL the bot can't receive on
- Application would need to be edited later when the real endpoint exists

Building the infrastructure first means:
- The callback endpoint exists and is reachable before we even register it with cTrader
- cTrader application is created with the correct production URL on first try
- OAuth flow works immediately when credentials are added
- No editing the cTrader app later, no mismatched URLs, no debugging "why isn't the redirect working"

### cTrader credentials are NOT needed until Phase 18

The agent must not attempt cTrader connection before Phase 18. Specifically:

- **Phases 1-14: NO cTrader work.** Build the entire backtest engine using real historical data from Dukascopy. Don't reference cTrader, don't try to connect, don't fail because credentials are missing.
- **Phases 15-17: Build cTrader infrastructure CODE.** Implement CTraderDataFeed, CTraderExecutionAdapter, OAuth callback endpoint, SystemClock, live composition root. Deploy to DO. Verify endpoints are reachable. DO NOT attempt to connect to cTrader yet — credentials don't exist.
- **Phase 18: First cTrader connection.** Architect creates cTrader app, adds credentials to Replit secrets, agent runs OAuth flow, agent verifies live connection works end-to-end.

---

## Contents

1. Architecture
2. Goals
3. Principles
4. Project Structure
5. Data Models
6. Friction Model (Backtest)
7. Execution Model (Live)
8. Statistical Methodology
9. Build Phases (24)
10. Strategy Specifications
11. Orchestrator Specifications
12. Operational UI Specifications
13. cTrader Integration Specifications
14. Asset Universe

---

# 1. Architecture

## 1.1 Two modes, one system

```
MODE=backtest → HistoricalDataFeed + SimulatedExecutionAdapter + SimulatedClock
MODE=live     → CTraderDataFeed + CTraderExecutionAdapter + SystemClock
```

In live mode, `CTRADER_ACCOUNT_TYPE` selects `demo` (account 5286746) or `live`.

Same code paths in all configurations. Only boundary adapters differ.

## 1.2 Mode-invariant components

Same code, same behavior across modes:
- Strategy modules
- Orchestrator
- Risk Manager
- Indicator Library
- Metrics & Statistics
- Audit Log
- Configuration

## 1.3 Mode-specific components (injected at startup)

Three interfaces, two implementations each:

**MarketDataFeed** — provides bars
- Backtest: reads chronologically from TimescaleDB
- Live: connects to Pepperstone WebSocket, builds bars from ticks

**ExecutionAdapter** — executes orders
- Backtest: applies friction model, simulates fills
- Live: submits orders to Pepperstone via cTrader Open API

**Clock** — provides current time
- Backtest: advances based on bar processing
- Live: system wall-clock

Every other component is mode-invariant.

## 1.4 Composition root

One function wires everything based on config:

```typescript
function buildSystem(config: SystemConfig): TradingSystem {
  const isBacktest = config.mode === 'backtest';

  const dataFeed = isBacktest
    ? new HistoricalDataFeed(db, config.backtest)
    : new CTraderDataFeed(config.live);

  const execution = isBacktest
    ? new SimulatedExecutionAdapter(new FrictionModel(config.backtest.frictionProfile), db)
    : new CTraderExecutionAdapter(config.live);

  const clock = isBacktest
    ? new SimulatedClock(config.backtest.startDate)
    : new SystemClock();

  const strategies = config.strategies.map(s => buildStrategy(s));
  const riskManager = new RiskManager(config.riskConfig);
  const orchestrator = new Orchestrator(strategies, config.orchestratorMode, riskManager);
  const metrics = new MetricsCollector();
  const auditLog = new AuditLog(db);

  return new TradingSystem(dataFeed, execution, clock,
    orchestrator, riskManager, metrics, auditLog, config.sessionId);
}
```

TradingSystem class itself is identical regardless of mode.

---

# 2. Goals

**G1.** Backtest engine running strategies against 5 years of historical daily data for the full Dukascopy instrument universe plus M1 data for the active trading subset, with realistic friction.

**G2.** Live engine connecting to Pepperstone via cTrader Open API, running the same strategies.

**G3.** Single Strategy interface — same code runs in backtest and live.

**G4.** Walk-forward validation and parameter sweep in backtest mode.

**G5.** Monte Carlo trade reshuffling.

**G6.** Multi-strategy orchestration with three modes (equal weight, risk parity, regime-switched).

**G7.** All risk parameters as percentages of account equity. Position sizes scale automatically with growth.

**G8.** Full database persistence: every bar, signal, order, trade, audit event, account snapshot.

**G9.** Operational UI replacing cTrader for daily use: positions, P&L, strategy controls, manual orders, emergency stop, configuration changes.

**G10.** Deployable to DigitalOcean via GitHub push, with structured logging, health monitoring, automated backups.

**G11.** Test coverage 80%+ on critical paths (indicators, friction, risk, trade lifecycle).

---

# 3. Principles

## 3.1 Strict mode parity
Exactly two modes. Mode selected at startup. Code paths identical. No `if mode === 'live'` outside composition root.

## 3.2 Strategy code is mode-agnostic
Strategies receive `MarketState`, return `Signal[]`, update internal state. Never check mode.

## 3.3 Bar-by-bar event loop
Strategies process one bar at a time, chronologically, no lookahead.

## 3.4 Percentages, not dollars
Risk parameters, position sizes, limits all as % of account equity. Scales automatically with account growth.

Dollars appear only in:
- Account equity display (for human)
- P&L display (for human)
- Commission ($7/lot — fixed by broker)

## 3.5 Real data and real broker
Backtest uses real historical data from Dukascopy in TimescaleDB. No synthetic series, no generated test data.

Live uses real Pepperstone demo or live account via cTrader Open API. No simulated broker.

All testing uses real data and real connections. The demo account is the testing ground for live mode — free, real orders, real fills.

## 3.6 Reproducibility (backtest)
Same code + data + config + seed = identical output. Capture: seed, git SHA, data hash, full parameters, library versions.

Live is non-deterministic (real markets) but fully auditable.

## 3.7 Full provenance
Every backtest run unique ID. Every live session unique ID. Every trade unique ID. Every order unique broker ID. Every rejected signal logged with reason.

## 3.8 Realistic friction in backtest
Default matches Pepperstone Razor. Strategies working with zero friction but failing with realistic friction are not real edges.

## 3.9 No lookahead
At bar B, strategies use only information from bars ≤ B. Walk-forward test windows use only training window data. Enforced architecturally via clock-bound data feed.

## 3.10 Database-first
All historical data lives in TimescaleDB. Strategies fetch from DB, not Dukascopy at runtime. Dukascopy used only for ingestion (Phase 3) and incremental updates.

## 3.11 UI replaces broker app
After deployment, operator never opens cTrader for daily operations. Positions, manual orders, strategy controls, emergency stop, config changes — all in the UI.

## 3.12 Live safety
- Pre-trade risk checks before every order
- Emergency stop closes all positions in <10 seconds
- Strategy heartbeat; loss of heartbeat pauses strategy
- Connection loss triggers managed-only mode
- Crash recovery on restart: reconcile against broker, resume or alert

---

# 4. Project Structure

## 4.1 Stack (locked)

- **Language:** TypeScript strict mode
- **Runtime:** Node.js 20 LTS
- **Database:** PostgreSQL 16 + TimescaleDB
- **Monorepo:** pnpm workspaces
- **ORM:** Drizzle
- **Testing:** Vitest
- **Logging:** Pino
- **Config:** Zod-validated environment variables
- **cTrader:** `@reiryoku/ctrader-layer` (or current best npm equivalent — agent may select)
- **HTTP/WS server:** agent picks (Fastify or Hono recommended)
- **Web UI framework:** agent picks (Next.js, Remix, or SvelteKit)
- **UI components:** shadcn/ui
- **Charts:** Recharts
- **Process management:** PM2 on DigitalOcean

## 4.2 Repository organization

Packages:
- `core` — types, interfaces, utilities
- `data` — ingestion, storage, validation
- `adapters` — data feed and execution adapter implementations
- `strategies` — strategy modules
- `engine` — TradingSystem event loop (mode-agnostic)
- `metrics` — performance calculation
- `orchestrator` — multi-strategy aggregation
- `risk` — account-level risk management
- `reporting` — result formatting
- `web` — UI application
- `cli` — command-line operations

## 4.3 Naming

- Files match exported entity
- Strategy IDs: kebab-case ('asian-range-sweep')
- Instrument IDs: uppercase, no separator ('EURUSD', 'XAUUSD')
- Timeframes: 'm1', 'm5', 'h1', 'd1'
- Directions: 'long', 'short'
- DB tables: snake_case, singular

## 4.4 Configuration

All values from env vars, validated by Zod on startup. No magic numbers.

Replit handles secrets natively at platform level — no application-level secrets management needed.

```typescript
SystemConfig {
  mode: 'backtest' | 'live'
  database: { connectionString }
  
  backtest?: {
    startDate, endDate
    instruments: string[]
    timeframes: ('m1'|'m5'|'h1'|'d1')[]
    initialEquityUsd: number
    frictionProfile: 'pepperstone_razor' | 'zero_friction' | 'pessimistic'
    randomSeed: number
  }
  
  live?: {
    accountType: 'demo' | 'live'
    ctraderClientId, ctraderClientSecret
    ctraderAccessToken, ctraderRefreshToken
    ctraderAccountId: number
    instrumentsTraded: string[]
  }
  
  strategies: StrategyConfig[]
  orchestratorMode: 'equal_weight' | 'risk_parity' | 'regime_switched'
  riskConfig: RiskConfig
  logLevel: 'trace'|'debug'|'info'|'warn'|'error'
}

RiskConfig (all percentages):
  riskPerTradePct: 1.5
  maxTotalOpenRiskPct: 6.0
  maxCorrelatedClusterPct: 4.0
  maxMarginUtilizationPct: 25.0
  dailyLossLimitPct: 4.0
  weeklySoftAlertPct: 6.0
  weeklyHardHaltPct: 12.0
  monthlySoftAlertPct: 8.0
  monthlyHardHaltPct: 15.0
  drawdownSoftReducePct: 10.0
  drawdownEmergencyStopPct: 20.0
  drawdownRebuildRequiredPct: 25.0
```

## 4.5 Database access
- Schema in code via Drizzle
- Migrations auto-run on startup
- Type-safe queries
- Connection pooling (10 default)
- Transactions for multi-step writes

## 4.6 Logging
- Pino structured JSON
- Levels: trace, debug, info, warn, error
- Production: info+; Development: debug+

## 4.7 Error handling
- User errors → warn level, clear message
- System errors → error level with stack, graceful fallback
- Broker errors → specific handling per class
- Never silent failures

## 4.8 Testing
- Unit tests against published mathematical reference values (Wilder's indicators) and Pepperstone Razor published fee schedule
- Integration tests using real historical data from the database
- Integration tests using real Pepperstone demo account for live mode
- Determinism tests for backtest
- 80%+ coverage on critical paths

All tests run against real data and real services. Tests requiring credentials use the demo account.

---

# 5. Data Models

## 5.1 Core types

### Bar
```typescript
{
  instrument: string
  timeframe: 'm1'|'m5'|'h1'|'d1'
  timestampUtc: Date  // start of bar
  open, high, low, close, volume: number
  source: 'historical' | 'live'
}
```
Constraints: high >= max(open,close,low); low <= min(open,close,high); volume >= 0.

### MarketState
```typescript
{
  currentBar: Bar
  instrument: string
  recentBars: Bar[]  // ~500 bars typically
  indicators: {
    atr14, atr20, adx14,
    sma20, sma50, sma100, sma200,
    ema20, ema50,
    rsi14,
    bbUpper20, bbMiddle20, bbLower20,
    atrPercentile60,
    pastReturn252,
    rollingHigh20, rollingHigh55,
    rollingLow20, rollingLow55
  }
  sessionContext: {
    asianHigh, asianLow
    currentSession: 'asia'|'london'|'ny'|'overlap'|'closed'
    secondsToSessionClose: number
    isInNewsWindow: boolean
  }
  currentPositions: Position[]  // this strategy's own
  accountEquity: number  // current USD
  now: Date  // per Clock
}
```

### Signal
```typescript
{
  id: UUID
  originatingStrategy: string
  instrument: string
  direction: 'long'|'short'
  proposedEntryPrice, proposedStopPrice, proposedTargetPrice: number
  proposedSizeFractionOfAllocation: number  // 0-1
  urgencyScore: number  // 0-1
  signalType: string
  entryReason: string
  generatedAtBar: Date
  metadata: object
}
```

### Position
```typescript
{
  id: UUID
  sessionId: UUID
  originatingSignalId: UUID
  originatingStrategy: string
  instrument: string
  direction: 'long'|'short'
  entryPrice: number
  entryTime: Date
  currentStopPrice, currentTargetPrice: number
  lotSize: number
  notionalUsd: number
  initialRiskPct: number  // % of account at entry
  initialRiskUsd: number  // $ at entry
  frictionPaidUsd: { spread, slippage, commission, swap }
  unrealizedPnLUsd, unrealizedPnLPct: number
  brokerOrderId, brokerPositionId: string | null  // live only
}
```

### Trade
All Position fields plus:
```typescript
{
  exitPrice: number
  exitTime: Date
  exitReason: 'target'|'stop'|'be_stop'|'time_stop'|'session_close'
            |'signal_flip'|'orchestrator_close'|'manual_close'
            |'emergency_stop'|'data_end'
  realizedPnLUsd: number
  realizedPnLPct: number  // % of account at entry
  realizedRMultiple: number
  totalFrictionUsd: { spread, slippage, commission, swap }
  holdDurationMinutes: number
}
```

### Session
A backtest run OR live session.
```typescript
{
  id: UUID
  createdAt, endedAt: Date
  mode: 'backtest'|'live'
  sessionType: 'single_backtest'|'walk_forward_window'|'parameter_sweep_instance'
              |'orchestrator_backtest'|'live_demo'|'live_real'
  parentSessionId: UUID | null
  codeVersion: string  // git SHA
  dataIntegrityHash: string | null  // backtest
  instruments: string[]
  timeframes: string[]
  dateRangeFrom, dateRangeTo: Date
  strategies: { name, config }[]
  orchestratorMode: 'equal_weight'|'risk_parity'|'regime_switched'
  frictionConfig: object | null  // backtest
  randomSeed: bigint
  initialEquityUsd, currentEquityUsd: number
  riskConfig: object
  aggregateMetrics: object | null
  tradeCount: number
  status: 'pending'|'running'|'completed'|'failed'|'halted'|'emergency_stopped'
  haltReason, errorDetails: string | null
  accountType, brokerAccountId: string | null  // live
}
```

## 5.2 Database schema

### `bar` (TimescaleDB hypertable, 1-month chunks)
```
instrument        text not null
timeframe         text not null
timestamp_utc     timestamptz not null
open, high, low, close  numeric(18,6) not null
volume            numeric(18,2) not null default 0
source            text not null default 'historical'

PK: (instrument, timeframe, timestamp_utc)
Indexes: (instrument, timeframe), (timestamp_utc)
```

### `session`
```
id                       uuid PK
created_at, ended_at     timestamptz
mode                     text not null check (in 'backtest', 'live')
session_type             text not null
parent_session_id        uuid nullable references session(id)
code_version             text not null
data_integrity_hash      text nullable
instruments              text[] not null
timeframes               text[] not null
date_range_from, date_range_to  timestamptz
strategies               jsonb not null
orchestrator_mode        text not null
friction_config          jsonb nullable
random_seed              bigint not null
initial_equity_usd, current_equity_usd  numeric(18,2) not null
risk_config              jsonb not null
aggregate_metrics        jsonb nullable
trade_count              integer not null default 0
status                   text not null default 'pending'
halt_reason, error_details  text nullable
account_type, broker_account_id  text nullable

Indexes: (created_at desc), (mode, status), (session_type)
```

### `signal_log` (hypertable on generated_at_bar)
```
id                       uuid PK
session_id               uuid not null references session(id)
originating_strategy     text not null
instrument               text not null
direction                text not null
proposed_entry_price, proposed_stop_price, proposed_target_price  numeric(18,6)
proposed_size_fraction, urgency_score  numeric(5,4)
signal_type              text not null
entry_reason             text
generated_at_bar         timestamptz not null
became_trade_id          uuid nullable references trade(id)
rejected_reason          text nullable
metadata                 jsonb

Indexes: (session_id), (generated_at_bar)
```

### `trade` (hypertable on entry_time)
```
id                       uuid PK
session_id               uuid not null references session(id)
originating_signal_id    uuid not null
originating_strategy     text not null
instrument, direction    text not null
entry_price, exit_price  numeric(18,6) not null
entry_time, exit_time    timestamptz not null
exit_reason              text not null
lot_size                 numeric(10,4) not null
notional_usd             numeric(18,2) not null
initial_risk_pct, realized_pnl_pct, realized_r_multiple  numeric(10,4) not null
initial_risk_usd, realized_pnl_usd  numeric(18,2) not null
initial_stop_price, initial_target_price  numeric(18,6) not null
total_friction_usd       jsonb not null
hold_duration_minutes    integer not null
metadata                 jsonb not null

Indexes: (session_id), (entry_time)
```

### `order_log` (live order tracking)
```
id                       uuid PK
session_id               uuid not null references session(id)
created_at               timestamptz not null default now()
originating_signal_id    uuid nullable references signal_log(id)
order_type, instrument   text not null
direction                text nullable
lot_size                 numeric(10,4) nullable
price                    numeric(18,6) nullable
broker_order_id          text nullable
status                   text not null
fill_price               numeric(18,6) nullable
fill_time                timestamptz nullable
rejection_reason         text nullable
metadata                 jsonb
```

### `account_snapshot` (every 5 min in live)
```
id                       uuid PK
session_id               uuid not null references session(id)
captured_at              timestamptz not null
equity_usd, balance_usd, margin_used_usd, margin_free_usd  numeric(18,2) not null
open_positions_count     integer not null
total_open_risk_pct      numeric(6,3) not null
unrealized_pnl_usd       numeric(18,2) not null
unrealized_pnl_pct       numeric(6,3) not null

Index: (session_id, captured_at desc)
```

### `data_validation_issue`
```
id                       uuid PK
detected_at              timestamptz not null default now()
instrument, timeframe    text not null
issue_type               text not null
severity                 text not null check (in 'info','warn','error')
description              text not null
affected_time_range_start, affected_time_range_end  timestamptz nullable

Index: (instrument, timeframe)
```

### `audit_event`
```
id                       uuid PK
created_at               timestamptz not null default now()
session_id               uuid nullable references session(id)
severity                 text not null
category                 text not null
description              text not null
metadata                 jsonb
acknowledged_at          timestamptz nullable

Indexes: (session_id, created_at desc), (category), (severity)
```

### `config_setting` (runtime-changeable with audit)
```
key                      text PK
value                    jsonb not null
updated_at               timestamptz not null default now()
updated_by               text not null  -- 'system' or user
previous_value           jsonb nullable
```

---

# 6. Friction Model (Backtest)

Applies only in backtest. Live mode uses actual broker fills.

## 6.1 Components
1. Spread (entry + exit)
2. Slippage (entry + exit, news amplified)
3. Commission ($7/lot round-turn Pepperstone Razor)
4. Swap (overnight, triple Wednesday)

## 6.2 Spread base values (pips, Pepperstone Razor)

| Instrument | Mean | Std | Min | Max |
|-----------|------|-----|-----|-----|
| EURUSD | 0.15 | 0.10 | 0.0 | 0.5 |
| GBPUSD | 0.25 | 0.15 | 0.0 | 0.8 |
| USDJPY | 0.20 | 0.10 | 0.1 | 0.5 |
| USDCHF | 0.30 | 0.15 | 0.1 | 0.8 |
| AUDUSD | 0.25 | 0.15 | 0.0 | 0.7 |
| USDCAD | 0.30 | 0.20 | 0.1 | 0.9 |
| NZDUSD | 0.35 | 0.20 | 0.1 | 1.0 |
| EURJPY | 0.50 | 0.25 | 0.2 | 1.2 |
| GBPJPY | 0.80 | 0.40 | 0.3 | 2.0 |
| EURGBP | 0.40 | 0.20 | 0.1 | 1.0 |
| XAUUSD | 12 | 8 | 5 | 40 (cents) |
| XAGUSD | 25 | 12 | 10 | 60 (cents) |
| BRENTCMDUSD | 3 | 2 | 1 | 10 (cents) |
| LIGHTCMDUSD | 3 | 2 | 1 | 10 (cents) |

For unlisted: default 0.4 mean / 0.25 std / 0.1 min / 1.0 max pips.

## 6.3 Time-of-day multipliers
```
00:00-07:00 UTC  1.2x  (Asian)
07:00-08:00 UTC  1.1x  (London open)
08:00-16:00 UTC  1.0x  (London active)
16:00-17:00 UTC  1.0x  (NY/London overlap)
17:00-21:00 UTC  1.1x  (NY)
21:00-22:00 UTC  1.5x  (low liquidity)
22:00-23:00 UTC  2.0x  (rollover)
23:00-00:00 UTC  1.3x  (post-rollover)
```

## 6.4 News window widening

Major events: FOMC, NFP, US CPI, ECB, BoE. Stored in `data/news_events.json` with real dates 2020-2026.

Within ±15min of major event: spread multiplier = 5 + uniform(0,5) (seeded RNG).

## 6.5 Spread sampling

For each fill:
```
spread_pips = max(min_spread, normal(mean × tod_mult × news_mult, std_dev))
```
Uses session seeded RNG.

## 6.6 Slippage

```
normalized_atr = clamp(current_bar_atr14 / median_atr14_60d, 0.1, 5.0)

if order_type == 'stop':
  base_slippage = 0.3 + 0.5 × normalized_atr
else:
  base_slippage = 0.1 + 0.2 × normalized_atr

if in_news_window:
  slippage = base_slippage × (3 + uniform(0, 10))
else:
  slippage = base_slippage
```

Direction: always reduces P&L.

## 6.7 Commission

Pepperstone Razor: $7 per round-turn standard lot for FX.
```
commission_usd = 7.0 × lot_size_standard
```

Metals/oil: same $7 per Pepperstone lot (lot sizes differ — XAUUSD 100oz, oil 100bbl).

## 6.8 Swap (per standard lot per night USD)

| Instrument | Long | Short |
|-----------|------|-------|
| EURUSD | -5.50 | +1.20 |
| GBPUSD | -4.20 | +0.80 |
| USDJPY | +3.50 | -7.20 |
| USDCHF | +2.10 | -5.80 |
| AUDUSD | -3.80 | +0.50 |
| USDCAD | +1.50 | -4.50 |
| NZDUSD | -3.20 | +0.40 |
| EURJPY | -2.00 | -3.50 |
| GBPJPY | -1.50 | -3.00 |
| EURGBP | -1.80 | -0.50 |
| XAUUSD | -6.50 | -5.20 |
| XAGUSD | -2.50 | -1.80 |
| BRENTCMDUSD | -2.80 | -2.20 |
| LIGHTCMDUSD | -2.80 | -2.20 |

For unlisted: default -3.00 long, -3.00 short.

Triple swap Wednesday 22:00 UTC rollover.

## 6.9 Currency conversion

Non-USD-quote pairs: `pnl_usd = pnl_quote / quote_to_usd_rate × (1 - 0.001)` (10bps conversion spread).

## 6.10 Profiles

- `pepperstone_razor` (default)
- `zero_friction` (all costs = 0)
- `pessimistic` (1.5x spreads, 2x slippage, 1.2x commission, 1.5x swap)

---

# 7. Execution Model (Live)

Actual costs from broker fills. System queries cTrader for fills and records realized cost components.

## 7.1 Order types
- Market, Limit, Stop
- Server-side SL and TP (broker-managed — protects against system crash)

System uses server-side stops by default.

## 7.2 Order lifecycle

```
Strategy → Signal
  → RiskManager validates
  → Orchestrator applies allocation
  → ExecutionAdapter.submitOrder()
  → cTrader returns broker order ID
  → Status: 'pending'
  → On fill: status 'filled', record fill price
  → Place server-side SL and TP
  → Position opened in internal state
  → Tracked until SL/TP hit OR strategy closes OR manual close
  → On exit: trade record with realized P&L
```

## 7.3 Position reconciliation

Every 60s: query cTrader for all open positions, compare against internal state.

On mismatch:
- Log `reconciliation_mismatch` audit event
- If significant: pause strategies, alert operator
- Reconciliation continues regardless

Mismatch causes: network drop during submission, broker-side auto-close, manual intervention outside our UI.

## 7.4 Connection management

- WebSocket maintained continuously
- Heartbeat every 30s (cTrader requirement)
- Disconnect: exponential backoff (1s, 2s, 4s, 8s, 16s, 32s, 60s)
- During disconnect: no new orders; server-side stops at broker still protect
- On reconnect: re-authenticate, re-subscribe, immediate reconciliation

## 7.5 Pre-trade checks

1. RiskManager check (all percentage limits)
2. Account equity check (free margin)
3. Symbol availability (not market closed)
4. Spread check (current ≤ 3x normal)
5. Connection health

Any failure → signal rejected, logged, no order submitted.

## 7.6 Order failure handling
- Rejection: logged, signal marked not-traded
- Partial fill: position size adjusted, stops recomputed
- Connection drop during submission: on reconnect query order status to determine actual state

## 7.7 Emergency stop

When triggered:
1. Halt all strategies (no new signals)
2. Cancel all pending orders
3. Close all open positions at market
4. Target: complete in <10 seconds
5. Audit log entry with reason and operator

Must work even if some strategies unresponsive.

---

# 8. Statistical Methodology

## 8.1 Metrics

Trade-level:
- N trades
- Win rate with Wilson 95% CI
- Expectancy with SE
- Avg win R, avg loss R
- Profit factor
- R distribution percentiles (10, 25, 50, 75, 90)

Equity-level:
- Total return $ and %
- CAGR
- Max DD $ and %, duration days
- Calmar
- Sharpe with bootstrap 95% CI (1000+ resamples)
- Sortino
- Daily/weekly/monthly returns

Trade efficiency:
- Avg hold duration
- Time in market %
- Trades per day/week/month

Risk:
- Avg risk per trade %
- Avg leverage utilization
- Avg margin utilization

Multi-strategy:
- Per-strategy attribution
- Pairwise correlation matrix
- Diversification ratio

## 8.2 Walk-forward

Rolling train/test:
- `train_months` (default 12)
- `test_months` (default 3)
- `step_months` (default = test_months)

Per window: IS backtest + OOS backtest as child sessions.

Parent session aggregates OOS across windows.

WF consistency = mean(OOS Sharpe) / mean(IS Sharpe).

## 8.3 Bootstrap CI

Sharpe: resample daily returns with replacement 1000+ times, compute Sharpe per resample, report 2.5/97.5 percentiles. Seeded RNG.

## 8.4 Wilson CI

```
z = 1.96 for 95%
center = (p + z²/(2n)) / (1 + z²/n)
margin = z × sqrt(p(1-p)/n + z²/(4n²)) / (1 + z²/n)
ci = [center - margin, center + margin]
```

## 8.5 Monte Carlo trade reshuffling

After every completed session: shuffle trade sequence 1000+ times, compute distribution of:
- Final equity
- Max DD
- Longest losing streak

Report 5/50/95 percentiles. Seeded RNG.

## 8.6 Multiple-comparison correction

Parameter sweeps: Bonferroni adjusted threshold = 0.05 / N combinations.

Combinations that look good but don't survive correction flagged as "within noise of N tested."

## 8.7 Determinism

All stochastic uses seeded RNG. Child sessions: `child_seed = hash(parent_seed, child_index)`.

---

# 9. Build Phases

25 phases. Each = one Replit Power Mode session.

- Phases 1-4: Foundation
- Phases 5-9: Backtest engine
- Phases 10-14: Validation tools and strategies
- Phases 15-17: Live infrastructure (code only, no broker connection yet)
- Phase 18: cTrader application creation + OAuth + first connection verification
- Phase 19: Runtime configuration and manual operations
- Phases 20-22: Operational UI
- Phases 23-25: Production validation

---

## 9.1 Phase 1: Project Skeleton

**Goal:** Empty monorepo that builds, tests, runs.

**Tasks:**
- pnpm monorepo with packages from section 4.2
- TypeScript strict mode across all packages
- ESLint strict, Prettier, Vitest workspace
- `.env.example` documenting required vars (NODE_ENV, DATABASE_URL, LOG_LEVEL, MODE, BACKTEST_*, CTRADER_*)
- Pino logger in core package
- Zod config validator with mode-conditional schema per section 4.4
- Root scripts: dev, build, test, lint, typecheck
- README.md with setup and doc reference

**Verification:**
- `pnpm install`, `build`, `test`, `lint`, `typecheck` all pass
- Logger writes structured JSON
- Config validator accepts valid configs, rejects invalid with clear errors
- MODE=backtest requires backtest fields; MODE=live requires live fields

**Agent Brief:**
```
Build the project skeleton for a systematic trading system (backtest + live modes).

REFERENCE: Read sections 1-4 of trading_system_docs.md for full context.

KEY CONCEPT: One system, two modes (backtest, live). Mode selected at startup via
config. Same code paths, different adapters injected at boundaries.

DELIVERABLES THIS SESSION (Phase 1):

1. pnpm monorepo with packages: core, data, adapters, strategies, engine, metrics,
   orchestrator, risk, reporting, web, cli

2. TypeScript strict mode in every package

3. ESLint (strict), Prettier configured at root

4. Vitest with workspace support

5. .env.example documenting all env vars per section 4.4 of project docs

6. Pino logger in core package (structured JSON, levels: trace/debug/info/warn/error)

7. Zod configuration validator in core package implementing SystemConfig schema
   per section 4.4. Mode-conditional: backtest fields required when MODE=backtest,
   live fields required when MODE=live.

8. Root scripts: dev, build, test, lint, typecheck

9. README.md with setup instructions and reference to this doc

CONSTRAINTS:
- TypeScript strict mode mandatory; no `any` without comment justifying
- No console.log; use structured logger
- All env vars validated on startup with clear errors

VERIFICATION:
- Run pnpm install, build, test, lint, typecheck — all pass
- Show directory tree
- Show sample logger output
- Show config validation: valid accepts, missing required rejects clearly
- Show mode-conditional validation
```

---

## 9.2 Phase 2: Database Setup

**Goal:** Drizzle ORM, migrations, type-safe access. All tables from section 5.2.

**Tasks:**
- Add Drizzle ORM and node-postgres
- Activate TimescaleDB extension via migration
- Schema for: bar (hypertable), session, signal_log (hypertable), trade (hypertable), order_log, account_snapshot, data_validation_issue, audit_event, config_setting
- Migrations auto-run on startup
- Query layer in `data` package: repositories for each table
- Connection pooling (10 default)
- Health check function
- Unit tests against real test database

**Verification:**
- Migrations run on fresh DB
- All tables exist with correct schema and indexes
- TimescaleDB hypertables confirmed
- Round-trip insert/query works for each
- Health check returns true
- Unit tests pass

**Agent Brief:**
```
Set up the database layer with Drizzle ORM.

REFERENCE: Read section 5 (data models and full schema in section 5.2).

DELIVERABLES THIS SESSION (Phase 2):

1. Add Drizzle ORM and node-postgres dependencies

2. Activate TimescaleDB extension via migration

3. Define schema for all tables per section 5.2 of project docs:
   - bar (hypertable, 1-month chunks)
   - session, signal_log (hypertable), trade (hypertable)
   - order_log, account_snapshot
   - data_validation_issue, audit_event, config_setting

4. Migrations auto-run on startup

5. Type-safe query layer in `data` package with repositories for each table:
   - barRepo, sessionRepo, signalLogRepo, tradeRepo, orderLogRepo,
     accountSnapshotRepo, validationIssueRepo, auditEventRepo, configSettingRepo

6. Connection pooling

7. Health check function

8. Unit tests against REAL test database (no mocking — Replit's environment
   provides PostgreSQL+TimescaleDB)

CONSTRAINTS:
- All queries type-safe via Drizzle
- Prices use numeric(18,6); USD amounts numeric(18,2)
- Migrations idempotent
- Connection failures handled with retry

VERIFICATION:
- Migrations run on fresh DB
- Show schema (\d+ each table) and TimescaleDB hypertables
- Demonstrate round-trip insert/query for bar, session, trade, signal_log, audit_event
- All unit tests pass against real DB
```

---

## 9.3 Phase 3: Historical Data Ingestion

**Goal:** Load 5 years of daily data for the FULL Dukascopy instrument universe (~30+ instruments). Load 6 months of M1 for the active trading subset.

**Tasks:**
- Add `dukascopy-node` npm package
- Implement `ingest(instrument, timeframe, from, to)` in `data` package
- Bulk insert with ON CONFLICT DO NOTHING (idempotent)
- Progress reporting (every 100 days for daily, every 1000 minutes for M1)
- Retry on errors with exponential backoff
- Validation pipeline (gaps, OHLC sanity, magnitude, zero-volume) persisting to `data_validation_issue`
- Default ingestion: full universe per section 14
- CLI commands: `ingest:full`, `ingest:asset`, `ingest:incremental`, `ingest:report`
- Post-ingestion summary

**Verification:**
- `pnpm ingest:full` completes (1-3 hours expected)
- Bar counts match expectations (~1300 daily/instrument over 5yr; ~130 weekdays × 1440min for M1)
- Validation reports zero errors on clean data
- Spot-check EURUSD daily 2025-12-15 against public reference

**Agent Brief:**
```
Load 5 years of historical data into TimescaleDB for the FULL Dukascopy universe.

REFERENCE: Section 14 (asset universe) for the complete instrument list.

GOAL: Build the persistent database backing all future research. Once loaded,
strategies fetch from DB, not from Dukascopy at runtime. Loading the full asset
universe means we can scale up the trading universe without re-downloading.

DELIVERABLES THIS SESSION (Phase 3):

1. Add dukascopy-node npm package

2. Implement ingest(instrument, timeframe, from, to) in `data` package:
   - Pulls via dukascopy-node
   - Bulk insert with ON CONFLICT DO NOTHING (idempotent)
   - Progress reporting
   - Retry on errors

3. Default ingestion: 

   Daily (2020-01-01 to 2026-05-12) for the COMPLETE Dukascopy instrument universe
   per section 14:
   - All FX majors and crosses (~25 pairs)
   - Metals: XAUUSD, XAGUSD
   - Energy: BRENTCMDUSD, LIGHTCMDUSD
   - Major stock indices
   - Major cryptos (BTCUSD, ETHUSD if available)
   
   M1 (2025-11-01 to 2026-05-12) for active trading universe:
   EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, USDCAD, XAUUSD, BRENTCMDUSD

4. Validation pipeline persisting issues to data_validation_issue:
   - Gap detection (missing trading days)
   - OHLC sanity (high >= max, low <= min)
   - Magnitude check (prices in expected ranges per instrument category)
   - Zero-volume flagging

5. CLI commands: pnpm ingest:full, ingest:asset, ingest:incremental, ingest:report

6. Post-ingestion summary report

CONSTRAINTS:
- All timestamps UTC
- Daily bars at 00:00:00 UTC; M1 at minute start
- Idempotent re-runs
- Validation issues persisted

VERIFICATION:
- Run small test first (EURUSD daily for one year) — verify pipeline works
- Then pnpm ingest:full (will take 1-3 hours; run in background)
- After completion: show counts per instrument/timeframe
- Validate one date (EURUSD daily 2025-12-15) against public source
- Show validation report summary
- Report DB disk space used
```

---

## 9.4 Phase 4: Indicator Library

**Goal:** All technical indicators required by strategies, tested against published reference values.

**Tasks:**
- Implement in `core` or dedicated `indicators` module:
  - `atr(bars, period)` Wilder smoothing
  - `sma(values, period)`
  - `ema(values, period)` multiplier = 2/(period+1)
  - `rsi(closes, period)` Wilder smoothing
  - `adx(bars, period)` with +DI, -DI
  - `bollingerBands(closes, period, stdDevs)`
  - `atrPercentile(atrValues, window)`
  - `pastReturn(closes, bars)`
  - `rollingHigh(highs, period)` excluding current
  - `rollingLow(lows, period)` excluding current

- Two patterns: streaming (stateful) and batch (array in/out)
- Return null when insufficient data
- Unit tests against Wilder's "New Concepts in Technical Trading Systems" (1978):
  - ATR: page 23 example
  - RSI: page 65 example
  - ADX: published reference
- Performance: batch 1000 bars in <100ms

**Verification:**
- Unit tests pass against published reference values
- Compute ATR(14) for EURUSD daily Q1 2024 from database, show last 5 values
- Performance benchmark

**Agent Brief:**
```
Implement the indicator library used by strategies.

REFERENCE: Section 5.1 (indicator list in MarketState).

DELIVERABLES THIS SESSION (Phase 4):

1. Indicator functions in core or dedicated indicators module:
   - atr (Wilder smoothing)
   - sma, ema
   - rsi (Wilder smoothing)
   - adx (with +DI, -DI)
   - bollingerBands
   - atrPercentile
   - pastReturn
   - rollingHigh (excluding current bar)
   - rollingLow (excluding current bar)

2. Two access patterns:
   - Streaming: stateful object updated per bar
   - Batch: array in, array out

3. Return null when insufficient data

4. Unit tests against PUBLISHED reference values from Wilder's "New Concepts in
   Technical Trading Systems" (1978):
   - ATR: page 23 example
   - RSI: page 65 example
   - ADX: published reference
   
   These are real published mathematical results, not invented test data.

5. Performance: batch compute 1000 bars in <100ms

CONSTRAINTS:
- Mathematical correctness critical — indicators feed every strategy
- Use exact formulas: Wilder smoothing for ATR/RSI/ADX (not simple averaging)
- Deterministic
- Rolling high/low EXCLUDES current bar

VERIFICATION:
- All unit tests pass against published reference values
- Compute ATR(14) for EURUSD daily Q1 2024 (real data from Phase 3), show last 5
- Benchmark numbers
```

---

## 9.5 Phase 5: Core Interfaces and TradingSystem Skeleton

**Goal:** Define boundary interfaces. Most important phase — if these are wrong, every subsequent phase requires refactor.

**Tasks:**

T5.1. `MarketDataFeed` interface in `core`:
```typescript
interface MarketDataFeed {
  subscribe(instrument: string, timeframe: Timeframe): AsyncIterable<Bar>
  getHistoricalBars(instrument, timeframe, from, to): Promise<Bar[]>
  getCurrentBar(instrument, timeframe): Bar | null
  isConnected(): boolean
  start(): Promise<void>
  stop(): Promise<void>
}
```

T5.2. `ExecutionAdapter` interface:
```typescript
interface ExecutionAdapter {
  submitOrder(order: OrderRequest): Promise<OrderResult>
  cancelOrder(orderId: string): Promise<void>
  modifyOrder(orderId: string, updates: OrderUpdate): Promise<OrderResult>
  closePosition(positionId: string): Promise<OrderResult>
  getOpenPositions(): Promise<Position[]>
  getAccountInfo(): Promise<AccountInfo>
  subscribeOrderUpdates(): AsyncIterable<OrderUpdate>
  start(): Promise<void>
  stop(): Promise<void>
  isConnected(): boolean
}
```

T5.3. `Clock` interface:
```typescript
interface Clock {
  now(): Date
  sleep(ms: number): Promise<void>
}
```

T5.4. `Strategy` interface:
```typescript
interface Strategy {
  readonly name: string
  readonly config: StrategyConfig
  initialize(context: StrategyContext): Promise<void>
  generateSignals(state: MarketState): Promise<Signal[]>
  updateState(state: MarketState): Promise<void>
  onPositionEvent(event: PositionEvent): Promise<void>
  getOpenPositions(): Position[]
  shutdown(): Promise<void>
}
```

T5.5. Supporting types: `OrderRequest`, `OrderResult`, `OrderUpdate`, `AccountInfo`, `PositionEvent`, `StrategyContext`, `MarketState`.

T5.6. `TradingSystem` class in `engine` with bar-by-bar event loop:
```
while not stopped:
  bar = await dataFeed.next()
  indicators = computeIndicators(recentBars, bar)
  state = buildMarketState(bar, indicators, sessionContext, openPositions, equity, clock.now())
  
  // Check open positions for exits
  for each open position:
    if shouldExit(position, bar):
      await execution.closePosition(position.id)
  
  // Strategy signals
  signals = []
  for each strategy:
    signals.push(...await strategy.generateSignals(state))
  
  // Orchestrator + risk
  aggregatedOrders = orchestrator.process(signals, currentState)
  for each order in aggregatedOrders:
    if riskManager.canExecute(order, accountState):
      result = await execution.submitOrder(order)
      auditLog.recordSignal(order.signal, becameTrade=true, brokerOrderId=result.id)
    else:
      auditLog.recordSignal(order.signal, becameTrade=false, rejectedReason)
  
  // Strategy state updates
  for each strategy:
    await strategy.updateState(state)
  
  // Metrics + periodic snapshots
  metrics.update(state, closedTradesThisBar)
  if mode === 'live' && shouldSnapshot():
    await saveAccountSnapshot(await execution.getAccountInfo())
```

T5.7. Composition root `buildSystem(config)` per section 1.4.

T5.8. Integration test using real historical data: stub strategy returning no signals runs through 1 year EURUSD daily without errors.

**Verification:**
- All interfaces compile with strict TS
- buildSystem selects correct adapters by mode
- Stub strategy runs through real historical data without errors
- All wiring uses interfaces from this phase

**Agent Brief:**
```
Define the boundary interfaces. THIS IS THE MOST IMPORTANT PHASE — if interfaces
are wrong, every subsequent phase has to be refactored.

REFERENCE: Section 1 (architecture, mode parity), section 5 (data models).

CONCEPT: Three boundary interfaces define what differs between backtest and live:
MarketDataFeed, ExecutionAdapter, Clock. Everything else is mode-invariant.

DELIVERABLES THIS SESSION (Phase 5):

1. MarketDataFeed interface per section 9.5 T5.1
2. ExecutionAdapter interface per T5.2
3. Clock interface per T5.3
4. Strategy interface per T5.4
5. Supporting types: OrderRequest, OrderResult, OrderUpdate, AccountInfo,
   PositionEvent, StrategyContext, MarketState per section 5.1
6. TradingSystem class in engine package with bar-by-bar event loop per T5.6
7. Composition root buildSystem(config) per section 1.4
8. Integration test using REAL historical data: stub strategy that returns no
   signals processes 1 year of EURUSD daily without errors

CRITICAL CONSTRAINTS:
- All interfaces async-first (live mode requires this)
- TradingSystem code IDENTICAL regardless of mode — no `if mode === 'live'`
  anywhere except composition root
- Interfaces work for intraday (M1) and multi-day (daily) strategies
- Strategy never knows mode

NON-GOALS THIS PHASE:
- Actual HistoricalDataFeed (Phase 6)
- Actual SimulatedExecutionAdapter (Phase 7)
- cTrader adapters (Phases 16-17)
- Strategy implementations (Phase 11)

For the integration test, use placeholder/empty implementations of the adapters
that just yield bars from the DB sequentially and accept orders without doing
anything. Real implementations come in next phases.

VERIFICATION:
- All interfaces compile with strict TypeScript
- TradingSystem instantiates
- buildSystem(config) selects correct adapter implementations
- Stub test runs through real data without errors
- Show all interface definitions
```

---

## 9.6 Phase 6: Historical Data Feed (Backtest Mode)

**Goal:** Implement `MarketDataFeed` for backtest by reading TimescaleDB.

**Tasks:**
- `HistoricalDataFeed` class in `adapters` implementing MarketDataFeed
- Constructor: db connection + config (instruments, timeframes, date range)
- `subscribe()` yields bars chronologically, only where `bar.timestampUtc <= clock.now()` (no-lookahead enforced architecturally)
- `getHistoricalBars()` cursor-based query for indicator warmup
- `getCurrentBar()` returns most recently yielded bar
- Multi-instrument: interleave by timestamp
- Memory efficient: stream from DB, no full loads
- Performance: 5yr daily across 30+ instruments in <30s

**Verification:**
- Interface conformance verified by TypeScript
- Subscribe to EURUSD daily 2024, iterate, verify chronological order
- Multi-instrument subscription interleaves correctly
- No bars beyond clock.now() ever yielded
- Performance benchmark on real DB

**Agent Brief:**
```
Implement HistoricalDataFeed (backtest mode's data feed).

REFERENCE: Section 1.3, section 3.9 (no lookahead).

CONTEXT: One of two MarketDataFeed implementations. Reads from TimescaleDB and
yields bars chronologically. CTraderDataFeed (Phase 16) is the other.

DELIVERABLES THIS SESSION (Phase 6):

1. HistoricalDataFeed class in adapters package implementing MarketDataFeed
2. Constructor: database + config (instruments, timeframes, dateRange)
3. subscribe(): yields bars chronologically, respects clock.now() for no-lookahead
4. getHistoricalBars(): cursor-based query
5. getCurrentBar(): returns last yielded
6. Multi-instrument: interleave by timestamp
7. Memory efficient: stream from DB
8. Performance: 5-year daily across 30+ instruments in <30s

CONSTRAINTS:
- Must conform exactly to MarketDataFeed interface
- Clock determines current time; never yield bars beyond clock.now()
- Database is read-only from this adapter

VERIFICATION (using real data from Phase 3):
- Unit tests confirm interface conformance
- Subscribe EURUSD daily 2024, verify chronological order
- Multi-instrument: EURUSD + GBPUSD, verify interleaved
- Lookahead test: confirm no bars beyond clock.now()
- Performance benchmark
```

---

## 9.7 Phase 7: Friction Model and Simulated Execution Adapter

**Goal:** Implement `ExecutionAdapter` for backtest with realistic friction.

**Tasks:**
- `FrictionModel` class in `adapters` per section 6
- Three profiles: `pepperstone_razor` (default), `zero_friction`, `pessimistic`
- All deterministic with seeded RNG
- `data/news_events.json` with REAL historical dates for FOMC, NFP, US CPI, ECB, BoE 2020-2026 (researched from public sources)
- `SimulatedExecutionAdapter` implementing `ExecutionAdapter`:
  - In-memory state of positions, orders, equity
  - submitOrder applies friction, simulates fill, opens position
  - Stop/target detection per bar: longs (low ≤ stop, high ≥ target), shorts mirrored, both-hit → assume stop first (conservative)
  - Trade records persisted to DB on close
- Unit tests against published Pepperstone Razor fee schedule

**Verification:**
- Unit tests pass with values matching Pepperstone Razor docs
- Run small backtest with stub "always enter, exit next bar" strategy — friction realistic (~$0.50-2 per 0.1 lot trade)
- Three profiles produce different costs
- Determinism: same seed → identical fills

**Agent Brief:**
```
Implement friction model and simulated execution adapter for backtest mode.

REFERENCE: Section 6 (all friction values), section 7.5 (pre-trade reference).

CONTEXT: SimulatedExecutionAdapter is one of two ExecutionAdapter implementations.
Applies friction model and simulates fills. CTraderExecutionAdapter (Phase 17)
is the other.

DELIVERABLES THIS SESSION (Phase 7):

1. FrictionModel class in adapters per section 6:
   - Three profiles: pepperstone_razor (default), zero_friction, pessimistic
   - All values per section 6 tables
   - Deterministic with seeded RNG

2. data/news_events.json with REAL major events 2020-2026:
   - FOMC (8/year, 18:00 UTC on meeting day) — research actual Fed calendar dates
   - NFP (first Friday of month, 12:30 UTC) — research BLS release dates
   - US CPI (monthly, ~12:30 UTC) — research BLS dates
   - ECB rate (8/year) — research ECB calendar
   - BoE rate (8/year) — research BoE calendar
   
   These are REAL dates from public sources, not invented.

3. SimulatedExecutionAdapter implementing ExecutionAdapter:
   - In-memory positions, orders, equity
   - submitOrder: apply friction, simulate fill, open position
   - cancelOrder, modifyOrder, closePosition
   - getOpenPositions, getAccountInfo, subscribeOrderUpdates

4. Stop/target detection per bar:
   - Longs: bar.low ≤ stop → stop; bar.high ≥ target → target
   - Shorts: bar.high ≥ stop → stop; bar.low ≤ target → target
   - Both possible: assume stop first (conservative — engine doesn't have intra-bar)

5. Trade records persisted to DB on position close

6. Unit tests against published Pepperstone Razor fee schedule

CONSTRAINTS:
- Must conform exactly to ExecutionAdapter interface
- Deterministic with seeded RNG
- Conservative both-hit assumption
- Real news dates from public sources, researched and documented

VERIFICATION:
- Unit tests pass
- Run small backtest: stub strategy "enter at open, exit next bar" on EURUSD
  daily 2024; verify friction costs match Pepperstone Razor expectations
  (~$0.50-2 total per 0.1 lot trade)
- Determinism: run twice, identical
- Show three profiles producing different costs on same trade
```

---

## 9.8 Phase 8: Simulated Clock and Backtest Composition

**Goal:** Complete backtest mode wiring. Run an empty backtest end-to-end.

**Tasks:**
- `SimulatedClock` implementing `Clock`:
  - Advances based on most recently processed bar's timestamp
  - `now()` returns current bar's end-of-period time
  - `sleep()` no-op in backtest
- Complete `buildSystem(config)` for backtest mode (live mode throws "not yet implemented")
- CLI: `pnpm backtest --strategy <name> --instrument <symbol> --timeframe <tf> --from <date> --to <date>`
- Outputs progress, final summary, session ID
- End-to-end test: empty strategy runs through 1 year EURUSD daily

**Verification:**
- buildSystem for backtest returns valid TradingSystem
- Empty backtest over 1 year EURUSD daily completes without errors
- Session record created with all metadata, status='completed'
- All wiring uses Phase 5 interfaces

**Agent Brief:**
```
Wire everything together for backtest mode.

DELIVERABLES THIS SESSION (Phase 8):

1. SimulatedClock implementing Clock:
   - Advances based on bar processing
   - now() returns current bar's timestamp
   - sleep() no-op

2. Complete buildSystem(config) for backtest mode per section 1.4. Live mode
   throws "not yet implemented" for now.

3. CLI: pnpm backtest --strategy <name> --instrument <symbol> --timeframe <tf>
   --from <date> --to <date>
   - Outputs progress (% complete, bars, trades opened/closed)
   - Final summary metrics
   - Returns session ID

4. End-to-end test: empty strategy returns zero signals, runs through 1 year
   EURUSD daily; verify completes without errors

CONSTRAINTS:
- No mode-specific code outside composition root
- TradingSystem unchanged

VERIFICATION:
- buildSystem returns valid TradingSystem for backtest config
- Empty backtest over 1 year EURUSD daily completes without errors
- Session record contains correct metadata, status='completed'
- All wiring uses Phase 5 interfaces
```

---

## 9.9 Phase 9: Metrics Module

**Goal:** All performance metrics with statistical rigor.

**Tasks:**
- `MetricsCollector` in `metrics` package per section 8
- Two modes: final (trades list → metrics) and incremental (update per trade close)
- All metrics from section 8.1
- Bootstrap CI for Sharpe (1000+ resamples, seeded)
- Wilson CI for win rate
- Monte Carlo trade reshuffling auto-runs after every completed session, stored in `session.aggregateMetrics`
- Per-strategy attribution
- Unit tests against documented statistical results (e.g., Wilson CI for n=50, wins=28 → (42.4%, 68.6%))

**Verification:**
- Unit tests pass
- Run backtest, verify aggregate_metrics populated
- Monte Carlo distribution visible in output
- Bootstrap CI width reasonable

**Agent Brief:**
```
Implement the metrics module.

REFERENCE: Section 8 (statistical methodology).

DELIVERABLES THIS SESSION (Phase 9):

1. MetricsCollector in metrics package per section 8.1

2. Two operating modes (same code paths):
   - Final: trades list → all metrics
   - Incremental: update on each new trade

3. All metrics per section 8.1:
   - Trade-level: N, win rate (Wilson CI), expectancy (SE), profit factor, R percentiles
   - Equity: total return, CAGR, max DD, Calmar, Sharpe (bootstrap CI), Sortino,
     monthly returns
   - Trade efficiency: hold duration, time in market, trades/period
   - Per-strategy attribution

4. Bootstrap CI for Sharpe (1000+ resamples, seeded RNG per section 8.3)

5. Wilson CI for win rate per section 8.4

6. Monte Carlo trade reshuffling per section 8.5 auto-runs after sessions complete,
   stored in session.aggregateMetrics

7. Unit tests against documented statistical results

CONSTRAINTS:
- Same calculations in backtest (final) and live (incremental)
- Deterministic with seeded RNG
- Edge cases: zero trades, all wins, all losses
- Per-strategy attribution reconciles to total

VERIFICATION:
- All unit tests pass
- Run small backtest, show full aggregate_metrics
- Incremental updates yield same result as one-shot
- Monte Carlo distribution visible
- Manual spot-check: pick one metric, verify by hand
```

---

## 9.10 Phase 10: Risk Manager and Audit Log

**Goal:** Risk management with percentage-based limits. Comprehensive audit logging.

**Tasks:**
- `RiskManager` in `risk` package
- All percentage-based limits per section 4.4 RiskConfig
- Per-order checks: per-trade risk, total open risk, correlated cluster, margin, drawdown
- Daily/weekly/monthly loss tracking with halts
- Position sizing function that scales with account equity:
```typescript
function computeLotSize(signal, accountEquity, riskConfig, currentDrawdownPct): number {
  const dollarRisk = accountEquity * (riskConfig.riskPerTradePct / 100)
  const stopDistance = Math.abs(signal.proposedEntryPrice - signal.proposedStopPrice)
  const pipValuePerLot = computePipValue(signal.instrument)
  let lotSize = dollarRisk / (stopDistance * pipValuePerLot)
  
  if (currentDrawdownPct > riskConfig.drawdownSoftReducePct) lotSize *= 0.5
  lotSize = Math.round(lotSize * 100) / 100  // 0.01 increment
  if (lotSize < 0.01) return 0
  return lotSize
}
```
- `AuditLog` class with all category methods (recordSignal, recordOrder, recordOrderUpdate, recordTrade, recordStrategyPaused, recordStrategyResumed, recordStrategyKilled, recordRiskLimitHit, recordDrawdownThreshold, recordManualOrder, recordManualClose, recordEmergencyStop, recordConfigChange, recordBrokerDisconnect, recordBrokerReconnect, recordSignalRejected, recordOrderRejected, recordReconciliationMismatch)
- Query API: recentEvents, eventsByCategory, unacknowledgedEvents, acknowledgeEvent
- Unit tests verifying percentage-based scaling

**Verification:**
- Same risk config at $1K vs $10K vs $100K produces proportional positions
- Risk checks reject orders exceeding limits
- Drawdown reduction at thresholds
- Audit events persisted correctly

**Agent Brief:**
```
Implement risk manager (percentage-based) and audit log.

REFERENCE: Section 3.4 (percentages), section 4.4 (RiskConfig), section 5.2
(audit_event table).

DELIVERABLES THIS SESSION (Phase 10):

1. RiskManager in risk package:
   - All percentage-based limits per RiskConfig in section 4.4
   - Per-trade, total open risk, correlated cluster, margin, drawdown checks
   - Daily/weekly/monthly loss tracking
   - Position sizing scaling with account equity per section 9.10 T10.5

2. AuditLog class with all record methods per section 9.10 T10.7

3. Query API: recentEvents, eventsByCategory, unacknowledgedEvents, acknowledgeEvent

4. Unit tests verifying percentage-based scaling

CONSTRAINTS:
- ALL risk parameters are percentages, never dollars
- Position sizing scales linearly with account equity
- RiskManager is source of truth for order execution
- Same code in backtest and live

VERIFICATION:
- Unit tests pass
- Demonstrate: same risk config (1.5%) at $1K, $10K, $100K → lot sizes
  0.01, 0.1, 1.0 (proportional)
- Risk check rejects order exceeding maxTotalOpenRiskPct
- Drawdown circuit breaker triggers at threshold
- Audit log persists events; query API retrieves sorted
```

---

## 9.11 Phase 11: Asian Range Sweep Strategy

**Goal:** First real strategy, end-to-end backtest.

**Tasks:**
- `AsianRangeSweepStrategy` in `strategies` per section 10.1
- All parameters configurable with defaults
- Implements Strategy interface
- Unit tests using REAL M1 data from database for specific historical scenarios
- End-to-end backtest: EURUSD M1 over 2025-11-01 to 2026-05-12
- CLI command

**Verification:**
- Unit tests pass against real M1 data
- End-to-end backtest produces trades
- Determinism: identical results on rerun
- Walk through 3 sample trades manually

**Agent Brief:**
```
Implement Asian Range Sweep strategy and run end-to-end backtest.

REFERENCE: Section 10.1 (Asian Range Sweep algorithmic spec).

DELIVERABLES THIS SESSION (Phase 11):

1. AsianRangeSweepStrategy in strategies package per section 10.1

2. All parameters configurable per defaults in section 10.1

3. Implements Strategy interface from Phase 5

4. Unit tests against REAL M1 data from database (no synthetic):
   - Identify historical dates with valid sweep+reversal patterns
   - Identify dates with too-shallow sweeps
   - Identify dates with too-deep sweeps
   - Verify strategy behavior on each

5. End-to-end backtest: AsianRangeSweep on EURUSD M1 over 2025-11-01 to 2026-05-12

6. CLI: pnpm backtest --strategy asian-range-sweep --instrument EURUSD
   --timeframe m1 --from 2025-11-01 --to 2026-05-12

CONSTRAINTS:
- Uses ONLY Strategy interface
- Same code runs in live mode later (no mode-specific logic)
- Deterministic given seed
- Tests use REAL historical data

VERIFICATION:
- Unit tests pass against real data
- End-to-end backtest produces trade list
- Show 5 sample trades with full details
- Walk through one manually showing engine got it right
- Determinism: rerun → identical trades
- Session aggregate_metrics populated
```

---

## 9.12 Phase 12: Walk-Forward Validation

**Goal:** Rolling train/test window framework.

**Tasks:**
- `WalkForwardRunner` in `engine` or `backtest`
- Configuration: train_months, test_months, step_months, min_trades_per_window
- Algorithm per section 8.2: rolling windows, each window has IS+OOS child sessions linked to parent
- Parent aggregates OOS metrics, computes WF consistency = mean(OOS Sharpe) / mean(IS Sharpe)
- CLI: `pnpm backtest:walkforward`
- Output parent session ID

**Verification:**
- Walk-forward Asian Range Sweep on M1 with adjusted windows (4 train / 1 test for 6mo data)
- Number of windows matches expectation
- IS and OOS metrics per window
- Verify no data leakage

**Agent Brief:**
```
Implement walk-forward validation.

REFERENCE: Section 8.2.

DELIVERABLES THIS SESSION (Phase 12):

1. WalkForwardRunner in engine or backtest package
2. Configuration: train_months (default 12), test_months (default 3),
   step_months (default = test_months), min_trades_per_window (default 30)
3. Algorithm per section 8.2: rolling windows, IS+OOS child sessions linked
   to parent_session_id
4. Parent aggregates OOS, WF consistency computed
5. CLI: pnpm backtest:walkforward --strategy <name> --instrument <symbol>
   --from <date> --to <date> --train-months 12 --test-months 3

CONSTRAINTS:
- No data leakage: OOS data never influences IS metrics
- Child sessions are full Session records

VERIFICATION (using real data):
- Walk-forward Asian Range Sweep on EURUSD M1 2025-11 to 2026-05 with 4 train / 1 test
- Show parent session ID, # windows, per-window IS vs OOS, WF consistency
- Verify manually no data leakage between windows
```

---

## 9.13 Phase 13: Additional Strategies

**Goal:** Donchian Breakout, Trend Following, Bollinger Reversal.

**Tasks:**
- `DonchianBreakoutStrategy` per section 10.2 (variants 20/10 and 55/20)
- `TimeSeriesTrendStrategy` per section 10.3
- `BollingerReversalStrategy` per section 10.4
- Unit tests against real historical data
- Gate 1 validation per strategy

**Verification:**
- Unit tests pass
- Gate 1 reports per strategy

**Agent Brief:**
```
Implement three more strategies.

REFERENCE: Sections 10.2 (Donchian), 10.3 (Trend), 10.4 (Bollinger Reversal).

DELIVERABLES THIS SESSION (Phase 13):

1. DonchianBreakoutStrategy per section 10.2 with variants 20/10 and 55/20
2. TimeSeriesTrendStrategy per section 10.3
3. BollingerReversalStrategy per section 10.4
4. Unit tests for each against real historical data
5. Gate 1 validation reports

CONSTRAINTS:
- Strategy interface conformance
- No lookahead
- Same code runs in live later

NOTE: Trend Following needs 252-bar lookback. Walk-forward windows fit within
5-year daily data but trade counts per instrument modest. Aggregate across
instruments to reach ≥100 OOS trades for Gate 1.

VERIFICATION:
- All unit tests pass against real data
- Gate 1 report per strategy across daily universe
- Sample trades per strategy
```

---

## 9.14 Phase 14: Orchestrator

**Goal:** Multi-strategy orchestration with three modes.

**Tasks:**
- `Orchestrator` in `orchestrator` package per section 11
- Three modes: equal weight, risk parity (quarterly rebalance), regime-switched
- Regime classifier with LOCKED rules per section 11.3
- Position aggregation with per-strategy attribution
- Account-level limits via RiskManager
- CLIs: multi-strategy backtest, mode comparison

**Verification:**
- Multi-strategy backtest with 3 strategies, all three modes
- Per-strategy attribution reconciles to total
- Regime classifications sensible on sample bars

**Agent Brief:**
```
Implement multi-strategy orchestration.

REFERENCE: Section 11.

DELIVERABLES THIS SESSION (Phase 14):

1. Orchestrator in orchestrator package per section 11
2. Three modes:
   - Equal weight (1/N allocation)
   - Risk parity (inverse rolling 60d volatility, quarterly rebalance)
   - Regime-switched (classifier + allocation rules per section 11.3)
3. Regime classifier with LOCKED rules per section 11.3
4. Position aggregation: each strategy tracks own positions, orchestrator
   computes net per instrument
5. Per-strategy attribution preserved
6. Account-level limits via RiskManager from Phase 10
7. CLIs:
   - pnpm backtest --strategies <list> --mode <mode> --instruments <list> --from <date> --to <date>
   - pnpm backtest:compare-modes --strategies <list> --instruments <list> --from <date> --to <date>

CONSTRAINTS:
- Regime classifier rules LOCKED, not tunable
- Attribution reconciles: sum of per-strategy P&L = total P&L (within rounding)
- Three modes use identical data; only orchestration logic differs

VERIFICATION:
- Multi-strategy backtest with 3 strategies in each mode
- Show mode comparison table
- Per-strategy attribution reconciles
- Sample regime classifications sensible
```

---

## 9.15 Phase 15: cTrader Data Feed CODE (No Connection Yet)

**Goal:** Build the `CTraderDataFeed` code that implements `MarketDataFeed`. No actual cTrader connection in this phase — credentials don't exist yet.

**Important:** This phase builds the integration CODE. It does NOT attempt to connect to cTrader. cTrader application creation and OAuth happen in Phase 18 after all live infrastructure code is ready.

**Tasks:**
- Add `@reiryoku/ctrader-layer` npm package (or current best equivalent)
- `CTraderDataFeed` class in `adapters` implementing `MarketDataFeed`
- OAuth2 authentication code that READS credentials from environment variables (Replit secrets — they won't exist yet, that's fine)
- WebSocket connection logic to `demo.ctraderapi.com:5036` (or `live.ctraderapi.com:5035` based on account type)
- Application auth message handling: `ProtoOAApplicationAuthReq`
- Account auth message handling: `ProtoOAAccountAuthReq`
- Symbol mapping fetched on connect: canonical name → cTrader symbolId
- Subscribe logic: `ProtoOASubscribeSpotsReq`
- Bar builder from tick stream
- Reconnect logic with exponential backoff
- Heartbeat every 30s
- Persist incoming bars with `source='live'`
- All events to audit log
- **No actual connection attempts in this phase.** Code should fail gracefully (with clear log message) if credentials are missing.

**Verification:**
- Code compiles, conforms to `MarketDataFeed` interface
- Unit tests for protocol message construction (test that the right protobuf messages would be sent given inputs)
- Unit tests for bar-from-tick logic using synthetic tick sequences
- Code clearly indicates when credentials are missing: log message "cTrader credentials not configured — connection skipped"

**Agent Brief:**
```
Build CTraderDataFeed CODE. Do NOT attempt to connect to cTrader yet — credentials
don't exist. cTrader application creation and OAuth happen in Phase 18 after all
live infrastructure code is ready and deployed.

REFERENCE: Section 13 (cTrader integration specifications) of project docs.

REQUIRED READING BEFORE STARTING:
Read the official cTrader Open API documentation at:
https://help.ctrader.com/open-api/

Comb through it thoroughly. Pay specific attention to:
- Authentication and OAuth2 flow
- Application registration at id.ctrader.com
- Connection: host, port, WebSocket protocol, protobuf framing
- Spot subscription (ProtoOASubscribeSpotsReq)
- Symbol list (ProtoOASymbolsListReq) and symbolId conventions
- Heartbeat (ProtoOAHeartbeatEvent)
- Error codes and error handling
- Rate limits
- Reconnection guidance

This documentation is authoritative. Section 13 of project docs is a summary;
official docs override it if anything differs.

DELIVERABLES THIS SESSION (Phase 15):

1. Add @reiryoku/ctrader-layer npm package (or current best alternative —
   research and pick most maintained)

2. CTraderDataFeed CLASS implementing MarketDataFeed:
   - OAuth2 logic reading credentials from env vars (which won't exist yet — OK)
   - WebSocket connection code for demo.ctraderapi.com:5036 OR live.ctraderapi.com:5035
   - Application auth: ProtoOAApplicationAuthReq
   - Account auth: ProtoOAAccountAuthReq
   - Subscribe to prices: ProtoOASubscribeSpotsReq
   - Build bars from tick stream
   - Reconnect with exponential backoff (1s, 2s, 4s, 8s, 16s, 32s, 60s)
   - Heartbeat every 30s

3. Symbol mapping logic: ProtoOASymbolsListReq, canonical name → symbolId cache

4. Persist incoming bars with source='live' (when actual ticks eventually arrive)

5. All connection events to audit log

CRITICAL CONSTRAINT — DO NOT CONNECT YET:
- This phase builds CODE only
- DO NOT attempt actual connection to cTrader
- credentials don't exist yet (no CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, etc.
  in Replit secrets — that's intentional)
- Code must check for credential presence and log clearly when missing:
  "cTrader credentials not configured — connection skipped. Add credentials in
  Phase 18."
- DO NOT ask the architect for credentials yet — Phase 18 handles that

VERIFICATION:
- Code compiles and conforms to MarketDataFeed interface
- Unit tests for protocol message construction (mock the WebSocket, verify
  correct protobuf messages would be sent given inputs)
- Unit tests for bar-builder logic using synthetic tick sequences
- Demonstrate clear log message when credentials are missing
- Show the code structure for the connection lifecycle (start, auth, subscribe,
  handle ticks, heartbeat, disconnect, reconnect)
```

---

## 9.16 Phase 16: cTrader Execution Adapter CODE (No Connection Yet)

**Goal:** Build the `CTraderExecutionAdapter` code that implements `ExecutionAdapter`. No actual cTrader connection in this phase.

**Important:** Same as Phase 15 — build the code, don't attempt connection. Credentials don't exist yet.

**Tasks:**
- `CTraderExecutionAdapter` class in `adapters` implementing `ExecutionAdapter`
- Order submission code: translates `OrderRequest` to `ProtoOANewOrderReq`
- Order modification: `ProtoOAAmendOrderReq` for SL/TP updates
- Order cancellation: `ProtoOACancelOrderReq`
- Position closure: market close existing
- Position queries: `ProtoOAReconcileReq`
- Account info: `ProtoOAGetAccountInfoReq`
- Subscribe to executions: `ProtoOAExecutionEvent` stream handler
- Error handling: network retry with backoff, auth re-authenticate, margin propagate, validation reject
- Server-side SL/TP placement after fill
- All operations to audit log + order_log table
- **No actual connection attempts.** Code fails gracefully when credentials missing.

**Verification:**
- Code compiles, conforms to `ExecutionAdapter` interface
- Unit tests for protocol message construction (verify correct protobuf messages would be sent)
- Order state machine tested without real broker
- Clear log message when credentials missing

**Agent Brief:**
```
Build CTraderExecutionAdapter CODE. Do NOT attempt to connect to cTrader yet —
credentials don't exist. Phase 18 handles cTrader application creation and OAuth.

REFERENCE: Section 13 (cTrader integration), section 7 (execution model live).

REQUIRED READING BEFORE STARTING:
Read the official cTrader Open API documentation at:
https://help.ctrader.com/open-api/

For this phase (execution), pay specific attention to:
- Order types and their parameters (ProtoOANewOrderReq)
- Order modification (ProtoOAAmendOrderReq)
- Order cancellation (ProtoOACancelOrderReq)
- Position closure (ProtoOAClosePositionReq)
- Execution events and lifecycle (ProtoOAExecutionEvent)
- Server-side stop loss and take profit placement
- Partial fill handling
- Order rejection scenarios and error codes
- Position reconciliation (ProtoOAReconcileReq)
- Account info (ProtoOAGetAccountInfoReq)
- Lot size and volume conventions (centi-lots vs standard lots)
- Symbol-specific conversion (ProtoOASymbolsForConversionReq)

This documentation is authoritative. Section 13 of project docs is a summary;
official docs override it if anything differs.

DELIVERABLES THIS SESSION (Phase 16):

1. CTraderExecutionAdapter implementing ExecutionAdapter:
   - submitOrder: translate to ProtoOANewOrderReq
   - cancelOrder: ProtoOACancelOrderReq
   - modifyOrder: ProtoOAAmendOrderReq for SL/TP updates
   - closePosition: market close
   - getOpenPositions, getAccountInfo: query broker
   - subscribeOrderUpdates: ProtoOAExecutionEvent handler

2. Server-side SL/TP management:
   - Place after position opens
   - Modify on trailing changes
   - Cancel on close

3. Error handling:
   - Network: retry with backoff
   - Auth: re-authenticate
   - Margin: log + propagate
   - Validation: log + reject

4. All operations to audit log + order_log table

CRITICAL CONSTRAINT — DO NOT CONNECT YET:
- This phase builds CODE only
- DO NOT attempt actual connection to cTrader
- Credentials don't exist yet (intentional)
- Code must check for credential presence and log clearly when missing
- DO NOT ask the architect for credentials yet — Phase 18 handles that

VERIFICATION:
- Code compiles and conforms to ExecutionAdapter interface
- Unit tests for protocol message construction (mock the WebSocket)
- Order state machine tested without real broker
- Clear log message when credentials missing
- Show full code structure for order lifecycle
```

---

## 9.17 Phase 17: System Clock, Live Composition, OAuth Callback Endpoint, Deploy to DO

**Goal:** Complete the live mode infrastructure code AND deploy it to DigitalOcean. The OAuth callback endpoint is reachable at `https://bot.<your-domain>/oauth/callback` after this phase. Still no cTrader connection — that's Phase 18.

**Tasks:**
- `SystemClock` implementing `Clock`:
  - `now()` returns real wall-clock time
  - `sleep(ms)` returns Promise resolved after ms
- Complete `buildSystem(config)` for `mode='live'`:
  - `CTraderDataFeed` + `CTraderExecutionAdapter` + `SystemClock`
  - Rest of wiring matches backtest mode
- Live-specific event loop additions to `TradingSystem`:
  - Continuous operation (no finite date range)
  - Real-time async event handling
  - Account snapshots every 5 minutes
  - Position reconciliation every 60 seconds (will be a no-op until connection works)
  - Strategy heartbeat monitoring
- **OAuth callback endpoint**:
  - HTTP server in `web` package (or dedicated `oauth` package)
  - Route: `GET /oauth/callback`
  - Accepts authorization code as query parameter
  - Exchanges code for access_token + refresh_token using stored client_id + client_secret
  - Saves tokens to Replit secrets via Replit secrets API (or to a secure config table in the database, agent's call)
  - Displays success page to the user
  - This endpoint MUST be reachable at the production URL before Phase 18
- Graceful shutdown: stop accepting signals, close all open positions, wait for pending orders, disconnect, record final state
- Crash recovery on startup: load last session state, reconcile if possible (skipped if not connected), resume or alert
- Lifecycle scripts: `pnpm live:start`, `live:stop`, `live:status`
- PM2 ecosystem file for production deployment
- **DEPLOY TO DIGITALOCEAN DROPLET**:
  - Push to GitHub
  - Pull on droplet
  - Install dependencies, run migrations
  - Start under PM2
  - Verify the OAuth callback endpoint is reachable from the internet at `https://bot.<your-domain>/oauth/callback` (the architect's domain configured during Phase 1 prerequisites)
- TLS via Caddy or nginx + Let's Encrypt (the callback URL MUST be HTTPS for cTrader)

**Verification:**
- Code deploys to DO droplet successfully
- `https://bot.<your-domain>/oauth/callback` reachable from anywhere (test from outside the droplet)
- Returns a placeholder response when accessed without a code parameter (e.g., "OAuth callback endpoint ready. Awaiting authorization.")
- PM2 shows the process running
- Live mode startup attempts (with no credentials) logs clear message: "cTrader credentials not configured. Run Phase 18 to set up cTrader application and OAuth."
- Service auto-restarts on crash via PM2

**Agent Brief:**
```
Complete live infrastructure code AND deploy to DigitalOcean. OAuth callback
endpoint must be reachable at https://bot.<your-domain>/oauth/callback after
this phase. NO cTrader connection yet — that's Phase 18.

REFERENCE: Section 1.4 (composition root), section 7 (execution model live).

DELIVERABLES THIS SESSION (Phase 17):

1. SystemClock implementing Clock with real wall-clock time

2. Complete buildSystem(config) for mode='live':
   - CTraderDataFeed + CTraderExecutionAdapter + SystemClock
   - Rest matches backtest wiring

3. Live-specific event loop additions to TradingSystem:
   - Continuous operation (no finite date range)
   - Real-time async event handling
   - Account snapshots every 5 minutes (no-op until connected)
   - Position reconciliation every 60 seconds (no-op until connected)
   - Strategy heartbeat monitoring

4. OAuth callback endpoint:
   - HTTP server in web package or dedicated oauth package
   - Route: GET /oauth/callback
   - Accepts auth code as query parameter
   - Exchanges code for access_token + refresh_token using stored
     CTRADER_CLIENT_ID + CTRADER_CLIENT_SECRET
   - Saves tokens (architect decides: Replit secrets API or DB config table)
   - Displays success page
   - MUST be reachable at production URL before Phase 18 starts

5. Graceful shutdown, crash recovery (with reconciliation no-op when not connected)

6. Lifecycle scripts: pnpm live:start, live:stop, live:status

7. PM2 ecosystem file

8. DEPLOY TO DIGITALOCEAN:
   - Push to GitHub
   - Pull on droplet
   - Install deps, run migrations
   - Start under PM2
   - Verify OAuth callback endpoint reachable at production URL from outside

9. TLS via Caddy or nginx + Let's Encrypt
   - The callback URL MUST be HTTPS (cTrader requires for production redirects)
   - Use the architect's configured subdomain (bot.<their-domain>)

CONSTRAINTS:
- Backtest mode unchanged
- Live mode uses same TradingSystem class
- All live operations audit-logged
- DO NOT attempt cTrader connection
- Clear messages when credentials missing

VERIFICATION:
- Code deploys to DO droplet successfully
- OAuth callback endpoint reachable from internet at production URL
  (test with curl or browser from outside the droplet)
- Endpoint returns placeholder when accessed without code parameter
- PM2 shows process running
- Startup with no credentials logs: "cTrader credentials not configured. Run
  Phase 18 to set up cTrader application and OAuth."
- Process auto-restarts on crash
- Domain resolves correctly: ping bot.<your-domain> returns droplet IP
- HTTPS works: curl https://bot.<your-domain>/oauth/callback returns 200 with
  placeholder response

REQUEST TO ARCHITECT AT END OF PHASE:
After verifying deployment, tell the architect:
"Phase 17 complete. OAuth callback endpoint is live at
https://bot.<your-domain>/oauth/callback. The infrastructure is ready for cTrader
connection. Phase 18 will guide you through creating the cTrader application at
id.ctrader.com using this exact callback URL, then adding credentials, then
running the OAuth flow."
```

---

## 9.18 Phase 18: cTrader Application Creation, OAuth Flow, First Connection

**Goal:** Architect creates the cTrader application at id.ctrader.com (now that the OAuth callback endpoint is live). Agent guides the OAuth flow to obtain access and refresh tokens. Verify end-to-end live connection works.

**This is the FIRST phase requiring cTrader credentials.** Everything before this was code-only.

**Tasks:**

**Architect-led portion (steps 1-4):**

1. **Verify OAuth callback endpoint is live** from Phase 17:
   - `curl https://bot.<your-domain>/oauth/callback` returns 200 with placeholder
   - DNS resolves correctly

2. **Create cTrader application** at id.ctrader.com:
   - Visit https://id.ctrader.com → Applications → Add Application
   - Application name: `ARKS Trading System`
   - Description: brief professional description (≤180 chars)
   - Redirect URL: `https://bot.<your-domain>/oauth/callback` (the EXACT URL from Phase 17)
   - Scope: `trading`
   - Application type: `Web application` (if asked)
   - Submit
   - **Capture Client ID and Client Secret immediately** — Client Secret shown only once

3. **Add credentials to Replit secrets**:
   - `CTRADER_CLIENT_ID` = (from step 2)
   - `CTRADER_CLIENT_SECRET` = (from step 2)
   - `CTRADER_ACCOUNT_ID` = `5286746` (the demo account)
   - `CTRADER_ACCOUNT_TYPE` = `demo`

4. **Trigger redeploy** on DigitalOcean so the bot picks up the new env vars (or restart the PM2 process)

**Agent-led portion (steps 5-7):**

5. **Run OAuth authorization flow**:
   - Agent constructs the OAuth auth URL: `https://openapi.ctrader.com/apps/auth?client_id=...&redirect_uri=https://bot.<your-domain>/oauth/callback&scope=trading`
   - Agent provides the URL to the architect
   - Architect opens URL in browser, logs in to cTrader, approves the application's access to account 5286746
   - cTrader redirects to `https://bot.<your-domain>/oauth/callback?code=...`
   - Our callback endpoint receives the code, exchanges it for `access_token` + `refresh_token` (via POST to cTrader's token endpoint with client_id + client_secret + code)
   - Tokens saved to Replit secrets (or DB config table) as `CTRADER_ACCESS_TOKEN` and `CTRADER_REFRESH_TOKEN`
   - Success page displayed to architect

6. **Verify live connection**:
   - Bot starts in live mode
   - CTraderDataFeed authenticates application (ProtoOAApplicationAuthReq)
   - Authenticates account (ProtoOAAccountAuthReq)
   - Fetches symbol list (ProtoOASymbolsListReq) and caches mapping
   - Subscribes to EURUSD ticks (ProtoOASubscribeSpotsReq)
   - Receives first ticks within 30 seconds
   - Logs: "cTrader connection established. Account: 5286746 (demo). Subscribed to EURUSD."

7. **Run end-to-end test order**:
   - Place a 0.01 lot EURUSD market order via CTraderExecutionAdapter.submitOrder()
   - Wait for fill event
   - Verify fill price logged
   - Verify position appears in cTrader (architect spot-checks via cTrader web UI)
   - Place server-side SL and TP
   - Wait 60 seconds
   - Close the position
   - Verify exit fill logged
   - Verify position closed in cTrader
   - Order log shows complete lifecycle

**Verification:**
- OAuth flow completes successfully
- Tokens saved to secrets/DB
- Application + account authentication successful
- Symbol mapping fetched and cached
- Live ticks arriving on EURUSD
- End-to-end test order: open → SL/TP placed → close → all logged correctly

**Agent Brief:**

```
This phase performs the FIRST cTrader connection. Phase 17 deployed the OAuth
callback endpoint to https://bot.<your-domain>/oauth/callback. Now we create the
cTrader application, run OAuth, and verify the full connection works.

REFERENCE: Section 13 (cTrader integration) of project docs.

THIS PHASE HAS ARCHITECT-LED STEPS. You guide the architect through them.

DELIVERABLES THIS SESSION (Phase 18):

STEP 1 — Verify infrastructure (you do this):
- Confirm https://bot.<your-domain>/oauth/callback returns 200
- Confirm PM2 shows the bot process running
- If anything wrong, stop and ask architect to fix Phase 17 first

STEP 2 — Ask architect to create cTrader application (architect-led):
Tell the architect:
"The OAuth callback endpoint is live at https://bot.<your-domain>/oauth/callback.
Now we need to create the cTrader application:

1. Go to https://id.ctrader.com → Applications → Add Application
2. Fill in:
   - Application name: ARKS Trading System
   - Description: brief professional description (under 180 chars)
   - Redirect URL: https://bot.<your-domain>/oauth/callback
   - Scope: trading
   - Application type: Web application (if asked)
3. Submit and copy the Client ID and Client Secret immediately (Client Secret
   shown only once)
4. Add to Replit secrets:
   - CTRADER_CLIENT_ID = (value from step 3)
   - CTRADER_CLIENT_SECRET = (value from step 3)
   - CTRADER_ACCOUNT_ID = 5286746
   - CTRADER_ACCOUNT_TYPE = demo
5. Tell me when done."

WAIT for architect's confirmation.

STEP 3 — Trigger bot restart to pick up new env vars:
- SSH into droplet (or via Replit's deployment integration)
- pm2 restart all
- Verify bot starts cleanly with new credentials available

STEP 4 — Construct OAuth auth URL and guide architect:
Tell the architect:
"Open this URL in your browser to authorize the application:
https://openapi.ctrader.com/apps/auth?client_id=<CTRADER_CLIENT_ID>&redirect_uri=https://bot.<your-domain>/oauth/callback&scope=trading

Log in to cTrader, select demo account 5286746, click Approve. You'll be
redirected to our callback endpoint. The bot will save the tokens and show
a success page."

STEP 5 — Verify OAuth flow completes:
- Monitor the callback endpoint logs
- Wait for code → token exchange to complete
- Verify CTRADER_ACCESS_TOKEN and CTRADER_REFRESH_TOKEN are saved
- Confirm to architect: "OAuth complete. Tokens saved."

STEP 6 — Verify live connection:
- Restart bot in live mode if needed
- CTraderDataFeed should:
  - Connect to demo.ctraderapi.com:5036 via WebSocket
  - Send ProtoOAApplicationAuthReq, receive auth response
  - Send ProtoOAAccountAuthReq with account 5286746, receive response
  - Send ProtoOASymbolsListReq, cache symbol mapping
  - Send ProtoOASubscribeSpotsReq for EURUSD
  - Start receiving ProtoOASpotEvent messages
- Log: "cTrader connection established. Account: 5286746 (demo). Subscribed to EURUSD."
- If any step fails, debug and resolve before proceeding

STEP 7 — End-to-end test order:
- Place 0.01 lot EURUSD market order via CTraderExecutionAdapter.submitOrder()
- Wait for ProtoOAExecutionEvent with fill confirmation
- Place server-side SL (e.g., 20 pips below entry) and TP (e.g., 20 pips above)
- Verify SL and TP visible in cTrader web UI (ask architect to spot-check)
- Wait 60 seconds
- Call closePosition() to close at market
- Verify exit fill
- Confirm position closed in cTrader
- Verify order_log table contains complete lifecycle

CONSTRAINTS:
- This is the first time cTrader connection is attempted
- All steps must succeed before declaring phase complete
- Tokens must be securely stored (Replit secrets or DB config table)
- Test order must be small (0.01 lot)
- Use the demo account ONLY — never live for verification

VERIFICATION:
- All 7 steps complete successfully
- Architect confirms position visible in cTrader during the test
- Position closes cleanly
- order_log shows: open, SL placement, TP placement, close
- Bot can now run live sessions on demo account
- Report to architect:
  "Phase 18 complete. Live connection to Pepperstone demo (account 5286746) is
  working. Test order executed successfully. The bot is ready for Phase 19
  (Runtime Configuration) and eventually Phase 24 (7-day demo validation)."
```

---

## 9.19 Phase 19: Runtime Configuration and Manual Operations

**Goal:** Allow runtime config changes via UI without restart. Manual orders, strategy controls, emergency stop.

**Tasks:**
- Config store backed by `config_setting` table
- Hot-reload of risk config: changes take effect immediately
- Strategy pause/resume: paused strategy stops generating signals but existing positions managed
- Strategy kill: stops strategy AND closes its positions at market
- Emergency stop:
  - Halt all strategies
  - Cancel all pending orders
  - Close all open positions at market
  - Target: <10 seconds
  - Must work even with unresponsive strategies
- Manual order entry: bypasses strategy signals, still goes through risk checks, user-attributed in audit log
- Manual position close: closes specific position at market with reason in audit log

**Verification:**
- Change risk config via direct DB write (simulating UI), verify takes effect
- Pause/resume strategy, verify behavior
- Emergency stop in live demo: positions closed in <10s
- Manual order in live demo, verify goes through risk check and audit log
- Manual close, verify position closed

**Agent Brief:**
```
Add runtime config management and manual operations for live mode.

CONCEPT: The UI is the operational interface. User can change risk params, pause
strategies, place manual orders, emergency stop — all without restarting the system.

DELIVERABLES THIS SESSION (Phase 19):

1. Config store backed by config_setting table

2. Hot-reload of risk config: changes via UI take effect immediately

3. Strategy controls:
   - Pause: stops signal generation, positions still managed
   - Resume: restart signal generation
   - Kill: stops strategy AND closes its positions

4. Emergency stop:
   - Halt all strategies
   - Cancel all pending orders
   - Close all open positions at market
   - <10 second target
   - Must work even if some strategies unresponsive

5. Manual order entry: bypasses strategy signals, goes through risk checks,
   user-attributed in audit log

6. Manual position close: closes specific position at market with reason

All operations audit-logged with user attribution.

CONSTRAINTS:
- Changes propagate without restart
- Audit log records every change
- Emergency stop must work in degraded conditions
- Risk checks still apply to manual orders

VERIFICATION (using real demo connected in Phase 18):
- Change risk config via direct DB write, verify takes effect
- Pause/resume a strategy, verify behavior
- Emergency stop: verify positions closed in <10s
- Manual order: goes through risk check, audit-logged
- Manual close: position closed
```

---

## 9.20 Phase 20: Operational UI Foundation

**Goal:** Web UI that REPLACES cTrader for daily operations.

**Tasks:**
- Web app (framework: Next.js, Remix, or SvelteKit — agent picks; document choice with rationale)
- Authentication: password-based session or JWT, never public
- Real-time updates via WebSocket from backend
- Design language per section 12: dark mode default, Linear/Vercel/Stripe aesthetic, minimal modern functional
- Pages:
  - **Login**
  - **Dashboard** (primary operational view):
    - Account status header: equity USD + % change today, P&L today/week/month, account type indicator (DEMO/LIVE clearly distinct), connection status
    - Open positions table: live-updating P&L per position, [Close] buttons
    - Active strategies panel: status (Running/Paused/Killed), [Pause/Resume/Kill] buttons
    - Recent events: last 20 audit events with acknowledge
    - **Emergency stop button**: always visible, prominent, 2-step confirmation
    - Quick links to other pages
  - **Backtest browser**: paginated/filterable/sortable list of backtest sessions
  - **Live session detail**: real-time view of current live session
  - **Configuration**: edit risk parameters with 2-step confirmations
  - **Manual orders**: place new orders (going through risk checks), cancel pending, close open

**Verification:**
- Auth works, no public access
- Dashboard shows real-time account state when in live mode
- Position P&L updates live (every second or via WebSocket)
- Emergency stop button workflow tested
- Backtest browser shows historical sessions
- Manual orders go through risk checks
- Configuration changes audit-logged

**Agent Brief:**
```
Build the operational UI.

REFERENCE: Section 12 (UI specifications) of project docs.

CONCEPT: The UI is the operator's primary interface. After deployment, you should
never need to open cTrader for daily operations.

DELIVERABLES THIS SESSION (Phase 20):

1. Web app (framework choice: Next.js, Remix, or SvelteKit — pick best fit with
   existing TypeScript stack, document choice with brief rationale)

2. Authentication: password-based session or JWT; no public access

3. Real-time updates via WebSocket

4. Pages per section 12:
   - Login
   - Dashboard (account state, positions, strategies, events, emergency stop)
   - Backtest browser (list with filters and sorting)
   - Live session detail (real-time view)
   - Configuration (edit risk parameters)
   - Manual orders (place, cancel, close)

5. Design per section 12.1:
   - Dark mode default, light toggle (persistent preference)
   - Linear / Vercel / Stripe aesthetic
   - Sans-serif (Inter, Geist)
   - Generous whitespace
   - Restricted palette + single accent
   - Consistent chart palette
   - No marketing fluff or welcome popups

6. Use shadcn/ui for components, Recharts for charts

CONSTRAINTS:
- Auth required, no public access
- Fast (sub-100ms interactions)
- Real-time updates not stale (>5s out of date)
- Emergency stop button always accessible
- Type-safe end-to-end

VERIFICATION:
- Screenshots of all pages
- Demonstrate live updates of position P&L
- Demonstrate emergency stop workflow
- Show backtest browser
- Page load times reported
- Confirm deploys to DigitalOcean cleanly
```

---

## 9.21 Phase 21: UI Advanced Analytics

**Goal:** Detailed analytics — parameter sweep visualization, walk-forward detail, per-strategy attribution UI.

**Tasks:**
- Parameter sweep visualization:
  - Heatmap of expectancy across parameter combinations
  - Distribution plot
  - Bonferroni significance flag
  - Top 5 combinations table
- Walk-forward detail:
  - Per-window timeline with IS/OOS markers
  - Per-window metrics table
  - WF consistency prominent
  - Equity curve with window boundaries
- Orchestrator run detail:
  - Per-strategy attribution breakdown
  - Pairwise correlation matrix heatmap
  - Mode + regime distribution
  - Per-strategy equity curves overlaid
- Trade detail modal: full audit detail on click
- Export: trade list CSV, equity curve CSV, run summary PDF

**Verification:**
- Each new feature works on real data from previous backtests
- CSV exports valid

**Agent Brief:**
```
Add advanced UI analytics.

DELIVERABLES THIS SESSION (Phase 21):

1. Parameter sweep visualization (heatmap, distribution, significance, top 5)
2. Walk-forward detail page (per-window IS vs OOS, WF consistency, equity curve)
3. Orchestrator run detail (attribution, correlation matrix, per-strategy curves)
4. Trade detail modal (full audit detail)
5. Export features (CSV, PDF)

VERIFICATION:
- Screenshots of each feature using real data
- CSV exports valid and complete
```

---

## 9.22 Phase 22: Parameter Sweep Framework

**Goal:** Multi-parameter combination testing with statistical correction.

**Tasks:**
- `ParameterSweepRunner` in `engine` or `backtest`
- Accept grid as JSON spec (strategy, instrument, date range, parameters)
- Cross-product generation, skip invalid combinations
- Each combination = child Session
- Sweep analysis: expectancy distribution, best by metric, plateau detection, Bonferroni
- CLI: `pnpm backtest:sweep --grid <path>`

**Verification:**
- Small sweep of Asian Range Sweep on EURUSD (e.g., 12 combos of param values)
- Summary table, plateau detection, Bonferroni flagging
- Determinism check

**Agent Brief:**
```
Implement parameter sweep.

REFERENCE: Section 8.6 (multiple-comparison correction).

DELIVERABLES THIS SESSION (Phase 22):

1. ParameterSweepRunner in engine or backtest package
2. Accept parameter grid as JSON spec
3. Generate cross-product, skip invalid combinations
4. Each combination = child Session (sessionType='parameter_sweep_instance')
5. Sweep analysis:
   - Expectancy distribution across combinations
   - Best by expectancy and Sharpe
   - Plateau detection
   - Bonferroni-adjusted significance
6. CLI: pnpm backtest:sweep --grid <path>

CONSTRAINTS:
- Each combination is full child Session
- Skip invalid combinations rather than erroring
- Bonferroni default; document this in report

VERIFICATION:
- Run small sweep (~12 combinations of Asian Range Sweep on EURUSD M1)
- Show summary table
- Show plateau-vs-spike reporting
- Show Bonferroni-adjusted significance
- Determinism: run twice, identical results
```

---

## 9.23 Phase 23: Production Hardening

**Goal:** System ready for sustained use.

**Tasks:**
- Comprehensive logging audit across all components
- Health monitoring endpoints (`/health`, `/metrics` Prometheus format)
- Error handling audit (user vs system errors, graceful fallback)
- Automated daily database backups, 30-day retention, restore tested
- Live mode alerting: email/SMS on critical events (drawdown threshold, broker disconnect, reconciliation mismatch, strategy halt)
- Restart on crash via PM2
- Log rotation
- Performance benchmarks:
  - 5-year single-strategy daily backtest: <30s
  - Multi-strategy walk-forward: <30 min
- Cost analysis: DB disk, CPU/RAM, monthly DO cost
- Documentation:
  - `DEVELOPER.md`: local setup, development workflow
  - `DEPLOYMENT.md`: DO deployment, configuration
  - `OPERATIONS.md`: common workflows, troubleshooting
  - `ARCHITECTURE.md`: high-level design, key decisions

**Verification:**
- Health endpoint correct status
- Backup/restore demonstration
- All 4 documentation files complete
- Performance benchmarks met
- Alert system tested (e.g., trigger drawdown threshold in demo)

**Agent Brief:**
```
Production hardening.

DELIVERABLES THIS SESSION (Phase 23):

1. Comprehensive logging audit
2. Health monitoring: /health, /metrics endpoints
3. Error handling audit (user vs system, graceful fallback)
4. Automated daily DB backups, 30-day retention, restore tested
5. Live mode alerting: email/SMS on critical events
6. Restart on crash via PM2
7. Log rotation
8. Performance benchmarks:
   - 5-year single-strategy daily backtest: target <30s
   - Multi-strategy walk-forward: target <30 min
9. Cost analysis
10. Documentation: DEVELOPER.md, DEPLOYMENT.md, OPERATIONS.md, ARCHITECTURE.md

VERIFICATION:
- Health endpoint returns correct status
- Backup created and restore demonstrated
- All 4 docs complete and accurate
- Benchmark numbers reported
- Trigger drawdown threshold in demo, verify alert sent
```

---

## 9.24 Phase 24: End-to-End 7-Day Demo Validation

**Goal:** Run full system in live mode on Pepperstone demo for 7 days, validate stability and behavior.

**Tasks:**
- Configure: mode=live, account_type=demo (account 5286746)
- Enable all 4 strategies under Equal Weight orchestrator
- Deploy to DigitalOcean droplet, start under PM2
- Run continuously for 7 days
- Monitor: stability, audit log, alerts, performance
- After 7 days, generate validation report:
  - Per-strategy trade summary
  - P&L and drawdown
  - Live vs backtest comparison
  - Incident log (disconnects, reconnects, reconciliation mismatches)
  - Recommendations for live-account deployment

**Verification:**
- 7-day continuous operation, no manual intervention
- All trades audit-logged
- No reconciliation failures
- Performance acceptable
- Validation report produced

**Agent Brief:**
```
Final validation in live mode on Pepperstone demo for 7 days.

DELIVERABLES THIS SESSION (Phase 24):

1. Configure: mode=live, account_type=demo (Pepperstone account 5286746), all
   4 strategies, Equal Weight orchestrator

2. Deploy to DigitalOcean droplet, start under PM2

3. Run continuously for at least 7 calendar days

4. Monitor: stability, audit log, alerts, performance

5. Generate validation report:
   - Per-strategy trade summary
   - P&L, drawdown
   - Live vs backtest comparison (compare to walk-forward results from earlier phases)
   - Incidents log
   - Recommendations for live-account deployment

VERIFICATION:
- 7-day continuous operation without manual intervention
- All trades audit-logged
- No reconciliation failures
- Performance acceptable
- Validation report produced
```

---

## 9.25 Phase 25: Documentation and Handoff

**Goal:** Comprehensive system documentation.

**Tasks:**
- Final ARCHITECTURE.md with all design decisions, data flow diagrams, interface specifications
- Final DEVELOPER.md with local setup, common workflows, how to add new strategies
- Final DEPLOYMENT.md with full DigitalOcean deployment guide
- Final OPERATIONS.md with daily ops playbook (how to use the UI, when to intervene, troubleshooting)
- API reference for all public interfaces
- Schema reference (auto-generated from Drizzle if possible)
- Runbook for common scenarios:
  - "Strategy is generating losses — how to investigate"
  - "Broker disconnected — what to do"
  - "Reconciliation mismatch — recovery steps"
  - "Migrating from demo to live account"
  - "Adding a new strategy"
  - "Adding a new instrument to the universe"

**Verification:**
- A new developer reading the docs should be able to:
  - Set up the project locally
  - Run a backtest
  - Understand the architecture
  - Deploy to a new DO droplet

**Agent Brief:**
```
Final documentation and handoff.

DELIVERABLES THIS SESSION (Phase 25):

1. ARCHITECTURE.md: design decisions, data flow, interfaces
2. DEVELOPER.md: local setup, workflows, adding strategies
3. DEPLOYMENT.md: DO deployment guide
4. OPERATIONS.md: daily ops, UI use, troubleshooting
5. API reference for public interfaces
6. Schema reference (Drizzle auto-gen if possible)
7. Runbook for common scenarios per section 9.25 task list

VERIFICATION:
- Docs sufficient for new developer to: setup locally, run backtest, understand
  architecture, deploy to new DO droplet
```

---

# 10. Strategy Specifications

## 10.1 Asian Range Sweep (Mean Reversion, intraday)

### Mechanic
During Asian session (00:00-07:00 UTC), Asian Range forms with high (AH) and low (AL). At London open, price often briefly breaches AH or AL then reverses. We enter on reversal with stops beyond the swept extreme.

### State per day
- `asianHigh`: max of bar.high during 00:00-07:00 UTC
- `asianLow`: min of bar.low during 00:00-07:00 UTC
- `highSweepState`: 'idle' | 'breached' | 'abandoned'
- `lowSweepState`: same
- `highBreachExtreme`, `lowBreachExtreme`: deepest level seen
- `highBreachAtBar`, `lowBreachAtBar`: bar index when breach occurred
- `tradeTakenToday`: max one trade per direction per day

### Algorithm (M1 bars chronologically)

**At 00:00 UTC each day:** reset state.

**During 00:00-07:00 UTC (Asian):**
```
asianHigh = max(asianHigh, bar.high)
asianLow = min(asianLow, bar.low)
```

**During 07:30-10:30 UTC (London open window):**

For long setup (sweep of low):
```
if lowSweepState == 'idle':
  if bar.low < asianLow:
    sweepDepth = (asianLow - bar.low) / atr14_daily
    if sweepDepth < minSweepAtr: continue  // too shallow
    elif sweepDepth > maxSweepAtr: lowSweepState = 'abandoned'  // too deep, real breakout
    else:
      lowSweepState = 'breached'
      lowBreachExtreme = bar.low
      lowBreachAtBar = current_bar_index

elif lowSweepState == 'breached':
  if bar.low < lowBreachExtreme:
    lowBreachExtreme = bar.low
    if (asianLow - lowBreachExtreme) / atr14_daily > maxSweepAtr:
      lowSweepState = 'abandoned'
  
  barsSinceBreach = current_bar_index - lowBreachAtBar
  if barsSinceBreach > sweepMaxBars:
    lowSweepState = 'abandoned'
  
  elif bar.close > asianLow and barsSinceBreach > 0:
    // Reversal candle?
    barBody = bar.close - bar.open
    barRange = bar.high - bar.low
    if barRange > 0 and barBody > 0 and (barBody / barRange) >= displacementRatio:
      // VALID — generate long signal
      entry = bar.close
      stop = lowBreachExtreme - stopBufferPips × pipSize
      target = entry + targetR × (entry - stop)
      generate signal { direction: 'long', entry, stop, target, ... }
      tradeTakenToday[long] = true
```

For short setup: mirrored.

### Exit (engine handles)
- Stop hit
- Target hit (2R default)
- Time stop (90 min from entry)
- Move stop to breakeven at +1R
- Session close (21:00 UTC) — force flat

### Constraints
- Max one trade per direction per day
- Skip days with <100 valid M1 bars in Asian session
- Skip days where atr14_daily is null

### Parameters (defaults)
- `minSweepAtr`: 0.05
- `maxSweepAtr`: 0.80
- `sweepMaxBars`: 15
- `displacementRatio`: 0.50
- `stopBufferPips`: 1.5
- `targetR`: 2.0
- `timeStopMinutes`: 90
- `breakevenAtR`: 1.0
- `asianStartUtc`: '00:00'
- `asianEndUtc`: '07:00'
- `londonOpenStartUtc`: '07:30'
- `londonOpenEndUtc`: '10:30'
- `sessionCloseUtc`: '21:00'

## 10.2 Donchian Breakout (Turtle System 1 style)

### Mechanic
Long when daily close > rolling 20-day high. Short when daily close < rolling 20-day low. Exit when close crosses opposite 10-day extreme OR -2.5R trailing.

### State
- `currentPosition`: 'long' | 'short' | 'flat'
- `entryPrice`, `entryAtr`, `currentStop`, `peakExcursionPrice`

### Algorithm (daily bars)
```
rollingHigh20 = max(high over previous 20 bars, excluding current)
rollingLow20 = min(low over previous 20 bars, excluding current)
rollingHigh10 = max(high over previous 10 bars)
rollingLow10 = min(low over previous 10 bars)
atrPct = ATR percentile within last 60 days

if currentPosition == 'flat':
  if atrPct < 20 or atrPct > 95: skip  // chop or panic
  
  if bar.close > rollingHigh20:
    entry = bar.close
    stop = entry - 2.0 × atr14
    enter long
  elif bar.close < rollingLow20:
    entry = bar.close
    stop = entry + 2.0 × atr14
    enter short

elif currentPosition == 'long':
  peakExcursionPrice = max(peakExcursionPrice, bar.high)
  trailingStop = peakExcursionPrice - 2.5 × (entryPrice - originalStop)
  currentStop = max(currentStop, trailingStop)
  
  if bar.low <= currentStop: exit at currentStop  // stop
  elif bar.close < rollingLow10: exit at bar.close  // Donchian exit

elif currentPosition == 'short':
  // Mirrored
```

### Variants
- `donchian-20-10`: 20-day entry, 10-day exit
- `donchian-55-20`: 55-day entry, 20-day exit (Turtle System 1)

## 10.3 Time-Series Trend Following

### Mechanic
Hold position in direction of 12-month price trend, confirmed by SMA50 vs SMA200. Hold until trend reverses or stop hit.

### State
- `currentPosition`, `entryPrice`, `entryAtr`, `peakExcursionPrice`, `currentStop`

### Algorithm (daily bars)
```
pastReturn = (bar.close - bar.close_252_ago) / bar.close_252_ago
sma50 = SMA(close, 50)
sma200 = SMA(close, 200)

trendBullish = (pastReturn > 0) AND (sma50 > sma200)
trendBearish = (pastReturn < 0) AND (sma50 < sma200)

if currentPosition == 'flat':
  if trendBullish:
    entry = bar.close
    stop = entry - 3.0 × atr14
    enter long
  elif trendBearish:
    entry = bar.close
    stop = entry + 3.0 × atr14
    enter short

elif currentPosition == 'long':
  peakExcursionPrice = max(peakExcursionPrice, bar.high)
  trailingStop = peakExcursionPrice - 2.5 × (entryPrice - originalStop)
  currentStop = max(currentStop, trailingStop)
  
  if bar.low <= currentStop: exit at currentStop
  elif trendBearish: exit at bar.close  // signal flip

elif currentPosition == 'short':
  // Mirrored
```

### Parameters
- `momentumLookbackBars`: 252
- `fastSmaPeriod`: 50
- `slowSmaPeriod`: 200
- `atrStopMultiplier`: 3.0
- `trailingStopR`: 2.5

### Constraints
- Daily bars
- Needs 252 bars of history before first signal
- One position per instrument at a time

## 10.4 Bollinger Reversal (Multi-day Mean Reversion)

### Mechanic
Wait for daily close OUTSIDE 2-stddev Bollinger Band. Wait for daily close BACK INSIDE. Enter on re-entry. Target: SMA20 or 2R.

### State
- `outsideBandState`: 'idle' | 'above' | 'below'
- `extremeOutside`: high/low during outside-band period
- `currentPosition`, `entryPrice`, `currentStop`, `currentTarget`, `entryTime`

### Algorithm (daily bars)
```
bbUpper = SMA20 + 2 × stddev20
bbLower = SMA20 - 2 × stddev20

if outsideBandState == 'idle':
  if bar.close > bbUpper:
    outsideBandState = 'above'
    extremeOutside = bar.high
  elif bar.close < bbLower:
    outsideBandState = 'below'
    extremeOutside = bar.low

elif outsideBandState == 'above':
  if bar.high > extremeOutside: extremeOutside = bar.high
  if bar.close < bbUpper:
    // Re-entry — enter short
    entry = bar.close
    stop = extremeOutside + 1.5 pip buffer
    targetPrimary = SMA20  // mean reversion
    targetSecondary = entry - 2.0 × (stop - entry)  // 2R
    enter short
    outsideBandState = 'idle'

elif outsideBandState == 'below':
  // Mirrored: enter long
```

### Exit
- Stop hit
- Hit SMA20 OR 2R (whichever first)
- Time stop: 10 trading days

### Parameters
- `bbPeriod`: 20
- `bbStdDev`: 2
- `maxHoldDays`: 10
- `targetType`: 'sma' or '2r' (default 'sma')

---

# 11. Orchestrator Specifications

## 11.1 Equal Weight Mode
Each strategy receives 1/N allocation. N = active strategies. Fixed, no rebalance.

## 11.2 Risk Parity Mode
At end of each calendar quarter:
- Compute rolling 60-day realized volatility per strategy's returns
- New allocations: `1/vol` per strategy, normalized to sum to 1.0
- Higher recent volatility → smaller allocation
- Allocations held constant during quarter

Edge case: strategy with <60 days of returns → equal weight for that strategy.

## 11.3 Regime-Switched Mode

### Classifier inputs (computed daily on EURUSD daily as reference)
- ADX(14)
- ATR percentile (within last 60 days)
- Close vs SMA200

### Rules (LOCKED, NOT TUNABLE)
```
if atrPercentile > 80:
  regime = 'volatile'
elif adx14 > 25 and close > sma200:
  regime = 'trending'
elif adx14 < 20 and atrPercentile < 50:
  regime = 'ranging'
else:
  regime = 'mixed'
```

### Allocations per regime (also LOCKED)
```
trending:  trend=60%, meanRev=15%, breakout=25%
ranging:   trend=15%, meanRev=60%, breakout=25%
volatile:  trend=25%, meanRev=15%, breakout=60%
mixed:     trend=33.3%, meanRev=33.3%, breakout=33.3%
```

Reclassification: daily.

## 11.4 Position Aggregation
- Each strategy tracks own positions internally
- Orchestrator queries each strategy for target positions
- Computes net target per instrument
- Generates orders to reconcile actual broker position to net target
- Internal accounting preserves per-strategy positions
- P&L: each strategy computes own P&L based on its tracked position; they sum to broker P&L (mathematically guaranteed)

## 11.5 Account-Level Limits
Delegated to RiskManager from Phase 10. Orchestrator passes intent; RiskManager enforces.

---

# 12. Operational UI Specifications

## 12.1 Aesthetic
Reference: Linear, Vercel dashboard, Stripe data views.

- Dark mode default, light toggle (persistent)
- Sans-serif (Inter, Geist, or equivalent)
- Generous whitespace
- Restricted palette: 3-4 background shades, neutrals + single accent (indigo/teal/violet — agent picks)
- Subdued status colors (green success, amber warning, red error)
- Chart palette: consistent 4-6 colors across all views
- No marketing language, welcome popups, onboarding
- Keyboard navigation
- Semantic HTML

## 12.2 Pages

### Login
Minimal: credentials, submit.

### Dashboard (primary operational view)

**Account status header:**
- Current equity USD + % change today
- P&L today (USD + %), week, month
- Account type indicator (DEMO/LIVE clearly distinct visually)
- Broker connection status badge (connected/disconnected/reconnecting)

**Open positions table:**
- Columns: Instrument, Direction, Lot size, Entry, Current, Stop, Target, Unrealized P&L (USD + %), Strategy, Time in trade, [Close button]
- Live updating
- Click row → trade detail modal

**Active strategies panel:**
- Each strategy: name, status (Running/Paused/Killed), recent trade count, allocation %, [Pause/Resume/Kill] buttons

**Recent events:**
- Last 20 audit events
- Click to acknowledge

**Emergency stop button:**
- Always visible, prominent
- 2-step confirmation
- Closes all positions, halts all strategies

**Quick links:** Backtest browser, Configuration, Manual orders

### Backtest browser
- Paginated, filterable, sortable list of sessions
- Filters: date range, strategy, instrument, run type
- Sort by: created_at, total return, Sharpe, max DD
- Click row → run detail

### Run detail
- Configuration summary
- Aggregate metrics with CIs in clean table
- Run metadata (code version, friction profile, seed)
- Equity curve
- Drawdown curve
- Trade distribution histogram
- Trade list (paginated)
- For walk-forward: per-window table
- For orchestrator: per-strategy attribution + correlation matrix

### Live session detail
- All info from dashboard, plus:
- Equity curve since session start (real-time)
- All trades from session (paginated)
- All signals from session (filterable, includes rejected)
- Per-strategy attribution breakdown

### Configuration
- All RiskConfig fields editable, current values shown
- Each change: 2-step confirmation
- Audit log of changes visible

### Manual orders
- Place order: instrument selector, direction, size (lot size OR % risk auto-computing other), stop, target, [Submit]
- Submit goes through risk checks
- Cancel pending orders: list with cancel buttons
- Close open positions: list with close buttons
- All manual ops audit-logged

### Strategy comparison
- Pick 2+ runs
- Side-by-side metrics
- Overlaid equity curves
- Statistical significance of differences

## 12.3 Charts
Use Recharts.

- Equity curve (line, time × USD)
- Drawdown (filled area, negative %)
- Trade distribution (histogram of R)
- Parameter sensitivity (heatmap)
- Walk-forward windows (sequence with IS/OOS markers)
- Correlation matrix (heatmap, -1 to +1)

## 12.4 Real-time updates
WebSocket pushes:
- Position P&L updates
- New audit events
- Order status changes
- Account equity changes
- Strategy state changes

---

# 13. cTrader Integration Specifications

## 13.0 Required reading

Before implementing any cTrader integration (Phases 15-16), the agent MUST read and internalize the official cTrader Open API documentation at:

**https://help.ctrader.com/open-api/**

This documentation is authoritative and current. The summary in sections 13.1-13.9 below is a reference, not a substitute. Specifically read:
- Authentication and OAuth2 flow
- Application registration at id.ctrader.com
- Connection details (host, port, protocol)
- Protocol message reference (ProtoOA* message types)
- Account types (demo vs live), spot subscription, order management
- Error codes and error handling
- Rate limits
- Heartbeat requirements
- Reconnection guidance

If the npm package `@reiryoku/ctrader-layer` (or current equivalent) abstracts some of this, still read the underlying docs — the wrapper's behavior must be understood at the protocol level for proper error handling, edge cases, and debugging.

If anything in the official docs contradicts the summary in this section, the official docs are authoritative. Flag the contradiction in the implementation notes and follow the official docs.

## 13.1 Authentication
OAuth2 flow:

1. **Setup (one-time):** at id.ctrader.com create Open API Application with:
   - Name (e.g., "ARKS Trading System v1")
   - Redirect URI: `http://localhost:8080/callback` for development
   - Scope: `trading`
   - Receive: Client ID + Client Secret

2. **Authorization code grant (one-time per environment):**
   - User visits cTrader auth URL
   - Approves the app
   - cTrader redirects with code
   - Code exchanged for access_token + refresh_token

3. **Runtime:**
   - Access token in protocol messages
   - Refresh access token before expiration using refresh token

Architect adds credentials to Replit secrets when the agent reaches Phase 15.

## 13.2 Connection
WebSocket:
- Demo: `demo.ctraderapi.com:5036`
- Live: `live.ctraderapi.com:5035`

Protocol: Protocol Buffers over TCP.

Use `@reiryoku/ctrader-layer` npm package (or current best alternative).

## 13.3 Authentication sequence
1. Connect to broker
2. `ProtoOAApplicationAuthReq` (client_id, client_secret)
3. Receive `ProtoOAApplicationAuthRes`
4. `ProtoOAAccountAuthReq` (ctidTraderAccountId, accessToken)
5. Receive `ProtoOAAccountAuthRes`
6. Now authenticated

## 13.4 Common requests
- `ProtoOASymbolsListReq`: fetch tradable instruments with symbolIds
- `ProtoOASubscribeSpotsReq`: subscribe to real-time prices
- `ProtoOANewOrderReq`: submit order
- `ProtoOAAmendOrderReq`: modify (price, SL, TP)
- `ProtoOACancelOrderReq`: cancel pending
- `ProtoOAClosePositionReq`: close position at market
- `ProtoOAReconcileReq`: get all open positions

## 13.5 Common events
- `ProtoOASpotEvent`: real-time price update
- `ProtoOAExecutionEvent`: order/position execution
- `ProtoOAErrorRes`: error response

## 13.6 Heartbeat
`ProtoOAHeartbeatEvent` every 30s.

## 13.7 Symbol mapping
Numeric symbolIds (varies per broker). Fetched via `ProtoOASymbolsListReq` on connect, cached:
```
"EURUSD" → 1
"GBPUSD" → 2
...
```

## 13.8 Lot size conventions
- cTrader volumes in units of 0.01 lot (centi-lots)
- 1.0 lot = 100,000 units of base currency = 100 centi-lots
- Minimum order: typically 0.01 lot = 1 centi-lot
- Verify per symbol via `ProtoOASymbolsForConversionReq`

## 13.9 Reconnection
On disconnect:
- Wait 1s, attempt reconnect
- If failed: wait 2s, then 4s, 8s, 16s, 32s, max 60s
- On successful reconnect: re-authenticate, re-subscribe, immediate reconciliation

---

# 14. Asset Universe

## 14.1 Full Dukascopy daily ingestion (loaded once, all instruments)

5 years (2020-01-01 to 2026-05-12).

**FX Majors (7):**
- EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, USDCAD, NZDUSD

**FX Crosses (~20):**
- EURGBP, EURJPY, GBPJPY, AUDJPY, CADJPY, CHFJPY, NZDJPY
- EURCHF, EURAUD, EURCAD, EURNZD
- GBPAUD, GBPCAD, GBPCHF, GBPNZD
- AUDCAD, AUDCHF, AUDNZD
- CADCHF
- NZDCAD, NZDCHF

**Metals (2):**
- XAUUSD (gold)
- XAGUSD (silver)

**Energy (2):**
- BRENTCMDUSD (Brent crude oil)
- LIGHTCMDUSD (WTI crude oil)

**Major Stock Indices (varies by Dukascopy availability):**
- SPXUSD (S&P 500 CFD)
- NSXUSD (Nasdaq 100 CFD)
- USA30IDXUSD (Dow Jones CFD)
- DEUIDXEUR (DAX 40 CFD)
- FRAIDXEUR (CAC 40 CFD)
- JPNIDXJPY (Nikkei 225 CFD)
- GBRIDXGBP (FTSE 100 CFD)
- AUSIDXAUD (ASX 200 CFD)
- HKGIDXHKD (Hang Seng CFD)

**Crypto (if available in Dukascopy historical):**
- BTCUSD
- ETHUSD

Total: ~35-40 instruments. Agent should ingest all available from Dukascopy. If a specific instrument isn't available, log it and skip.

## 14.2 M1 ingestion (active trading subset)

6 months (2025-11-01 to 2026-05-12):
- EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, USDCAD
- XAUUSD
- BRENTCMDUSD

## 14.3 Storage estimates

Daily data: ~1300 bars × 40 instruments × ~200 bytes = ~10 MB total. Trivial.

M1 data: ~190K bars × 8 instruments × ~200 bytes = ~300 MB total. Manageable.

Total DB usage: well under 1 GB after full ingestion.

## 14.4 Scaling up later

When ready to expand the active trading universe:
- Daily data already loaded for ~40 instruments — no re-download needed
- M1 data for new instruments: incremental ingestion takes 1-2 hours per instrument for 6 months
- Strategies fetch from DB; adding a new instrument requires only configuration

---

# Document End

**Total scope:** 25 phases, est. 80-160 hours agent runtime.

**Architect time per phase:** 30-90 min (more for Phase 18 cTrader OAuth and Phase 24 7-day validation).

**Calendar time:** 4-12 weeks at 1-2 phases/week.

**Critical path:**
- Phases 1-4: Foundation (project skeleton, DB, data ingestion full universe, indicators)
- Phases 5-9: Backtest engine (interfaces, historical feed, friction+simulated exec, simulated clock+composition, metrics)
- Phases 10-14: Tools + strategies + orchestrator (risk+audit, sweep, walk-forward, more strategies, orchestrator)
- Phases 15-17: Live engine CODE (cTrader adapters built, OAuth callback endpoint deployed, NO connection yet)
- Phase 18: cTrader application creation + OAuth + first connection verification
- Phase 19: Runtime config + manual ops (works against live demo connection from Phase 18)
- Phases 20-22: Operational UI + parameter sweep
- Phases 23-25: Production hardening, 7-day demo validation, documentation

**The most critical phase:** Phase 5 (Core Interfaces). If interfaces are wrong, every subsequent phase requires refactor. Review carefully before approving.

**Build-then-connect for cTrader:**
- Phases 1-14: backtest only, no cTrader work
- Phases 15-17: cTrader adapter CODE built and deployed, OAuth callback endpoint live, but NO actual connection (no credentials yet)
- Phase 18: architect creates cTrader app at id.ctrader.com using the deployed callback URL, adds credentials to Replit secrets, agent runs OAuth flow and verifies live connection
- Phase 19+: runs against the live demo connection

**Production readiness:** After Phase 24's successful 7-day demo validation, the system is ready for live-account deployment. Switch is configuration only: change `CTRADER_ACCOUNT_TYPE` from `demo` to `live`.
