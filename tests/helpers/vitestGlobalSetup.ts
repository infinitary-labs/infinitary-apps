import { leaveRunnerSession } from "./runnerSession";
import { closeRunTempRoot, leakReport, openRunTempRoot } from "./runTempRoot";

const OWNED = "INFINITARY_UNIT_TEMP_ROOT_OWNED";

/**
 * Every unit and integration test runs with TMPDIR pointed at one private
 * root (tests/helpers/runTempRoot.ts); the run fails if anything is still
 * in it at the end. None of them sees the session that started the run
 * (tests/helpers/runnerSession.ts).
 */
export default function setup(): () => Promise<void> {
  leaveRunnerSession();
  // Every project inherits this global setup; the first one to run owns the
  // root and the rest share it.
  if (process.env[OWNED]) return async () => undefined;
  process.env[OWNED] = "1";
  const run = openRunTempRoot("unit");
  return async () => {
    delete process.env[OWNED];
    const leaked = await closeRunTempRoot(run);
    if (leaked.length === 0) return;
    // Vitest prints a teardown error but keeps the run's exit code; a leak
    // must fail the run, so say it and set the code ourselves.
    process.exitCode = 1;
    throw new Error(leakReport("unit", leaked));
  };
}
