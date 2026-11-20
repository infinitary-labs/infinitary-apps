import { describe, expect, it } from "vitest";
import { AUTOMATIC_EMOTE_WORDS, EMOTE_WORDS_MAX, emoteWords } from "./emotes";

/**
 * The words of the reply emotes the host fires itself (FI3-1077's plan, the
 * captain's Approve and build): each keeps the exact words the captain
 * approved, and each passes the one rule every emote's words pass, so the
 * reply line shows them as they are.
 */
const APPROVED: [string, string][] = [
  ["nod", "Got it"],
  ["tuck", "Noted"],
  ["tick", "All set"],
];

describe("the host's own reply emotes' words", () => {
  it("has exactly the approved words for every reply the host fires", () => {
    expect(Object.entries(AUTOMATIC_EMOTE_WORDS)).toEqual(APPROVED);
  });

  it.each(APPROVED)("keeps %s's words clean and within the limit", (_, text) => {
    expect(emoteWords(text)).toEqual({ kind: "words", text });
    expect([...text].length).toBeLessThanOrEqual(EMOTE_WORDS_MAX);
  });
});
