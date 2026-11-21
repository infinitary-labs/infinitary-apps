import { describe, expect, it } from "vitest";
import { CREATE_PANEL_SLOT_ID } from "./createPanelSlot";
import {
  type ArrangedPanel,
  arrangePanels,
  defaultArrangement,
  knownPanels,
  movedPanels,
  movePanel,
  pickToEdge,
  stepPanel,
} from "./panelArrangement";
import type { PersonalExtensionView } from "./personal/manifest";
import type { Layout, PanelArrangement } from "./preferences";
import { BUILTIN_SURFACES } from "./surfaces";

/**
 * The one saved layout of the rails (INF-2344, captain: "Both: the tab, and
 * arranging on the rails"): every panel's slot and its place in it. The
 * panels here are the app's own, read from their folders, and three of the
 * captain's own as the core serves them.
 */
const APP: ArrangedPanel[] = BUILTIN_SURFACES.map((surface) => ({
  id: surface.id,
  preferred: surface.preferredPlacement,
  order: surface.order,
}));
const yours = (id: string, x: "left" | "right", y: "top" | "bottom", order = 100) => ({
  id,
  preferred: { x, y },
  order,
});
const PANELS: ArrangedPanel[] = [
  ...APP,
  yours("tokyo-clock", "right", "top"),
  yours("open-prs", "right", "top", 50),
  yours("scratchpad", "left", "top"),
];

function layout(extra: Partial<Layout> = {}): Layout {
  return { collapsedPanels: {}, hiddenPanels: {}, placements: {}, ...extra };
}

function arrangement(
  leftTop: string[],
  leftBottom: string[],
  rightTop: string[],
  rightBottom: string[],
): PanelArrangement {
  return {
    left: { top: leftTop, bottom: leftBottom },
    right: { top: rightTop, bottom: rightBottom },
  };
}

describe("arrangePanels", () => {
  it("writes the arrangement once from where the rails drew each panel, so nothing moves", () => {
    // A placement the captain chose before decides the slot, and the newest
    // More pick leads at its slot's edge: the top of a top group, the
    // bottom of a bottom group. The rest keep their declared order, ties on id.
    const before = layout({
      placements: { scratchpad: { x: "right", y: "top" } },
      panelOrder: ["tokyo-clock", "knowledge"],
    });
    expect(arrangePanels(before, PANELS)).toEqual(
      arrangement(
        [],
        ["activity"],
        ["tokyo-clock", "open-prs", "scratchpad"],
        ["now", "batches-panel", "automation", "knowledge"],
      ),
    );
  });

  it("lands a new panel at its slot's middle and keeps every listed panel where it is", () => {
    const saved = arrangement(
      ["scratchpad"],
      ["activity"],
      ["open-prs"],
      ["knowledge", "now", "automation"],
    );
    const next = arrangePanels(layout({ arrangement: saved }), [
      ...PANELS,
      yours("weather", "right", "bottom"),
    ]);
    // tokyo-clock joins the right rail's top group at its foot; weather the
    // bottom group at its head; a listed panel never follows its manifest.
    expect(next).toEqual(
      arrangement(
        ["scratchpad"],
        ["activity"],
        ["open-prs", "tokyo-clock"],
        ["batches-panel", "weather", "knowledge", "now", "automation"],
      ),
    );
  });

  it("keeps the place of a panel the app no longer serves, and a panel listed twice at its first place", () => {
    const saved = arrangement(["scratchpad", "old-panel"], ["activity"], ["scratchpad"], ["now"]);
    expect(arrangePanels(layout({ arrangement: saved }), APP)).toEqual(
      arrangement(
        ["scratchpad", "old-panel"],
        ["activity"],
        [],
        ["batches-panel", "knowledge", "automation", "now"],
      ),
    );
  });
});

describe("movePanel", () => {
  const saved = arrangement(["scratchpad"], ["activity"], ["open-prs", "tokyo-clock"], ["now"]);

  it("puts a panel just above or below a neighbour, at a slot's edge, or at its middle", () => {
    expect(
      movePanel(saved, "now", { slot: { x: "right", y: "top" }, above: "tokyo-clock" }),
    ).toEqual(arrangement(["scratchpad"], ["activity"], ["open-prs", "now", "tokyo-clock"], []));
    expect(
      movePanel(saved, "open-prs", { slot: { x: "right", y: "top" }, below: "tokyo-clock" }),
    ).toEqual(arrangement(["scratchpad"], ["activity"], ["tokyo-clock", "open-prs"], ["now"]));
    expect(movePanel(saved, "activity", { slot: { x: "left", y: "top" }, edge: true })).toEqual(
      arrangement(["activity", "scratchpad"], [], ["open-prs", "tokyo-clock"], ["now"]),
    );
    expect(movePanel(saved, "scratchpad", { slot: { x: "left", y: "bottom" } })).toEqual(
      arrangement([], ["scratchpad", "activity"], ["open-prs", "tokyo-clock"], ["now"]),
    );
  });

  it("refuses a move next to the panel itself or next to one the slot does not list", () => {
    expect(() =>
      movePanel(saved, "now", { slot: { x: "right", y: "bottom" }, above: "now" }),
    ).toThrow("cannot move next to itself");
    expect(() =>
      movePanel(saved, "now", { slot: { x: "left", y: "top" }, below: "activity" }),
    ).toThrow("activity is not in the left rail, top.");
  });
});

describe("pickToEdge", () => {
  // INF-2344, captain: "Yes, to the end of its slot, saved in the layout
  // where you can see it."
  it("moves a More row pick to its slot's end at the window's edge", () => {
    const saved = arrangement([], ["activity"], ["open-prs", "tokyo-clock"], ["now", "knowledge"]);
    expect(pickToEdge(saved, "tokyo-clock").right.top).toEqual(["tokyo-clock", "open-prs"]);
    expect(pickToEdge(saved, "now").right.bottom).toEqual(["knowledge", "now"]);
    expect(pickToEdge(saved, "weather")).toBe(saved);
  });
});

describe("stepPanel", () => {
  const saved = arrangement(
    ["scratchpad"],
    ["activity"],
    ["open-prs", "tokyo-clock"],
    ["now", "knowledge"],
  );

  it("reads a rail as one column for up and down, and crosses to the other rail's middle for left and right", () => {
    expect(stepPanel(saved, "tokyo-clock", "up")?.right.top).toEqual(["tokyo-clock", "open-prs"]);
    expect(stepPanel(saved, "tokyo-clock", "down")).toEqual(
      arrangement(["scratchpad"], ["activity"], ["open-prs"], ["tokyo-clock", "now", "knowledge"]),
    );
    expect(stepPanel(saved, "now", "up")).toEqual(
      arrangement(["scratchpad"], ["activity"], ["open-prs", "tokyo-clock", "now"], ["knowledge"]),
    );
    expect(stepPanel(saved, "knowledge", "down")).toBeUndefined();
    expect(stepPanel(saved, "open-prs", "right")).toBeUndefined();
    expect(stepPanel(saved, "open-prs", "left")).toEqual(
      arrangement(["scratchpad", "open-prs"], ["activity"], ["tokyo-clock"], ["now", "knowledge"]),
    );
    expect(stepPanel(saved, "weather", "up")).toBeUndefined();
  });

  it("passes over the panels a person cannot see, so every press moves past one they do", () => {
    // Automation waits for a rule, so the rail draws nothing for it.
    const withGated = arrangement([], ["activity"], [], ["now", "automation", "knowledge"]);
    const seen = (id: string) => id !== "automation";
    expect(stepPanel(withGated, "knowledge", "up", seen)?.right.bottom).toEqual([
      "knowledge",
      "now",
      "automation",
    ]);
  });
});

describe("movedPanels", () => {
  it("names only the panel one drag moved, though its neighbours' places shift", () => {
    const before = arrangement(["scratchpad"], ["activity"], ["open-prs", "tokyo-clock"], ["now"]);
    const dragged = movePanel(before, "now", { slot: { x: "right", y: "top" }, above: "open-prs" });
    expect(movedPanels(before, dragged)).toEqual(["now"]);
    const reordered = movePanel(before, "tokyo-clock", {
      slot: { x: "right", y: "top" },
      above: "open-prs",
    });
    expect(movedPanels(before, reordered)).toHaveLength(1);
  });

  it("does not call a panel written in or forgotten a move", () => {
    const before = arrangement([], ["activity"], ["open-prs"], ["now"]);
    const after = arrangement([], ["activity"], ["tokyo-clock"], ["now"]);
    expect(movedPanels(before, after)).toEqual([]);
  });
});

describe("defaultArrangement", () => {
  it("puts every panel where it asks to be, in its declared order, whatever was saved", () => {
    expect(defaultArrangement(PANELS)).toEqual(
      arrangement(
        ["scratchpad"],
        ["activity"],
        ["open-prs", "tokyo-clock"],
        ["now", "batches-panel", "knowledge", "automation"],
      ),
    );
  });
});

describe("knownPanels", () => {
  it("knows every app panel, gated or not, and the captain's own, but never the create-your-own-panel slot", () => {
    const view = (id: string): PersonalExtensionView => ({
      id,
      source: "yours",
      by: null,
      frame: null,
      title: id,
      placement: { x: "right", y: "top" },
      order: 100,
      size: "content",
      present: true,
      ownPresence: false,
      moves: false,
      running: false,
      reads: [],
      sql: [],
      panel: null,
      server: null,
      cardViews: [],
      cards: {},
      header: [],
      commands: [],
      error: null,
    });
    const ids = knownPanels({ extensions: [view("tokyo-clock"), view(CREATE_PANEL_SLOT_ID)] }).map(
      (panel) => panel.id,
    );
    expect(ids).toEqual([...BUILTIN_SURFACES.map((surface) => surface.id), "tokyo-clock"]);
  });
});
