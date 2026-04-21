# Claude Code Prompt: Hydra Trading Bot + Dashboard UI

**Paste everything below this line into Claude Code. Have `TRADING_BOT_SPEC.md` in the project root.**

**Invoke with:** `claude --dangerously-skip-permissions`

This mode runs autonomously without per-action confirmations. Every instruction below assumes that flag is set.

---

You are implementing a production crypto trading bot + dashboard UI. Read `TRADING_BOT_SPEC.md` completely before writing any code. It is the source of truth for bot behavior. If anything in this prompt conflicts with the spec, the spec wins.

## Execution model: autonomous with self-review gates

You run end-to-end without human checkpoints. Between phases, you **self-review against an explicit rubric** and fix any gaps before proceeding. You do not ask for approval. You do not pause for confirmation. You execute, verify, fix, commit, continue.

**Exception — automatic halts** (only these five conditions stop execution):

1. **Suspicious backtest results:** first BTC-only backtest shows >100% annualized return OR <5% max drawdown on 3+ months of data. Stop, write `SUSPICIOUS_RESULTS.md`, do NOT proceed. This is almost certainly a look-ahead bias bug.
2. **Validation pipeline produces `deployment_allowed: false`:** stop, write `VALIDATION_FAILED.md` with diagnosis, do NOT proceed to deployment.
3. **Security-relevant code change without rationale:** you cannot disable security checks, remove the deployment gate, bypass artifact verification, or commit secrets.
4. **Spec interpretation ambiguity resolved unsafely:** if you chose an interpretation that could cause financial loss, document in `INTERPRETATION_LOG.md` and stop.
5. **Same test fails 5+ times:** don't loop forever. Document in `BLOCKERS.md`, mark phase as incomplete, continue to next independent phase.

Otherwise: run straight through, commit liberally, self-review at every gate, fix, continue.

## Your mandate

Build:
1. **Trading bot** per spec — three modes (backtest/paper/live), validation pipeline gate, regime drift monitoring
2. **Dashboard UI** — internal web app, reads from shared database, issues commands to bot via internal API
3. **Deployment:** monorepo, two services on DO App Platform sharing one managed Postgres, bot service public, UI service private (VPC-only or IP-restricted)
4. Full `RUNBOOK.md` for non-DevOps operator

## Tech stack — bot (pinned)

- **Runtime:** Node.js 20 LTS
- **Language:** TypeScript 5.3+, strict mode, `noUncheckedIndexedAccess: true`
- **Package manager:** pnpm (monorepo workspaces)
- **Database:** PostgreSQL 15 (DO Managed)
- **DB driver:** `pg` (node-postgres)
- **Migrations:** `node-pg-migrate`
- **Binance:** `binance` library (Anatoly Gavryushov's maintained lib, NOT ccxt)
- **HTTP:** `fastify` (for bot's internal API + `/health`)
- **Scheduler:** `node-cron` + DB-backed recovery
- **Config:** `zod` + `dotenv`
- **Logging:** `pino` + `pino-pretty`
- **Testing:** `vitest`
- **Date:** `date-fns` + `date-fns-tz`
- **Numerical:** native JS for indicators; `decimal.js` for money only
- **HTTP retry:** `p-retry`

## Tech stack — UI (requirements, you choose exact libraries)

You decide the exact stack based on these constraints. Default to Next.js 14 App Router unless you have a specific reason to deviate.

**Must provide:**
- Server-side rendering capability (data is mostly in DB, not API calls — SSR faster)
- File-based routing with layouts
- Dark theme support (we only use dark)
- Good TypeScript support
- Well-maintained component library with headless/unstyled primitives (not Material UI or Chakra — those are heavy and opinionated)
- Ability to fetch from Postgres directly in server components (reduces API surface)
- Tailwind CSS (required — not negotiable, the design system uses it)

**Pick from these combinations, or justify deviation:**
- **Option A (recommended):** Next.js 14 + Tailwind + shadcn/ui + Recharts
- **Option B:** Remix + Tailwind + Radix Primitives + Recharts
- **Option C:** SvelteKit + Tailwind + Bits UI + LayerChart (only if you are confident)

Document your choice with 3-sentence rationale in `ARCHITECTURE.md`.

**Forbidden in UI:** TradingView widgets (licensing + heavy), Material UI, Chakra, Ant Design, any emoji in visual UI, gradients beyond the ones in the design system, drop shadows on anything except modal overlays.

## Project structure — monorepo

```
/
├── README.md
├── RUNBOOK.md
├── ARCHITECTURE.md
├── TRADING_BOT_SPEC.md
├── SELF_REVIEW_LOG.md          ← you append to this at every gate
├── package.json                ← root, workspace definitions
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .gitignore
├── .dockerignore
├── .env.example
├── docker-compose.yml
├── .do/
│   └── app.yaml                ← defines BOTH services + DB
├── .github/
│   └── workflows/
│       └── test.yml
├── migrations/                 ← shared, at root (both services need schema)
│   └── 1700000000000_initial-schema.sql
├── artifacts/
│   └── .gitkeep
├── packages/
│   ├── shared/                 ← types shared between bot and UI
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── types.ts        ← Candle, SignalIntent, Trade, etc.
│   │       └── constants.ts    ← shared enums/strings
│   ├── bot/                    ← trading bot service
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   ├── vitest.config.ts
│   │   ├── .eslintrc.cjs
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── config/
│   │   │   ├── core/
│   │   │   ├── backtest/
│   │   │   ├── execution/
│   │   │   ├── data/
│   │   │   ├── db/
│   │   │   ├── scheduler/
│   │   │   ├── monitoring/
│   │   │   ├── api/            ← internal REST API for UI to call
│   │   │   ├── cli/
│   │   │   └── util/
│   │   └── tests/
│   └── ui/                     ← Next.js dashboard
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.js
│       ├── tailwind.config.ts
│       ├── postcss.config.js
│       ├── Dockerfile
│       ├── public/
│       ├── src/
│       │   ├── app/            ← Next.js App Router
│       │   ├── components/
│       │   ├── lib/
│       │   ├── db/             ← direct Postgres access for server components
│       │   └── api-client/     ← typed fetch wrapper for bot internal API
│       └── tests/
```

## Self-review gate mechanism

Before advancing between phases, you execute `SELF_REVIEW` — a structured review against an explicit rubric. If any criterion fails, you fix it and re-review. Only when all criteria pass do you commit and advance.

Write your self-review to `SELF_REVIEW_LOG.md` using this format:

```markdown
## Gate: [Phase Name] — [timestamp]

### Criteria checked
- [x] Criterion 1 — PASS, evidence: <file/command/output>
- [x] Criterion 2 — PASS, evidence: ...
- [ ] Criterion 3 — FAIL, fixing... [after fix] PASS, evidence: ...

### Fixes applied during review
- Fixed X in file Y (commit <hash>)

### Decision
PASS — proceeding to next phase.
```

You cannot advance past a gate with any criterion unchecked. Append-only; never edit prior gate records.

## Phase plan

Each phase has an explicit rubric. Execute the phase, self-review, fix, commit with tag, advance.

---

### Phase 1: Monorepo scaffold + shared types

**Deliverables:**
- Root `package.json` with pnpm workspaces
- `packages/shared`, `packages/bot`, `packages/ui` directories
- Shared types package with Candle, SignalIntent, Trade, Direction, Regime, StrategyName, etc.
- Root `tsconfig.base.json` with strict settings
- All three sub-packages extend the base config

**SELF_REVIEW rubric:**
- [ ] `pnpm install` at root installs all workspace packages successfully
- [ ] `packages/shared/dist` builds without errors
- [ ] Both `bot` and `ui` can import `@hydra/shared` types
- [ ] No `any` types in shared package
- [ ] `tsconfig.base.json` has `noUncheckedIndexedAccess: true`

**Fix loop:** if any criterion fails, fix the specific issue, re-run the verification, update log.

**Commit + tag:** `git commit -am "Phase 1: Monorepo scaffold" && git tag phase-1`

---

### Phase 2: Database schema + migrations

**Deliverables:**
- `migrations/1700000000000_initial-schema.sql` per spec §8.5 and §8.12.6
- `packages/bot/src/db/migrator.ts` that runs migrations programmatically
- `packages/bot/src/db/pool.ts` connection pool
- Migrations runnable via `pnpm --filter bot migrate:up`

**Required tables (all with IF NOT EXISTS):**

```
candles, funding_rates, validated_artifacts, validation_snapshots,
trades, open_positions, account_equity_history, regime_check_log,
revalidation_events, circuit_breaker_events, scheduler_runs
```

**SELF_REVIEW rubric:**
- [ ] `docker compose up -d db && pnpm --filter bot migrate:up` succeeds
- [ ] `\dt` in psql shows all 11 tables
- [ ] Running migration a second time is a no-op (idempotent)
- [ ] Each table has proper indexes where spec §8.12.6 requires
- [ ] CHECK constraints present on mode, direction, outcome enums
- [ ] Run `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='trades'` — all columns match spec §8.5 exactly

**Commit + tag:** `phase-2`

---

### Phase 3: Environment, logging, health server

**Deliverables:**
- `packages/bot/src/config/env.ts` with zod schema per spec
- `packages/bot/src/monitoring/logger.ts` using pino
- `packages/bot/src/monitoring/health.ts` with Fastify `/health` + `/ready`
- `packages/bot/src/util/hash.ts` for code_hash computation
- `packages/bot/src/core/artifact.ts` for artifact load + verification
- `packages/bot/src/main.ts` stub: runs migrations, starts health, routes by BOT_MODE

**SELF_REVIEW rubric:**
- [ ] `pnpm --filter bot build` succeeds, no TS errors
- [ ] `BOT_MODE=backtest node packages/bot/dist/main.js` starts without error
- [ ] `curl localhost:8080/health` returns 200 with valid JSON
- [ ] Missing DATABASE_URL produces clear startup error (not silent default)
- [ ] Missing BINANCE_API_KEY with BOT_MODE=paper produces clear error
- [ ] Artifact verification rejects: missing file, stale (>30 days), bad code_hash, `deployment_allowed: false` — write test for each of these four cases
- [ ] Logger outputs structured JSON in production mode, pretty in dev

**Commit + tag:** `phase-3`

---

### Phase 4: Binance data layer

**Deliverables:**
- `packages/bot/src/data/binance-rest.ts` — REST client with retry via `p-retry`
- `packages/bot/src/data/historical-loader.ts` — paginated 18-month kline fetch for BTC/ETH/SOL
- `packages/bot/src/data/funding-loader.ts` — funding rate history
- `packages/bot/src/data/binance-ws.ts` — WebSocket candle subscription
- Rate limiting respected (Binance: 2400 weight/min for futures)

**SELF_REVIEW rubric:**
- [ ] Fetch 3 months (~2,190 candles) for BTC, persist to `candles` table
- [ ] Row count matches expected (±5 for edge boundaries)
- [ ] No gaps in timestamp sequence (detect with `SELECT MAX(open_time) - MIN(open_time) FROM candles GROUP BY symbol`)
- [ ] Fetch funding rates, persist to `funding_rates`, expect ~270 rows per symbol for 3 months
- [ ] WS client successfully receives at least 2 live candles from Binance testnet stream (skip if no internet — document in log)
- [ ] REST client retries on 429 rate limit, not on 4xx client errors

**Commit + tag:** `phase-4`

---

### Phase 5: Core indicators

**Deliverables:**
- `packages/bot/src/core/indicators.ts` — ATR(14), EMA(7/25/99), RSI(14), Bollinger(14,2), ADX(14), percentile
- All pure functions, no I/O
- Golden-value tests against TradingView/reference implementation

**SELF_REVIEW rubric:**
- [ ] All indicator functions return expected values for at least 3 synthetic test cases each
- [ ] `tests/core/indicators.test.ts` coverage ≥ 90%
- [ ] ATR uses Wilder's smoothing, not simple SMA (common bug)
- [ ] Bollinger uses population stddev (N), not sample stddev (N-1) — match Binance/TradingView
- [ ] EMA initialized from first value, not from SMA seed (common implementation difference)
- [ ] All functions handle empty/insufficient arrays by returning NaN or sentinel, not throwing
- [ ] Run indicators on 100 real BTC candles from phase 4, log sample output, visually confirm no absurd values

**Commit + tag:** `phase-5`

---

### Phase 6: Regime classifier + session utilities

**Deliverables:**
- `packages/bot/src/core/regime.ts` per spec §regime classifier behavior
- `packages/bot/src/core/sessions.ts` — session windows, range computation, candle-in-session helpers
- Tests for each regime state (RANGING, TRENDING_UP, TRENDING_DOWN, SQUEEZE, TRANSITION) using synthetic data

**SELF_REVIEW rubric:**
- [ ] Regime classifier returns RANGING for flat chop synthetic data
- [ ] Returns TRENDING_UP for monotonic uptrend synthetic data
- [ ] Returns SQUEEZE when BB width at historical low
- [ ] Returns TRANSITION right after a regime flip
- [ ] Session utilities: correct Asian range (00:00-07:00 UTC) for arbitrary date
- [ ] Session utilities handle daylight-saving-free UTC correctly (no off-by-one on month boundaries)
- [ ] `hasPriorBreakout` correctly identifies first-only breakouts

**Commit + tag:** `phase-6`

---

### Phase 7: Strategy A (Asian Range Breakout)

**Deliverables:**
- `packages/bot/src/core/signals-arb.ts` per spec §2
- Unit tests: positive case (should fire), negative cases (low volume, no breakout, outside window, weekend)

**SELF_REVIEW rubric:**
- [ ] Positive synthetic: Asian range 0.8%, London candle closes above high with 1.5× volume → fires LONG
- [ ] Negative: same setup but volume 1.0× → does NOT fire
- [ ] Negative: Saturday UTC → does NOT fire
- [ ] Negative: hour 12 UTC (past window) → does NOT fire
- [ ] Stop price = asian_low − 0.5 × ATR(14) for LONG (exact formula per spec §2.3)
- [ ] TP1 at 1.5R, TP2 at 3.0R, 50/50 allocation
- [ ] First-breakout-only enforcement works: synthetic with two breakouts — only first fires
- [ ] Signal includes time_stop = 20:00 UTC same day

**Commit + tag:** `phase-7`

---

### Phase 8: Risk module + circuit breakers

**Deliverables:**
- `packages/bot/src/core/risk.ts` — position sizing, exposure caps, quantity rounding
- `packages/bot/src/core/circuit-breakers.ts` — daily/weekly loss caps, consecutive loss cooldowns
- Tests for every sizing edge case

**SELF_REVIEW rubric:**
- [ ] Sizing formula: `notional = risk_usd / (stop_distance / entry_price)` — verified with spec §2.4 worked example numbers exactly
- [ ] At $5000 equity, 2% risk, 1% stop → $10K notional, 0.2 BTC at $50K price (round numbers test)
- [ ] Quantity rounded DOWN to step size (never up)
- [ ] Reject when notional < Binance minNotional (hardcoded $5)
- [ ] Exposure cap 2.5× equity enforced — reject or scale-down mode works
- [ ] Daily loss cap -5% triggers block of new entries same UTC day
- [ ] Weekly loss cap -12% triggers full halt (requires manual reset flag)
- [ ] 3 consecutive losses on symbol triggers 12h cooldown
- [ ] Cooldown only counts STOP exits, not TP1-then-breakeven partial wins

**Commit + tag:** `phase-8`

---

### Phase 9: Backtest engine + fill simulation

**Deliverables:**
- `packages/bot/src/backtest/replay-engine.ts` — bar-by-bar replay, strict no-look-ahead
- `packages/bot/src/backtest/fill-sim.ts` — order fill simulation with slippage
- `packages/bot/src/backtest/metrics.ts` — Sharpe, max DD, win rate, profit factor, per-strategy/symbol/month breakdown
- Look-ahead test (hardest test to get right)

**SELF_REVIEW rubric:**
- [ ] No-look-ahead test: signal generated with candles[0..N] vs candles[0..N+1] must produce identical result when evaluating at candle N's close time
- [ ] Fill sim: if candle high ≥ TP1 AND low ≤ stop in same candle, stop fills first (conservative)
- [ ] Fees deducted at 0.04% taker per side
- [ ] Slippage applied at 2bps (0.02%) per side
- [ ] Funding payments accrued at 00:00/08:00/16:00 UTC crossings while position open
- [ ] Run backtest on 3 months of BTC with Strategy A only
- [ ] **CRITICAL CHECK:** if return >100% or max DD <5% on 3 months → HALT, write SUSPICIOUS_RESULTS.md, do NOT proceed
- [ ] Metrics module produces per-month P&L table, per-strategy breakdown, per-symbol breakdown
- [ ] Sharpe calculation annualized correctly (√(365*24) multiplier for hourly bars → scaled to daily equivalent)

**Commit + tag:** `phase-9`

---

### Phase 10: Strategies B, C, D

**Deliverables:**
- `packages/bot/src/core/signals-ny-open.ts` per spec §3
- `packages/bot/src/core/signals-weekend-mr.ts` per spec §4
- `packages/bot/src/core/signals-funding-fade.ts` per spec §5
- Tests for each

**SELF_REVIEW rubric:**
- [ ] Each strategy has positive + ≥3 negative test cases
- [ ] NY Open: pre-range 11:00-13:00 UTC, breakout window 13:00-15:00 UTC, volume 1.4× threshold
- [ ] Weekend MR: fires on Monday 00:00 UTC when weekend move >3%, blocks if >1% gap
- [ ] Funding Fade: 30-min confirmation wait + 0.2% confirmation move, 0.8% stop, 1.5% target
- [ ] Funding Fade skipped when account equity < $3,000
- [ ] Run combined backtest with all 4 strategies enabled on 3 months of BTC
- [ ] Verify no two strategies fire on same candle same symbol (should be rare but possible — stronger signal wins)

**Commit + tag:** `phase-10`

---

### Phase 11: Veto layer + drift monitoring

**Deliverables:**
- `packages/bot/src/core/veto.ts` — HTF bias, funding gate, OI spike gate, correlation caps
- `packages/bot/src/core/drift-monitor.ts` per spec §8.12
- Validation snapshot capture on artifact creation

**SELF_REVIEW rubric:**
- [ ] Veto blocks: MR short when HTF (4H) trending up
- [ ] Veto blocks: MR long during HTF lower-band walking
- [ ] Veto reduces leverage when funding elevated but not opposing
- [ ] Drift monitor classifies UNCHANGED/DRIFTED/FLIPPED correctly per spec §8.12.2
- [ ] Portfolio aggregation: FLIPPED only when 2+ symbols flipped OR 1 symbol flipped 2 consecutive days
- [ ] FLIPPED triggers: pause new entries on affected symbols, do NOT close existing
- [ ] Validation snapshot stored alongside every artifact

**Commit + tag:** `phase-11`

---

### Phase 12: Full validation pipeline

**Deliverables:**
- `packages/bot/src/backtest/monte-carlo.ts` — 1000-run trade order randomization
- `packages/bot/src/backtest/walk-forward.ts` — rolling 6mo train / 2mo test
- `packages/bot/src/backtest/pipeline.ts` — orchestrates Stages 1-5 per spec §8.11.1
- `packages/bot/src/cli/run-validation.ts` — CLI entry

**SELF_REVIEW rubric:**
- [ ] `pnpm --filter bot validate-pipeline` runs end-to-end on 18 months of data (if you only have 3 months from phase 4, fetch more now)
- [ ] Outputs `artifacts/validated_config.json` with all fields per spec §8.11.2
- [ ] `deployment_allowed` is `true` OR pipeline halts with explanation
- [ ] Composite score formula matches spec §8.11.1 Stage 5 exactly
- [ ] Walk-forward produces train_sharpe and test_sharpe per window
- [ ] Monte Carlo produces distribution stats (p5, median, p95 returns and DDs)
- [ ] Code hash in artifact matches current `src/core/` hash
- [ ] **If validation pipeline sets `deployment_allowed: false`:** HALT, write VALIDATION_FAILED.md with stage-by-stage diagnosis, do NOT proceed to UI or deployment phases

**Commit + tag:** `phase-12`

---

### Phase 13: Execution adapters

**Deliverables:**
- `packages/bot/src/execution/adapter.ts` — ExecutionAdapter interface
- `packages/bot/src/execution/backtest-adapter.ts` — synthetic fills against OHLC
- `packages/bot/src/execution/paper-adapter.ts` — synthetic fills against streaming WebSocket prices
- `packages/bot/src/execution/live-adapter.ts` — real Binance Futures orders with STOP_MARKET + TAKE_PROFIT_MARKET brackets

**SELF_REVIEW rubric:**
- [ ] All three adapters implement same interface
- [ ] Backtest adapter used internally by replay engine
- [ ] Paper adapter: connects WebSocket, receives live candles, simulates entries at mark price × slippage
- [ ] Live adapter: places entry market order, then attaches STOP_MARKET and TAKE_PROFIT_MARKET as reduceOnly brackets
- [ ] Live adapter: on startup, reconciles with Binance — fetches open positions, rebuilds state
- [ ] Live adapter stores exchange_order_ids in open_positions for later cancellation
- [ ] Paper and live write to `trades` table with correct `mode` value

**Commit + tag:** `phase-13`

---

### Phase 14: Scheduler + bot internal API

**Deliverables:**
- `packages/bot/src/scheduler/runner.ts` — node-cron with DB-backed missed-run recovery
- `packages/bot/src/scheduler/jobs.ts` — daily regime check (00:30 UTC), fortnightly re-validation (every 14 days at 02:00 UTC)
- `packages/bot/src/api/routes.ts` — internal REST API for UI to call (no external auth; trust network)

**Internal API endpoints (for UI to consume):**

- `POST /api/commands/pause` — set BOT_MODE to backtest (stops new entries)
- `POST /api/commands/resume` — return to previous mode
- `POST /api/commands/force-revalidate` — trigger immediate re-validation
- `POST /api/commands/close-all-positions` — emergency close all (requires body `{"confirm": "CONFIRM_CLOSE_ALL"}`)
- `GET /api/status` — current mode, artifact info, open position count, uptime, last regime check
- `POST /api/commands/approve-artifact` — approve a pending artifact swap

Rate limit all command endpoints: max 1 per 10 seconds per endpoint.

**SELF_REVIEW rubric:**
- [ ] Scheduler runs daily check at 00:30 UTC test (set system clock forward, verify runs)
- [ ] Missed run recovery: kill bot at 00:25, restart at 00:35, daily check still runs
- [ ] All API endpoints return correct JSON shapes
- [ ] `force-revalidate` triggers actual pipeline run in background
- [ ] `close-all-positions` refuses without confirm token
- [ ] API listens on separate port or same Fastify instance as health
- [ ] Commands logged to dedicated `command_log` table (add migration for this)

**Commit + tag:** `phase-14`

---

### Phase 15: UI scaffold + design system

**This phase is big. Self-review has many criteria.**

**Deliverables:**
- `packages/ui` with chosen framework (default: Next.js 14 App Router)
- Tailwind configured with exact design tokens below
- Layout shell with grouped sidebar navigation
- Dark theme only (no light mode needed)
- Responsive: desktop sidebar collapses to mobile drawer
- Global loading, error, 404 pages
- Direct Postgres access configured for server components

#### Design system — pin these exactly

**Palette (Binance-inspired, slightly more refined):**

```css
/* Background hierarchy — darkest to lightest */
--bg-0: #0B0E11;           /* page background */
--bg-1: #14181F;           /* card background */
--bg-2: #1E2329;           /* elevated card / hover */
--bg-3: #2B3139;           /* input background */

/* Borders */
--border-subtle: #2B3139;
--border-default: #3C424B;
--border-strong: #5E6673;

/* Text */
--text-primary: #EAECEF;
--text-secondary: #B7BDC6;
--text-tertiary: #848E9C;
--text-disabled: #5E6673;

/* Accents — Binance yellow-gold */
--accent: #FCD535;
--accent-hover: #FFD84D;
--accent-muted: #FCD53522;     /* 13% alpha for subtle bg */

/* Semantic */
--green: #2EBD85;              /* up, win, long */
--green-bg: #2EBD8515;
--red: #F6465D;                /* down, loss, short */
--red-bg: #F6465D15;
--blue: #4A78E0;               /* info */
--orange: #F0B90B;             /* warning */
```

**Typography:**
- Font: `Inter` (load from Google Fonts, subset latin)
- Monospace: `JetBrains Mono` (for prices, IDs, hashes)
- Scale: 11px (table dense), 12px (secondary), 14px (default), 16px (subhead), 20px (page title), 28px (KPI number), 36px (hero KPI)
- Weight: 400 (body), 500 (emphasis), 600 (heading). Never 700 — reads heavy against dark bg.
- Line height: 1.5 for body, 1.25 for headings

**Spacing:** Tailwind default scale (4px units). Cards use `p-4` or `p-6`, never `p-5`.

**Radius:** `rounded-md` (6px) for inputs, `rounded-lg` (8px) for cards, `rounded-full` for pills. No `rounded-xl` or above.

**Elevation:** no drop shadows. Cards elevate via slightly lighter background (`bg-1`) on top of `bg-0`.

**Tables:** monospace for numbers, right-aligned. Alternating row backgrounds `bg-0` / `bg-1`. Hover: `bg-2`. Border only between rows, not between cells. Sticky header.

**Numbers in tables:**
- Prices: monospace, 2 decimals for USD, 8 for crypto qty
- Percentages: monospace, 2 decimals, signed (+3.42% green, −1.87% red)
- Timestamps: monospace, UTC, format "2026-04-20 14:23" (never relative "2 hours ago" in tables — relative time is fine in cards)

**Micro-animations — exact specs:**

- **All transitions:** `150ms cubic-bezier(0.4, 0, 0.2, 1)` (tailwind's `ease-out`) unless specified
- **Hover on interactive elements:** background color shift only, 150ms
- **Button press:** `scale(0.98)` on active, 100ms
- **Card entry on page load:** fade from 0 to 1 + `translateY(4px)` to 0, 200ms, staggered 30ms between cards
- **KPI number changes:** count up/down animation, 400ms ease-out (use `framer-motion` or custom `requestAnimationFrame`)
- **Tab switching:** 150ms fade + 100ms translate, never slide
- **Modal open:** backdrop fade 200ms, modal fade+scale from 0.96 to 1.0, 200ms ease-out
- **Toast notifications:** slide in from top-right, 200ms ease-out, auto-dismiss 4s with 200ms fade out
- **Skeleton loaders:** subtle pulse, 1.5s infinite, opacity 0.4 to 0.7
- **Chart hovers:** crosshair tooltip with 100ms fade, no scale
- **NEVER ANIMATE:** scroll, page transitions (they feel laggy), font size, font weight

**Accessibility non-negotiables:**
- All text contrast ratio ≥ 4.5:1 against its background
- Focus visible on all interactive elements (ring accent color, 2px offset)
- All actions keyboard accessible
- `prefers-reduced-motion` disables all non-essential animations (but keep hover states)

#### Grouped navigation (desktop sidebar, mobile drawer)

Structure:

```
OVERVIEW
├── Dashboard        (default landing, /dashboard)
└── Live Activity    (/activity) — streaming feed of recent trades/events

TRADING
├── Open Positions   (/positions)
├── Trade History    (/trades)
├── Performance      (/performance) — equity curve, metrics
└── Strategies       (/strategies) — per-strategy breakdown

SYSTEM
├── Regime Monitor   (/regime) — drift log, current state
├── Validation       (/validation) — pipeline runs, artifacts
└── Circuit Breakers (/breakers) — events, current state

CONTROLS
├── Commands         (/commands) — pause/resume/force-revalidate/close-all
└── Settings         (/settings) — read-only view of runtime config
```

Each group has a muted header (text-tertiary, 11px, uppercase, letter-spacing-wide). Active item: `bg-2` background, accent-color left border (2px), text-primary. Inactive: text-secondary, no background. Hover: `bg-1`.

Desktop: fixed 240px left sidebar. Mobile (<768px): slide-out drawer from left, trigger with hamburger in top bar. Drawer closes on nav click.

#### SELF_REVIEW rubric for Phase 15

- [ ] `pnpm --filter ui dev` starts Next.js on port 3000
- [ ] Open localhost:3000: see dark dashboard landing page
- [ ] Sidebar shows 4 groups, 11 items with correct grouping
- [ ] All 11 pages exist as routes (can be stubs for now)
- [ ] Resize window to 375px width: sidebar collapses to hamburger, drawer opens/closes smoothly
- [ ] Tab through nav items with keyboard: focus rings visible
- [ ] Inspect CSS: exact hex colors from design system present (grep for #0B0E11, #FCD535, etc.)
- [ ] Run Lighthouse on dashboard page: accessibility score ≥ 95
- [ ] Confirm zero usage of Material UI, Chakra, Ant Design, emojis, drop shadows
- [ ] Test `prefers-reduced-motion: reduce` — animations disabled
- [ ] Fonts loaded: Inter for UI, JetBrains Mono visible on a placeholder number
- [ ] No layout shift when page loads (CLS score in Lighthouse = 0)

**Commit + tag:** `phase-15`

---

### Phase 16: UI page — Dashboard

The main landing page. Must look polished, minimal, information-dense without being cluttered.

**Layout (desktop):**

```
┌─────────────────────────────────────────────────────────────┐
│ Top bar: Mode pill (PAPER/LIVE) | Uptime | Last check | Menu │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  KPI Row (4 cards)                                           │
│  ┌──────────┬──────────┬──────────┬──────────┐              │
│  │ Equity   │ Today    │ Week     │ All-Time │              │
│  │ $5,247   │ +2.4%    │ +8.1%    │ +43.2%   │              │
│  │ ↗        │ 3 trades │ 12 wins  │ 67% WR   │              │
│  └──────────┴──────────┴──────────┴──────────┘              │
│                                                              │
│  Equity Curve (large, full width, last 30 days)             │
│  ┌────────────────────────────────────────────────┐          │
│  │                                    ___/\_/\    │          │
│  │                         _________/             │          │
│  │                    ___/                        │          │
│  │  _/\_/\_/\___/\___/                           │          │
│  └────────────────────────────────────────────────┘          │
│                                                              │
│  Two-column: Open Positions | Recent Trades                 │
│  ┌──────────────────────┬──────────────────────┐            │
│  │ Open Positions (2)   │ Recent Trades (10)   │            │
│  │ ...                  │ ...                  │            │
│  └──────────────────────┴──────────────────────┘            │
│                                                              │
│  Regime state per symbol (3 compact cards)                  │
└─────────────────────────────────────────────────────────────┘
```

**Layout (mobile < 768px):** single column, everything stacks vertically in the same order.

**Components:**
- `<ModePill>`: "PAPER" in blue, "LIVE" in green, "BACKTEST" in gray. Rounded-full, px-2.5 py-0.5, font-semibold 11px, monospace.
- `<KpiCard>`: bg-1, p-6, rounded-lg. Title text-tertiary 12px. Number 28px monospace. Delta row: 12px with icon arrow. Click through to relevant page.
- `<EquityChart>`: Recharts `AreaChart`, gradient fill from accent-muted to transparent. No grid, subtle x-axis labels only. Hover shows crosshair + tooltip with equity + timestamp.
- `<PositionsTable>`: compact. Columns: Symbol | Direction | Entry | Current | PnL | Time. Direction is a small pill. PnL colored green/red. Clicking a row opens position detail drawer.
- `<TradesTable>`: columns: Time | Symbol | Strategy | Direction | PnL. Shows last 10. "View all" link to /trades page.
- `<RegimeCard>`: one per symbol. Shows current regime, confidence bar, last check time. Green dot = UNCHANGED, amber = DRIFTED, red = FLIPPED.

**Data fetching:** all server components. Query Postgres directly via `pg` pool. Revalidate every 30 seconds with Next.js `revalidate: 30` or on-demand via Server Actions from "Refresh" button.

**SELF_REVIEW rubric:**
- [ ] Dashboard loads with real data from DB (seed with fixture data if backtest/paper hasn't produced any)
- [ ] All 4 KPI cards render with correct values
- [ ] Equity chart renders with gradient, hover tooltip works
- [ ] Open positions table renders, click row opens drawer
- [ ] Recent trades table renders, correct sorting by time desc
- [ ] Regime cards show 3 symbols with correct color coding
- [ ] Mobile layout: everything stacks, no horizontal scroll
- [ ] Numbers in all tables are right-aligned and monospace
- [ ] No emojis, no drop shadows, no gradients except the chart fill
- [ ] Page loads in <2s (server-rendered)
- [ ] Micro-animations: KPI cards stagger-fade in on load (30ms stagger, 200ms each)
- [ ] Refresh button: subtle spinner, 300ms debounced

**Commit + tag:** `phase-16`

---

### Phase 17: UI pages — remaining 10

Build the other 10 pages per the nav structure. Each follows the design system strictly.

**Shared rubric for every page:**
- [ ] Uses only design tokens from Phase 15
- [ ] Server-rendered where possible
- [ ] Mobile-responsive, no horizontal scroll at 375px
- [ ] All data bound to real DB queries
- [ ] Loading state: skeleton rows matching final layout (no spinner in center of page)
- [ ] Error state: inline error message, "Retry" button, does NOT crash the app
- [ ] Empty state: clear text, optional illustration (simple line-art, text-tertiary color, 80px max)
- [ ] Tables use sticky headers, pagination at bottom
- [ ] All interactive elements keyboard accessible

**Per-page notes:**

- **Live Activity** — WebSocket or polling feed showing stream of bot events (signal fired, signal vetoed, trade opened, trade closed, regime check ran). Each event is a compact row. 100 most recent, auto-scroll new ones in from top.

- **Open Positions** — full table with all columns from `open_positions`, plus computed: current price (from latest candle), unrealized PnL, distance to stop, distance to TP. Row click opens side drawer with full position detail and manual "Close position" button (fires command API).

- **Trade History** — full paginated table of trades with filters: mode, strategy, symbol, date range, exit reason. Export CSV button. Each row expandable to show entry/exit prices, stops, TPs, reasoning text.

- **Performance** — equity curve (same as dashboard but with date range picker), below it: metrics table (Sharpe, Sortino, Calmar, max DD, win rate, profit factor) computed on the selected window. Below that: monthly P&L heatmap (Binance-style color coded cells). Below that: per-strategy breakdown table.

- **Strategies** — one card per strategy (ARB, NY_OPEN, WEEKEND_MR, FUNDING_FADE). Each card shows: enabled toggle (read-only — toggling requires command API call), trade count, win rate, total PnL, avg R per trade, expectancy. Small equity chart per strategy.

- **Regime Monitor** — current regime state per symbol (3 large cards), below it: timeline chart showing regime states over last 30 days. Below that: `regime_check_log` table with outcome-colored rows.

- **Validation** — list of all `validated_artifacts`, newest first. Each row: created_at, composite_score, deployment_allowed (icon), code_hash (short). Current active artifact highlighted. Click row: modal with full artifact JSON rendered as nested expandable tree.

- **Circuit Breakers** — current state (daily P&L, weekly P&L, cooldowns active), then `circuit_breaker_events` table of historical triggers.

- **Commands** — list of available commands as large buttons with confirmation modals: Pause Trading, Resume Trading, Force Revalidate, Close All Positions (requires typing "CONFIRM"), Approve Pending Artifact (only visible if one exists). Each button disabled during action with spinner.

- **Settings** — read-only view of runtime environment: mode, starting equity, enabled strategies, risk parameters from current artifact, database connection status. All values copyable with one click.

**SELF_REVIEW rubric:**
- [ ] All 10 pages exist and route correctly from sidebar
- [ ] Each page passes the shared rubric above
- [ ] Live Activity streams new events without full page refresh
- [ ] Trade History CSV export downloads valid CSV
- [ ] Performance metrics match backtest module output exactly (same data, same math)
- [ ] Commands: test pause/resume round-trip against running bot, verify state changes
- [ ] Commands: test close-all refuses without "CONFIRM" typed
- [ ] Mobile layout on each page: tables become horizontally-scrollable cards or stacked key-value lists
- [ ] Performance page: month heatmap cells colored correctly, tooltip shows month + P&L
- [ ] Validation page: artifact JSON tree expand/collapse works

**Commit + tag:** `phase-17`

---

### Phase 18: Dockerfiles + docker-compose + .do/app.yaml

**Deliverables:**
- `packages/bot/Dockerfile` (multi-stage, Node 20-slim)
- `packages/ui/Dockerfile` (multi-stage, Node 20-slim, standalone Next.js output)
- Root `docker-compose.yml` running all three services (bot, ui, db) locally
- `.do/app.yaml` defining two services + one database

**Critical `.do/app.yaml` structure:**

```yaml
name: hydra-trading
region: nyc

services:
  - name: bot
    dockerfile_path: packages/bot/Dockerfile
    github:
      repo: YOUR_USERNAME/hydra-bot
      branch: main
      deploy_on_push: true
    instance_count: 1
    instance_size_slug: basic-xs
    http_port: 8080
    health_check:
      http_path: /health
    envs:
      # (bot env vars — BOT_MODE, DATABASE_URL, BINANCE_*, TELEGRAM_*, etc.)

  - name: ui
    dockerfile_path: packages/ui/Dockerfile
    github:
      repo: YOUR_USERNAME/hydra-bot
      branch: main
      deploy_on_push: true
    instance_count: 1
    instance_size_slug: basic-xs
    http_port: 3000
    internal_ports:
      - 3000
    # IMPORTANT: no routes section — makes this service accessible only from within DO VPC
    envs:
      - key: DATABASE_URL
        scope: RUN_TIME
        value: ${db.DATABASE_URL}
      - key: BOT_INTERNAL_API_URL
        scope: RUN_TIME
        value: "http://bot:8080"
      - key: NODE_ENV
        value: "production"

databases:
  - name: db
    engine: PG
    version: "15"
    production: false
    size: db-s-1vcpu-1gb
```

The trick: the `ui` service has no `routes` section, so DO doesn't expose it to the public internet. It's only accessible from within the app's VPC or via `doctl apps tunnel`.

**SELF_REVIEW rubric:**
- [ ] `docker compose up` starts db, bot, ui
- [ ] `curl localhost:8080/health` returns 200
- [ ] `curl localhost:3000` returns UI HTML
- [ ] UI running in docker can query the db service (internal hostname)
- [ ] Bot Dockerfile uses multi-stage, final image < 400MB
- [ ] UI Dockerfile uses Next.js standalone output, final image < 250MB
- [ ] Both containers run as non-root user
- [ ] Both have HEALTHCHECK directives
- [ ] `.do/app.yaml` validates with `doctl apps spec validate .do/app.yaml`
- [ ] UI service has no public routes (verify by reading the yaml)

**Commit + tag:** `phase-18`

---

### Phase 19: RUNBOOK + ARCHITECTURE docs + README

**Deliverables:**
- `README.md` — 1-page project overview, quick start, link to other docs
- `ARCHITECTURE.md` — tech stack rationale, module boundaries, diagrams
- `RUNBOOK.md` — full operator guide (see structure below)

**RUNBOOK must cover:**

1. **One-time local setup** (install, clone, docker compose up, migrate, seed)
2. **GitHub setup** (create private repo, push, configure actions)
3. **DigitalOcean account setup** (sign up, billing, API token, doctl)
4. **Connect GitHub to DO** (App Platform create app, authorize GitHub, review resources)
5. **Set bot secrets** in DO console (BINANCE_API_KEY, etc., mark as encrypted)
6. **First deployment** (click create, watch build, verify /health)
7. **Accessing the UI** (VPC access or doctl tunnel):
   - DO App Platform console → Components → UI → "View Live App" works from browser logged into DO
   - For mobile/off-network access: install Tailscale, join DO Droplet to tailnet, access UI via tailnet IP
   - OR: add IP allowlist to UI service ingress restricting to your office/home IP
8. **Running validation pipeline** (run locally, commit artifact, push → deploys)
9. **Switching BOT_MODE** between paper and live (DO console env var, auto-redeploys)
10. **Ongoing ops cheat sheet** (logs, restart, rollback, DB connect, CSV export)
11. **Troubleshooting** (5-7 common scenarios)
12. **Monthly cost breakdown** (~$40 for two services + DB at 1vcpu-1gb each)

**SELF_REVIEW rubric:**
- [ ] RUNBOOK has all 12 sections, each actionable
- [ ] Every command in RUNBOOK is copy-pasteable (no placeholders without clear markers)
- [ ] Includes specific doctl commands with `--format` flags for parseable output
- [ ] ARCHITECTURE.md explains why Next.js (or whatever you picked) was chosen
- [ ] ARCHITECTURE.md documents the three-tier structure (shared / bot / ui)
- [ ] README has 30-second pitch, 5-minute quickstart, links to RUNBOOK + ARCHITECTURE + SPEC

**Commit + tag:** `phase-19`

---

### Phase 20: Final validation gate

**Deliverables:** verification of the entire system end-to-end.

**SELF_REVIEW rubric:**
- [ ] All phases 1-19 tagged in git
- [ ] `pnpm typecheck` clean across all packages
- [ ] `pnpm lint` clean across all packages
- [ ] `pnpm test` green, coverage ≥80% in `core/` and `backtest/`
- [ ] `docker compose up` runs all services healthy
- [ ] Validation pipeline produces `deployment_allowed: true` artifact
- [ ] UI renders dashboard with real data from paper mode trades
- [ ] Deployment gate test: manually corrupt artifact, bot refuses to start with clear error
- [ ] No secrets in git history (`git log -p | grep -iE "(api_key|secret|password|token)"` returns only documentation mentions)
- [ ] `.do/app.yaml` validates with doctl
- [ ] SELF_REVIEW_LOG.md has gate entries for all 19 prior phases, all PASS

**Final action:**

Write `HANDOFF.md` with:
- Status of every phase (PASS/FAIL + notes)
- List of any BLOCKERS, SUSPICIOUS_RESULTS, VALIDATION_FAILED files
- Specific next actions the human operator needs to do (e.g., "sign up for DigitalOcean, run validation pipeline locally, push artifact")
- Known issues or deviations from spec

**Commit + tag:** `phase-20-complete`

---

## Self-review enforcement

After every phase, before advancing, append to `SELF_REVIEW_LOG.md`:

```markdown
## Gate: Phase N — YYYY-MM-DD HH:MM UTC

### Criteria checked
- [x] Criterion 1 — PASS, evidence: <specific file/command output>
- [x] Criterion 2 — PASS, evidence: ...
- [ ] Criterion 3 — FAIL initially
      Fix: <what you did>
      Recheck: PASS, evidence: ...

### Fixes applied during this review
- Fix 1 (commit abc123)
- Fix 2 (commit def456)

### Final decision
PASS — advancing to Phase N+1
```

If any criterion fails more than 5 times:
- Document in `BLOCKERS.md`
- Mark phase as INCOMPLETE
- Continue to next phase if independent, else halt

If a HALT condition triggers (suspicious backtest, validation failed, security issue, interpretation ambiguity):
- Write the corresponding `.md` file with full diagnosis
- Do NOT commit further changes to that subsystem
- Stop execution for that phase
- Continue only with subsystems unaffected

## Non-negotiable principles (repeating for emphasis)

- **UTC everywhere.** `.getHours()` is a bug.
- **No look-ahead in backtest.** The test is mandatory.
- **Numbers in UI are monospace.** Always.
- **No drop shadows. No gradients except chart fills. No emojis in UI.**
- **The spec wins.** When in doubt, re-read.
- **Fail loud, fail early.** Silent fallbacks are bugs.
- **Commit per phase.** Small commits within phases are fine, but every phase ends with a tag.

## Start now

1. Confirm you read `TRADING_BOT_SPEC.md` completely. Summarize in 5 sentences.
2. Begin Phase 1 immediately.
3. Execute, self-review against the rubric, fix any fails, commit, tag, advance.
4. Do not ask for confirmation. Do not pause between phases. Run straight through.
5. Only halt if a HALT condition (suspicious backtest / failed validation / security issue / interpretation ambiguity) is met.

Go.
