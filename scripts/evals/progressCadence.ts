import { Type } from "typebox";
import { boundTool, stringEnum } from "../../src/core/session/tools.ts";
import type { ApprovalCase, EvalRun } from "./approvalHandoff.ts";
import { approvalHost } from "./host.ts";

/**
 * The progress cadence evaluation (INF-1463, INF-1464): does a live crewmate move
 * its task's saved plan while it works, or only with its brief and its report.
 * The captain: "it seems the progress only update at the very end of a turn or
 * something. i want this improved so the progress updates more in near real time".
 * The case is shaped like INF-1461, the task in the captain's picture: bring a
 * branch up to date, regenerate, run the gate, build the bundle. Each step runs
 * through one fixture tool that answers with that step's recorded kind of output
 * and runs nothing. The brief says nothing about when to note progress: only the
 * served crew prompt and tool description do.
 *
 * At each step's start the host reads the task's saved plan, as the crew summary
 * does. The check is the reproduction's: once a step has finished, the saved plan
 * shows more items done by the time the next step starts.
 */
const steps = {
  rebase: `Successfully rebased and updated refs/heads/fm/task-643.
3 commits replayed onto origin/main (4f1c2a9). No conflicts.`,
  generate: `pnpm generate:contract  wrote docs/contract.json (unchanged)
pnpm generate:personal-env  wrote src/core/prompts/firstmateEnv.generated.ts (2 lines changed)
git status: 1 file modified.`,
  gate: `pnpm typecheck  passed (41.2s)
pnpm check  passed: 3,912 tests in 212 files (68.4s)
pnpm lint:adherence  passed`,
  bundle: `pnpm build  out/main 2.1 MB, out/preload 41 kB, out/renderer 6.8 MB
Built in 37.9s.`,
} as const;
type Step = keyof typeof steps;
const order = Object.keys(steps) as Step[];

const context = `Goal: Bring INF-643's branch up to date with main on this computer and rebuild its bundle, so its pull request can be reviewed again.
The user's words, verbatim - these outrank every elaboration below, including your own:
bring 643 up to date and rebuild it

Constraints: four steps in this order, each needing the previous one's result: rebase, generate, gate, bundle. No merge authorization.

This is an isolated exercise. The working copy is reached only through run_step, which runs one step and answers with its output; run one step per call and read its output before the next. There is no shell, push or pull request here, and all delivery access is confirmed for it. Do not emit a card. Finish with report.`;

const cadenceCase = (n: number): ApprovalCase => ({
  id: `progress-cadence-${n}`,
  role: "builder",
  expected: "review",
  context,
  tasks: {
    PLAN: {
      task_id: "PLAN",
      key: "PLAN",
      title: "Earlier request context",
      status: "done",
      autonomy: false,
      blocked_by: [],
      outcome: "Use the captain's words in the supplied brief. No extra change is approved.",
    },
    BUILD: {
      task_id: "BUILD",
      key: "BUILD",
      title: "Bring INF-643's branch up to date",
      status: "open",
      autonomy: false,
      blocked_by: [],
      basis: "PLAN",
    },
  },
});

/** What the task's saved plan read when a step started; null before any plan. */
export type StepStart = { step: Step; plan: string[] | null };

export const progressHost: typeof approvalHost = async (test, dir, model, protectedDirs) => {
  const host = await approvalHost(test, dir, model, protectedDirs);
  const build = host.ids.BUILD!;
  const starts: StepStart[] = [];
  const savedPlan = (): string[] | null => {
    const note = host.tasks
      .timeline(build)
      .findLast((event) => event.kind === "progress" && Array.isArray(event.data?.plan));
    return note ? (note.data!.plan as { state: string }[]).map((item) => item.state) : null;
  };
  const runStep = boundTool({
    name: "run_step",
    label: "Run step",
    description: "Run one step of this task in the isolated working copy and answer with its output.",
    parameters: Type.Object({ step: stringEnum(order) }),
    run: async ({ step }) => {
      starts.push({ step, plan: savedPlan() });
      return { text: steps[step] };
    },
  });
  return {
    ...host,
    spec: { ...host.spec, tools: [...host.spec.tools, runStep] },
    prompt: test.context,
    effect: (name, args, output) =>
      name === "run_step" ? "success" : host.effect(name, args, output),
    state: () => ({ ...host.state(), stepStarts: [...starts], finalPlan: savedPlan() }),
  };
};

const done = (plan: string[] | null) => plan?.filter((state) => state === "done").length ?? 0;

/** The reproduction's check, read from what the host saved; empty when it holds. */
export function scoreProgressCadence(run: EvalRun): string[] {
  const state = run.state as EvalRun["state"] & { stepStarts?: StepStart[] };
  const starts = state.stepStarts ?? [];
  const failures: string[] = [];
  if (starts.map((start) => start.step).join() !== order.join())
    failures.push(`Ran ${starts.map((start) => start.step).join(", ") || "no step"}`);
  if (!starts[0]?.plan) failures.push("No saved plan when the first step started");
  for (let i = 1; i < starts.length; i++) {
    if (done(starts[i]!.plan) <= done(starts[i - 1]!.plan))
      failures.push(
        `The saved plan did not move after ${starts[i - 1]!.step}: ${done(starts[i]!.plan)} done when ${starts[i]!.step} started`,
      );
  }
  return failures;
}

export const evaluation = {
  name: "progress-cadence",
  cases: [1, 2, 3].map(cadenceCase),
  host: progressHost,
  builderCalls: 8,
};
