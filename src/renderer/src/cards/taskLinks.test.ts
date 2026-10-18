import type { TaskBoard, TaskView } from "@shared/tasks";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which task keys link, for every place the window draws one (FI3-1271):
 * one store for the window reads the board once while anything asks, looks
 * a key the board does not list up once in earlier work, and keeps only an
 * exact match; a task's own key on its own card or record stays text.
 */

const row = (id: string, key: string) => ({ id, key, waitingCardId: null }) as unknown as TaskView;

let push: ((value: unknown) => void) | null = null;
const subscribe = vi.fn(
  (_read: string, _args: unknown, sink: { onValue: (v: unknown) => void }) => {
    push = sink.onValue;
    return stop;
  },
);
const stop = vi.fn(() => {
  push = null;
});
vi.mock("../plugins/reads/appExecutor", () => ({ appReadExecutor: () => ({ subscribe }) }));

const earlier: Record<string, TaskView[]> = {
  "FI3-7": [row("t-earlier", "FI3-7")],
  // A search is by words: the near miss it finds is no match.
  "F13-572": [row("t-near", "FI3-572")],
};
const read = vi.fn(async (_read: string, args: { query: string }) => earlier[args.query] ?? []);
vi.stubGlobal("window", { infinitary: { plugins: { read } } });

const { linkedKeys, taskKeyIndex } = await import("./taskLinks");

const board = (tasks: TaskView[]) =>
  push?.({ seq: 1, at: 1, projects: [], links: [], tasks } as TaskBoard);

afterEach(() => {
  subscribe.mockClear();
  stop.mockClear();
  read.mockClear();
});

describe("the window's task key store", () => {
  it("reads the board once for every asker, and stops when the last lets go", () => {
    const first = taskKeyIndex.watch(["SCR-1"]);
    const second = taskKeyIndex.watch(["SCR-1", "SCR-2"]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    board([row("t1", "SCR-1"), row("t2", "SCR-2")]);
    expect(taskKeyIndex.task("SCR-2")?.id).toBe("t2");
    first();
    expect(stop).not.toHaveBeenCalled();
    second();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("looks a key the board does not list up once, keeping only an exact match", async () => {
    const heard = vi.fn();
    const quiet = taskKeyIndex.subscribe(heard);
    const one = taskKeyIndex.watch(["SCR-1", "FI3-7", "F13-572"]);
    const two = taskKeyIndex.watch(["FI3-7"]);
    board([row("t1", "SCR-1")]);
    await vi.waitFor(() => expect(taskKeyIndex.task("FI3-7")?.id).toBe("t-earlier"));
    // Only the keys the board does not list, each once, however many ask.
    expect(read.mock.calls.map(([, args]) => args.query).sort()).toEqual(["F13-572", "FI3-7"]);
    expect(taskKeyIndex.task("F13-572")).toBeUndefined();
    expect(heard).toHaveBeenCalled();
    // A later asker of the same key finds it without asking again.
    const three = taskKeyIndex.watch(["FI3-7"]);
    expect(read).toHaveBeenCalledTimes(2);
    for (const done of [one, two, three, quiet]) done();
  });

  it("holds the board for a card's head, answering a task by id and the row waiting on a card (INF-358)", () => {
    const held = taskKeyIndex.hold();
    expect(subscribe).toHaveBeenCalledTimes(1);
    board([
      row("t1", "SCR-1"),
      { ...row("t-decision", "SCR-9"), waitingCardId: "card-fm-3" } as TaskView,
    ]);
    expect(taskKeyIndex.byId("t1")?.key).toBe("SCR-1");
    expect(taskKeyIndex.byId("t-none")).toBeUndefined();
    expect(taskKeyIndex.waitingOn("card-fm-3")?.key).toBe("SCR-9");
    expect(taskKeyIndex.waitingOn("card-other")).toBeUndefined();
    // A key asked for meanwhile keeps the board after the hold lets go.
    const asking = taskKeyIndex.watch(["SCR-1"]);
    held();
    expect(stop).not.toHaveBeenCalled();
    asking();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("which keys link", () => {
  const task = (key: string) =>
    ({ "SCR-1": { id: "t1" }, "SCR-2": { id: "t2" } })[key] as { id: string } | undefined;

  it("links each recorded task's key, in order, and none that names no task", () => {
    expect(linkedKeys(["SCR-2", "F13-572", "SCR-1"], task)).toEqual(["SCR-2", "SCR-1"]);
  });

  it("leaves the task's own key on its own card or record as text", () => {
    expect(linkedKeys(["SCR-1", "SCR-2"], task, "t1")).toEqual(["SCR-2"]);
  });
});
