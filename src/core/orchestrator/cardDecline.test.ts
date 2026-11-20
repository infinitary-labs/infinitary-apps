/**
 * The app's Decline on a decision (INF-3108, the captain's approved plan:
 * "Decline" on every open decision by the first mate or a crewmate, except
 * merge cards and decisions whose author marked its own way to say no;
 * kept as the captain's answer "no to every choice"; its author hears one
 * message; an answer task closes as answered unless the card continues).
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts): the crewmate emits a card through its own
 * tool, and the test reads the card as shown, the record and what the
 * crewmate heard.
 */
import { DECLINE_ACTION_ID, DECLINE_LABEL } from "@shared/cardLeave";
import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import { bindTool } from "../session/tools";
import { DECLINE_WORDS } from "./captainWakes";
import type { CrewmateSpec } from "./crewSession";

fakeCrewTimersEachTest();

/** A started crewmate task, read-only (an answer task) when asked. */
async function crewmateTask(readOnly: boolean) {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, {
    ...(readOnly
      ? {
          classifier: {
            classify: async () =>
              ({ kind: "research", source: "classifier:test", version: "kc1" }) as const,
          },
        }
      : {}),
  });
  const { taskId } = await h.supervisor.intake.commission(
    readOnly
      ? {
          title: "Compare the two launch checklists",
          intent: {
            ...intentOf("a read-only comparison of the short and full launch checklists"),
            constraints: [{ kind: "read-only" }],
          },
        }
      : {
          title: "Tidy the launch checklist",
          intent: intentOf("tidy the launch checklist"),
        },
  );
  await tick();
  const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
  /** The crewmate's turn ends: the card it emitted goes on the stage. */
  const endTurn = async () => {
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
  };
  const shown = () =>
    h.supervisor.cards.snapshot().find((card) => card.taskId === taskId) as Card | undefined;
  return { ...h, crewmate, taskId, emitCard, endTurn, shown };
}

const CHECKLIST_QUESTION = {
  title: "Which checklist should the launch use?",
  body: "<p>The short checklist from last month, or the full one the team wrote this week.</p>",
};

describe("the app's Decline", () => {
  it("sits on a crewmate's decision, and pressing it steers the crewmate once with no to every choice", async () => {
    const h = await crewmateTask(false);
    await h.emitCard.run({
      ...CHECKLIST_QUESTION,
      actions: [
        { id: "full", label: "Use the full checklist", default: true },
        { id: "short", label: "Use the short one" },
      ],
    });
    await h.endTurn();
    const card = h.shown() as Card;
    // The default sits last among the author's choices, and Decline after them.
    expect(card.actions.map((action) => action.id)).toEqual(["short", "full", DECLINE_ACTION_ID]);
    expect(card.actions.at(-1)).toMatchObject({
      label: DECLINE_LABEL,
      variant: "ghost",
      declines: true,
    });
    // The saved card never holds it: the app adds it to the card it shows.
    expect(h.cardStore.get(card.id)?.actions.map((action) => action.id)).toEqual(["short", "full"]);
    // The crewmate's turn has ended, so the captain's answer starts its next one.
    const prompts = h.crewmate.promptCalls.length;
    const steers = h.crewmate.steer.mock.calls.length;
    h.supervisor.cardActions.act(card.id, DECLINE_ACTION_ID);
    await tick();
    expect(h.shown()).toBeUndefined();
    expect(h.crewmate.steer.mock.calls.length).toBe(steers);
    const heard = h.crewmate.promptCalls.slice(prompts);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain(DECLINE_WORDS);
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", closedReason: null });
  });

  it("closes an answer task as answered", async () => {
    const h = await crewmateTask(true);
    expect(h.tasks.get(h.taskId)?.shape).toMatchObject({ deliverable: "answer" });
    await h.emitCard.run({
      ...CHECKLIST_QUESTION,
      actions: [
        { id: "full", label: "Use the full checklist", default: true },
        { id: "short", label: "Use the short one" },
      ],
    });
    await h.endTurn();
    h.supervisor.cardActions.act((h.shown() as Card).id, DECLINE_ACTION_ID);
    await tick();
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "done", closedReason: "answered" });
  });

  it("stays off a decision whose author marked its own way to say no", async () => {
    const h = await crewmateTask(false);
    await h.emitCard.run({
      ...CHECKLIST_QUESTION,
      actions: [
        { id: "full", label: "Use the full checklist", default: true },
        { id: "neither", label: "Neither for now", declines: true },
      ],
    });
    await h.endTurn();
    expect((h.shown() as Card).actions.map((action) => [action.id, action.declines])).toEqual([
      ["neither", true],
      ["full", undefined],
    ]);
  });

  it("stays off a merge card", async () => {
    const h = await crewmateTask(false);
    h.supervisor.cards.put({
      id: "card-merge-checklist",
      taskId: h.taskId,
      author: "crewmate",
      title: "Merge the tidier checklist",
      body: "<p>The checklist reads in one pass.</p>",
      meta: "crew",
      status: "ready",
      priority: 10,
      createdAt: Date.now(),
      actions: [
        {
          id: "merge",
          label: "Merge",
          default: true,
          effect: { kind: "merge", after: "close" },
        },
      ],
    });
    expect(h.shown()?.actions.map((action) => action.id)).toEqual(["merge"]);
  });
});
