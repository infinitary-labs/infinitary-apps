import { useSyncExternalStore } from "react";
import type { Box } from "../../character/crew/hover";

/**
 * A task key the pointer rests on in a card body (FI3-594): the key's box
 * and its card's, in window coordinates, and the frame the key is in.
 */
export type KeyPeek = { taskId: string; key: Box; card: Box; frame: HTMLIFrameElement };

/**
 * A task a panel's page rests on (`point.peekTask`, docs/ui-plugins.md "A
 * panel's cards"): its box in window coordinates, the page it is in - the
 * panel on its rail or the card on the stack, whose edge the summary sits
 * beside - and that page's frame for a panel drawn in one. A Tasks row and
 * a task board tile are such tasks: the Tasks panel and its board are
 * panels like any other.
 */
export type PanelPeek = {
  taskId: string;
  box: Box;
  page: HTMLElement;
  pageFrame: HTMLIFrameElement | null;
};

/**
 * A task key the window itself draws (FI3-1271): a thread line, a card's
 * title, the record's Now line, a Settings row. The key's box and the box of
 * the surface it is drawn on - its card, or the Settings section - in window
 * coordinates, and the key's own element, which lets it go.
 */
export type AnchorPeek = { taskId: string; key: Box; card: Box; anchor: HTMLElement };

/** What the summary beside a key or a panel's task reads: one at a time, or none. */
export type TaskPeek = KeyPeek | PanelPeek | AnchorPeek | null;

/**
 * The task the pointer rests on: a task key in a card body, written by that
 * body's frame (`../../cards/taskLinks.ts`), a task key the window draws
 * (`../../cards/TaskKey.tsx`), or a task a panel's page rests on, written
 * by its `point.peekTask` (`../panelPoint.ts`) - and let go of
 * by whatever lets each go. Read by the one summary the host opens beside
 * it (./PeekSummary.tsx). Host-owned view state: the core never knows
 * where the pointer is. A plain external store, like the rail's.
 */
let pointed: TaskPeek = null;
const listeners = new Set<() => void>();

const sameBox = (a: Box, b: Box) =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

const same = (a: TaskPeek, b: TaskPeek): boolean => {
  if (a === b) return true;
  if (a === null || b === null || a.taskId !== b.taskId) return false;
  if ("page" in a) return "page" in b && a.page === b.page && sameBox(a.box, b.box);
  if ("page" in b) return false;
  if ("anchor" in a) {
    return (
      "anchor" in b && a.anchor === b.anchor && sameBox(a.key, b.key) && sameBox(a.card, b.card)
    );
  }
  if ("anchor" in b) return false;
  return a.frame === b.frame && sameBox(a.key, b.key) && sameBox(a.card, b.card);
};

export const taskPeek = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get(): TaskPeek {
    return pointed;
  },
  /** A repeat of the same key or task keeps its beat; anything else starts a new one. */
  set(next: TaskPeek): void {
    if (same(pointed, next)) return;
    pointed = next;
    for (const listener of listeners) listener();
  },
  /**
   * Lets go of a key in `from`, a card body's frame, of the window's own key
   * `from`, or of a task in the panel page `from` (or that page's frame),
   * and of nothing else: what the pointer rests on elsewhere stays.
   */
  release(from: HTMLIFrameElement | HTMLElement | null): void {
    if (!pointed) return;
    const held =
      "page" in pointed
        ? pointed.page === from || pointed.pageFrame === from
        : "anchor" in pointed
          ? pointed.anchor === from
          : pointed.frame === from;
    if (held) taskPeek.set(null);
  },
};

export function useTaskPeek(): TaskPeek {
  return useSyncExternalStore(taskPeek.subscribe, taskPeek.get, taskPeek.get);
}
