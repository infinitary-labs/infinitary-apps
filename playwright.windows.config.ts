import { defineConfig } from "@playwright/test";

/**
 * The Windows installer check (docs/windows.md, "The checks"): one journey
 * against the app a Windows installer put in place on a fresh Windows 11
 * PC. windows.yml runs it there; the journey suite (playwright.config.ts)
 * never does.
 */
export default defineConfig({
  testDir: "tests/windows",
  tsconfig: "./tsconfig.node.json",
  timeout: 20 * 60_000,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/windows-results.json" }]],
  outputDir: "test-results/windows",
  use: { trace: "retain-on-failure" },
  // Playwright reads git on CI by default, and on a pull request's run it
  // fetches the base commit. The check job's checkout keeps no credentials,
  // so on a private project that fetch asks for a sign-in nobody answers on
  // the machine, and Playwright's timeout ends git but not its children,
  // which hold the run open until the job's timeout.
  captureGitInfo: { commit: false, diff: false },
});
