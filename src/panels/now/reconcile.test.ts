import type { PanelProject, PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import { describe, expect, it } from "vitest";
import { reconcileBoard, reconcileRows, sameValue } from "./reconcile";
import { rowsOf } from "./rows";

/**
 * INF-2105, on INF-2078's accepted plan ("every row stays in the page; only
 * the redraw and the measuring are narrowed to what changed"): a pushed
 * board, which crosses the bridge as a new copy, keeps the panel's own
 * object for every task and project the change never touched, so the
 * panel's memoized rows paint only what changed, and keeps the whole board
 * when nothing listed moved.
 */

function task(overrides: Partial<PanelTaskRow> = {}): PanelTaskRow {
  return {
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
    ...overrides,
  };
}

function project(overrides: Partial<PanelProject> = {}): PanelProject {
  return {
    id: "proj-r1",
    key: "FI3",
    name: "firstmate-3000",
    repo: { name: "firstmate-3000" },
    archived: false,
    counts: { needsYou: 0, waitingOnYou: 0, open: 1, active: 0, doneRecent: 0 },
    ...overrides,
  };
}

/** A push: the same rows as a fresh copy, the way a structured clone lands. */
function pushed(board: PanelTaskBoard, overrides: Partial<PanelTaskBoard> = {}): PanelTaskBoard {
  return { ...structuredClone(board), seq: board.seq + 1, at: board.at + 1, ...overrides };
}

describe("reconciling a pushed board against the one the panel holds", () => {
  const held: PanelTaskBoard = {
    seq: 1,
    at: 1,
    projects: [project()],
    tasks: [task(), task({ id: "t2", key: "FI3-13" }), task({ id: "t3", key: "FI3-14" })],
  };

  it("takes the first board as it is", () => {
    const first = pushed(held);
    expect(reconcileBoard(null, first)).toBe(first);
  });

  it("keeps the held board when every row reads the same", () => {
    expect(reconcileBoard(held, pushed(held))).toBe(held);
  });

  it("keeps every untouched row's object and replaces only the changed one", () => {
    const next = pushed(held);
    (next.tasks[1] as PanelTaskRow).title = "Ship the row chrome, again";
    const kept = reconcileBoard(held, next);
    expect(kept).not.toBe(held);
    expect(kept.seq).toBe(next.seq);
    expect(kept.tasks[0]).toBe(held.tasks[0]);
    expect(kept.tasks[1]).toBe(next.tasks[1]);
    expect(kept.tasks[2]).toBe(held.tasks[2]);
    expect(kept.projects).toBe(held.projects);
  });

  it("keeps the rows around an added, removed or moved one", () => {
    const added = pushed(held, {
      tasks: [...structuredClone(held.tasks), task({ id: "t4", key: "FI3-15" })],
    });
    const withAdded = reconcileBoard(held, added);
    for (const [index, row] of held.tasks.entries()) expect(withAdded.tasks[index]).toBe(row);
    expect(withAdded.tasks[3]).toBe(added.tasks[3]);

    const removed = pushed(held, { tasks: structuredClone(held.tasks.slice(1)) });
    const withRemoved = reconcileBoard(held, removed);
    expect(withRemoved.tasks).toHaveLength(2);
    expect(withRemoved.tasks[0]).toBe(held.tasks[1]);
    expect(withRemoved.tasks[1]).toBe(held.tasks[2]);

    const moved = pushed(held, { tasks: structuredClone([...held.tasks].reverse()) });
    const withMoved = reconcileBoard(held, moved);
    expect(withMoved.tasks).not.toBe(held.tasks);
    expect(withMoved.tasks[0]).toBe(held.tasks[2]);
    expect(withMoved.tasks[2]).toBe(held.tasks[0]);
  });

  it("replaces the projects when one changed and keeps the rows", () => {
    const next = pushed(held, { projects: [project({ name: "renamed" })] });
    const kept = reconcileBoard(held, next);
    expect(kept.projects).not.toBe(held.projects);
    expect(kept.projects[0]).toBe(next.projects[0]);
    expect(kept.tasks).toBe(held.tasks);
  });

  it("reads a nested change as a change", () => {
    const next = pushed(held);
    (next.tasks[2] as PanelTaskRow).flags.blocked = true;
    const kept = reconcileBoard(held, next);
    expect(kept.tasks[2]).toBe(next.tasks[2]);
    const withBlocker = pushed(held);
    (withBlocker.tasks[2] as PanelTaskRow).blockedBy = ["FI3-12"];
    expect(reconcileBoard(held, withBlocker).tasks[2]).toBe(withBlocker.tasks[2]);
  });
});

it("keeps an unchanged group's full row list across crew writes (INF-2221)", () => {
  // The unchanged latency bar and INF-2078's accepted all-rows choice:
  // changing Working must not rebuild Landed's elements, while changes to
  // its data, order or membership must still reach the rendered list.
  const working = task({ activity: "running", status: "active" });
  const earlier = task({
    id: "earlier",
    key: "FI3-13",
    status: "done",
    closedReason: "merged",
    closedAt: 1,
  });
  const latest = task({
    id: "latest",
    key: "FI3-14",
    status: "done",
    closedReason: "merged",
    closedAt: 2,
  });
  const board: PanelTaskBoard = {
    seq: 1,
    at: 1,
    projects: [project()],
    tasks: [working, earlier, latest],
  };
  const filter = { query: "", projectId: null };
  const held = rowsOf(board, filter);
  const landed = held.get("landed");
  expect(landed).toHaveLength(2);
  expect(reconcileRows(held, rowsOf(board, filter))).toBe(held);

  const nextBoard = {
    ...board,
    tasks: [{ ...working, title: "Verify task navigation" }, earlier, latest],
  };
  const derived = rowsOf(nextBoard, filter);
  const expectedRows = structuredClone(derived);
  const next = reconcileRows(held, derived);
  expect(next).toEqual(expectedRows);
  expect(next.get("landed")).toBe(landed);
  expect(next.get("working")).not.toBe(held.get("working"));

  const reordered = rowsOf({ ...board, tasks: [...board.tasks].reverse() }, filter);
  const reorderedGroups = [...reordered.keys()];
  const reorderedResult = reconcileRows(held, reordered);
  expect([...reorderedResult.keys()]).toEqual(reorderedGroups);
  expect(reorderedResult.get("landed")).toBe(landed);

  for (const tasks of [
    [working, { ...earlier, title: "Review task navigation" }, latest],
    [working, { ...earlier, closedAt: 3 }, latest],
    [working, earlier],
    [working],
  ]) {
    const expected = rowsOf({ ...board, tasks }, filter);
    const expectedRows = structuredClone(expected);
    const result = reconcileRows(held, expected);
    expect(result).toEqual(expectedRows);
    expect(result).not.toBe(held);
    expect(result.get("landed")).not.toBe(landed);
  }
});

describe("structural equality over what crosses the bridge", () => {
  it("compares primitives, arrays and plain objects by value", () => {
    expect(sameValue({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(sameValue({ a: [1, { b: null }] }, { a: [1, { b: undefined }] })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue([], {})).toBe(false);
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
  });
});
