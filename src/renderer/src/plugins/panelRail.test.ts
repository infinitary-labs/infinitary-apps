import { afterEach, describe, expect, it } from "vitest";
import { PANEL_UNRESPONSIVE_LINE } from "./frames/FrameMount";
import {
  frameRailAction,
  PANEL_SUMMARY_TEXT_MAX,
  panelRail,
  railProp,
  summaryLine,
} from "./panelRail";

/**
 * A panel on its rail, from its own code (docs/ui-plugins.md, "A panel's
 * cards", piece 5): what it says it holds, checked like any input, and
 * whether a panel whose presence is its code's is on its rail.
 */

afterEach(() => panelRail.forget("desk"));

describe("what a panel says on its rail", () => {
  it("keeps what it holds, at most three short parts, and clears it", () => {
    const rail = railProp("desk", true, false);
    expect(rail.collapsed).toBe(true);
    rail.summarize([{ text: "2 waiting", strong: true }, { text: "1 working" }]);
    expect(panelRail.get("desk").summary).toEqual([
      { text: "2 waiting", strong: true },
      { text: "1 working" },
    ]);
    expect(() => rail.summarize([{ text: "x".repeat(33) }])).toThrow("at most 3 parts");
    expect(() =>
      rail.summarize([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]),
    ).toThrow("at most 3 parts");
    rail.summarize(null);
    expect(panelRail.get("desk").summary).toBeNull();
  });

  it("keeps one line among the parts, with its lead and tone, and refuses a second", () => {
    const rail = railProp("desk", true, false);
    rail.summarize([
      { line: "reported: Steady as she goes.", lead: "SCR-1", tone: "info" },
      { text: "now" },
    ]);
    const summary = panelRail.get("desk").summary ?? [];
    expect(summaryLine(summary)).toEqual({
      line: "reported: Steady as she goes.",
      lead: "SCR-1",
      tone: "info",
    });
    expect(summaryLine([{ text: "now" }])).toBeNull();
    rail.summarize([{ line: "x".repeat(500) }]);
    expect(() => rail.summarize([{ line: "x".repeat(501) }])).toThrow("a line of at most 500");
    expect(() => rail.summarize([{ line: "a" }, { line: "b" }])).toThrow("a line");
    expect(() => rail.summarize([{ line: "a", tone: "loud" } as never])).toThrow("a line");
    expect(() => rail.summarize([{ line: "a", lead: "x".repeat(33) }])).toThrow("a line");
  });

  it("lets only a panel whose presence is its own code's decide whether it shows", async () => {
    expect(() => railProp("desk", false, false).show(false)).toThrow(
      '"presence": { "code": true }',
    );
    expect(panelRail.get("desk").shown).toBeUndefined();
    railProp("desk", false, true).show(true);
    expect(panelRail.get("desk").shown).toBe(true);
    await frameRailAction("desk", true)("rail.show", false);
    expect(panelRail.get("desk").shown).toBe(false);
    await expect(frameRailAction("desk", true)("rail.show", "yes")).rejects.toThrow(
      "true or false",
    );
    railProp("desk", false, true).show(false, "There are no tasks yet");
    expect(panelRail.get("desk")).toMatchObject({ shown: false, why: "There are no tasks yet" });
    await frameRailAction("desk", true)("rail.show", { shown: false, why: "Nothing here" });
    expect(panelRail.get("desk").why).toBe("Nothing here");
    await frameRailAction("desk", true)("rail.show", true);
    expect(panelRail.get("desk")).toMatchObject({ shown: true, why: null });
    await expect(
      frameRailAction("desk", true)("rail.show", { shown: false, why: "x".repeat(61) }),
    ).rejects.toThrow("at most 60 characters");
    await expect(frameRailAction("desk", true)("rail.other", 1)).rejects.toThrow(
      "is not one of a panel's rail actions",
    );
  });

  it("can say a stopped panel stopped, which fits the header and is not a count", () => {
    expect(PANEL_UNRESPONSIVE_LINE.length).toBeLessThanOrEqual(PANEL_SUMMARY_TEXT_MAX);
    panelRail.summarize("desk", [{ text: PANEL_UNRESPONSIVE_LINE }]);
    expect(panelRail.get("desk").summary).toEqual([{ text: PANEL_UNRESPONSIVE_LINE }]);
  });
});
