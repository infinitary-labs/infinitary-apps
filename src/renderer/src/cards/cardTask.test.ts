import type { Card } from "@shared/cards";
import type { TaskBoard, TaskView } from "@shared/tasks";
import { describe, expect, it, vi } from "vitest";

/**
 * The task a card on the stage is about (INF-358; the captain's "the task
 * key is added to all decision cards about a task, so it's not
 * inconsistent"): its own `taskId`, a first mate decision's filed row, and
 * none for a card about no task.
 */

let push: ((value: unknown) => void) | null = null;
const subscribe = vi.fn(
  (_read: string, _args: unknown, sink: { onValue: (v: unknown) => void }) => {
    push = sink.onValue;
    return () => {
      push = null;
    };
  },
);
vi.mock("../plugins/reads/appExecutor", () => ({ appReadExecutor: () => ({ subscribe }) }));
vi.stubGlobal("window", { infinitary: { plugins: { read: async () => [] } } });

const { cardTaskOf } = await import("./cardTask");
const { taskKeyIndex } = await import("./taskLinks");

const row = (id: string, key: string, waitingCardId: string | null = null) =>
  ({ id, key, waitingCardId }) as unknown as TaskView;
const card = (overrides: Partial<Card>): Card => ({
  id: "card-1",
  author: "crewmate",
  priority: 10,
  title: "A card",
  meta: "m",
  body: "",
  actions: [],
  status: "ready",
  createdAt: 1,
  ...overrides,
});
const choice = [{ id: "go", label: "Go", default: true }];

describe("the task a card is about", () => {
  it("is the task its id names, else the decision row filed for a first mate decision, else none", () => {
    const held = taskKeyIndex.hold();
    push?.({
      seq: 1,
      at: 1,
      projects: [],
      links: [],
      tasks: [row("t1", "SCR-1"), row("t-decision", "SCR-9", "card-fm-2")],
    } as TaskBoard);
    // A crewmate's card, a host card about a task and a first mate card with task_id alike.
    expect(cardTaskOf(card({ taskId: "t1" }))?.key).toBe("SCR-1");
    expect(cardTaskOf(card({ taskId: "t1", author: "host", actions: choice }))?.key).toBe("SCR-1");
    // A first mate decision that named no task: the row the app filed for it.
    expect(cardTaskOf(card({ id: "card-fm-2", author: "firstmate", actions: choice }))?.key).toBe(
      "SCR-9",
    );
    // A first mate note that named no task, and a host card about no task
    // (a provider's sign-in, whose operation row still waits on it), draw none.
    expect(cardTaskOf(card({ id: "card-fm-2", author: "firstmate" }))).toBeUndefined();
    expect(cardTaskOf(card({ id: "card-fm-2", author: "host", actions: choice }))).toBeUndefined();
    // A task the board does not list answers nothing rather than a guess.
    expect(cardTaskOf(card({ taskId: "t-gone" }))).toBeUndefined();
    held();
  });
});
