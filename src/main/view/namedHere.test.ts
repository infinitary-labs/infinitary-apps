import type { FeedLine } from "@shared/feed";
import { describe, expect, it } from "vitest";
import { namedHere } from "./namedHere";

// The approved plan (INF-3674, piece 3): a line saved as a fact is worded
// where it is shown, but a line a computer that controls the first mate
// renamed this computer in keeps those words, since its fact would word
// this computer again.
describe("the first mate's own feed lines on a computer that controls it", () => {
  it("keep their fact unless naming the first mate's computer changed their words", () => {
    const said = { m: "settleMergingChange", a: { change: "PR #61" } };
    const lines: FeedLine[] = [
      { kind: "info", text: "Merging PR #61", said, saidHere: true, at: 1 },
      {
        kind: "info",
        text: "Merging on this computer",
        said: { m: "settleMerging" },
        saidHere: true,
        at: 2,
      },
    ];
    expect(namedHere("inf:feed:recent", lines, () => "Studio Mac")).toEqual([
      lines[0],
      { kind: "info", text: "Merging on Studio Mac", saidHere: true, at: 2 },
    ]);
  });
});
