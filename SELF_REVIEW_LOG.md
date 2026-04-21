# Hydra Self-Review Log

Append-only record of phase gate reviews. Format specified in `CLAUDE_CODE_PROMPT.md`.

---

## Gate: Phase 1 — Monorepo scaffold + shared types — 2026-04-21 UTC

### Criteria checked
- [x] `pnpm install` at root installs all workspace packages successfully — PASS, evidence: `Progress: resolved 486, ... Done in 13.5s` (4 workspace projects detected)
- [x] `packages/shared/dist` builds without errors — PASS, evidence: `tsc -p tsconfig.json` exits 0; `constants.js`, `index.js`, `types.js` plus `.d.ts` files produced in `packages/shared/dist/`
- [x] Both `bot` and `ui` can import `@hydra/shared` types — PASS, evidence: `pnpm --filter @hydra/bot typecheck` and `pnpm --filter @hydra/ui typecheck` both exit 0 with real consumer files (`packages/bot/src/util/smoke-shared.ts`, `packages/ui/src/lib/smoke-shared.ts`) that import `Candle`, `SignalIntent`, `Trade`, `BotStatus`, `OpenPosition`, and the enum constants
- [x] No `any` types in shared package — PASS, evidence: `grep -n '\bany\b' packages/shared/src` returns no matches
- [x] `tsconfig.base.json` has `noUncheckedIndexedAccess: true` — PASS, evidence: line 8 of `tsconfig.base.json`

### Fixes applied during review
- None — first pass clean.

### Final decision
PASS — advancing to Phase 2.

---

## Gate: Phase 2 — Database schema + migrations — 2026-04-21 UTC

### Criteria checked
- [x] `docker compose up -d db && pnpm --filter bot migrate:up` succeeds — PASS (modified: used local systemd Postgres 16 since the sandbox has no docker daemon; functionally equivalent). Evidence: `{"applied":["1700000000000_initial-schema"],...,"appliedCount":1}`
- [x] `\dt` in psql shows all 11 required tables — PASS. Evidence: `\dt` shows `candles, funding_rates, validated_artifacts, validation_snapshots, trades, open_positions, account_equity_history, regime_check_log, revalidation_events, circuit_breaker_events, scheduler_runs` (plus bookkeeping `schema_migrations`).
- [x] Running migration a second time is a no-op (idempotent) — PASS. Evidence: second run output `{"applied":[],"skipped":["1700000000000_initial-schema"],"appliedCount":0,"skippedCount":1}`. Additionally every `CREATE TABLE`/`CREATE INDEX` uses `IF NOT EXISTS` (27 of 27, verified via grep) so even direct SQL re-execution would be safe.
- [x] Each table has proper indexes where spec §8.12.6 requires — PASS. Spec §8.12.6 calls for per-symbol regime log and per-event reval log; migration adds `regime_symbol_ts_idx`, `regime_ts_idx`, `reval_started_idx`, plus the supporting indexes on `trades`, `candles`, `funding_rates`, `account_equity_history`, `open_positions`, `scheduler_runs`, `circuit_breaker_events`, `validated_artifacts`. Full list confirmed via `pg_indexes` query (27 indexes).
- [x] CHECK constraints present on mode, direction, outcome enums — PASS. Evidence: `trades_mode_chk`, `trades_direction_chk`, `trades_exit_chk`, `trades_strategy_chk`, `trades_symbol_chk`, `positions_*_chk`, `regime_outcome_chk`, `regime_current_chk`, `regime_val_chk`, `reval_trigger_chk`, `cb_kind_chk`, `cb_symbol_chk`, `equity_mode_chk`, `candles_symbol_chk`, `candles_ohlc_chk`, `funding_symbol_chk`, `sched_status_chk` — all defined in `migrations/1700000000000_initial-schema.sql`.
- [x] Trades columns match spec §8.5 exactly — PASS. Every §8.5 field is present: trade_id, strategy, symbol, direction, entry_time, entry_price, quantity, notional_usd, stop_price, tp1_price, tp2_price, exit_time, exit_price, exit_reason, pnl_usd, pnl_r, fees_paid, account_equity_before, account_equity_after. Added `mode` column is permitted by §8.10 ("or with a `mode` column") for paper/live segregation.

### Notes / deviations
- Docker is not available in this sandbox; Postgres 16 was started locally via systemd and user `hydra` + database `hydra` provisioned. Schema and idempotency were verified against a real Postgres server. Docker Compose will still work when run against a local Docker daemon in Phase 18.

### Fixes applied during this review
- None — first pass clean.

### Final decision
PASS — advancing to Phase 3.

---

## Gate: Phase 3 — Environment, logging, health server — 2026-04-21 UTC

### Criteria checked
- [x] `pnpm --filter bot build` succeeds, no TS errors — PASS. Evidence: `tsc -p tsconfig.json` exits 0; `dist/main.js` + `dist/config`, `dist/db`, `dist/core`, `dist/monitoring`, `dist/util`, `dist/cli` all produced with source maps and declarations.
- [x] `BOT_MODE=backtest node packages/bot/dist/main.js` starts without error — PASS. Evidence: bot booted, ran migrations (all skipped — idempotent), computed code hash `sha256:f45ba19266c…`, started health server on :8080, logged `mode=backtest: idle`, and cleanly shut down on SIGTERM.
- [x] `curl localhost:8080/health` returns 200 with valid JSON — PASS. Evidence: `HTTP 200` with body `{"status":"ok","mode":"backtest","uptime_ms":2825,"timestamp":"2026-04-21T03:38:33.252Z"}`.
- [x] Logger outputs structured JSON in production mode, pretty in dev — PASS. Evidence: with `NODE_ENV=production`, every line is single-line JSON (`{"level":30,"time":"…","pid":…,"hostname":"…","msg":"…"}`); with `NODE_ENV=development` + `LOG_FORMAT=pretty`, lines render with ANSI timestamps and level tags (`[03:38:30.435] INFO: hydra boot`).
- [x] Env loader rejects missing required vars with clear messages — PASS. Evidence: vitest `tests/config/env.test.ts` (6/6 passing) covers missing `DATABASE_URL`, paper mode missing `BINANCE_API_KEY`, paper mode missing `ARTIFACT_PATH`, live mode missing `BINANCE_API_SECRET`, and numeric coercion of `BOT_HTTP_PORT`; all error paths assert zod / guard messages that name the missing variable.
- [x] Artifact verification enforces §8.11.3 (blocks stale / code-hash mismatch / `deployment_allowed=false`) — PASS. Evidence: vitest `tests/core/artifact.test.ts` (8/8 passing) covers clean artifact, `deploymentAllowed=false` rejection, stale-threshold (>30d) rejection, `code_hash` mismatch rejection, boundary fresh artifact, multi-error aggregation (no short-circuit), missing file, and round-trip through a real temp file. Integration smoke: `BOT_MODE=paper ARTIFACT_PATH=/nonexistent/artifact.json` exits with code 1 and prints `ArtifactVerificationError: Artifact verification failed: • Artifact file not found at path: /nonexistent/artifact.json. Run validation pipeline first.`
- [x] All 3 packages typecheck + lint clean — PASS. Evidence: `pnpm -r typecheck` shows `packages/shared typecheck: Done`, `packages/ui typecheck: Done`, `packages/bot typecheck: Done` (using split `tsconfig.test.json` so tests type-check under a non-composite project while `tsconfig.json` stays clean for the build).

### Fixes applied during this review
- Initial `tsconfig.test.json` inherited `rootDir: "./src"` from the build config and tried to include `tests/**/*.ts`, which produced TS6059 errors; then overriding with `"rootDir": "."` broke the `@hydra/shared` path alias (shared package is outside `packages/bot`). Resolved by having `tsconfig.test.json` extend `../../tsconfig.base.json` directly (not the build tsconfig), re-declare the `@hydra/shared` paths, and set `noEmit: true`. Build (`tsconfig.json`) stays composite + emits to `dist/`; typecheck/lint (`tsconfig.test.json`) covers src + tests with no emit.

### Notes
- Pino 8 ESM subpath requires `import { pino } from "pino"` (named), not the default export, otherwise `pino(opts)` throws "This expression is not callable". Code already uses the named form.
- `exactOptionalPropertyTypes: true` rejects `{ base: undefined }`; we omit the `base` key entirely from `LoggerOptions` instead.

### Final decision
PASS — advancing to Phase 4.
