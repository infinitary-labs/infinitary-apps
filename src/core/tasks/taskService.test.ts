import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { waitStall } from "@shared/recovery";
import { describe, expect, it } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { planDetails } from "../../../tests/helpers/statementPlans";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { DECISION_RECORD_SCHEMA, type DecisionRecord } from "../../shared/provenance";
import type { WorkShape } from "../../shared/routingPolicy";
import { initOverflowDir, MESSAGE_EXCERPT_LIMIT } from "../overflow";
import { savedDeliveryReader } from "../storage/taskDeliveryFields";
import type { TaskRecord } from "../storage/taskRecords";
import { seedProject } from "../workspace/seedProject";
import { reportEntryOf } from "./reportEntry";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";
import { TIMELINE_CAP, TIMELINE_KEEP } from "./timelineCompaction";

function setup() {
  const db = freshDatabase();
  seedProject(db, {
    id: "r1",
    name: "nimbus-api",
    path: "/fleet/nimbus-api",
    delivery: "direct-pr",
    addedAt: 1,
  });
  let now = 1_000;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  return { db, tasks, tick: (ms = 1) => (now += ms) };
}

const intent = { goal: "Ship it", userWords: "please ship it" };

// INF-2006: the computer resource feed asks whether work exists on every
// two-second tick and every task change; composing the whole history to
// answer it stalled the window for about 50 ms per read at 4,813 tasks.
describe("whether any task holds a status", () => {
  it("answers from one row, however long the closed history, and follows each status change", () => {
    const { db, tasks } = setup();
    for (let i = 0; i < 50; i++) {
      seedTask(tasks, {
        id: `old-${i}`,
        title: `Earlier work ${i}`,
        repoId: "r1",
        status: "queued",
      });
      tasks.close(`old-${i}`, { status: "done", reason: "settled", actor: "host" });
    }
    seedTask(tasks, { id: "waiting", title: "Queued work", repoId: "r1", status: "queued" });
    const active = () => tasks.list().some((task) => task.status === "active");
    expect(tasks.hasStatus("active")).toBe(false);
    expect(active()).toBe(false);
    expect(tasks.hasStatus("open")).toBe(true);

    seedTask(tasks, {
      id: "held",
      title: "Held work",
      repoId: "r1",
      status: "running",
      worktreeDir: "/wt/h",
    });
    expect(tasks.hasStatus("active")).toBe(true);
    expect(active()).toBe(true);
    expect(rowsRead(db, () => tasks.hasStatus("active"))).toBe(1);
    expect(rowsRead(db, () => active())).toBeGreaterThan(50);

    tasks.close("held", { status: "done", reason: "settled", actor: "host" });
    expect(tasks.hasStatus("active")).toBe(false);
    expect(active()).toBe(false);
  });
});

// INF-4680's start cuts: what each start reads of every task, without
// composing a record for each one.
describe("reading every task at start", () => {
  it("gives each task's status and the tasks holding a working copy as the full records say", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "waiting", title: "Queued work", repoId: "r1", status: "queued" });
    seedTask(tasks, {
      id: "held",
      title: "Held work",
      repoId: "r1",
      status: "running",
      worktreeDir: "/wt/h",
    });
    seedTask(tasks, {
      id: "kept",
      title: "Closed, its copy kept",
      repoId: "r1",
      status: "running",
      worktreeDir: "/wt/k",
    });
    tasks.close("kept", { status: "done", reason: "settled", actor: "host" });
    seedTask(tasks, { id: "gone", title: "Dropped", repoId: "r1", status: "queued" });
    tasks.close("gone", { status: "dropped", reason: "cancelled", actor: "host" });
    const all = tasks.list();
    expect(tasks.statuses()).toEqual(new Map(all.map((task) => [task.id, task.status])));
    const present = all.filter((task) => task.workspaceState === "present").map((t) => t.id);
    expect(present.sort()).toEqual(["held", "kept"]);
    expect(
      tasks
        .withPresentWorkspace()
        .map((task) => task.id)
        .sort(),
    ).toEqual(present);
    expect(tasks.withPresentWorkspace().find((task) => task.id === "kept")).toEqual(
      tasks.get("kept"),
    );
  });

  // A full index on id and status made the planner walk every closed task
  // in the container repair's and the dead-blocked sweep's joins.
  it("leaves the plan of every other read as it was without the start's two indexes", () => {
    const { db, tasks } = setup();
    const seen = new Set<string>();
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seen.add(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    seedTask(tasks, { id: "parent", title: "Container", repoId: "r1", status: "queued" });
    seedTask(tasks, { id: "dropped", title: "Dropped blocker", repoId: "r1", status: "queued" });
    tasks.close("dropped", { status: "dropped", reason: "cancelled", actor: "host" });
    seedTask(tasks, {
      id: "waiting",
      title: "Blocked work",
      repoId: "r1",
      status: "queued",
      parentId: "parent",
      blockedBy: ["dropped"],
    });
    try {
      tasks.list();
      tasks.statuses();
      tasks.withPresentWorkspace();
      tasks.listClosedRetentionFields(null, null);
      tasks.listClosedRetentionFields(1, 2_000);
      tasks.graph.listDeadBlocked();
      tasks.reopenHeldContainers();
      new TaskService({ db, repos: { get: () => undefined }, strict: true });
    } finally {
      db.prepare = prepare;
    }
    const reads = [...seen].filter(
      (sql) => /\btasks\b/.test(sql) && /^\s*(SELECT|WITH)/i.test(sql),
    );
    const plans = () => reads.map((sql) => planDetails(db, sql));
    const owners = (plan: unknown) =>
      /tasks_status_reads|tasks_missing_invariants/.test(JSON.stringify(plan));
    const withIndexes = plans();
    // The status read, the two reads of every close and the record check.
    expect(withIndexes.filter(owners)).toHaveLength(4);
    db.exec("DROP INDEX tasks_status_reads; DROP INDEX tasks_missing_invariants");
    const without = plans();
    expect(withIndexes.filter((plan) => !owners(plan))).toEqual(
      without.filter((_, at) => !owners(withIndexes[at])),
    );
    // The two joins the full index reordered are among them.
    expect(reads.filter((sql) => /JOIN tasks/.test(sql)).length).toBeGreaterThanOrEqual(2);
    expect(withIndexes.every((plan) => plan !== null)).toBe(true);
  });

  it("still finds a row that lacks its key when the record opens", () => {
    const { db, tasks } = setup();
    seedTask(tasks, { id: "waiting", title: "Queued work", repoId: "r1", status: "queued" });
    new TaskService({ db, repos: { get: () => undefined }, strict: true });
    db.prepare("UPDATE tasks SET key = NULL WHERE id = 'waiting'").run();
    expect(() => new TaskService({ db, repos: { get: () => undefined }, strict: true })).toThrow(
      "1 task row(s) lack key/project_id/updated_at after migration.",
    );
  });
});

describe("starting dropped work again", () => {
  it("copies project/repository and priority while publishing the replacement and live waits atomically", () => {
    const { tasks } = setup();
    const old = tasks.create({
      id: "old",
      title: "Finish it",
      goal: "Finish the sketch",
      intent,
      prompt: "sketch",
      repoId: "r1",
      priority: 1,
    });
    const waiter = tasks.create({
      id: "waiter",
      title: "Share",
      prompt: "share",
      repoId: "r1",
      blockedBy: [old.id],
      status: "active",
    });
    tasks.close(old.id, { status: "dropped", reason: "discarded", actor: "captain" });
    const seen: string[][] = [];
    tasks.onChange(() =>
      seen.push([
        tasks.graph.replacementOf(old.id) ?? "missing",
        ...tasks.graph.blockers(waiter.id).map((row) => row.key),
      ]),
    );
    const fresh = tasks.starts.startAgain(old.id, {
      id: "fresh",
      shape: { kind: "unclear" },
      actor: "captain",
      via: "task-card",
    });
    expect(fresh).toMatchObject({
      title: old.title,
      goal: old.goal,
      intent,
      prompt: old.prompt,
      repoId: "r1",
      projectId: old.projectId,
      priority: 1,
      status: "open",
      startPolicy: "on-request",
      sessionFile: null,
      model: null,
      delivery: null,
    });
    expect(seen).toEqual([[fresh.key, fresh.key]]);
    expect(tasks.get(old.id)).toMatchObject({ status: "dropped", closedReason: "discarded" });
    const seq = tasks.boardSeq();
    expect(() =>
      tasks.starts.startAgain(old.id, {
        id: "duplicate",
        shape: { kind: "unclear" },
        actor: "captain",
      }),
    ).toThrow("already replaces");
    expect(tasks.boardSeq()).toBe(seq);
    expect(tasks.get("duplicate")).toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});

describe("recovering a basis before implementation starts", () => {
  it("attaches, replaces and clears grounding while preserving the rest of the work shape", () => {
    const { tasks } = setup();
    const plan = tasks.create({ id: "plan", title: "Plan", prompt: "p", repoId: "r1" });
    const other = tasks.create({ id: "other", title: "Other spec", prompt: "p", repoId: "r1" });
    const build = tasks.create({
      id: "build",
      title: "Build",
      prompt: "p",
      repoId: "r1",
      shape: { kind: "implement", rigor_ask: "standard", autonomy_ask: false },
      startPolicy: "on-request",
    });
    expect(tasks.updateFields(build.id, { basis: plan.id }, "firstmate")).toEqual([
      `basis ${plan.key}`,
    ]);
    expect(tasks.get(build.id)?.shape).toMatchObject({
      kind: "implement",
      basis: plan.key,
      rigor_ask: "standard",
      autonomy_ask: false,
    });
    expect(tasks.updateFields(build.id, { basis: other.key }, "firstmate")).toEqual([
      `basis ${other.key}`,
    ]);
    expect(tasks.updateFields(build.id, { basis: "" }, "firstmate")).toEqual(["basis cleared"]);
    expect(tasks.get(build.id)?.shape).not.toHaveProperty("basis");
    expect(tasks.get(build.id)).toMatchObject({ status: "open", startPolicy: "on-request" });
    expect(() =>
      tasks.updateFields(build.id, { basis: build.key, title: "Changed" }, "firstmate"),
    ).toThrow("own basis");
    expect(tasks.get(build.id)?.title).toBe("Build");
    expect(() => tasks.updateFields(build.id, { basis: "missing" }, "firstmate")).toThrow(
      "Unknown basis",
    );
  });

  it("refuses changing a live, closed or previously started task's spec, and keeps it open to change after a start that began no crewmate", () => {
    const { db, tasks } = setup();
    const plan = tasks.create({ id: "plan", title: "Plan", prompt: "p", repoId: "r1" });
    for (const status of ["active", "done", "dropped"] as const) {
      const record = tasks.create({
        id: status,
        title: status,
        prompt: "p",
        repoId: "r1",
        status: status === "active" ? "active" : "open",
      });
      if (status !== "active")
        tasks.close(record.id, {
          status,
          reason: status === "done" ? "answered" : "cancelled",
          actor: "captain",
        });
      expect(() => tasks.updateFields(record.id, { basis: plan.key }, "firstmate")).toThrow(
        "has not started",
      );
    }
    // An older version's failed start left the row open and still marked started.
    seedTask(tasks, { id: "started", title: "Started", status: "running" });
    db.prepare(
      "UPDATE tasks SET status = 'open', activity = NULL, assignee = NULL WHERE id = 'started'",
    ).run();
    expect(tasks.get("started")).toMatchObject({ status: "open", startedAt: expect.any(Number) });
    expect(() => tasks.updateFields("started", { basis: plan.key }, "firstmate")).toThrow(
      "has not started",
    );
    // INF-3307 row 4: a start that failed before its crewmate began leaves the task never started.
    seedTask(tasks, { id: "returned", title: "Returned", status: "running" });
    tasks.starts.returnStart("returned", { kind: "failed", reason: "its working copy failed" });
    expect(tasks.updateFields("returned", { basis: plan.key }, "firstmate")).toEqual([
      `basis ${plan.key}`,
    ]);
  });
});

describe("naming a model for a filed task (FI3-436)", () => {
  it("names, replaces and clears the model while preserving the rest of the work shape", () => {
    const { tasks } = setup();
    const plan = tasks.create({ id: "plan", title: "Plan", prompt: "p", repoId: "r1" });
    const build = tasks.create({
      id: "build",
      title: "Build",
      prompt: "p",
      repoId: "r1",
      difficulty: "high",
      shape: { kind: "implement", kind_source: "none", basis: plan.key, rigor_ask: "standard" },
      startPolicy: "on-request",
    });
    expect(tasks.updateFields(build.id, { model: " claude-fable-5-1 " }, "firstmate")).toEqual([
      "model claude-fable-5-1",
    ]);
    // R0 names a model, not a tier: the record's tier follows the shape.
    expect(tasks.get(build.id)).toMatchObject({
      key: build.key,
      difficulty: null,
      shape: {
        kind: "implement",
        basis: plan.key,
        rigor_ask: "standard",
        override_model_id: "claude-fable-5-1",
      },
    });
    expect(tasks.updateFields(build.id, { model: "claude-fable-5-1" }, "firstmate")).toEqual([]);
    expect(
      tasks.updateFields(build.id, { model: "anthropic-claude/claude-fable-5-1" }, "firstmate"),
    ).toEqual(["model anthropic-claude/claude-fable-5-1"]);
    expect(tasks.updateFields(build.id, { model: "" }, "firstmate")).toEqual(["model cleared"]);
    expect(tasks.get(build.id)?.shape).not.toHaveProperty("override_model_id");
    expect(tasks.get(build.id)).toMatchObject({ status: "open", startPolicy: "on-request" });
    expect(tasks.get(build.id)?.difficulty).not.toBeNull();
  });

  it("names a model alongside a basis in one edit, on a row filed with no shape", () => {
    const { tasks } = setup();
    const plan = tasks.create({ id: "plan", title: "Plan", prompt: "p", repoId: "r1" });
    tasks.create({ id: "filed", title: "Filed", prompt: "p", repoId: "r1" });
    expect(
      tasks.updateFields("filed", { basis: plan.key, model: "gpt-6-astra" }, "firstmate"),
    ).toEqual([`basis ${plan.key}`, "model gpt-6-astra"]);
    expect(tasks.get("filed")?.shape).toMatchObject({
      basis: plan.key,
      override_model_id: "gpt-6-astra",
    });
  });

  it("asks for the kind again once a model that skipped it is cleared", () => {
    const { tasks } = setup();
    tasks.create({
      id: "skipped",
      title: "Skipped",
      prompt: "p",
      repoId: "r1",
      shape: { kind: "unclear", kind_source: "skipped:override", override_model_id: "gpt-6-astra" },
    });
    tasks.updateFields("skipped", { model: "" }, "firstmate");
    expect(tasks.get("skipped")?.shape?.kind_source).toBe("none");
  });

  it("names a model on queued work a failed start returned, but not on work a crewmate holds or closed", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "requeued", title: "Requeued", status: "running" });
    tasks.starts.returnStart("requeued", { kind: "failed", reason: "failed start" });
    expect(tasks.updateFields("requeued", { model: "gpt-6-astra" }, "firstmate")).toEqual([
      "model gpt-6-astra",
    ]);
    seedTask(tasks, { id: "running", title: "Running", status: "running" });
    expect(() => tasks.updateFields("running", { model: "gpt-6-astra" }, "firstmate")).toThrow(
      "only be named on open work",
    );
    const closed = tasks.create({ id: "closed", title: "Closed", prompt: "p", repoId: "r1" });
    tasks.close(closed.id, { status: "dropped", reason: "cancelled", actor: "captain" });
    expect(() => tasks.updateFields(closed.id, { model: "gpt-6-astra" }, "firstmate")).toThrow(
      "only be named on open work",
    );
    expect(tasks.get("running")?.shape?.override_model_id).toBeUndefined();
  });
});

describe("scope edits", () => {
  it("repairs already-divergent saved intent even when the goal column matches the edit", () => {
    const { tasks } = setup();
    const record = tasks.create({
      id: "stale",
      title: "Transitions",
      goal: "Expanded scope",
      intent: { goal: "Original scope", userWords: "build transitions" },
      prompt: "Goal: Original scope\n\nVerbatim constraints and delivery.",
      repoId: null,
    });
    tasks.updateFields(record.id, { goal: "Expanded scope" }, "firstmate");
    expect(tasks.get(record.id)).toMatchObject({
      goal: "Expanded scope",
      intent: { goal: "Expanded scope", userWords: "build transitions" },
      prompt: "Goal: Expanded scope\n\nVerbatim constraints and delivery.",
    });
  });

  it("amends a filing's host goal without fabricating captain words or removing provenance", () => {
    const { tasks } = setup();
    const origin = tasks.create({ id: "origin", title: "Investigate", prompt: "p", repoId: null });
    const filing = tasks.fileFollowup({
      id: "filing",
      originId: origin.id,
      title: "Fix",
      goal: "Old goal",
      why: "Recorded finding",
      prompt: "Goal: Old goal\n\nRecorded filing provenance.",
    }).record;
    tasks.updateFields(filing.id, { goal: "Expanded finding" }, "firstmate");
    expect(tasks.get(filing.id)).toMatchObject({
      goal: "Expanded finding",
      intent: null,
      prompt: "Goal: Expanded finding\n\nRecorded filing provenance.",
    });
    expect(tasks.graph.discoveredOrigins(filing.id).map((row) => row.id)).toEqual([origin.id]);
  });
});

describe("close invariants (interaction P0, WI-7)", () => {
  function dispatched(tasks: TaskService, id: string) {
    tasks.create({ id, title: `Task ${id}`, prompt: "p", repoId: "r1", status: "active" });
    tasks.starts.dispatch(id, {
      workspace: {
        repoDir: "/fleet/nimbus-api",
        worktreeDir: `/wt/${id}`,
        branch: `fm/task-${id}`,
      },
      accountId: null,
      assignee: "crewmate 1",
    });
  }
  it("every close path stamps closed_at", () => {
    const { tasks, tick } = setup();
    dispatched(tasks, "closed");
    tick();
    tasks.close("closed", { status: "dropped", reason: "cancelled", actor: "captain" });
    const parent = tasks.create({ id: "parent", title: "Parent", prompt: "p", repoId: null });
    tasks.create({ id: "child", title: "Child", prompt: "p", repoId: null, parentId: parent.id });
    tick();
    tasks.dropWithChildren("parent", { reason: "not needed", actor: "captain" });
    tick();
    tasks.capture.fileQuestion({ id: "question", title: "Why", outcome: "Because." });
    tick();
    tasks.capture.fileOperation({
      id: "operation",
      title: "Adopt",
      outcome: "Adopted.",
      tool: "setup_repo",
    });

    const closed = tasks.list().filter((record) => TaskService.isClosed(record));
    expect(closed.map((record) => record.id).sort()).toEqual([
      "child",
      "closed",
      "operation",
      "parent",
      "question",
    ]);
    for (const record of closed) {
      expect(record.closedAt, record.id).toBeGreaterThan(0);
    }
  });
});

describe("TaskService (task-system P0)", () => {
  it("mints per-project keys from the repo's project, else Scratch, and starts the timeline", () => {
    const { tasks } = setup();
    const a = tasks.create({ id: "a", title: "A", prompt: "p", intent, repoId: "r1" });
    const b = tasks.create({ id: "b", title: "B", prompt: "p", repoId: "r1" });
    const c = tasks.create({ id: "c", title: "C", prompt: "p", repoId: null });
    const d = tasks.create({ id: "d", title: "D", prompt: "p", repoId: "unknown-repo" });
    expect([a.key, b.key, c.key, d.key]).toEqual(["NIA-1", "NIA-2", "SCR-1", "SCR-2"]);
    expect(a).toMatchObject({
      projectId: "proj-r1",
      seq: 1,
      status: "open",
      activity: null,
      goal: "Ship it",
      intent,
      priority: 2,
      startPolicy: "when-ready",
      workspaceState: "none",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(tasks.byKey("nia-2")?.id).toBe("b");
    expect(tasks.timeline("a")).toEqual([
      expect.objectContaining({ kind: "created", actor: "firstmate", feed: false }),
    ]);
  });

  it("dispatches, records reports and activity, and closes without deleting (D2)", () => {
    const { tasks, tick } = setup();
    tasks.create({ id: "t", title: "T", prompt: "p", repoId: "r1", status: "active" });
    expect(tasks.get("t")).toMatchObject({ status: "active", activity: "starting" });
    tick();
    tasks.starts.dispatch("t", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/t", branch: "fm/task-t" },
      accountId: "acct_1",
      assignee: "crewmate 1",
      model: { provider: "openai-codex", id: "gpt-5.5" },
    });
    expect(tasks.get("t")).toMatchObject({
      activity: "starting",
      workspaceState: "present",
      assignee: "crewmate 1",
      model: "openai-codex/gpt-5.5",
      accountId: "acct_1",
      startedAt: 1_001,
    });
    tick();
    tasks.turns.setActivity("t", "running");
    tasks.turns.recordReport("t", { text: "Fixed the flake. Two files changed." });
    tasks.turns.setActivity("t", "idle");
    expect(tasks.get("t")).toMatchObject({
      activity: "idle",
      outcome: "Fixed the flake. Two files changed.",
      outcomeSummary: "Fixed the flake.",
    });
    tick();
    // A finished crewmate stays active and idle (WI-11); the close is the
    // landing itself, done in one step.
    tasks.close("t", {
      status: "done",
      reason: "landed",
      actor: "captain",
      delivery: { landedMode: "fast-forward" },
    });
    tasks.placement.markWorkspaceRemoved("t");
    const closed = tasks.get("t");
    expect(closed).toMatchObject({
      status: "done",
      closedReason: "landed",
      workspaceState: "removed",
      delivery: { mode: "direct-pr", landedMode: "fast-forward" },
      outcome: "Fixed the flake. Two files changed.",
    });
    expect(tasks.timeline("t").map((event) => [event.kind, event.actor])).toEqual([
      ["created", "firstmate"],
      ["dispatched", "host"],
      ["report", "crewmate"],
      ["landed", "captain"],
      ["note", "host"],
    ]);
    expect(tasks.list()).toHaveLength(1);
  });

  it("claimForDispatch takes open work off the ready query once", () => {
    const { tasks } = setup();
    tasks.create({ id: "t", title: "T", prompt: "p", repoId: null });
    expect(tasks.graph.listReady().map((r) => r.id)).toEqual(["t"]);
    expect(tasks.starts.claimForDispatch("t")).toBe(true);
    expect(tasks.get("t")).toMatchObject({
      status: "active",
      activity: "starting",
      gate: null,
      startedAt: 1_000,
    });
    expect(tasks.graph.listReady()).toEqual([]);
    expect(tasks.starts.claimForDispatch("t")).toBe(false);
    expect(tasks.timeline("t").at(-1)).toMatchObject({ kind: "status", text: "starting" });
  });

  it("boot returns a claimed-but-unstarted row to the ready query", () => {
    const { db, tasks } = setup();
    tasks.create({ id: "t", title: "T", prompt: "p", repoId: null });
    expect(tasks.starts.claimForDispatch("t")).toBe(true);
    const again = new TaskService({ db, now: () => 2_000, strict: true });
    expect(again.get("t")).toMatchObject({ status: "open", activity: null, gate: null });
    expect(again.graph.listReady().map((r) => r.id)).toEqual(["t"]);
    expect(again.timeline("t").at(-1)).toMatchObject({
      kind: "status",
      text: "returned to the queue - the start did not finish",
      feed: true,
    });
  });

  it("returns a start held for a sign-in to the queue behind its gate, never started", () => {
    const { tasks } = setup();
    tasks.create({
      id: "q",
      title: "Q",
      prompt: "p",
      repoId: null,
      gate: { kind: "at-time", until: 5 },
    });
    tasks.starts.dispatch("q", {
      workspace: { repoDir: "/r", worktreeDir: "/wt/q", branch: "fm/task-q" },
      accountId: null,
      assignee: "crewmate 2",
    });
    const gate = {
      kind: "captain" as const,
      ref: "forge-sign-in:github.com",
      reason: "waiting for GitHub sign-in",
    };
    tasks.starts.returnStart("q", { kind: "held", gate });
    expect(tasks.get("q")).toMatchObject({
      status: "open",
      activity: null,
      worktreeDir: "",
      workspaceState: "none",
      assignee: null,
      startedAt: null,
      gate,
    });
    expect(tasks.timeline("q").at(-1)).toMatchObject({
      text: "returned to the queue - waiting for GitHub sign-in",
    });
    expect(tasks.listOpen().map((r) => r.id)).toEqual(["q"]);
  });

  it("records delivery facts against the repo posture and events for CI reads", () => {
    const { tasks } = setup();
    tasks.create({ id: "pr", title: "PR", prompt: "p", repoId: "r1", status: "active" });
    seedDelivery(
      tasks,
      "pr",
      { prUrl: "https://x/1", prNumber: 1 },
      { kind: "pr_opened", text: "PR #1", feed: true },
    );
    seedDelivery(tasks, "pr", { ci: "green", ciAt: 1_000 }, { kind: "ci", text: "CI green" });
    expect(tasks.get("pr")?.delivery).toEqual({
      mode: "direct-pr",
      prUrl: "https://x/1",
      prNumber: 1,
      ci: "green",
      ciAt: 1_000,
    });
    expect(tasks.timeline("pr").map((e) => [e.kind, e.feed])).toEqual([
      ["created", false],
      ["pr_opened", true],
      ["ci", false],
    ]);
  });

  it("records delivery facts against a task-level ask, not the repo default", () => {
    const { tasks } = setup();
    tasks.create({
      id: "local",
      title: "Local",
      prompt: "p",
      repoId: "r1",
      status: "active",
      shape: { kind: "fix", kind_source: "none", delivery_ask: "local-only" },
    });
    seedDelivery(tasks, "local", { landedMode: "fast-forward" });
    expect(tasks.get("local")?.delivery).toMatchObject({
      mode: "local-only",
      landedMode: "fast-forward",
    });
  });

  // INF-1288 piece 3, the captain's "Remove the two fields nothing reads":
  // rows an older build saved keep them on disk, and read as before.
  it("reads a row an older build saved without its retired fields, and drops them at its next write", () => {
    const { db, tasks } = setup();
    const landedAt = 5_300;
    const facts = {
      mode: "direct-pr",
      prNumber: 86,
      prUrl: "https://github.com/example/chart/pull/86",
      ci: "merged",
      ciAt: 5_200,
      landedMode: "pr",
    } as const;
    const savedDelivery = JSON.stringify({ ...facts, landedAt });
    // The older shape's knowledge grant, whose one value was "references".
    const shape = { kind: "implement", kind_source: "none" } as const;
    seedTask(tasks, {
      id: "older",
      title: "Merged before",
      repoId: "r1",
      status: "completed",
      shape: { ...shape, knowledge_access: "references" } as WorkShape,
    });
    seedDelivery(tasks, "older", JSON.parse(savedDelivery));
    const saved = () => {
      const row = db
        .prepare("SELECT shape_json, delivery_json FROM task_records WHERE id = ?")
        .get("older") as { shape_json: string; delivery_json: string };
      // The delivery as saved across its column and its evidence and permission rows.
      const delivery = savedDeliveryReader(db)("older", row.delivery_json);
      return { shape: JSON.parse(row.shape_json), delivery: JSON.parse(String(delivery)) };
    };
    expect(saved().shape).toHaveProperty("knowledge_access", "references");
    expect(saved().delivery).toHaveProperty("landedAt", landedAt);

    expect(tasks.get("older")).toMatchObject({ shape, delivery: facts });
    expect(tasks.get("older")?.shape).not.toHaveProperty("knowledge_access");
    expect(tasks.get("older")?.delivery).not.toHaveProperty("landedAt");

    tasks.placement.recordShape("older", { deliverable: "change" }, null);
    seedDelivery(tasks, "older", { ci: "merged" });
    expect(saved()).toEqual({
      shape: { ...shape, deliverable: "change" },
      delivery: { ...facts, ci: "merged" },
    });
  });

  it("interrupts a turn a dead process left running at boot, and only then", () => {
    const { db, tasks } = setup();
    seedTask(tasks, { id: "run", title: "running", status: "running", worktreeDir: "/wt/run" });
    seedTask(tasks, { id: "idle", title: "idle", status: "idle", worktreeDir: "/wt/idle" });
    seedTask(tasks, { id: "open", title: "queued", status: "queued" });
    const rebooted = new TaskService({ db, strict: true });
    expect(rebooted.get("run")?.activity).toBe("interrupted");
    expect(rebooted.get("idle")?.activity).toBe("idle");
    expect(rebooted.get("open")?.status).toBe("open");
  });

  it("revises a settled run's operation in place and withdraws it, and refuses other rows", () => {
    const { tasks, tick } = setup();
    const filed = tasks.capture.fileOperation({
      id: "run",
      title: "window wash 48% → 50%",
      outcome: "window wash 48% → 50%",
      tool: "app_change",
      actor: "captain",
    });
    tick(500);
    tasks.capture.reviseOperation("run", {
      title: "window wash 48% → 76%",
      outcome: "window wash 48% → 76%",
    });
    expect(tasks.get("run")).toMatchObject({
      key: filed.key,
      title: "window wash 48% → 76%",
      outcome: "window wash 48% → 76%",
      status: "done",
      createdAt: filed.createdAt,
      closedAt: filed.createdAt + 500,
    });
    tasks.create({ id: "work", title: "Work", prompt: "p", repoId: "r1" });
    expect(() => tasks.archive.withdrawOperation("work")).toThrow("is not an operation");
    expect(() => tasks.capture.reviseOperation("work", { title: "x", outcome: "x" })).toThrow(
      "is not an operation",
    );
    tasks.archive.withdrawOperation("run");
    expect(tasks.get("run")).toBeUndefined();
    expect(tasks.timeline("run")).toEqual([]);
    expect(tasks.get("work")?.title).toBe("Work");
  });

  it("hard-deletes only a spawn that never ran, and the D-13 purge keeps projects", () => {
    const { db, tasks } = setup();
    tasks.create({ id: "dead", title: "never ran", prompt: "p", repoId: "r1", status: "active" });
    tasks.archive.discardFailedSpawn("dead");
    expect(tasks.get("dead")).toBeUndefined();
    expect(tasks.timeline("dead")).toEqual([]);
    tasks.create({ id: "x", title: "X", prompt: "p", repoId: "r1" });
    tasks.create({ id: "y", title: "Y", prompt: "p", repoId: null, blockedBy: ["x"] });
    expect(tasks.archive.purge()).toBe(2);
    expect(tasks.list()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_events").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_links").get()).toEqual({ n: 0 });
    expect(
      tasks.projects
        .list()
        .map((p) => p.key)
        .sort(),
    ).toEqual(["NIA", "SCR"]);
    // Keys keep counting: history never reuses a handle.
    expect(tasks.create({ id: "z", title: "Z", prompt: "p", repoId: "r1" }).key).toBe("NIA-3");
  });

  it("refuses to boot strict over rows that lack the record invariants", () => {
    const db = freshDatabase();
    db.prepare(
      "INSERT INTO tasks (id, kind, title, repo_id, repo_dir, worktree_dir, branch, status, created_at) VALUES ('raw', 'work', 'raw', NULL, '', '', '', 'open', 1)",
    ).run();
    expect(() => new TaskService({ db, strict: true })).toThrow(/lack key\/project_id\/updated_at/);
    expect(() => new TaskService({ db })).not.toThrow();
  });

  it("folds an over-cap timeline into one compacted head, absorbing an earlier fold (P5)", () => {
    const { tasks, tick } = setup();
    tasks.create({ id: "t", title: "T", prompt: "p", repoId: "r1", status: "active" });
    const createdAt = tasks.get("t")?.createdAt as number;
    for (let index = 1; index <= TIMELINE_CAP - 1; index += 1) {
      tick();
      tasks.noteProgress("t", `step ${index}`);
    }
    expect(tasks.timeline("t")).toHaveLength(TIMELINE_CAP);
    expect(tasks.timeline("t")[0]?.kind).toBe("created");
    tick();
    tasks.noteProgress("t", "one over");
    const folded = tasks.timeline("t");
    expect(folded).toHaveLength(TIMELINE_KEEP);
    const head = folded[0];
    const foldedCount = TIMELINE_CAP + 1 - TIMELINE_KEEP + 1;
    expect(head).toMatchObject({
      kind: "compacted",
      actor: "host",
      feed: false,
      text: `${foldedCount} earlier events folded`,
      data: {
        folded: foldedCount,
        firstAt: createdAt,
        kinds: { created: 1, progress: foldedCount - 1 },
      },
    });
    // The head sorts before everything it stands for, and the tail is intact.
    expect(folded.slice(1).every((event) => event.kind === "progress")).toBe(true);
    expect(folded.at(-1)?.text).toBe("one over");
    expect(folded.slice(1).every((event) => event.at > (head?.at as number))).toBe(true);

    // The next fold absorbs the head's counts rather than nesting folds.
    for (let index = 0; index < TIMELINE_CAP - TIMELINE_KEEP + 1; index += 1) {
      tick();
      tasks.noteProgress("t", `later ${index}`);
    }
    const again = tasks.timeline("t");
    expect(again).toHaveLength(TIMELINE_KEEP);
    expect(again.filter((event) => event.kind === "compacted")).toHaveLength(1);
    const secondFold = TIMELINE_CAP + 1 - TIMELINE_KEEP + 1;
    expect(again[0]?.data).toEqual({
      folded: foldedCount + secondFold - 1,
      firstAt: createdAt,
      lastAt: again[0]?.at,
      kinds: { created: 1, progress: foldedCount - 1 + secondFold - 1 },
    });
    expect(tasks.get("t")?.status).toBe("active");
  });

  it("does not rewrite a lone ordinary row when exempt provenance exceeds the cap", () => {
    const { tasks, tick } = setup();
    tasks.create({ id: "t", title: "T", prompt: "p", repoId: "r1", status: "active" });

    for (let index = 0; index <= TIMELINE_CAP; index += 1) {
      tick();
      tasks.turns.recordInterrupt("t", {
        actor: "captain",
        mode: "interrupt",
        effect: "no-turn",
        via: "shell",
        decision: null,
      });
    }

    const timeline = tasks.timeline("t");
    expect(timeline).toHaveLength(TIMELINE_CAP + 2);
    expect(timeline.filter((event) => event.kind === "created")).toHaveLength(1);
    expect(timeline.filter((event) => event.kind === "compacted")).toEqual([]);
  });

  it("keeps prospective provenance intact while ordinary timeline events fold", () => {
    const { tasks, tick } = setup();
    tasks.create({ id: "t", title: "T", prompt: "p", repoId: "r1", status: "active" });
    const decision: DecisionRecord = {
      schema: DECISION_RECORD_SCHEMA,
      decision: "fm-decision",
      startedAt: 1_001,
      endedAt: 1_002,
      producer: {
        actor: "firstmate",
        role: "firstmate",
        model: { provider: "openai", id: "gpt-test" },
        accountId: "account-1",
        thinkingLevel: "low",
      },
      contract: { version: "2.7", promptSha: "prompt-sha", toolsSha: "tools-sha" },
      trigger: "wake",
      served: null,
      disposition: {
        outcome: "clean",
        error: null,
        inbox: "acked",
        asks: [],
        toolCalls: [],
        cards: [],
        tasks: ["t"],
        verdict: null,
        outcomeId: null,
        handoffInboxId: null,
      },
    };
    tick();
    tasks.turns.recordDecision(decision);
    tick();
    tasks.turns.recordSteer("t", {
      text: "keep the exact control evidence",
      actor: "captain",
      outcome: "mid-turn",
      via: "card",
      decision: decision.decision,
      cardId: "card-1",
      inboxId: 42,
    });
    tick();
    tasks.turns.recordInterrupt("t", {
      actor: "captain",
      mode: "interrupt",
      effect: "aborted-turn",
      via: "shell",
      decision: decision.decision,
    });
    const provenance = tasks
      .timeline("t")
      .filter((event) => ["decided", "steered", "interrupted"].includes(event.kind));

    for (let index = 0; index < TIMELINE_CAP - 4; index += 1) {
      tick();
      tasks.noteProgress("t", `step ${index}`);
    }
    tick();
    tasks.noteProgress("t", "one over");

    const timeline = tasks.timeline("t");
    expect(timeline).toHaveLength(TIMELINE_KEEP);
    expect(
      timeline.filter((event) => ["decided", "steered", "interrupted"].includes(event.kind)),
    ).toEqual(provenance);
    expect(timeline.find((event) => event.kind === "compacted")).toMatchObject({
      kind: "compacted",
      data: { kinds: { created: 1, progress: 101 } },
    });
  });
});

describe("the basis (primitives review P1)", () => {
  it("stores the basis as named, never its verdict, and derives the verdict at every read", () => {
    const { tasks, tick } = setup();
    const plan = tasks.create({ id: "plan", title: "Plan", prompt: "p", repoId: "r1" });
    const shape = {
      kind: "implement" as const,
      kind_source: "classifier:test",
      basis: plan.key,
      basis_verified: true,
    };
    const byKey = tasks.create({ id: "k", title: "By key", prompt: "p", repoId: "r1", shape });
    const byId = tasks.create({
      id: "i",
      title: "By id",
      prompt: "p",
      repoId: "r1",
      shape: { ...shape, basis: "plan" },
    });
    const ghost = tasks.create({
      id: "g",
      title: "On a ghost",
      prompt: "p",
      repoId: "r1",
      shape: { ...shape, basis: "NIA-404" },
    });
    tasks.placement.recordShape("k", shape, "low");
    for (const record of [byKey, byId, ghost]) {
      expect(tasks.get(record.id)?.shape).not.toHaveProperty("basis_verified");
    }
    const verdicts = () =>
      [byKey, byId, ghost].map((record) => tasks.graph.basisOf(tasks.get(record.id) ?? record));
    // The plan is running and has said nothing: nothing holds.
    expect(verdicts()).toEqual([
      { ref: plan.key, verified: false },
      { ref: "plan", verified: false },
      { ref: "NIA-404", verified: false },
    ]);
    tick();
    tasks.turns.recordReport("plan", { text: "Group the rows." });
    expect(verdicts().map((basis) => basis?.verified)).toEqual([true, true, false]);
    expect(tasks.graph.basisOf(plan)).toBeNull();
  });
});

describe("INF-125 validation persistence", () => {
  it("keeps proof and spent review pairs when the owner is reconstructed", () => {
    const { db, tasks } = setup();
    const head = "a".repeat(40);
    tasks.create({
      id: "proof-task",
      title: "Review the static explanation",
      prompt: "Review the static explanation",
      repoId: "r1",
    });
    tasks.delivery.recordLiveValidation(
      "proof-task",
      {
        kind: "plan",
        previousRevision: 0,
        reason: "The explanation has no runtime.",
        scenarios: [],
      },
      { head },
    );
    tasks.delivery.recordLiveValidation(
      "proof-task",
      {
        kind: "run",
        id: "explanation",
        head,
        scenarioRevision: 1,
        completion: "complete",
        verdict: "no-surface",
        reason: "Only explanatory prose changed.",
        observations: [],
        evidence: [],
      },
      { head },
    );
    seedDelivery(tasks, "proof-task", {
      reviewRounds: 2,
      reviewRoundPairs: [`${head}:1`],
      ciRounds: 2,
    });
    const restored = new TaskService({
      db,
      repos: { get: () => ({ delivery: "direct-pr" as const }) },
      now: () => 2000,
      strict: true,
    });
    expect(restored.get("proof-task")?.delivery).toEqual(tasks.get("proof-task")?.delivery);
    expect(restored.get("proof-task")?.delivery?.liveValidation?.runs[0]).toMatchObject({
      head,
      revision: 1,
      verdict: "no-surface",
    });
    expect(() =>
      restored.delivery.recordLiveValidation(
        "proof-task",
        {
          kind: "plan",
          previousRevision: 0,
          reason: "A stale plan must not replace the current one.",
          scenarios: [],
        },
        { head },
      ),
    ).toThrow("current scenario revision");
    expect(restored.get("proof-task")?.delivery?.liveValidation?.scenarioRevision).toBe(1);
  });
});

it("INF-203 F4: keeps transcript bytes out of delivery rewrites and validation timeline events", () => {
  const { tasks, db } = setup();
  seedTask(tasks, { id: "lean-proof", title: "Inspect the fixture", repoId: "r1", status: "idle" });
  const head = "a".repeat(40);
  const proof = noSurfaceProof(head);
  const text = JSON.stringify(tasks.get("lean-proof"));
  const digest = createHash("sha256").update(text).digest("hex");
  const evidence = {
    id: "record",
    description: "The task service's actual fixture record.",
    text,
    digest,
    bytes: Buffer.byteLength(text),
    file: `lean-proof-${digest}.json`,
  };
  tasks.delivery.recordLiveValidation(
    "lean-proof",
    {
      kind: "plan",
      previousRevision: 0,
      scenarios: [],
      reason: "The task fixture has no running product.",
    },
    { head },
  );
  const { revision: _revision, at: _at, deviceId: _device, ...run } = proof.runs[0]!;
  for (let index = 0; index < 12; index++) {
    tasks.delivery.recordLiveValidation(
      "lean-proof",
      { ...run, id: `run-${index}`, evidence: [evidence] },
      { head },
    );
    seedDelivery(tasks, "lean-proof", { ci: "green", ciAt: index });
  }
  const delivery = tasks.get("lean-proof")!.delivery!;
  expect(delivery.liveValidation?.runs).toHaveLength(12);
  expect(delivery.liveValidation?.runs.every((run) => run.evidence[0]?.text === undefined)).toBe(
    true,
  );
  expect(delivery.liveValidation?.runs[0]?.evidence[0]).toMatchObject({
    digest,
    bytes: evidence.bytes,
    file: evidence.file,
  });
  const events = tasks
    .timeline("lean-proof")
    .filter((event) => event.text === "Live validation: run");
  expect(events).toHaveLength(12);
  for (const event of events) {
    expect(event.data).not.toHaveProperty("liveValidation");
    expect(event.data).toMatchObject({
      validation: {
        kind: "run",
        evidence: [{ id: "record", digest, bytes: evidence.bytes, file: evidence.file }],
      },
    });
    expect(
      (event.data?.validation as { evidence: unknown[] } | undefined)?.evidence[0],
    ).not.toHaveProperty("text");
  }
  const reopened = new TaskService({ db });
  expect(reopened.get("lean-proof")?.delivery?.liveValidation).toEqual(delivery.liveValidation);
  console.log(
    "INF-203 lean validation record",
    JSON.stringify({
      runs: 12,
      deliveryBytes: Buffer.byteLength(JSON.stringify(delivery)),
      eventBytes: Buffer.byteLength(JSON.stringify(events)),
      transcriptBytes: evidence.bytes,
    }),
  );
});

/** Each statement `read` ran through `all`, with its arguments, as SQLite received it. */
function statementsRun(
  db: ReturnType<typeof freshDatabase>,
  read: () => void,
): { source: string; args: unknown[] }[] {
  const statement = Object.getPrototypeOf(db.prepare("SELECT 1")) as {
    all: (this: { source: string }, ...args: unknown[]) => unknown[];
  };
  const { all } = statement;
  const ran: { source: string; args: unknown[] }[] = [];
  statement.all = function (this: { source: string }, ...args: unknown[]) {
    ran.push({ source: this.source, args });
    return all.apply(this, args);
  };
  try {
    read();
  } finally {
    statement.all = all;
  }
  return ran;
}

// INF-940: macOS reported the app's main thread writing 549.76 GB in a day,
// nearly all of it SQLite's sorter writing an ORDER BY over every task row
// to a temporary file, once per read of a 3,411-task record.
describe("reading many tasks (INF-940)", () => {
  it("reads rows oldest first without SQLite sorting them", () => {
    const { db, tasks, tick } = setup();
    const plan = tasks.create({
      id: "plan",
      title: "Plan the meter export",
      prompt: "p",
      repoId: "r1",
    });
    tick();
    tasks.create({
      id: "piece",
      title: "Export the meter readings",
      prompt: "p",
      repoId: "r1",
      parentId: plan.id,
    });
    tasks.create({ id: "shipped", title: "Fix the meter rounding", prompt: "p", repoId: "r1" });
    // The same instant in another project: its first key orders it before nimbus-api's third.
    tasks.create({ id: "scratch", title: "Sketch the meter icon", prompt: "p", repoId: null });
    tick(1_000);
    tasks.close("shipped", { status: "done", reason: "merged", actor: "captain" });
    const closedAt = tasks.get("shipped")?.closedAt as number;
    // The computer's clock stepped back: written last, created first.
    tick(-1_500);
    tasks.create({
      id: "stepped",
      title: "Rename the meter tab",
      prompt: "p",
      repoId: "r1",
      parentId: plan.id,
      status: "active",
    });

    const reads: [string, () => TaskRecord[], string[]][] = [
      ["list", () => tasks.list(), ["stepped", "plan", "scratch", "piece", "shipped"]],
      ["listLive", () => tasks.listLive(), ["stepped", "plan", "scratch", "piece"]],
      [
        "listLiveOrClosedSince",
        () => tasks.listLiveOrClosedSince(closedAt),
        ["stepped", "plan", "scratch", "piece", "shipped"],
      ],
      [
        "getMany",
        () => tasks.getMany(["shipped", "stepped", "piece"]),
        ["stepped", "piece", "shipped"],
      ],
      ["children", () => tasks.graph.children(plan.id), ["stepped", "piece"]],
    ];
    for (const [name, read, oldestFirst] of reads) {
      let rows: TaskRecord[] = [];
      const ran = statementsRun(db, () => {
        rows = read();
      });
      expect(
        rows.map((row) => row.id),
        name,
      ).toEqual(oldestFirst);
      expect(ran, name).not.toHaveLength(0);
      for (const { source, args } of ran) {
        const steps = db.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...args) as {
          detail: string;
        }[];
        expect(
          steps.map((step) => step.detail).filter((detail) => detail.includes("TEMP B-TREE")),
          `${name}: ${source}`,
        ).toEqual([]);
      }
    }
  });
});

// Source: INF-1554 F4/F5, authorized repairs to INF-1540's approved B/C.
describe("review F4/F5 recovery report bounds", () => {
  const history =
    "The host fix is merged, but the installed app still lacks it; no release owner has started an alpha. ".repeat(
      8,
    );
  it("bounds durable recovery fields and counts, retaining the complete details through existing overflow", () => {
    initOverflowDir(scratchDir("infinitary-recovery-overflow-"));
    const { tasks, db } = setup();
    seedTask(tasks, { id: "recovery", title: "Recover the blocked branch", status: "idle" });
    const workWait = {
      owner: "INF-1539",
      end: history,
      observation: history,
      cheapestWay: history,
    };
    const recoveryWays = Array.from({ length: 100 }, (_, index) => ({
      action: `Inspect report ${index + 1} for a cheaper consent-free alternative.`,
      hold: "waits" as const,
      evidence: history,
      nextFact: "The named owner starts its takeover.",
    }));
    tasks.turns.recordReport("recovery", {
      text: "The work still waits on its host record.",
      declared: { workWait, recoveryWays },
    });
    const entry = tasks.reportEntries("recovery").at(-1);
    const kept = entry?.declared;
    for (const value of Object.values(kept?.workWait ?? {}))
      expect(value.length).toBeLessThanOrEqual(300);
    expect(kept?.recoveryWays?.length).toBeGreaterThan(0);
    expect(kept?.recoveryWays?.length).toBeLessThan(recoveryWays.length);
    expect(JSON.stringify(kept?.recoveryWays).length).toBeLessThanOrEqual(MESSAGE_EXCERPT_LIMIT);
    for (const way of kept?.recoveryWays ?? [])
      for (const value of [way.action, way.evidence, way.nextFact])
        expect(value.length).toBeLessThanOrEqual(300);
    const file = /full text: (.+)\]/.exec(entry?.text ?? "")?.[1];
    expect(file).toBeDefined();
    expect(JSON.parse(readFileSync(file ?? "", "utf8"))).toEqual({ workWait, recoveryWays });
    expect(tasks.get("recovery")?.outcome).toBe(entry?.text);
    console.info(
      "[F5] bounded report:",
      JSON.stringify({
        waysKept: kept?.recoveryWays?.length,
        originalWays: recoveryWays.length,
        contextCharacters: JSON.stringify(kept).length,
        fullDetailsRetained: true,
      }),
    );
    db.close();
  });

  it("keeps long wait identity stable and distinguishes a changed tail after clipping", () => {
    initOverflowDir(scratchDir("infinitary-wait-overflow-"));
    const { tasks, db } = setup();
    seedTask(tasks, { id: "recovery", title: "Check takeover ownership", status: "idle" });
    const workWait = {
      owner: "INF-1539",
      end: "The takeover starts",
      observation: `${history}The takeover is still planned.`,
      cheapestWay: "Start the takeover",
    };
    const record = (observation: string) => {
      tasks.turns.recordReport("recovery", {
        text: "Read the owner's next fact.",
        declared: { workWait: { ...workWait, observation } },
      });
      return tasks.reportEntries("recovery").at(-1)?.declared.workWait;
    };
    const first = record(workWait.observation);
    const same = record(workWait.observation);
    const changed = record(`${history}The takeover has started.`);
    expect(first).toBeDefined();
    expect(same).toEqual(first);
    expect(changed).toBeDefined();
    if (!first || !same || !changed) throw new Error("No kept wait");
    expect(waitStall(same, first)?.kind).toBe("repeated-wait");
    expect(waitStall(changed, same)).toBeUndefined();
    db.close();
  });

  // Source: INF-1554 F7, "Only ways that work around a hold; passing a hold or a stronger model stays your call".
  it("keeps a declared approach and reads an older way without one as captain-owned", () => {
    const { tasks, db } = setup();
    seedTask(tasks, { id: "recovery", title: "Take over the blocked branch", status: "idle" });
    const way = {
      action: "Start the takeover from the committed branch",
      hold: "waits" as const,
      evidence: "The running first mate serves branch_from",
      nextFact: "The takeover starts on the branch",
    };
    tasks.turns.recordReport("recovery", {
      text: "A takeover works around the host record.",
      declared: { recoveryWays: [{ ...way, approach: "workaround" }] },
    });
    expect(tasks.reportEntries("recovery").at(-1)?.declared.recoveryWays).toEqual([
      { ...way, approach: "workaround", basis: "record", needsConsent: false },
    ]);
    const event = tasks
      .timeline("recovery")
      .filter((entry) => entry.kind === "report")
      .at(-1);
    if (!event) throw new Error("No report");
    // A report kept before approaches existed declared none.
    expect(
      reportEntryOf({ ...event, data: { ...event.data, recoveryWays: [way] } }).declared
        .recoveryWays,
    ).toEqual([{ ...way, approach: "pass-hold", basis: "record", needsConsent: true }]);
    db.close();
  });

  // Source: R6 of INF-1644: a report saved before INF-1688 retired its hold stays readable.
  it("reads a saved recovery way whose hold this build retired as captain-owned", () => {
    const { tasks, db } = setup();
    seedTask(tasks, { id: "recovery", title: "Repair the failing checks", status: "idle" });
    tasks.turns.recordReport("recovery", { text: "The checks still fail on the same version." });
    const event = tasks
      .timeline("recovery")
      .filter((entry) => entry.kind === "report")
      .at(-1);
    if (!event) throw new Error("No report");
    const way = {
      action: "Push one more repair",
      approach: "workaround",
      hold: "repairs",
      evidence: "The checks failed on the same version",
      nextFact: "Read the next check result",
    };
    expect(
      reportEntryOf({ ...event, data: { ...event.data, recoveryWays: [way] } }).declared
        .recoveryWays,
    ).toEqual([{ ...way, basis: undefined, needsConsent: true }]);
    db.close();
  });

  it("omits empty findings at the durable writer and when reading an older report", () => {
    const { tasks, db } = setup();
    seedTask(tasks, { id: "recovery", title: "Wait for the check owner", status: "idle" });
    tasks.turns.recordReport("recovery", {
      text: "The checks remain watched.",
      declared: { recoveryWays: [] },
    });
    const event = tasks
      .timeline("recovery")
      .filter((entry) => entry.kind === "report")
      .at(-1);
    expect(event?.data).not.toHaveProperty("recoveryWays");
    if (!event) throw new Error("No report");
    expect(
      reportEntryOf({ ...event, data: { ...event.data, recoveryWays: [] } }).declared,
    ).not.toHaveProperty("recoveryWays");
    db.close();
  });
});
