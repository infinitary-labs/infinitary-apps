import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { DECISION_RECORD_SCHEMA, type DecisionRecord } from "../../shared/provenance";
import { seedTask } from "./seedTask";
import { TaskService, TIMELINE_CAP, TIMELINE_KEEP } from "./taskService";

function setup() {
  const db = freshDatabase();
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', NULL, 'direct-pr', 0)",
  ).run("r1", "/fleet/nimbus-api", "nimbus-api", 1);
  let now = 1_000;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  // A repo registered before this service existed still gets its project.
  tasks.projects.ensureForRepo({ id: "r1", name: "nimbus-api" });
  return { db, tasks, tick: (ms = 1) => (now += ms) };
}

const intent = { goal: "Ship it", userWords: "please ship it" };

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
        tasks.replacementOf(old.id) ?? "missing",
        ...tasks.blockers(waiter.id).map((row) => row.key),
      ]),
    );
    const fresh = tasks.startAgain(old.id, {
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
      tasks.startAgain(old.id, { id: "duplicate", shape: { kind: "unclear" }, actor: "captain" }),
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

  it("refuses changing a live, closed or previously started task's spec", () => {
    const { tasks } = setup();
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
    seedTask(tasks, { id: "started", title: "Started", status: "running" });
    tasks.requeue("started", { kind: "captain" }, "failed start");
    expect(() => tasks.updateFields("started", { basis: plan.key }, "firstmate")).toThrow(
      "has not started",
    );
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
    tasks.requeue("requeued", { kind: "captain" }, "failed start");
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
    expect(tasks.discoveredOrigins(filing.id).map((row) => row.id)).toEqual([origin.id]);
  });
});

describe("close invariants (interaction P0, WI-7)", () => {
  function dispatched(tasks: TaskService, id: string) {
    tasks.create({ id, title: `Task ${id}`, prompt: "p", repoId: "r1", status: "active" });
    tasks.dispatch(id, {
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
    tasks.fileQuestion({ id: "question", title: "Why", outcome: "Because." });
    tick();
    tasks.fileOperation({
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
    tasks.dispatch("t", {
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
    tasks.setActivity("t", "running");
    tasks.recordReport("t", { text: "Fixed the flake. Two files changed." });
    tasks.setActivity("t", "idle");
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
      delivery: { landedMode: "fast-forward", landedAt: 1_004 },
    });
    tasks.markWorkspaceRemoved("t");
    const closed = tasks.get("t");
    expect(closed).toMatchObject({
      status: "done",
      closedReason: "landed",
      workspaceState: "removed",
      delivery: { mode: "direct-pr", landedMode: "fast-forward", landedAt: 1_004 },
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
    expect(tasks.listReady().map((r) => r.id)).toEqual(["t"]);
    expect(tasks.claimForDispatch("t")).toBe(true);
    expect(tasks.get("t")).toMatchObject({
      status: "active",
      activity: "starting",
      gate: null,
      startedAt: 1_000,
    });
    expect(tasks.listReady()).toEqual([]);
    expect(tasks.claimForDispatch("t")).toBe(false);
    expect(tasks.timeline("t").at(-1)).toMatchObject({ kind: "status", text: "starting" });
  });

  it("boot returns a claimed-but-unstarted row to the ready query", () => {
    const { db, tasks } = setup();
    tasks.create({ id: "t", title: "T", prompt: "p", repoId: null });
    expect(tasks.claimForDispatch("t")).toBe(true);
    const again = new TaskService({ db, now: () => 2_000, strict: true });
    expect(again.get("t")).toMatchObject({ status: "open", activity: null, gate: null });
    expect(again.listReady().map((r) => r.id)).toEqual(["t"]);
    expect(again.timeline("t").at(-1)).toMatchObject({
      kind: "status",
      text: "returned to the queue - the start did not finish",
    });
  });

  it("requeues a failed dispatch behind a gate and reopens a closed park row", () => {
    const { tasks } = setup();
    tasks.create({
      id: "q",
      title: "Q",
      prompt: "p",
      repoId: null,
      gate: { kind: "at-time", until: 5 },
    });
    tasks.dispatch("q", {
      workspace: { repoDir: "/r", worktreeDir: "/wt/q", branch: "fm/task-q" },
      accountId: null,
      assignee: "crewmate 2",
    });
    tasks.requeue(
      "q",
      { kind: "captain", ref: "dispatch-failed", reason: "boom" },
      "could not start: boom",
    );
    expect(tasks.get("q")).toMatchObject({
      status: "open",
      activity: null,
      worktreeDir: "",
      workspaceState: "none",
      assignee: null,
      gate: { kind: "captain", ref: "dispatch-failed", reason: "boom" },
    });
    expect(tasks.listOpen().map((r) => r.id)).toEqual(["q"]);
  });

  it("records delivery facts against the repo posture and events for CI reads", () => {
    const { tasks } = setup();
    tasks.create({ id: "pr", title: "PR", prompt: "p", repoId: "r1", status: "active" });
    tasks.recordDelivery(
      "pr",
      { prUrl: "https://x/1", prNumber: 1 },
      { kind: "pr_opened", text: "PR #1", feed: true },
    );
    tasks.recordDelivery("pr", { ci: "green", ciAt: 1_000 }, { kind: "ci", text: "CI green" });
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
    tasks.recordDelivery("local", { landedMode: "fast-forward", landedAt: 1 });
    expect(tasks.get("local")?.delivery).toMatchObject({
      mode: "local-only",
      landedMode: "fast-forward",
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
    const filed = tasks.fileOperation({
      id: "run",
      title: "window wash 48% → 50%",
      outcome: "window wash 48% → 50%",
      tool: "app_change",
      actor: "captain",
    });
    tick(500);
    tasks.reviseOperation("run", {
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
    expect(() => tasks.withdrawOperation("work")).toThrow("is not an operation");
    expect(() => tasks.reviseOperation("work", { title: "x", outcome: "x" })).toThrow(
      "is not an operation",
    );
    tasks.withdrawOperation("run");
    expect(tasks.get("run")).toBeUndefined();
    expect(tasks.timeline("run")).toEqual([]);
    expect(tasks.get("work")?.title).toBe("Work");
  });

  it("hard-deletes only a spawn that never ran, and the D-13 purge keeps projects", () => {
    const { db, tasks } = setup();
    tasks.create({ id: "dead", title: "never ran", prompt: "p", repoId: "r1", status: "active" });
    tasks.discardFailedSpawn("dead");
    expect(tasks.get("dead")).toBeUndefined();
    expect(tasks.timeline("dead")).toEqual([]);
    tasks.create({ id: "x", title: "X", prompt: "p", repoId: "r1" });
    tasks.create({ id: "y", title: "Y", prompt: "p", repoId: null, blockedBy: ["x"] });
    expect(tasks.purge()).toBe(2);
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
      "INSERT INTO tasks (id, kind, title, prompt, repo_id, repo_dir, worktree_dir, branch, status, created_at) VALUES ('raw', 'work', 'raw', '', NULL, '', '', '', 'open', 1)",
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
    // Exactly at the cap: nothing folds.
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
      tasks.recordInterrupt("t", {
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
    tasks.recordDecision(decision);
    tick();
    tasks.recordSteer("t", {
      text: "keep the exact control evidence",
      actor: "captain",
      outcome: "mid-turn",
      via: "card",
      decision: decision.decision,
      cardId: "card-1",
      inboxId: 42,
    });
    tick();
    tasks.recordInterrupt("t", {
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
    // A later shape write carries no stamp either.
    tasks.recordShape("k", shape, "low");
    for (const record of [byKey, byId, ghost]) {
      expect(tasks.get(record.id)?.shape).not.toHaveProperty("basis_verified");
    }
    const verdicts = () =>
      [byKey, byId, ghost].map((record) => tasks.basisOf(tasks.get(record.id) ?? record));
    // The plan is running and has said nothing: nothing holds.
    expect(verdicts()).toEqual([
      { ref: plan.key, verified: false },
      { ref: "plan", verified: false },
      { ref: "NIA-404", verified: false },
    ]);
    tick();
    tasks.recordReport("plan", { text: "Group the rows." });
    expect(verdicts().map((basis) => basis?.verified)).toEqual([true, true, false]);
    expect(tasks.basisOf(plan)).toBeNull();
  });
});
