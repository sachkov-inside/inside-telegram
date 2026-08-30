import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: ["test/unit/**/*.test.ts", "test/architecture/**/*.test.ts"],
  },
});
