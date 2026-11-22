import { describe, expect, it } from "vitest";
import { holdState } from "../../resources/runbooks/batches/panel/words";
import {
  type BatchHoldFacts,
  batchAnswerSchema,
  batchHoldState,
  batchRepairOf,
  crewHolds,
  keepsCommits,
  type MergeWays,
  mergeWayFor,
  type OpenBatch,
} from "./batches";
import { ownsBatches, type RepoView } from "./repos";

// Intent: the captain's approved plan for batches of their own, piece 1: a batch merges
// keeping one commit per change, by a rebase merge where the project allows it and a
// merge commit otherwise; a project that allows only squash merges is not offered them.

const EVERY_WAY: MergeWays = { squash: true, rebase: true, merge: true };

describe("the merge a batch takes, from what the project's host allows", () => {
  it("keeps one commit per change by a rebase merge where the project allows it", () => {
    expect(mergeWayFor(EVERY_WAY, 2)).toBe("rebase");
    expect(mergeWayFor({ squash: false, rebase: true, merge: false }, 3)).toBe("rebase");
  });

  it("takes a merge commit where rebase merges are turned off", () => {
    expect(mergeWayFor({ squash: true, rebase: false, merge: true }, 2)).toBe("merge");
  });

  it("finds no merge for several changes where only squash merges are allowed", () => {
    const squashOnly = { squash: true, rebase: false, merge: false };
    expect(mergeWayFor(squashOnly, 2)).toBeUndefined();
    expect(keepsCommits(squashOnly)).toBe(false);
    expect(keepsCommits(EVERY_WAY)).toBe(true);
    expect(keepsCommits({ squash: false, rebase: false, merge: true })).toBe(true);
  });

  it("merges a batch of one as that change's own pull request merges today, by squash", () => {
    expect(mergeWayFor(EVERY_WAY, 1)).toBe("squash");
    // Where squash merges are off, one commit is still one commit.
    expect(mergeWayFor({ squash: false, rebase: true, merge: true }, 1)).toBe("rebase");
    expect(mergeWayFor({ squash: false, rebase: false, merge: true }, 1)).toBe("merge");
  });
});

describe("a by-hand answer to a held batch", () => {
  const head = "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0";

  it("sends several changes back, each with its own reason", () => {
    const answer = batchAnswerSchema.parse({
      action: "send-back",
      head,
      changes: [
        { taskId: "t-parser", reason: "Its new parser fails the date tests the batch ran." },
        { taskId: "t-export", reason: " The export reads a column the parser renamed. " },
      ],
    });
    expect(answer).toMatchObject({
      changes: [
        { taskId: "t-parser" },
        { taskId: "t-export", reason: "The export reads a column the parser renamed." },
      ],
    });
  });

  it("refuses a send-back that names no change or gives no reason", () => {
    expect(batchAnswerSchema.safeParse({ action: "send-back", head, changes: [] }).success).toBe(
      false,
    );
    expect(
      batchAnswerSchema.safeParse({
        action: "send-back",
        head,
        changes: [{ taskId: "t-parser", reason: "   " }],
      }).success,
    ).toBe(false);
  });
});

describe("which batched projects get batches of the person's own", () => {
  const github: RepoView["host"] = { kind: "github", name: "github.com" };

  it("is every batched project on a host that takes batch pull requests", () => {
    expect(ownsBatches("queue-pr", { host: github })).toBe(true);
    expect(ownsBatches("queue-pr", { host: { kind: "gitlab", name: "gitlab.com" } })).toBe(true);
  });

  it("is never a direct or local project, nor a host with no pull requests to batch", () => {
    expect(ownsBatches("direct-pr", { host: github })).toBe(false);
    expect(ownsBatches("local-only", { host: github })).toBe(false);
    expect(ownsBatches("queue-pr", { host: { kind: "git", name: "git.example.com" } })).toBe(false);
  });
});

// Intent: the captain's ask that the Batches panel and Settings show a held batch's actual
// state "and don't mislead users into thinking they have to answer the hold": each hold says
// who has its next step, and only the captain's and no one's ask anything of the captain.
describe("who has a held batch's next step", () => {
  const working = { status: "active", waitingCardId: null };
  const facts = (over: Partial<BatchHoldFacts>): BatchHoldFacts => ({
    reason: "checks",
    repair: { own: false, fixing: false },
    awaitsFix: false,
    passed: false,
    task: working,
    ...over,
  });

  it("names the crew while a repair works, the captain while it waits on their card, and no one without one", () => {
    expect(batchHoldState(facts({}))).toBe("repairing");
    expect(batchHoldState(facts({ repair: { own: true, fixing: false } }))).toBe("own");
    expect(batchHoldState(facts({ repair: { own: false, fixing: true } }))).toBe("fixing");
    expect(batchHoldState(facts({ awaitsFix: true }))).toBe("sent-back");
    expect(batchHoldState(facts({ passed: true }))).toBe("passed");
    expect(
      batchHoldState(
        facts({ task: { ...working, waitingCardId: "c-1", waitingCardMerges: true } }),
      ),
    ).toBe("approve");
    expect(batchHoldState(facts({ task: { ...working, waitingCardId: "c-1" } }))).toBe("card");
    expect(batchHoldState(facts({ reason: "merge-way" }))).toBe("setting");
    expect(batchHoldState(facts({ reason: "rules" }))).toBe("rule");
    expect(batchHoldState(facts({ repair: null }))).toBe("none");
    // A repair whose task closed while the batch still holds leaves no one on it.
    expect(batchHoldState(facts({ task: { ...working, status: "done" } }))).toBe("none");
    // Before the board lists the repair's task, the recorded repair still has it.
    expect(batchHoldState(facts({ task: null }))).toBe("repairing");
  });

  it("asks nothing of the captain only while the crew has it", () => {
    const crew = ["repairing", "own", "fixing", "sent-back", "passed"] as const;
    const others = ["approve", "card", "setting", "rule", "none"] as const;
    for (const state of crew) expect(crewHolds(state)).toBe(true);
    for (const state of others) expect(crewHolds(state)).toBe(false);
  });

  it("is the same rule in the Batches panel, which keeps its own copy", () => {
    const tasks: BatchHoldFacts["task"][] = [
      null,
      working,
      { status: "done", waitingCardId: null },
      { ...working, waitingCardId: "c-1" },
      { ...working, waitingCardId: "c-1", waitingCardMerges: true },
    ];
    for (const reason of ["checks", "merge-way", "rules"] as const)
      for (const repair of [null, { own: false, fixing: false }, { own: true, fixing: true }])
        for (const awaitsFix of [false, true])
          for (const passed of [false, true])
            for (const task of tasks) {
              const each = { reason, repair, awaitsFix, passed, task };
              expect(holdState(each)).toBe(batchHoldState(each));
            }
  });

  it("finds the repair: the recorded task, or a held batch of one's own change", () => {
    const member = {
      taskId: "t-parser",
      branch: "inf/parser",
      head: "4444444444444444444444444444444444444444",
      title: "fix(parser): read dates with a time zone",
      body: "",
      at: 1_000,
      commit: "5555555555555555555555555555555555555555",
    };
    const head = "1111111111111111111111111111111111111111";
    const one: OpenBatch = {
      branch: "infinitary-batch/7c41",
      base: "0000000000000000000000000000000000000000",
      head,
      since: 1_000,
      members: [member],
      hold: { reason: "checks", head, checks: ["lint"], at: 2_000 },
    };
    expect(batchRepairOf(one, undefined)).toEqual({ taskId: "t-parser", own: true, fixing: false });
    expect(batchRepairOf({ ...one, repair: "t-repair" }, ["t-repair"])).toEqual({
      taskId: "t-repair",
      own: false,
      fixing: true,
    });
    // A batch of several names no repair until one is recorded, and a rule's hold none of its own.
    expect(
      batchRepairOf({ ...one, members: [member, { ...member, taskId: "t-export" }] }, undefined),
    ).toBeUndefined();
    expect(
      batchRepairOf({ ...one, hold: { reason: "rules", head, checks: [], at: 2_000 } }, undefined),
    ).toBeUndefined();
    const { hold: _hold, ...checking } = one;
    expect(batchRepairOf({ ...checking, repair: "t-repair" }, undefined)).toBeUndefined();
  });
});
