import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { CardStore } from "./cardStore";
import { openInMemoryDatabase } from "./db";
import { DecisionStore } from "./decisionStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "./inboxStore";

const actedCard: Card = {
  id: "card-acted",
  taskId: "t-act",
  author: "firstmate",
  priority: 30,
  title: "Land the PR?",
  meta: "firstmate",
  body: "CI is green.",
  actions: [
    { id: "land", label: "Land", variant: "primary" },
    { id: "later", label: "Later", variant: "ghost" },
  ],
  status: "ready",
  createdAt: 1000,
};

const dismissedCard: Card = {
  id: "card-dismissed",
  taskId: "t-dismiss",
  author: "firstmate",
  priority: 30,
  title: "Something happened",
  meta: "firstmate",
  body: "A wake the captain waved off.",
  actions: [
    { id: "look", label: "Look", variant: "primary" },
    { id: "dismiss", label: "Done", variant: "ghost" },
  ],
  status: "ready",
  createdAt: 1001,
};

describe("DecisionStore sort provenance (migration 15)", () => {
  it("writes card_id on the existing outcome+inbox transaction so the cards join labels acted vs dismissed", () => {
    const db = openInMemoryDatabase();
    const store = new DecisionStore(db);
    const inbox = new InboxStore(db);
    const cards = new CardStore(db);
    cards.upsert(actedCard);
    cards.upsert(dismissedCard);
    cards.resolve("card-acted", "land");
    cards.resolve("card-dismissed", "dismiss");

    store.transaction(() => {
      store.recordSort({
        taskId: "t-act",
        wake: "[fm-op] task t-act finished with a PR",
        verdict: "captain",
        summary: "The PR is green.",
        cardId: "card-acted",
      });
      inbox.enqueue(
        FIRSTMATE_RECIPIENT,
        "[fm-op] fleet event escalated to you (task t-act): The PR is green.",
      );
      store.recordSort({
        taskId: "t-dismiss",
        wake: "[fm-op] crewmate 1 reported on task t-dismiss: noise",
        verdict: "captain",
        summary: "A wake the captain can ignore.",
        cardId: "card-dismissed",
      });
      inbox.enqueue(
        FIRSTMATE_RECIPIENT,
        "[fm-op] fleet event escalated to you (task t-dismiss): A wake the captain can ignore.",
      );
    });

    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(2);

    const labelled = db
      .prepare(
        `SELECT o.verdict AS verdict, o.card_id AS card_id, c.chosen_action AS chosen_action
         FROM supervision_outcomes o
         JOIN cards c ON c.id = o.card_id
         ORDER BY o.id`,
      )
      .all() as { verdict: string; card_id: string; chosen_action: string | null }[];
    expect(labelled).toEqual([
      { verdict: "captain", card_id: "card-acted", chosen_action: "land" },
      { verdict: "captain", card_id: "card-dismissed", chosen_action: "dismiss" },
    ]);
    const acted = labelled.filter(
      (row) =>
        row.chosen_action != null && !["dismiss", "close", "later"].includes(row.chosen_action),
    );
    const dismissed = labelled.filter((row) => row.chosen_action === "dismiss");
    expect(acted.map((row) => row.card_id)).toEqual(["card-acted"]);
    expect(dismissed.map((row) => row.card_id)).toEqual(["card-dismissed"]);
  });
});

describe("DecisionStore missed-escalation label (migration 16)", () => {
  function seed() {
    return { store: new DecisionStore(openInMemoryDatabase()) };
  }

  it("labels the task's newest routine outcome and leaves the rest unlabelled", () => {
    const { store } = seed();
    store.recordSort({
      taskId: "t1",
      wake: "[fm-op] crewmate 1 reported on task t1: tests green",
      verdict: "routine",
      summary: "Tests are green.",
    });
    const newest = store.recordSort({
      taskId: "t1",
      wake: "[fm-op] crewmate 1 reported on task t1: pushed a force-push",
      verdict: "routine",
      summary: "The branch was rewritten.",
    });
    store.recordSort({
      taskId: "t2",
      wake: "[fm-op] crewmate 2 reported on task t2: idle",
      verdict: "routine",
      summary: "Nothing happened.",
    });

    const result = store.flagMissedEscalation({
      taskId: "t1",
      note: "a force-push over my branch is always my call",
      at: 5000,
    });
    expect(result.status).toBe("flagged");
    expect(result.status === "flagged" && result.outcome.id).toBe(newest);

    const rows = store.recent(10);
    const flagged = rows.filter((row) => row.missedEscalation === true);
    expect(flagged.map((row) => row.id)).toEqual([newest]);
    expect(flagged[0]).toMatchObject({
      missedNote: "a force-push over my branch is always my call",
      missedAt: 5000,
    });
    for (const row of rows.filter((row) => row.id !== newest)) {
      expect(row.missedEscalation).toBeNull();
      expect(row.missedNote).toBeNull();
      expect(row.missedAt).toBeNull();
    }
  });

  it("labels a named outcome id when the captain means an older wake", () => {
    const { store } = seed();
    const older = store.recordSort({
      taskId: "t1",
      wake: "[fm-op] crewmate 1 reported on task t1: skipped a test",
      verdict: "routine",
      summary: "One test was skipped.",
    });
    store.recordSort({
      taskId: "t1",
      wake: "[fm-op] crewmate 1 reported on task t1: done",
      verdict: "routine",
      summary: "Work finished.",
    });

    const result = store.flagMissedEscalation({
      taskId: "t1",
      note: "a skipped test is never routine",
      outcomeId: older,
    });
    expect(result.status === "flagged" && result.outcome.id).toBe(older);
    expect(store.recent(10).find((row) => row.id === older)?.missedNote).toBe(
      "a skipped test is never routine",
    );
  });

  it("refuses without writing when there is no routine outcome, on another task, on an escalated verdict, or twice", () => {
    const { store } = seed();
    const captain = store.recordSort({
      taskId: "t1",
      wake: "[fm-op] crewmate 1 reported on task t1: needs a decision",
      verdict: "captain",
      summary: "Land it?",
    });
    const other = store.recordSort({
      taskId: "t2",
      wake: "[fm-op] crewmate 2 reported on task t2: quiet",
      verdict: "routine",
      summary: "Quiet.",
    });

    expect(store.flagMissedEscalation({ taskId: "t1", note: "should have told me" })).toEqual({
      status: "no-outcome",
      taskId: "t1",
    });
    expect(store.flagMissedEscalation({ taskId: "t1", note: "x", outcomeId: captain }).status).toBe(
      "not-routine",
    );
    expect(store.flagMissedEscalation({ taskId: "t1", note: "x", outcomeId: other }).status).toBe(
      "other-task",
    );
    expect(store.flagMissedEscalation({ taskId: "t1", note: "x", outcomeId: 999 })).toEqual({
      status: "no-outcome",
      taskId: "t1",
    });
    expect(store.recent(10).every((row) => row.missedEscalation === null)).toBe(true);

    store.flagMissedEscalation({ taskId: "t2", note: "first words", at: 10 });
    const second = store.flagMissedEscalation({ taskId: "t2", note: "second words", at: 20 });
    expect(second.status).toBe("already-flagged");
    expect(store.recent(10).find((row) => row.id === other)).toMatchObject({
      missedNote: "first words",
      missedAt: 10,
    });
  });
});

describe("DecisionStore: one ledger for routing, account and sort decisions (P6)", () => {
  it("records each kind in one table and reads it back through the old names", () => {
    const db = openInMemoryDatabase();
    const store = new DecisionStore(db);
    store.recordRouting({
      taskId: "t1",
      provider: "openai-codex",
      model: "gpt-5.5",
      bucket: "high",
      rule: "R3",
      served: "medium",
      reasons: ["shape kind=change", "rule R3"],
    });
    store.recordAccount({
      taskId: "t1",
      provider: "openai-codex",
      accountId: "acct-1",
      reasons: ["headroom first"],
    });
    const facts = { kind: "idle-nudge" as const, thread: false };
    store.recordSort({
      taskId: "t1",
      wake: "finish, or say what blocks you",
      facts,
      verdict: "routine",
      summary: "nudged",
      rule: "idle-nudge",
      wakeKind: "agent",
    });

    expect(db.prepare("SELECT kind, task_id FROM decisions ORDER BY id").all()).toEqual([
      { kind: "routing", task_id: "t1" },
      { kind: "account", task_id: "t1" },
      { kind: "sort", task_id: "t1" },
    ]);
    expect(
      db
        .prepare(
          "SELECT task_id, provider, model, bucket, rule, served, reasons_json FROM routing_decisions",
        )
        .all(),
    ).toEqual([
      {
        task_id: "t1",
        provider: "openai-codex",
        model: "gpt-5.5",
        bucket: "high",
        rule: "R3",
        served: "medium",
        reasons_json: '["shape kind=change","rule R3"]',
      },
    ]);
    expect(
      db.prepare("SELECT task_id, provider, account_id, reasons_json FROM account_decisions").all(),
    ).toEqual([
      {
        task_id: "t1",
        provider: "openai-codex",
        account_id: "acct-1",
        reasons_json: '["headroom first"]',
      },
    ]);
    // A rule-sorted row reads its rule where the retired triage model's
    // name used to sit (R4.4), in the log and through the old name alike.
    expect(
      db
        .prepare("SELECT wake, verdict, model, wake_kind, facts_json FROM supervision_outcomes")
        .all(),
    ).toEqual([
      {
        wake: "finish, or say what blocks you",
        verdict: "routine",
        model: "rule:idle-nudge",
        wake_kind: "agent",
        facts_json: JSON.stringify(facts),
      },
    ]);
    expect(store.recent(1)[0]).toMatchObject({ model: "rule:idle-nudge", facts });
  });

  it("reads routing decisions in the order they were made, and only the chosen when asked", () => {
    const db = openInMemoryDatabase();
    const store = new DecisionStore(db);
    const route = (taskId: string, provider: string | null) =>
      store.recordRouting({
        taskId,
        provider,
        model: provider ? "m" : null,
        bucket: "medium",
        rule: "R5",
        served: provider ? "medium" : null,
        reasons: [],
      });
    route("t1", "openai-codex");
    route("t2", "xai");
    route("t1", null);

    expect(store.routing().map((row) => [row.taskId, row.provider])).toEqual([
      ["t1", "openai-codex"],
      ["t2", "xai"],
      ["t1", null],
    ]);
    expect(store.routing({ taskIds: ["t1"], chosen: true }).map((row) => row.provider)).toEqual([
      "openai-codex",
    ]);
    expect(store.routing({ taskIds: [] })).toEqual([]);
    expect(store.latestRouting("t1")?.provider).toBeNull();
    expect(store.latestRouting("t3")).toBeUndefined();
  });
});
