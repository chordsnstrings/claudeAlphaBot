import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "strategies",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
