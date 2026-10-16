import { describe, expect, it } from "vitest";
import type { Card } from "./cards";
import { cardMerges, type TaskMovesInput, taskMovesOf } from "./taskMoves";
import type { TaskView } from "./tasks";
import { presentTask } from "./taskWaiting";

/**
 * Which of the six moves a task allows now, and why not (docs/ui-plugins.md,
 * "A panel's cards", piece 4): the task record's own rule, read from the
 * task's typed fields, so a panel says what the record's buttons would.
 */

function task(patch: Partial<TaskMovesInput> = {}): TaskMovesInput {
  return {
    key: "FM-1",
    kind: "work",
    status: "open",
    activity: null,
    closedReason: null,
    startPolicy: "on-request",
    flags: { blocked: false, held: false, needsYou: false, ready: true },
    waitingCardId: null,
    startedAt: null,
    children: { total: 0, closed: 0 },
    blockedBy: [],
    ...patch,
  };
}

const allowed = (input: TaskMovesInput) =>
  Object.entries(taskMovesOf(input) ?? {})
    .filter(([, allowance]) => allowance.ok)
    .map(([op]) => op);

describe("taskMovesOf", () => {
  it("lets never-started work in the backlog start, drop and queue", () => {
    expect(allowed(task())).toEqual(["start-task", "drop-task", "queue-task"]);
    expect(taskMovesOf(task())?.["unqueue-task"]).toEqual({
      ok: false,
      text: "It already waits for your word.",
    });
  });

  it("lets queued work go back to the backlog or drop, and says why it does not start", () => {
    const queued = task({ startPolicy: "when-ready" });
    expect(allowed(queued)).toEqual(["drop-task", "unqueue-task"]);
    expect(taskMovesOf(queued)?.["start-task"]).toEqual({
      ok: false,
      text: "It is queued. It starts by itself once nothing holds it.",
    });
  });

  it("names what blocked work waits on", () => {
    const blocked = task({
      blockedBy: ["FM-2", "FM-3"],
      flags: { blocked: true, held: false, needsYou: false, ready: false },
    });
    expect(taskMovesOf(blocked)?.["start-task"]).toEqual({
      ok: false,
      text: "FM-2 and FM-3 must finish first.",
    });
  });

  it("lets started work stop, and interrupted work continue", () => {
    const working = task({ status: "active", activity: "running", startedAt: 5 });
    expect(allowed(working)).toEqual(["stop-task"]);
    expect(taskMovesOf(working)?.["drop-task"]).toMatchObject({ ok: false });
    expect(allowed(task({ status: "active", activity: "interrupted", startedAt: 5 }))).toEqual([
      "stop-task",
      "continue-task",
    ]);
  });

  it("keeps a parent's parts as the work, and refuses its drop while they are open", () => {
    const parent = task({ children: { total: 2, closed: 1 } });
    expect(allowed(parent)).toEqual([]);
    expect(taskMovesOf(parent)?.["drop-task"]).toEqual({
      ok: false,
      text: "Its parts are still open. Drop those first.",
    });
  });

  it("offers dropped work only Start again, unless replaced or containing parts", () => {
    expect(allowed(task({ status: "dropped" }))).toEqual(["start-again"]);
    expect(allowed(task({ status: "dropped", replacedBy: "FI3-8" }))).toEqual([]);
    expect(allowed(task({ status: "dropped", children: { total: 1, closed: 1 } }))).toEqual([]);
  });

  it("gives Done work, decisions and questions no moves at all", () => {
    expect(taskMovesOf(task({ status: "done" }))).toBeUndefined();
    expect(taskMovesOf(task({ kind: "decision" }))).toBeUndefined();
  });

  it("knows a card that merges by its settle action", () => {
    expect(
      cardMerges({
        actions: [
          { id: "merge", label: "Merge", effect: { kind: "settle", mode: "merge" } },
        ] as never,
      }),
    ).toBe(true);
    expect(cardMerges({ actions: [{ id: "ok", label: "OK" }] as never })).toBe(false);
    expect(cardMerges(undefined)).toBe(false);
  });
});

describe("the moves as the stack presents a task (presentTask)", () => {
  const view = {
    ...task({ status: "active", activity: "idle", startedAt: 5 }),
    id: "t1",
    waitingCardId: "card-1",
    waitingCardMerges: true,
  } as unknown as TaskView;
  const merging = {
    id: "card-2",
    taskId: "t1",
    status: "ready",
    actions: [{ id: "merge", label: "Merge", effect: { kind: "settle", mode: "merge" } }],
  } as unknown as Card;

  it("drops a merge it cannot show, and takes a sibling's", () => {
    const masked = presentTask({ ...view, moves: taskMovesOf(view) }, []);
    expect(masked.waitingCardId).toBeNull();
    expect(masked.waitingCardMerges).toBeUndefined();
    expect(masked.moves?.["stop-task"]).toEqual({ ok: true });
    const sibling = presentTask(view, [merging]);
    expect(sibling).toMatchObject({ waitingCardId: "card-2", waitingCardMerges: true });
    // Nothing moved: the same row back.
    const shown = { ...view, waitingCardId: "card-2" };
    expect(presentTask(shown, [merging])).toBe(shown);
  });
});
