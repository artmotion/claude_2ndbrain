import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["tests/helpers/email-env.ts", "tests/helpers/blob-env.ts", "tests/helpers/shrink-brake-env.ts"],
    // Integration tests share one Postgres; run serially to keep state predictable.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globals: false,
  },
});
