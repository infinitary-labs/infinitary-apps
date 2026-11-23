/**
 * The words of rows an earlier build saved in the inbox, of kinds the host no
 * longer queues (INF-2625's plan, the wakes row: "saved rows of removed kinds
 * are frozen"). A lane can still hold such a row after an update, and its
 * drain serves it; these rows are written to the column as JSON, the way the
 * build that queued them wrote them, so they hold whatever `WakeFacts` declares.
 */
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { drainWakes } from "./wakes";

/** A first mate lane holding one saved payload, drained as the next turn serves it. */
function drained(payload: object): string | undefined {
  const db = openInMemoryDatabase();
  db.prepare(
    "INSERT INTO inbox (recipient, payload, created_at, ref, content_hash, origin) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(FIRSTMATE_RECIPIENT, JSON.stringify(payload), 1_000, "479823ee", "h", "crewmate-report");
  return drainWakes(new InboxStore(db).pending(FIRSTMATE_RECIPIENT, 2_000))[0]?.body;
}

const TASK = { id: "479823ee", title: "Restructure the wakes file" };

const RETIRED_COUNT_HOLD =
  '[fm-op] An earlier version recorded a count hold on task 479823ee "Restructure the wakes file". Repair, re-review and rerun count holds are retired. This record places no hold and grants no authorization. Read current facts and judge the next action from your delivery guidance.';

/** The ways a saved count hold carried, which its words no longer name. */
const SAVED_WAYS = [
  {
    label: "Retry with the captain's guidance",
    tool: "steer_crewmate",
    args: { task_id: TASK.id },
  },
];

describe("saved rows of wakes the host no longer queues", () => {
  it("serves a saved CI cap as a retired count hold", () => {
    expect(
      drained({
        v: 1,
        facts: { kind: "ci-cap", task: TASK, rounds: 3, cap: 3, head: "4be7c1d90a" },
        ways: SAVED_WAYS,
      }),
    ).toBe(RETIRED_COUNT_HOLD);
  });

  it("serves a saved review cap with the findings it rode, and no next step", () => {
    expect(
      drained({
        v: 1,
        facts: {
          kind: "review-cap",
          owner: "captain",
          task: TASK,
          rounds: 3,
          cap: 2,
          findings: {
            kind: "review-verdict",
            task: { id: "b9299a73", title: "Review: Restructure the wakes file" },
            builder: TASK,
            crewmate: "crewmate 62",
            verdict: "findings",
            excerpt: "One wake kind lost its trailing sentence.",
            findings: [
              "F1 error src/core/orchestrator/wakes.ts:2147 the outage words lost a clause",
            ],
            cards: [{ id: "card-r", word: "decision", title: "Review of INF-2696" }],
          },
        },
        ways: SAVED_WAYS,
      }),
    ).toBe(
      `${RETIRED_COUNT_HOLD} [fm-op] crewmate 62 reported on review task b9299a73 "Review: Restructure the wakes file" - the review of task 479823ee "Restructure the wakes file" - with verdict findings: One wake kind lost its trailing sentence.\nFindings:\n- F1 error src/core/orchestrator/wakes.ts:2147 the outage words lost a clause Its card on the captain's screen: card-r (decision) "Review of INF-2696".`,
    );
  });

  // A saved review cap with its findings as prose: wakes.test.ts's
  // "drains queued review findings without reviving their retired cap".
  it("serves a saved review cap that carried neither", () => {
    expect(
      drained({
        v: 1,
        facts: { kind: "review-cap", owner: "firstmate", task: TASK, rounds: 3, cap: 2 },
      }),
    ).toBe(RETIRED_COUNT_HOLD);
  });

  it("serves a saved idle reminder about a count hold as a retired count hold", () => {
    for (const held of ["ci-cap", "review-cap"]) {
      expect(
        drained({
          v: 1,
          facts: {
            kind: "idle-owed",
            held,
            task: TASK,
            reason: "the round cap",
            idleMs: 1_200_000,
            wakes: 2,
          },
          ways: SAVED_WAYS,
        }),
      ).toBe(RETIRED_COUNT_HOLD);
    }
  });

  it("serves a saved passing default-branch run's steer", () => {
    expect(
      drained({
        v: 1,
        facts: {
          kind: "main-check-passed",
          check: "typecheck-lint-build",
          sha: "7820fd065a1b2c3d",
        },
      }),
    ).toBe(
      "The default branch's own run of typecheck-lint-build passed at 7820fd0. Bring your change up to date and read the checks again.",
    );
  });
});
