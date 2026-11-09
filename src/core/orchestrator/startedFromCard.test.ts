/**
 * The work a captain's reply under a card started is named in that card's
 * thread (INF-3071's plan, its second change; the captain picked "Yes, as a
 * second change that starts once this one merges"). INF-3060's finding 5:
 * three replies on crewmate cards (DOP-357, INF-3020, HEAD-6) went to the
 * first mate, and nothing in their threads said what became of them. The
 * case replays INF-3020's: the captain asked under a plan card for a
 * planning crewmate, its crewmate passed the words on and ended the card,
 * and the first mate then started the work naming that card.
 */

import { startedLineWords } from "@shared/threadLines";
import { describe, expect, it } from "vitest";
import {
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { firstmateSeat } from "../../../tests/helpers/firstmateTools";
import { writeStartedLine } from "./startedFromCard";

fakeCrewTimersEachTest();

const PLAN = {
  id: "program-starts-plan",
  title: "Plan: how a program starts its crewmates",
  body: "<p>I recommend a program start each crewmate through the first mate.</p>",
  asking: true,
  actions: [
    { id: "approve", label: "Approve and build", default: true },
    { id: "defer", label: "Save and defer" },
  ],
};

describe("the line naming the work a reply started", () => {
  it("lands under a crewmate's ended card, which stays on the stack", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Plan how a program starts its crewmates",
      intent: intentOf("plan how a program starts its crewmates"),
    });
    await tick();
    const spec = h.specs[0];
    if (!spec?.onCard || !spec.onCloseCard || !spec.onReply) throw new Error("no crewmate doors");
    await spec.onCard(PLAN);
    await endTurn(crewmate, taskId, "I put up the plan card.");
    const card = h.supervisor.cards.snapshot().find((entry) => entry.taskId === taskId);
    if (!card?.offerId) throw new Error("the plan card did not go up");
    h.supervisor.cards.seen(card.id, card.offerId);
    h.supervisor.cardActions.replyToCard(card.id, "start a planning crewmate for this");
    spec.onReply({
      cardId: card.id,
      text: "That is your first mate's job; I passed your words on.",
    });
    await spec.onCloseCard({ cardId: card.id, reason: "Your words went to the first mate." });

    const answer = writeStartedLine(h.supervisor.cards, card.id, { key: "INF-3022" }, false);

    expect(answer).toContain("INF-3022");
    const thread = h.supervisor.cards.thread(card.id).messages;
    expect(thread.at(-1)).toMatchObject({
      who: "host",
      text: startedLineWords("INF-3022", false),
    });
    h.supervisor.cards.flushBroadcast();
    expect(h.cards().find((entry) => entry.id === card.id)?.ended).toBeDefined();
  });

  it("writes nothing under a card the captain never replied under", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Plan how a program starts its crewmates",
      intent: intentOf("plan how a program starts its crewmates"),
    });
    await tick();
    await h.specs[0]?.onCard?.(PLAN);
    await endTurn(crewmate, taskId, "I put up the plan card.");
    const card = h.supervisor.cards.snapshot().find((entry) => entry.taskId === taskId);
    if (!card) throw new Error("the plan card did not go up");

    const answer = writeStartedLine(h.supervisor.cards, card.id, { key: "INF-3022" }, false);

    expect(answer).toContain("has not replied under it");
    expect(h.supervisor.cards.thread(card.id).messages).toEqual([]);
  });

  it("is written by the first mate's spawn_crewmate when it names the card, as filed for a later start", async () => {
    const { tools, supervisor, tasks } = await firstmateSeat();
    const tool = (name: string) => {
      const found = tools.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`the first mate has no ${name}`);
      return found;
    };
    await tool("emit_card").run({
      id: "meter-plan",
      title: "The meter reads kWh",
      body: "<p>The meter reads kilowatt-hours.</p>",
      actions: [
        { id: "build", label: "Approve and build", default: true },
        { id: "defer", label: "Save and defer" },
      ],
    } as never);
    const card = supervisor.cards.shown("card-fm-meter-plan");
    if (!card) throw new Error("the first mate's card did not go up");
    supervisor.cards.addMessage(card.id, "captain", "start someone on the meter now");

    const { text } = await tool("spawn_crewmate").run({
      title: "Read the meter in kWh",
      goal: "The meter reads kilowatt-hours.",
      user_words: "start someone on the meter now",
      // A later start, so nothing reaches the workspace this seat has none of.
      start_after: { at_time: "2099-01-01T09:00:00Z" },
      from_card: card.id,
    } as never);

    const started = tasks.list().find((task) => task.title === "Read the meter in kWh");
    if (!started) throw new Error("nothing was started");
    expect(text).toContain(`naming ${started.key}`);
    const line = supervisor.cards.thread(card.id).messages.at(-1);
    expect(line?.who).toBe("host");
    expect(line?.text).toBe(startedLineWords(started.key, true));
  });
});
