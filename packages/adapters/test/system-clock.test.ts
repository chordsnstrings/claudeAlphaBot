import { describe, expect, it } from "vitest";

import { SystemClock } from "../src/system-clock.js";

describe("SystemClock", () => {
  it("now() returns a Date close to wall time", () => {
    const c = new SystemClock();
    const before = Date.now();
    const now = c.now();
    const after = Date.now();
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });

  it("sleep(50) resolves after at least 45 ms", async () => {
    const c = new SystemClock();
    const t0 = Date.now();
    await c.sleep(50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it("does NOT expose advanceTo (live mode invariant)", () => {
    const c = new SystemClock();
    // advanceTo is optional on the Clock interface; SystemClock omits it.
    expect((c as unknown as { advanceTo?: unknown }).advanceTo).toBeUndefined();
  });
});
