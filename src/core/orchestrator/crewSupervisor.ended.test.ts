/**
 * A card its crewmate ends after the captain has seen it stays on the
 * stack, ended, until the captain closes it (INF-3071, the captain: "instead
 * of 'physically' dismissing the card straight away, we should consider
 * instead showing a message in the card thread saying the card was ended by
 * the agent and can be safely closed"). The case replays INF-3020's card:
 * the captain asked under a plan card for a planning crewmate, its crewmate
 * answered that this was the first mate's to start and ended the card in
 * the same turn, so the answer left the screen with the card. The record
 * still ends the card at once; only the stack the views draw keeps it.
 */

import { type Card, MERGE_CLOSES_WORDS, withMergeClosesLine } from "@shared/cards";
import { ENDED_CLOSE_LABEL, endedLineWords } from "@shared/endedCard";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { firstmateSeat } from "../../../tests/helpers/firstmateTools";
import { ENDED_STAYS, EndedCards } from "./endedCards";

fakeCrewTimersEachTest();

const TITLE = "Plan: how a program starts its crewmates";
const REASON = "Your words went to the first mate, who starts planning crewmates.";

/** The plan card, as its crewmate emitted it, and another card behind it. */
const PLAN = {
  id: "program-starts-plan",
  title: TITLE,
  body: "<p>I recommend a program start each crewmate through the first mate, so every start is on the record.</p>",
  asking: true,
  actions: [
    { id: "approve", label: "Approve and build", default: true },
    { id: "defer", label: "Save and defer" },
  ],
};

async function planUp() {
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
  // The card reaches the stage when its crewmate's turn ends.
  await endTurn(crewmate, taskId, "I put up the plan card.");
  const card = h.supervisor.cards.snapshot().find((entry) => entry.taskId === taskId);
  if (!card?.offerId) throw new Error("the plan card did not go up");
  return { ...h, crewmate, spec, taskId, card };
}

/** What the window was last pushed. */
function pushed(h: Awaited<ReturnType<typeof planUp>>) {
  h.supervisor.cards.flushBroadcast();
  return h.cards();
}

describe("a card its author ends after the captain saw it (INF-3071)", () => {
  it("stays on the views' stack, ended with its reason and one Close, while the record closes it", async () => {
    const h = await planUp();
    h.supervisor.cards.seen(h.card.id, h.card.offerId as string);
    h.supervisor.cardActions.replyToCard(h.card.id, "start a planning crewmate for this");
    h.spec.onReply?.({
      cardId: h.card.id,
      text: "That is your first mate's job; I passed your words on.",
    });

    const answer = await h.spec.onCloseCard?.({ cardId: h.card.id, reason: REASON });

    // The crewmate hears that the captain still sees it, with its reason.
    expect(answer).toContain(ENDED_STAYS);
    // The record closed it: every reader in the crew reads it as gone.
    expect(h.supervisor.cards.snapshot().some((entry) => entry.id === h.card.id)).toBe(false);
    expect(h.supervisor.cards.past(h.card.id)?.ending.how).toBe("author-withdrawal");
    // The window is pushed the card still, ended, with no choices and one Close.
    const ended = pushed(h).find((entry) => entry.id === h.card.id);
    expect(ended).toMatchObject({
      title: TITLE,
      actions: [],
      noteDone: { label: ENDED_CLOSE_LABEL, closesTask: false },
      corner: { label: ENDED_CLOSE_LABEL },
      ended: { by: "crewmate", reason: REASON, line: endedLineWords("crewmate", REASON) },
    });
    // Its thread keeps the exchange the captain was reading.
    expect(h.supervisor.cards.thread(h.card.id).messages.map((m) => m.who)).toEqual([
      "captain",
      "crewmate",
    ]);

    // The captain's reply under it still reaches the crewmate.
    expect(() => h.supervisor.cardActions.replyToCard(h.card.id, "thanks, close it")).not.toThrow();

    // Close takes it off the stack and tells nobody: the past card is the withdrawal.
    const before = h.ledgerFacts.length;
    h.supervisor.pressNote(h.card.id);
    await tick();
    expect(pushed(h).some((entry) => entry.id === h.card.id)).toBe(false);
    expect(h.ledgerFacts.length).toBe(before);
    expect(h.supervisor.cards.past(h.card.id)?.ending.how).toBe("author-withdrawal");
  });

  it("leaves at once when the captain never saw it", async () => {
    const h = await planUp();
    const answer = await h.spec.onCloseCard?.({ cardId: h.card.id, reason: REASON });
    expect(answer).not.toContain(ENDED_STAYS);
    expect(pushed(h).some((entry) => entry.id === h.card.id)).toBe(false);
  });

  it("is open again, and the minus puts it aside, when its crewmate puts it back up under the same id", async () => {
    const h = await planUp();
    h.supervisor.cards.seen(h.card.id, h.card.offerId as string);
    await h.spec.onCloseCard?.({ cardId: h.card.id, reason: REASON });
    await h.spec.onCard?.(PLAN);
    await endTurn(h.crewmate, h.taskId, "I put the plan card back up.");

    h.supervisor.close(h.card.id);
    expect(h.supervisor.cards.shown(h.card.id)?.minimized).toBe(true);
    const back = pushed(h).find((entry) => entry.id === h.card.id);
    expect(back?.ended).toBeUndefined();
    expect(back?.actions.map((action) => action.id).sort()).toEqual(["approve", "defer"]);
  });

  it("comes back ended after a restart, and the minus closes it", async () => {
    const h = await planUp();
    h.supervisor.cards.seen(h.card.id, h.card.offerId as string);
    await h.spec.onCloseCard?.({ cardId: h.card.id, reason: REASON });
    h.supervisor.disposeAll();

    const fresh = reboot({ paths: h.paths, db: h.db, workspace: h.workspace }, vi.fn());
    const restored = fresh.cards.ended.stack().find((entry) => entry.id === h.card.id);
    expect(restored?.ended?.line).toBe(endedLineWords("crewmate", REASON));
    expect(restored?.actions).toEqual([]);
    expect(fresh.cards.snapshot().some((entry) => entry.id === h.card.id)).toBe(false);

    fresh.close(h.card.id);
    expect(fresh.cards.ended.stack().some((entry) => entry.id === h.card.id)).toBe(false);
    fresh.disposeAll();
    const again = reboot({ paths: h.paths, db: h.db, workspace: h.workspace }, vi.fn());
    expect(again.cards.ended.stack().some((entry) => entry.id === h.card.id)).toBe(false);
    again.disposeAll();
  });

  it("stays when the first mate ends its own card you saw, naming your first mate", async () => {
    const { tools, supervisor } = await firstmateSeat();
    const tool = (name: string) => {
      const found = tools.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`the first mate has no ${name}`);
      return found;
    };
    const reason = "The crewmate on this task answered it under its own card.";
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
    if (!card?.offerId) throw new Error("the first mate's card did not go up");
    supervisor.cards.seen(card.id, card.offerId);

    const { text } = await tool("close_card").run({ card_id: card.id, reason } as never);

    expect(text).toContain(ENDED_STAYS);
    expect(supervisor.cards.snapshot().some((entry) => entry.id === card.id)).toBe(false);
    expect(supervisor.cards.ended.stack().find((entry) => entry.id === card.id)).toMatchObject({
      actions: [],
      noteDone: { label: ENDED_CLOSE_LABEL },
      ended: { by: "firstmate", reason, line: endedLineWords("firstmate", reason) },
    });
    supervisor.pressNote(card.id);
    expect(supervisor.cards.ended.stack().some((entry) => entry.id === card.id)).toBe(false);
  });

  // The proof read of INF-3071: an ended merge card kept "Merging closes this
  // task" under its facts, though nothing on it merges any more.
  it("draws an ended merge card without the line saying what its merge would do", () => {
    const facts = '<div class="inf-facts" data-facts><div data-fact="project">meterlab</div></div>';
    const merges = [
      { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
    ] as Card["actions"];
    const why = "<h3>Why</h3><p>The meter read early.</p>";
    const card = (id: string, strip: string | undefined): Card => ({
      id,
      taskId: "meter-fix",
      author: "crewmate",
      priority: 30,
      title: `The meter fix ${id}`,
      meta: "crewmate",
      body: `${why}${withMergeClosesLine(strip, merges)}`,
      actions: merges,
      status: "ready",
      createdAt: 1,
      seen: true,
    });
    const ended = new EndedCards(
      { markEnded: () => {}, listEnded: () => [] },
      { snapshot: () => [], scheduleBroadcast: () => {} },
    );
    for (const [id, strip] of [
      ["with-facts", facts],
      ["line-only", undefined],
    ] as const) {
      const shown = card(id, strip);
      expect(shown.body).toContain(MERGE_CLOSES_WORDS.closes);
      ended.hold(id, ended.end(shown, "crewmate", "Merged by hand.", 2));
    }
    const drawn = Object.fromEntries(ended.stack().map((entry) => [entry.id, entry.body]));
    expect(drawn["with-facts"]).toBe(`${why}${facts}`);
    expect(drawn["line-only"]).toBe(why);
  });
});
