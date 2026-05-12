-- 0001_init_extensions.sql
--
-- Activate required extensions. TimescaleDB is required in production; when
-- it is unavailable (e.g. local dev without the extension installed) the
-- migration logs a NOTICE and continues. Tables are still created in 0002
-- and the hypertable conversion in 0004 silently skips.

-- CREATE EXTENSION IF NOT EXISTS races between concurrent transactions on
-- older Postgres builds; the duplicate-name catalog insert can still trip
-- pg_extension_name_index. Both blocks below tolerate that race.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
EXCEPTION WHEN unique_violation THEN
  -- another transaction created it concurrently; ignore.
  NULL;
END$$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION
  WHEN unique_violation THEN
    NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'timescaledb extension not available: %. '
                 'Tables will be created as plain Postgres relations. '
                 'Install TimescaleDB and re-run migrations in production.',
                 SQLERRM;
END$$;
