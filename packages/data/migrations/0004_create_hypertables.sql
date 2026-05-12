-- 0004_create_hypertables.sql
--
-- Convert bar, signal_log, trade into TimescaleDB hypertables per spec
-- section 5.2. Bar uses 1-month chunks (~10 GB at full M1 universe).
-- Hypertable conversion is idempotent (if_not_exists => true) and is
-- a NO-OP when TimescaleDB is not installed (e.g. local dev sandbox).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
  ) THEN
    RAISE NOTICE 'TimescaleDB extension not installed; skipping '
                 'hypertable conversion. Bar, signal_log, trade '
                 'remain as plain Postgres tables.';
    RETURN;
  END IF;

  PERFORM create_hypertable(
    'bar', 'timestamp_utc',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists       => TRUE,
    migrate_data        => TRUE
  );

  PERFORM create_hypertable(
    'signal_log', 'generated_at_bar',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists       => TRUE,
    migrate_data        => TRUE
  );

  PERFORM create_hypertable(
    'trade', 'entry_time',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists       => TRUE,
    migrate_data        => TRUE
  );
END$$;
