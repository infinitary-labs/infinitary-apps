import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import {
  CAPTAIN_OWNED_SHAPE_FIELDS,
  DERIVED_SHAPE_FIELDS,
  HOST_KEPT_SHAPE_FIELDS,
  HOST_STAMP_FIELDS,
  workShapeSchema,
} from "../../shared/routingPolicy";
import { effectiveTaskPolicies, type PolicyRepo } from "../../shared/taskPolicies";
import { seedTask } from "./seedTask";
import { queryTasks } from "./taskQuery";
import { TaskService } from "./taskService";

function current(tasks: TaskService, id: string) {
  const task = tasks.get(id);
  if (!task) throw new Error(`Missing task ${id}`);
  return task;
}

function setup() {
  const db = freshDatabase();
  const project: PolicyRepo = {
    delivery: "direct-pr",
    autonomy: false,
    rigor: "standard",
    kind: "project",
  };
  const repos = { get: () => project };
  const tasks = new TaskService({ db, repos });
  tasks.projects.ensureForRepo({ id: "project", name: "Harbour" });
  return { db, tasks, project, repos };
}

describe("live task policies", () => {
  it("derives overrides, explicit resets and local care without changing dispatch history", () => {
    const { tasks, project } = setup();
    const task = seedTask(tasks, {
      id: "work",
      title: "Fix chart",
      repoId: "project",
      status: "running",
      shape: {
        kind: "fix",
        delivery_ask: "direct-pr",
        autonomy_ask: false,
        rigor_ask: "reviewed",
        rigor: "reviewed",
      },
    });
    tasks.recordDelivery(task.id, {
      mode: "direct-pr",
      prNumber: 42,
      prUrl: "https://github.com/example/chart/pull/42",
      headSha: "head",
      ci: "red",
      ciRounds: 2,
      reviewRounds: 1,
    });
    tasks.updateFields(
      task.id,
      { policies: { delivery: "local-only", autonomy: true } },
      "firstmate",
    );
    const changed = current(tasks, task.id);
    expect(tasks.policiesOf(changed)).toMatchObject({
      delivery: { value: "local-only", source: "task" },
      autonomy: { value: true, source: "task" },
      rigor: { value: "standard", requested: "reviewed", source: "task" },
    });
    expect(changed.shape).toMatchObject({
      rigor: "reviewed",
      rigor_ask: "reviewed",
      autonomy_ask: false,
      delivery_ask: "direct-pr",
    });
    expect(changed.delivery).toMatchObject({
      prNumber: 42,
      mode: "direct-pr",
      headSha: "head",
      ci: "red",
      ciRounds: 2,
      reviewRounds: 1,
    });
    tasks.updateFields(
      task.id,
      { policies: { delivery: null, autonomy: null, rigor: null } },
      "firstmate",
    );
    expect(tasks.policiesOf(current(tasks, task.id))).toMatchObject({
      delivery: { value: "direct-pr", source: "project" },
      autonomy: { value: false, source: "project" },
      rigor: { value: "standard", source: "project" },
    });
    project.autonomy = true;
    expect(tasks.policiesOf(current(tasks, task.id))?.autonomy.value).toBe(true);
    expect(queryTasks(tasks, { key: task.key }).rows[0]?.policies).toEqual(
      tasks.policiesOf(current(tasks, task.id)),
    );
    const events = tasks.timeline(task.id).filter((event) => event.data?.changes);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.feed)).toBe(true);
    expect(events[1]?.text).toContain("Project setting");
  });

  it.each(["queued", "running", "idle", "interrupted"] as const)(
    "keeps %s work in place, and persists edits when the service reopens",
    (status) => {
      const { tasks, db, repos } = setup();
      const task = seedTask(tasks, {
        id: status,
        title: status,
        status,
        repoId: "project",
        startPolicy: "on-request",
        gate: { kind: "captain", ref: "unrelated" },
      });
      const before = current(tasks, task.id);
      tasks.updateFields(task.id, { policies: { autonomy: true, rigor: "quick" } }, "firstmate");
      expect(tasks.get(task.id)).toMatchObject({
        status: before.status,
        activity: before.activity,
        startPolicy: before.startPolicy,
        gate: before.gate,
      });
      const after = current(new TaskService({ db, repos }), task.id);
      expect(effectiveTaskPolicies(after, repos.get())).toMatchObject({
        autonomy: { value: true, source: "task" },
        rigor: { value: "quick", source: "task" },
      });
    },
  );

  it("repeated ask-first requests advance the cancellation generation and clear pending settles", () => {
    const { tasks } = setup();
    const task = seedTask(tasks, { id: "ask", title: "Ask", repoId: "project", status: "idle" });
    for (let revision = 1; revision <= 2; revision++) {
      tasks.setPendingSettle(task.id, {
        mode: "merge-pr",
        actor: "captain",
        requestedAt: 1,
        proceedWithOpen: false,
      });
      tasks.updateFields(task.id, { policies: { autonomy: false } }, "firstmate");
      expect(tasks.get(task.id)?.pendingSettle).toBeNull();
      expect(tasks.policiesOf(current(tasks, task.id))?.revision).toBe(revision);
    }
    tasks.updateFields(task.id, { policies: { autonomy: true } }, "firstmate");
    expect(tasks.policiesOf(current(tasks, task.id))?.autonomy.value).toBe(true);
  });

  it("removes only a host review's policy-owned edge, preserving its history, caps and other blockers", () => {
    const { tasks } = setup();
    const task = seedTask(tasks, {
      id: "builder",
      title: "Builder",
      repoId: "project",
      status: "idle",
      shape: { kind: "fix", rigor_ask: "reviewed" },
    });
    const review = seedTask(tasks, {
      id: "review",
      title: "Review",
      repoId: "project",
      status: "idle",
      parentId: task.id,
      shape: { kind: "review", kind_source: "host:review" },
    });
    const dependency = seedTask(tasks, {
      id: "dependency",
      title: "Dependency",
      repoId: "project",
      status: "idle",
    });
    tasks.link(review.id, task.id, "blocks", "host");
    tasks.link(dependency.id, task.id, "blocks", "firstmate");
    tasks.recordDelivery(task.id, {
      reviewVerdict: "findings",
      reviewRounds: 3,
      reviewCapAt: 123,
      ci: "red",
      ciRounds: 3,
      ciCapAt: 124,
    });
    tasks.updateFields(task.id, { policies: { rigor: "quick" } }, "firstmate");
    // The review edge goes. A recorded wait stays on the graph and holds no close.
    expect(tasks.blockers(task.id).map((row) => row.id)).toEqual([dependency.id]);
    expect(tasks.blockersHoldingClose(task.id)).toEqual([]);
    expect(tasks.get(task.id)?.delivery).toMatchObject({
      reviewVerdict: "findings",
      reviewRounds: 3,
      reviewCapAt: 123,
      ci: "red",
      ciRounds: 3,
      ciCapAt: 124,
    });
    tasks.updateFields(task.id, { policies: { rigor: "reviewed" } }, "firstmate");
    expect(tasks.blockersHoldingClose(task.id).map((row) => row.id)).toEqual([review.id]);
    expect(
      tasks
        .blockers(task.id)
        .map((row) => row.id)
        .sort(),
    ).toEqual([dependency.id, review.id].sort());
  });

  it("refuses closed and inapplicable work atomically and freezes closed policy history", () => {
    const { tasks, project } = setup();
    for (const kind of ["answer", "review", "personal", "done", "dropped"] as const) {
      project.kind = kind === "personal" ? "personal" : "project";
      const task = seedTask(tasks, {
        id: kind,
        title: kind,
        repoId: "project",
        status: "idle",
        shape: {
          kind: kind === "review" ? "review" : "fix",
          deliverable: kind === "answer" ? "answer" : "change",
        },
      });
      if (kind === "done" || kind === "dropped")
        tasks.close(task.id, {
          status: kind,
          reason: kind === "done" ? "merged" : "discarded",
          actor: "captain",
        });
      const before = current(tasks, task.id);
      const events = tasks.timeline(task.id);
      expect(() =>
        tasks.updateFields(task.id, { title: "Wrong", policies: { autonomy: true } }, "firstmate"),
      ).toThrow("Policies can only change");
      expect(tasks.get(task.id)).toEqual(before);
      expect(tasks.timeline(task.id)).toEqual(events);
      if (kind === "done") {
        project.autonomy = true;
        expect(tasks.policiesOf(current(tasks, task.id))?.autonomy.value).toBe(false);
      }
    }
  });

  it("freezes a shapeless task's policies without inventing dispatch provenance", () => {
    const { tasks, project } = setup();
    const task = seedTask(tasks, {
      id: "old-work",
      title: "Old work",
      repoId: "project",
      status: "idle",
    });
    expect(task.shape).toBeNull();
    tasks.close(task.id, { status: "done", reason: "merged", actor: "captain" });
    project.autonomy = true;
    expect(current(tasks, task.id).shape).toBeNull();
    expect(tasks.policiesOf(current(tasks, task.id))?.autonomy.value).toBe(false);
  });

  it("rolls back project, title and policy changes when a mixed edit has an unknown parent", () => {
    const { tasks } = setup();
    const task = seedTask(tasks, {
      id: "atomic",
      title: "Keep me",
      repoId: "project",
      status: "queued",
    });
    const other = tasks.projects.ensureForRepo({ id: "other", name: "Other" });
    const before = current(tasks, task.id);
    const events = tasks.timeline(task.id);
    expect(() =>
      tasks.updateFields(
        task.id,
        { project: other.id, title: "Changed", parent: "missing", policies: { autonomy: true } },
        "firstmate",
      ),
    ).toThrow("Unknown parent");
    expect(current(tasks, task.id)).toEqual(before);
    expect(tasks.timeline(task.id)).toEqual(events);
  });

  it("an awaited classifier cannot replace a newer policy edit with its stale shape", () => {
    const { tasks } = setup();
    const task = seedTask(tasks, {
      id: "classified",
      title: "Classify",
      repoId: "project",
      status: "queued",
      shape: { kind: "unclear" },
    });
    tasks.updateFields(task.id, { policies: { rigor: "reviewed" } }, "firstmate");
    tasks.recordShape(task.id, { ...(task.shape ?? { kind: "unclear" }), kind: "fix" }, "high");
    expect(tasks.policiesOf(current(tasks, task.id))?.rigor.value).toBe("reviewed");
  });

  it("an awaited classifier keeps where the captain said a task runs, set or cleared while it ran", () => {
    const { tasks } = setup();
    const task = seedTask(tasks, {
      id: "placed",
      title: "Place",
      repoId: "project",
      status: "queued",
      shape: { kind: "unclear", runs_on_ask: "mini" },
    });
    const stale = { ...(task.shape ?? { kind: "unclear" as const }), kind: "fix" as const };
    tasks.updateFields(task.id, { runsOn: { ask: "this-mac", words: "This Mac" } }, "firstmate");
    tasks.recordShape(task.id, stale, "high");
    expect(current(tasks, task.id).shape).toMatchObject({ kind: "fix", runs_on_ask: "this-mac" });
    tasks.updateFields(task.id, { runsOn: { ask: null, words: "Mac mini" } }, "firstmate");
    tasks.recordShape(task.id, stale, "high");
    expect(current(tasks, task.id).shape?.runs_on_ask).toBeUndefined();
  });

  // FI3-1812 review R1: the captain's own speed and reasoning for a task are
  // edits like Runs on, which a classifier's earlier snapshot never undoes.
  it("an awaited classifier keeps the task's own crew speed and reasoning, set or cleared while it ran", () => {
    const { tasks } = setup();
    const task = seedTask(tasks, {
      id: "named",
      title: "Name",
      repoId: "project",
      status: "queued",
      shape: { kind: "unclear", override_speed: "fast", override_reasoning: "low" },
    });
    const stale = { ...(task.shape ?? { kind: "unclear" as const }), kind: "fix" as const };
    tasks.updateFields(task.id, { speed: "ultrafast", reasoning: "xhigh" }, "firstmate");
    tasks.recordShape(task.id, stale, "high");
    expect(current(tasks, task.id).shape).toMatchObject({
      kind: "fix",
      override_speed: "ultrafast",
      override_reasoning: "xhigh",
    });
    tasks.updateFields(task.id, { speed: null, reasoning: null }, "firstmate");
    tasks.recordShape(task.id, stale, "high");
    expect(current(tasks, task.id).shape).not.toHaveProperty("override_speed");
    expect(current(tasks, task.id).shape).not.toHaveProperty("override_reasoning");
  });

  // INF-416 piece F (T2): the old writer copied six fields back by name and
  // still wrote the classifier's copy over model and basis.
  it("writes a host stamp onto the record as it stands, so six captain edits survive an old copy", () => {
    const { tasks } = setup();
    const first = seedTask(tasks, {
      id: "first",
      title: "First plan",
      repoId: "project",
      status: "queued",
    });
    const second = seedTask(tasks, {
      id: "second",
      title: "Second plan",
      repoId: "project",
      status: "queued",
    });
    const old = {
      kind: "unclear" as const,
      kind_source: "none",
      policies: { rigor: "quick" as const, revision: 1 },
      basis: first.key,
      override_model_id: "old-model",
      override_speed: "fast" as const,
      override_reasoning: "low" as const,
      runs_on_ask: "mini",
    };
    const task = seedTask(tasks, {
      id: "stamped",
      title: "Stamp",
      repoId: "project",
      status: "queued",
      shape: old,
    });
    tasks.updateFields(task.id, { policies: { rigor: "reviewed" } }, "firstmate");
    tasks.updateFields(task.id, { basis: second.key }, "firstmate");
    tasks.updateFields(task.id, { model: "new-model" }, "firstmate");
    tasks.updateFields(task.id, { speed: "ultrafast", reasoning: "xhigh" }, "firstmate");
    tasks.updateFields(task.id, { runsOn: { ask: "this-mac", words: "This Mac" } }, "firstmate");
    tasks.recordShape(
      task.id,
      { ...old, kind: "fix", kind_source: "classifier:test", deliverable: "change" },
      "high",
    );
    expect(current(tasks, task.id).shape).toMatchObject({
      kind: "fix",
      kind_source: "classifier:test",
      deliverable: "change",
      policies: { rigor: "reviewed" },
      basis: second.key,
      override_model_id: "new-model",
      override_speed: "ultrafast",
      override_reasoning: "xhigh",
      runs_on_ask: "this-mac",
    });
    expect(current(tasks, task.id).shape).not.toMatchObject({
      basis: first.key,
      override_model_id: "old-model",
    });
    // The list INF-409 reuses names each of those six, and every shape field once.
    expect(CAPTAIN_OWNED_SHAPE_FIELDS).toEqual(
      expect.arrayContaining([
        "policies",
        "basis",
        "override_model_id",
        "override_speed",
        "override_reasoning",
        "runs_on_ask",
      ]),
    );
    expect(
      new Set([
        ...CAPTAIN_OWNED_SHAPE_FIELDS,
        ...HOST_STAMP_FIELDS,
        ...HOST_KEPT_SHAPE_FIELDS,
        ...DERIVED_SHAPE_FIELDS,
      ]),
    ).toEqual(new Set(workShapeSchema.keyof().options));
  });

  // FI3-1812 review R3: update_task's direction says the record names it.
  it("names the standing direction behind a crew speed or reasoning edit", () => {
    const { tasks } = setup();
    const task = seedTask(tasks, {
      id: "directed",
      title: "Direct",
      repoId: "project",
      status: "queued",
      shape: { kind: "unclear" },
    });
    expect(
      tasks.updateFields(
        task.id,
        { speed: "fast", reasoning: "high", direction: "d:careful-reviews" },
        "firstmate",
      ),
    ).toEqual([
      "crew speed fast, from d:careful-reviews",
      "reasoning high, from d:careful-reviews",
    ]);
    expect(
      tasks.updateFields(
        task.id,
        { speed: null, reasoning: null, direction: "d:careful-reviews" },
        "firstmate",
      ),
    ).toEqual([
      "crew speed follows the model default, from d:careful-reviews",
      "reasoning follows Models, from d:careful-reviews",
    ]);
  });

  it("changes where a task runs only before it starts, and says what changed", () => {
    const { tasks } = setup();
    const filed = seedTask(tasks, {
      id: "filed",
      title: "Filed",
      repoId: "project",
      status: "queued",
    });
    expect(
      tasks.updateFields(
        filed.id,
        { runsOn: { ask: "mini", words: "Mac mini (This task)" } },
        "firstmate",
      ),
    ).toEqual(["Runs on: Mac mini (This task)"]);
    expect(
      tasks.updateFields(filed.id, { runsOn: { ask: "mini", words: "x" } }, "firstmate"),
    ).toEqual([]);
    const going = seedTask(tasks, {
      id: "going",
      title: "Going",
      repoId: "project",
      status: "running",
    });
    expect(() =>
      tasks.updateFields(going.id, { runsOn: { ask: "mini", words: "x" } }, "firstmate"),
    ).toThrow("a started task finishes where it started");
    expect(current(tasks, going.id).shape?.runs_on_ask).toBeUndefined();
  });
});
