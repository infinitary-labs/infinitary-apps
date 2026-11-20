import { describe, expect, it } from "vitest";
import { cardAnswerLines, replyWithSettings, withoutSkipped } from "./cardAnswerLines";
import type { CardAnswer } from "./cards";

/**
 * A skip read as the Default it sent (INF-4425, INF-4422 direction A, with
 * the captain's choice to record a skip with its default). The answer is the
 * shape the frame bridge sends for a skippable radio question left untouched
 * whose author marked Wide.
 */
const SKIPPED: CardAnswer = {
  name: "width",
  values: ["wide"],
  labels: ["Wide"],
  changed: false,
  skipped: true,
};

describe("cardAnswerLines reads a skipped question as its Default", () => {
  it("names the option a skip sent", () => {
    expect(cardAnswerLines([SKIPPED])).toEqual([
      '- width: skipped, default "Wide" (wide), as proposed',
    ]);
  });

  it("reads an answer with nothing in it as no answer, and a pick of the Default as a pick", () => {
    expect(cardAnswerLines([{ name: "width", values: [], changed: true }])).toEqual([
      "- width: no answer, changed",
    ]);
    const { skipped: _skipped, ...picked } = SKIPPED;
    expect(cardAnswerLines([picked])).toEqual(['- width: "Wide" (wide), as proposed']);
  });

  it("words a skip the same way in a reply's settings", () => {
    expect(replyWithSettings("Go ahead", [SKIPPED])).toContain(
      '- width: skipped, default "Wide" (wide), as proposed',
    );
  });

  it("leaves the mark out for a reader from before it, keeping the Default it sent", () => {
    const { skipped: _skipped, ...picked } = SKIPPED;
    expect(withoutSkipped([SKIPPED])).toEqual([picked]);
  });
});
