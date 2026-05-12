-- 0002_create_tables.sql
--
-- All tables per trading_system_docs.md section 5.2. Idempotent via IF NOT
-- EXISTS so re-runs are safe.

CREATE TABLE IF NOT EXISTS bar (
  instrument      text          NOT NULL,
  timeframe       text          NOT NULL,
  timestamp_utc   timestamptz   NOT NULL,
  open            numeric(18,6) NOT NULL,
  high            numeric(18,6) NOT NULL,
  low             numeric(18,6) NOT NULL,
  close           numeric(18,6) NOT NULL,
  volume          numeric(18,2) NOT NULL DEFAULT 0,
  source          text          NOT NULL DEFAULT 'historical',

  CONSTRAINT bar_pk PRIMARY KEY (instrument, timeframe, timestamp_utc),
  CONSTRAINT bar_timeframe_chk CHECK (timeframe IN ('m1','m5','h1','d1')),
  CONSTRAINT bar_source_chk    CHECK (source IN ('historical','live')),
  CONSTRAINT bar_ohlc_chk      CHECK (high >= GREATEST(open, close, low)
                                  AND low  <= LEAST(open, close, high)),
  CONSTRAINT bar_volume_chk    CHECK (volume >= 0)
);

CREATE TABLE IF NOT EXISTS session (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               timestamptz  NOT NULL DEFAULT now(),
  ended_at                 timestamptz,
  mode                     text         NOT NULL,
  session_type             text         NOT NULL,
  parent_session_id        uuid         REFERENCES session(id),
  code_version             text         NOT NULL,
  data_integrity_hash      text,
  instruments              text[]       NOT NULL,
  timeframes               text[]       NOT NULL,
  date_range_from          timestamptz  NOT NULL,
  date_range_to            timestamptz  NOT NULL,
  strategies               jsonb        NOT NULL,
  orchestrator_mode        text         NOT NULL,
  friction_config          jsonb,
  random_seed              bigint       NOT NULL,
  initial_equity_usd       numeric(18,2) NOT NULL,
  current_equity_usd       numeric(18,2) NOT NULL,
  risk_config              jsonb        NOT NULL,
  aggregate_metrics        jsonb,
  trade_count              integer      NOT NULL DEFAULT 0,
  status                   text         NOT NULL DEFAULT 'pending',
  halt_reason              text,
  error_details            text,
  account_type             text,
  broker_account_id        text,

  CONSTRAINT session_mode_chk    CHECK (mode IN ('backtest','live')),
  CONSTRAINT session_status_chk  CHECK (status IN (
    'pending','running','completed','failed','halted','emergency_stopped'
  )),
  CONSTRAINT session_orchestrator_chk CHECK (orchestrator_mode IN (
    'equal_weight','risk_parity','regime_switched'
  )),
  CONSTRAINT session_session_type_chk CHECK (session_type IN (
    'single_backtest','walk_forward_window','parameter_sweep_instance',
    'orchestrator_backtest','live_demo','live_real'
  ))
);

-- signal_log references trade(id); trade references session(id). To allow
-- the forward reference without a circular dependency, defer the FK on
-- signal_log.became_trade_id to a later step (added after trade exists).
CREATE TABLE IF NOT EXISTS trade (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid          NOT NULL REFERENCES session(id),
  originating_signal_id    uuid          NOT NULL,
  originating_strategy     text          NOT NULL,
  instrument               text          NOT NULL,
  direction                text          NOT NULL,
  entry_price              numeric(18,6) NOT NULL,
  exit_price               numeric(18,6) NOT NULL,
  entry_time               timestamptz   NOT NULL,
  exit_time                timestamptz   NOT NULL,
  exit_reason              text          NOT NULL,
  lot_size                 numeric(10,4) NOT NULL,
  notional_usd             numeric(18,2) NOT NULL,
  initial_risk_pct         numeric(10,4) NOT NULL,
  realized_pnl_pct         numeric(10,4) NOT NULL,
  realized_r_multiple      numeric(10,4) NOT NULL,
  initial_risk_usd         numeric(18,2) NOT NULL,
  realized_pnl_usd         numeric(18,2) NOT NULL,
  initial_stop_price       numeric(18,6) NOT NULL,
  initial_target_price     numeric(18,6) NOT NULL,
  total_friction_usd       jsonb         NOT NULL,
  hold_duration_minutes    integer       NOT NULL,
  metadata                 jsonb         NOT NULL,

  CONSTRAINT trade_direction_chk    CHECK (direction IN ('long','short')),
  CONSTRAINT trade_exit_reason_chk  CHECK (exit_reason IN (
    'target','stop','be_stop','time_stop','session_close',
    'signal_flip','orchestrator_close','manual_close',
    'emergency_stop','data_end'
  ))
);

CREATE TABLE IF NOT EXISTS signal_log (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid          NOT NULL REFERENCES session(id),
  originating_strategy     text          NOT NULL,
  instrument               text          NOT NULL,
  direction                text          NOT NULL,
  proposed_entry_price     numeric(18,6),
  proposed_stop_price      numeric(18,6),
  proposed_target_price    numeric(18,6),
  proposed_size_fraction   numeric(5,4),
  urgency_score            numeric(5,4),
  signal_type              text          NOT NULL,
  entry_reason             text,
  generated_at_bar         timestamptz   NOT NULL,
  became_trade_id          uuid          REFERENCES trade(id),
  rejected_reason          text,
  metadata                 jsonb,

  CONSTRAINT signal_log_direction_chk CHECK (direction IN ('long','short'))
);

CREATE TABLE IF NOT EXISTS order_log (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid          NOT NULL REFERENCES session(id),
  created_at               timestamptz   NOT NULL DEFAULT now(),
  originating_signal_id    uuid          REFERENCES signal_log(id),
  order_type               text          NOT NULL,
  instrument               text          NOT NULL,
  direction                text,
  lot_size                 numeric(10,4),
  price                    numeric(18,6),
  broker_order_id          text,
  status                   text          NOT NULL,
  fill_price               numeric(18,6),
  fill_time                timestamptz,
  rejection_reason         text,
  metadata                 jsonb
);

CREATE TABLE IF NOT EXISTS account_snapshot (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid          NOT NULL REFERENCES session(id),
  captured_at              timestamptz   NOT NULL,
  equity_usd               numeric(18,2) NOT NULL,
  balance_usd              numeric(18,2) NOT NULL,
  margin_used_usd          numeric(18,2) NOT NULL,
  margin_free_usd          numeric(18,2) NOT NULL,
  open_positions_count     integer       NOT NULL,
  total_open_risk_pct      numeric(6,3)  NOT NULL,
  unrealized_pnl_usd       numeric(18,2) NOT NULL,
  unrealized_pnl_pct       numeric(6,3)  NOT NULL
);

CREATE TABLE IF NOT EXISTS data_validation_issue (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at              timestamptz   NOT NULL DEFAULT now(),
  instrument               text          NOT NULL,
  timeframe                text          NOT NULL,
  issue_type               text          NOT NULL,
  severity                 text          NOT NULL,
  description              text          NOT NULL,
  affected_time_range_start timestamptz,
  affected_time_range_end   timestamptz,

  CONSTRAINT dvi_severity_chk CHECK (severity IN ('info','warn','error'))
);

CREATE TABLE IF NOT EXISTS audit_event (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               timestamptz   NOT NULL DEFAULT now(),
  session_id               uuid          REFERENCES session(id),
  severity                 text          NOT NULL,
  category                 text          NOT NULL,
  description              text          NOT NULL,
  metadata                 jsonb,
  acknowledged_at          timestamptz
);

CREATE TABLE IF NOT EXISTS config_setting (
  key                      text          PRIMARY KEY,
  value                    jsonb         NOT NULL,
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  updated_by               text          NOT NULL,
  previous_value           jsonb
);
