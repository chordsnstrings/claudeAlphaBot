import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "metrics",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
