import { dirname, join, relative } from "node:path";
import type { FullConfig } from "@playwright/test";
import { leaveRunnerSession } from "../helpers/runnerSession";
import { closeRunTempRoot, leakReport, openRunTempRoot } from "../helpers/runTempRoot";
import { E2E_RUN_ROOT } from "../helpers/scratchDirs";
import { runDir, tidyRunEvidence } from "./runEvidence";

/**
 * Before any test starts: the run's own evidence directory
 * (tests/e2e/runEvidence.ts) and the run's private TMPDIR
 * (tests/helpers/runTempRoot.ts). Workers and every app they launch inherit
 * the TMPDIR; each worker removes what it made as it exits
 * (tests/helpers/scratchDirs.ts), and the run fails here if anything is left.
 * They inherit nothing of the session that started the run
 * (tests/helpers/runnerSession.ts).
 */
export default function globalSetup(config: FullConfig): () => Promise<void> {
  leaveRunnerSession();
  const workingCopy = config.configFile ? dirname(config.configFile) : config.rootDir;
  const evidence = runDir();
  tidyRunEvidence(workingCopy, evidence);
  console.log(`This run's evidence: ${relative(process.cwd(), join(workingCopy, evidence))}/`);
  const run = openRunTempRoot("e2e");
  process.env[E2E_RUN_ROOT] = run.root;
  return async () => {
    delete process.env[E2E_RUN_ROOT];
    const leaked = await closeRunTempRoot(run, 15_000);
    if (leaked.length > 0) throw new Error(leakReport("e2e", leaked));
  };
}
