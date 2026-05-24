-- Widen numeric columns that overflow at crypto-perp scale.
--
-- The original precisions assumed FX/metals: lot sizes in the 0.01–100 range
-- and P&L percentages well under 1000%. Crypto perps break both assumptions:
--   * lot_size is in COINS, so a sub-dollar coin (DOGE/XRP) sized to a normal
--     dollar risk implies millions of units — past numeric(10,4)'s 1e6 ceiling.
--   * with leverage, a single position's unrealized P&L can exceed 1000% of
--     equity on a large favourable move, past numeric(6,3)'s 999.999 ceiling.
--
-- Widening is backward-compatible (every old value still fits).

ALTER TABLE trade
  ALTER COLUMN lot_size            TYPE numeric(24,8),
  ALTER COLUMN realized_pnl_pct    TYPE numeric(16,4),
  ALTER COLUMN realized_r_multiple TYPE numeric(16,4);

ALTER TABLE order_log
  ALTER COLUMN lot_size TYPE numeric(24,8);

ALTER TABLE account_snapshot
  ALTER COLUMN total_open_risk_pct TYPE numeric(16,4),
  ALTER COLUMN unrealized_pnl_pct  TYPE numeric(16,4);
