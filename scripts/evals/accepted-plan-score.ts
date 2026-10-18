import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { openModuleRunner } from "../moduleRunner.ts";
import type { EvalRun } from "./approvalHandoff.ts";
import type { AcceptedPlanReview, LargeDesignReview } from "./acceptedPlan.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    responses: { type: "string" },
    reviews: { type: "string" },
  },
});
if (!values.out || !values.responses || !values.reviews)
  throw new Error("Name out, responses and independent reviews");
const responses = JSON.parse(readFileSync(values.responses, "utf8")) as Record<string, EvalRun>;
const reviews = JSON.parse(readFileSync(values.reviews, "utf8")) as Record<
  string,
  AcceptedPlanReview | LargeDesignReview
>;
const runner = await openModuleRunner();
try {
  const { acceptedPlanCase, largeDesignCase, scoreAcceptedPlan, scoreLargeDesign, scorePlanRead } =
    await runner.import<typeof import("./acceptedPlan.ts")>("scripts/evals/acceptedPlan.ts");
  const cases = [
    {
      test: acceptedPlanCase,
      score: (run: EvalRun, review: unknown) =>
        scoreAcceptedPlan(run, review as AcceptedPlanReview),
    },
    {
      test: largeDesignCase,
      score: (run: EvalRun, review: unknown) => scoreLargeDesign(run, review as LargeDesignReview),
    },
  ].map(({ test, score }) => {
    const id = test.id;
    const path = join(dirname(values.responses!), `${id}.json`);
    const record = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
    const run = responses[id];
    // Older responses lack request numbers; their original tool-end frames retain them.
    // Match every executed call, never assign one request per call or trust a proposed order.
    const ends = record?.frames?.filter((frame: { type: string }) => frame.type === "tool_end");
    const matched =
      run &&
      ends?.length === run.calls.length &&
      run.calls.every(
        (call, index) =>
          ends[index].toolName === call.name &&
          (call.request === undefined || call.request === ends[index].request),
      );
    const measured = matched
      ? { ...run, calls: run.calls.map((call, index) => ({ ...call, request: ends[index].request })) }
      : run;
    const failures =
      measured && reviews[id]
        ? score(measured, reviews[id]!)
        : ["Missing response or independent review"];
    if (id === acceptedPlanCase.id && !matched)
      failures.push("Missing or inconsistent tool request evidence");
    if (!record) failures.push("Missing live client record");
    else {
      const planReads = (responses[id]?.calls ?? []).flatMap((call, index) =>
        call.name === "tasks" && call.args.key === "PLAN" && record.results?.[index]
          ? [record.results[index]]
          : [],
      );
      failures.push(...scorePlanRead(test, planReads, record.native ?? []));
    }
    return { id, failures };
  });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "accepted-plan-scores.json"), JSON.stringify({ cases }, null, 2));
  if (cases.some(({ failures }) => failures.length)) process.exitCode = 1;
} finally {
  await runner.close();
}
