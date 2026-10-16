import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { E2E_PROJECTS } from "./tests/e2e/lanes";
import { runDir } from "./tests/e2e/runEvidence";

// Only the CLI runner has the selection arguments; workers reload this config.
// Listing is discovery, not execution (tests/e2e-lanes.test.ts uses it locally).
if (process.argv[2] === "test" && !process.env.CI) {
  const flags = new Set([
    "--fail-on-flaky-tests",
    "--forbid-only",
    "--fully-parallel",
    "--headed",
    "--ignore-snapshots",
    "--last-failed",
    "--list",
    "--no-deps",
    "--pass-with-no-tests",
    "--quiet",
    "--ui",
    "-x",
  ]);
  const filters: string[] = [];
  let optionValue = false;
  let variadic = false;
  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith("-")) {
      // Value-taking options (including variadic --project) are not file filters.
      optionValue = !arg.includes("=") && !flags.has(arg);
      variadic = arg === "--project";
    } else if (!optionValue) {
      filters.push(arg);
    } else if (!variadic) {
      optionValue = false;
    }
  }
  if (
    !process.argv.includes("--list") &&
    !(
      filters.length > 0 &&
      filters.every((arg) => {
        const file = arg.replace(/:\d+(?::\d+)?$/, "");
        return (
          /\.spec\.tsx?$/.test(file) && (existsSync(file) || existsSync(join("tests/e2e", file)))
        );
      })
    )
  ) {
    throw new Error(
      "Full end-to-end runs are CI-only. Start verify.yml for your branch: " +
        "gh workflow run verify.yml --ref <branch>. Locally, name the affected " +
        "test file: pnpm exec playwright test tests/e2e/<file>.spec.ts " +
        "(add --no-deps for renderer/application specs).",
    );
  }
}

// Each run keeps its own evidence, so a second run never clears the first's
// (tests/e2e/runEvidence.ts, docs/testing.md "Per-run e2e evidence").
const run = runDir();
// `--last-failed` reads the working copy's last run, which no longer shares
// the new run's output directory.
process.env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE ??= join(
  fileURLToPath(new URL(".", import.meta.url)),
  "test-results",
  ".last-run.json",
);

export default defineConfig({
  testDir: "tests/e2e",
  tsconfig: "./tsconfig.node.json",
  timeout: 60_000,
  // One private TMPDIR per run, required empty at the end (runTempRoot.ts).
  globalSetup: "./tests/e2e/globalSetup.ts",
  outputDir: run,
  // Bound parallel app processes to the host allowance; native work stays serial.
  workers: Math.min(10, availableParallelism()),
  projects: E2E_PROJECTS,
  reporter: [
    // The console reporter Playwright picks on its own: dots on CI, a line per test here.
    [process.env.CI ? "dot" : "list"],
    // The machine-readable result, beside the run's result directories;
    // verify.yml names the fixed path it keeps and summarizes (docs/testing.md).
    ["json", { outputFile: join(run, "e2e-results.json") }],
  ],
  use: {
    trace: "retain-on-failure",
    // Taken as each app closes; Playwright keeps it only when that test failed.
    screenshot: "only-on-failure",
  },
});
