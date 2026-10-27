import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { declareCheckAction } from "../orchestrator/checkRepair";
import { TaskGraphRefusal, TaskService } from "./taskService";

// Reproduction of reciprocal baseline waits and mixed ordinary/baseline loops.
function setup() {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  for (const id of ["a", "b", "c"]) {
    tasks.create({ id, title: id, prompt: "", repoId: null });
    seedDelivery(tasks, id, {
      headSha: id,
      ci: "red",
      ciRepair: { failures: [{ headSha: id, checks: ["checks"] }], diagnoses: [], repairs: [] },
    });
  }
  const diagnose = (waiter: string, owner: string) =>
    declareCheckAction(
      tasks,
      waiter,
      {
        diagnosis: {
          headSha: waiter,
          check: "checks",
          classification: "baseline-blocked",
          dependencyTask: owner,
          evidence: "Untouched-main failing check log",
        },
      },
      100,
    );
  const path = (...ids: string[]) => ids.map((id) => tasks.get(id)?.key).join(" → ");
  const state = () => ({
    tasks: tasks.list(),
    links: tasks.allLinks(),
    events: tasks.list().map((task) => tasks.timeline(task.id)),
  });
  return { db, tasks, diagnose, path, state };
}

describe("refusing newly accepted circular waits", () => {
  it("refuses reciprocal and transitive baseline waits without changing records or budgets", () => {
    const { db, diagnose, path, state } = setup();
    try {
      expect(diagnose("a", "b").text).toContain("Diagnosis recorded");
      const before = state();
      expect(diagnose("b", "a")).toMatchObject({
        read: false,
        text: expect.stringContaining(path("b", "a", "b")),
      });
      expect(state()).toEqual(before);
      expect(diagnose("b", "c").text).toContain("Diagnosis recorded");
      const chain = state();
      expect(diagnose("c", "a").text).toContain(path("c", "a", "b", "c"));
      expect(state()).toEqual(chain);
    } finally {
      db.close();
    }
  });

  it("refuses a baseline wait that closes an ordinary-blocker loop", () => {
    const { db, tasks, diagnose, path, state } = setup();
    try {
      tasks.link("b", "a", "blocks", "firstmate");
      const before = state();
      expect(diagnose("b", "a").text).toContain(path("b", "a", "b"));
      expect(state()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("refuses an ordinary blocker that closes a baseline-wait loop", () => {
    const { db, tasks, diagnose, path, state } = setup();
    try {
      expect(diagnose("a", "b").text).toContain("Diagnosis recorded");
      const before = state();
      expect(() => tasks.link("a", "b", "blocks", "firstmate")).toThrow(TaskGraphRefusal);
      expect(() => tasks.link("a", "b", "blocks", "firstmate")).toThrow(path("b", "a", "b"));
      expect(state()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
