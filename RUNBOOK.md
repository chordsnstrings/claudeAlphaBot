# Runbook

Operator procedures for Hydra. Read this before touching production.

Conventions:
- `SSH` commands assume you are on a DO App Platform console. Substitute with
  `docker exec -it hydra-bot-1 …` locally.
- `DB` commands run from `psql "$DATABASE_URL"` or the DO managed-database web
  console. Everything is read-safe unless explicitly marked **DESTRUCTIVE**.
- Every procedure has a rollback path. Do not skip it.

---

## First deploy

1. **Prereqs**
   - DigitalOcean account with App Platform + managed Postgres enabled.
   - `doctl` installed locally and authenticated (`doctl auth init`).
   - Binance Futures API keys (start with testnet — `BINANCE_TESTNET=true`).
2. **Apply the spec**
   ```bash
   doctl apps create --spec .do/app.yaml
   ```
   Wait ~5–10 min for build + first deploy.
3. **Set secrets**
   In the DO UI for each service, add `BINANCE_API_KEY` and `BINANCE_API_SECRET`
   as RUN_TIME secrets.  Trigger a new deploy.
4. **Verify health**
   ```bash
   curl -sS https://<ui-domain>/ -o /dev/null -w "%{http_code}\n"     # → 200
   ```
   In the UI, dashboard should render with "No equity history yet" and all
   empty states. That's correct for a fresh deploy.
5. **Backfill historical data** (one-off, ~3 min)
   ```bash
   doctl apps console <app-id> --service bot --command "node packages/bot/dist/cli/backfill.js"
   ```
6. **Run initial validation** (~30–60 min depending on params)
   ```bash
   doctl apps console <app-id> --service bot --command "node packages/bot/dist/cli/run-validation.js"
   ```
   This populates `validated_artifacts`. Check the Validation page in the UI.
7. **Approve an artifact** (UI → /commands → "Approve Artifact"). This sets
   `is_active = TRUE` on one artifact. Without this step, `BOT_MODE=live`
   aborts on boot.

---

## Daily checks (00:30 UTC + any time during session)

1. Dashboard `/` — equity curve looks reasonable, no big unexplained drawdown.
2. Regime Monitor `/regime` — all three symbols show UNCHANGED (or DRIFTED
   with low confidence delta). Any `FLIPPED` row means revalidation was
   triggered overnight — verify `/validation` has a new artifact.
3. Circuit Breakers `/breakers` — header says "ALL CLEAR". If not, see
   *Incident: breaker tripped* below.
4. Live Activity `/activity` — spot-check last 20 events make sense for the
   volume of candles that have closed.
5. Open Positions `/positions` — count matches the trading log; no position
   older than its configured time stop.

---

## Common procedures

### Pause trading (non-destructive)

```
UI → /commands → "Pause Trading"
```

Switches `BOT_MODE` to `backtest` in memory. Open positions are **not**
closed; the bot simply stops generating new signals. Resume with the Resume
button to restore the previous mode.

Rollback: "Resume Trading" button.

### Resume trading

```
UI → /commands → "Resume Trading"
```

Sets mode back to the previous value (`paper` or `live`). Rejected if the
bot was already unpaused.

### Force a revalidation run

```
UI → /commands → "Force Revalidation"
```

Inserts a `revalidation_events` row with `trigger_reason='MANUAL'` and
queues the same worker the fortnightly cron uses. Completes in ~30 min.
View progress in `/activity`.

Rollback: none needed — the run is idempotent and only *proposes* a new
artifact; live params don't change until you approve it.

### Approve a validated artifact (promote to live)

1. Check `/validation` — find the most recent row with `deployment_allowed =
   ALLOWED`. Confirm `composite_score > 0` and the run covered the
   expected data window.
2. UI → `/commands` → "Approve Artifact <hash>" button.
3. Confirm the modal. The bot flips `is_active` on the new artifact
   (unsetting the old one in the same transaction) and the live loop
   picks up the new parameters on the next candle close.

**Rollback** (if the new artifact behaves badly): re-approve the
previously-active artifact, OR pause and approve a specific `artifact_hash`
via psql:
```sql
BEGIN;
UPDATE validated_artifacts SET is_active = FALSE WHERE is_active = TRUE;
UPDATE validated_artifacts SET is_active = TRUE  WHERE artifact_hash = 'xxx';
COMMIT;
```
Then restart the bot so boot verification re-runs.

### Close all open positions (**DESTRUCTIVE**)

```
UI → /commands → "Close All Positions"
```

The button requires a `window.confirm`. The body sent is
`{confirm: "CONFIRM_CLOSE_ALL"}` — the bot rejects the request otherwise.
Market-closes every open position at current book. **No rollback.**

Use only for:
- Imminent exchange outage or maintenance window.
- Suspected strategy malfunction where continuing is riskier than the
  market-close slippage.
- Operator decision to exit the market entirely.

### Flip to live mode (first time)

1. Start in `BOT_MODE=paper` for at least one week. Verify the paper trades
   make sense and match backtest expectations.
2. Set `BINANCE_TESTNET=false` in the DO UI. *Does not yet enable live*.
3. Approve the currently-active artifact (redundant but sanity check).
4. Set `BOT_MODE=live` in the DO UI. Trigger a redeploy.
5. Bot reboots, verifies the active artifact against the current code hash
   (aborts loud if mismatch), and starts the live loop.
6. Watch `/positions` + `/activity` for the first real trade. First trade
   should match a paper trade from the same candle.

**Rollback**: Pause → set `BOT_MODE=paper` → redeploy. Any live positions
remain open until you close them explicitly.

---

## Incidents

### Incident: breaker tripped

Symptom: `/breakers` shows an ACTIVE row.

1. Read the `kind` column:
   - `DAILY_LOSS_CAP` — bot lost > daily cap; resumes automatically at next
     00:00 UTC unless you intervene.
   - `WEEKLY_LOSS_CAP` — bot lost > weekly cap; resumes Monday 00:00 UTC.
   - `SYMBOL_COOLDOWN` — single symbol hit consecutive-loss cap; resumes
     automatically after the cooldown elapses.
   - `MANUAL_HALT` — operator triggered; resumes only with "Resume Trading".
2. Decide whether the cause is an outlier move (trust the breaker, let it
   reset) or a strategy malfunction (pause + investigate).
3. If a real bug: pause, grab logs (`doctl apps logs <app-id> --type=run
   --service=bot`), file an issue.

### Incident: bot crash-looping on boot

Symptom: DO dashboard shows the `bot` worker failing health checks.

1. Check logs: `doctl apps logs <app-id> --type=run --service=bot --tail=100`.
2. Common causes:
   - `ArtifactVerificationError` — code hash changed without re-validation.
     Run the validation pipeline, approve the new artifact, redeploy.
   - Postgres connection refused — managed DB is resizing or down. Wait
     and/or file DO ticket; bot will retry on its own once DB is up.
   - Missing `BINANCE_API_KEY` in live/paper mode — set the secret, redeploy.
3. If you must bypass temporarily: set `BOT_MODE=backtest` (no artifact
   needed), redeploy, fix root cause, promote back up.

### Incident: stuck revalidation run

Symptom: `revalidation_events` has a row with `started_at_utc` hours ago
and `completed_at_utc IS NULL`.

1. Check bot logs for a stack trace; if the process died mid-run, the row
   is stale.
2. Clean up:
   ```sql
   UPDATE revalidation_events
      SET completed_at_utc = EXTRACT(EPOCH FROM now()) * 1000,
          notes = 'manually marked failed — process died'
    WHERE completed_at_utc IS NULL
      AND started_at_utc < EXTRACT(EPOCH FROM now() - INTERVAL '2 hours') * 1000;
   ```
3. Re-trigger via UI → "Force Revalidation".

### Incident: scheduler missed a run

Symptom: "Last regime check" on the dashboard is > 24 h old.

1. Inspect `scheduler_runs`:
   ```sql
   SELECT job_name, scheduled_for_utc, status, error_message
     FROM scheduler_runs
    ORDER BY scheduled_for_utc DESC LIMIT 10;
   ```
2. If there's a `PENDING` row with `scheduled_for_utc` in the past, the
   bot recovers on next start — restart the bot.
3. If there's a `FAILED` row, read `error_message`, fix the cause, then
   ```sql
   UPDATE scheduler_runs SET status = 'PENDING' WHERE id = <row-id>;
   ```
   and restart.

### Incident: exchange rejects orders

Symptom: live trades logged with `exit_reason = MANUAL` and PnL =
negative fees only.

1. Check `circuit_breaker_events` — may have already halted.
2. Check Binance status page. If API is degraded, pause until resolved.
3. If keys are revoked / wrong: re-issue keys, update DO secret, redeploy.

---

## Disaster recovery

### Restore from DO managed-DB backup

DO takes daily backups automatically (7-day retention on the dev tier).

1. DO UI → Databases → hydra-db → Backups → pick a point-in-time.
2. Create a fork database from the backup.
3. Point the app at the fork by updating the DATABASE_URL binding (or
   create a new app pointing at the fork for verification, then switch).

### Lost artifacts / validated_config.json

The bundled `artifacts/validated_config.json` is committed to the repo
for a reason — it's the initial, reproducible seed. To regenerate:

```bash
pnpm --filter @hydra/bot validate-pipeline --start 2024-01-01 --months 12
```

Then commit the new `artifacts/validated_config.json` and redeploy.

---

## Getting help

- Phase-by-phase implementation history: `SELF_REVIEW_LOG.md`
- System design: `ARCHITECTURE.md`
- Product spec: `TRADING_BOT_SPEC.md`

For bugs, attach: `doctl apps logs <app-id> --tail=500` output, screenshots
of `/breakers`, `/activity`, `/dashboard`, and the relevant `command_log`
rows.
