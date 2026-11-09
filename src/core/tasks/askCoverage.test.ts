import { expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { TaskEventStore } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

// INF-2278: narrowing dismissal coverage must retain every work-carrying edge,
// direct attribution, the before cutoff, and fresh facts after writes or rollback.
it("retains the work graph and current task facts without composing coverage records", () => {
  const db = freshDatabase();
  let clock = 1_000;
  const tasks = new TaskService({ db, strict: true, now: () => ++clock });
  const fields = (task: TaskRecord) => ({
    id: task.id,
    key: task.key,
    title: task.title,
    status: task.status,
    closedReason: task.closedReason,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
  });
  try {
    const root = seedTask(tasks, {
      id: "plan",
      title: "Plan responsive card dismissal",
      status: "idle",
    });
    const first = seedTask(tasks, {
      id: "first",
      parentId: root.id,
      title: "Measure cold coverage",
      status: "cancelled",
      createdAt: clock,
    });
    const second = seedTask(tasks, {
      id: "second",
      parentId: root.id,
      title: "Check acceptance facts",
      status: "idle",
      createdAt: first.createdAt,
    });
    tasks.capture.openAsk({
      id: "ask",
      text: "Keep dismissal responsive and preserve acceptance.",
    });
    tasks.capture.attachAsk("ask", root.id, "host:fallback");
    tasks.capture.attachAsk("ask", second.id, "tool:steer_crewmate");
    tasks.capture.closeAsk("ask", "closed");
    const cutoff = ++clock;
    const replacement = seedTask(tasks, {
      id: "replacement",
      title: "Continue the investigation",
      status: "queued",
    });
    tasks.graph.link(root.id, replacement.id, "replaced-by", "firstmate");
    const basis = seedTask(tasks, {
      id: "build",
      title: "Build the planned fix",
      status: "queued",
      shape: { kind: "implement", basis: root.key },
    });
    const retry = seedTask(tasks, {
      id: "retry",
      title: "Continue with a stronger model",
      status: "queued",
      shape: { kind: "fix", escalate_from: root.id },
    });
    const branch = seedTask(tasks, {
      id: "branch",
      title: "Build on the same branch",
      status: "queued",
      shape: { kind: "implement", branch_from: root.key },
    });
    const escalated = seedTask(tasks, {
      id: "escalated",
      title: "Read the earlier attempt",
      status: "idle",
    });
    new TaskEventStore(db).insert({
      taskId: root.id,
      at: ++clock,
      actor: "firstmate",
      kind: "escalated",
      text: "Continue on a stronger model.",
      data: { escalated_to: escalated.id },
      ref: escalated.id,
    });
    // Reaching the same task through a second edge may not duplicate it.
    tasks.graph.link(first.id, replacement.id, "replaced-by", "firstmate");
    const expected = [root, second, first, replacement, basis, retry, branch, escalated];
    const assertCoverage = () => {
      const coverage = tasks.capture.askCoverage(["ask"]);
      expect(coverage.work).toEqual(expected.map((task) => fields(tasks.get(task.id)!)));
      expect([...coverage.acted]).toEqual([second.id]);
    };
    assertCoverage();
    expect(tasks.capture.askCoverage(["ask"], cutoff).work.map((task) => task.id)).toEqual([
      root.id,
      second.id,
      first.id,
    ]);
    // A direct attachment still counts even when its work was filed after the cutoff.
    tasks.capture.attachAsk("ask", replacement.id, "tool:spawn_crewmate");
    expect(tasks.capture.askCoverage(["ask"], cutoff).work.map((task) => task.id)).toEqual([
      root.id,
      second.id,
      replacement.id,
      first.id,
    ]);

    tasks.readProjection(() => {
      tasks.capture.askCoverage(["ask"]);
      tasks.updateFields(root.id, { title: "Keep the accepted answer intact" }, "firstmate");
      expect(tasks.capture.askCoverage(["ask"]).work[0]?.title).toBe(
        "Keep the accepted answer intact",
      );
      const beforeRollback = tasks.capture.askCoverage(["ask"]);
      expect(() =>
        tasks.atomic(
          () => {
            tasks.updateFields(root.id, { title: "A rolled-back title" }, "firstmate");
            expect(tasks.capture.askCoverage(["ask"]).work[0]?.title).toBe("A rolled-back title");
            throw new Error("rollback");
          },
          () => {},
        ),
      ).toThrow("rollback");
      expect(tasks.capture.askCoverage(["ask"])).toEqual(beforeRollback);
      const child = seedTask(tasks, {
        id: "new-part",
        parentId: root.id,
        title: "Check the new part",
        status: "queued",
      });
      expect(tasks.capture.askCoverage(["ask"]).work.map((task) => task.id)).toContain(child.id);
      tasks.setParent(child.id, null, "firstmate");
      expect(tasks.capture.askCoverage(["ask"]).work.map((task) => task.id)).not.toContain(
        child.id,
      );
      tasks.close(second.id, { status: "done", reason: "answered", actor: "host" });
      expect(tasks.capture.askCoverage(["ask"]).work.find((task) => task.id === second.id)).toEqual(
        fields(tasks.get(second.id)!),
      );
    });
    expect(tasks.capture.askCoverage(["ask"]).work[0]?.title).toBe(
      "Keep the accepted answer intact",
    );
    expect(tasks.capture.askCoverage(["unknown"])).toEqual({ work: [], acted: new Set() });
  } finally {
    db.close();
  }
});
