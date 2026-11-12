import { TASK_KEYS_PER_READ } from "@shared/channels/tasks";
import type { FrameBox, FrameTaskGesture } from "@shared/plugins/bridge";
import { taskKeysIn } from "@shared/taskKeys";
import type { TaskBoard, TaskView } from "@shared/tasks";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useLitTaskId } from "../plugins/point/litTask";
import { openTaskFromKey } from "../plugins/point/openTask";
import { taskPeek } from "../plugins/point/taskPeek";
import { appReadExecutor } from "../plugins/reads/appExecutor";

/**
 * The tasks a body or a line names (FI3-594, FI3-1271; the design skill's
 * core rule "Task keys"): `keys` are the keys the words write that are
 * exactly a recorded task's key, other than the task they are about, and
 * `task` reads that task as it is now. `lit` is the one of those keys a rest
 * elsewhere in the window lights (INF-237), or null.
 */
export type TaskLinks = {
  keys: readonly string[];
  lit: string | null;
  task: (key: string) => TaskView | undefined;
};

const NO_KEYS: readonly string[] = [];

/**
 * Which keys name recorded tasks, for every place the window draws a key:
 * one store for the whole window. While anything asks, it reads the board
 * once without its closed rows, which answers for live work and keeps each
 * task current; every key the board does not list is looked up once by its
 * exact key, all of a turn's keys in one read (`tasks.keys`). Nothing is guessed:
 * `F13-572` links nothing where no project F13 exists, however close
 * FI3-572 is.
 */
let boardRows = new Map<string, TaskView>();
/** The same rows by id, and the row waiting on each card (`waitingCardId`). */
let boardById = new Map<string, TaskView>();
let boardByCard = new Map<string, TaskView>();
let boardSeen = false;
let stopBoard: (() => void) | null = null;
const earlier = new Map<string, TaskView>();
const asked = new Set<string>();
const wanted = new Map<string, number>();
/** How many readers hold the board for its rows alone (`hold`), naming no key. */
let holds = 0;
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Keys waiting for the next lookup, sent together once the current turn ends. */
const pending = new Set<string>();
let flushQueued = false;

/**
 * A key the board does not list, looked up once: every such key the window
 * asks for in one turn goes in one exact-key read (`tasks.keys`), which
 * finds live work and work closed at any age, this week's included
 * (INF-3896). A key that names no task stays text.
 */
function lookUp(key: string): void {
  if (asked.has(key) || boardRows.has(key)) return;
  asked.add(key);
  pending.add(key);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flushLookups);
}

function flushLookups(): void {
  flushQueued = false;
  const keys = [...pending];
  pending.clear();
  for (let at = 0; at < keys.length; at += TASK_KEYS_PER_READ) {
    void window.infinitary.plugins
      .read("tasks.keys", { keys: keys.slice(at, at + TASK_KEYS_PER_READ) })
      .then(found)
      .catch(() => {
        // A home built before this read answers each key's search of earlier work.
        for (const key of keys.slice(at, at + TASK_KEYS_PER_READ)) {
          void window.infinitary.plugins
            .read("tasks.search", { query: key })
            .then((rows) => found(rows.filter((row) => row.key === key)))
            .catch(() => {});
        }
      });
  }
}

function found(rows: readonly TaskView[]): void {
  if (rows.length === 0) return;
  for (const task of rows) earlier.set(task.key, task);
  changed();
}

/** The board is read while any key is wanted or any reader holds it. */
function readBoard(): void {
  if (stopBoard) return;
  stopBoard = appReadExecutor().subscribe(
    "tasks.board",
    { closed: false },
    {
      onValue: (value) => {
        const rows = (value as TaskBoard).tasks;
        boardRows = new Map(rows.map((row) => [row.key, row]));
        boardById = new Map(rows.map((row) => [row.id, row]));
        boardByCard = new Map(
          rows.flatMap((row) => (row.waitingCardId ? [[row.waitingCardId, row] as const] : [])),
        );
        boardSeen = true;
        for (const key of wanted.keys()) lookUp(key);
        changed();
      },
      onError: () => {},
    },
  );
}

/** Lets the board go once nothing wants a key and nothing holds it. */
function releaseBoard(): void {
  if (wanted.size > 0 || holds > 0 || !stopBoard) return;
  stopBoard();
  stopBoard = null;
  boardSeen = false;
}

export const taskKeyIndex = {
  /** Asks for `keys` until the returned function lets them go. */
  watch(keys: readonly string[]): () => void {
    for (const key of keys) wanted.set(key, (wanted.get(key) ?? 0) + 1);
    if (!stopBoard) readBoard();
    else if (boardSeen) for (const key of keys) lookUp(key);
    return () => {
      for (const key of keys) {
        const left = (wanted.get(key) ?? 1) - 1;
        if (left > 0) wanted.set(key, left);
        else wanted.delete(key);
      }
      releaseBoard();
    };
  },
  /**
   * Keeps the board read for its rows (`byId`, `waitingOn`) until the
   * returned function lets it go: a card's head asks for its task this way.
   */
  hold(): () => void {
    holds += 1;
    readBoard();
    return () => {
      holds -= 1;
      releaseBoard();
    };
  },
  /** The recorded task with exactly this key, as last read, or undefined. */
  task(key: string): TaskView | undefined {
    return boardRows.get(key) ?? earlier.get(key);
  },
  /** The board's row for the task `id`, as last read, or undefined. */
  byId(id: string): TaskView | undefined {
    return boardById.get(id);
  },
  /** The key of the recorded task `id`, on the board or among the earlier work looked up, or undefined. */
  keyOf(id: string): string | undefined {
    const row = boardById.get(id);
    if (row) return row.key;
    for (const task of earlier.values()) if (task.id === id) return task.key;
    return undefined;
  },
  /** The board's row whose waiting decision is the card `cardId`, or undefined. */
  waitingOn(cardId: string): TaskView | undefined {
    return boardByCard.get(cardId);
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
  const litId = useLitTaskId();
  const litKey = litId === null ? undefined : taskKeyIndex.keyOf(litId);
  const lit = litKey !== undefined && keys.includes(litKey) ? litKey : null;
  return useMemo(() => ({ keys, lit, task }), [keys, lit, task]);
}

/** What a body's frame is shown in: its card, with a thread beside it when one is open. */
const CARD_SURFACE = "[data-card-presentation]";

/**
 * A gesture on a linked key in the body shown in `frame` - a card's body or
 * a task's record: a rest opens the task's summary beside the card, level
 * with the key, as resting on its Tasks row does beside the panel; a leave
 * lets it go; an open lets it go and opens the task’s record in front of the card. A body the captain cannot act on now (`admitted` false) opens
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
    void openTaskFromKey(task).catch(() => {});
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
