import type { PanelMove } from "@shared/panelArrangement";
import type { RailSide, RailY, SidePanelPlacement } from "@shared/plugins/manifest";

/**
 * Moving a panel by hand (INF-2344; design skill
 * `components/panel/Panel.prompt.md`, "Moving a panel"): a press on a
 * panel's header on the rails, or on its row in Settings → Panels, that
 * travels a few pixels picks the panel up. A ghost follows the pointer, the
 * nearest place it could land is drawn, and letting go there moves it in
 * the saved arrangement; letting go anywhere else, or Escape, puts it back.
 * There is no arrange mode: every header is a handle.
 *
 * The drawing is the window's own, out of React: three kinds of fixed
 * elements under `document.body`, styled in design/styles.css by their
 * data attributes, and `html[data-panel-dragging]` while a panel is held.
 */

/** How far the pointer travels before a press becomes a drag, as a model pill's does (`ModelLevels.tsx`). */
const DRAG_START_DISTANCE = 5;

export type Box = { left: number; top: number; right: number; bottom: number };

/** One place a held panel could land. */
export type PanelDropTarget = {
  /** The move a drop here makes, or null where the panel already is. */
  move: PanelMove | null;
  /** Its height in the window: the pointer picks the nearest target in its column. */
  y: number;
  /** The column it competes in: a rail, or a rail's block in Settings → Panels. */
  area: Box;
  /** A line across the column where the panel would go. */
  line?: { left: number; top: number; width: number };
  /** The outline of an empty group the panel would go into. */
  zone?: Box;
};

/** One group of a column, as the window drew it. */
export type DropGroup = {
  slot: SidePanelPlacement;
  /** The panels a person sees in it, top to bottom. */
  items: readonly { id: string; top: number; bottom: number }[];
  /** With no item: where its line goes, or the outline a panel would go into. */
  empty: { y: number; zone?: Box };
};

/**
 * The places a column offers the held panel: above each panel it shows,
 * below the last of each group, and an empty group whole. The two around
 * the held panel itself are where it already is.
 */
export function columnTargets(
  panelId: string,
  groups: readonly DropGroup[],
  column: { area: Box; left: number; width: number; gap: number },
): PanelDropTarget[] {
  const { area, left, width, gap } = column;
  const line = (top: number) => ({ left, top, width });
  return groups.flatMap((group): PanelDropTarget[] => {
    const { items, slot } = group;
    const last = items[items.length - 1];
    if (!last) {
      const { y, zone } = group.empty;
      return [{ move: { slot }, y, area, ...(zone ? { zone } : { line: line(y) }) }];
    }
    const held = items.findIndex((item) => item.id === panelId);
    return [...items, undefined].map((item, index): PanelDropTarget => {
      const y = item ? item.top - gap / 2 : last.bottom + gap / 2;
      if (held >= 0 && (index === held || index === held + 1)) return { move: null, y, area };
      const move: PanelMove = item ? { slot, above: item.id } : { slot, below: last.id };
      return { move, y, area, line: line(y) };
    });
  });
}

/** The target nearest the pointer in the column it is over, or none outside every column. */
export function nearestTarget(
  targets: readonly PanelDropTarget[],
  x: number,
  y: number,
): PanelDropTarget | undefined {
  let best: PanelDropTarget | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const { area } = target;
    if (x < area.left || x > area.right || y < area.top || y > area.bottom) continue;
    const away = Math.abs(y - target.y);
    if (away < distance) {
      best = target;
      distance = away;
    }
  }
  return best;
}

export type PanelDrag = {
  panelId: string;
  /** What the press began on: it holds the pointer once the panel is picked up. */
  handle: HTMLElement;
  /** What goes faint while the panel is held. */
  source: HTMLElement;
  /** The ghost's words. */
  title: string;
  /** Where the panel could land, read as the pointer moves. */
  targets: () => readonly PanelDropTarget[];
  /** Outlines shown for the whole drag: each group of a rail that has no panels. */
  zones?: () => readonly Box[];
  drop: (move: PanelMove) => void;
};

let holding = false;

/** Whether a panel is held now. */
export function isHoldingPanel(): boolean {
  return holding;
}

/**
 * A press that may pick a panel up. Call it from the handle's pointerdown;
 * the press stays an ordinary click until it travels far enough.
 */
export function pressPanel(event: PointerEvent, drag: PanelDrag): void {
  if (event.button !== 0 || holding) return;
  const pointerId = event.pointerId;
  const start = { x: event.clientX, y: event.clientY };
  let held: ReturnType<typeof pickUp> | null = null;
  const stop = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onCancel);
  };
  const putDown = () => {
    stop();
    if (!held) return;
    const target = held.target();
    held.remove();
    held = null;
    swallowNextClick();
    return target;
  };
  function onMove(move: PointerEvent) {
    if (move.pointerId !== pointerId) return;
    if (!held) {
      if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_START_DISTANCE) return;
      held = pickUp(drag, start, pointerId);
    }
    move.preventDefault();
    held.follow(move.clientX, move.clientY);
  }
  function onUp(up: PointerEvent) {
    if (up.pointerId !== pointerId) return;
    const target = putDown();
    if (target?.move) drag.drop(target.move);
  }
  function onCancel() {
    putDown();
  }
  function onKey(key: KeyboardEvent) {
    if (key.key !== "Escape" || !held) return;
    // Escape puts the panel back and closes nothing else.
    key.preventDefault();
    key.stopPropagation();
    putDown();
  }
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onCancel);
}

/** The click a drag's release makes is not a click on what it began on. */
function swallowNextClick(): void {
  const swallow = (click: MouseEvent) => {
    click.preventDefault();
    click.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

function place(element: HTMLElement, box: Box): void {
  element.style.left = `${box.left}px`;
  element.style.top = `${box.top}px`;
  element.style.width = `${box.right - box.left}px`;
  element.style.height = `${box.bottom - box.top}px`;
}

function pickUp(drag: PanelDrag, start: { x: number; y: number }, pointerId: number) {
  holding = true;
  const root = document.documentElement;
  root.setAttribute("data-panel-dragging", "");
  drag.source.setAttribute("data-panel-drag-source", "");
  window.getSelection()?.removeAllRanges();
  try {
    // Held by the handle, the pointer's moves reach the window even over a panel's frame.
    drag.handle.setPointerCapture(pointerId);
  } catch {
    // A pointer already gone: the window's own listeners still hear the rest.
  }
  const grabbed = drag.handle.getBoundingClientRect();
  const offset = { x: start.x - grabbed.left, y: start.y - grabbed.top };
  const ghost = document.createElement("div");
  ghost.setAttribute("data-panel-drag-ghost", "");
  ghost.setAttribute("aria-hidden", "true");
  ghost.textContent = drag.title;
  ghost.style.width = `${grabbed.width}px`;
  ghost.style.height = `${grabbed.height}px`;
  const line = document.createElement("div");
  line.setAttribute("data-panel-drop-line", "");
  line.setAttribute("aria-hidden", "true");
  line.hidden = true;
  const zones = (drag.zones?.() ?? []).map((box) => {
    const zone = document.createElement("div");
    zone.setAttribute("data-panel-drop-zone", "");
    zone.setAttribute("aria-hidden", "true");
    place(zone, box);
    return zone;
  });
  const lit = document.createElement("div");
  lit.setAttribute("data-panel-drop-zone", "");
  lit.setAttribute("data-lit", "");
  lit.setAttribute("aria-hidden", "true");
  lit.hidden = true;
  document.body.append(...zones, lit, line, ghost);
  let target: PanelDropTarget | undefined;
  const follow = (x: number, y: number) => {
    ghost.style.transform = `translate(${x - offset.x}px, ${y - offset.y}px)`;
    target = nearestTarget(drag.targets(), x, y);
    line.hidden = !target?.line;
    if (target?.line) {
      line.style.left = `${target.line.left}px`;
      line.style.top = `${target.line.top - 1}px`;
      line.style.width = `${target.line.width}px`;
    }
    lit.hidden = !target?.zone;
    if (target?.zone) place(lit, target.zone);
  };
  follow(start.x, start.y);
  return {
    follow,
    target: () => target,
    remove: () => {
      holding = false;
      for (const element of [...zones, lit, line, ghost]) element.remove();
      root.removeAttribute("data-panel-dragging");
      drag.source.removeAttribute("data-panel-drag-source");
      try {
        drag.handle.releasePointerCapture(pointerId);
      } catch {
        // Already released with the pointer.
      }
    },
  };
}

/** A length a design token resolves to here, read through a probe as the rail's measure does. */
function tokenPx(host: HTMLElement, value: string): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;width:${value};height:0`;
  host.append(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px;
}

const SIDES: readonly RailSide[] = ["left", "right"];

/** Whether a rail draws anything: an empty rail is zero-wide and paints nothing. */
function railShown(rail: HTMLElement): boolean {
  return (
    rail.querySelector(
      ":scope > :is([data-side-panel], [data-create-panel-slot], [data-rail-more]):not([hidden])",
    ) !== null
  );
}

/** Where an empty rail would draw its top and bottom groups, a header high each. */
function emptyRailZones(rail: HTMLElement, side: RailSide): { area: Box; top: Box; bottom: Box } {
  const box = rail.getBoundingClientRect();
  const width = tokenPx(rail, "var(--rail-width)");
  const inset = tokenPx(rail, "var(--space-3)");
  const header = tokenPx(rail, "var(--rail-header-height)");
  const left = side === "left" ? box.left : box.right - width;
  const area = { left, right: left + width, top: box.top, bottom: box.bottom };
  const topEdge = box.top + tokenPx(rail, "var(--space-8)");
  const bottomEdge = box.bottom - tokenPx(rail, "var(--space-4)");
  const across = { left: left + inset, right: left + width - inset };
  return {
    area,
    top: { ...across, top: topEdge, bottom: topEdge + header },
    bottom: { ...across, top: bottomEdge - header, bottom: bottomEdge },
  };
}

/** The places the rails offer a held panel, read from the window as drawn now. */
export function railTargets(panelId: string): PanelDropTarget[] {
  return SIDES.flatMap((side) => {
    const rail = document.querySelector<HTMLElement>(`[data-rail="${side}"]`);
    if (!rail) return [];
    if (!railShown(rail)) {
      const { area, top, bottom } = emptyRailZones(rail, side);
      return (["top", "bottom"] as const).map((y) => {
        const zone = y === "top" ? top : bottom;
        return { move: { slot: { x: side, y } }, y: (zone.top + zone.bottom) / 2, area, zone };
      });
    }
    const box = rail.getBoundingClientRect();
    const style = getComputedStyle(rail);
    const gap = Number.parseFloat(style.rowGap) || 0;
    const panels = [
      ...rail.querySelectorAll<HTMLElement>(":scope > [data-side-panel]:not([hidden])"),
    ];
    const first = panels[0];
    const across = first?.getBoundingClientRect() ?? {
      left: box.left + (Number.parseFloat(style.paddingLeft) || 0),
      width: box.width - (Number.parseFloat(style.paddingLeft) || 0) * 2,
    };
    const slot = rail.querySelector<HTMLElement>(":scope > [data-create-panel-slot]:not([hidden])");
    const more = rail.querySelector<HTMLElement>(":scope > [data-rail-more]");
    const contentTop = slot
      ? slot.getBoundingClientRect().bottom + gap / 2
      : box.top + (Number.parseFloat(style.paddingTop) || 0);
    const contentBottom = more
      ? more.getBoundingClientRect().top - gap / 2
      : box.bottom - (Number.parseFloat(style.paddingBottom) || 0);
    const group = (y: RailY): DropGroup => ({
      slot: { x: side, y },
      items: panels
        .filter((panel) => panel.getAttribute("data-side-panel-placement-y") === y)
        .map((panel) => {
          const at = panel.getBoundingClientRect();
          return {
            id: panel.getAttribute("data-side-panel") ?? "",
            top: at.top,
            bottom: at.bottom,
          };
        }),
      empty: { y: y === "top" ? contentTop : contentBottom },
    });
    return columnTargets(panelId, [group("top"), group("bottom")], {
      area: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      left: across.left,
      width: across.width,
      gap,
    });
  });
}

/** The outlines of a rail with no panels, shown while a panel is held. */
export function railZones(): Box[] {
  return SIDES.flatMap((side) => {
    const rail = document.querySelector<HTMLElement>(`[data-rail="${side}"]`);
    if (!rail || railShown(rail)) return [];
    const { top, bottom } = emptyRailZones(rail, side);
    return [top, bottom];
  });
}

/**
 * Whether a person sees a panel on its rail now: a keyboard step passes
 * over the ones they do not, so every press moves it past one they see.
 */
export function shownOnRail(id: string): boolean {
  return document.querySelector(`[data-side-panel="${CSS.escape(id)}"]:not([hidden])`) !== null;
}
