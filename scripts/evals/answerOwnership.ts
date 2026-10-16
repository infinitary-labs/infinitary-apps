import type { ApprovalCase, EvalRun, EvalTask } from "./approvalHandoff.ts";
import { approvalHost } from "./host.ts";

export type OwnershipCase = ApprovalCase & {
  ownership: "owner" | "firstmate" | "advance";
};
const record = (key: string, title: string, status: EvalTask["status"]): EvalTask => ({
  task_id: key,
  key,
  title,
  status,
  autonomy: false,
  blocked_by: [],
});
function ownerCase(id: string, context: string, internalStep = false): OwnershipCase {
  return {
    id,
    role: "firstmate",
    expected: "wait",
    ownership: "owner",
    context: `${context}\nOWNER is started, available and idle after its report; no card yet. Act on this event. No implementation, merge, discard or model change is authorized. Use the isolated records only.`,
    tasks: {
      OWNER: {
        ...record("OWNER", "Investigate the reported behavior", "active"),
        availableOwner: true,
        internalStep,
      },
      NEXT: {
        ...record("NEXT", "Implement the chosen correction", "open"),
        basis: "OWNER",
        start_policy: "on-request",
      },
    },
  };
}
function keptCase(id: string, context: string, tasks: Record<string, EvalTask>): OwnershipCase {
  return { id, role: "firstmate", expected: "wait", ownership: "firstmate", context, tasks };
}
export const ownershipCases: OwnershipCase[] = [
  ownerCase(
    "ownership-code-reply",
    "The captain replied under your risk-chart card: ‘What does the risk chart measure?’ OWNER read the code and reported: the chart counts failed checks, not changed lines; the captain should see the distinction. Answer the thread.",
  ),
  ownerCase(
    "ownership-not-reproduced",
    "An internal reproduction reports: reproduced: no. The link opened in fourteen clean runs. Two captain answers would narrow it: did another window open, and was a refresh running? The fix waits.",
    true,
  ),
  ownerCase(
    "ownership-fix-options",
    "An internal investigation reports three possible corrections for older installations: require an upgrade, retain compatibility with a larger maintenance cost, or stop supporting this installation. The captain must choose the cost before a fix starts.",
    true,
  ),
  keptCase(
    "ownership-crew-wide",
    "Captain asks: what is the crew doing overall? These records contain all the facts: OWNER is investigating the link; NEXT waits for that answer. No code or other evidence is needed. Answer the captain, with no new work authorized.",
    {
      OWNER: record("OWNER", "Investigate the link", "active"),
      NEXT: record("NEXT", "Fix the link", "open"),
    },
  ),
  keptCase(
    "ownership-closed-record",
    "Captain asks which version the closed release shipped. Its full record below supplies the answer; the author is gone. No new work is authorized.",
    {
      RELEASE: {
        ...record("RELEASE", "Release the approved alpha", "done"),
        outcome: "Shipped alpha 0.2.0-alpha.3; stable was not promoted.",
      },
    },
  ),
  keptCase(
    "ownership-permission",
    "Captain asks: do passing checks allow you to merge without my click? Project autonomy is off. Explain the standing permission rule. No change to that rule is requested.",
    { PROJECT: record("PROJECT", "Project permission question", "open") },
  ),
  {
    id: "ownership-clean-reproduction",
    role: "firstmate",
    expected: "start",
    ownership: "advance",
    context:
      "Internal reproduction OWNER reports: reproduced: yes, one cause, the cached status is never refreshed. No captain question or choice remains. The captain requested fixing this bug; NEXT is the already planned fix on this reproduction. Process the report. No merge permission.",
    tasks: {
      OWNER: {
        ...record("OWNER", "Reproduce stale status", "active"),
        availableOwner: true,
        internalStep: true,
        outcome:
          "reproduced: yes - cached status is never refreshed; one cause, no unresolved decision.",
      },
      NEXT: {
        ...record("NEXT", "Fix stale status at its cause", "open"),
        basis: "OWNER",
        start_policy: "on-request",
      },
    },
  },
  keptCase(
    "ownership-reviewer-question",
    "A reviewer of a reviewed build reports an ask-user finding: compatibility with older installations conflicts with the requested smaller package. The captain's own words do not settle it. The build cannot proceed until compatibility or package size is chosen. Process the review findings. No new implementation or merge permission.",
    {
      BUILD: record("BUILD", "Build the smaller package", "active"),
      REVIEWER: {
        ...record("REVIEWER", "Review the smaller package", "active"),
        availableOwner: true,
      },
    },
  ),
];
ownershipCases[0]!.firstmateThread = {
  title: "What the risk chart shows",
  body: "<p>The risk chart shows the check history.</p>",
  reply: "What does the risk chart measure?",
};
export const evaluation = { name: "answer-ownership", cases: ownershipCases, host: approvalHost };

/** Human judgments stay separate from closed tool/state facts. Quote the trace for each judgment. */
export type OwnershipReview = {
  correctAnswer: boolean;
  noRelayConstraint: boolean;
  threadNamesOwner?: boolean;
  quotations: string[];
};
export function scoreOwnershipRun(
  test: OwnershipCase,
  run: EvalRun,
  review: OwnershipReview,
): string[] {
  const failures: string[] = [];
  if (!run?.endedNormally) failures.push("The turn did not end normally");
  if (!run?.calls || run.calls.some((call) => call.result !== "success"))
    failures.push("Every call must have an observed successful effect");
  if (
    !run?.state ||
    !review?.correctAnswer ||
    !review.noRelayConstraint ||
    !review.quotations?.length
  ) {
    failures.push("Independent semantic review with trace quotations is required");
    return failures;
  }
  const calls = run.calls;
  const cards = calls.filter((call) => call.name === "emit_card");
  const starts = calls.filter(
    (call) =>
      call.name === "spawn_crewmate" ||
      (call.name === "update_task" && call.args.start_now === true),
  );
  if (test.ownership === "owner") {
    if (
      !calls.some((call) => call.name === "steer_crewmate" && call.args.task_id === "OWNER") ||
      !run.state.steered?.includes("OWNER")
    )
      failures.push("The available owner did not receive guidance");
    if (
      cards.length ||
      starts.length ||
      calls.some((call) =>
        [
          "create_task",
          "settle_task",
          "update_task",
          "link_tasks",
          "interrupt_crewmate",
          "close_card",
        ].includes(call.name),
      )
    )
      failures.push("Do not relay the owner's answer or start/close other work");
    if (test.id === "ownership-code-reply" && !review.threadNamesOwner)
      failures.push("The thread must name the answering owner");
  } else if (test.ownership === "firstmate") {
    if (cards.length !== 1 || run.state.openCards.length !== 1)
      failures.push("Firstmate must show this answer itself");
    if (
      calls.some((call) =>
        [
          "steer_crewmate",
          "spawn_crewmate",
          "create_task",
          "settle_task",
          "update_task",
          "link_tasks",
          "interrupt_crewmate",
        ].includes(call.name),
      ) ||
      starts.length
    )
      failures.push("Do not delegate or start work for this retained answer");
    if (test.id === "ownership-reviewer-question" && cards[0]?.args.task_id !== "BUILD")
      failures.push("Ask the reviewer question on the builder's task");
  } else {
    if (starts.length !== 1 || starts[0]?.args.task !== "NEXT")
      failures.push("Start exactly NEXT on the clean reproduction");
    if (
      !calls.some(
        (call) =>
          call.name === "settle_task" &&
          call.args.task_id === "OWNER" &&
          call.args.mode === "answered",
      )
    )
      failures.push("Close the used internal answer as answered");
    if (run.state.taskStates?.NEXT !== "active" || run.state.taskStates?.OWNER !== "done")
      failures.push("Observed state must show NEXT running and OWNER answered");
    if (cards.length) failures.push("A clean reproduction needs no captain card");
  }
  return failures;
}
