import { CARD_ANSWER_SKIPPED } from "@core/connection/cardCompatibility";
import type { CardAnswer } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { skippedAnswersFor } from "./cardAnswerSkipped";

/**
 * Intent: a skip recorded with its Default (INF-4425) must not make an older
 * home, which reads answers strictly, refuse the captain's click or reply.
 */
const SKIPPED: CardAnswer = {
  name: "width",
  values: ["wide"],
  labels: ["Wide"],
  changed: false,
  skipped: true,
};
const { skipped: _mark, ...UNMARKED } = SKIPPED;

describe("a view sends a skip's mark only to a home that lists it", () => {
  it("keeps the mark for a home with the change", () => {
    const args = ["card", "send", "chrome", { answers: [SKIPPED] }, {}];
    expect(skippedAnswersFor("inf:cards:act", args, [CARD_ANSWER_SKIPPED])).toBe(args);
  });

  it("leaves it out of a choice and a reply for an older home, keeping the Default", () => {
    const act = skippedAnswersFor(
      "inf:cards:act",
      ["card", "send", "chrome", { answers: [SKIPPED] }, {}],
      [],
    );
    expect(act[3]).toEqual({ answers: [UNMARKED] });
    const reply = skippedAnswersFor(
      "inf:cards:reply",
      ["card", { text: "Go", answers: [SKIPPED] }],
      null,
    );
    expect(reply[1]).toEqual({ text: "Go", answers: [UNMARKED] });
    const plain = ["card", "Go ahead"];
    expect(skippedAnswersFor("inf:cards:reply", plain, null)).toBe(plain);
  });
});
