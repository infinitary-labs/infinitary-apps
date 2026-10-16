import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { EvalRun } from "./approvalHandoff.ts";
import { openModuleRunner } from "../moduleRunner.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, responses: { type: "string" } } });
if (!values.out || !values.responses) throw new Error("Name out and the recorded responses");
const responses = JSON.parse(readFileSync(values.responses, "utf8")) as Record<string, EvalRun>;
const runner = await openModuleRunner();
try {
  const { lessonCases, scoreLessonRun } = await runner.import<typeof import("./lessons.ts")>(
    "scripts/evals/lessons.ts",
  );
  const scores = lessonCases.map((test) => ({
    id: test.id,
    failures: responses[test.id]
      ? scoreLessonRun(test, responses[test.id] as EvalRun)
      : ["Missing recorded response"],
  }));
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "lesson-scores.json"), JSON.stringify(scores, null, 2));
  if (scores.some((score) => score.failures.length)) process.exitCode = 1;
} finally {
  await runner.close();
}
