import { onStage } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  syncCardId,
  tick,
} from "../../../tests/helpers/crewHarness";

/**
 * Intent: the approved /feedback plan's intake under a card - a reply that
 * starts with /feedback on a crewmate's card reaches the first mate as a
 * feedback request about that card, stays in the card's thread, and never
 * reaches the card's crewmate (docs/feedback.md, "Where it starts").
 */
fakeCrewTimersEachTest();

describe("a /feedback reply under a crewmate's card", () => {
  async function crewmateCard() {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const heard = vi.fn();
    harness.supervisor.setFirstmateHooks({
      notifyOp: vi.fn(),
      retryConverse: vi.fn(),
      converseAboutCard: heard,
    });
    await harness.supervisor.intake.commission({
      title: "Choose a release date",
      intent: intentOf("investigate and ask"),
    });
    await tick();
    const cardId =
      syncCardId(
        harness.specs[0]?.onCard?.({
          title: "Choose a release date",
          body: "<p>Friday leaves a day for the checks.</p>",
          actions: [
            { id: "friday", label: "Friday", default: true },
            { id: "monday", label: "Monday" },
          ],
        }),
      ) ?? "";
    harness.specs[0]?.onReport?.("Intent: the card is up for the captain.");
    crewmate.finishPrompt();
    await tick();
    const shown = harness.cards().find((card) => card.id === cardId);
    expect(shown && onStage(shown)).toBe(true);
    return { crewmate, harness, heard, cardId, prompts: crewmate.promptCalls.length };
  }

  it("goes to the first mate and stays in the thread, never to the crewmate", async () => {
    const { crewmate, harness, heard, cardId, prompts } = await crewmateCard();
    const typed = "/feedback the card's buttons jumped while I read it";
    const thread = harness.supervisor.cardActions.replyToCard(cardId, typed);
    await tick();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0]?.[0]).toBe(cardId);
    expect(thread.messages.at(-1)).toMatchObject({ who: "captain", text: typed });
    expect(crewmate.promptCalls).toHaveLength(prompts);
    expect(crewmate.steer).not.toHaveBeenCalled();
    // Nobody on the card owes the /feedback line an answer: the card does not
    // wait on its author, so no nudge or whose-turn sort asks the crewmate.
    expect(harness.supervisor.cards.owed(cardId)).toBe("none");
    expect(harness.cards().find((card) => card.id === cardId)?.awaiting).toBeUndefined();
  });

  it("leaves the question the crewmate already owes as the one it answers", async () => {
    const { harness, cardId } = await crewmateCard();
    const thread = harness.supervisor.cardActions.replyToCard(cardId, "why not Monday?");
    const asked = thread.messages.at(-1)?.id ?? 0;
    await tick();
    harness.supervisor.cardActions.replyToCard(cardId, "/feedback the card scrolled away");
    await tick();
    expect(harness.supervisor.cards.owed(cardId)).toBe("author");
    // The crewmate answers the question it was asked, not the /feedback line.
    expect(
      harness.specs[0]?.onReply?.({
        cardId,
        text: "Monday leaves no day for the checks.",
        answersMessage: asked,
      }),
    ).toContain(`It answers the captain's message ${asked}.`);
    // That answer ends the hold: nothing keeps nudging the crewmate.
    expect(harness.supervisor.cards.owed(cardId)).not.toBe("author");
  });

  it("leaves an ordinary reply with the card's crewmate", async () => {
    const { crewmate, heard, harness, cardId, prompts } = await crewmateCard();
    harness.supervisor.cardActions.replyToCard(cardId, "why not Monday?");
    await tick();
    expect(heard).not.toHaveBeenCalled();
    expect(crewmate.promptCalls.length).toBeGreaterThan(prompts);
    expect(harness.supervisor.cards.owed(cardId)).toBe("author");
  });
});
