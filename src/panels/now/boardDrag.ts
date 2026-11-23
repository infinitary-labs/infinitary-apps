import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { BoardTarget } from "./boardMoves";
import type { BoardLane } from "./boardTiles";

/**
 * Picking a task board tile up with the pointer (docs/task-board.md,
 * "Moves"), as the app's Models board picks up a pill:
 * a press becomes a drag once the pointer has travelled 5 px, a ghost of the
 * tile follows the pointer while the tile itself stays at 40%, the lane or
 * tray under the pointer is the drop, Esc lets go of the drag and writes
 * nothing, and the board's body scrolls while the pointer rests near one of
 * its edges. What a drop does is the board's (./boardMoves.ts).
 */

/** How far the pointer travels before a press on a tile becomes a drag. */
export const DRAG_START_DISTANCE = 5;
/** How near an edge of the body the pointer brings on its scrolling, and the fastest step. */
const EDGE_ZONE = 40;
const EDGE_STEP = 14;

export type TileDrag = { taskId: string; from: BoardLane; over: BoardTarget | null };

export type GhostPlace = { left: number; top: number; width: number };

export function boardTargetAt(x: number, y: number): BoardTarget | null {
  const drop = document
    .elementFromPoint(x, y)
    ?.closest("[data-board-drop]")
    ?.getAttribute("data-board-drop");
  switch (drop) {
    case "waiting":
    case "backlog":
    case "queued":
    case "working":
    case "landed":
    case "drop":
      return drop;
    default:
      return null;
  }
}

type Press = {
  taskId: string;
  from: BoardLane;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
  width: number;
  x: number;
  y: number;
  dragging: boolean;
  cancelled: boolean;
  stop: () => void;
};

export type TileDragHandlers = {
  /** Over a new target, or none: the board says what a drop there would do. */
  onOver: (drag: TileDrag) => void;
  /** Let go over `target` (null: over nothing the board takes). */
  onDrop: (drag: TileDrag, target: BoardTarget | null) => void;
  /** Esc, or the pointer was taken away: nothing is written. */
  onCancel: (drag: TileDrag) => void;
};

export function useTileDrag(
  body: React.RefObject<HTMLElement | null>,
  handlers: TileDragHandlers,
): {
  drag: TileDrag | null;
  ghost: GhostPlace | null;
  ghostRef: React.RefObject<HTMLDivElement | null>;
  /** Pointer down on a tile that may move. */
  begin: (event: React.PointerEvent<HTMLElement>, taskId: string, from: BoardLane) => void;
  /** True for the click a drag's release would otherwise send to the tile. */
  swallowsClick: () => boolean;
} {
  const [drag, setDrag] = useState<TileDrag | null>(null);
  const [ghost, setGhost] = useState<GhostPlace | null>(null);
  const press = useRef<Press | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const suppress = useRef(false);
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => () => press.current?.stop(), []);

  const begin = (event: React.PointerEvent<HTMLElement>, taskId: string, from: BoardLane) => {
    if (event.button !== 0 || press.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    const state: Press = {
      taskId,
      from,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - box.left,
      grabY: event.clientY - box.top,
      width: box.width,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
      cancelled: false,
      stop: () => {},
    };
    let over: BoardTarget | null = null;
    let frame = 0;
    const view = (): TileDrag => ({ taskId, from, over });
    const place = () => {
      const node = ghostRef.current;
      if (!node) return;
      node.style.left = `${state.x - state.grabX}px`;
      node.style.top = `${state.y - state.grabY}px`;
    };
    const look = () => {
      const now = boardTargetAt(state.x, state.y);
      if (now === over) return;
      over = now;
      setDrag(view());
      latest.current.onOver(view());
    };
    // The body scrolls while the pointer rests near one of its edges.
    const scroll = () => {
      frame = 0;
      const scroller = body.current;
      if (!state.dragging || state.cancelled || !scroller) return;
      const edge = scroller.getBoundingClientRect();
      const step = (near: number) => Math.round(EDGE_STEP * (1 - Math.max(near, 0) / EDGE_ZONE));
      let dx = 0;
      let dy = 0;
      if (state.x > edge.right - EDGE_ZONE) dx = step(edge.right - state.x);
      else if (state.x < edge.left + EDGE_ZONE) dx = -step(state.x - edge.left);
      if (state.y > edge.bottom - EDGE_ZONE) dy = step(edge.bottom - state.y);
      else if (state.y < edge.top + EDGE_ZONE) dy = -step(state.y - edge.top);
      if (dx === 0 && dy === 0) return;
      scroller.scrollBy(dx, dy);
      look();
      frame = requestAnimationFrame(scroll);
    };
    const onMove = (moved: PointerEvent) => {
      state.x = moved.clientX;
      state.y = moved.clientY;
      if (!state.dragging) {
        const travelled =
          Math.abs(moved.clientX - state.startX) + Math.abs(moved.clientY - state.startY);
        if (travelled < DRAG_START_DISTANCE) return;
        state.dragging = true;
        setGhost({
          left: state.x - state.grabX,
          top: state.y - state.grabY,
          width: state.width,
        });
        over = boardTargetAt(state.x, state.y);
        setDrag(view());
        latest.current.onOver(view());
      }
      if (state.cancelled) return;
      place();
      look();
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const end = () => {
      state.stop();
      press.current = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      setDrag(null);
      setGhost(null);
    };
    // Esc lets go of the drag before anything else hears it: the board stays.
    const onKey = (pressed: KeyboardEvent) => {
      if (!state.dragging || state.cancelled || pressed.key !== "Escape") return;
      pressed.preventDefault();
      pressed.stopPropagation();
      state.cancelled = true;
      const was = view();
      setDrag(null);
      setGhost(null);
      latest.current.onCancel(was);
    };
    const finish = (released: PointerEvent, dropped: boolean) => {
      const wasDragging = state.dragging && !state.cancelled;
      const was = view();
      if (state.dragging) {
        suppress.current = true;
        window.setTimeout(() => {
          suppress.current = false;
        }, 0);
      }
      end();
      if (!wasDragging) return;
      if (!dropped) {
        latest.current.onCancel(was);
        return;
      }
      latest.current.onDrop(was, boardTargetAt(released.clientX, released.clientY));
    };
    const onUp = (released: PointerEvent) => finish(released, true);
    const onCancel = (released: PointerEvent) => finish(released, false);
    state.stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
    press.current = state;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  return { drag, ghost, ghostRef, begin, swallowsClick: () => suppress.current };
}
