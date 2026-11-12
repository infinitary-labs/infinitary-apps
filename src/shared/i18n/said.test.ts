import { afterEach, describe, expect, it } from "vitest";
import { setCurrentLanguage } from "./current.ts";
import { formatTime } from "./format.ts";
import * as m from "./messages.generated.ts";
import {
  englishOf,
  said,
  saidLine,
  saidMark,
  saidPart,
  wordedLine,
  wordSaid,
  wordSaidBody,
} from "./said.ts";

// The approved plan (INF-3674, piece 3): the app's own lines are saved as
// facts and worded where they are shown, with the English beside each fact
// for a reader that words nothing itself; a line written before a language
// change follows it.
afterEach(() => setCurrentLanguage("en"));

describe("a saved fact", () => {
  it("is worded in the language of whoever shows it, its English saved beside it", () => {
    const line = saidLine(said("settleMergingChange", { change: "PR #61" }));
    expect(line.text).toBe("Merging PR #61");
    setCurrentLanguage("en-XA");
    expect(wordedLine(line)).toBe(m.settleMergingChange({ change: "PR #61" }));
    expect(wordedLine(line)).not.toBe(line.text);
    expect(englishOf(line.said)).toBe("Merging PR #61");
  });

  it("words a message it fills a blank with, and a time of day, where it is shown", () => {
    const time = Date.UTC(2026, 10, 11, 18, 5);
    const fact = said("settleCannotMerge", { problem: saidPart("mergedAt", { at: { time } }) });
    setCurrentLanguage("en-XA");
    const at = formatTime(time, { hour: "numeric", minute: "2-digit" });
    expect(wordSaid(fact)).toBe(m.settleCannotMerge({ problem: m.mergedAt({ at }) }));
  });

  it("shows its saved English when this catalog cannot word it", () => {
    setCurrentLanguage("en-XA");
    expect(wordedLine({ text: "Old words", said: { m: "noSuchMessage" } })).toBe("Old words");
    expect(wordedLine({ text: "Merging PR #61", said: { m: "settleMergingChange" } })).toBe(
      "Merging PR #61",
    );
    expect(wordedLine({ text: "Plain" })).toBe("Plain");
  });
});

describe("a run of the app's own words in a card body", () => {
  it("is worded in place, and the places after it move by as much as it grew", () => {
    const mark = saidMark(said("mergeContinues"));
    const saved = `<p>${mark}</p><p id="after">Kept</p>`;
    const after = saved.indexOf('<p id="after">');
    setCurrentLanguage("en-XA");
    const { body, at } = wordSaidBody(saved);
    expect(body).toContain(m.mergeContinues());
    expect(body.slice(at(after))).toBe('<p id="after">Kept</p>');
    expect(at(0)).toBe(0);
  });

  it("keeps a run whose fact it cannot read as it was saved", () => {
    const saved = `<span data-inf-said="{&quot;m&quot;:&quot;gone&quot;}">Old words</span>`;
    setCurrentLanguage("en-XA");
    expect(wordSaidBody(saved).body).toBe(saved);
  });
});
