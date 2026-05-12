import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../src/index.js";

describe("@trading/data", () => {
  it("identifies itself", () => {
    expect(PACKAGE_NAME).toBe("@trading/data");
  });
});
