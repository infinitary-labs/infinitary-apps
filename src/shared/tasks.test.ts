import { describe, expect, it } from "vitest";
import {
  applyTaskBoardDelta,
  diffTaskBoards,
  type ProjectView,
  sortBoardLinks,
  sortBoardTasks,
  type TaskBoard,
  type TaskLinkView,
  type TaskView,
  taskBoardDeltaSchema,
  taskBoardSchema,
} from "./tasks";

/**
 * The delta half of the task protocol (task-system P5, design section
 * 9.1): applying the diff of two boards to the first reproduces the
 * second, exactly, for boards of every shape a seeded generator can make -
 * rows added, changed and removed, edges added and removed, project counts
 * moved. The contract test in taskProtocol.push.test.ts proves the same over
 * the real writer; this one proves the pure functions the client relies
 * on, including the two refusals (a stale delta, a gap).
 */

/** A small deterministic PRNG, so a failure names its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function view(id: string, createdAt: number, overrides: Partial<TaskView> = {}): TaskView {
  return {
    id,
    key: `SCR-${id}`,
    projectId: "scratch",
    parentId: null,
    kind: "work",
    title: `Task ${id}`,
    goal: null,
    priority: 2,
    status: "open",
    activity: null,
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: true },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: null,
    model: null,
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function project(id: string, open: number): ProjectView {
  return {
    id,
    key: id.toUpperCase().slice(0, 3),
    name: id,
    repo: null,
    archived: false,
    counts: { needsYou: 0, waitingOnYou: 0, open, active: 0, doneRecent: 0 },
  };
}

function board(seq: number, tasks: TaskView[], links: TaskLinkView[], open: number): TaskBoard {
  return {
    seq,
    at: 1_000 + seq,
    projects: [project("scratch", open)],
    tasks: sortBoardTasks(tasks),
    links: sortBoardLinks(links),
  };
}

/** A random next board: some rows change, some go, some arrive, edges shuffle. */
function evolve(prev: TaskBoard, random: () => number, seq: number): TaskBoard {
  const tasks: TaskView[] = [];
  for (const task of prev.tasks) {
    const roll = random();
    if (roll < 0.15) continue;
    if (roll < 0.5) {
      tasks.push({
        ...task,
        title: `${task.title}!`,
        updatedAt: task.updatedAt + 1,
        flags: { ...task.flags, blocked: !task.flags.blocked },
      });
    } else {
      tasks.push(task);
    }
  }
  const arrivals = Math.floor(random() * 4);
  for (let index = 0; index < arrivals; index += 1) {
    tasks.push(view(`n${seq}-${index}`, Math.floor(random() * 50)));
  }
  const ids = tasks.map((task) => task.id);
  // Edges are a set on the board (one row per (from, to, type)).
  const links = new Map<string, TaskLinkView>();
  const edges = Math.floor(random() * Math.min(6, ids.length));
  for (let index = 0; index < edges; index += 1) {
    const from = ids[Math.floor(random() * ids.length)] as string;
    const to = ids[Math.floor(random() * ids.length)] as string;
    const type = random() < 0.5 ? "blocks" : "related";
    if (from !== to) links.set(`${from} ${to} ${type}`, { fromId: from, toId: to, type });
  }
  return board(
    seq,
    tasks,
    [...links.values()],
    tasks.filter((task) => task.status === "open").length,
  );
}

describe("the board delta (task-system P5)", () => {
  it("applying the diff of two boards to the first reproduces the second, for 200 random pairs", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = rng(seed);
      let prev = board(
        seed,
        Array.from({ length: Math.floor(random() * 8) }, (_, index) =>
          view(`t${index}`, Math.floor(random() * 50)),
        ),
        [],
        0,
      );
      for (let step = 1; step <= 3; step += 1) {
        const next = evolve(prev, random, prev.seq + step);
        const delta = diffTaskBoards(prev, next);
        expect(taskBoardDeltaSchema.parse(delta), `seed ${seed} step ${step}`).toEqual(delta);
        const applied = applyTaskBoardDelta(prev, delta);
        expect(applied, `seed ${seed} step ${step}`).toEqual(next);
        expect(taskBoardSchema.parse(applied)).toEqual(next);
        prev = next;
      }
    }
  });

  it("carries only what changed: unchanged rows and edges stay off the wire", () => {
    const a = view("a", 1);
    const b = view("b", 2);
    const prev = board(1, [a, b], [{ fromId: "a", toId: "b", type: "blocks" }], 2);
    const next = board(
      2,
      [a, { ...b, title: "B two", updatedAt: 3 }, view("c", 3)],
      [
        { fromId: "a", toId: "b", type: "blocks" },
        { fromId: "b", toId: "c", type: "related" },
      ],
      3,
    );
    const delta = diffTaskBoards(prev, next);
    expect(delta.upserts.map((task) => task.id)).toEqual(["b", "c"]);
    expect(delta.removed).toEqual([]);
    expect(delta.links).toEqual({
      added: [{ fromId: "b", toId: "c", type: "related" }],
      removed: [],
    });
    expect(delta.baseSeq).toBe(1);
    expect(delta.seq).toBe(2);
  });

  // INF-2078: the core keeps a row's view between pushes, so a row the
  // change did not reach is the same object on both boards, and the diff
  // of a 3,400-row board must not pay to serialize every row to learn that.
  it("knows a row kept by identity without reading it, and the edges by their array", () => {
    const serialized: string[] = [];
    const watched = (id: string, createdAt: number) =>
      Object.defineProperty(view(id, createdAt), "toJSON", {
        value(this: TaskView) {
          serialized.push(this.id);
          return { ...this };
        },
        enumerable: false,
      });
    const a = watched("a", 1);
    const b = watched("b", 2);
    const links: TaskLinkView[] = [{ fromId: "a", toId: "b", type: "blocks" }];
    const prev = board(1, [a, b], links, 2);
    // The same row objects and the same edge array: nothing moved, nothing read.
    const kept = diffTaskBoards(prev, { ...board(2, [a, b], [], 2), links });
    expect(kept.upserts).toEqual([]);
    expect(kept.links).toEqual({ added: [], removed: [] });
    expect(serialized).toEqual([]);
    // A rebuilt row is compared, and only it; an edge array built again
    // with the same edges adds and removes nothing.
    const next = board(3, [a, { ...view("b", 2), title: "B two" }], [...links], 2);
    const moved = diffTaskBoards(prev, next);
    expect(moved.upserts.map((task) => task.id)).toEqual(["b"]);
    expect(moved.links).toEqual({ added: [], removed: [] });
    expect(serialized).toEqual(["b"]);
    expect(applyTaskBoardDelta(prev, moved)).toEqual(next);
  });

  it("returns the board unchanged for a stale delta and null on a gap", () => {
    const prev = board(5, [view("a", 1)], [], 1);
    const next = board(6, [view("a", 1), view("b", 2)], [], 2);
    const delta = diffTaskBoards(prev, next);
    const ahead = board(7, next.tasks, [], 2);
    // Already past it: nothing to do, the same object back.
    expect(applyTaskBoardDelta(ahead, delta)).toBe(ahead);
    // Behind it by one push: a gap, and the one honest answer is "resync".
    expect(applyTaskBoardDelta(board(4, [view("a", 1)], [], 1), delta)).toBeNull();
    expect(applyTaskBoardDelta(prev, delta)).toEqual(next);
  });

  it("orders rows by creation then id, and edges by (from, to, type), on both sides", () => {
    const tasks = [view("b", 2), view("a", 2), view("c", 1)];
    expect(sortBoardTasks(tasks).map((task) => task.id)).toEqual(["c", "a", "b"]);
    const links: TaskLinkView[] = [
      { fromId: "b", toId: "a", type: "related" },
      { fromId: "a", toId: "b", type: "related" },
      { fromId: "a", toId: "b", type: "blocks" },
    ];
    expect(sortBoardLinks(links)).toEqual([
      { fromId: "a", toId: "b", type: "blocks" },
      { fromId: "a", toId: "b", type: "related" },
      { fromId: "b", toId: "a", type: "related" },
    ]);
  });
});
