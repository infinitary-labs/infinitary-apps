import type { TestProject } from "vitest/node";
import { closeChromiumTemp, openChromiumTemp } from "./browserChromiumTemp";
import { leaveRunnerSession } from "./runnerSession";
import { closeRunTempRoot, leakReport, openRunTempRoot } from "./runTempRoot";

const OWNED = "INFINITARY_UNIT_TEMP_ROOT_OWNED";

/**
 * The browser layer's Chromium profile and artifacts (vitest.config.ts,
 * project "browser") belong to the runner, not a test. Their file-entry
 * exemption remains while this setup closes the provider before scanning
 * for programs, rather than waiting for Vitest's later browser shutdown.
 */
const BROWSER_ENTRIES = [/^playwright_chromiumdev_profile-/, /^playwright-artifacts-/];

/**
 * Every unit and integration test runs with TMPDIR pointed at one private
 * root (tests/helpers/runTempRoot.ts); the run fails if anything is still
 * in it at the end. None of them sees the session that started the run
 * (tests/helpers/runnerSession.ts).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  leaveRunnerSession();
  // Every project inherits this global setup; the first one to run owns the
  // root and the rest share it.
  if (process.env[OWNED]) return async () => undefined;
  process.env[OWNED] = "1";
  const run = await openRunTempRoot("unit");
  openChromiumTemp(run.root);
  return async () => {
    delete process.env[OWNED];
    try {
      // Tests have finished, but Vitest normally closes its browser after
      // global teardown. Its Chromium also holds files outside its profile.
      // Ask the actual owner to close it before looking for leftovers: never
      // exempt arbitrary Chromium processes or all of the runner's children.
      await Promise.all(project.vitest.projects.map((p) => p.browser?.provider.close()));
      // What a Chromium process left in its own folder goes with its browser;
      // a program still holding a file there is still found below.
      closeChromiumTemp(run.root);
      const leaked = await closeRunTempRoot(run, 0, BROWSER_ENTRIES);
      const report = leakReport("unit", leaked);
      if (report) throw new Error(report);
    } catch (error) {
      // Vitest prints a teardown error but keeps the run's exit code.
      process.exitCode = 1;
      throw error;
    }
  };
}
