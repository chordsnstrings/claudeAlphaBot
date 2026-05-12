import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../src/index.js";

describe("@trading/engine", () => {
  it("identifies itself", () => {
    expect(PACKAGE_NAME).toBe("@trading/engine");
  });
});
