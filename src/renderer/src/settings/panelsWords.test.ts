import { describe, expect, it } from "vitest";
import { PANEL_STATE_WORDS, panelGroups, panelRowState, rowStep } from "./panelsWords";

/**
 * Settings → Panels' rows (INF-2344, captain: "Both: the tab, and arranging
 * on the rails"; design skill components/core/PanelsSettings.prompt.md).
 */
describe("panelRowState", () => {
  const facts = {
    hidden: false,
    present: true as const,
    empty: false,
    gathered: false,
    collapsed: false,
  };

  it("puts the captain's Hide first, then why the rail does not draw it, then its collapse", () => {
    expect(panelRowState(facts)).toBe("shown");
    expect(panelRowState({ ...facts, collapsed: true })).toBe("collapsed");
    expect(panelRowState({ ...facts, collapsed: true, gathered: true })).toBe("more");
    expect(panelRowState({ ...facts, gathered: true, empty: true })).toBe("nothing");
    expect(panelRowState({ ...facts, empty: true, present: "automation" })).toBe("waits-for-rule");
    expect(panelRowState({ ...facts, present: "knowledge" })).toBe("waits-for-knowledge");
    expect(panelRowState({ ...facts, present: "automation", hidden: true })).toBe("hidden");
    expect(PANEL_STATE_WORDS[panelRowState({ ...facts, gathered: true })]).toBe("In the More row");
  });
});

describe("panelGroups", () => {
  it("lists the four groups in reading order, each with only the panels the tab shows", () => {
    const groups = panelGroups(
      {
        left: { top: ["scratchpad"], bottom: ["activity"] },
        right: { top: ["tokyo-clock", "gone-panel"], bottom: ["now", "knowledge"] },
      },
      (id) => id !== "gone-panel",
    );
    expect(groups).toEqual([
      { slot: { x: "left", y: "top" }, ids: ["scratchpad"] },
      { slot: { x: "left", y: "bottom" }, ids: ["activity"] },
      { slot: { x: "right", y: "top" }, ids: ["tokyo-clock"] },
      { slot: { x: "right", y: "bottom" }, ids: ["now", "knowledge"] },
    ]);
  });
});

describe("rowStep", () => {
  const rows = ["scratchpad", "activity", "tokyo-clock", "now"];

  it("moves focus one row with the arrows and to either end with Home and End, stopping at the ends", () => {
    expect(rowStep("ArrowDown", rows, "activity")).toBe("tokyo-clock");
    expect(rowStep("ArrowUp", rows, "activity")).toBe("scratchpad");
    expect(rowStep("ArrowUp", rows, "scratchpad")).toBeNull();
    expect(rowStep("ArrowDown", rows, "now")).toBeNull();
    expect(rowStep("Home", rows, "now")).toBe("scratchpad");
    expect(rowStep("End", rows, "scratchpad")).toBe("now");
    expect(rowStep("PageDown", rows, "scratchpad")).toBeNull();
  });
});
