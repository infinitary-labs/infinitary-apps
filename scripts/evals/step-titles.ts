import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { EvalRun } from "./approvalHandoff.ts";
import type { StepTitleReview } from "./stepTitles.ts";
import { openModuleRunner } from "../moduleRunner.ts";

/**
 * Scores a recorded step-titles run (docs/account-evaluation.md, "Step titles").
 * Without --reviews it writes the trace score and every filed title and goal as
 * passed, for an independent reviewer; with --reviews it adds that review.
 */
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    responses: { type: "string" },
    reviews: { type: "string" },
  },
});
if (!values.out || !values.responses) throw new Error("Name out and the recorded responses");
const responses = JSON.parse(readFileSync(values.responses, "utf8")) as Record<string, EvalRun>;
const reviews = values.reviews
  ? (JSON.parse(readFileSync(values.reviews, "utf8")) as Record<string, StepTitleReview>)
  : undefined;
const runner = await openModuleRunner();
try {
  const { stepTitleCases, scoreStepTitleRun, scoreStepTitleTrace, filedSteps } =
    await runner.import<typeof import("./stepTitles.ts")>("scripts/evals/stepTitles.ts");
  const scores = stepTitleCases.map((test) => {
    const run = responses[test.id];
    const review = reviews?.[test.id];
    if (!run || (reviews && !review))
      return { id: test.id, failures: ["Missing recorded response or independent review"] };
    return {
      id: test.id,
      review: reviews ? "included" : "pending",
      failures: review ? scoreStepTitleRun(test, run, review) : scoreStepTitleTrace(test, run),
    };
  });
  const filed = Object.fromEntries(
    stepTitleCases.map((test) => [
      test.id,
      { planSteps: test.steps, filed: responses[test.id] ? filedSteps(responses[test.id]!) : [] },
    ]),
  );
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "step-title-scores.json"), JSON.stringify(scores, null, 2));
  writeFileSync(join(values.out, "step-titles-filed.json"), JSON.stringify(filed, null, 2));
  if (scores.some((score) => score.failures.length)) process.exitCode = 1;
} finally {
  await runner.close();
}
