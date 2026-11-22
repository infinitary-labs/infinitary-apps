import type { PanelFeedLine } from "@infinitary/contracts";
import { describe, expect, it } from "vitest";
import { feedKeysOf, focusedKeyOf, leadingDrop, linesInFocus, semanticKind } from "./feedRows";

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
    expect(leadingDrop(painted, ["x", "y"])).toBe(3);
    expect(leadingDrop([], ["a"])).toBe(0);
  });

  it("reads a line written before the semantic trail", () => {
    expect(semanticKind("spawn")).toBe("info");
    expect(semanticKind("report")).toBe("info");
    expect(semanticKind("done")).toBe("ok");
    expect(semanticKind("warn")).toBe("warn");
  });

  // The captain's answer to INF-1091's question 3: "Hide them while focus is on."
  it("under focus keeps the focused project's lines and those about no task, and hides the rest", () => {
    const feed: PanelFeedLine[] = [
      { at: 1, kind: "info", text: "Started", taskKey: "INF-412", event: "dispatched" },
      { at: 2, kind: "you", text: "Give the retry its own test" },
      {
        at: 3,
        kind: "info",
        text: "Reported: Opened the pricing page change",
        taskKey: "WEB-7",
        event: "report",
      },
      // A project whose key starts another's: IN is not INF.
      { at: 4, kind: "ok", text: "Merged", taskKey: "IN-3", event: "merged" },
      { at: 5, kind: "warn", text: "Your Claude account needs signing in again" },
      {
        at: 6,
        kind: "info",
        text: "Reported: Fixed the close button",
        taskKey: "INF-409",
        event: "report",
      },
    ];
    const projects = [
      { id: "repo-inf", key: "INF" },
      { id: "repo-in", key: "IN" },
      { id: "repo-web", key: "WEB" },
    ];
    expect(linesInFocus(feed, focusedKeyOf(projects, "repo-inf")).map((l) => l.at)).toEqual([
      1, 2, 5, 6,
    ]);
    expect(linesInFocus(feed, focusedKeyOf(projects, "repo-in")).map((l) => l.at)).toEqual([
      2, 4, 5,
    ]);
    // No focus, or a board not read yet, keeps every line.
    expect(linesInFocus(feed, focusedKeyOf(projects, null))).toBe(feed);
    expect(linesInFocus(feed, focusedKeyOf(null, "repo-inf"))).toBe(feed);
  });
});
