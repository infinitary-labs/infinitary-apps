import { describe, expect, it } from "vitest";
import {
  ASKED_PICTURE_WORDS,
  askedInBubble,
  askedLabel,
  askedText,
  askedWords,
} from "./askedWords";

// INF-1610 and the captain's "the UI showing the captain's ask should be
// thoughtful about long messages": the line shows the message without added quotation marks (INF-1958), runs a long
// one's paragraphs together while folded and keeps them when opened.
const message =
  "did something change about how we order the cards in the stack?\n\nif it is a regression, please fix it,\nbut keep the minimize behavior as it is.";
const at = new Date(2026, 9, 1, 13, 3).getTime();
const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

describe("askedWords", () => {
  it("labels the line with when the captain sent the message", () => {
    expect(askedLabel({ at }, at + 60 * 60_000)).toBe(`You asked · ${time}`);
  });

  // INF-2326: the line says where the work came from - the captain's message,
  // a message aimed at that work alone, their click, or an automation named
  // without a bubble - and how many tasks away, or the nearest task by key.
  it("labels each kind of origin, with the tasks it sits behind", () => {
    const later = at + 60 * 60_000;
    expect(askedLabel({ at, through: 4 }, later)).toBe(`You asked · ${time} · through 4 tasks`);
    expect(askedLabel({ at, kind: "said", through: 1 }, later)).toBe(
      `You said · ${time} · through 1 task`,
    );
    expect(askedLabel({ at, kind: "chose" }, later)).toBe(`You chose · ${time}`);
    // INF-2744: a click names the card it was on.
    expect(askedLabel({ at, kind: "chose", card: "Merge the meter fix" }, later)).toBe(
      `You chose on “Merge the meter fix” · ${time}`,
    );
    expect(askedLabel({ at, kind: "automation" }, later)).toBe(`Run by an automation · ${time}`);
    expect(askedLabel({ at, kind: "from", key: "INF-2081" }, later)).toBe("From INF-2081");
  });

  it("keeps only the captain's own words in the bubble, a click's button words first", () => {
    expect(askedInBubble({ kind: "automation" })).toBe(false);
    expect(askedInBubble({ kind: "from" })).toBe(false);
    expect(askedInBubble({ kind: "chose" })).toBe(true);
    expect(
      askedText({ kind: "chose", choice: "File the picked improvements", text: "later" }),
    ).toBe("File the picked improvements · later");
    expect(askedText({ kind: "chose", choice: "Approve and build", text: "" })).toBe(
      "Approve and build",
    );
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
