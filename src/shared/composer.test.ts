import { describe, expect, it } from "vitest";
import { CARD_REPLY_MAX_CHARS, CONVERSE_TEXT_MAX_CHARS } from "./cards";
import {
  COMPOSER_HINTS,
  COMPOSER_NOTICE_WORDS,
  composerCount,
  composeTurnText,
  fittingHint,
  limitBand,
  lineCount,
  normalizeLineEndings,
  PASTE_CHIP_CHARS,
  PASTE_CHIP_LINES,
  PASTED_TEXT_WORDS,
  shouldChip,
} from "./composer";

describe("composeTurnText", () => {
  it("drops leading blank lines and trailing whitespace", () => {
    expect(composeTurnText("\n  \n\t\nfix it  \n\n", [])).toBe("fix it");
  });

  it("keeps the first line's indentation and interior blank lines", () => {
    expect(composeTurnText("    indented()\n\n\nnext paragraph", [])).toBe(
      "    indented()\n\n\nnext paragraph",
    );
  });

  it("puts each paste after the typed words, after a blank line, verbatim", () => {
    const log = "  line one\n\n  line two\n";
    expect(composeTurnText("why does this fail?", [{ text: log }, { text: "second" }])).toBe(
      `why does this fail?\n\n${log}\n\nsecond`,
    );
    expect(composeTurnText("", [{ text: log }])).toBe(log);
  });

  it("treats whitespace alone as empty, typed or pasted", () => {
    expect(composeTurnText("  \n\t ", [])).toBe("");
    expect(composeTurnText(" ", [{ text: " \n " }])).toBe("");
  });
});

describe("shouldChip", () => {
  it("chips a paste over 20 lines", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
    expect(lineCount(lines(PASTE_CHIP_LINES))).toBe(PASTE_CHIP_LINES);
    expect(shouldChip(lines(PASTE_CHIP_LINES))).toBe(false);
    expect(shouldChip(lines(PASTE_CHIP_LINES + 1))).toBe(true);
  });

  it("chips a paste over 2,000 characters", () => {
    expect(shouldChip("x".repeat(PASTE_CHIP_CHARS))).toBe(false);
    expect(shouldChip("x".repeat(PASTE_CHIP_CHARS + 1))).toBe(true);
  });
});

describe("normalizeLineEndings", () => {
  it("turns CRLF and a lone CR into LF", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("limitBand", () => {
  it("counts from 80% of each limit and refuses past it, at the task prompt's and a reply's", () => {
    expect(limitBand(15_999, CONVERSE_TEXT_MAX_CHARS)).toBe("none");
    expect(limitBand(16_000, CONVERSE_TEXT_MAX_CHARS)).toBe("near");
    expect(limitBand(20_000, CONVERSE_TEXT_MAX_CHARS)).toBe("near");
    expect(limitBand(20_001, CONVERSE_TEXT_MAX_CHARS)).toBe("over");
    expect(limitBand(3_199, CARD_REPLY_MAX_CHARS)).toBe("none");
    expect(limitBand(3_200, CARD_REPLY_MAX_CHARS)).toBe("near");
    expect(limitBand(4_000, CARD_REPLY_MAX_CHARS)).toBe("near");
    expect(limitBand(4_001, CARD_REPLY_MAX_CHARS)).toBe("over");
  });
});

describe("fittingHint", () => {
  const full = "type, or press/hold right ⌥ to talk";
  const short = "press/hold right ⌥ to talk";
  const width = (form: string) => form.length * 8;

  it("shows the fullest form that fits the line, and the shortest when none does", () => {
    expect(fittingHint([full, short], 400, width)).toBe(full);
    expect(fittingHint([full, short], width(full), width)).toBe(full);
    expect(fittingHint([full, short], width(full) - 1, width)).toBe(short);
    expect(fittingHint([full, short], 10, width)).toBe(short);
    expect(fittingHint([full], 0, width)).toBe(full);
    expect(fittingHint([], 400, width)).toBeUndefined();
  });
});

describe("the composer's words", () => {
  it("counts in grouped digits against the limit", () => {
    expect(composerCount(16_240, 20_000)).toBe("16,240 / 20,000");
  });

  it("names the pasted-text chip by its line count", () => {
    expect(PASTED_TEXT_WORDS.meta(1)).toBe("file · 1 line · 0 KB");
    expect(PASTED_TEXT_WORDS.meta(1_240)).toBe("file · 1,240 lines · 0 KB");
    expect(PASTED_TEXT_WORDS.remove(240)).toBe("Remove file, 240 lines");
  });

  it("says over the limit what the refusal notice says", () => {
    expect(COMPOSER_HINTS["too-long"]).toEqual([{ words: COMPOSER_NOTICE_WORDS["too-long"] }]);
  });
});
