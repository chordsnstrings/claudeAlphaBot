import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "reporting",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
