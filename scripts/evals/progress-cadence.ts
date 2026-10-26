import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { EvalRun } from "./approvalHandoff.ts";
import { openModuleRunner } from "../moduleRunner.ts";

/**
 * Scores a recorded progress-cadence run (docs/account-evaluation.md, "Progress cadence"):
 * each case's saved plan at every step's start, and whether it moved between steps.
 */
const { values } = parseArgs({
  options: { out: { type: "string" }, responses: { type: "string" } },
});
if (!values.out || !values.responses) throw new Error("Name out and the recorded responses");
const responses = JSON.parse(readFileSync(values.responses, "utf8")) as Record<string, EvalRun>;
const runner = await openModuleRunner();
try {
  const { evaluation, scoreProgressCadence } = await runner.import<
    typeof import("./progressCadence.ts")
  >("scripts/evals/progressCadence.ts");
  const scores = evaluation.cases.map((test) => {
    const run = responses[test.id];
    if (!run) return { id: test.id, failures: ["Missing recorded response"] };
    return {
      id: test.id,
      endedNormally: run.endedNormally,
      stepStarts: (run.state as { stepStarts?: unknown }).stepStarts,
      failures: scoreProgressCadence(run),
    };
  });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "progress-cadence-scores.json"), JSON.stringify(scores, null, 2));
  console.log(JSON.stringify(scores, null, 2));
  if (scores.some((score) => score.failures.length)) process.exitCode = 1;
} finally {
  await runner.close();
}
