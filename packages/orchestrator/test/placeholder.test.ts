import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../src/index.js";

describe("@trading/orchestrator", () => {
  it("identifies itself", () => {
    expect(PACKAGE_NAME).toBe("@trading/orchestrator");
  });
});
