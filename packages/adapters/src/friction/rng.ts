/**
 * Re-export the seeded RNG from @trading/core. The implementation moved
 * to core in Phase 9 so the metrics package (bootstrap / Monte Carlo)
 * can share the same deterministic generator.
 */

export { mulberry32, seedFromBigint, type SeededRng } from "@trading/core";
