import { dirname, join, relative } from "node:path";
import type { FullConfig } from "@playwright/test";
import { takeHeavyRunPlace } from "../../scripts/heavy-run-place";
import { leaveRunnerSession } from "../helpers/runnerSession";
import { closeRunTempRoot, leakReport, openRunTempRoot } from "../helpers/runTempRoot";
import { E2E_RUN_ROOT } from "../helpers/scratchDirs";
import { checkMicrophone } from "./micPreflight";
import { runDir, tidyRunEvidence } from "./runEvidence";

/**
 * Before any test starts: a place in this computer's load line where the
 * shell has one (scripts/heavy-run-place.ts), the run's own evidence
 * directory (tests/e2e/runEvidence.ts) and the run's private TMPDIR
 * (tests/helpers/runTempRoot.ts). Workers and every app they launch inherit
 * the TMPDIR; each worker removes what it made as it exits
 * (tests/helpers/scratchDirs.ts), and the run fails here if anything is left.
 * They inherit nothing of the session that started the run
 * (tests/helpers/runnerSession.ts).
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  leaveRunnerSession();
  // INF-1541 piece 4 and INF-1664: a local run waits in its computer's load line and holds its
  // place to the end; in CI, or in a shell with no line, it starts at once (INF-2137).
  const runPlace = await takeHeavyRunPlace("journeys", { workers: config.workers });
  // Voice journeys need the runner to open the microphone (tests/e2e/micPreflight.ts).
  await checkMicrophone();
  const workingCopy = config.configFile ? dirname(config.configFile) : config.rootDir;
  const evidence = runDir();
  tidyRunEvidence(workingCopy, evidence);
  console.log(`This run's evidence: ${relative(process.cwd(), join(workingCopy, evidence))}/`);
  const run = await openRunTempRoot("e2e");
  process.env[E2E_RUN_ROOT] = run.root;
  return async () => {
    try {
      delete process.env[E2E_RUN_ROOT];
      const leaked = await closeRunTempRoot(run, 15_000);
      const report = leakReport("e2e", leaked);
      if (report) throw new Error(report);
    } finally {
      runPlace.close();
    }
  };
}
