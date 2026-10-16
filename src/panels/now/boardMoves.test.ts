import type { PanelTaskRow } from "@infinitary/contracts";
import { DROP_TASK_LABEL, dropConfirmLead, dropPartsRefusal } from "@infinitary/ui";
import { taskMovesOf } from "@shared/taskMoves";
import { describe, expect, it } from "vitest";
import {
  type BoardMenuEntry,
  type BoardMoveContext,
  type BoardTarget,
  boardMenuOf,
  boardMovable,
  boardMoveOf,
  dropAskOf,
  moveContextOf,
} from "./boardMoves";
import { type BoardLane, boardLaneOf } from "./boardTiles";

/**
 * What the task board does with a tile dropped on a lane, and what its ⋯
 * menu offers (./boardMoves.ts), driven through the functions the board
 * runs a drag and the menu from. Each row carries the moves the app's own
 * rule gives it (`taskMovesOf`), as the board read does. The writes
 * themselves, and the board in its page, are read off the real app by
 * tests/e2e/task-board-moves.spec.ts.
 */

function task(overrides: Partial<PanelTaskRow> = {}): PanelTaskRow {
  const { moves: _given, ...rest } = overrides;
  const row: PanelTaskRow = {
    id: "t1",
    key: "FI3-12",
    projectId: "proj-r1",
    parentId: null,
    kind: "work",
    title: "Ship the row chrome",
    goal: null,
    priority: 2,
    status: "open",
    activity: null,
    closedReason: null,
    startPolicy: "on-request",
    flags: { blocked: false, held: false, needsYou: false, ready: true },
    blockedBy: [],
    children: { total: 0, closed: 0 },
    assignee: null,
    model: null,
    repo: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 0,
    updatedAt: 1,
    startedAt: null,
    closedAt: null,
    ...rest,
  };
  // The app's own rule says which moves the row allows, as the board read carries it.
  const moves = taskMovesOf(row);
  return moves ? { ...row, moves } : row;
}

const NO_CARD: BoardMoveContext = { completionCardId: null };
const lane = (row: PanelTaskRow) => boardLaneOf(row) as BoardLane;
const move = (row: PanelTaskRow, target: BoardTarget, context = NO_CARD) =>
  boardMoveOf(row, lane(row), target, context);

const backlog = task();
const queued = task({ startPolicy: "when-ready" });
const blocked = task({
  blockedBy: ["FI3-3"],
  flags: { blocked: true, held: false, needsYou: false, ready: false },
});
const held = task({ flags: { blocked: false, held: true, needsYou: false, ready: false } });
const parent = task({ children: { total: 2, closed: 1 } });
const working = task({
  status: "active",
  activity: "running",
  startedAt: 5,
  assignee: "crewmate 4",
});
const interrupted = task({ ...working, activity: "interrupted" });
const waiting = task({ ...working, activity: "idle", waitingCardId: "card-1" });
const done = task({ status: "done", closedReason: "merged", closedAt: 9, startedAt: 5 });
const dropped = task({ status: "dropped", closedReason: "cancelled", closedAt: 9 });

describe("the task board's moves", () => {
  it("moves never-started work between Backlog and Queued, asking only when it could start at once", () => {
    expect(move(backlog, "queued")).toMatchObject({
      kind: "ask",
      op: "queue-task",
      confirm: "Queue it",
      sentence: expect.stringContaining("can begin at once"),
    });
    // While a blocker or hold stands it queues at once, keeping either.
    expect(move(blocked, "queued")).toMatchObject({
      kind: "now",
      op: "queue-task",
      done: "FI3-12 moved to Queued. It starts on its own once FI3-3 is done.",
    });
    expect(move(held, "queued")).toMatchObject({ kind: "now", op: "queue-task" });
    expect(move(queued, "backlog")).toMatchObject({ kind: "now", op: "unqueue-task" });
    // A parent's parts are the work, either way.
    expect(move(parent, "queued").kind).toBe("refused");
    expect(move(task({ ...parent, startPolicy: "when-ready" }), "backlog").kind).toBe("refused");
    // Work that started once and went back to the queue stays where its work put it.
    expect(move(task({ startedAt: 3 }), "queued")).toMatchObject({
      kind: "refused",
      text: expect.stringContaining("already started"),
    });
  });

  it("makes Working the record's Start, asking once, and refuses what the record would not start", () => {
    expect(move(backlog, "working")).toMatchObject({
      kind: "ask",
      op: "start-task",
      confirm: "Start",
    });
    expect(move(blocked, "working")).toEqual({
      kind: "refused",
      text: "FI3-3 must finish first. The dependency stays.",
    });
    for (const row of [held, parent, queued]) expect(move(row, "working").kind).toBe("refused");
    expect(move(waiting, "working").kind).toBe("refused");
  });

  it("never takes a drop on Waiting on you, never moves started work back, and a lane's own drop changes nothing", () => {
    for (const row of [backlog, queued, working]) {
      expect(move(row, "waiting")).toMatchObject({ kind: "refused" });
    }
    expect(move(working, "backlog")).toMatchObject({
      kind: "refused",
      text: expect.stringContaining("already started"),
    });
    expect(move(working, "queued").kind).toBe("refused");
    expect(move(backlog, "backlog").kind).toBe("none");
    expect(move(working, "working").kind).toBe("none");
    // A waiting tile goes nowhere but Drop task, or Done to its completion card.
    for (const target of ["backlog", "queued", "working"] as const) {
      expect(move(waiting, target)).toMatchObject({
        kind: "refused",
        text: "Answer its card first. Moving it cannot dismiss that decision.",
      });
    }
  });

  it("reads its completion card off the row: a waiting card that settles with a merge", () => {
    expect(moveContextOf(waiting)).toEqual({ completionCardId: null });
    expect(moveContextOf({ ...waiting, waitingCardMerges: true })).toEqual({
      completionCardId: "card-1",
    });
    expect(moveContextOf({ ...backlog, waitingCardMerges: true })).toEqual({
      completionCardId: null,
    });
  });

  it("brings the completion card forward on Done while it is up, and never merges", () => {
    expect(move(waiting, "landed", { completionCardId: "card-1" })).toMatchObject({
      kind: "card",
      cardId: "card-1",
    });
    expect(move(waiting, "landed").kind).toBe("refused");
    expect(move(backlog, "landed").kind).toBe("refused");
  });

  it("drops through the record's Drop task, asking once in its words, and refuses open parts", () => {
    expect(move(backlog, "drop")).toEqual({
      kind: "ask",
      op: "drop-task",
      sentence: dropConfirmLead("FI3-12"),
      confirm: DROP_TASK_LABEL,
    });
    expect(move(working, "drop")).toEqual({
      kind: "ask",
      op: "stop-task",
      sentence: dropConfirmLead("FI3-12", true),
      confirm: DROP_TASK_LABEL,
    });
    expect(move(waiting, "drop")).toMatchObject({ kind: "ask", op: "stop-task" });
    expect(move(parent, "drop").kind).toBe("refused");
    // With the record's effects, the sentence is the record's own, and so is its refusal.
    const effects = {
      parts: [],
      waiting: [{ key: "FI3-20", title: "Use it" }],
      underway: [],
    };
    expect(dropAskOf("FI3-12", effects)).toEqual({
      kind: "ask",
      sentence: `${dropConfirmLead("FI3-12")} FI3-20 is still waiting on this work. Dropping this task will not start it.`,
      review: { parts: [], waiting: ["FI3-20"], underway: [] },
    });
    const parts = [{ key: "FI3-13", title: "A part", started: false }];
    expect(dropAskOf("FI3-12", { parts, waiting: [], underway: [] })).toEqual({
      kind: "refused",
      text: dropPartsRefusal("FI3-12", parts),
    });
  });

  it("never picks up Done or Dropped tiles", () => {
    expect(boardMovable("landed")).toBe(false);
    expect(boardMovable("dropped")).toBe(false);
    expect(move(done, "backlog").kind).toBe("refused");
    expect(move(dropped, "drop").kind).toBe("refused");
  });
});

const labels = (entries: BoardMenuEntry[]) =>
  entries.map((entry) => ("separator" in entry ? "---" : entry.label));

describe("a tile's ⋯ menu", () => {
  it("offers on backlog work what its drops do, with Drop task last in danger", () => {
    const entries = boardMenuOf(backlog, "backlog", NO_CARD);
    expect(labels(entries)).toEqual(["Open record", "Queue it", "Start now", "---", "Drop task"]);
    expect(entries[1]).toMatchObject({
      detail: "May start at once · asks once",
      target: "queued",
      disabled: false,
    });
    expect(entries[2]).toMatchObject({
      detail: "Asks once · the record's Start",
      target: "working",
    });
    expect(entries.at(-1)).toMatchObject({ danger: true, target: "drop", detail: "Asks once" });
  });

  it("keeps an entry that cannot run listed, dim, with its reason", () => {
    const entries = boardMenuOf(blocked, "backlog", NO_CARD);
    expect(entries[1]).toMatchObject({
      label: "Queue it",
      detail: "Starts by itself once FI3-3 is done · at once",
      disabled: false,
    });
    expect(entries[2]).toMatchObject({
      label: "Start now",
      detail: "FI3-3 must finish first. The dependency stays.",
      disabled: true,
    });
    const queuedEntries = boardMenuOf(queued, "queued", NO_CARD);
    expect(labels(queuedEntries)).toEqual([
      "Open record",
      "Back to backlog",
      "Start now",
      "---",
      "Drop task",
    ]);
    expect(queuedEntries[1]).toMatchObject({ detail: "Waits for your word again · at once" });
    expect(queuedEntries[2]).toMatchObject({ disabled: true });
    expect(boardMenuOf(parent, "backlog", NO_CARD).at(-1)).toMatchObject({ disabled: true });
  });

  it("offers Show the card on waiting work and Continue on interrupted work, and nothing on closed work", () => {
    expect(labels(boardMenuOf(waiting, "waiting", NO_CARD))).toEqual([
      "Open record",
      "Show the card",
      "---",
      "Drop task",
    ]);
    expect(labels(boardMenuOf(interrupted, "working", NO_CARD))).toEqual([
      "Open record",
      "Continue",
      "---",
      "Drop task",
    ]);
    expect(labels(boardMenuOf(working, "working", NO_CARD))).toEqual([
      "Open record",
      "---",
      "Drop task",
    ]);
    expect(boardMenuOf(done, "landed", NO_CARD)).toEqual([]);
    expect(boardMenuOf(dropped, "dropped", NO_CARD)).toEqual([]);
  });
});
