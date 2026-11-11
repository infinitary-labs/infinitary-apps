import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// The real journey global setup and teardown, without an app or browser:
// tests/run-temp-root.test.ts proves that a leaked daemon fails Playwright too.
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "leaks.pw.ts",
  tsconfig: resolve(import.meta.dirname, "../../../tsconfig.node.json"),
  globalSetup: "../../e2e/globalSetup.ts",
  outputDir: process.env.INFINITARY_FIXTURE_OUTPUT,
  workers: 1,
  retries: 0,
  reporter: "line",
});
