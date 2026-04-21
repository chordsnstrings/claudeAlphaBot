import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli/**", "src/main.ts"],
      thresholds: {
        lines: 0,
        statements: 0,
        branches: 0,
        functions: 0,
      },
    },
  },
  resolve: {
    alias: {
      "@hydra/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
