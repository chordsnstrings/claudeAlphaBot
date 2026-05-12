/** @trading/engine — TradingSystem event loop + composition root. */

export const PACKAGE_NAME = "@trading/engine";

export { TradingSystem, emptyPositionEvents } from "./trading-system.js";
export { buildSystem, registerAdapters } from "./build-system.js";
export type { TradingSystemDeps, PerBarStats } from "./types.js";
export { isCompleteBar, barKey } from "./types.js";
export {
  planWalkForwardWindows,
  summariseWalkForward,
  type WalkForwardConfig,
  type WalkForwardWindow,
  type WindowResult,
  type WalkForwardSummary,
} from "./walk-forward.js";
