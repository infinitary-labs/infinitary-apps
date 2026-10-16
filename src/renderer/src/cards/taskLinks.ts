import type { FrameBox, FrameTaskGesture } from "@shared/plugins/bridge";
import { taskKeysIn } from "@shared/taskKeys";
import type { TaskBoard, TaskView } from "@shared/tasks";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { openTask } from "../plugins/point/openTask";
import { taskPeek } from "../plugins/point/taskPeek";
import { appReadExecutor } from "../plugins/reads/appExecutor";

/**
 * The tasks a body or a line names (FI3-594, FI3-1271; the design skill's
 * core rule "Task keys"): `keys` are the keys the words write that are
 * exactly a recorded task's key, other than the task they are about, and
 * `task` reads that task as it is now.
 */
export type TaskLinks = {
  keys: readonly string[];
  task: (key: string) => TaskView | undefined;
};

const NO_KEYS: readonly string[] = [];

/**
 * Which keys name recorded tasks, for every place the window draws a key:
 * one store for the whole window. While anything asks, it reads the board
 * once, which answers for live and recent work and keeps each task current;
 * a key the board does not list is looked up once in earlier work
 * (`tasks.search`) and kept only on an exact match. Nothing is guessed:
 * `F13-572` links nothing where no project F13 exists, however close
 * FI3-572 is.
 */
let boardRows = new Map<string, TaskView>();
let boardSeen = false;
let stopBoard: (() => void) | null = null;
const earlier = new Map<string, TaskView>();
const asked = new Set<string>();
const wanted = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Earlier work the board does not list, looked up once per key. */
function lookUp(key: string): void {
  if (asked.has(key) || boardRows.has(key)) return;
  asked.add(key);
  void window.infinitary.plugins
    .read("tasks.search", { query: key })
    .then((rows) => {
      const task = rows.find((row) => row.key === key);
      if (!task) return;
      earlier.set(key, task);
      changed();
    })
    .catch(() => {});
}

export const taskKeyIndex = {
  /** Asks for `keys` until the returned function lets them go. */
  watch(keys: readonly string[]): () => void {
    for (const key of keys) wanted.set(key, (wanted.get(key) ?? 0) + 1);
    if (!stopBoard) {
      stopBoard = appReadExecutor().subscribe(
        "tasks.board",
        {},
        {
          onValue: (value) => {
            boardRows = new Map((value as TaskBoard).tasks.map((row) => [row.key, row]));
            boardSeen = true;
            for (const key of wanted.keys()) lookUp(key);
            changed();
          },
          onError: () => {},
        },
      );
    } else if (boardSeen) {
      for (const key of keys) lookUp(key);
    }
    return () => {
      for (const key of keys) {
        const left = (wanted.get(key) ?? 1) - 1;
        if (left > 0) wanted.set(key, left);
        else wanted.delete(key);
      }
      if (wanted.size > 0 || !stopBoard) return;
      stopBoard();
      stopBoard = null;
      boardSeen = false;
    };
  },
  /** The recorded task with exactly this key, as last read, or undefined. */
  task(key: string): TaskView | undefined {
    return boardRows.get(key) ?? earlier.get(key);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  version(): number {
    return version;
  },
};

/**
 * Which of `wanted` link: each that is exactly a recorded task's key, other
 * than `own`'s, the task the words are about - a task's own key on its own
 * record or card stays text (FI3-1271).
 */
export function linkedKeys(
  wanted: readonly string[],
  task: (key: string) => Pick<TaskView, "id"> | undefined,
  own?: string,
): string[] {
  return wanted.filter((key) => {
    const named = task(key);
    return named !== undefined && named.id !== own;
  });
}

/** Finds which of the keys `text` writes are recorded tasks, leaving out `own`'s (`linkedKeys`). */
export function useTaskLinks(text: string, own?: string): TaskLinks {
  const wanted = useMemo(() => taskKeysIn(text).join(" "), [text]);
  useEffect(() => (wanted ? taskKeyIndex.watch(wanted.split(" ")) : undefined), [wanted]);
  const seen = useSyncExternalStore(
    taskKeyIndex.subscribe,
    taskKeyIndex.version,
    taskKeyIndex.version,
  );
  const last = useRef(NO_KEYS);
  const keys = useMemo(() => {
    void seen;
    const linked = linkedKeys(wanted ? wanted.split(" ") : [], taskKeyIndex.task, own);
    const kept = last.current.join(" ") === linked.join(" ") ? last.current : linked;
    last.current = kept.length === 0 ? NO_KEYS : kept;
    return last.current;
  }, [wanted, seen, own]);
  const task = useCallback(
    (key: string) => (keys.includes(key) ? taskKeyIndex.task(key) : undefined),
    [keys],
  );
  return useMemo(() => ({ keys, task }), [keys, task]);
}

/** What a body's frame is shown in: its card, with a thread beside it when one is open. */
const CARD_SURFACE = "[data-card-presentation]";

/**
 * A gesture on a linked key in the body shown in `frame` - a card's body or
 * a task's record: a rest opens the task's summary beside the card, level
 * with the key, as resting on its Tasks row does beside the panel; a leave
 * lets it go; an open lets it go and opens the task as a click on its Tasks
 * row does. A body the captain cannot act on now (`admitted` false) opens
 * nothing.
 */
export function taskKeyGesture(
  gesture: FrameTaskGesture,
  key: string,
  box: FrameBox | undefined,
  context: { frame: HTMLIFrameElement | null; links: TaskLinks; admitted: boolean },
): void {
  const { frame, links, admitted } = context;
  if (gesture !== "rest") taskPeek.release(frame);
  const task = links.task(key);
  if (!frame || !task || !admitted) return;
  if (gesture === "open") {
    void openTask({
      taskId: task.id,
      ...(task.waitingCardId ? { cardId: task.waitingCardId } : {}),
    }).catch(() => {});
    return;
  }
  if (gesture !== "rest" || !box) return;
  const at = frame.getBoundingClientRect();
  const card = (frame.closest(CARD_SURFACE) ?? frame).getBoundingClientRect();
  taskPeek.set({
    taskId: task.id,
    frame,
    key: {
      left: box.left + at.left,
      top: box.top + at.top,
      right: box.right + at.left,
      bottom: box.bottom + at.top,
    },
    card: { left: card.left, top: card.top, right: card.right, bottom: card.bottom },
  });
}
