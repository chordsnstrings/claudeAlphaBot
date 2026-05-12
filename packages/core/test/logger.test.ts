import { afterEach, describe, expect, it } from "vitest";

import { getLogger, logger, resetLoggerForTest } from "../src/logger.js";

afterEach(() => {
  delete process.env["LOG_LEVEL"];
  resetLoggerForTest();
});

describe("logger", () => {
  it("emits structured JSON to stdout", () => {
    const log = getLogger();
    expect(typeof log.info).toBe("function");
    // Pino loggers expose .levels with values for each named level.
    expect(log.levels.values["info"]).toBe(30);
  });

  it("honors LOG_LEVEL when constructed", () => {
    process.env["LOG_LEVEL"] = "warn";
    resetLoggerForTest();
    const log = getLogger();
    expect(log.level).toBe("warn");
  });

  it("creates child loggers bound to a component", () => {
    const child = logger("ingest");
    expect(child).toBeDefined();
    expect(typeof child.info).toBe("function");
  });
});
