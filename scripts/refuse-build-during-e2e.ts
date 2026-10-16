// The first step of `pnpm build`, and so of `pnpm test:e2e`: an e2e run
// launches the app from out/ for every test, so a build that rewrites out/
// while a run of this working copy is going would swap the app under its
// later tests. Refuse instead (docs/testing.md, "Per-run e2e evidence").
import { join } from "node:path";
import { liveRuns, RUNS_DIR, runPid } from "../tests/e2e/runEvidence.ts";

const live = liveRuns(process.cwd());
if (live.length > 0) {
  const one = live.length === 1;
  const runs = live.map((name) => `${join(RUNS_DIR, name)}/, runner pid ${runPid(name)}`);
  console.error(
    `Not building: ${one ? "an e2e run of this working copy is" : `${live.length} e2e runs of this working copy are`} ` +
      `still going (${runs.join("; ")}). ${one ? "Its" : "Their"} tests launch the app from out/, ` +
      "so a build now would replace the app under them. Build again once " +
      `${one ? "it has" : "they have"} finished or been stopped; meanwhile, ` +
      "`pnpm exec playwright test <spec>` runs more specs against the current build.",
  );
  process.exit(1);
}
