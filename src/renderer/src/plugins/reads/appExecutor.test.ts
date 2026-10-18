import type { Card } from "@shared/cards";
import { macBookResourcesView } from "@shared/macBookResourceReading";
import { panelComputerResources } from "@shared/resources";
import type { ProjectView, TaskBoard, TaskBoardDelta, TaskView } from "@shared/tasks";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The app's read executor over a stand-in `window.infinitary`: however many
 * surfaces read the task board, a push crosses the bridge once, as text,
 * and every one of them gets the same parsed board (character-jank scout).
 */

function board(seq: number): TaskBoard {
  return { seq, at: seq, projects: [], tasks: [], links: [] } as unknown as TaskBoard;
}

function fakeWindow() {
  const json = new Set<(board: string) => void>();
  const deltas = new Set<(delta: TaskBoardDelta) => void>();
  let jsonSubscriptions = 0;
  const firstmate = {
    tasks: {
      onBoard: vi.fn(() => () => {}),
      onBoardJson: (listener: (board: string) => void) => {
        jsonSubscriptions += 1;
        json.add(listener);
        return () => json.delete(listener);
      },
      onBoardDelta: (listener: (delta: TaskBoardDelta) => void) => {
        deltas.add(listener);
        return () => deltas.delete(listener);
      },
    },
    plugins: { read: vi.fn(async () => board(1)) },
    events: { on: () => () => {} },
  };
  (globalThis as unknown as { window: unknown }).window = { infinitary: firstmate };
  return {
    firstmate,
    pushBoard: (next: TaskBoard) => {
      const text = JSON.stringify(next);
      for (const listener of json) listener(text);
    },
    attached: () => json.size,
    jsonSubscriptions: () => jsonSubscriptions,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.resetModules();
});

describe("the app read executor's task board", () => {
  it("takes one bridge subscription for every tasks.board reader and shares each push", async () => {
    const fake = fakeWindow();
    const { appReadExecutor } = await import("./appExecutor");
    const executor = appReadExecutor();
    const seen: TaskBoard[][] = [[], [], []];
    const stops = seen.map((list) =>
      executor.subscribe(
        "tasks.board",
        {},
        { onValue: (value) => list.push(value as TaskBoard), onError: () => {} },
      ),
    );
    await vi.waitFor(() => expect(seen.every((list) => list.length === 1)).toBe(true));

    fake.pushBoard(board(2));
    fake.pushBoard(board(3));

    expect(fake.jsonSubscriptions()).toBe(1);
    expect(fake.attached()).toBe(1);
    expect(fake.firstmate.tasks.onBoard).not.toHaveBeenCalled();
    expect(seen.map((list) => list.map((value) => value.seq))).toEqual([
      [1, 2, 3],
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(seen[2]?.[2]).toBe(seen[0]?.[2]);

    for (const stop of stops) stop();
    expect(fake.attached()).toBe(0);
  });
});

describe("the shell's shared task projection", () => {
  it("does not revive waiting from a project read captured before a newer board arrived", async () => {
    const { useShellStore } = await import("../../app/store");
    useShellStore.setState({
      cards: [
        {
          id: "old-choice",
          taskId: "t",
          status: "ready",
          actions: [{ id: "go", label: "Go" }],
        } as Card,
      ],
    });
    const project = {
      id: "p",
      counts: { needsYou: 0, waitingOnYou: 0, open: 0, active: 0, doneRecent: 0 },
    } as ProjectView;
    const older = {
      seq: 2,
      projects: [project],
      tasks: [
        { id: "t", projectId: "p", status: "active", waitingCardId: "old-choice" } as TaskView,
      ],
    } as TaskBoard;
    const latest = { ...older, seq: 3, tasks: [] };
    let finish: ((value: TaskBoard) => void) | undefined;
    vi.stubGlobal("window", {
      infinitary: {
        plugins: { read: async () => [project] },
        tasks: {
          board: () =>
            new Promise<TaskBoard>((resolve) => {
              finish = resolve;
            }),
        },
      },
    });
    const { firstmateReadApi } = await import("./appExecutor");
    const api = firstmateReadApi();
    const pending = api.read("projects.list", {}, {});
    await Promise.resolve();
    api.present?.("tasks.board", latest);
    finish?.(older);
    const projects = api.present?.("projects.list", await pending) as ProjectView[];
    expect(projects[0]?.counts.waitingOnYou).toBe(0);
    expect(projects[0]?.counts.needsYou).toBe(0);
    expect(api.present?.("tasks.board", older)).toMatchObject({ seq: 3, tasks: [] });
  });
});

/** INF-396: the read executor is what hands a panel the narrowed memory reading. */
describe("the app read executor's computer readings", () => {
  it("hands panels the figure projection of the 11:32:53 PM MacBook reading", async () => {
    vi.stubGlobal("window", { infinitary: {} });
    const { firstmateReadApi } = await import("./appExecutor");
    expect(firstmateReadApi().present?.("computers.resources", macBookResourcesView)).toEqual(
      panelComputerResources(macBookResourcesView),
    );
  });
});
