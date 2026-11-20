import { describe, expect, it, vi } from "vitest";
import { fakeCrewmate, fakeCrewTimersEachTest, setup } from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { initOverflowDir } from "../overflow";
import {
  CORRECTION_CARD_BYTE_LIMIT,
  CORRECTION_EXCERPT_BYTE_LIMIT,
  CorrectionSources,
} from "./correctionSources";

/** Intent: the approved detector receives exact new words, source-time card
 * context and known scope, but no attachment contents or later revisions.
 * Real card/choice owners produce these readings; the enqueue spy observes
 * a data boundary and never simulates classifier quality. */
fakeCrewTimersEachTest();
function fixture() {
  const h = setup(fakeCrewmate());
  const enqueue = vi.fn();
  let allowed = true;
  const sources = new CorrectionSources({
    cards: h.cardStore,
    consumer: { enqueue },
    allowed: () => allowed,
    task: (id) => h.tasks.get(id),
    project: () => undefined,
  });
  h.supervisor.setFirstmateHooks({
    notifyOp: vi.fn(),
    retryConverse: vi.fn(),
    converseAboutCard: vi.fn(),
  });
  h.cardStore.onCaptainInteraction((id) => {
    const input = h.cardStore.captainInput(id);
    if (input) sources.card(input);
  });
  return {
    ...h,
    enqueue,
    sources,
    stop: () => {
      allowed = false;
    },
  };
}

describe("bounded correction source assembly", () => {
  it("uses the actual shown offer and exact caption, not attachments or a later body", () => {
    initOverflowDir(scratchDir("correction-source-files-"));
    const h = fixture();
    const id = h.supervisor.cards.addFirstmateCard({
      id: "source-preview",
      title: "The shown proposal",
      body: "<p>The proposal uses three reviews.</p>",
      actions: [{ id: "continue", label: "Continue", default: true }],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const shown = h.supervisor.cards.shown(id);
    if (!shown) throw new Error("The source fixture was not shown.");
    const caption = "For the next 3 reviews, keep that exact scope.";
    h.supervisor.cardActions.replyToCard(
      id,
      caption,
      undefined,
      {
        id: "source-gesture",
        offerId: shown.offerId,
        lifecycleId: shown.lifecycleId,
        questions: [],
      },
      undefined,
      [{ name: "example.txt", text: "Attached data must not enter the question." }],
    );
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    const observation = h.cardStore
      .observations(id)
      .findLast((entry) => entry.kind === "message_ref" && entry.actor === "captain");
    if (!observation) throw new Error("The actual source has no message reference.");
    const original = h.cardStore.captainInput(observation.id);
    if (!original) throw new Error("The actual source has no original caption.");
    h.supervisor.cards.addFirstmateCard({
      id,
      title: "A later proposal",
      body: "<p>The later version must not become earlier context.</p>",
      actions: [{ id: "continue", label: "Continue", default: true }],
      reply: "I revised the proposal.",
      answersMessage: h.supervisor.cards.thread(id).messages.at(-1)?.id,
    });
    h.enqueue.mockClear();
    h.sources.card(original);
    const [source, state] = h.enqueue.mock.calls[0] ?? [];
    expect(source).toMatchObject({ kind: "card", cardId: id });
    expect(state.facts.latest_captain_reply).toBe(caption);
    expect(JSON.parse(state.facts.addressed_card)).toEqual({
      title: shown.title,
      text: "The proposal uses three reviews.",
    });
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThanOrEqual(
      CORRECTION_EXCERPT_BYTE_LIMIT,
    );
  });

  it("keeps exact long latest words or skips rather than clipping their conditions", () => {
    const h = fixture();
    const paragraph = "For the next 3 reviews only, preserve all conditions. ";
    const latest = paragraph.repeat(
      Math.ceil(CORRECTION_EXCERPT_BYTE_LIMIT / Buffer.byteLength(paragraph)) + 1,
    );
    h.sources.composer({ key: "ask:long", kind: "composer", askId: "long", at: 1_000 }, latest, []);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("marks omitted figures and excerpts, and sends nothing while permission is off", () => {
    const h = fixture();
    const body = `<p>${"A published proposal. ".repeat(CORRECTION_CARD_BYTE_LIMIT)}</p><svg viewBox="0 0 50 50"><text>Drawing</text></svg>`;
    const id = h.supervisor.cards.addFirstmateCard({
      id: "long-card",
      title: "Review the drawing",
      body,
      actions: [{ id: "continue", label: "Continue", default: true }],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const shown = h.supervisor.cards.shown(id);
    if (!shown) throw new Error("The long card was not shown.");
    h.supervisor.cardActions.replyToCard(
      id,
      "Use that approach for the next 3 reviews.",
      undefined,
      {
        id: "drawing-gesture",
        offerId: shown.offerId,
        lifecycleId: shown.lifecycleId,
        questions: [],
      },
    );
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    const state = h.enqueue.mock.calls[0]?.[1];
    expect(state.facts.context_missing_or_omitted).toBe(true);
    expect(
      Buffer.byteLength(JSON.parse(state.facts.addressed_card).text, "utf8"),
    ).toBeLessThanOrEqual(CORRECTION_CARD_BYTE_LIMIT);
    h.stop();
    h.sources.composer(
      { key: "ask:off", kind: "composer", askId: "off", at: 1_000 },
      "Keep this for later work.",
      [],
    );
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
});
