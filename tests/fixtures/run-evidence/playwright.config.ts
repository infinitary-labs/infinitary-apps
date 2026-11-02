import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { LOCAL_JOURNEY_WORKERS } from "../../../scripts/heavy-run-place";
import { runDir } from "../../e2e/runEvidence";

// Playwright runs of their own for tests/run-evidence-playwright.test.ts: the
// e2e suite's global setup and per-run evidence, over specs that launch no app
// and open no microphone (the test turns the setup's microphone check off).
const run = runDir();

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "../../e2e/globalSetup.ts",
  outputDir: run,
  workers: LOCAL_JOURNEY_WORKERS,
  reporter: [["list"], ["json", { outputFile: join(run, "e2e-results.json") }]],
});
