import { describe, expect, it } from "vitest";
import { foldForSearch } from "./searchText";

/** Task search's one fold (FI3-930): case, and typographic quotes, never matter. */
describe("foldForSearch", () => {
  const finds = (field: string, typed: string) =>
    foldForSearch(field).includes(foldForSearch(typed));

  it("reads every curly apostrophe and quote as the plain one, and ignores case", () => {
    expect(foldForSearch("What’s new in 0.1.28")).toBe("what's new in 0.1.28");
    expect(foldForSearch("‘a’ ‚b‛ ʼc")).toBe("'a' 'b' 'c");
    expect(foldForSearch("“Later” „x‟")).toBe('"later" "x"');
    expect(foldForSearch("Plain 'one' \"two\"")).toBe("plain 'one' \"two\"");
  });

  it("finds a curly title from straight typing, and a straight title from curly text", () => {
    expect(finds("What’s new in 0.1.28", "what's new")).toBe(true);
    expect(finds("Rename the “Later” group", '"later"')).toBe(true);
    expect(finds("Don't rename it", "Don’t")).toBe(true);
    // An apostrophe stays an apostrophe: it never matches a double quote.
    expect(finds("What’s new", 'what"s')).toBe(false);
  });
});
