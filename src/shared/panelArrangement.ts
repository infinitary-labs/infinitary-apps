import { CREATE_PANEL_SLOT_ID } from "./createPanelSlot";
import type { PersonalSnapshot } from "./personal/manifest";
import type { RailSide, RailY, SidePanelPlacement } from "./plugins/manifest";
import type { Layout, PanelArrangement } from "./preferences";
import { BUILTIN_SURFACES } from "./surfaces";

/**
 * The one saved layout of the rails (INF-2344): every panel's slot and its
 * place in it, read and written the same way by the core, the first mate's
 * panel action, the rails and Settings → Panels. Each slot lists its panels
 * in the order the rail draws them, top to bottom.
 *
 * Two ends of a slot have names here. Its EDGE is the end at the window's
 * edge: the top of a top group, the bottom of a bottom group, where a full
 * rail keeps panels longest (`railRoom`). Its MIDDLE is the end facing the
 * other group, where a new panel lands.
 */

/** A panel as the arrangement needs it: its id, the slot it asks for and its declared order. */
export type ArrangedPanel = { id: string; preferred: SidePanelPlacement; order: number };

/** The four slots, in reading order: the left rail's top and bottom, then the right's. */
export const RAIL_SLOTS: readonly SidePanelPlacement[] = [
  { x: "left", y: "top" },
  { x: "left", y: "bottom" },
  { x: "right", y: "top" },
  { x: "right", y: "bottom" },
];

export function emptyArrangement(): PanelArrangement {
  return { left: { top: [], bottom: [] }, right: { top: [], bottom: [] } };
}

function copy(arrangement: PanelArrangement): PanelArrangement {
  return {
    left: { top: [...arrangement.left.top], bottom: [...arrangement.left.bottom] },
    right: { top: [...arrangement.right.top], bottom: [...arrangement.right.bottom] },
  };
}

/** The panels one slot lists, top to bottom. */
export function slotPanels(
  arrangement: PanelArrangement,
  slot: SidePanelPlacement,
): readonly string[] {
  return arrangement[slot.x][slot.y];
}

/** Where a panel is listed, or undefined when the arrangement does not list it. */
export function panelSlot(
  arrangement: PanelArrangement,
  id: string,
): { slot: SidePanelPlacement; index: number } | undefined {
  for (const slot of RAIL_SLOTS) {
    const index = arrangement[slot.x][slot.y].indexOf(id);
    if (index >= 0) return { slot, index };
  }
  return undefined;
}

/** The arrangement without one panel: what forgetting it leaves. */
export function withoutPanel(arrangement: PanelArrangement, id: string): PanelArrangement {
  const next = copy(arrangement);
  for (const slot of RAIL_SLOTS)
    next[slot.x][slot.y] = next[slot.x][slot.y].filter((listed) => listed !== id);
  return next;
}

export function sameArrangement(a: PanelArrangement, b: PanelArrangement): boolean {
  return RAIL_SLOTS.every((slot) => {
    const left = a[slot.x][slot.y];
    const right = b[slot.x][slot.y];
    return left.length === right.length && left.every((id, index) => right[index] === id);
  });
}

function byDeclaredOrder(a: ArrangedPanel, b: ArrangedPanel): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

/** Puts panels at a slot's middle, keeping their own order. */
function atMiddle(slot: SidePanelPlacement, listed: string[], added: string[]): string[] {
  return slot.y === "top" ? [...listed, ...added] : [...added, ...listed];
}

/**
 * Where every panel sits now (INF-2344): the saved arrangement, with each
 * panel it does not list written in.
 *
 * Before an arrangement is saved, every panel sits where the rails drew it
 * before the arrangement existed: its saved placement or the slot it asks
 * for, the More picks nearest the slot's edge, then its declared order and
 * its id. That is how the core fills the arrangement once, so nothing moves
 * when it first exists. Once one is saved, a panel it does not list is new:
 * it lands in its slot's middle. A listed panel the caller does not know
 * keeps its place, since a caller may know fewer panels than the core.
 */
export function arrangePanels(layout: Layout, panels: readonly ArrangedPanel[]): PanelArrangement {
  const slotOf = (panel: ArrangedPanel) => layout.placements[panel.id] ?? panel.preferred;
  const saved = layout.arrangement;
  if (!saved) {
    const next = emptyArrangement();
    const picked = (id: string) => {
      const at = layout.panelOrder?.indexOf(id) ?? -1;
      return at < 0 ? Number.POSITIVE_INFINITY : at;
    };
    for (const slot of RAIL_SLOTS) {
      const here = panels.filter((panel) => {
        const at = slotOf(panel);
        return at.x === slot.x && at.y === slot.y;
      });
      here.sort((a, b) => {
        const rankA = picked(a.id);
        const rankB = picked(b.id);
        const rank = rankA === rankB ? 0 : rankA < rankB ? -1 : 1;
        return (slot.y === "top" ? rank : -rank) || byDeclaredOrder(a, b);
      });
      next[slot.x][slot.y] = unique(here.map((panel) => panel.id));
    }
    return next;
  }
  const next = deduplicated(saved);
  const listed = new Set(RAIL_SLOTS.flatMap((slot) => next[slot.x][slot.y]));
  const added = panels.filter((panel) => !listed.has(panel.id)).sort(byDeclaredOrder);
  for (const slot of RAIL_SLOTS) {
    const here = added.filter((panel) => {
      const at = slotOf(panel);
      return at.x === slot.x && at.y === slot.y;
    });
    if (here.length)
      next[slot.x][slot.y] = atMiddle(
        slot,
        next[slot.x][slot.y],
        unique(here.map((panel) => panel.id)),
      );
  }
  return next;
}

/** Every panel where it asks to be, in its declared order: what Reset to defaults writes. */
export function defaultArrangement(panels: readonly ArrangedPanel[]): PanelArrangement {
  const next = emptyArrangement();
  for (const slot of RAIL_SLOTS)
    next[slot.x][slot.y] = unique(
      panels
        .filter((panel) => panel.preferred.x === slot.x && panel.preferred.y === slot.y)
        .sort(byDeclaredOrder)
        .map((panel) => panel.id),
    );
  return next;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** A saved arrangement with any panel listed twice kept at its first place. */
function deduplicated(arrangement: PanelArrangement): PanelArrangement {
  const seen = new Set<string>();
  const next = emptyArrangement();
  for (const slot of RAIL_SLOTS)
    next[slot.x][slot.y] = arrangement[slot.x][slot.y].filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  return next;
}

/**
 * Where a move puts a panel: a slot, and in it just above or below another
 * panel there, at its edge, or - with neither - at its middle, where a new
 * panel lands.
 */
export type PanelMove = {
  slot: SidePanelPlacement;
  above?: string;
  below?: string;
  edge?: true;
};

/**
 * The arrangement with one panel moved. A panel it does not list yet is
 * written in where the move says. Moving next to a panel that is not in the
 * slot, or next to itself, is refused: the caller names a real neighbour.
 */
export function movePanel(
  arrangement: PanelArrangement,
  id: string,
  move: PanelMove,
): PanelArrangement {
  const neighbour = move.above ?? move.below;
  if (neighbour === id) throw new Error("A panel cannot move next to itself.");
  const next = withoutPanel(arrangement, id);
  const slot = next[move.slot.x][move.slot.y];
  if (neighbour !== undefined) {
    const at = slot.indexOf(neighbour);
    if (at < 0) throw new Error(`${neighbour} is not in the ${move.slot.x} rail, ${move.slot.y}.`);
    slot.splice(move.above !== undefined ? at : at + 1, 0, id);
  } else if (move.edge) {
    if (move.slot.y === "top") slot.unshift(id);
    else slot.push(id);
  } else if (move.slot.y === "top") slot.push(id);
  else slot.unshift(id);
  return next;
}

/**
 * A More row pick (captain's answer on INF-2344: "Yes, to the end of its
 * slot, saved in the layout where you can see it"): the panel moves to its
 * slot's edge, where a full rail keeps panels longest.
 */
export function pickToEdge(arrangement: PanelArrangement, id: string): PanelArrangement {
  const at = panelSlot(arrangement, id);
  if (!at) return arrangement;
  return movePanel(arrangement, id, { slot: at.slot, edge: true });
}

/** One keyboard step: up and down along its rail, left and right to the other rail. */
export type PanelStep = "up" | "down" | "left" | "right";

/**
 * The arrangement after one step of a panel, or undefined when the step
 * has nowhere to go. A rail reads as one column, its top group above its
 * bottom group, so up from the first of a bottom group joins the top
 * group's end, and down from the last of a top group joins the bottom
 * group's start. Left and right cross to the same group of the other rail,
 * at its middle. `visible` is the panels a person can see in each slot: a
 * step passes over the ones they cannot, so every press moves the panel
 * past one they see.
 */
export function stepPanel(
  arrangement: PanelArrangement,
  id: string,
  step: PanelStep,
  visible: (id: string) => boolean = () => true,
): PanelArrangement | undefined {
  const at = panelSlot(arrangement, id);
  if (!at) return undefined;
  const { slot } = at;
  if (step === "left" || step === "right") {
    const x: RailSide = step === "left" ? "left" : "right";
    if (x === slot.x) return undefined;
    return movePanel(arrangement, id, { slot: { x, y: slot.y } });
  }
  const shown = slotPanels(arrangement, slot).filter((listed) => listed === id || visible(listed));
  const index = shown.indexOf(id);
  const y: RailY = slot.y;
  if (step === "up") {
    const above = shown[index - 1];
    if (above !== undefined) return movePanel(arrangement, id, { slot, above });
    if (y === "bottom") return movePanel(arrangement, id, { slot: { x: slot.x, y: "top" } });
    return undefined;
  }
  const below = shown[index + 1];
  if (below !== undefined) return movePanel(arrangement, id, { slot, below });
  if (y === "top") return movePanel(arrangement, id, { slot: { x: slot.x, y: "bottom" } });
  return undefined;
}

/**
 * The panels a change of arrangement moved: each one listed both before
 * and after whose slot changed, or whose place among the others in its
 * slot did. One drag or one step moves exactly one panel even though its
 * neighbours' numbers shift; a panel written in or forgotten is not a move.
 * Two neighbours trading places read either way, so `named`, the panel the
 * request named, is the one moved whenever moving it alone explains the change.
 */
export function movedPanels(
  before: PanelArrangement,
  after: PanelArrangement,
  named?: string,
): string[] {
  const moved = longestRunOutside(before, after);
  if (
    named !== undefined &&
    moved.length === 1 &&
    moved[0] !== named &&
    panelSlot(before, named) &&
    panelSlot(after, named) &&
    sameArrangement(withoutPanel(before, named), withoutPanel(after, named))
  )
    return [named];
  return moved;
}

function longestRunOutside(before: PanelArrangement, after: PanelArrangement): string[] {
  const listedBefore = new Set(RAIL_SLOTS.flatMap((slot) => before[slot.x][slot.y]));
  const listedAfter = new Set(RAIL_SLOTS.flatMap((slot) => after[slot.x][slot.y]));
  const both = (id: string) => listedBefore.has(id) && listedAfter.has(id);
  const entries = (arrangement: PanelArrangement) =>
    RAIL_SLOTS.flatMap((slot) =>
      arrangement[slot.x][slot.y]
        .filter(both)
        .map((id) => ({ id, key: `${slot.x}:${slot.y}:${id}` })),
    );
  const a = entries(before);
  const b = entries(after);
  // The longest run the two share in order (a table of its lengths from
  // each pair of positions on): every panel outside it moved.
  const width = b.length + 1;
  const run = new Array<number>((a.length + 1) * width).fill(0);
  const at = (i: number, j: number) => run[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      run[i * width + j] =
        a[i]?.key === b[j]?.key ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const kept = new Set<string>();
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i]?.key === b[j]?.key) {
      kept.add(b[j]?.key ?? "");
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return b.filter((entry) => !kept.has(entry.key)).map((entry) => entry.id);
}

/**
 * Every panel the core knows, for the arrangement: each of the app's own
 * panels, gated or not, so a gated one has its place before its gate opens,
 * and every panel in the snapshot of the captain's own and added panels.
 * The create-your-own-panel slot is the app's chrome, always first on the
 * left rail, and never listed.
 */
export function knownPanels(snapshot: PersonalSnapshot): ArrangedPanel[] {
  return [
    ...BUILTIN_SURFACES.map((surface) => ({
      id: surface.id,
      preferred: surface.preferredPlacement,
      order: surface.order,
    })),
    ...snapshot.extensions
      .filter((extension) => extension.id !== CREATE_PANEL_SLOT_ID)
      .map((extension) => ({
        id: extension.id,
        preferred: extension.placement,
        order: extension.order,
      })),
  ];
}
