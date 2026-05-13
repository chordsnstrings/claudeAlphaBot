# Operations runbook

Daily and incident-time procedures for running the trading system.
Pair with `DEPLOYMENT.md` for first-time setup of a production droplet.

## Operational UI

`@trading/web` ships a Fastify server-rendered UI. Default port 3000;
front with Caddy / nginx + Let's Encrypt for TLS (cTrader requires
the OAuth callback URL to be HTTPS).

Routes:

- `GET  /login`              — sign-in form
- `GET  /dashboard`          — account header (equity, unrealized P&L,
                               open positions count, total open risk %),
                               open positions table with [Close] buttons,
                               strategies panel with Pause/Resume/Kill,
                               last 20 audit events, **emergency stop**
                               button always visible in the nav
- `GET  /backtests`          — recent sessions (paginated by limit 50)
- `GET  /backtests/:id`      — trades + aggregate metrics for one session
- `GET  /config`             — risk-config form, 2-step confirmation
- `GET  /orders`             — manual order entry; current positions
- `POST /api/emergency-stop` — halt + close all (≤10s target)
- `POST /api/manual-order`   — risk-checked manual entry
- `POST /api/strategy/{pause,resume,kill}` — RuntimeOps
- `POST /api/config`         — hot-reload risk config
- `GET  /events`             — SSE refresh stream (5s tick)
- `GET  /api/health`         — JSON: status / DB / adapters / uptime

The UI is auth-gated everywhere except `/login` and `/api/health`.

## Daily checks

1. `GET /api/health` should report `status: "ok"`.
2. Dashboard equity matches broker statement to within friction
   accounting (run `pnpm --filter @trading/cli ingest:report` to
   confirm bar coverage if anything looks stale).
3. Audit-log tail at `/dashboard` shouldn't have unacknowledged
   `error`/`fatal` events.

## Pausing a strategy

Dashboard → strategies panel → **Pause**. Audit log records
`strategy.paused` with the operator name and reason.

The engine consults `RuntimeOps.isPaused(name)` before calling the
strategy's `generateSignals(state)` each bar; existing positions
continue to be managed (stop/target detection runs as normal).

To stop **and close** positions, use **Kill** instead.

## Emergency stop

Click the red **Emergency stop** button in the nav. Confirm via the
2-step dialog. The system will:

1. Mark every strategy as `killed`.
2. Race the broker for the full open-positions list (2s timeout).
3. Submit market closes for each position with a 10-second deadline
   per position (parallel).
4. Record a `fatal` halt audit event with the report.

The result page shows: strategies halted, positions closed, duration,
whether the 10-second deadline was met, and any per-position failures
(broker timeout, network drop, etc).

After an emergency stop, all strategies remain in `killed` state —
they cannot be `Resume`d, the system must be restarted to re-enable
them. This is intentional: emergency stop implies an investigation,
not a quick toggle back on.

## Manual order

Orders → fill the form → submit. The order:

1. Synthesises a `Signal` tagged `metadata.manual=true, by=<operator>`.
2. Runs through `RiskManager.canExecute(...)` — per-trade risk %,
   total open risk %, drawdown emergency stop, daily loss limit.
3. On approval: forwarded to the broker via the live execution
   adapter; recorded via `AuditLog.recordManualOrder`.
4. On rejection: recorded via `AuditLog.recordOrderRejected` with the
   reason from the RiskManager.

Risk checks are NOT bypassable — by design, manual entries can't
exceed the configured per-trade or total-open caps. To override the
limits, edit the risk config first (`/config`).

## Editing risk configuration

Configuration → adjust values → save (2-step confirm). The form
posts to `/api/config` which:

1. Parses + validates the new `RiskConfig`.
2. Calls `RuntimeOps.reloadRiskConfig(by, next)`:
   - Persists to `config_setting.risk.config` (upsert with
     `previous_value` audit).
   - Updates the in-memory `RiskManager` so subsequent
     `canExecute(...)` calls use the new thresholds.
3. Records a `config.change` audit event with the previous + new
   values.

Changes take effect **immediately** — no engine restart required.
The next per-bar risk check uses the new thresholds.

## Backtest browsing

Backtests → click a row → drills into a single session:

- Status + final equity + trade count
- Full aggregate metrics JSON (Wilson CI win rate, expectancy ± SE,
  profit factor, R percentiles, bootstrap Sharpe CI, Sortino, max
  drawdown, Calmar, Monte Carlo distribution).
- Trade-by-trade list with R, P&L USD, exit reason.

## Health / monitoring

`GET /api/health` returns:

```json
{
  "status": "ok" | "degraded" | "down",
  "codeVersion": "...",
  "uptimeSeconds": 12345,
  "components": {
    "database": { "ok": true, "error": null },
    "dataFeed": { "ok": true },
    "execution": { "ok": true }
  }
}
```

`degraded` returns 200; `down` returns 503 (use this for the
loadbalancer health check). Wire your monitoring (UptimeRobot,
Pingdom, or DigitalOcean monitoring) to the 503 transition.

## Troubleshooting

**cTrader credentials not configured — connection skipped.**
Phase 18 hasn't been completed for this environment. Hit
`/oauth/callback` (after running through the cTrader connect flow at
`buildAuthorizationUrl(...)`), tokens get persisted, then restart the
process.

**Broker disconnect.** Live adapter logs `cTrader connect failed;
backing off` with the attempt count. Backoff sequence is 1, 2, 4, 8,
16, 32, 60 seconds. No operator action required unless the failure
persists past 60s — at which point check
`https://status.spotware.com` and the OAuth refresh-token validity.

**Reconciliation mismatch.** Spec §9.16 audit category
`reconciliation`. Indicates the broker's open-positions list differs
from the engine's. Manual intervention required: pause all
strategies, compare `/dashboard` open positions to the cTrader app,
close the discrepant positions manually, then resume.
