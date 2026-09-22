import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Chromium starts per suite; the default 5s is not enough.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts"],
  },
});
