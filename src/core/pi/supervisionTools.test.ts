import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import {
  createFlagDuplicateTool,
  createFlagMissedEscalationTool,
  createSupervisionLogTool,
} from "./supervisionTools";
import { piToolOf } from "./toolSpec";

type AnyTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[] }>;
};

function harness(options: { captainTurn?: boolean } = {}) {
  const store = new DecisionStore(openInMemoryDatabase());
  let captainTurn = options.captainTurn ?? true;
  const tool = piToolOf(
    createFlagMissedEscalationTool({
      flag: (input) => store.flagMissedEscalation(input),
      isCaptainTurn: () => captainTurn,
    }),
  ) as unknown as AnyTool;
  return {
    store,
    name: tool.name,
    setCaptainTurn: (next: boolean) => {
      captainTurn = next;
    },
    flag: async (params: Record<string, unknown>) =>
      (await tool.execute("c1", params)).content[0]?.text ?? "",
    log: async (params: Record<string, unknown> = {}) => {
      const log = piToolOf(
        createSupervisionLogTool((limit) => store.recent(limit)),
      ) as unknown as AnyTool;
      return (await log.execute("c2", params)).content[0]?.text ?? "";
    },
  };
}

function routine(store: DecisionStore, taskId: string, summary: string): number {
  return store.recordSort({
    taskId,
    wake: `[fm-op] crewmate 1 reported on task ${taskId}: ${summary}`,
    verdict: "routine",
    summary,
  });
}

describe("flag_duplicate (interaction P1 WI-14)", () => {
  function duplicates(options: { captainTurn?: boolean } = {}) {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    const captainTurn = options.captainTurn ?? true;
    const card = (id: string, title: string, createdAt: number): Card => ({
      id,
      taskId: "t1",
      author: "crewmate",
      priority: 30,
      title,
      meta: "crewmate 1",
      body: `<p>${title}.</p>`,
      actions: [],
      status: "ready",
      createdAt,
    });
    store.upsert(card("card-t1-1", "Delivered means the crewmate stopped", 1));
    store.upsert(card("card-t1-2", "What delivered means", 2));
    const tool = piToolOf(
      createFlagDuplicateTool({
        flag: (input) => store.flagDuplicate(input),
        isCaptainTurn: () => captainTurn,
      }),
    ) as unknown as AnyTool;
    return {
      store,
      name: tool.name,
      flag: async (params: Record<string, unknown>) =>
        (await tool.execute("d1", params)).content[0]?.text ?? "",
    };
  }

  it("stamps the label write-once on the duplicate, naming the card it repeats", async () => {
    const t = duplicates();
    const text = await t.flag({
      card_id: "card-t1-2",
      duplicate_of: "card-t1-1",
      note: "this is the same as the card before it",
    });
    expect(text).toBe("Recorded card card-t1-2 as a duplicate of card-t1-1 and closed it.");
    expect(t.store.duplicateLabel("card-t1-2")).toMatchObject({
      duplicateOf: "card-t1-1",
      note: "this is the same as the card before it",
    });
    const again = await t.flag({ card_id: "card-t1-2", duplicate_of: "card-t1-1", note: "twice" });
    expect(again).toContain("already flagged");
    expect(t.store.duplicateLabel("card-t1-2")?.note).toBe(
      "this is the same as the card before it",
    );
  });

  it("refuses off a captain turn, so the agent cannot manufacture the label", async () => {
    const t = duplicates({ captainTurn: false });
    const text = await t.flag({ card_id: "card-t1-2", duplicate_of: "card-t1-1", note: "dupe" });
    expect(text).toContain("Refused");
    expect(t.store.duplicateLabel("card-t1-2")).toBeUndefined();
  });

  it("returns every refusal as text: empty note, self, unknown cards", async () => {
    const t = duplicates();
    expect(await t.flag({ card_id: "card-t1-2", duplicate_of: "card-t1-1", note: "  " })).toContain(
      "Refused",
    );
    expect(await t.flag({ card_id: "card-t1-2", duplicate_of: "card-t1-2", note: "x" })).toContain(
      "cannot duplicate itself",
    );
    expect(await t.flag({ card_id: "ghost", duplicate_of: "card-t1-1", note: "x" })).toContain(
      "No card ghost exists",
    );
    expect(await t.flag({ card_id: "card-t1-2", duplicate_of: "ghost", note: "x" })).toContain(
      "to be the original",
    );
    expect(t.store.duplicateLabel("card-t1-2")).toBeUndefined();
  });
});

describe("flag_missed_escalation", () => {
  it("writes the confirmed label on the task's newest routine outcome", async () => {
    const t = harness();
    const id = routine(t.store, "t1", "the branch was rewritten");

    const text = await t.flag({
      task_id: "t1",
      what_was_missed: "a force-push over my branch is always my call",
    });

    expect(text).toContain(`#${id}`);
    expect(text).toContain("Recorded");
    expect(t.store.recent(1)[0]).toMatchObject({
      id,
      missedEscalation: true,
      missedNote: "a force-push over my branch is always my call",
    });
    expect(typeof t.store.recent(1)[0]?.missedAt).toBe("number");
  });

  it("targets an explicit outcome id from supervision_log", async () => {
    const t = harness();
    const older = routine(t.store, "t1", "one test was skipped");
    routine(t.store, "t1", "work finished");

    const listing = await t.log();
    expect(listing).toContain(`#${older}`);

    await t.flag({ task_id: "t1", what_was_missed: "skips are never routine", outcome_id: older });
    expect(t.store.recent(10).find((row) => row.id === older)?.missedEscalation).toBe(true);
    expect(await t.log()).toContain("flagged as a missed escalation");
  });

  it("refuses off a captain turn, so the agent cannot manufacture the label", async () => {
    const t = harness({ captainTurn: false });
    routine(t.store, "t1", "quiet");

    const text = await t.flag({ task_id: "t1", what_was_missed: "I think this was a miss" });

    expect(text).toContain("Refused");
    expect(t.store.recent(1)[0]?.missedEscalation).toBeNull();
  });

  it("refuses an empty rationale and refuses an already-escalated verdict, as plain text", async () => {
    const t = harness();
    const escalated = t.store.recordSort({
      taskId: "t1",
      wake: "[fm-op] crewmate 1 reported on task t1: needs a decision",
      verdict: "captain",
      summary: "Land it?",
    });

    expect(await t.flag({ task_id: "t1", what_was_missed: "   " })).toContain("Refused");
    const text = await t.flag({
      task_id: "t1",
      what_was_missed: "you should have told me",
      outcome_id: escalated,
    });
    expect(text).toContain("already escalated");
    expect(t.store.recent(1)[0]?.missedEscalation).toBeNull();
  });

  it("says so instead of throwing when the task has no routine outcome", async () => {
    const t = harness();
    const text = await t.flag({ task_id: "ghost", what_was_missed: "nothing reached me" });
    expect(text).toContain("No routine fleet outcome");
    expect(t.store.recent(10)).toEqual([]);
  });

  it("keeps the first confirmation when the same miss is flagged twice", async () => {
    const t = harness();
    routine(t.store, "t1", "quiet");
    await t.flag({ task_id: "t1", what_was_missed: "first words" });
    const text = await t.flag({ task_id: "t1", what_was_missed: "second words" });
    expect(text).toContain("already flagged");
    expect(t.store.recent(1)[0]?.missedNote).toBe("first words");
  });
});
