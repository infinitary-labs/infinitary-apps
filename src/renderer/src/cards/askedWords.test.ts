import { describe, expect, it } from "vitest";
import { ASKED_PICTURE_WORDS, askedLabel, askedWords } from "./askedWords";

// INF-1610 and the captain's "the UI showing the captain's ask should be
// thoughtful about long messages": the line shows the message without added quotation marks (INF-1958), runs a long
// one's paragraphs together while folded and keeps them when opened.
const message =
  "did something change about how we order the cards in the stack?\n\nif it is a regression, please fix it,\nbut keep the minimize behavior as it is.";
const at = new Date(2026, 9, 1, 13, 3).getTime();
const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

describe("askedWords", () => {
  it("labels the line with when the captain sent the message", () => {
    expect(askedLabel(at, at + 60 * 60_000)).toBe(`You asked · ${time}`);
  });

  it("runs a long message together while folded and keeps its paragraphs when opened", () => {
    expect(askedWords(message, false)).toBe(
      "did something change about how we order the cards in the stack? if it is a regression, please fix it, but keep the minimize behavior as it is.",
    );
    expect(askedWords(`  ${message}\n`, true)).toBe(message);
  });

  it("says a message with only pictures is a picture", () => {
    expect(askedWords(" \n", false)).toBe(ASKED_PICTURE_WORDS);
  });
});
