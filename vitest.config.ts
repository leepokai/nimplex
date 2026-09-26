import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    // Crash and CLI tests fork real processes that import Pi; under a full parallel run
    // on a laptop a child can take well over 5 s to boot, so waits are generous.
    testTimeout: 60_000,
  },
});
