-- ──────────────────────────────────────────────────────────────
-- Phase 14: command_log table
-- Records every operator / UI-triggered command through the
-- internal HTTP API so we have an audit trail of mode flips,
-- revalidation triggers, and emergency closes.
-- Idempotent: IF NOT EXISTS guards all objects.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS command_log (
  id                BIGSERIAL PRIMARY KEY,
  timestamp_utc     BIGINT NOT NULL,
  command           TEXT NOT NULL,
  requester         TEXT,
  payload           JSONB,
  result            TEXT NOT NULL,
  error_message     TEXT,
  CONSTRAINT command_result_chk CHECK (result IN ('OK','ERROR','RATE_LIMITED','REJECTED'))
);
CREATE INDEX IF NOT EXISTS command_log_ts_idx ON command_log (timestamp_utc DESC);
CREATE INDEX IF NOT EXISTS command_log_cmd_idx ON command_log (command, timestamp_utc DESC);

INSERT INTO schema_migrations (id) VALUES ('1700000001000_command-log')
ON CONFLICT (id) DO NOTHING;
