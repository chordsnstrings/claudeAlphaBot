# Hydra

Systematic crypto perpetual-futures trading bot with a built-in dashboard UI.
Targets Binance Futures BTCUSDT / ETHUSDT / SOLUSDT with five validated
strategies (ARB, NY_OPEN, WEEKEND_MR, FUNDING_FADE, BB_MR), daily regime
monitoring, and a fortnightly revalidation loop.

## Packages

This is a pnpm workspace with three packages:

| Package | Purpose |
| --- | --- |
| `@hydra/shared` | Domain types, constants, and small pure utilities shared between bot and UI. |
| `@hydra/bot` | Strategy engine, backtester, live-trading loop, scheduler, internal HTTP API. |
| `@hydra/ui` | Next.js 14 dashboard (server-rendered; reads Postgres directly; proxies commands to the bot). |

## Quick start

```bash
# 1. One-time setup
cp .env.example .env                    # fill in BINANCE_* if running paper/live
pnpm install

# 2. Start Postgres + run migrations
docker compose up -d postgres
pnpm --filter @hydra/bot migrate:up

# 3. Backfill historical candles (one-off, ~3 minutes)
pnpm --filter @hydra/bot backfill

# 4a. Local dev (two terminals)
pnpm --filter @hydra/bot dev            # bot + health API on :8080
pnpm --filter @hydra/ui dev             # dashboard on :3000

# 4b. Or docker-compose the whole stack
docker compose up -d
```

Visit <http://localhost:3000> for the dashboard.

## Modes

`BOT_MODE` controls runtime behaviour:

| Mode | What it does |
| --- | --- |
| `backtest` | Runs historical simulations only. Never touches an exchange. Default for local dev. |
| `paper` | Subscribes to live market data and logs what trades the bot *would* place. Requires Binance API keys but no trading permission. |
| `live` | Places real orders on Binance Futures. Requires keys with trading permission and a valid `validated_config.json` artifact. |

Switching live requires (a) a validated artifact with `deployment_allowed: true`,
(b) an operator approve-artifact API call, and (c) `BINANCE_TESTNET=false` set
explicitly. There is no implicit promotion path.

## Repository layout

```
.
├── .do/app.yaml              # DigitalOcean App Platform deploy spec
├── docker-compose.yml        # local dev stack
├── migrations/               # idempotent SQL migrations (IF NOT EXISTS)
├── packages/
│   ├── shared/               # @hydra/shared — types, constants, utils
│   ├── bot/                  # @hydra/bot — trading + scheduling + API
│   └── ui/                   # @hydra/ui — Next.js dashboard
├── ARCHITECTURE.md           # system diagrams, data flow, invariants
├── RUNBOOK.md                # operator procedures for production
├── TRADING_BOT_SPEC.md       # source-of-truth spec (20 phases)
└── SELF_REVIEW_LOG.md        # per-phase rubric checks
```

## Development commands

```bash
pnpm -r typecheck              # strict TypeScript check across all packages
pnpm -r test                   # run every vitest suite (318 tests, ~4.5s)
pnpm -r lint                   # alias for typecheck (tsc is our linter)
pnpm -r build                  # compile all packages

pnpm --filter @hydra/bot migrate:up         # apply migrations
pnpm --filter @hydra/bot backfill           # backfill Binance candles
pnpm --filter @hydra/bot validate-pipeline  # run the full validation pipeline

docker compose config          # validate the compose file
docker compose up --build      # rebuild + run the stack
```

## Further reading

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system design, data flow, component contracts.
- [`RUNBOOK.md`](./RUNBOOK.md) — how to deploy, monitor, and respond to incidents.
- [`TRADING_BOT_SPEC.md`](./TRADING_BOT_SPEC.md) — original product + engineering spec.
- [`SELF_REVIEW_LOG.md`](./SELF_REVIEW_LOG.md) — phase-by-phase implementation history.

## License

MIT (see `LICENSE`).
