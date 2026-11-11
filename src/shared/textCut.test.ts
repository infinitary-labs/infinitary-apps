// A user's report (INF-3734): a cut through the middle of an emoji left half
// of it behind and the first mate stopped answering. The fix asked for: cut
// text by whole characters wherever it gets truncated. These cases own what a
// cut keeps; firstmateContext.cuts.test.ts owns the turn that reads it.
import { describe, expect, it } from "vitest";
import { characterBoundary, cutText, cutTextEnd } from "./textCut";

// 🧪 is U+1F9EA, written as two UTF-16 code units (D83E DDEA).
const TEST_TUBE = "🧪";

describe("cutText", () => {
  it("keeps the first max code units when the cut falls between characters", () => {
    expect(cutText(`abc${TEST_TUBE}def`, 5)).toBe(`abc${TEST_TUBE}`);
    expect(cutText("abcdef", 3)).toBe("abc");
    expect(cutText("abc", 10)).toBe("abc");
  });

  it("leaves out an emoji the cut would split, rather than keep half of it", () => {
    const text = `abc${TEST_TUBE}def`;
    expect(text.slice(0, 4).charCodeAt(3).toString(16)).toBe("d83e");
    expect(cutText(text, 4)).toBe("abc");
  });
});

describe("cutTextEnd", () => {
  it("keeps the last max code units, leaving out an emoji the cut would split", () => {
    const text = `abc${TEST_TUBE}def`;
    expect(cutTextEnd(text, 5)).toBe(`${TEST_TUBE}def`);
    expect(text.slice(-4).charCodeAt(0).toString(16)).toBe("ddea");
    expect(cutTextEnd(text, 4)).toBe("def");
    expect(cutTextEnd(text, 10)).toBe(text);
  });
});

describe("characterBoundary", () => {
  it("moves an index between the halves of an emoji past it, and leaves any other index alone", () => {
    const text = `abc${TEST_TUBE}def`;
    expect(characterBoundary(text, 4)).toBe(5);
    expect(characterBoundary(text, 3)).toBe(3);
    expect(characterBoundary(text, 5)).toBe(5);
    expect(characterBoundary(text, text.length)).toBe(text.length);
  });
});
