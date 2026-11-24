/**
 * A question the captain already answered, through a real CrewSupervisor
 * (tests/helpers/crewHarness.ts): the crewmate's own emit_card on a computer
 * with and without the `card-asks-again` change, and a builder's report
 * while its reviewer's Review finding card is up (INF-6523 parts 3 and 4).
 */
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
import type { CrewMachines } from "../placed/crewMachines";
import { bindTool } from "../session/tools";
import { seedTask } from "../tasks/seedTask";
import type { CrewmateSpec } from "./crewSession";

fakeCrewTimersEachTest();

// The incident's question: a reviewer asked it again under a new card id.
const QUESTION = {
  title: "Review of INF-6521: one question waits",
  body: `<p>The change keeps words the captain placed.</p><fieldset><legend>Keep the words?</legend><label><input type="radio" name="placed-kept-words" value="fix-now" data-inf-recommended> Fix the words now</label><label><input type="radio" name="placed-kept-words" value="leave"> Leave as built</label><label><input type="radio" name="placed-kept-words" value="other" data-inf-write-in> Something else</label></fieldset>`,
  actions: [
    { id: "send", label: "Send my answer", default: true },
    { id: "not-now", label: "Not now", declines: true as const },
  ],
};
const ANSWERS = [
  { name: "placed-kept-words", values: ["fix-now"], labels: ["Fix the words now"], changed: true },
];

/** A crewmate whose task runs on another computer that does or does not list the change. */
async function crewmateOnMini(listsAsksAgain: boolean) {
  const machines = {
    computers: () => ["mini"],
    ready: () => true,
    nameOf: () => "Mac mini",
    placeOf: () => ({ label: "Mac mini", where: "on Mac mini", who: "Mac mini" }),
    takesSharedCards: () => true,
    listsChange: (_machine: string, change: string) =>
      change === "card-asks-again" && listsAsksAgain,
    signInWait: () => undefined,
    signInsOf: async () => undefined,
    takesRepoless: () => true,
    served: async () => undefined,
    accountOf: () => undefined,
    cutOffOf: () => undefined,
  } as unknown as CrewMachines;
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, { machines });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Keep placed words",
    intent: intentOf("keep the words I placed"),
  });
  await tick();
  h.tasks.placement.setDevice(taskId, "mini");
  const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
  return { ...h, crewmate, taskId, emitCard };
}

describe("a question the captain already answered, through the crew", () => {
  it.each([
    [true, "refuses"],
    [false, "lets through"],
  ])("with the change listed %s, the home %s the repeat", async (lists) => {
    const h = await crewmateOnMini(lists);
    await h.emitCard.run({ ...QUESTION, id: "a" });
    const first = h.supervisor.cards.snapshot().find((card) => card.taskId === h.taskId) as Card;
    h.supervisor.cards.resolve(first, "send", "send", ANSWERS);
    const again = h.emitCard.run({ ...QUESTION, id: "b", title: "The wording question" });
    if (lists)
      await expect(again).rejects.toThrow(`already answered this question on card "${first.id}"`);
    else {
      await again;
      expect(h.supervisor.cards.snapshot().map((card) => card.title)).toContain(
        "The wording question",
      );
    }
  });

  it("names the reviewer's open Review finding card on the builder's report wake", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, ledger } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Keep placed words",
      intent: intentOf("keep the words I placed"),
    });
    await tick();
    seedTask(tasks, {
      id: "review-1",
      title: "Review",
      status: "idle",
      parentId: taskId,
      shape: { kind: "review", kind_source: "host:review", basis: taskId },
    });
    const card = supervisor.cards.emitCrewmateCard("review-1", { ...QUESTION, id: "a" }, "m");
    crewmate.emit({ type: "assistant_delta", taskId, text: "Pushed the fix." });
    crewmate.emit({ type: "turn_end", taskId, usage: { input: 10, output: 2 } });
    crewmate.finishPrompt();
    await tick();
    // The sort may keep this report quiet while a question card is up; its
    // record holds the wake either way.
    const report = ledger.find((text) => text.includes(`reported on task ${taskId}`));
    expect(report).toContain(
      `Its reviewer's Review finding card is on the captain's screen: ${card} "${QUESTION.title}". The app already handed those findings to the reviewer and sends the captain's choice to this task, so ask nobody for a card about them.`,
    );
  });
});
