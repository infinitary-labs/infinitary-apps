import { defineConfig } from "@playwright/test";
// Each worker reloads this config and starts the load clock, as the journeys' config does.
import "../../helpers/budgets";

// Playwright runs of their own for tests/load-clock.test.ts (INF-1083): the
// real runner and its patched deadlines over a file a child process writes,
// with no app, browser or account. The test freezes each run's process group.
export default defineConfig({
  testDir: ".",
  testMatch: "*.fixture.ts",
  workers: 1,
  retries: 0,
  outputDir: process.env.INFINITARY_LOAD_CLOCK_OUTPUT,
  reporter: "json",
});
