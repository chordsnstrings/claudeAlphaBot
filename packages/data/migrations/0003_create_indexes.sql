-- 0003_create_indexes.sql
--
-- Secondary indexes per spec section 5.2. PKs already provide the primary
-- index; these add the additional access paths called out in each table.

CREATE INDEX IF NOT EXISTS bar_instrument_timeframe_idx
  ON bar (instrument, timeframe);
CREATE INDEX IF NOT EXISTS bar_timestamp_utc_idx
  ON bar (timestamp_utc);

CREATE INDEX IF NOT EXISTS session_created_at_idx
  ON session (created_at DESC);
CREATE INDEX IF NOT EXISTS session_mode_status_idx
  ON session (mode, status);
CREATE INDEX IF NOT EXISTS session_session_type_idx
  ON session (session_type);

CREATE INDEX IF NOT EXISTS signal_log_session_id_idx
  ON signal_log (session_id);
CREATE INDEX IF NOT EXISTS signal_log_generated_at_bar_idx
  ON signal_log (generated_at_bar);

CREATE INDEX IF NOT EXISTS trade_session_id_idx
  ON trade (session_id);
CREATE INDEX IF NOT EXISTS trade_entry_time_idx
  ON trade (entry_time);

CREATE INDEX IF NOT EXISTS account_snapshot_session_captured_idx
  ON account_snapshot (session_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS data_validation_issue_instr_tf_idx
  ON data_validation_issue (instrument, timeframe);

CREATE INDEX IF NOT EXISTS audit_event_session_created_idx
  ON audit_event (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_category_idx
  ON audit_event (category);
CREATE INDEX IF NOT EXISTS audit_event_severity_idx
  ON audit_event (severity);
