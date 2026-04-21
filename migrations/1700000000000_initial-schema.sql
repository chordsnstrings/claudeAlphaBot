-- ──────────────────────────────────────────────────────────────
-- Hydra initial schema
-- References: spec §8.5 (trades), §8.12.6 (regime_check_log,
--   revalidation_events, validation_snapshots), §8.11.2 (artifacts).
-- Idempotent: every object uses IF NOT EXISTS or ON CONFLICT logic.
-- All timestamps are stored as BIGINT epoch milliseconds (UTC) to
-- match the JS time model — no TIMESTAMP WITH TIME ZONE footguns.
-- ──────────────────────────────────────────────────────────────

-- Migration bookkeeping
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_utc BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::BIGINT
);

-- ── Market data ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS candles (
  symbol      TEXT    NOT NULL,
  open_time   BIGINT  NOT NULL,
  close_time  BIGINT  NOT NULL,
  open        NUMERIC(20, 8) NOT NULL,
  high        NUMERIC(20, 8) NOT NULL,
  low         NUMERIC(20, 8) NOT NULL,
  close       NUMERIC(20, 8) NOT NULL,
  volume      NUMERIC(24, 8) NOT NULL,
  PRIMARY KEY (symbol, open_time),
  CONSTRAINT candles_symbol_chk CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
  CONSTRAINT candles_ohlc_chk   CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close)
);
CREATE INDEX IF NOT EXISTS candles_symbol_time_idx ON candles (symbol, open_time DESC);

CREATE TABLE IF NOT EXISTS funding_rates (
  symbol       TEXT   NOT NULL,
  funding_time BIGINT NOT NULL,
  funding_rate NUMERIC(12, 8) NOT NULL,
  PRIMARY KEY (symbol, funding_time),
  CONSTRAINT funding_symbol_chk CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT'))
);
CREATE INDEX IF NOT EXISTS funding_symbol_time_idx ON funding_rates (symbol, funding_time DESC);

-- ── Artifacts + snapshots (spec §8.11.2, §8.12.1) ───────────

CREATE TABLE IF NOT EXISTS validated_artifacts (
  artifact_hash       TEXT PRIMARY KEY,
  artifact_version    TEXT NOT NULL,
  created_at_utc      BIGINT NOT NULL,
  code_hash           TEXT NOT NULL,
  data_window_start   TEXT NOT NULL,
  data_window_end     TEXT NOT NULL,
  months_covered      INTEGER NOT NULL,
  symbols             JSONB NOT NULL,
  winning_parameters  JSONB NOT NULL,
  validation_results  JSONB NOT NULL,
  composite_score     NUMERIC(10, 6) NOT NULL,
  deployment_allowed  BOOLEAN NOT NULL,
  deployment_blockers JSONB,
  approved_at_utc     BIGINT,
  is_active           BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS artifacts_created_idx ON validated_artifacts (created_at_utc DESC);
CREATE INDEX IF NOT EXISTS artifacts_active_idx ON validated_artifacts (is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS validation_snapshots (
  artifact_hash           TEXT PRIMARY KEY REFERENCES validated_artifacts(artifact_hash) ON DELETE CASCADE,
  created_at_utc          BIGINT NOT NULL,
  per_symbol              JSONB NOT NULL,
  btc_realized_vol_30d    NUMERIC(10, 6) NOT NULL,
  notes                   TEXT
);

-- ── Trades + positions (spec §8.5) ──────────────────────────

CREATE TABLE IF NOT EXISTS trades (
  trade_id              BIGSERIAL PRIMARY KEY,
  mode                  TEXT NOT NULL,
  strategy              TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  direction             TEXT NOT NULL,
  entry_time            BIGINT NOT NULL,
  entry_price           NUMERIC(20, 8) NOT NULL,
  quantity              NUMERIC(20, 8) NOT NULL,
  notional_usd          NUMERIC(20, 8) NOT NULL,
  stop_price            NUMERIC(20, 8) NOT NULL,
  tp1_price             NUMERIC(20, 8) NOT NULL,
  tp2_price             NUMERIC(20, 8) NOT NULL,
  exit_time             BIGINT NOT NULL,
  exit_price            NUMERIC(20, 8) NOT NULL,
  exit_reason           TEXT NOT NULL,
  pnl_usd               NUMERIC(20, 8) NOT NULL,
  pnl_r                 NUMERIC(12, 6) NOT NULL,
  fees_paid             NUMERIC(20, 8) NOT NULL,
  account_equity_before NUMERIC(20, 8) NOT NULL,
  account_equity_after  NUMERIC(20, 8) NOT NULL,
  CONSTRAINT trades_mode_chk       CHECK (mode IN ('backtest','paper','live')),
  CONSTRAINT trades_strategy_chk   CHECK (strategy IN ('ARB','NY_OPEN','WEEKEND_MR','FUNDING_FADE','BB_MR')),
  CONSTRAINT trades_symbol_chk     CHECK (symbol IN ('BTCUSDT','ETHUSDT','SOLUSDT')),
  CONSTRAINT trades_direction_chk  CHECK (direction IN ('LONG','SHORT')),
  CONSTRAINT trades_exit_chk       CHECK (exit_reason IN ('STOP','TP1','TP2','TIME_STOP','BREAKEVEN','CIRCUIT_BREAKER','MANUAL'))
);
CREATE INDEX IF NOT EXISTS trades_mode_time_idx   ON trades (mode, entry_time DESC);
CREATE INDEX IF NOT EXISTS trades_symbol_time_idx ON trades (symbol, entry_time DESC);
CREATE INDEX IF NOT EXISTS trades_strategy_idx    ON trades (strategy, entry_time DESC);

CREATE TABLE IF NOT EXISTS open_positions (
  id                       TEXT PRIMARY KEY,
  mode                     TEXT NOT NULL,
  strategy                 TEXT NOT NULL,
  symbol                   TEXT NOT NULL,
  direction                TEXT NOT NULL,
  entry_time               BIGINT NOT NULL,
  entry_price              NUMERIC(20, 8) NOT NULL,
  quantity                 NUMERIC(20, 8) NOT NULL,
  remaining_quantity       NUMERIC(20, 8) NOT NULL,
  notional_usd             NUMERIC(20, 8) NOT NULL,
  stop_price               NUMERIC(20, 8) NOT NULL,
  tp1_price                NUMERIC(20, 8) NOT NULL,
  tp2_price                NUMERIC(20, 8) NOT NULL,
  breakeven_trigger_price  NUMERIC(20, 8) NOT NULL,
  time_stop_utc            BIGINT NOT NULL,
  tp1_filled               BOOLEAN NOT NULL DEFAULT FALSE,
  breakeven_moved          BOOLEAN NOT NULL DEFAULT FALSE,
  fees_paid_usd            NUMERIC(20, 8) NOT NULL DEFAULT 0,
  realized_pnl_usd         NUMERIC(20, 8) NOT NULL DEFAULT 0,
  exchange_order_ids       JSONB,
  CONSTRAINT positions_mode_chk      CHECK (mode IN ('backtest','paper','live')),
  CONSTRAINT positions_symbol_chk    CHECK (symbol IN ('BTCUSDT','ETHUSDT','SOLUSDT')),
  CONSTRAINT positions_direction_chk CHECK (direction IN ('LONG','SHORT')),
  CONSTRAINT positions_strategy_chk  CHECK (strategy IN ('ARB','NY_OPEN','WEEKEND_MR','FUNDING_FADE','BB_MR'))
);
CREATE INDEX IF NOT EXISTS positions_mode_symbol_idx ON open_positions (mode, symbol);

CREATE TABLE IF NOT EXISTS account_equity_history (
  id           BIGSERIAL PRIMARY KEY,
  mode         TEXT NOT NULL,
  ts_utc       BIGINT NOT NULL,
  equity_usd   NUMERIC(20, 8) NOT NULL,
  open_notional_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  CONSTRAINT equity_mode_chk CHECK (mode IN ('backtest','paper','live'))
);
CREATE INDEX IF NOT EXISTS equity_mode_ts_idx ON account_equity_history (mode, ts_utc DESC);

-- ── Drift / monitoring (spec §8.12.6) ───────────────────────

CREATE TABLE IF NOT EXISTS regime_check_log (
  id                            BIGSERIAL PRIMARY KEY,
  timestamp_utc                 BIGINT NOT NULL,
  symbol                        TEXT NOT NULL,
  outcome                       TEXT NOT NULL,
  current_regime                TEXT NOT NULL,
  validation_regime             TEXT NOT NULL,
  confidence_current            NUMERIC(6, 4) NOT NULL,
  confidence_at_validation      NUMERIC(6, 4) NOT NULL,
  confidence_delta_pct          NUMERIC(8, 2) NOT NULL,
  bb_width_pct_current          NUMERIC(8, 2) NOT NULL,
  bb_width_pct_at_validation    NUMERIC(8, 2) NOT NULL,
  bb_width_delta_points         NUMERIC(8, 2) NOT NULL,
  ema99_slope_current           NUMERIC(12, 8) NOT NULL,
  ema99_slope_at_validation     NUMERIC(12, 8) NOT NULL,
  consecutive_days_same_outcome INTEGER NOT NULL,
  CONSTRAINT regime_outcome_chk CHECK (outcome IN ('UNCHANGED','DRIFTED','FLIPPED')),
  CONSTRAINT regime_symbol_chk  CHECK (symbol IN ('BTCUSDT','ETHUSDT','SOLUSDT')),
  CONSTRAINT regime_current_chk CHECK (current_regime IN ('RANGING','TRENDING_UP','TRENDING_DOWN','SQUEEZE','TRANSITION')),
  CONSTRAINT regime_val_chk     CHECK (validation_regime IN ('RANGING','TRENDING_UP','TRENDING_DOWN','SQUEEZE','TRANSITION'))
);
CREATE INDEX IF NOT EXISTS regime_symbol_ts_idx ON regime_check_log (symbol, timestamp_utc DESC);
CREATE INDEX IF NOT EXISTS regime_ts_idx        ON regime_check_log (timestamp_utc DESC);

CREATE TABLE IF NOT EXISTS revalidation_events (
  id                            BIGSERIAL PRIMARY KEY,
  trigger_reason                TEXT NOT NULL,
  started_at_utc                BIGINT NOT NULL,
  completed_at_utc              BIGINT,
  duration_seconds              INTEGER,
  previous_artifact_hash        TEXT,
  new_artifact_hash             TEXT,
  mean_parameter_deviation_pct  NUMERIC(10, 4),
  auto_swap_applied             BOOLEAN NOT NULL DEFAULT FALSE,
  operator_approved             BOOLEAN,
  approved_at_utc               BIGINT,
  notes                         TEXT,
  CONSTRAINT reval_trigger_chk CHECK (trigger_reason IN ('FLIPPED','PERFORMANCE_DECAY','VOL_SHIFT','CODE_CHANGE','MANUAL','FORTNIGHTLY'))
);
CREATE INDEX IF NOT EXISTS reval_started_idx ON revalidation_events (started_at_utc DESC);

CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  id                    BIGSERIAL PRIMARY KEY,
  timestamp_utc         BIGINT NOT NULL,
  kind                  TEXT NOT NULL,
  symbol                TEXT,
  triggered_by_pnl_pct  NUMERIC(8, 4),
  account_equity        NUMERIC(20, 8) NOT NULL,
  action                TEXT NOT NULL,
  released_at_utc       BIGINT,
  CONSTRAINT cb_kind_chk   CHECK (kind IN ('DAILY_LOSS_CAP','WEEKLY_LOSS_CAP','SYMBOL_COOLDOWN','MANUAL_HALT')),
  CONSTRAINT cb_symbol_chk CHECK (symbol IS NULL OR symbol IN ('BTCUSDT','ETHUSDT','SOLUSDT'))
);
CREATE INDEX IF NOT EXISTS cb_ts_idx ON circuit_breaker_events (timestamp_utc DESC);

-- ── Scheduler state ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id               BIGSERIAL PRIMARY KEY,
  job_name         TEXT NOT NULL,
  scheduled_for_utc BIGINT NOT NULL,
  started_at_utc   BIGINT,
  completed_at_utc BIGINT,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  error_message    TEXT,
  CONSTRAINT sched_status_chk CHECK (status IN ('PENDING','RUNNING','OK','FAILED','SKIPPED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS sched_job_scheduled_idx ON scheduler_runs (job_name, scheduled_for_utc);
CREATE INDEX IF NOT EXISTS sched_pending_idx ON scheduler_runs (status, scheduled_for_utc) WHERE status = 'PENDING';

-- ── Register this migration ─────────────────────────────────

INSERT INTO schema_migrations (id) VALUES ('1700000000000_initial-schema')
ON CONFLICT (id) DO NOTHING;
