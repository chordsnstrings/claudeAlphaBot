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
export {
  planSweepCombinations,
  analyseSweep,
  type ParameterGrid,
  type ParameterCombination,
  type SweepResult,
  type SweepSummary,
} from "./parameter-sweep.js";
export {
  computeHealth,
  createHealthHandler,
  type HealthCheckArgs,
  type HealthReport,
} from "./health-endpoint.js";
