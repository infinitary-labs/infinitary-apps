import { describe, expect, it } from "vitest";
import { columnTargets, type DropGroup, nearestTarget } from "./panelDrag";
import { panelStepOf } from "./panelMoveKeys";

/**
 * Where a held panel can land (INF-2344, captain: "i think we should simply
 * make all panel headers draggable"). The geometry is the right rail of the
 * smallest window as the design tokens draw it: 300 wide at x 660, panels
 * 12 apart, Tasks and Knowledge in its bottom group, two of the captain's
 * clocks in its top group.
 */
const RAIL = { left: 660, top: 44, right: 960, bottom: 600 };
const COLUMN = { area: RAIL, left: 672, width: 276, gap: 12 };
const RIGHT: DropGroup[] = [
  {
    slot: { x: "right", y: "top" },
    items: [
      { id: "tokyo-clock", top: 56, bottom: 120 },
      { id: "paris-clock", top: 132, bottom: 196 },
    ],
    empty: { y: 56 },
  },
  {
    slot: { x: "right", y: "bottom" },
    items: [
      { id: "now", top: 360, bottom: 480 },
      { id: "knowledge", top: 492, bottom: 588 },
    ],
    empty: { y: 588 },
  },
];

describe("columnTargets", () => {
  it("offers above each panel and below each group's last, and marks the two around the held panel as where it is", () => {
    const targets = columnTargets("knowledge", RIGHT, COLUMN);
    expect(targets.map((target) => [target.y, target.move])).toEqual([
      [50, { slot: { x: "right", y: "top" }, above: "tokyo-clock" }],
      [126, { slot: { x: "right", y: "top" }, above: "paris-clock" }],
      [202, { slot: { x: "right", y: "top" }, below: "paris-clock" }],
      [354, { slot: { x: "right", y: "bottom" }, above: "now" }],
      [486, null],
      [594, null],
    ]);
    expect(targets[0]?.line).toEqual({ left: 672, top: 50, width: 276 });
    expect(targets[4]?.line).toBeUndefined();
  });

  it("offers an empty group whole, as its outline when the rail has one", () => {
    const zone = { left: 672, top: 56, right: 948, bottom: 120 };
    const targets = columnTargets(
      "now",
      [{ slot: { x: "left", y: "top" }, items: [], empty: { y: 88, zone } }],
      { ...COLUMN, area: { left: 0, top: 44, right: 300, bottom: 600 } },
    );
    expect(targets).toEqual([
      {
        move: { slot: { x: "left", y: "top" } },
        y: 88,
        area: { left: 0, top: 44, right: 300, bottom: 600 },
        zone,
      },
    ]);
  });
});

describe("nearestTarget", () => {
  const targets = columnTargets("knowledge", RIGHT, COLUMN);

  it("lights the place nearest the pointer in the rail it is over", () => {
    expect(nearestTarget(targets, 800, 140)?.move).toEqual({
      slot: { x: "right", y: "top" },
      above: "paris-clock",
    });
    // Just under Tasks' top edge is nearer the place above it than below it.
    expect(nearestTarget(targets, 800, 380)?.move).toEqual({
      slot: { x: "right", y: "bottom" },
      above: "now",
    });
    // Over the held panel itself, nothing moves.
    expect(nearestTarget(targets, 800, 540)?.move).toBeNull();
  });

  it("lights nothing while the pointer is outside every rail", () => {
    expect(nearestTarget(targets, 400, 140)).toBeUndefined();
  });
});

describe("panelStepOf", () => {
  // The keyboard rule (docs/keyboard.md): a panel moves from its chevron with ⌥ and an arrow.
  it("reads ⌥ with an arrow as one step, and any other chord as none", () => {
    const press = (
      key: string,
      mods: Partial<Record<"alt" | "ctrl" | "meta" | "shift", boolean>>,
    ) =>
      panelStepOf({
        key,
        altKey: mods.alt ?? false,
        ctrlKey: mods.ctrl ?? false,
        metaKey: mods.meta ?? false,
        shiftKey: mods.shift ?? false,
      });
    expect(press("ArrowUp", { alt: true })).toBe("up");
    expect(press("ArrowDown", { alt: true })).toBe("down");
    expect(press("ArrowLeft", { alt: true })).toBe("left");
    expect(press("ArrowRight", { alt: true })).toBe("right");
    expect(press("ArrowUp", {})).toBeNull();
    expect(press("ArrowUp", { alt: true, meta: true })).toBeNull();
    expect(press("ArrowUp", { alt: true, shift: true })).toBeNull();
    expect(press("Enter", { alt: true })).toBeNull();
  });
});
