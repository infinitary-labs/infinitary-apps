import { expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { TaskStore } from "./taskRecords";

// INF-3291: preserve task completion counts while splitting task storage.
it("counts only finished work started by a crewmate, and excludes host operations", () => {
  const db = freshDatabase();
  const tasks = new TaskService({ db });
  try {
    seedTask(tasks, {
      id: "operation",
      title: "Change a setting",
      kind: "operation",
      status: "queued",
    });
    tasks.close("operation", { status: "done", reason: "settled", actor: "host" });
    expect(tasks.hasFinishedTask()).toBe(false);
    expect(tasks.finishedCrewmates(10)).toBe(0);

    seedTask(tasks, { id: "unstarted", title: "Review a plan", status: "queued" });
    tasks.close("unstarted", { status: "done", reason: "settled", actor: "host" });
    expect(tasks.hasFinishedTask()).toBe(true);
    expect(tasks.finishedCrewmates(10)).toBe(0);

    for (const id of ["first", "second"]) {
      seedTask(tasks, { id, title: "Review a change", status: "running" });
      tasks.close(id, { status: "done", reason: "settled", actor: "host" });
    }
    seedTask(tasks, { id: "dropped", title: "Stop a change", status: "failed" });
    expect(tasks.finishedCrewmates(10)).toBe(2);
    expect(tasks.finishedCrewmates(1)).toBe(1);
    expect(tasks.finishedCrewmates(0)).toBe(0);
  } finally {
    db.close();
  }
});

// INF-3291: preserve task selection and projection behavior while splitting storage.
it("keeps active computer counts and cached child reads consistent with persisted tasks", () => {
  const db = freshDatabase();
  const tasks = new TaskService({ db });
  const store = new TaskStore(db);
  try {
    seedTask(tasks, { id: "parent", title: "Review changes", status: "queued" });
    seedTask(tasks, {
      id: "active",
      title: "Review the notes",
      parentId: "parent",
      status: "running",
      deviceId: "computer-a",
    });
    seedTask(tasks, {
      id: "closed",
      title: "Review the tests",
      parentId: "parent",
      status: "running",
      deviceId: "computer-a",
      worktreeDir: "/work/review",
    });
    tasks.close("closed", { status: "done", reason: "settled", actor: "host" });
    expect(store.countActiveByDevice()).toEqual(new Map([["computer-a", 1]]));
    expect(store.hasKind("question")).toBe(false);
    expect(store.hasKind("work")).toBe(true);
    expect(store.listByStatus()).toEqual([]);
    expect(store.getActiveMany([])).toEqual([]);
    expect(store.getActiveMany(["active", "closed"]).map((task) => task.id)).toEqual(["active"]);
    expect(store.closedPresentOn("computer-a")).toEqual(["closed"]);
    store.readProjection(() => {
      expect(store.listChildren("parent").map((task) => task.id)).toEqual(["active", "closed"]);
      expect(store.listChildren("parent").map((task) => task.id)).toEqual(["active", "closed"]);
      expect(store.listLiveChildren("parent").map((task) => task.id)).toEqual(["active"]);
      expect(store.listLiveChildren("parent").map((task) => task.id)).toEqual(["active"]);
    });
  } finally {
    db.close();
  }
});
