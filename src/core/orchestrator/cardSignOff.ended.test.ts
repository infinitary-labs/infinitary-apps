import type { Card } from "@shared/cards";
import { ENDED_CLOSE_LABEL } from "@shared/endedCard";
import { describe, expect, it } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { seedTask } from "../tasks/seedTask";
import { taskResultResponse } from "./answerTaskResponse";
import { type AskEnding, askEndingOf } from "./askEnding";
import type { CardService } from "./cardService";

/**
 * A crewmate's sign-off in front of the captain (INF-5561, the captain's
 * words: "even if it's considered a sign-off, the card should not just
 * disappear in front of me. it should show me the close card button"): the
 * answering note they had seen stays on the window's stack, ended with one
 * Close, as INF-3071 keeps a card its author closed. Same fixture as
 * cardSignOff.test.ts (real task record, card store and message ending, one
 * clock); the card and lines are the ones that vanished on INF-5555.
 */
function fixture() {
  const clock = { t: 1_000 };
  const f = setup(undefined, () => clock.t);
  const later = () => {
    clock.t += 1_000;
  };
  let ending: AskEnding | undefined;
  const cards: CardService = f.make(
    undefined,
    (card, response, action) => ending?.captainResponded(card, response, action),
    {
      closeAnsweredTask: (card, action, by) => {
        const record = card.taskId ? f.tasks.get(card.taskId) : undefined;
        if (!card.taskId || !taskResultResponse(card, record, action, by)) return false;
        f.tasks.close(card.taskId, { status: "done", reason: "answered", actor: "captain" });
        return true;
      },
    },
  );
  ending = askEndingOf(f.tasks, cards);
  seedTask(f.tasks, {
    id: "carried",
    title: "Check the legacy batch line carried over",
    status: "running",
    shape: { kind: "research", deliverable: "answer" },
  });
  later();
  f.tasks.capture.openAsk({ id: "m1", text: "did we carry those over?" });
  f.tasks.capture.attachAsk("m1", "carried", "tool:spawn_crewmate");
  f.tasks.capture.closeAsk("m1", "closed");
  later();
  // INF-5555's card: an answering note, no actions.
  const id = cards.emitCrewmateCard(
    "carried",
    {
      title: "All 11 held changes carried over; none merged yet, none lost",
      body: "<p>Yes, all 11 held changes were carried over.</p>",
      actions: [],
      answering: true,
    },
    "Check the legacy batch line carried over",
    "model",
  );
  cards.closeOut({ kind: "crewmate", taskId: "carried" }, "idle");
  later();
  const card = cards.get(id) as Card;
  const shown = cards.snapshot().find((entry) => entry.id === id);
  if (shown?.lifecycleId && shown.currentUpdateId) {
    cards.seenUpdate(id, shown.lifecycleId, shown.currentUpdateId);
  } else {
    cards.seen(id, card.offerId as string);
  }
  later();
  const asked = cards.addMessage(
    id,
    "captain",
    "ok, i don't need to do anything special, right?",
  ).id;
  later();
  /** What the window was last pushed: the stack the views draw. */
  const pushed = () => {
    cards.flushBroadcast();
    return f.pushes.at(-1) ?? [];
  };
  return { ...f, cards, card, asked, pushed };
}

const ANSWER =
  "Right, nothing special from you. The first mate steers the 11 owners to put up fresh merge cards.";

describe("a signed-off answer the captain had seen", () => {
  it("stays on the window's stack, ended with one Close, with the crewmate's answer in its thread", () => {
    const f = fixture();
    expect(f.pushed().some((entry) => entry.id === f.card.id)).toBe(true);
    const receipt = f.cards.replyFromCrewmate("carried", {
      cardId: f.card.id,
      text: ANSWER,
      answersMessage: f.asked,
      signsOff: true,
    });
    expect(receipt).toContain("signs the answer off");
    expect(f.tasks.get("carried")).toMatchObject({ status: "done", closedReason: "answered" });
    // The captain was looking at it: the window should still draw it with Close.
    const kept = f.pushed().find((entry) => entry.id === f.card.id);
    expect(kept, "the signed-off card left the window's stack").toBeDefined();
    expect(kept).toMatchObject({
      actions: [],
      noteDone: { label: ENDED_CLOSE_LABEL },
      ended: { by: "crewmate" },
    });
    expect(f.cards.thread(f.card.id).messages.map((m) => m.who)).toEqual(["captain", "crewmate"]);
  });
});
