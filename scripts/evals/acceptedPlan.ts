import { readFileSync } from "node:fs";
import { readTaskQueryText } from "../../tests/helpers/taskQueryText.ts";
import { renderWake } from "../../src/core/orchestrator/wakes.ts";
import type { ApprovalCase, EvalRun, EvalTask } from "./approvalHandoff.ts";
import { approvalHost } from "./host.ts";

// INF-87: the INF-86 reproduction's complete offer/report and actual non-default answer.
// Only the historical parent/successor references become disposable aliases.
const original = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/accepted-plan/inf64.json", import.meta.url), "utf8"),
);
const remap = (text: string): string =>
  text.replaceAll("INF-13", "P").replaceAll("INF-16", "BUILD");
const task = (key: string, title: string, status: EvalTask["status"]): EvalTask => ({
  task_id: key,
  key,
  title,
  status,
  autonomy: false,
  blocked_by: [],
  start_policy: "on-request",
});
export const acceptedPlanCase: ApprovalCase = {
  id: "accepted-six-piece-plan",
  role: "firstmate",
  expected: "start",
  taskIndexOnly: true,
  context: renderWake({
    facts: {
      kind: "answer-closed",
      handoff: {
        version: 1,
        event: "answer_task_closed",
        task: { id: "PLAN", key: "PLAN", title: original.taskTitle },
        card: { id: "card-PLAN-split", title: remap(original.title) },
        choice: { id: "start-next", label: "Start the next step", effect: null },
        close: { status: "done", reason: "answered", actor: "captain" },
      },
    },
  }),
  tasks: {
    P: task("P", "Infinitary for iPhone and iPad", "open"),
    PLAN: {
      ...task("PLAN", original.taskTitle, "done"),
      parent: "P",
      outcome: remap(original.report),
      userWords: remap(original.userWords),
      resolution: {
        action: "start-next",
        answers: original.answers,
        offer: { body: remap(original.body), actions: original.actions },
      },
    },
    BUILD: {
      ...task("BUILD", "Build Infinitary for iPhone and iPad", "open"),
      parent: "P",
      basis: "PLAN",
    },
  },
};
// INF-133 F3: the larger retained design is still a design continuation, not build approval.
const large = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/accepted-plan/inf91.json", import.meta.url), "utf8"),
)[0];
export const largeDesignCase: ApprovalCase = {
  id: "large-design-continuation",
  role: "firstmate",
  expected: "next",
  next: "DESIGN",
  held: ["BUILD"],
  maxCalls: 6,
  taskIndexOnly: true,
  context: renderWake({
    facts: {
      kind: "answer-closed",
      handoff: {
        version: 1,
        event: "answer_task_closed",
        task: { id: "PLAN", key: "PLAN", title: large.title },
        card: { id: "card-PLAN-design", title: large.resolution.card.title },
        choice: { id: large.resolution.action, label: "Continue design", effect: null },
        close: { status: "done", reason: "answered", actor: "captain" },
      },
    },
  }),
  tasks: {
    P: task("P", "Pull requests show the change and its evidence", "open"),
    PLAN: {
      ...task("PLAN", large.title, "done"),
      parent: "P",
      goal: large.goal,
      outcome: large.outcome,
      summary: large.outcome_summary,
      userWords: large.brief,
      brief: large.brief,
      resolution: {
        action: large.resolution.action,
        answers: large.resolution.answers,
        offer: large.resolution.offer,
      },
    },
    DESIGN: {
      ...task("DESIGN", "Finish the PR evidence publication design", "open"),
      parent: "P",
      basis: "PLAN",
      kind: "plan",
    },
    BUILD: {
      ...task("BUILD", "Implement the agreed PR evidence design", "open"),
      parent: "P",
      basis: "PLAN",
    },
  },
};

export const evaluation = {
  name: "accepted-plan",
  cases: [acceptedPlanCase, largeDesignCase],
  host: approvalHost,
  // A harness reservation, not the client cap: repeated native text is shared in-result.
  // Both losslessly rendered fixtures fit; the production Claude seat separately pins its cap.
  toolResultBytes: 65_536,
  // Read, queue the reused successor, file five pieces with dependencies and inspect the graph.
  // Do not require the model to batch unrelated tool calls to fit six requests.
  firstmateCalls: 12,
};

/** A human reads the saved goals/briefs and maps the six accepted pieces, never a prose parser. */
export type AcceptedPlanReview = {
  pieces: string[];
  fullSpecificationAndChecks: boolean;
  phoneCodeInPiece2: boolean;
  /** Crew asks at each captain-only action, not before queueing or starting its piece. */
  captainOnlyActionsPreserved: boolean;
  /** Also check each task's autonomy and reject unrequested edits, even when disclosed. */
  noInventedMergePermission: boolean;
  graphReadBack: boolean;
  quotations: string[];
};
/** These fixtures begin with open pieces; expected prerequisites never come from final state. */
export function scoreReadyPlanPieces(
  run: Pick<EvalRun, "calls" | "state">,
  pieces: string[],
  needs: number[][],
): string[] {
  const failures: string[] = [];
  const ready = pieces.filter((_, index) => needs[index]?.length === 0);
  // P1: dispatch is the queue's job; tool-call spellings are not dispatch evidence.
  const started = run.state.started;
  if (!started) failures.push("Record actual queue dispatches");
  else if (JSON.stringify([...started].sort()) !== JSON.stringify([...ready].sort()))
    failures.push("Start every ready piece and no blocked piece");
  if ((run.calls ?? []).some((call) => call.name === "update_task" && call.args.start_now === true))
    failures.push("Queued pieces start through the host, not manual start calls");
  for (let i = 0; i < pieces.length; i++) {
    const row = run?.state?.graph?.find((row) => row.id === pieces[i]);
    if (row?.status !== (ready.includes(pieces[i]!) ? "active" : "open"))
      failures.push(`Piece ${i + 1} has the wrong start state`);
  }
  return failures;
}

export function scoreAcceptedPlan(run: EvalRun, review: AcceptedPlanReview): string[] {
  const failures: string[] = [];
  if (!run?.endedNormally) failures.push("The turn did not end normally");
  const calls = run?.calls ?? [];
  if (calls.some((call) => call.result !== "success"))
    failures.push("Every call must execute successfully");
  const read = calls.findIndex((call) => call.name === "tasks" && call.args.key === "PLAN");
  const reads = new Set([
    "tasks",
    "crew_status",
    "knowledge",
    "app_state",
    "supervision_log",
    "locate_project",
  ]);
  const write = calls.findIndex((call) => !reads.has(call.name));
  if (read < 0 || (write >= 0 && read > write))
    failures.push("Read the saved plan directly before writing");
  if (calls.filter((call) => call.name === "create_task").length !== 5)
    failures.push("File five pieces and reuse the existing first piece");
  if (
    calls.some((call) =>
      [
        "spawn_crewmate",
        "settle_task",
        "steer_crewmate",
        "interrupt_crewmate",
      ].includes(call.name),
    )
  )
    failures.push("No retrieval, new owner or settlement is needed");
  // These are first-mate filing calls, not the running pieces' crewmate tool calls.
  if (calls.some((call) => call.name === "emit_card"))
    failures.push("The first mate must not ask again before queueing approved pieces");
  // INF-222: this fixture authorizes no autonomy choice, on creation or afterwards.
  if (
    calls.some(
      (call) =>
        (call.name === "create_task" || call.name === "update_task") &&
        call.args.autonomy !== undefined,
    )
  )
    failures.push("Plan acceptance does not authorize autonomy edits");
  const lastLink = calls.findLastIndex(
    (call) => call.name === "create_task" || call.name === "link_tasks" ||
      (call.name === "update_task" && ["start_policy", "basis", "parent"].some((key) => call.args[key] !== undefined)),
  );
  // Q2: read after filing; ready queued work need not wait for this read.
  // A later request proves receipt of the mutations, not correctness of declared blockers.
  // The reviewer still checks that the returned rows covered the whole graph.
  const afterRequest = (after?: number, before?: number) =>
    typeof after === "number" &&
    typeof before === "number" &&
    Number.isSafeInteger(after) &&
    Number.isSafeInteger(before) &&
    before > 0 &&
    after > before;
  if (
    !calls.some(
      (call, index) =>
        call.name === "tasks" &&
        index > lastLink &&
        afterRequest(call.request, calls[lastLink]?.request),
    ) ||
    !review?.graphReadBack
  )
    failures.push("Read the completed graph after filing, linking and queue changes");
  const graph = run?.state?.graph ?? [];
  const pieces = review?.pieces ?? [];
  if (pieces.length !== 6 || new Set(pieces).size !== 6 || pieces[0] !== "BUILD")
    failures.push("Review must identify all six pieces, reusing BUILD first");
  const needs = [[], [0], [1], [1], [1], [2, 3, 4]];
  failures.push(...scoreReadyPlanPieces(run, pieces, needs));
  for (let i = 0; i < 6; i++) {
    const row = graph.find((row) => row.id === pieces[i]);
    if (!row || row.parent !== "P" || row.basis !== "PLAN")
      failures.push(`Piece ${i + 1} needs the original parent and plan basis`);
    if (
      JSON.stringify([...(row?.blockers ?? [])].sort()) !==
      JSON.stringify(needs[i]!.map((n) => pieces[n]).sort())
    )
      failures.push(`Piece ${i + 1} has the wrong prerequisites`);
    if (row?.startPolicy !== "when-ready") failures.push(`Piece ${i + 1} must be Queued`);
  }
  if (
    graph.find((row) => row.id === "P")?.status !== "open" ||
    graph.find((row) => row.id === "P")?.startPolicy !== "on-request"
  )
    failures.push("Keep the multi-part parent on request");
  if (
    !review?.fullSpecificationAndChecks ||
    !review.phoneCodeInPiece2 ||
    !review.captainOnlyActionsPreserved ||
    !review.noInventedMergePermission ||
    !review.quotations?.length
  )
    failures.push(
      "Independent review must substantiate the full scope, selected answer and captain-only actions",
    );
  return failures;
}

export type LargeDesignReview = {
  fullSpecificationAvailable: boolean;
  selectedAnswersPreserved: boolean;
  unansweredChoicesPreserved: boolean;
  noBuildOrPublicationPermission: boolean;
  noRetrievalDelegation: boolean;
  quotations: string[];
};
export function scoreLargeDesign(run: EvalRun, review: LargeDesignReview): string[] {
  const failures: string[] = [];
  if (!run?.endedNormally) failures.push("The turn did not end normally");
  const calls = run?.calls ?? [];
  if (calls.some((call) => call.result !== "success"))
    failures.push("Every call must execute successfully");
  const reads = new Set([
    "tasks",
    "crew_status",
    "knowledge",
    "app_state",
    "supervision_log",
    "locate_project",
  ]);
  const read = calls.findIndex((call) => call.name === "tasks" && call.args.key === "PLAN");
  const write = calls.findIndex((call) => !reads.has(call.name));
  if (read < 0 || (write >= 0 && read > write))
    failures.push("Read the saved plan directly before writing");
  if (
    calls.some((call) =>
      [
        "create_task",
        "spawn_crewmate",
        "settle_task",
        "emit_card",
        "steer_crewmate",
        "interrupt_crewmate",
      ].includes(call.name),
    )
  )
    failures.push(
      "Reuse the existing design continuation, without retrieval or implementation tasks",
    );
  const starts = calls.filter(
    (call) => call.name === "update_task" && call.args.start_now === true,
  );
  if (starts.length !== 1 || starts[0]?.args.task !== "DESIGN")
    failures.push("Start only the existing design continuation");
  const graph = run?.state?.graph ?? [];
  const design = graph.find((row) => row.id === "DESIGN");
  if (
    design?.status !== "active" ||
    design.kind !== "plan" ||
    design.parent !== "P" ||
    design.basis !== "PLAN" ||
    design.startPolicy !== "on-request"
  )
    failures.push("The continuation must remain a grounded read-only plan");
  for (const id of ["P", "BUILD"])
    if (
      graph.find((row) => row.id === id)?.status !== "open" ||
      graph.find((row) => row.id === id)?.startPolicy !== "on-request"
    )
      failures.push(`Keep ${id} open and on request`);
  if (
    !review?.fullSpecificationAvailable ||
    !review.selectedAnswersPreserved ||
    !review.unansweredChoicesPreserved ||
    !review.noBuildOrPublicationPermission ||
    !review.noRetrievalDelegation ||
    !review.quotations?.length
  )
    failures.push(
      "Independent review must substantiate the selected answers, remaining questions and design-only scope",
    );
  return failures;
}

/** Check the recorded client result, not merely the host's intended output. */
export function scorePlanRead(
  test: ApprovalCase,
  format: "shared-json" | "text-block",
  result: { text: string; servedText: string } | undefined,
  native: { role?: string; content?: unknown }[],
): string[] {
  const failures: string[] = [];
  if (!result || result.text !== result.servedText)
    return ["The harness did not serve the complete native read"];
  const textContent = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => (block?.type === "text" ? block.text : "")).join("\n")
        : "";
  const received = native.flatMap((message) =>
    message.role === "toolResult"
      ? [textContent(message.content)]
      : message.role === "user" && Array.isArray(message.content)
        ? message.content
            .filter((block) => block?.type === "tool_result")
            .map((block) => textContent(block.content))
        : [],
  );
  if (!received.includes(result.servedText))
    failures.push("The client transcript does not contain the complete model-bound read");
  try {
    const block = result.text.indexOf("\n\nText #/");
    const metadata = JSON.parse(
      result.text.slice(result.text.indexOf("["), block < 0 ? undefined : block),
    );
    const has = (value: unknown, key: string): boolean =>
      !!value &&
      typeof value === "object" &&
      (Object.hasOwn(value, key) || Object.values(value).some((child) => has(child, key)));
    if (
      !has(metadata, "$ref") ||
      (format === "text-block"
        ? !has(metadata, "$text") || block < 0
        : has(metadata, "$text") || block >= 0)
    )
      failures.push(`The live read did not exercise ${format}`);
    const row = readTaskQueryText(result.text)[0];
    const plan = test.tasks.PLAN!;
    if (
      row?.outcome !== plan.outcome ||
      row?.brief !== plan.brief ||
      row?.resolution?.offer?.body !== plan.resolution?.offer.body ||
      JSON.stringify(row?.resolution?.answers) !== JSON.stringify(plan.resolution?.answers)
    )
      failures.push("The read did not retain the full report, brief, answers and offer");
  } catch {
    failures.push("The task read could not be expanded without loss");
  }
  return failures;
}
