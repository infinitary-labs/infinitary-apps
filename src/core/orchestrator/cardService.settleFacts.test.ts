import { MERGE_ANYWAY_ACTION, SETTLE_FACTS_OPEN } from "@shared/cards";
import { MERGE_ANYWAY_WORDS } from "@shared/vocabulary";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { cardEmitter } from "./cardEmit";

/**
 * Guardrails for a merge card's facts (INF-2625's plan, cardService's row:
 * the settle-card facts become `settleCardFacts`, which the crew supervisor
 * later reuses): the merge's words and Merge anyway follow the record, not
 * an author's revision, and an emitter reads its open cards, oldest first,
 * with who put each up.
 */

const merge = {
  id: "merge",
  label: "Merge",
  default: true,
  effect: { kind: "settle" as const, mode: "merge" as const },
};

const completion = {
  id: "meter-fix",
  title: "The meter reads in watts",
  body: "<p>The meter now reads in watts.</p>",
  actions: [merge],
};

describe("a merge card's facts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the merge as the record says and offers Merge anyway beside it only while the host does", () => {
    const { tasks, cardStore, make } = setup();
    seedTask(tasks, { id: "t1", title: "Fix the meter", status: "idle" });
    let label: string | undefined = "Merge and close the task";
    let anyway = false;
    const facts = () =>
      `${SETTLE_FACTS_OPEN}<span>${tasks.get("t1")?.delivery?.ci ?? "pending"}</span></div>`;
    const cards = make(facts, undefined, {
      mergeLabel: () => label,
      mergeAnyway: () => anyway,
    });
    const id = cards.emitCrewmateCard("t1", completion, "Fix the meter", "model");
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    const labels = () => cards.get(id)?.actions.map((action) => [action.id, action.label]);
    // The body's refresh is cardService.test.ts's fact; this case owns the actions.
    expect(labels()).toEqual([["merge", "Merge and close the task"]]);

    anyway = true;
    seedDelivery(tasks, "t1", { ci: "red", ciAt: 1000 });
    expect(cards.get(id)?.actions).toEqual([
      {
        id: MERGE_ANYWAY_ACTION,
        label: MERGE_ANYWAY_WORDS,
        variant: "secondary",
        effect: { kind: "settle", mode: "merge" },
        passes: "checks",
      },
      { ...merge, label: "Merge and close the task", variant: "primary" },
    ]);
    // The saved row and the stage carry the same facts.
    expect(cardStore.get(id)?.actions).toEqual(cards.get(id)?.actions);
    expect(cards.snapshot().find((card) => card.id === id)?.actions).toEqual(
      cards.get(id)?.actions,
    );

    // A new label renames only the merge; Merge anyway keeps its words.
    label = "Merge";
    anyway = false;
    cards.refreshSettleFacts(["t1"]);
    expect(labels()).toEqual([["merge", "Merge"]]);

    // A refresh for another task leaves this card as it stands.
    anyway = true;
    cards.refreshSettleFacts(["other"]);
    expect(labels()).toEqual([["merge", "Merge"]]);
    cards.refreshSettleFacts();
    expect(labels()).toEqual([
      [MERGE_ANYWAY_ACTION, MERGE_ANYWAY_WORDS],
      ["merge", "Merge"],
    ]);
    cards.dispose();
  });

  it("finds the completion card an emit would revise, and none for another task's card or a note", () => {
    const { tasks, make } = setup();
    seedTask(tasks, { id: "t1", title: "Fix the meter", status: "idle" });
    seedTask(tasks, { id: "t2", title: "Fix the footer", status: "idle" });
    const cards = make();
    const id = cards.emitCrewmateCard("t1", completion, "Fix the meter", "model");
    cards.emitCrewmateCard(
      "t1",
      { id: "progress", title: "Halfway", body: "<p>Half done.</p>", actions: [] },
      "Fix the meter",
      "model",
    );
    expect(cards.openCompletionCard("t1", "meter-fix")?.id).toBe(id);
    expect(cards.openCompletionCard("t1", "progress")).toBeUndefined();
    expect(cards.openCompletionCard("t2", "meter-fix")).toBeUndefined();
    expect(cards.openCompletionCard("t1", undefined)).toBeUndefined();
    expect(cards.openCompletionCard("t1", "Not A Stable Id!")).toBeUndefined();
    cards.dispose();
  });

  it("lists a task's open cards oldest first, with who put each one up", () => {
    let clock = 1000;
    const { tasks, make } = setup(undefined, () => clock);
    seedTask(tasks, { id: "t1", title: "Fix the meter", status: "idle" });
    const cards = make();
    const crew = cards.emitCrewmateCard("t1", completion, "Fix the meter", "model");
    clock = 2000;
    const fm = cards.addFirstmateCard({
      title: "Ship the meter fix?",
      body: "<p>It is ready.</p>",
      actions: [{ id: "ship", label: "Ship", default: true }],
      taskId: "t1",
    });
    clock = 3000;
    cards.raiseHostCard({
      id: "card-host-t1",
      taskId: "t1",
      title: "Merging",
      meta: "Fix the meter",
      body: "<p>Merging now.</p>",
      actions: [],
    });
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "report");
    expect(
      cards.openCardDigests("t1").map(({ id, emitter, createdAt }) => [id, emitter, createdAt]),
    ).toEqual([
      [crew, "crewmate", 1000],
      [fm, "firstmate", 2000],
      ["card-host-t1", "host", 3000],
    ]);
    expect(cards.openCardsFor("t1").map((card) => card.id)).toEqual([crew, fm, "card-host-t1"]);
    expect(cards.shownCards("t1")).toEqual([
      { id: crew, word: expect.any(String), title: "The meter reads in watts" },
    ]);
    expect([crew, fm, "card-host-t1"].map((id) => cardEmitter(id, "t1"))).toEqual([
      "crewmate",
      "firstmate",
      "host",
    ]);
    cards.close(crew, { kind: "crewmate", taskId: "t1" }, "superseded");
    expect(cards.openCardsFor("t1").map((card) => card.id)).toEqual([fm, "card-host-t1"]);
    cards.dispose();
  });
});
