/**
 * Wilson CI tests against the documented statistical result from spec §9.9:
 *   n=50, wins=28 -> 95% CI (42.4%, 68.6%).
 */

import { describe, expect, it } from "vitest";

import { wilsonCi } from "../src/wilson-ci.js";

describe("wilsonCi", () => {
  it("matches the spec §9.9 reference: n=50, wins=28 → (42.4%, 68.6%)", () => {
    const ci = wilsonCi(28, 50);
    expect(ci.point).toBeCloseTo(0.56, 8);
    expect(ci.lower).toBeCloseTo(0.4231, 3);
    expect(ci.upper).toBeCloseTo(0.6885, 3);
  });

  it("returns zeros for n=0", () => {
    expect(wilsonCi(0, 0)).toEqual({ point: 0, lower: 0, upper: 0 });
  });

  it("clamps the interval to [0, 1]", () => {
    const ci = wilsonCi(0, 5);
    expect(ci.lower).toBeGreaterThanOrEqual(0);
    const ci2 = wilsonCi(5, 5);
    expect(ci2.upper).toBeLessThanOrEqual(1);
  });
});
