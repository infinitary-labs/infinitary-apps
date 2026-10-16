import { describe, expect, it } from "vitest";
import { anchoredScrollTop, isMaximized, readingAnchor } from "./cardMaximize";

describe("which card is maximized", () => {
  const at = { entryId: "card-a", focusRequest: 3 };

  it("is the entry maximized, while it is shown", () => {
    expect(isMaximized(at, "card-a", 3)).toBe(true);
    expect(isMaximized(null, "card-a", 3)).toBe(false);
  });

  it("ends when another entry is shown: paging, a close, another card brought forward", () => {
    expect(isMaximized(at, "card-b", 3)).toBe(false);
    expect(isMaximized(at, undefined, 3)).toBe(false);
  });

  it("ends when the main message is asked for", () => {
    expect(isMaximized(at, "card-a", 4)).toBe(false);
  });
});

describe("the reading place across a change of width", () => {
  it("keeps the top of what was in sight at the same share of the body", () => {
    const anchor = readingAnchor({ top: 600, height: 400, scrollHeight: 2400 });
    expect(anchor).toEqual({ at: "fraction", fraction: 0.25 });
    // Wider, the body is shorter: the same share of it is in sight.
    expect(anchoredScrollTop(anchor, { height: 700, scrollHeight: 1600 })).toBe(400);
  });

  it("stays at the start, and at the end, of a body read to either", () => {
    const start = readingAnchor({ top: 0, height: 400, scrollHeight: 2400 });
    expect(anchoredScrollTop(start, { height: 700, scrollHeight: 1600 })).toBe(0);
    const end = readingAnchor({ top: 2000, height: 400, scrollHeight: 2400 });
    expect(end).toEqual({ at: "end" });
    expect(anchoredScrollTop(end, { height: 700, scrollHeight: 1600 })).toBe(900);
  });

  it("never goes past the end of a body that became shorter than its share", () => {
    const anchor = readingAnchor({ top: 1500, height: 400, scrollHeight: 2400 });
    expect(anchoredScrollTop(anchor, { height: 700, scrollHeight: 1000 })).toBe(300);
  });
});
