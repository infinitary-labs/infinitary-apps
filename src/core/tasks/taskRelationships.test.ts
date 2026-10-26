import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { openDatabase, openInMemoryDatabase, TASK_REFERENCES_VERSION } from "../storage/db";
import { seedTask } from "./seedTask";
import { exportTaskRecords, parseTaskExport } from "./taskExport";
import { TASK_RELATIONSHIP_RULES, type TaskRelationshipKind } from "./taskRelationships";
import { TaskGraphRefusal, TaskService } from "./taskService";

// INF-1296 piece 2, the captain's approved plan B: parent, dependencies,
// basis, branch source and retry provenance behind one checked relationship
// contract, each kind keeping its own rule, and "good e2e test coverage to
// ensure exsiting users don't get regressed during this migration".

function setup(db = openInMemoryDatabase()) {
  let now = 10_000;
  const tasks = new TaskService({ db, strict: true, now: () => (now += 1_000) });
  return { db, tasks };
}

describe("the relationship contract", () => {
  it("only a dependency holds the start of the task it points at", () => {
    const { tasks } = setup();
    const named = seedTask(tasks, { id: "spec", title: "Write the spec", status: "idle" });
    const shown = (kind: TaskRelationshipKind): boolean => {
      const id = `waits-${kind}`;
      if (kind === "parent")
        seedTask(tasks, { id, title: kind, status: "queued", parentId: named.id });
      else if (kind === "basis" || kind === "branch-source" || kind === "retry-of")
        seedTask(tasks, {
          id,
          title: kind,
          status: "queued",
          shape: {
            kind: "implement",
            [kind === "basis"
              ? "basis"
              : kind === "branch-source"
                ? "branch_from"
                : "escalate_from"]: named.key,
          },
        });
      else {
        seedTask(tasks, { id, title: kind, status: "queued" });
        tasks.link(named.id, id, kind, "firstmate");
      }
      return tasks.listReady().some((record) => record.id === id);
    };
    for (const [kind, rule] of Object.entries(TASK_RELATIONSHIP_RULES))
      expect({ kind, ready: shown(kind as TaskRelationshipKind) }).toEqual({
        kind,
        ready: !rule.holdsStart,
      });
  });

  it("reads every family through one call, with who recorded each and when", () => {
    const { tasks } = setup();
    const plan = seedTask(tasks, { id: "plan", title: "Plan", status: "completed", outcome: "B." });
    const first = seedTask(tasks, {
      id: "first",
      title: "First go",
      status: "completed",
      outcome: "x",
    });
    const parent = seedTask(tasks, { id: "parent", title: "Ship it", status: "idle" });
    const build = tasks.create({
      id: "build",
      title: "Build B",
      prompt: "p",
      repoId: null,
      parentId: parent.id,
      shape: {
        kind: "implement",
        basis: plan.key,
        branch_from: first.key,
        escalate_from: first.key,
      },
      blockedBy: [plan.id],
      actor: "firstmate",
    });
    const relationships = tasks.relationshipsOf(build.id);
    expect(
      relationships.map(({ kind, from, to, ref, actor }) => ({ kind, from, to, ref, actor })),
    ).toEqual([
      { kind: "parent", from: build.id, to: parent.id, ref: undefined, actor: null },
      { kind: "blocks", from: plan.id, to: build.id, ref: undefined, actor: "firstmate" },
      { kind: "basis", from: build.id, to: plan.id, ref: plan.key, actor: "firstmate" },
      { kind: "branch-source", from: build.id, to: first.id, ref: first.key, actor: "firstmate" },
      { kind: "retry-of", from: build.id, to: first.id, ref: first.key, actor: "firstmate" },
    ]);
    expect(relationships.find((edge) => edge.kind === "basis")?.at).toBe(build.createdAt);
    // The named end reads the same edges from its side.
    expect(tasks.relationshipsOf(first.id).map((edge) => [edge.kind, edge.from])).toEqual([
      ["branch-source", build.id],
      ["retry-of", build.id],
    ]);
    // The record still reads them under the shape's fields.
    expect(tasks.get(build.id)?.shape).toMatchObject({
      basis: plan.key,
      branch_from: first.key,
      escalate_from: first.key,
    });
  });

  it("keeps each reference to one, and refuses what each kind's rule refuses", () => {
    const { tasks } = setup();
    const a = seedTask(tasks, { id: "a", title: "A", status: "completed", outcome: "A." });
    const b = seedTask(tasks, { id: "b", title: "B", status: "completed", outcome: "B." });
    const other = seedTask(tasks, {
      id: "other",
      title: "Other",
      status: "idle",
      repoId: "elsewhere",
    });
    const step = seedTask(tasks, {
      id: "step",
      title: "Step",
      status: "queued",
      shape: { kind: "fix" },
    });
    tasks.updateFields(step.id, { basis: a.key }, "firstmate");
    tasks.updateFields(step.id, { basis: b.key }, "firstmate");
    expect(tasks.relationshipsOf(step.id).filter((edge) => edge.kind === "basis")).toMatchObject([
      { to: b.id, ref: b.key },
    ]);
    expect(() => tasks.updateFields(step.id, { basis: step.key }, "firstmate")).toThrow(
      "A task cannot be its own basis.",
    );
    // A branch source is in the same project, and names a task.
    expect(() =>
      tasks.create({
        id: "across",
        title: "Across",
        prompt: "p",
        repoId: null,
        shape: { kind: "fix", branch_from: other.key },
      }),
    ).toThrow(TaskGraphRefusal);
    expect(() =>
      tasks.create({
        id: "nowhere",
        title: "Nowhere",
        prompt: "p",
        repoId: null,
        shape: { kind: "fix", escalate_from: "SCR-999" },
      }),
    ).toThrow('Unknown escalate_from "SCR-999"');
    expect(tasks.get("across")).toBeUndefined();
    expect(tasks.get("nowhere")).toBeUndefined();
    // Clearing removes the row and the shape field with it.
    tasks.updateFields(step.id, { basis: "" }, "firstmate");
    expect(tasks.get(step.id)?.shape).toEqual({ kind: "fix" });
    expect(tasks.relationshipsOf(step.id)).toEqual([]);
  });

  it("keeps a spawn's basis as named until it names a task, which it then reads as verified", () => {
    const { tasks } = setup();
    const step = tasks.create({
      id: "ahead",
      title: "Build on what comes next",
      prompt: "p",
      repoId: null,
      shape: { kind: "implement", basis: "SCR-2" },
    });
    expect(tasks.basisOf(step)).toEqual({ ref: "SCR-2", verified: false });
    const later = seedTask(tasks, {
      id: "later",
      title: "Spec",
      status: "completed",
      outcome: "Spec.",
    });
    expect(later.key).toBe("SCR-2");
    expect(tasks.basisOf(step)).toEqual({ ref: "SCR-2", verified: true });
    expect(tasks.builtOn(later.id).map((record) => record.id)).toEqual([step.id]);
  });

  it("refuses a shape write that names another relationship, and keeps one a write leaves out", () => {
    const { tasks } = setup();
    const plan = seedTask(tasks, { id: "plan", title: "Plan", status: "completed", outcome: "B." });
    const step = seedTask(tasks, {
      id: "step",
      title: "Step",
      status: "queued",
      shape: { kind: "implement", basis: plan.key },
    });
    // A routing stamp rewrites the shape as it stands; the basis stays.
    tasks.recordShape(step.id, { kind: "fix", kind_source: "classifier:test" }, "medium");
    expect(tasks.get(step.id)?.shape).toMatchObject({ kind: "fix", basis: plan.key });
    expect(tasks.basisOf(tasks.get(step.id)!)).toEqual({ ref: plan.key, verified: true });
  });
});

describe("the migration of an older release's relationships", () => {
  /**
   * A profile as the release before this migration saved it: the basis,
   * branch source and earlier attempt inside each task's shape, a parent
   * edge and a dependency beside them.
   */
  function olderProfile() {
    const dir = scratchDir("relationships-");
    const at = openDatabase(dir, TASK_REFERENCES_VERSION - 1);
    const { tasks } = setup(at);
    const plan = seedTask(tasks, {
      id: "plan",
      title: "Plan the chart",
      status: "completed",
      outcome: "Do B.",
    });
    const first = seedTask(tasks, {
      id: "first",
      title: "Draw the chart",
      status: "completed",
      outcome: "Wrong axis.",
    });
    const wip = seedTask(tasks, { id: "wip", title: "Still deciding", status: "running" });
    const parent = seedTask(tasks, { id: "parent", title: "Ship the chart", status: "idle" });
    tasks.create({
      id: "retry",
      title: "Draw it again",
      prompt: "p",
      repoId: null,
      parentId: parent.id,
    });
    tasks.create({
      id: "guess",
      title: "Build on a guess",
      prompt: "p",
      repoId: null,
      blockedBy: ["wip"],
    });
    tasks.create({ id: "loose", title: "Build on nothing yet", prompt: "p", repoId: null });
    const shapes: Record<string, Record<string, string>> = {
      retry: { kind: "fix", basis: plan.key, branch_from: first.key, escalate_from: first.key },
      guess: { kind: "implement", basis: wip.id },
      loose: { kind: "implement", basis: "SCR-404" },
    };
    const write = at.prepare("UPDATE tasks SET shape_json = ? WHERE id = ?");
    for (const [id, shape] of Object.entries(shapes)) write.run(JSON.stringify(shape), id);
    at.close();
    return { dir, plan, first, wip, parent, shapes };
  }

  it("moves each name exactly as saved, and every reader reads the same as before", () => {
    const { dir, plan, first, wip, parent, shapes } = olderProfile();
    const before = openDatabase(dir, TASK_REFERENCES_VERSION - 1);
    const view = (db: typeof before) =>
      db.prepare("SELECT task_id, basis FROM v_tasks_v1 ORDER BY task_id").all();
    const readBefore = (() => {
      const { tasks } = setup(before);
      return {
        view: view(before),
        shapes: Object.fromEntries(tasks.list().map((record) => [record.id, record.shape])),
        ready: tasks.listReady().map((record) => record.id),
        blockers: tasks.blockers("guess").map((record) => record.id),
        children: tasks.children(parent.id).map((record) => record.id),
      };
    })();
    before.close();

    const upgraded = openDatabase(dir);
    const { tasks } = setup(upgraded);
    expect(upgraded.prepare("SELECT * FROM task_references ORDER BY task_id, kind").all()).toEqual([
      {
        task_id: "guess",
        kind: "basis",
        ref: wip.id,
        target_id: wip.id,
        actor: null,
        recorded_at: null,
      },
      {
        task_id: "loose",
        kind: "basis",
        ref: "SCR-404",
        target_id: null,
        actor: null,
        recorded_at: null,
      },
      {
        task_id: "retry",
        kind: "basis",
        ref: plan.key,
        target_id: plan.id,
        actor: null,
        recorded_at: null,
      },
      {
        task_id: "retry",
        kind: "branch-source",
        ref: first.key,
        target_id: first.id,
        actor: null,
        recorded_at: null,
      },
      {
        task_id: "retry",
        kind: "retry-of",
        ref: first.key,
        target_id: first.id,
        actor: null,
        recorded_at: null,
      },
    ]);
    // The shape column no longer holds them.
    const stored = upgraded
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE json_type(shape_json, '$.basis') IS NOT NULL OR json_type(shape_json, '$.branch_from') IS NOT NULL OR json_type(shape_json, '$.escalate_from') IS NOT NULL",
      )
      .get();
    expect(stored).toEqual({ n: 0 });
    // Every reader: the shape as read, the published view, readiness, the graph.
    for (const [id, shape] of Object.entries(shapes)) expect(tasks.get(id)?.shape).toEqual(shape);
    expect(view(upgraded)).toEqual(readBefore.view);
    expect(tasks.listReady().map((record) => record.id)).toEqual(readBefore.ready);
    expect(tasks.blockers("guess").map((record) => record.id)).toEqual(readBefore.blockers);
    expect(tasks.children(parent.id).map((record) => record.id)).toEqual(readBefore.children);
    for (const id of ["retry", "guess", "loose"])
      expect(tasks.get(id)?.shape).toEqual(readBefore.shapes[id]);
    expect(tasks.basisOf(tasks.get("retry")!)).toEqual({ ref: plan.key, verified: true });
    expect(tasks.basisOf(tasks.get("guess")!)).toEqual({ ref: wip.id, verified: false });
    expect(tasks.basisOf(tasks.get("loose")!)).toEqual({ ref: "SCR-404", verified: false });
    expect(tasks.builtOn(plan.id).map((record) => record.id)).toEqual(["retry"]);
    expect(tasks.builtOn(wip.id).map((record) => record.id)).toEqual(["guess"]);
    upgraded.close();
    // A restart reads the same, and migrates nothing twice.
    const again = openDatabase(dir);
    expect(again.prepare("SELECT COUNT(*) AS n FROM task_references").get()).toEqual({ n: 5 });
    again.close();
  });

  it("round-trips through an export, and imports an older export's shapes", () => {
    const { tasks } = setup();
    const plan = seedTask(tasks, { id: "plan", title: "Plan", status: "completed", outcome: "B." });
    tasks.create({
      id: "build",
      title: "Build",
      prompt: "p",
      repoId: null,
      shape: { kind: "implement", basis: plan.key },
      actor: "captain",
    });
    const lines = exportTaskRecords(tasks, 1);
    const build = JSON.parse(lines.find((line) => line.includes('"id":"build"')) ?? "{}");
    // The shape still names it, so an older build imports the same task.
    expect(build.shape).toEqual({ kind: "implement", basis: plan.key });
    expect(build.references).toEqual([
      {
        kind: "basis",
        ref: plan.key,
        targetId: plan.id,
        actor: "captain",
        recordedAt: expect.any(Number),
      },
    ]);
    const restored = setup().tasks;
    restored.importRecords(parseTaskExport(lines));
    expect(exportTaskRecords(restored, 1)).toEqual(lines);

    // An export written before the references: only the shape names it.
    const older = lines.map((line) => {
      const row = JSON.parse(line);
      if (row.kind !== "task") return line;
      const { references: _references, ...kept } = row;
      return JSON.stringify(kept);
    });
    const fromOlder = setup().tasks;
    fromOlder.importRecords(parseTaskExport(older));
    expect(fromOlder.get("build")?.shape).toEqual({ kind: "implement", basis: plan.key });
    expect(fromOlder.relationshipsOf("build")).toMatchObject([
      { kind: "basis", to: plan.id, ref: plan.key, actor: null, at: null },
    ]);
    expect(fromOlder.builtOn(plan.id).map((record) => record.id)).toEqual(["build"]);
  });
});
