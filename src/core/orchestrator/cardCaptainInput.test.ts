import { type Card, withAnythingElse } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import { fakeCrewmate, fakeCrewTimersEachTest, setup } from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { initOverflowDir } from "../overflow";
import type { CaptainCardInput } from "../storage/cardStore";

/**
 * Intent: the approved detector receives the original captain text through
 * the source owner, never attachment decoration, option labels or a later
 * card revision. These are ordinary disposable cards and submitted inputs;
 * the model question and its quality are not simulated here.
 */
fakeCrewTimersEachTest();

const proposal = {
  id: "caption-source",
  title: "Review the proposed approach",
  body: "<p>The current proposal applies to this project.</p>",
  actions: [
    { id: "continue", label: "Continue", default: true },
    { id: "stop", label: "Stop" },
  ],
};

function fixture() {
  const h = setup(fakeCrewmate());
  const heard = vi.fn();
  h.supervisor.setFirstmateHooks({
    notifyOp: vi.fn(),
    retryConverse: vi.fn(),
    converseAboutCard: heard,
  });
  const id = h.supervisor.cards.addFirstmateCard(proposal);
  h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
  const shown = h.supervisor.cards.shown(id) as Card;
  const inputs: CaptainCardInput[] = [];
  h.cardStore.onCaptainInteraction((source) => {
    const input = h.cardStore.captainInput(source);
    if (input) inputs.push(input);
  });
  return { ...h, heard, id, shown, inputs };
}

function submission(card: Card, id: string) {
  return { id, offerId: card.offerId, lifecycleId: card.lifecycleId, questions: [] };
}

describe("new captain card input", () => {
  it("keeps the original caption separate while its author still receives the attached example", () => {
    initOverflowDir(scratchDir("captain-caption-overflow-"));
    const h = fixture();
    const caption = "For later work here, show the exact wording before keeping it.";
    const attached = "The attached example must not become a lasting instruction.";
    const before = h.tasks.list().length;
    const thread = h.supervisor.cardActions.replyToCard(
      h.id,
      caption,
      undefined,
      submission(h.shown, "gesture-caption-file"),
      undefined,
      [{ name: "example.txt", text: attached }],
    );
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]).toMatchObject({
      text: caption,
      offerId: h.shown.offerId,
      contextMissing: false,
    });
    expect(h.heard).toHaveBeenCalledTimes(1);
    expect(h.heard.mock.calls[0]?.[1]).toContain(attached);
    expect(thread.messages.at(-1)?.text).toContain(attached);
    expect(h.tasks.list()).toHaveLength(before);
    const source = h.cardStore.observationById(h.inputs[0]?.sourceId ?? "");
    // Input words remain in their thread owner, not copied into factual observations.
    expect(JSON.stringify(source)).not.toContain(caption);
    expect(JSON.stringify(source)).not.toContain(attached);
  });

  it("admits written words with a choice but never the bare button label or later thread lines", () => {
    const bare = fixture();
    bare.supervisor.cardActions.act(
      bare.id,
      "continue",
      "chrome",
      undefined,
      submission(bare.shown, "gesture-bare"),
    );
    expect(bare.inputs).toEqual([]);

    const h = fixture();
    const words = "For the remaining reviews, keep the proposed scope unchanged.";
    const beforeMessage = h.cardStore.latestMessageId(h.id);
    const value = { answers: withAnythingElse([], words) };
    h.supervisor.cardActions.act(
      h.id,
      "continue",
      "chrome",
      value,
      submission(h.shown, "gesture-written"),
    );
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]).toMatchObject({
      text: words,
      kind: "card-choice",
      precedingMessageId: beforeMessage,
    });
    h.supervisor.cards.addMessage(h.id, "firstmate", "A later answer is not earlier context.");
    expect(h.cardStore.captainInput(h.inputs[0]?.sourceId ?? "")?.precedingMessageId).toBe(
      beforeMessage,
    );
  });

  it("retains the source offer rather than substituting the author's revised head", () => {
    const h = fixture();
    h.supervisor.cardActions.replyToCard(
      h.id,
      "Use this approach for later reviews.",
      undefined,
      submission(h.shown, "gesture-old-offer"),
    );
    const source = h.inputs[0];
    expect(source).toBeDefined();
    h.supervisor.cards.addFirstmateCard({
      ...proposal,
      id: h.id,
      body: "<p>A later, different proposal.</p>",
      reply: "I updated the proposal on the card.",
      answersMessage: h.supervisor.cards.thread(h.id).messages.at(-1)?.id,
    });
    expect(h.cardStore.offer(h.id, source?.offerId ?? "")?.payload.body).toBe(proposal.body);
    expect(h.cardStore.get(h.id)?.body).not.toBe(proposal.body);
  });

  it("does not reconstruct an older caption or reject a new reply when an ancillary observer fails", () => {
    const h = fixture();
    h.supervisor.cards.addMessage(
      h.id,
      "captain",
      "Legacy text with unknown attachment provenance.",
    );
    expect(h.inputs).toEqual([]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.cardStore.onCaptainInteraction(() => {
      throw new Error("Ancillary storage unavailable");
    });
    try {
      const caption = "Only apply this correction in this project.";
      expect(() => h.supervisor.cardActions.replyToCard(h.id, caption)).not.toThrow();
      expect(h.inputs.at(-1)?.text).toBe(caption);
      expect(h.heard).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
