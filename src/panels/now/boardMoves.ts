import type {
  PanelDropReview,
  PanelTaskDetail,
  PanelTaskMove,
  PanelTaskRow,
} from "@infinitary/contracts";
import {
  DROP_TASK_LABEL,
  dropConfirmLead,
  dropPartsLine,
  dropReviewKeys,
  dropUnderwayLine,
  dropWaitingLine,
  PIN_LABEL,
  taskStatusOf,
  UNPIN_LABEL,
} from "@infinitary/ui";
import type { BoardColumn, BoardLane } from "./boardTiles";
import { isCardOnly } from "./rows";

/** What Drop task would affect, as `tasks.detail` lists it. */
type DropEffects = NonNullable<PanelTaskDetail["dropEffects"]>;

/**
 * What the task board does with a tile moved onto a lane (docs/task-board.md,
 * "Moves"; FI3-979 piece 3). Pure, so a drag, the ⋯ menu and a unit test
 * read the same rules: every move is one of the six the panel API runs
 * (`tasks.run`: Start, Drop task, queue and unqueue, through the task
 * record's own path), or points at the task's card, and none changes
 * priority, order, project, parent or dependencies. Which of the record's
 * ends a drop takes is the row's own say (`moves`, from the record's rule).
 *
 * - Backlog takes never-started work at once: it waits for the captain's
 *   word again, its blockers and holds kept. It takes started work at once
 *   too (INF-2062): its turn stops, its work stays, and nothing wakes it
 *   until Start, which asks once and picks it up in the same conversation.
 * - Queued takes never-started work with no parts: at once while a blocker
 *   or hold stands, and after asking once when it could start at once.
 * - Working is the record's Start: it asks once, and refuses blocked, held,
 *   parent, queued, started and closed work, except started work in the
 *   backlog, which it picks up again.
 * - Waiting on you is never a target: only a ready decision
 *   puts a task there.
 * - Done brings the task's completion card forward while one is up; the
 *   card merges, the drop never does.
 * - The Drop task tray is the record's Drop task: it asks once in the
 *   record's words and refuses open parts.
 * - A waiting tile goes nowhere but Drop task (and Done, to its completion
 *   card); Done and Dropped tiles never move; a drop on its own lane
 *   changes nothing.
 */

/** Where a tile can be dropped: a lane, or the foot's Drop task tray. */
export type BoardTarget = "waiting" | BoardColumn | "drop";

/** The facts beyond the task a move reads. */
export type BoardMoveContext = {
  /** The task's completion card while it is up on the stack, else null. */
  completionCardId: string | null;
};

/**
 * What a row says about its card: its waiting card settles with a merge
 * while it is up (`waitingCardMerges`), so that card is its completion card.
 */
export function moveContextOf(task: PanelTaskRow): BoardMoveContext {
  return {
    completionCardId: task.waitingCardMerges && task.waitingCardId ? task.waitingCardId : null,
  };
}

/** Open work that has never started: the record's Drop task, not its stop, ends it. */
export function isUnstartedWork(
  task: Pick<PanelTaskRow, "kind" | "status" | "startedAt" | "activity">,
): boolean {
  return (
    task.kind === "work" &&
    task.status === "open" &&
    task.startedAt == null &&
    task.activity == null
  );
}

/** A move that asks once on the tile where it landed: its sentence and its confirm button. */
export type BoardAsk = {
  kind: "ask";
  op: Extract<PanelTaskMove, "queue-task" | "start-task" | "drop-task" | "stop-task">;
  sentence: string;
  confirm: string;
};

export type BoardMove =
  /** The tile is already there: nothing changes. */
  | { kind: "none"; text: string }
  | { kind: "refused"; text: string }
  /** A move written at once: what it will do, and what it did once written. */
  | { kind: "now"; op: "queue-task" | "unqueue-task"; text: string; done: string }
  | BoardAsk
  /** Brings the task's completion card forward; it writes nothing. */
  | { kind: "card"; cardId: string; text: string };

export const QUEUE_LABEL = "Queue it";
export const UNQUEUE_LABEL = "Back to backlog";
export const START_LABEL = "Start";
export const START_NOW_LABEL = "Start now";
/** The board menu's Pin and Unpin sub-lines (INF-3127), which the phone's long press says too. */
export const PIN_DETAIL = "Keeps it at the top of Tasks · at once";
export const UNPIN_DETAIL = "Lists it under its state in Tasks again · at once";

/** The live line as a drag begins. */
export const DRAG_STARTED = "Drag to a column. Each one says what the drop would do.";
/** A move the captain cancelled, or a drag he let go of with Esc. */
export const MOVE_CANCELLED = "Cancelled. Nothing was written.";

/** "FM3K-3", "FM3K-3 and FM3K-4", "FM3K-3, FM3K-4 and FM3K-5". */
function keyList(keys: readonly string[]): string {
  if (keys.length <= 1) return keys[0] ?? "another task";
  return `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
}

const blockedOf = (task: PanelTaskRow) => task.flags.blocked || task.blockedBy.length > 0;
const hasParts = (task: PanelTaskRow) => task.children.total > 0;

/** Whether a tile in `lane` can be picked up at all: Done and Dropped tiles never move. */
export function boardMovable(lane: BoardLane): boolean {
  return lane !== "landed" && lane !== "dropped";
}

/** What dropping `task`, whose tile is in `from`, onto `target` does. */
export function boardMoveOf(
  task: PanelTaskRow,
  from: BoardLane,
  target: BoardTarget,
  context: BoardMoveContext,
): BoardMove {
  const key = task.key;
  if (!boardMovable(from)) {
    return { kind: "refused", text: "Closed work stays where it is. Open its record instead." };
  }
  if (target === from) {
    return {
      kind: "none",
      text: "Already here. The order follows priority and age, so this drop changes nothing.",
    };
  }
  if (target === "waiting") {
    return {
      kind: "refused",
      text: "Only a ready decision puts a task in Waiting on you.",
    };
  }
  if (target === "drop") return dropMoveOf(task);
  if (target === "landed") {
    return context.completionCardId
      ? {
          kind: "card",
          cardId: context.completionCardId,
          text: "Brings its merge card forward. The card merges; the drop never does.",
        }
      : {
          kind: "refused",
          text: "No merge card is up for it, so nothing can finish it from here.",
        };
  }
  if (from === "waiting") {
    return {
      kind: "refused",
      text: task.waitingCardId
        ? "Answer its card first. Moving it cannot dismiss that decision."
        : "It waits for you. Open its record; moving it cannot answer that wait.",
    };
  }
  if (from === "queued" && taskStatusOf(task).mark === "starting") {
    return { kind: "refused", text: "It is starting." };
  }
  if (task.status === "active") return startedMoveOf(task, from, target);
  if (from === "working" || !isUnstartedWork(task)) {
    return { kind: "refused", text: "It has already started." };
  }
  const blocked = blockedOf(task);
  const waitsOn = keyList(task.blockedBy);
  if (target === "backlog") {
    return hasParts(task)
      ? { kind: "refused", text: "Its parts are the work. Move a part, not the container." }
      : {
          kind: "now",
          op: "unqueue-task",
          text: "It now waits for your word. Its blockers and holds stay.",
          done: `${key} moved to Backlog. It waits for your word; its blockers and holds stay.`,
        };
  }
  if (target === "queued") {
    if (hasParts(task)) {
      return { kind: "refused", text: "Its parts are the work. Queue a part, not the container." };
    }
    if (blocked) {
      return {
        kind: "now",
        op: "queue-task",
        text: `Queued at once. It starts on its own once ${waitsOn} is done.`,
        done: `${key} moved to Queued. It starts on its own once ${waitsOn} is done.`,
      };
    }
    if (task.flags.held) {
      return {
        kind: "now",
        op: "queue-task",
        text: "Queued at once. It starts on its own once its hold ends.",
        done: `${key} moved to Queued. It starts on its own once its hold ends.`,
      };
    }
    return {
      kind: "ask",
      op: "queue-task",
      sentence: `Start automatically? ${key} can begin at once and spends your plan's allowance.`,
      confirm: QUEUE_LABEL,
    };
  }
  // Working: the record's Start.
  if (blocked) {
    return {
      kind: "refused",
      text: `${waitsOn} must finish first. ${task.blockedBy.length > 1 ? "The dependencies stay." : "The dependency stays."}`,
    };
  }
  if (task.flags.held) {
    return {
      kind: "refused",
      text: "It is held, so a drag cannot start it. Its record's Start can.",
    };
  }
  if (hasParts(task)) {
    return {
      kind: "refused",
      text: "Its parts are already planned. Start a part, not the container.",
    };
  }
  if (task.startPolicy === "when-ready") {
    return {
      kind: "refused",
      text: "It is already queued to start by itself. A drag cannot force a start.",
    };
  }
  return {
    kind: "ask",
    op: "start-task",
    sentence: `Start ${key} now? It spends your plan's allowance; what it waits on is checked again first.`,
    confirm: START_LABEL,
  };
}

/**
 * Started work (INF-2062): Backlog stops its turn and keeps its work, at
 * once; from the backlog, Working is Start, which asks once. Queued never
 * takes started work.
 */
function startedMoveOf(task: PanelTaskRow, from: BoardLane, target: BoardColumn): BoardMove {
  const key = task.key;
  if (target === "backlog") {
    return task.moves?.["unqueue-task"].ok === false
      ? { kind: "refused", text: task.moves["unqueue-task"].text }
      : {
          kind: "now",
          op: "unqueue-task",
          text: STARTED_BACKLOG_TEXT,
          done: `${key} moved to Backlog. Its work is kept; Start picks it up.`,
        };
  }
  if (target === "working" && from === "backlog") {
    return {
      kind: "ask",
      op: "start-task",
      sentence: `Start ${key} again? Its crewmate carries on in the same conversation and spends your plan's allowance.`,
      confirm: START_LABEL,
    };
  }
  return {
    kind: "refused",
    text:
      from === "backlog"
        ? "It has already started. Start picks it up from the backlog."
        : "It has already started.",
  };
}

/** What Back to backlog does to started work, before and as it moves. */
export const STARTED_BACKLOG_TEXT = "Its turn stops and its work stays. It waits for your Start.";

/** The Drop task tray: the record's own Drop task, which asks once. */
function dropMoveOf(task: PanelTaskRow): BoardMove {
  // The record's end, as the row says it: Drop task before the work
  // starts, its stop once it has.
  if (task.moves?.["drop-task"].ok) {
    return {
      kind: "ask",
      op: "drop-task",
      sentence: dropConfirmLead(task.key),
      confirm: DROP_TASK_LABEL,
    };
  }
  if (task.moves?.["stop-task"].ok) {
    return {
      kind: "ask",
      op: "stop-task",
      sentence: dropConfirmLead(task.key, true),
      confirm: DROP_TASK_LABEL,
    };
  }
  return { kind: "refused", text: "This task cannot be dropped here. Open its record instead." };
}

/**
 * The record's own confirmation for never-started work, read from the
 * effects its record lists (`tasks.detail`'s `dropEffects`): the sentence the
 * record asks with, saying its open parts stay planned, and the review the
 * host checks again.
 */
export function dropAskOf(
  key: string,
  effects: DropEffects | null | undefined,
): { kind: "ask"; sentence: string; review: PanelDropReview } | { kind: "refused"; text: string } {
  if (!effects)
    return { kind: "refused", text: `${key} changed. Look at it again before dropping it.` };
  return {
    kind: "ask",
    sentence: [
      dropConfirmLead(key),
      dropPartsLine(effects.parts),
      dropWaitingLine(effects.waiting),
      dropUnderwayLine(effects.underway),
    ]
      .filter(Boolean)
      .join(" "),
    review: dropReviewKeys(effects),
  };
}

/** What Pin or Unpin did, for the live line. */
export function boardPinText(key: string, pinned: boolean): string {
  return pinned ? `${key} is pinned to the top of Tasks.` : `${key} is unpinned.`;
}

/** What a confirmed move or a menu entry the host accepted did, for the live line. */
export function boardDoneText(key: string, op: PanelTaskMove): string {
  switch (op) {
    case "show-card":
      return `${key}'s card is shown.`;
    case "queue-task":
      return `${key} is queued. It may start at once.`;
    case "unqueue-task":
      return `${key} moved to Backlog. It waits for your word; its work, blockers and holds stay.`;
    case "start-again":
      return `${key} started again as a new task.`;
    case "start-task":
      return `${key} is starting.`;
    case "continue-task":
      return `${key}'s crewmate was told to carry on.`;
    case "drop-task":
      return `${key} dropped. Its record stays.`;
    case "stop-task":
      return `${key} dropped. A copy of its unfinished work is kept.`;
  }
}

/** One entry of a tile's ⋯ menu: what it is called, what it does, and why it cannot run. */
export type BoardMenuEntry =
  | {
      id: "open" | "card" | "pin" | "continue" | "queue" | "unqueue" | "start" | "drop";
      label: string;
      /** The sub-line under the label: what it does, or why it cannot. */
      detail?: string;
      disabled?: boolean;
      danger?: boolean;
      /** The move it makes, exactly as the matching drop does; none for Open record, Show the card or Continue. */
      target?: BoardTarget;
    }
  | { separator: true };

/**
 * A tile's ⋯ menu, the pointer's and the keyboard's way to do what a drag
 * does: Open record; Show the card while a decision waits; Continue on
 * interrupted work; Queue it or Back to backlog and Start now on open work;
 * Back to backlog on started work, and Start now on started work in the
 * backlog (INF-2062); Pin or Unpin, which keeps the task at the top of
 * Tasks (INF-3127); then Drop task, last, in danger. An entry that cannot run stays listed,
 * dim, with its reason. Done and Dropped tiles have no menu.
 */
export function boardMenuOf(
  task: PanelTaskRow,
  lane: BoardLane,
  context: BoardMoveContext,
): BoardMenuEntry[] {
  if (isCardOnly(task)) return [{ id: "card", label: "Show the card" }];
  if (!boardMovable(lane)) return [];
  const entries: BoardMenuEntry[] = [{ id: "open", label: "Open record" }];
  if (lane === "waiting" && (task.waitingCardId || task.minimizedCardId))
    entries.push({ id: "card", label: "Show the card" });
  if (lane === "working" && taskStatusOf(task).mark === "interrupted") {
    entries.push({
      id: "continue",
      label: "Continue",
      detail: "Picks the work up where it stopped",
    });
  }
  if (lane === "working" && task.status === "active") {
    const move = boardMoveOf(task, lane, "backlog", context);
    entries.push({
      id: "unqueue",
      label: UNQUEUE_LABEL,
      detail: move.kind === "refused" ? move.text : "Stops its turn, keeps its work · at once",
      disabled: move.kind === "refused",
      target: "backlog",
    });
  }
  if (lane === "backlog" || lane === "queued") {
    const target = lane === "backlog" ? "queued" : "backlog";
    const move = boardMoveOf(task, lane, target, context);
    entries.push({
      id: lane === "backlog" ? "queue" : "unqueue",
      label: lane === "backlog" ? QUEUE_LABEL : UNQUEUE_LABEL,
      detail:
        move.kind === "refused"
          ? move.text
          : lane === "queued"
            ? "Waits for your word again · at once"
            : move.kind === "ask"
              ? "May start at once · asks once"
              : blockedOf(task)
                ? `Starts by itself once ${keyList(task.blockedBy)} is done · at once`
                : "Starts by itself once its hold ends · at once",
      disabled: move.kind === "refused",
      target,
    });
    const start = boardMoveOf(task, lane, "working", context);
    entries.push({
      id: "start",
      label: START_NOW_LABEL,
      detail: start.kind === "refused" ? start.text : "Asks once · the record's Start",
      disabled: start.kind === "refused",
      target: "working",
    });
  }
  // After the moves, so the keys and the hand that walk a menu to a move find it where it was.
  entries.push(
    task.pinnedAt === undefined
      ? { id: "pin", label: PIN_LABEL, detail: PIN_DETAIL }
      : { id: "pin", label: UNPIN_LABEL, detail: UNPIN_DETAIL },
  );
  const drop = boardMoveOf(task, lane, "drop", context);
  entries.push(
    { separator: true },
    {
      id: "drop",
      label: DROP_TASK_LABEL,
      detail: drop.kind === "refused" ? drop.text : "Asks once",
      disabled: drop.kind === "refused",
      danger: true,
      target: "drop",
    },
  );
  return entries;
}
