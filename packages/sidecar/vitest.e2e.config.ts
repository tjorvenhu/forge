import { defineConfig } from "vitest/config";

// The build runs as global setup instead of "pnpm build && vitest": "&&" breaks when pnpm runs
// scripts through Windows PowerShell 5.1.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    globalSetup: ["test/e2e/build-sidecar.ts"],
  },
});
