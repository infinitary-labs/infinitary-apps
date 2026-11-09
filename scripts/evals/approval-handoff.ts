import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openModuleRunner, REPO_ROOT } from "../moduleRunner.ts";
import { approvalCases, type EvalRun, scoreApprovalRun } from "./approvalHandoff.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "test-results/approval-eval" },
    responses: { type: "string" },
  },
});
const runner = await openModuleRunner();
try {
  const { buildFirstmateSystemPrompt, buildCrewmateSystemPrompt } = (await runner.import(
    "src/core/pi/piResources.ts",
  )) as typeof import("../../src/core/pi/piResources.ts");
  const { Runbooks, crewRunbookText } = (await runner.import(
    "src/core/runbooks/runbooks.ts",
  )) as typeof import("../../src/core/runbooks/runbooks.ts");
  const { createTaskTools } = (await runner.import(
    "src/core/pi/taskTools.ts",
  )) as typeof import("../../src/core/pi/taskTools.ts");
  const { createCrewTools } = (await runner.import(
    "src/core/pi/crewTools.ts",
  )) as typeof import("../../src/core/pi/crewTools.ts");
  const { createEmitCardTool } = (await runner.import(
    "src/core/pi/cardTool.ts",
  )) as typeof import("../../src/core/pi/cardTool.ts");
  const { renderBasisSection } = (await runner.import(
    "src/core/orchestrator/intentBrief.ts",
  )) as typeof import("../../src/core/orchestrator/intentBrief.ts");
  const unavailable = (): never => {
    throw new Error("Evaluation export executes no tools");
  };
  const tools = [
    ...createTaskTools({
      plan: unavailable,
      update: unavailable,
      drop: unavailable,
      withdrawMerge: unavailable,
      override: unavailable,
      withdrawOverride: unavailable,
      withdrawAllowance: unavailable,
      startNow: unavailable,
      startAgain: unavailable,
      link: unavailable,
      query: unavailable,
    }),
    ...createCrewTools({
      commission: unavailable,
      steerCrewmate: unavailable,
      interruptCrewmate: unavailable,
      crewStatus: unavailable,
      isCaptainTurn: () => true,
      settleTask: unavailable,
      closeDone: unavailable,
    }),
    createEmitCardTool(unavailable, undefined, { role: "firstmate" }),
  ].map(({ name, description, parameters }) => ({ name, description, parameters }));
  // The guidance a fresh app serves: the bundled runbooks with every built-in on.
  const runbooks = new Runbooks(join(REPO_ROOT, "resources", "runbooks"), {
    getRunbookStates: () => ({}),
    setRunbookStates: () => {},
  });
  // The builder fixture's stated facts: implement work on a direct-pr project at standard care.
  const builderPrompt = buildCrewmateSystemPrompt(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    crewRunbookText(
      runbooks.crew({
        kind: "implement",
        place: "project",
        delivery: "direct-pr",
        care: "standard",
        backend: "pi",
      }),
    ),
  );
  const out = values.out as string;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "task-tools.json"), JSON.stringify(tools, null, 2));
  writeFileSync(join(out, "cases.json"), JSON.stringify(approvalCases, null, 2));
  for (const test of approvalCases) {
    const plan = test.tasks.PLAN!;
    const body =
      test.role === "builder"
        ? `${builderPrompt}\n\n${renderBasisSection({
            key: "PLAN",
            title: plan.title,
            outcome: plan.outcome,
            card: plan.resolution?.offer.body,
            choice: plan.resolution?.action,
            answers: plan.resolution?.answers.map(
              (answer) => `- ${answer.name}: ${answer.values.join(", ")}`,
            ),
          })}\n\nTask autonomy: false. Delivery: direct-pr. No captain merge authorization.`
        : `${buildFirstmateSystemPrompt()}\n\n${runbooks.firstmate().text}\n\nNative tool definitions:\n${JSON.stringify(tools)}`;
    writeFileSync(
      join(out, `${test.id}.txt`),
      `${body}\n\n${test.context}\n\nIsolated task records (tasks by key returns these facts; crew_status reports the stated autonomy):\n${JSON.stringify(test.tasks, null, 2)}\n\nUse only these isolated records. Do not touch other tasks.\n`,
    );
  }
  if (values.responses) {
    const responses = JSON.parse(readFileSync(values.responses, "utf8")) as Record<string, EvalRun>;
    const results = approvalCases.map((test) => ({
      id: test.id,
      failures: responses[test.id]
        ? scoreApprovalRun(test, responses[test.id] as EvalRun)
        : ["Missing recorded model response"],
    }));
    writeFileSync(join(out, "scores.json"), JSON.stringify(results, null, 2));
    if (results.some((result) => result.failures.length)) process.exitCode = 1;
  } else {
    console.log(
      "Exported evaluation prompts; no model responses scored. This is not instruction-following proof.",
    );
  }
} finally {
  await runner.close();
}
