# Trading System v3

Systematic trading system with two startup-selectable modes:

- **Backtest** — replays historical Dukascopy data from TimescaleDB through the same strategy / orchestrator / risk-manager code paths as live, with a realistic friction model.
- **Live** — connects to Pepperstone via the cTrader Open API and executes real orders on demo (account 5286746) or live accounts.

Mode parity is strict: the only differences between modes are the three boundary adapters (`MarketDataFeed`, `ExecutionAdapter`, `Clock`) selected at the composition root. Everything else — strategies, orchestrator, risk, metrics, audit — is mode-invariant.

The spec is `trading_system_docs.md` (v3). Build proceeds in 25 phases; see section 9 of the spec for the per-phase brief. Phases delivered so far: **1 (skeleton), 2 (DB schema + migrations + repositories), 3 (Dukascopy ingestion + CLI), 4 (indicator library), 5 (boundary interfaces + TradingSystem), 6 (HistoricalDataFeed), 7 (Friction model + SimulatedExecutionAdapter), 8 (SimulatedClock + backtest composition + `pnpm backtest` CLI), 9 (MetricsCollector with Wilson CI, bootstrap Sharpe, Monte Carlo)**.

## Stack (locked)

| Layer | Choice |
| --- | --- |
| Language | TypeScript strict mode |
| Runtime | Node 20+ |
| Package manager | pnpm workspaces |
| DB | PostgreSQL 16 + TimescaleDB |
| ORM | Drizzle (added in Phase 2) |
| Tests | Vitest |
| Logger | Pino (structured JSON) |
| Config | Zod-validated env vars |
| Broker | cTrader Open API (Phase 15+) |
| UI | TBD in Phase 20 (Next.js / Remix / SvelteKit) |

## Repository layout

```
packages/
├── core         — types, interfaces, logger, Zod config
├── data         — DB schema, repositories, Dukascopy ingestion
├── adapters     — MarketDataFeed + ExecutionAdapter implementations
├── strategies   — Asian Range Sweep, Donchian, TSMOM, BB Reversal
├── engine       — TradingSystem event loop (mode-agnostic)
├── metrics      — performance calculation
├── orchestrator — multi-strategy aggregation
├── risk         — account-level risk management
├── reporting    — result formatting
├── web          — operational UI
└── cli          — command-line operations
```

## Setup

Prerequisites: Node 20+, pnpm 9+, Postgres 16 reachable via `DATABASE_URL`.

```bash
cp .env.example .env
# Edit .env: at minimum, MODE and DATABASE_URL. For backtest mode set
# BACKTEST_START_DATE, BACKTEST_END_DATE, BACKTEST_INITIAL_EQUITY_USD.

pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Scripts

| Command | What |
| --- | --- |
| `pnpm build` | Compile every package via `tsc` |
| `pnpm typecheck` | Strict TS check, no emit |
| `pnpm lint` | ESLint, errors only |
| `pnpm test` | Run all vitest projects |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm format` | Prettier write |

Ingestion CLI (Phase 3):

```bash
# One-off: pull EURUSD daily from 2025-11 to 2026-05.
cd packages/cli && \
  DATABASE_URL=postgres://trading:trading@localhost:5432/trading_dev \
  npx tsx src/bin.ts ingest:asset \
    --instrument EURUSD --timeframe d1 \
    --from 2025-11-01 --to 2026-05-12

# Full default ingest (5y daily universe + 6mo M1 active subset).
DATABASE_URL=... pnpm --filter @trading/cli ingest:full

# Catch up to now without re-pulling history.
DATABASE_URL=... pnpm --filter @trading/cli ingest:incremental

# Row counts + first/last bar per (instrument, timeframe).
DATABASE_URL=... pnpm --filter @trading/cli ingest:report
```

Run migrations against a fresh DB before the first ingest:

```bash
DATABASE_URL=postgres://trading:trading@localhost:5432/trading_dev \
  pnpm --filter @trading/data migrate
```

## Configuration

All runtime configuration is environment variables, validated by Zod on startup. The schema is in `packages/core/src/config.ts` and is **mode-conditional**: `MODE=backtest` requires the `BACKTEST_*` block; `MODE=live` requires the `CTRADER_*` block. The OAuth tokens (`CTRADER_ACCESS_TOKEN`, `CTRADER_REFRESH_TOKEN`) are populated by the Phase 18 OAuth flow and are not required prior to that phase. See `.env.example` for the full list.

## Spec

Read `trading_system_docs.md` in this order:

1. Section 1 (Architecture) — two modes, composition root
2. Section 2 (Goals)
3. Section 3 (Principles) — strict mode parity, DB-first, no lookahead
4. Section 4 (Project Structure) — stack, naming, config conventions
5. Section 5 (Data Models) — Bar, MarketState, Signal, Position, Trade, Session, plus the DB schema
6. Section 9 (Build Phases) — per-phase tasks, verification, agent brief

Reference sections 6–8 and 10–14 as the phases that need them arrive.

## License

MIT. See `LICENSE`.
