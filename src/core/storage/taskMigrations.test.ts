import { PLACEMENT_DEMANDS, placementSnapshotSchema } from "@shared/placement";
import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS,
  appliedVersions,
  columnNames,
  MIGRATION_71_TABLE,
  REVERSE_MIGRATION_63,
  REVERSE_MIGRATION_71,
  REVERSE_MIGRATION_76,
  REVERSE_RUNNING_WORK,
  REVERSE_TASK_REFERENCES,
  TASK_REFERENCES_TABLE,
  tableNames,
  tmpUserData,
} from "../../../tests/helpers/migrations";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openDatabase } from "./db";
import { dropViews } from "./views";

describe("migration 46 (the two graph gaps)", () => {
  it("drops the stored basis verdict and review pointer, and the record derives both back", () => {
    const dir = tmpUserData();
    const at45 = openDatabase(dir, 45);
    // The one writer writes today's schema: a part's filing names its
    // parent in migration 71's table, lent here and taken back below.
    at45.exec(MIGRATION_71_TABLE + TASK_REFERENCES_TABLE);
    const before = new TaskService({ db: at45, strict: true });
    seedTask(before, { id: "plan", title: "Plan", status: "completed", outcome: "Do B." });
    seedTask(before, { id: "wip", title: "Still going", status: "running" });
    seedTask(before, {
      id: "build",
      title: "Build B",
      status: "idle",
      shape: { kind: "implement", kind_source: "classifier:test", basis: "plan" },
    });
    seedTask(before, {
      id: "guess",
      title: "Build on a guess",
      status: "queued",
      shape: { kind: "implement", kind_source: "classifier:test", basis: "wip" },
    });
    seedTask(before, {
      id: "review",
      title: "Review: Build B",
      status: "idle",
      parentId: "build",
      shape: { kind: "review", kind_source: "host:review", basis: "build" },
    });
    seedDelivery(before, "build", { reviewVerdict: "findings", reviewedAt: Date.now() });
    at45.exec(REVERSE_TASK_REFERENCES);
    // The stamps as a database before this migration stored them: a verdict
    // gone stale (the guess still says verified) and the cached join.
    at45.exec(`
      UPDATE tasks SET shape_json = json_set(shape_json, '$.basis_verified', json('true'))
        WHERE id IN ('build', 'guess', 'review');
      UPDATE tasks SET delivery_json = json_set(delivery_json, '$.reviewTaskId', 'review')
        WHERE id = 'build';
    `);
    at45.exec(REVERSE_MIGRATION_71);
    at45.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const stamps = upgraded
      .prepare(
        "SELECT COUNT(*) AS n FROM task_records WHERE json_type(shape_json, '$.basis_verified') IS NOT NULL OR json_type(delivery_json, '$.reviewTaskId') IS NOT NULL",
      )
      .get();
    expect(stamps).toEqual({ n: 0 });
    const tasks = new TaskService({ db: upgraded, strict: true });
    const build = tasks.get("build");
    const guess = tasks.get("guess");
    expect(build?.shape).toEqual({
      kind: "implement",
      kind_source: "classifier:test",
      basis: "plan",
      // INF-1605: startup returned this unstarted fixture to the queue at its recorded update time.
      start_wait_since: { policy: build?.updatedAt },
    });
    expect(build?.delivery).toMatchObject({ reviewVerdict: "findings" });
    expect(build && tasks.graph.basisOf(build)).toEqual({ ref: "plan", verified: true });
    expect(guess && tasks.graph.basisOf(guess)).toEqual({ ref: "wip", verified: false });
    expect(build && tasks.graph.verdictReviewOf(build)?.id).toBe("review");
    upgraded.close();
  });
});

describe("migration 47 (the gate becomes a witness, the primitives review P2)", () => {
  it("keeps legacy count history without creating retired captain gates (INF-1177)", () => {
    const dir = tmpUserData();
    const at46 = openDatabase(dir, 46);
    const tasks = new TaskService({ db: at46 });
    const active = (id: string) =>
      seedTask(tasks, { id, title: id, status: "completed", worktreeDir: `/wt/${id}` });
    active("ci-capped");
    seedDelivery(tasks, "ci-capped", { ciRounds: 3, ciRedHead: "abc1234", ciCapAt: 100 });
    active("review-capped");
    seedDelivery(tasks, "review-capped", {
      headSha: "def5678",
      reviewRounds: 3,
      reviewRoundSha: "def5678",
      reviewCapAt: 200,
    });
    // Answered since the cap: the steer that reopens the rounds is all it waits on.
    active("answered");
    seedDelivery(tasks, "answered", { ciRounds: 3, ciCapAt: 100, capAnsweredAt: 150 });
    active("gated");
    seedDelivery(tasks, "gated", { ciRounds: 3, ciCapAt: 100 });
    tasks.placement.setGate("gated", { kind: "at-time", until: 999 });
    active("uncapped");
    seedDelivery(tasks, "uncapped", { ciRounds: 1, ciRedHead: "abc1234" });
    at46.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const read = new TaskService({ db: upgraded });
    expect(read.get("ci-capped")?.gate).toBeNull();
    expect(read.get("review-capped")?.gate).toBeNull();
    expect(read.get("ci-capped")?.delivery?.ciRounds).toBe(3);
    expect(read.get("answered")?.gate).toBeNull();
    expect(read.get("gated")?.gate).toEqual({ kind: "at-time", until: 999 });
    expect(read.get("uncapped")?.gate).toBeNull();
    expect(
      upgraded
        .prepare("SELECT task_id, gate_ref, gate_reason FROM cap_gate_backfill ORDER BY task_id")
        .all(),
    ).toEqual([]);

    upgraded.exec(
      "UPDATE tasks SET gate_kind = NULL, gate_ref = NULL, gate_until = NULL, gate_reason = NULL WHERE id IN (SELECT task_id FROM cap_gate_backfill); DROP TABLE cap_gate_backfill;",
    );
    const reversed = new TaskService({ db: upgraded });
    for (const id of ["ci-capped", "review-capped", "answered", "uncapped"]) {
      expect(reversed.get(id)?.gate, id).toBeNull();
    }
    expect(reversed.get("gated")?.gate).toEqual({ kind: "at-time", until: 999 });
    upgraded.close();
  });
});

describe("migration 63 (where a task's crewmate runs, multi-machine piece 8)", () => {
  it("adds the nullable column, keeps every task on this Mac, records a computer, and reverses", () => {
    const dir = tmpUserData();
    const at62 = openDatabase(dir, 62);
    const columnsAt62 = columnNames(at62, "tasks");
    expect(columnsAt62).not.toContain("device_id");
    const before = new TaskService({ db: at62, now: () => 1 });
    seedTask(before, { id: "here", title: "Runs here", status: "running", worktreeDir: "/w/here" });
    at62.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const tasks = new TaskService({ db: upgraded, now: () => 2 });
    // A row written before the column runs on this Mac, and a restart still
    // interrupts its turn; a placed row's turn is that computer's to say.
    expect(tasks.get("here")).toMatchObject({ deviceId: null, activity: "interrupted" });
    seedTask(tasks, {
      id: "there",
      title: "Runs there",
      status: "running",
      deviceId: "mini",
      sessionFile: "/Users/builder/work/tasks/there/sessions/s.jsonl",
    });
    upgraded.close();

    const reopened = openDatabase(dir);
    expect(new TaskService({ db: reopened, now: () => 3 }).get("there")).toMatchObject({
      deviceId: "mini",
      activity: "running",
    });

    dropViews(reopened);
    reopened.exec(`${REVERSE_RUNNING_WORK} ${REVERSE_MIGRATION_76} ${REVERSE_MIGRATION_63}`);
    expect(columnNames(reopened, "tasks")).toEqual(columnsAt62);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 71 (whom an event concerns, FI3-1189's rule 1)", () => {
  it("adds the table to a database with tasks, keeps every row, and drops back to v70", () => {
    const dir = tmpUserData();
    const at70 = openDatabase(dir, 70);
    at70.exec(MIGRATION_71_TABLE);
    const before = new TaskService({ db: at70, strict: true });
    seedTask(before, { id: "kept", title: "Kept", status: "idle" });
    at70.exec(REVERSE_MIGRATION_71);
    const events = at70.prepare("SELECT COUNT(*) AS n FROM task_events").get();
    at70.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(tableNames(upgraded)).toContain("task_event_concerns");
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM task_events").get()).toEqual(events);
    const tasks = new TaskService({ db: upgraded, strict: true });
    tasks.create({ id: "part", title: "Part", prompt: "p", repoId: null, parentId: "kept" });
    expect(tasks.concerning("kept").map((event) => [event.taskId, event.relation])).toEqual([
      ["part", "part"],
    ]);
    upgraded.close();

    const reopened = openDatabase(dir);
    dropViews(reopened);
    reopened.exec(REVERSE_MIGRATION_71);
    expect(tableNames(reopened)).not.toContain("task_event_concerns");
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });
    reopened.close();
  });
});

describe("migration 85 (a recorded wait holds the start)", () => {
  it("marks every existing blocks edge as holding the close, and leaves other edges unmarked", () => {
    const dir = tmpUserData();
    const old = openDatabase(dir, 84);
    expect(columnNames(old, "task_links")).not.toContain("holds_merge");
    const insert = old.prepare(
      "INSERT INTO task_links (from_id, to_id, type, actor, created_at) VALUES (?, ?, ?, 'firstmate', 1)",
    );
    insert.run("waiter", "ship", "blocks");
    insert.run("note", "ship", "related");
    old.close();
    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(
      upgraded.prepare("SELECT type, holds_merge FROM task_links ORDER BY type").all(),
    ).toEqual([
      { type: "blocks", holds_merge: 1 },
      { type: "related", holds_merge: 0 },
    ]);
    upgraded.close();
  });
});

// INF-416 L: removing published flags must preserve a saved placement's words.
it("migration 86 retains connecting in saved placement verdicts without the old flag", () => {
  const dir = tmpUserData();
  const old = openDatabase(dir, 85);
  const tasks = new TaskService({ db: old });
  seedTask(tasks, {
    id: "connecting-placement",
    title: "Fix the footer.",
    prompt: "Fix the footer.",
    status: "queued",
  });
  const candidate = {
    physicalComputerId: null,
    missingTools: [],
    reading: { status: "unknown", reason: "out-of-reach" },
    factsAgeMs: null,
    capacity: null,
    reserved: { cpu: 0, memoryBytes: 0 },
    remaining: null,
    model: null,
    preferenceRank: null,
  };
  const snapshot = placementSnapshotSchema.parse({
    version: 1,
    at: 1_000,
    computerId: "chosen",
    computerName: "This computer",
    physicalComputerId: "a".repeat(64),
    orderId: "prepare:footer",
    demand: PLACEMENT_DEMANDS.standard,
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    acceptedFallback: false,
    requirements: { tools: ["git"], systems: ["macos"], profile: "standard" },
    candidateCount: 2,
    candidates: [
      { ...candidate, computerId: "mini", name: "Mac mini", rejections: ["out-of-reach"] },
      { ...candidate, computerId: "chosen", name: "This computer", rejections: [] },
    ],
  });
  // The legacy snapshot has the same whole shape, with its earlier connecting flag.
  const placement = {
    reservation: "pending",
    snapshot: {
      ...snapshot,
      candidates: [{ ...snapshot.candidates[0], connecting: true }, snapshot.candidates[1]],
    },
  };

  old
    .prepare("UPDATE tasks SET placement_json = ? WHERE id = ?")
    .run(JSON.stringify(placement), "connecting-placement");
  old.close();
  const upgraded = openDatabase(dir);
  const read = () =>
    JSON.parse(
      (
        upgraded
          // Saved on the task's execution row since INF-1296 piece 3.
          .prepare("SELECT placement_json FROM task_execution WHERE task_id = ?")
          .get("connecting-placement") as { placement_json: string }
      ).placement_json,
    );
  expect(read()).toEqual({
    ...placement,
    snapshot: {
      ...placement.snapshot,
      candidates: [
        { ...snapshot.candidates[0], reach: "connecting" },
        placement.snapshot.candidates[1],
      ],
    },
  });
  upgraded.close();
  const reopened = openDatabase(dir);
  expect(
    new TaskService({ db: reopened }).get("connecting-placement")?.placement?.snapshot.candidates[0]
      ?.reach,
  ).toBe("connecting");
  reopened.close();
});
