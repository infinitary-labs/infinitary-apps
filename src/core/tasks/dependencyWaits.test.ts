import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { declareCheckAction } from "../orchestrator/checkRepair";
import { standingDependencyWaits } from "./dependencyWaits";
import { TaskGraphRefusal } from "./taskGraph";
import { TaskService } from "./taskService";

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
    links: tasks.graph.allLinks(),
    events: tasks.list().map((task) => tasks.timeline(task.id)),
  });
  return { db, tasks, diagnose, path, state };
}

describe("refusing newly accepted circular waits", () => {
  // INF-2186: a board row's baseline waits must not search its entire diagnosis
  // history again for every diagnosis (the captain's 693 ms freeze sample).
  it("derives standing waits with linear diagnosis reads and keeps latest-diagnosis semantics", () => {
    const { db, tasks } = setup();
    try {
      const checks = [
        "typecheck-lint-build",
        "unit-tests",
        "integration-tests (1/2)",
        "integration-tests (2/2)",
        "probe-tests",
        "unit-repeats",
      ];
      const diagnoses = Array.from({ length: 40 }, (_, version) =>
        checks.map((check) => ({
          headSha: version.toString(16).padStart(40, "0"),
          check,
          classification: "baseline-blocked" as const,
          dependencyTask: "b",
          evidence: "The same job failed on untouched main.",
          at: 100 + version,
        })),
      ).flat();
      // A later own-regression diagnosis replaces one baseline diagnosis.
      const headSha = diagnoses.at(-1)!.headSha;
      const latest = { ...diagnoses.at(-1)!, classification: "own-regression" as const };
      const history = [...diagnoses, latest];
      let reads = 0;
      const measured = new Proxy(history, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const delivery = {
        mode: "direct-pr" as const,
        headSha,
        ci: "red" as const,
        ciRepair: { diagnoses: measured, failures: [], repairs: [] },
      };
      const waits = standingDependencyWaits(tasks, delivery);
      expect(waits.map((wait) => ({ id: wait.task.id, since: wait.since }))).toEqual([
        { id: "b", since: 139 },
      ]);
      expect(reads).toBeLessThanOrEqual(3 * history.length);
      const linearReads = reads;
      tasks.readProjection(() => {
        reads = 0;
        expect(standingDependencyWaits(tasks, delivery).map((wait) => wait.task.id)).toEqual(["b"]);
        const firstRead = reads;
        for (let reader = 0; reader < 20; reader += 1)
          expect(standingDependencyWaits(tasks, delivery).map((wait) => wait.task.id)).toEqual([
            "b",
          ]);
        console.info(
          JSON.stringify({
            intent: "INF-2186 shared dependency facts",
            firstRead,
            repeatedReads: reads,
          }),
        );
        expect(reads).toBe(firstRead);
        tasks.close("b", { status: "done", reason: "settled", actor: "host" });
        expect(standingDependencyWaits(tasks, delivery).map((wait) => wait.task.status)).toEqual([
          "done",
        ]);
      });
      const beforeNextRead = reads;
      expect(standingDependencyWaits(tasks, delivery).map((wait) => wait.task.status)).toEqual([
        "done",
      ]);
      expect(reads).toBeGreaterThan(beforeNextRead);
      console.info(
        JSON.stringify({
          intent: "INF-2186 baseline history",
          diagnoses: history.length,
          reads: linearReads,
          waits: waits.map((wait) => wait.task.id),
        }),
      );
    } finally {
      db.close();
    }
  });
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
      tasks.graph.link("b", "a", "blocks", "firstmate");
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
      expect(() => tasks.graph.link("a", "b", "blocks", "firstmate")).toThrow(TaskGraphRefusal);
      expect(() => tasks.graph.link("a", "b", "blocks", "firstmate")).toThrow(path("b", "a", "b"));
      expect(state()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
