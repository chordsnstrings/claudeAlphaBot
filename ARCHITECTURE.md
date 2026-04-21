# Architecture

This document describes the shape of Hydra's moving parts and how they
interact. For *why* each piece exists, see `TRADING_BOT_SPEC.md`.

## Topology

```
                 ┌──────────────┐
                 │  Operator    │
                 │  (browser)   │
                 └──────┬───────┘
                        │  HTTPS
                        ▼
 ┌────────────────────────────────────┐
 │   @hydra/ui  (Next.js 14)          │
 │   - server components → SELECT     │
 │   - route handlers → POST /api/... │
 └────────────┬──────────────────┬────┘
              │ SQL              │ HTTP
              │                  │
              ▼                  ▼
     ┌────────────────┐    ┌─────────────────────┐
     │   Postgres 16  │    │   @hydra/bot        │
     │                │    │   - live loop       │
     │                │    │   - scheduler       │
     │                │    │   - internal API    │
     │                │    └──────┬──────────────┘
     └────────────────┘           │
              ▲                   │ REST + WS
              │ INSERT/UPDATE     ▼
              └──────────  ┌──────────────┐
                           │  Binance     │
                           │  Futures     │
                           └──────────────┘
```

- The UI talks to Postgres directly for read queries (server
  components) and talks to the bot only for write-path commands
  (pause / resume / close-all / revalidate / approve).
- The bot talks to Postgres and Binance.
- Operator → UI → bot is the only authorised mutation path. Postgres
  is not exposed externally in the DO spec.

## Packages

### `@hydra/shared`

Pure types and utilities. No runtime deps on the bot or the UI. Exports:

- `domain/` — `Regime`, `Strategy`, `OpenPosition`, `Trade`, etc.
- `constants.ts` — venue, symbol, strategy enum values.
- `util/` — `Decimal` helpers, time math.

Anything imported by both `@hydra/bot` and `@hydra/ui` lives here.

### `@hydra/bot`

Organised into independent modules; import direction is one-way
(`core → data → execution` never reversed). Per-directory contracts:

| Dir | Contract |
| --- | --- |
| `config/` | `loadEnv()` — Zod-validated env, loud on missing required keys. |
| `core/` | Pure strategy logic: regime detector, signal generators, risk sizing, breakers. No IO. |
| `data/` | Binance adapters: REST (historical + orderbook), WS (candles + funding). Has IO. |
| `execution/` | `BacktestAdapter`, `PaperAdapter`, `BinanceFuturesAdapter`. Same interface across modes. |
| `backtest/` | Historical simulator + metrics + walk-forward + Monte Carlo. Driven from CLI. |
| `scheduler/` | `node-cron` driver + DB-backed recovery (PENDING→RUNNING CAS). |
| `monitoring/` | pino logger, Fastify `/health` + `/ready`, Prometheus-style counters. |
| `api/` | Fastify command endpoints (pause / resume / revalidate / close / approve). |
| `cli/` | `migrate.ts`, `backfill.ts`, `smoke-indicators.ts`, `run-validation.ts`. |
| `db/` | `pool.ts` (singleton pg Pool), `migrator.ts`. |
| `main.ts` | Entry point. Boot sequence: env → logger → migrate → code-hash → verify artifact → health server → mode-specific driver. |

### `@hydra/ui`

Next.js 14 App Router, server components by default.

| Dir | Contents |
| --- | --- |
| `app/` | 11 routes (dashboard + 10 detail pages) + 5 API route handlers for commands. |
| `components/` | Reusable bits: `Card`, `KpiCard`, `EquityChart` (client), `PositionsTable`, `RegimeCard`, `Sidebar`, `TopBar`, `PageShell`, `CommandsPanel` (client), ... |
| `db/` | `pool.ts` — singleton pg Pool keyed on `globalThis.__hydra_pg_pool`. `queries.ts` — dashboard loaders. `queries-ext.ts` — detail-page loaders. |
| `lib/` | `format.ts`, `cn.ts`, `nav.ts`, `bot-api.ts`. |

## Data flow

### 1. Ingestion

- `data/binance-ws.ts` subscribes to 1m/5m/1h candles + funding rates for
  each symbol and upserts into `candles` / `funding_rates`.
- `cli/backfill.ts` performs a bulk REST pull for initial seeding (24
  months of 1m data).

### 2. Strategy pipeline (live loop)

```
Candle close
    → core/regime.ts            (classifies the last N-minute regime)
    → core/signals/*.ts         (one generator per strategy emits zero or one Signal)
    → core/risk.ts              (rejects the signal if breakers or limits fire; else sizes)
    → execution/<adapter>.ts    (places entry + stop + TPs, atomically or simulated)
    → open_positions table      (INSERT)
```

### 3. Position management

On every candle close or fill callback:

- `core/position-manager.ts` walks open positions, moves stops to breakeven
  on TP1 fills, triggers time-stops, handles TP2 + stop-out, and writes
  closed rows to `trades`.
- `account_equity_history` gets a row per 1h candle close with the realised
  equity snapshot.

### 4. Regime check cron (daily 00:30 UTC)

```
cron trigger
    → scheduler/runner.ts acquires scheduler_runs PENDING → RUNNING via CAS
    → scheduler/jobs.ts::regimeCheckJob
    → core/regime.ts classifies each symbol's current regime
    → compares to validation_snapshots.per_symbol
    → inserts into regime_check_log with outcome ∈ {UNCHANGED, DRIFTED, FLIPPED}
    → aggregates portfolio outcome
    → if FLIPPED on majority of BTC/ETH/SOL: trigger revalidation automatically
```

### 5. Revalidation cron (every 14 days, 02:00 UTC)

```
cron trigger
    → scheduler/jobs.ts::revalidationJob inserts revalidation_events row (trigger_reason='FORTNIGHTLY')
    → backtest/pipeline.ts sweeps the parameter grid over the last N months
    → validation_snapshots stores the per-symbol candidate
    → validated_artifacts stores the hashed artifact with composite_score + deployment_allowed
    → operator must explicitly approve-artifact (via UI → POST /api/commands/approve-artifact)
      before is_active flips and the live loop picks up new parameters
```

### 6. Command path (operator → UI → bot)

```
Button click in /commands
    → UI route handler /api/commands/<cmd>
    → lib/bot-api.ts fetch(BOT_INTERNAL_API_URL + /api/commands/<cmd>)
    → Fastify handler in packages/bot/src/api/routes.ts
    → rate-limited to 1 req / 10s per endpoint
    → writes to command_log (OK | REJECTED | RATE_LIMITED | ERROR)
    → returns JSON to UI
```

## Database

Single Postgres 16 instance, 11 tables defined in `migrations/`. All
timestamps are `BIGINT` (epoch ms, UTC) to match the JS time model —
no `TIMESTAMP WITH TIME ZONE` footguns.

| Table | Rows per day (live) | Purpose |
| --- | --- | --- |
| `candles` | ~4,320 | Close-indexed OHLCV |
| `funding_rates` | ~9 | 8-hourly funding per symbol |
| `trades` | ~3–15 | Closed trades (ground truth for performance) |
| `open_positions` | ~0–3 | Currently-open positions |
| `account_equity_history` | ~24 | Hourly equity snapshots |
| `regime_check_log` | ~3 | Daily regime classification per symbol |
| `revalidation_events` | ~1/14 days | Fortnightly + triggered revalidations |
| `validated_artifacts` | ~1/14 days | Parameter snapshots with composite scores |
| `validation_snapshots` | ~1/14 days | 1:1 with artifacts — full per-symbol detail |
| `circuit_breaker_events` | ~0–1 | Daily/weekly loss caps, manual halts |
| `scheduler_runs` | ~2 | Cron bookkeeping (PENDING → RUNNING → OK/FAILED) |
| `command_log` | ~0–20 | Every operator command, for audit |

Idempotency: every `CREATE TABLE` uses `IF NOT EXISTS`, and every migration
ends with `INSERT INTO schema_migrations (id) ... ON CONFLICT DO NOTHING`,
so re-running migrations is a no-op.

## Invariants (must hold at all times)

- **Artifacts are content-addressed**: `artifact_hash` = SHA-256 of the
  canonical JSON form of `{winning_parameters, code_hash,
  data_window_start, data_window_end, months_covered, symbols}`. Different
  hash ⇒ different artifact ⇒ re-verification required.
- **Live mode requires `is_active = TRUE` on exactly one artifact**:
  enforced by `loadArtifactFromDisk` + `verifyArtifact` at boot. Without an
  active artifact, the live loop aborts before the first tick.
- **Migrations are monotonic**: `schema_migrations.id` is a timestamp
  prefix + slug. Never edit a committed migration — add a new one.
- **Scheduler never runs two instances of the same job concurrently**: the
  `PENDING → RUNNING` CAS in `scheduler_runs` ensures at-most-once semantics
  even across bot restarts.
- **Commands are rate-limited server-side**: 1 req / 10 s per endpoint,
  enforced by `@fastify/rate-limit` with per-route config. UI surfaces
  429s as "Rate-limited (wait 10s)".
- **DB writes from the UI go through the bot, not directly**: the UI's
  `db/pool.ts` is used only for reads. All mutations happen inside the bot
  process so the audit trail in `command_log` captures every change.

## Deployment

Two target environments:

### Local dev
Docker-compose stack of postgres + bot + ui. `docker compose up -d`.

### Production (DigitalOcean App Platform)
`.do/app.yaml` declares one `services.ui`, one `workers.bot`, and one
managed `databases.hydra-db`. Deploy via `doctl apps create --spec
.do/app.yaml`. Binance credentials are set as `type: SECRET` env vars in
the DO UI; the infra file itself has no secrets in it.

Deployment on push to `main` is enabled by default
(`deploy_on_push: true`). To deploy a branch, either change the branch in
`app.yaml` and re-apply, or use `doctl apps create-deployment` manually.

## Observability

- **Structured logs**: pino → stdout → DO App Platform log aggregator.
  `LOG_FORMAT=json` in prod, `pretty` in dev.
- **Health endpoints**: `/health` (liveness), `/ready` (readiness, includes
  DB ping). DO polls `/` on the UI and `/health` on the bot every 30 s.
- **Dashboard metrics**: Dashboard page revalidates every 30 s and surfaces
  equity, KPIs, open positions, recent trades, regime status, and last
  regime check timestamp.
- **Audit trail**: `command_log` + `regime_check_log` +
  `revalidation_events` + `circuit_breaker_events` between them capture
  every meaningful state transition for post-hoc review.
