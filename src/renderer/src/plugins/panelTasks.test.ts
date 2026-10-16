import { describe, expect, it, vi } from "vitest";
import { frameTasksAction, MOVE_NOT_ASKED, panelTasks, type TaskRunner } from "./panelTasks";

/**
 * Moving the captain's tasks from a panel (docs/ui-plugins.md, "A panel's
 * cards", piece 4): one of the six moves, through the task record's own
 * path, only from his click or key, naming the panel on the task's record.
 */

const desk = { id: "task-desk", title: "Task desk" };

describe("tasks.run", () => {
  it("runs a move through the record's own path, naming the panel, only from the captain's click or key", async () => {
    const run = vi.fn<TaskRunner>(async () => ({ ok: true }));
    await expect(panelTasks(desk, async () => false, run).run("t1", "queue-task")).resolves.toEqual(
      { ok: false, text: MOVE_NOT_ASKED },
    );
    expect(run).not.toHaveBeenCalled();
    const tasks = panelTasks(desk, async () => true, run);
    await expect(tasks.run("t1", "queue-task")).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith("t1", "queue-task", undefined, { panel: "Task desk" });
    const review = { parts: [], waiting: ["FM-2"], underway: [] };
    await tasks.run("t1", "drop-task", review);
    expect(run).toHaveBeenLastCalledWith("t1", "drop-task", review, { panel: "Task desk" });
  });

  it("names no panel for one of the app's own, as the record's own buttons name none", async () => {
    const run = vi.fn<TaskRunner>(async () => ({ ok: true }));
    const tasks = panelTasks({ id: "now", title: "Tasks", own: true }, async () => true, run);
    await tasks.run("t1", "queue-task");
    expect(run).toHaveBeenCalledWith("t1", "queue-task", undefined, undefined);
  });

  it("says why not in the app's words, and refuses what is not a move", async () => {
    const refused = panelTasks(
      desk,
      async () => true,
      async () => ({
        ok: false,
        text: "Cannot move FM-1: it has already started.",
      }),
    );
    await expect(refused.run("t1", "unqueue-task")).resolves.toEqual({
      ok: false,
      text: "Cannot move FM-1: it has already started.",
    });
    const thrown = panelTasks(
      desk,
      async () => true,
      async () => {
        throw new Error("the app is away");
      },
    );
    await expect(thrown.run("t1", "start-task")).resolves.toEqual({
      ok: false,
      text: "the app is away",
    });
    await expect(refused.run("t1", "merge" as never)).rejects.toThrow("tasks.run: move");
  });

  it("answers a frame's tasks.run with the same checks", async () => {
    const run = vi.fn<TaskRunner>(async () => ({ ok: true }));
    const act = frameTasksAction(panelTasks(desk, async () => true, run));
    await expect(act("tasks.run", { taskId: "t1", move: "start-task" })).resolves.toEqual({
      ok: true,
    });
    await expect(act("tasks.other", {})).rejects.toThrow("is not a panel's move");
  });
});
