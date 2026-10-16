import { defineConfig } from "@playwright/test";

/**
 * The installed-package check (docs/linux-packages.md, "The checks"): one
 * journey against a Linux package installed on a clean copy of its system,
 * named by INFINITARY_INSTALLED_APP. linux-packages.yml runs it; the journey
 * suite (playwright.config.ts) never does.
 */
export default defineConfig({
  testDir: "tests/installed",
  tsconfig: "./tsconfig.node.json",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/installed-results.json" }]],
  outputDir: "test-results/installed",
  use: { trace: "retain-on-failure" },
});
