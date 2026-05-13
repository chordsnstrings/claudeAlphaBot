# Developer guide

Local-machine setup, dev workflow, and how to run the test suite.

## Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL 16+ (TimescaleDB extension installed in production; optional locally — the migration runner degrades gracefully when it's absent)

## First-time setup

```bash
# Install workspace dependencies
pnpm install

# Build all packages so cross-package type resolution works
pnpm -r build

# Local Postgres (one-time)
sudo -u postgres psql -c "CREATE USER trading WITH PASSWORD 'trading';"
sudo -u postgres psql -c "CREATE DATABASE trading_dev OWNER trading;"
sudo -u postgres psql -c "CREATE DATABASE trading_test OWNER trading;"

# Migrate the dev DB
DATABASE_URL=postgres://trading:trading@localhost:5432/trading_dev \
  pnpm --filter @trading/data migrate
```

## Daily workflow

```bash
pnpm -w run typecheck   # all packages, strict TS
pnpm -w run lint        # ESLint with no warnings allowed
pnpm -w run test        # vitest across every workspace project
pnpm -r build           # tsc compile (needed for cross-package imports)
```

Tests use a real Postgres schema per test file. Set
`DATABASE_URL_TEST=postgres://trading:trading@localhost:5432/trading_test`
(the default) before running the data / risk / engine / adapters /
web suites.

## Repo layout

```
packages/
  core         — types, interfaces, indicators, RNG, logger, config (Zod)
  data         — Drizzle schema, repos, migrations, Dukascopy ingestion
  engine       — TradingSystem event loop, walk-forward, parameter sweep,
                 health endpoint, composition-root registry
  adapters     — HistoricalDataFeed, SimulatedExecutionAdapter, SimulatedClock,
                 FrictionModel, cTrader live adapters (Phase 15-17), OAuth
                 callback, build-backtest / build-live composition
  metrics      — MetricsCollector (Wilson CI, bootstrap Sharpe, Monte Carlo)
  risk         — RiskManager, AuditLog, position sizing, RuntimeOps
  strategies   — AsianRangeSweep, Donchian, TrendFollowing, BollingerReversal
  orchestrator — Orchestrator (equal/risk-parity/regime), regime classifier
  reporting    — (placeholder; reports rendered via the web UI for now)
  web          — Fastify operational UI (login, dashboard, backtests,
                 config, manual orders, emergency stop, SSE)
  cli          — `trading-cli` ingest:* + backtest commands
```

## Running things

```bash
# Ingest 5y daily + 6mo M1 from Dukascopy
DATABASE_URL=$DEV_DB pnpm --filter @trading/cli ingest:full

# Single-strategy backtest
DATABASE_URL=$DEV_DB pnpm --filter @trading/cli backtest \
  --strategy asian-range-sweep --instrument EURUSD --timeframe m1 \
  --from 2025-11-01 --to 2026-05-12

# Available strategies
#   --strategy asian-range-sweep    (m1)
#   --strategy donchian-breakout    (d1)
#   --strategy trend-following      (d1)
#   --strategy bollinger-reversal   (d1)
#   --strategy noop                 (any; for engine smoke tests)
```

## Adding a strategy

1. New file `packages/strategies/src/<name>.ts` implementing
   `Strategy` from `@trading/core`. Use `MarketState.indicators` for
   any inputs already in `IndicatorSnapshot`; if you need something
   bespoke (e.g. daily ATR while running on M1), preload it in
   `initialize(ctx)` via `ctx.dataFeed.getHistoricalBars(...)`.
2. Register in `packages/cli/src/backtest.ts` under
   `STRATEGY_REGISTRY`.
3. Add a unit test under `packages/strategies/test/`.
4. If the strategy uses signal-flip or trailing-stop exits beyond
   the engine's stop/target detection, extend
   `SimulatedExecutionAdapter` (see notes in spec §10).

## Architecture quick-reference

- **Mode parity** is enforced at the composition root. Backtest and
  live differ only in `MarketDataFeed`, `ExecutionAdapter`, `Clock`
  selected in `buildBacktestDeps` / `buildLiveDeps`. The
  `TradingSystem` event loop has zero `if mode === 'live'` branches.
- **No-lookahead** is enforced at the data feed: the engine advances
  `SimulatedClock` to each bar's timestamp before processing, and
  `HistoricalDataFeed`'s iterator gates each yield on
  `bar.ts <= clock.now() + one-bar-period`.
- **All risk parameters are percentages.** Position sizes scale
  linearly with account equity — see `@trading/risk/position-sizing`.
- **Determinism**: every stochastic call routes through Mulberry32
  seeded from `session.randomSeed`. A backtest with the same seed
  produces identical fills, identical bootstrap Sharpe CIs, and
  identical Monte Carlo distributions.
