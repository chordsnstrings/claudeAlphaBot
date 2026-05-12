import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "adapters",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
