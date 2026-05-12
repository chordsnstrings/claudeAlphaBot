import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "orchestrator",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
