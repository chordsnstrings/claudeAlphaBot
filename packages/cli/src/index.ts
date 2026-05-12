/**
 * @trading/cli
 *
 * Exposes the CLI entrypoints as programmatic functions for testing.
 * The shipped binary is `bin.js`.
 */

export const PACKAGE_NAME = "@trading/cli";

export { runBacktest, type BacktestCliOpts } from "./backtest.js";
export { runIngestAsset, type IngestAssetOpts } from "./ingest-asset.js";
export { runIngestFull } from "./ingest-full.js";
export { runIngestIncremental, type IncrementalOpts } from "./ingest-incremental.js";
export { runIngestReport } from "./ingest-report.js";
