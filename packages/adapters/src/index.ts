/** @trading/adapters — boundary-adapter implementations. */

export const PACKAGE_NAME = "@trading/adapters";

export { HistoricalDataFeed, type HistoricalDataFeedConfig } from "./historical-data-feed.js";
export { SimulatedExecutionAdapter } from "./simulated-execution-adapter.js";
export type { SimulatedExecutionAdapterDeps } from "./simulated-execution-adapter.js";
export { SimulatedClock } from "./simulated-clock.js";
export {
  buildBacktestDeps,
  registerBacktestAdapters,
  type BuildBacktestResult,
} from "./build-backtest.js";
export { AsyncQueue } from "./async-queue.js";
export * from "./friction/index.js";
