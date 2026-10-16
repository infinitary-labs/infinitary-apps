import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { EvalRun } from "./approvalHandoff.ts";
import type { OwnershipReview } from "./answerOwnership.ts";
import { openModuleRunner } from "../moduleRunner.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    responses: { type: "string" },
    reviews: { type: "string" },
  },
});
if (!values.out || !values.responses || !values.reviews)
  throw new Error("Name out, responses and independently reviewed judgments");
const responses = JSON.parse(readFileSync(values.responses, "utf8")) as Record<string, EvalRun>;
const reviews = JSON.parse(readFileSync(values.reviews, "utf8")) as Record<string, OwnershipReview>;
const runner = await openModuleRunner();
try {
  const { ownershipCases, scoreOwnershipRun } = await runner.import<
    typeof import("./answerOwnership.ts")
  >("scripts/evals/answerOwnership.ts");
  const scores = ownershipCases.map((test) => ({
    id: test.id,
    failures:
      responses[test.id] && reviews[test.id]
        ? scoreOwnershipRun(test, responses[test.id]!, reviews[test.id]!)
        : ["Missing recorded response or independent review"],
  }));
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "ownership-scores.json"), JSON.stringify(scores, null, 2));
  if (scores.some((score) => score.failures.length)) process.exitCode = 1;
} finally {
  await runner.close();
}
