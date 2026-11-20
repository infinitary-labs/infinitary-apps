// INF-993, the captain's direction B ("the app writes the history only"):
// INF-812's reviewer lost the captain's F5 and F6 answers when the first
// mate's retyped list said "none", and read an approved gap as unanswered.
// The app now writes every round, answer and gap answer into each reviewer
// turn and the first mate's findings wake. The fixture is INF-812's record.
import type { LiveValidation, ValidationScenario } from "@shared/liveValidation";
import { type ReviewFinding, renderFinding } from "@shared/rigor";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { renderReviewBrief } from "./intentBrief";
import { DECIDED_SO_FAR, renderReviewHistory, reviewHistory } from "./reviewHistory";
import { renderWake } from "./wakes";

const FIRST = "d2be517a1c3f40b6a9e0d2be517a1c3f40b6a9e0";
const SECOND = "1cca114b2d3e40f5a6b7c1cca114b2d3e40f5a6b";
const f5: ReviewFinding = {
  id: "F5",
  severity: "warning",
  file: "src/core/programs/runner.ts",
  line: 212,
  text: "A script that returns none falls back to the default branch instead of shipping nothing.",
  action: "ask-user",
};
const f6: ReviewFinding = {
  id: "F6",
  severity: "warning",
  file: "src/core/programs/runner.ts",
  line: 88,
  text: "The comments claim script-size and result-size limits the code never enforces.",
  action: "ask-user",
};
const f7: ReviewFinding = {
  id: "F7",
  severity: "error",
  file: "src/core/programs/journal.ts",
  line: 41,
  text: "A replay reads the journal before its last line is flushed.",
  action: "auto-fix",
};
const F5 = renderFinding(f5);
const F6 = renderFinding(f6);
const F7 = renderFinding(f7);

/** The typed review record the reviewer reported for one round (INF-1875). */
function typedReview(
  head: string,
  revision: number,
  findings: ReviewFinding[],
  at: number,
): LiveValidation["reviews"][number] {
  return {
    kind: "review",
    head,
    revision,
    code: "findings",
    findings,
    coverage: "complete",
    coverageReason: "The one scenario covers the captain's words.",
    effects: [],
    omitted: [],
    verdict: "inconclusive",
    reason: "The real model was not reached.",
    reviewer: "review",
    scenarioRevision: 1,
    stateRevision: 0,
    at,
  };
}

const realModel: ValidationScenario = {
  id: "real-model",
  source: "The captain's words: run a program end to end",
  importance: "required",
  action: "Run a program whose script asks the captain on a card, on a real model",
  expected: "The card shows and the program waits for the answer",
  adverse: "The program finishes without asking",
  environment: "This Mac with a signed-in model",
  signal: "The card on the stack",
  boundary: "A real model provider",
};
const approvedReason = "The only model sign-ins on this computer are the captain's own accounts.";

function proof(observedReason: string): LiveValidation {
  return {
    scenarioRevision: 1,
    scenarios: [realModel],
    plans: [{ revision: 1, reason: "First plan", scenarios: [realModel], at: 1_000 }],
    runs: [
      {
        kind: "run",
        id: "run-83c4f13",
        head: SECOND,
        scenarioRevision: 1,
        revision: 2,
        deviceId: null,
        at: 9_000,
        completion: "complete",
        verdict: "inconclusive",
        reason: "The real model was not reached.",
        observations: [
          {
            scenario: "real-model",
            result: "untested",
            live: false,
            actual: "Not run",
            evidence: [],
            standIns: ["The mock provider"],
            unproven: ["A real model's answer"],
            attempted: ["The mock provider run"],
            missingCapability: "A model sign-in the crew may use",
            reason: observedReason,
          },
        ],
        evidence: [],
      },
    ],
    reviews: [typedReview(FIRST, 1, [f5, f6], 1_900), typedReview(SECOND, 2, [f7], 12_900)],
    permissions: [
      {
        request: {
          kind: "gap",
          id: "gap-real-model",
          head: FIRST,
          scenario: "real-model",
          missingCapability: "A model sign-in the crew may use",
          reason: approvedReason,
          alternatives: [{ attempted: "The mock provider", result: "Proves no real model" }],
          remedies: ["The captain accepts the gap"],
        },
        scenario: realModel,
        state: "approved",
        at: 3_000,
        answer: { at: 3_500, action: "accept-gap", label: "Proceed without live proof" },
      },
    ],
  };
}

function inf812(observedReason: string) {
  let now = 1_000;
  const tasks = new TaskService({ db: freshDatabase(), now: () => now, strict: true });
  const tick = (ms = 1_000) => (now += ms);
  seedTask(tasks, { id: "builder", title: "Run programs as tasks", status: "idle" });
  seedTask(tasks, {
    id: "review",
    title: "Review: Run programs as tasks",
    status: "idle",
    parentId: "builder",
    shape: { kind: "review", kind_source: "host:review", basis: "builder" } as never,
  });
  seedDelivery(tasks, "builder", { liveValidation: proof(observedReason) });
  tick();
  tasks.turns.recordReport("review", { text: `verdict: findings\n${F5}\n${F6}\nrisk: medium` });
  seedDelivery(
    tasks,
    "builder",
    { reviewVerdict: "findings", reviewSha: FIRST },
    { kind: "review", text: "review findings", data: { reviewTaskId: "review" } },
  );
  tick();
  tasks.capture.recordCardRaised("builder", {
    cardId: "card-review-f5-f6",
    kind: "decision",
    title: "Review of INF-812: two findings",
  });
  tasks.capture.recordCardResolved("builder", {
    cardId: "card-review-f5-f6",
    title: "Review of INF-812: two findings",
    action: "decide",
    answers: [
      {
        name: "f5",
        values: ["keep"],
        labels: ["The program's branch is only the one its script returns"],
        changed: true,
      },
      {
        name: "f6",
        values: ["drop"],
        labels: ["Leave them out, and correct the comments that claim them"],
        changed: true,
      },
    ],
  });
  tick(10_000);
  tasks.turns.recordReport("review", { text: `verdict: findings\n${F7}\nrisk: medium` });
  seedDelivery(
    tasks,
    "builder",
    { reviewVerdict: "findings", reviewSha: SECOND },
    { kind: "review", text: "review findings", data: { reviewTaskId: "review" } },
  );
  const builder = tasks.get("builder");
  if (!builder) throw new Error("the builder was not seeded");
  return { tasks, builder };
}

describe("the review history the app writes (INF-993)", () => {
  it("keeps the captain's answers on earlier findings in a later round, oldest first", () => {
    const { tasks, builder } = inf812(approvedReason);
    const text = renderReviewHistory(reviewHistory(tasks, builder));
    const review = tasks.get("review")?.key;
    const order = [
      `Review ${review} returned findings at ${FIRST.slice(0, 7)}:`,
      F5,
      F6,
      'The captain chose "decide" on card "Review of INF-812: two findings"',
      `"The program's branch is only the one its script returns" (keep)`,
      `"Leave them out, and correct the comments that claim them" (drop)`,
      "The gap request gap-real-model",
      `Review ${review} returned findings at ${SECOND.slice(0, 7)}:`,
      F7,
    ].map((line) => text.indexOf(line));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain(
      `The gap request gap-real-model for scenario real-model at ${FIRST.slice(0, 7)} is approved ("Proceed without live proof"); it covers the latest run.`,
    );
  });

  // INF-1824 (the captain's answer to its question 6): an accepted gap is
  // kept by the check's id, so INF-812's reworded reason no longer ends it.
  it("says an approved gap still covers the latest run after its reason is reworded, as INF-812's was", () => {
    const { tasks, builder } = inf812(
      "The only model sign-ins here are the captain's own accounts.",
    );
    expect(renderReviewHistory(reviewHistory(tasks, builder))).toContain(
      'is approved ("Proceed without live proof"); it covers the latest run.',
    );
  });

  it("rides every reviewer turn's brief and the first mate's findings wake", () => {
    const { tasks, builder } = inf812(approvedReason);
    const history = reviewHistory(tasks, builder);
    const brief = renderReviewBrief(
      { goal: "Review", userWords: "run a program as a task" },
      "direct-pr",
      {
        builderTitle: builder.title,
        branch: "fm/task-builder",
        headSha: SECOND,
        builderReport: "Fixed F7.",
        changedFiles: ["src/core/programs/journal.ts"],
        history,
      },
    );
    expect(brief).toContain(`${renderReviewHistory(history)}\n`);
    const wake = renderWake({
      facts: {
        kind: "review-verdict",
        task: { id: "review", title: "Review: Run programs as tasks" },
        builder: { id: "builder", title: builder.title },
        crewmate: "crewmate 2",
        verdict: "findings",
        excerpt: `verdict: findings ${F7}`,
        cards: [],
        history,
      },
    });
    expect(wake).toContain(renderReviewHistory(history));
    expect(wake).toContain("Leave them out, and correct the comments that claim them");
  });

  it("keeps the rounds of a record written before reviews were typed, with no findings", () => {
    const { tasks } = inf812(approvedReason);
    seedDelivery(tasks, "builder", { liveValidation: { ...proof(approvedReason), reviews: [] } });
    const builder = tasks.get("builder");
    if (!builder) throw new Error("the builder was not seeded");
    const rounds = reviewHistory(tasks, builder).filter((entry) => entry.kind === "round");
    expect(rounds.map((round) => round.head)).toEqual([FIRST, SECOND]);
    expect(rounds.map((round) => round.findings)).toEqual([[], []]);
  });

  it("writes nothing before anything was decided", () => {
    const tasks = new TaskService({ db: freshDatabase(), now: () => 1, strict: true });
    const builder = seedTask(tasks, { id: "b", title: "New work", status: "idle" });
    expect(reviewHistory(tasks, builder)).toEqual([]);
    const brief = renderReviewBrief({ goal: "Review", userWords: "do it" }, "direct-pr", {
      builderTitle: "New work",
      branch: "fm/task-b",
      headSha: SECOND,
      builderReport: "Done.",
      changedFiles: [],
      history: [],
    });
    expect(brief).not.toContain(DECIDED_SO_FAR);
  });
});
