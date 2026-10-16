import { describe, expect, it } from "vitest";
import { READING_LINE_PX, readingScrollTop } from "./cardKeys";

/** A body 400 px tall over 2,000 px of content, scrolled to `top`. */
const at = (top: number) => ({ top, height: 400, scrollHeight: 2_000 });

describe("the shown card's reading keys", () => {
  it("move a line with the arrows and a screen with the page keys and Space", () => {
    expect(readingScrollTop("ArrowDown", false, at(100))).toBe(100 + READING_LINE_PX);
    expect(readingScrollTop("ArrowUp", false, at(100))).toBe(100 - READING_LINE_PX);
    expect(readingScrollTop("PageDown", false, at(100))).toBe(450);
    expect(readingScrollTop("PageUp", false, at(450))).toBe(100);
    expect(readingScrollTop(" ", false, at(100))).toBe(450);
    expect(readingScrollTop(" ", true, at(450))).toBe(100);
  });

  it("go to the ends with Home and End, and never past them", () => {
    expect(readingScrollTop("Home", false, at(700))).toBe(0);
    expect(readingScrollTop("End", false, at(0))).toBe(1_600);
    expect(readingScrollTop("ArrowUp", false, at(10))).toBe(0);
    expect(readingScrollTop("PageDown", false, at(1_500))).toBe(1_600);
    expect(readingScrollTop("End", false, { top: 0, height: 400, scrollHeight: 300 })).toBe(0);
  });

  it("leave every other key to the card", () => {
    expect(readingScrollTop("Enter", false, at(0))).toBeNull();
    expect(readingScrollTop("Tab", false, at(0))).toBeNull();
    expect(readingScrollTop("a", false, at(0))).toBeNull();
  });
});
