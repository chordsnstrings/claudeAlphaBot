import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ValidatedConfig } from "@hydra/shared";

import {
  STALE_DAYS,
  verifyArtifact,
  verifyArtifactAtPath,
} from "../../src/core/artifact.js";

function makeArtifact(over: Partial<ValidatedConfig> = {}): ValidatedConfig {
  return {
    artifactVersion: "1.0",
    createdAt: new Date().toISOString(),
    codeHash: "sha256:abc",
    dataWindow: { start: "2024-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z", monthsCovered: 24 },
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    winningParameters: {},
    validationResults: {
      backtest: { totalReturnPct: 50, sharpe: 1.5, maxDdPct: 15, tradeCount: 200, winRatePct: 60, profitFactor: 1.6 },
      monteCarlo: { runs: 1000, medianReturnPct: 48, p5ReturnPct: 30, p95ReturnPct: 70, p95MaxDdPct: 22, probNegativeReturnPct: 5 },
      walkForward: { windowsTested: 6, avgTestSharpe: 1.3, trainToTestRatio: 0.75, paramStabilityMaxDeviationPct: 10 },
      outOfSample: { period: "2026-01-01 to 2026-03-31", sharpe: 1.3, maxDdPct: 15, returnPct: 15 },
    },
    compositeScore: 0.7,
    deploymentAllowed: true,
    ...over,
  };
}

describe("verifyArtifact", () => {
  it("passes a clean artifact", () => {
    const result = verifyArtifact(makeArtifact(), { currentCodeHash: "sha256:abc" });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects deployment_allowed=false", () => {
    const result = verifyArtifact(makeArtifact({ deploymentAllowed: false }), {
      currentCodeHash: "sha256:abc",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("deploymentAllowed"))).toBe(true);
  });

  it("rejects stale artifacts (>30 days)", () => {
    const old = new Date(Date.now() - (STALE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const result = verifyArtifact(makeArtifact({ createdAt: old }), {
      currentCodeHash: "sha256:abc",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("stale"))).toBe(true);
  });

  it("rejects code_hash mismatch", () => {
    const result = verifyArtifact(makeArtifact({ codeHash: "sha256:different" }), {
      currentCodeHash: "sha256:abc",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("code_hash mismatch"))).toBe(true);
  });

  it("accepts fresh artifact exactly at the boundary", () => {
    const ms = Date.now();
    const almostStale = new Date(ms - (STALE_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
    const result = verifyArtifact(makeArtifact({ createdAt: almostStale }), {
      currentCodeHash: "sha256:abc",
      nowMs: ms,
    });
    expect(result.ok).toBe(true);
  });

  it("reports all errors together (not short-circuit)", () => {
    const result = verifyArtifact(
      makeArtifact({
        deploymentAllowed: false,
        codeHash: "sha256:bad",
      }),
      { currentCodeHash: "sha256:abc" },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("verifyArtifactAtPath — missing file", () => {
  it("reports missing file cleanly", async () => {
    const result = await verifyArtifactAtPath("/nonexistent/path/artifact.json", {
      currentCodeHash: "sha256:abc",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("not found"))).toBe(true);
  });

  it("loads and verifies a real file round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hydra-artifact-"));
    try {
      const path = join(dir, "artifact.json");
      await writeFile(path, JSON.stringify(makeArtifact()));
      const result = await verifyArtifactAtPath(path, { currentCodeHash: "sha256:abc" });
      expect(result.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
