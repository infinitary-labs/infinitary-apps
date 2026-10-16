import type { PanelFeedLine } from "@infinitary/contracts";
import { describe, expect, it } from "vitest";
import { feedKeysOf, leadingDrop, semanticKind } from "./feedRows";

/**
 * The Activity panel's row bookkeeping: which painted rows a push keeps,
 * which it drops, and how rows are told apart - the rules the streaming
 * probe (tests/e2e/rail-panels.spec.ts) counts on the real frame.
 */

const line = (at: number, text: string, kind: PanelFeedLine["kind"] = "info"): PanelFeedLine => ({
  at,
  kind,
  text,
});

describe("the feed's rows", () => {
  it("keys a line by what it says, and tells identical lines apart by their order", () => {
    expect(feedKeysOf([line(1, "a"), line(1, "a"), line(2, "b"), line(1, "a")])).toEqual([
      "1|info||a",
      "1|info||a#1",
      "2|info||b",
      "1|info||a#2",
    ]);
    expect(feedKeysOf([{ ...line(1, "a"), taskKey: "SCR-2" }])).toEqual(["1|info|SCR-2|a"]);
  });

  it("keeps every painted row while the window grows, and drops the oldest as it slides", () => {
    const painted = ["a", "b", "c"];
    expect(leadingDrop(painted, ["a", "b", "c", "d"])).toBe(0);
    expect(leadingDrop(painted, ["b", "c", "d"])).toBe(1);
    expect(leadingDrop(painted, ["c", "d", "e"])).toBe(2);
    // Nothing painted survives: the list is rebuilt.
    expect(leadingDrop(painted, ["x", "y"])).toBe(3);
    expect(leadingDrop([], ["a"])).toBe(0);
  });

  it("reads a line written before the semantic trail", () => {
    expect(semanticKind("spawn")).toBe("info");
    expect(semanticKind("report")).toBe("info");
    expect(semanticKind("done")).toBe("ok");
    expect(semanticKind("warn")).toBe("warn");
  });
});
