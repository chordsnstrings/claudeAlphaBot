/** @trading/adapters — boundary-adapter implementations. */

export const PACKAGE_NAME = "@trading/adapters";

export { HistoricalDataFeed, type HistoricalDataFeedConfig } from "./historical-data-feed.js";
export { SimulatedExecutionAdapter } from "./simulated-execution-adapter.js";
export type { SimulatedExecutionAdapterDeps } from "./simulated-execution-adapter.js";
export { SimulatedClock } from "./simulated-clock.js";
export { SystemClock } from "./system-clock.js";
export {
  buildBacktestDeps,
  registerBacktestAdapters,
  type BuildBacktestResult,
  type BuildBacktestOpts,
} from "./build-backtest.js";
export {
  buildLiveDeps,
  registerLiveAdapters,
  type BuildLiveResult,
  type BuildLiveOpts,
} from "./build-live.js";
export { AsyncQueue } from "./async-queue.js";
export * from "./friction/index.js";
export * from "./ctrader/index.js";
export * from "./oauth-callback.js";
