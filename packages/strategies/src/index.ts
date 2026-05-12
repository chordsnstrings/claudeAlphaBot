/** @trading/strategies — spec §10. */

export const PACKAGE_NAME = "@trading/strategies";

export {
  AsianRangeSweepStrategy,
  DEFAULT_PARAMS as ASIAN_RANGE_SWEEP_DEFAULTS,
  type AsianRangeSweepParams,
} from "./asian-range-sweep.js";

export {
  DonchianBreakoutStrategy,
  DONCHIAN_DEFAULTS,
  type DonchianBreakoutParams,
} from "./donchian-breakout.js";

export {
  TrendFollowingStrategy,
  TREND_FOLLOWING_DEFAULTS,
  type TrendFollowingParams,
} from "./trend-following.js";

export {
  BollingerReversalStrategy,
  BOLLINGER_REVERSAL_DEFAULTS,
  type BollingerReversalParams,
} from "./bollinger-reversal.js";
