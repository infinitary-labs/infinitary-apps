import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  openDatabase,
  openInMemoryDatabase,
  TASK_EXECUTION_VERSION,
  TASK_POLICIES_VERSION,
} from "../storage/db";
import { seedTask } from "./seedTask";
import { exportTaskRecords, parseTaskExport } from "./taskExport";
import { TaskService } from "./taskService";

// INF-1296 piece 3, the captain's approved plan B: scheduling, policy and
// execution state as owned records, and "good e2e test coverage to ensure
// exsiting users don't get regressed during this migration".

function setup(db = openInMemoryDatabase()) {
  let now = 10_000;
  const tasks = new TaskService({ db, strict: true, now: () => (now += 1_000) });
  return { db, tasks };
}

const PLACEMENT = {
  snapshot: { at: 5_000, computerId: "studio", computerName: "Studio Mac" },
  reservation: "pending",
};

/**
 * A profile as the release before these migrations saved it: a resume
 * token its conversation records and one from before conversations were
 * recorded, the idle clock and recovery rung, a placement still waiting on
 * its computer, the current turn's declarations inside the delivery, and
 * each policy input inside the shape.
 */
function olderProfile() {
  const dir = scratchDir("running-work-");
  // The older conversation file sits in its crewmate's folder, as it did.
  const legacyFolder = join(dir, "crewmates", "legacy", "sessions");
  mkdirSync(legacyFolder, { recursive: true });
  const legacyFile = join(legacyFolder, "old.jsonl");
  writeFileSync(legacyFile, "");
  const at = openDatabase(dir, TASK_EXECUTION_VERSION - 1);
  const { tasks } = setup(at);
  seedTask(tasks, { id: "bound", title: "Draw the chart", status: "idle" });
  seedTask(tasks, { id: "legacy", title: "Fix the axis", status: "idle" });
  seedTask(tasks, { id: "placed", title: "Run on the studio", status: "queued" });
  seedTask(tasks, {
    id: "asked",
    title: "Ship the legend",
    status: "idle",
    shape: {
      kind: "implement",
      delivery_ask: "local-only",
      autonomy_ask: false,
      rigor_ask: "reviewed",
      policies: { delivery: null, autonomy: true, revision: 2 },
    },
  });
  seedTask(tasks, {
    id: "odd",
    title: "A shape from a hand edit",
    status: "idle",
    shape: { kind: "implement", autonomy_ask: "yes" as unknown as boolean },
  });
  const boundFile = "/fleet/crewmates/bound/sessions/a1.jsonl";
  tasks.setSessionFile("bound", boundFile, {
    file: boundFile,
    computer: "this-mac",
    device_id: null,
    provider: "fm-mock",
    model: "mock-1",
    account_id: "acct-1",
    began: "start",
  });
  const raw = at.prepare(
    `UPDATE tasks SET session_file = COALESCE(?, session_file), account_id = ?, idle_since = ?,
       recovery_rung = ?, recovery_count = ?, recovery_at = ?, device_id = ?, placement_json = ?,
       start_notice = ?, delivery_json = ? WHERE id = ?`,
  );
  raw.run(null, "acct-1", 7_000, 2, 3, 8_000, null, null, null, null, "bound");
  raw.run(
    legacyFile,
    null,
    6_000,
    0,
    0,
    null,
    null,
    null,
    "Could not start: the project folder is missing.",
    JSON.stringify({
      pr: 41,
      captainWait: { at: 6_500, reason: "Pick the colors" },
      checkBack: { at: 6_500, until: 66_500, waitingFor: "the checks" },
    }),
    "legacy",
  );
  raw.run(null, null, null, 0, 0, null, "studio", JSON.stringify(PLACEMENT), null, null, "placed");
  raw.run(
    null,
    null,
    null,
    0,
    0,
    null,
    null,
    null,
    null,
    JSON.stringify({
      closedPolicies: {
        delivery: { value: "direct-pr", source: "project" },
        autonomy: { value: false, source: "task" },
        rigor: { value: "standard", source: "project", requested: "standard" },
        revision: 1,
      },
      needsFirstmate: { at: 9_000, request: "merge it" },
    }),
    "asked",
  );
  at.close();
  return { dir, boundFile, legacyFile, legacyFolder };
}

/** What every reader of a task reads, in the record's own words. */
function readEverything(tasks: TaskService, legacyFolder: string) {
  return Object.fromEntries(
    tasks.list().map((record) => [
      record.id,
      {
        sessionFile: record.sessionFile,
        deviceId: record.deviceId,
        accountId: record.accountId,
        placement: record.placement,
        idleSince: record.idleSince,
        recoveryRung: record.recoveryRung,
        recoveryCount: record.recoveryCount,
        recoveryAt: record.recoveryAt,
        startNotice: record.startNotice,
        delivery: record.delivery,
        shape: record.shape,
        policies: tasks.policiesOf(record),
        current:
          tasks
            .sessions(record.id, { dir: legacyFolder, computer: "this-mac" })
            .find((session) => session.current)?.conversation ?? null,
      },
    ]),
  );
}

describe("the migration of an older release's running work and policy inputs", () => {
  it("moves each value exactly as saved, and every reader reads the same as before", () => {
    const { dir, legacyFile, legacyFolder } = olderProfile();
    const before = openDatabase(dir, TASK_EXECUTION_VERSION - 1);
    const readBefore = readEverything(setup(before).tasks, legacyFolder);
    const placementsBefore = before.prepare("SELECT * FROM v_placements_v1").all();
    before.close();
    expect(readBefore.bound?.current).toBe("a1");
    expect(readBefore.legacy?.current).toBe("old");

    const upgraded = openDatabase(dir);
    const { tasks } = setup(upgraded);
    expect(readEverything(tasks, legacyFolder)).toEqual(readBefore);
    expect(upgraded.prepare("SELECT * FROM v_placements_v1").all()).toEqual(placementsBefore);
    expect(tasks.pendingPlacements().map((record) => record.id)).toEqual(["placed"]);

    // The binding names the conversation it resumes; a token none records keeps none.
    expect(
      upgraded
        .prepare(
          "SELECT task_id, session_file, conversation, turn_json FROM task_execution ORDER BY task_id",
        )
        .all(),
    ).toEqual([
      {
        task_id: "asked",
        session_file: null,
        conversation: null,
        turn_json: JSON.stringify({ needsFirstmate: { at: 9_000, request: "merge it" } }),
      },
      {
        task_id: "bound",
        session_file: "/fleet/crewmates/bound/sessions/a1.jsonl",
        conversation: "a1",
        turn_json: null,
      },
      {
        task_id: "legacy",
        session_file: legacyFile,
        conversation: null,
        turn_json: JSON.stringify({
          captainWait: { at: 6_500, reason: "Pick the colors" },
          checkBack: { at: 6_500, until: 66_500, waitingFor: "the checks" },
        }),
      },
      { task_id: "placed", session_file: null, conversation: null, turn_json: null },
    ]);
    expect(upgraded.prepare("SELECT * FROM task_policies").all()).toEqual([
      {
        task_id: "asked",
        delivery_ask: "local-only",
        autonomy_ask: 0,
        rigor_ask: "reviewed",
        edits_json: JSON.stringify({ delivery: null, autonomy: true, revision: 2 }),
      },
    ]);
    // The task row no longer holds them; a value of another type stays in the shape.
    const rows = upgraded
      .prepare("SELECT id, delivery_json, shape_json FROM task_records ORDER BY id")
      .all() as Record<string, string | null>[];
    for (const row of rows) {
      for (const field of ["session_file", "idle_since", "placement_json"])
        expect(
          (upgraded.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
            (column) => column.name,
          ),
        ).not.toContain(field);
      expect(row.delivery_json ?? "").not.toMatch(/captainWait|checkBack|needsFirstmate/);
    }
    expect(JSON.parse(rows.find((row) => row.id === "asked")!.delivery_json!)).toHaveProperty(
      "closedPolicies",
    );
    expect(JSON.parse(rows.find((row) => row.id === "asked")!.shape_json!)).toEqual({
      kind: "implement",
      // INF-1605: keep the source clock that startup recorded when it returned this fixture to the queue.
      start_wait_since: readBefore.asked?.shape?.start_wait_since,
    });
    expect(JSON.parse(rows.find((row) => row.id === "odd")!.shape_json!)).toMatchObject({
      autonomy_ask: "yes",
    });
    upgraded.close();

    // A restart reads the same, and migrates nothing twice.
    const again = openDatabase(dir);
    expect(readEverything(setup(again).tasks, legacyFolder)).toEqual(readBefore);
    expect(again.prepare("SELECT COUNT(*) AS n FROM task_execution").get()).toEqual({ n: 4 });
    again.close();
  });

  it("keeps a write after the upgrade where every reader reads it", () => {
    const { dir } = olderProfile();
    const upgraded = openDatabase(dir);
    const { tasks } = setup(upgraded);
    // A new turn clears the declarations and the idle clock, as before.
    tasks.recordReport("legacy", { text: "Done.", declared: { finished: true } });
    const legacy = tasks.get("legacy")!;
    expect(legacy.delivery).toMatchObject({ pr: 41, finishedAt: expect.any(Number) });
    expect(legacy.delivery).not.toHaveProperty("captainWait");
    // A new resume token that its conversation records is now named by it.
    const next = "/fleet/crewmates/legacy/sessions/b2.jsonl";
    tasks.setSessionFile("legacy", next, {
      file: next,
      computer: "this-mac",
      device_id: null,
      provider: "fm-mock",
      model: "mock-1",
      account_id: null,
      began: "resume",
    });
    expect(tasks.sessions("legacy").find((session) => session.current)?.conversation).toBe("b2");
    // A policy edit lands in its own row and reads back on the shape.
    tasks.recordShape("asked", { kind: "fix", kind_source: "classifier:test" }, "medium");
    expect(tasks.get("asked")?.shape).toMatchObject({
      kind: "fix",
      delivery_ask: "local-only",
      autonomy_ask: false,
      policies: { delivery: null, autonomy: true, revision: 2 },
    });
    upgraded.close();
    const again = openDatabase(dir);
    const reread = setup(again).tasks;
    expect(reread.get("legacy")?.sessionFile).toBe(next);
    expect(reread.get("legacy")?.delivery).not.toHaveProperty("captainWait");
    expect(reread.get("asked")?.shape).toMatchObject({ kind: "fix", rigor_ask: "reviewed" });
    again.close();
  });

  it("moves policy inputs on their own when running work already moved", () => {
    const dir = scratchDir("running-policies-");
    const at = openDatabase(dir, TASK_POLICIES_VERSION - 1);
    seedTask(setup(at).tasks, { id: "only", title: "Only an ask", status: "queued" });
    at.prepare("UPDATE tasks SET shape_json = ? WHERE id = 'only'").run(
      JSON.stringify({ kind: "implement", autonomy_ask: true }),
    );
    at.close();
    const upgraded = openDatabase(dir);
    expect(setup(upgraded).tasks.get("only")?.shape).toEqual({
      kind: "implement",
      autonomy_ask: true,
    });
    expect(upgraded.prepare("SELECT autonomy_ask FROM task_policies").all()).toEqual([
      { autonomy_ask: 1 },
    ]);
    upgraded.close();
  });
});

describe("a record export of running work", () => {
  it("carries the binding's conversation, and an older export derives it as the migration does", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "bound", title: "Draw the chart", status: "idle" });
    const file = "/fleet/crewmates/bound/sessions/a1.jsonl";
    tasks.setSessionFile("bound", file, {
      file,
      computer: "this-mac",
      device_id: null,
      provider: "fm-mock",
      model: "mock-1",
      account_id: null,
      began: "start",
    });
    seedTask(tasks, { id: "legacy", title: "Fix the axis", status: "idle" });
    tasks.setSessionFile("legacy", "/fleet/crewmates/legacy/sessions/old.jsonl");
    const lines = exportTaskRecords(tasks, 1);
    const taskLines = lines.map((line) => JSON.parse(line)).filter((line) => line.kind === "task");
    expect(taskLines.map((line) => [line.id, line.conversation])).toEqual([
      ["bound", "a1"],
      ["legacy", null],
    ]);
    const restore = (bundle: string[]) => {
      const { tasks: fresh } = setup();
      fresh.importRecords(parseTaskExport(bundle));
      return fresh;
    };
    const restored = restore(lines);
    expect(restored.recordedConversation("bound")).toBe("a1");
    expect(restored.recordedConversation("legacy")).toBeNull();
    expect(restored.sessions("bound").find((s) => s.current)?.conversation).toBe("a1");
    expect(exportTaskRecords(restored, 1)).toEqual(lines);
    // An export written before this field has no conversation on its task lines.
    const older = lines.map((line) => {
      const parsed = JSON.parse(line);
      if (parsed.kind !== "task") return line;
      const { conversation: _conversation, ...rest } = parsed;
      return JSON.stringify(rest);
    });
    const fromOlder = restore(older);
    expect(fromOlder.recordedConversation("bound")).toBe("a1");
    expect(fromOlder.recordedConversation("legacy")).toBeNull();
  });
});
