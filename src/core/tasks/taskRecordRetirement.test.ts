import { readFileSync } from "node:fs";
import { workShapeSchema } from "@shared/routingPolicy";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { openDatabase, TASK_RECORD_RETIREMENT_VERSION } from "../storage/db";
import {
  CONTRACT_FIELDS,
  PLACEMENT_FIELDS,
  PROGRAM_FIELDS,
  ROUTING_FIELDS,
  WORKSPACE_FIELDS,
} from "../storage/taskOwnedShapeStore";
import { POLICY_SHAPE_FIELDS } from "../storage/taskPolicyFields";
import { RETIRED_TASK_COLUMNS } from "../storage/taskRecordProjection";
import { REFERENCE_SHAPE_FIELDS } from "../storage/taskReferenceFields";
import { seedTask } from "./seedTask";
import { exportTaskRecords, parseTaskExport } from "./taskExport";
import { TaskService } from "./taskService";
import { TaskTimeline } from "./taskTimeline";

// INF-1296 B piece 5: the captain explicitly requires migration coverage
// protecting existing users' specifications, saved facts and history.
describe("retiring mixed task storage", () => {
  it("declares one owner for every work-shape field and derives the basis verdict", () => {
    const fields = [
      ...CONTRACT_FIELDS,
      ...PLACEMENT_FIELDS,
      ...PROGRAM_FIELDS,
      ...ROUTING_FIELDS,
      ...WORKSPACE_FIELDS,
      ...POLICY_SHAPE_FIELDS,
      ...Object.values(REFERENCE_SHAPE_FIELDS),
      "basis_verified",
    ];
    expect(fields.length).toBe(new Set(fields).size);
    expect([...fields].sort()).toEqual(Object.keys(workShapeSchema.shape).sort());
  });

  it("keeps exact goal-edit receipts after later edits and never accepts a permission through the evidence writer", () => {
    const db = openDatabase(scratchDir("task-specification-receipts-"));
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: "goal",
      title: "Check the practice release",
      status: "queued",
      intent: { goal: "The Mac check passes.", userWords: "check the practice release" },
    });
    tasks.updateFields("goal", { goal: "Both the Mac and Windows checks pass." }, "captain");
    const revised = tasks.timeline("goal").find((event) => event.data?.specificationRevision === 2);
    expect(revised).toBeDefined();
    tasks.updateFields("goal", { goal: "The next practice release also passes." }, "captain");
    const source = new TaskTimeline({ tasks }).expand("goal", `task-event:${revised?.id}`);
    expect(source).toMatchObject({
      status: "available",
      record: { specification: { goal: "Both the Mac and Windows checks pass." } },
    });
    expect(revised?.data?.journal).toBe(true);
    const before = tasks.get("goal");
    expect(() =>
      tasks.delivery.recordChangeEvidence("goal", { completionOffers: [] } as never),
    ).toThrow("Change evidence cannot write permissions");
    expect(() => tasks.delivery.recordPermissionRecords("goal", { ci: "green" } as never)).toThrow(
      "A permission write can only replace permission records",
    );
    expect(tasks.get("goal")).toEqual(before);
    db.close();
  });

  it("preserves an existing user's full record across upgrade, restart and later specification edits", () => {
    const dir = scratchDir("task-retirement-");
    const old = openDatabase(dir, TASK_RECORD_RETIREMENT_VERSION - 1);
    const tasks = new TaskService({ db: old, strict: true, now: () => 10000 });
    seedTask(tasks, {
      id: "practice",
      title: "Rerun the practice release's Mac check",
      status: "idle",
      intent: { goal: "The practice release passes.", userWords: "rerun the practice release" },
      prompt: "Goal: The practice release passes.",
      shape: {
        kind: "implement",
        internal_step: true,
        result_schema: { type: "object" },
        skipped_plan_because: "The reproduction is already recorded.",
        override_model_id: "openai-codex/gpt-6-sol",
        runs_on_ask: "this-mac",
        in_place: { folder: true },
      },
    });
    const olderIntent = JSON.stringify(tasks.get("practice")?.intent, null, 2);
    old.prepare("UPDATE tasks SET intent_json = ? WHERE id = 'practice'").run(olderIntent);
    tasks.recordBrief("practice", ["The practice release passes."]);
    tasks.turns.recordReport("practice", {
      text: "The Mac check passes.",
      declared: { result: { passed: true } },
    });
    seedDelivery(tasks, "practice", { mode: "direct-pr", ci: "green" });
    tasks.close("practice", { status: "done", reason: "finished", actor: "host" });
    const before = tasks.get("practice");
    const history = tasks.timeline("practice");
    old.close();

    const db = openDatabase(dir);
    const upgraded = new TaskService({ db, strict: true, now: () => 11000 });
    expect(upgraded.get("practice")).toEqual(before);
    expect(upgraded.timeline("practice")).toEqual(history);
    const columns = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const column of RETIRED_TASK_COLUMNS) expect(columns).not.toContain(column);
    const initial = db
      .prepare("SELECT id, goal, prompt, intent_json FROM task_specifications")
      .get();
    const firstExport = parseTaskExport(exportTaskRecords(upgraded, 12000));
    expect(firstExport.specifications).toEqual([
      {
        taskId: "practice",
        specifications: [
          {
            goal: before?.goal,
            prompt: before?.prompt,
            intentJson: olderIntent,
          },
        ],
      },
    ]);
    upgraded.updateFields(
      "practice",
      { goal: "The practice release also passes on Windows." },
      "captain",
    );
    expect(
      db
        .prepare(
          "SELECT id, goal, prompt, intent_json FROM task_specifications ORDER BY id LIMIT 1",
        )
        .get(),
    ).toEqual(initial);
    expect(upgraded.get("practice")?.intent?.userWords).toBe(before?.intent?.userWords);
    expect(upgraded.get("practice")?.goal).toBe("The practice release also passes on Windows.");
    expect(upgraded.servedBrief(history.find((e) => e.kind === "briefed")!)).toBe(
      "The practice release passes.",
    );
    db.close();

    const restarted = openDatabase(dir);
    const reopened = new TaskService({ db: restarted, strict: true });
    expect(reopened.get("practice")?.goal).toBe("The practice release also passes on Windows.");
    expect(restarted.prepare("SELECT COUNT(*) AS n FROM task_specifications").get()).toEqual({
      n: 2,
    });
    const exported = exportTaskRecords(reopened, 12000);
    const target = openDatabase(scratchDir("task-retirement-import-"));
    const imported = new TaskService({ db: target, strict: true });
    seedTask(imported, {
      id: "earlier-purged",
      title: "An earlier unfinished filing",
      status: "queued",
    });
    imported.archive.discardFailedSpawn("earlier-purged");
    imported.archive.importRecords(parseTaskExport(exported));
    const originalTimeline = new TaskTimeline({ tasks: reopened });
    const importedTimeline = new TaskTimeline({ tasks: imported });
    expect(imported.timeline("practice")[0]?.id).not.toBe(reopened.timeline("practice")[0]?.id);
    expect(importedTimeline.entries("practice").map((entry) => entry.id)).toEqual(
      originalTimeline.entries("practice").map((entry) => entry.id),
    );
    for (const entry of originalTimeline.entries("practice")) {
      const original = originalTimeline.expand("practice", entry.id);
      const restored = importedTimeline.expand("practice", entry.id);
      expect(restored.status).toBe("available");
      if (
        original.status === "available" &&
        restored.status === "available" &&
        original.record.source === "task-event" &&
        restored.record.source === "task-event"
      )
        expect(restored.record.event.text).toBe(original.record.event.text);
    }
    expect(imported.get("practice")).toEqual(reopened.get("practice"));
    expect(exportTaskRecords(imported, 12000)).toEqual(exported);
    target.close();
    restarted.close();
  });

  it("rolls the entire writer switch back when the specification reference cannot be committed", () => {
    const dir = scratchDir("task-retirement-interrupted-");
    const old = openDatabase(dir, TASK_RECORD_RETIREMENT_VERSION - 1);
    const tasks = new TaskService({ db: old, strict: true });
    seedTask(tasks, { id: "kept", title: "Keep the practice release record", status: "queued" });
    const before = tasks.get("kept");
    old.exec(
      "CREATE TRIGGER interrupt_retirement BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'interrupted specification reference'); END",
    );
    old.close();
    expect(() => openDatabase(dir)).toThrow("interrupted specification reference");
    const unchanged = openDatabase(dir, TASK_RECORD_RETIREMENT_VERSION - 1);
    expect(new TaskService({ db: unchanged, strict: true }).get("kept")).toEqual(before);
    expect(
      unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'task_specifications'").get(),
    ).toBeUndefined();
    expect(
      unchanged.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    ).toEqual({ version: TASK_RECORD_RETIREMENT_VERSION - 1 });
    unchanged.exec("DROP TRIGGER interrupt_retirement");
    unchanged.close();
    const recovered = openDatabase(dir);
    expect(new TaskService({ db: recovered, strict: true }).get("kept")).toEqual(before);
    recovered.close();
  });

  it("keeps scoped live-list reads composed so boot sees a retained approval and its original specification", () => {
    const dir = scratchDir("task-live-retirement-");
    const old = openDatabase(dir, TASK_RECORD_RETIREMENT_VERSION - 1);
    const tasks = new TaskService({ db: old, strict: true });
    seedTask(tasks, {
      id: "live",
      title: "Keep the practice release",
      status: "idle",
      worktreeDir: "/work/practice",
      prompt: "Goal: Keep the practice release.",
      shape: { kind: "implement" },
    });
    seedDelivery(tasks, "live", { mode: "direct-pr", completionOffers: [] });
    const before = tasks.listLive();
    old.close();
    const db = openDatabase(dir);
    const upgraded = new TaskService({ db, strict: true });
    expect(upgraded.listLive()).toEqual(before);
    expect(upgraded.listActive()).toEqual(before);
    expect(upgraded.get("live")).toEqual(before[0]);
    db.close();
  });

  it("records only new session observations and keeps their metadata immutable across later model changes", () => {
    const db = openDatabase(scratchDir("task-session-observations-"));
    const tasks = new TaskService({ db, strict: true });
    const task = seedTask(tasks, {
      id: "conversation",
      title: "Read the practice release history",
      status: "queued",
    });
    const file = "/work/practice/sessions/2026-10-20_pi.jsonl";
    tasks.turns.setSessionFile(task.id, file);
    const timeline = new TaskTimeline({ tasks });
    expect(
      timeline.entries(task.id).some((entry) => entry.content.kind === "session-observation"),
    ).toBe(false);
    const facts = {
      file,
      computer: "This computer",
      device_id: null,
      provider: "openai-codex",
      model: "gpt-5.5",
      account_id: null,
      began: "resume",
    };
    tasks.turns.setSessionFile(task.id, file, facts);
    const cut = timeline.read(task.id, { limit: 1 });
    const atCut = timeline.entries(task.id).map((entry) => entry.id);
    tasks.turns.setSessionFile(task.id, file, { ...facts, model: "gpt-6" });
    const paged = cut.entries.map((entry) => entry.id);
    let cursor = cut.cursor;
    while (cursor) {
      const page = timeline.read(task.id, { limit: 1, cursor });
      paged.push(...page.entries.map((entry) => entry.id));
      cursor = page.cursor;
    }
    expect(paged).toEqual(atCut);
    const observations = timeline
      .sources(task.id)
      .filter(({ entry }) => entry.content.kind === "session-observation");
    expect(observations).toHaveLength(2);
    expect(observations[0]?.record).toMatchObject({ observation: { model: "gpt-5.5" } });
    expect(observations[1]?.record).toMatchObject({ observation: { model: "gpt-6" } });
    expect(tasks.archive.sessions(task.id)).toHaveLength(1);
    expect(tasks.archive.sessions(task.id)[0]?.model).toBe("gpt-6");
    expect(timeline.expand(task.id, observations[0]!.entry.id)).toMatchObject({
      status: "available",
      record: { observation: { model: "gpt-5.5" } },
    });
    if (observations[0]?.record?.source === "session-observation")
      expect(observations[0].record.observation).not.toHaveProperty("resume_token");
    db.close();
  });

  it("preserves real older routing fields and unreadable saved evidence without inventing a shape", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../tests/fixtures/replay/sep26-claude/tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tasks: { shape_json: string | null }[] };
    const saved = fixture.tasks.find((row) => row.shape_json)?.shape_json;
    expect(saved).toBeTruthy();
    const dir = scratchDir("task-retirement-legacy-");
    const old = openDatabase(dir, TASK_RECORD_RETIREMENT_VERSION - 1);
    const tasks = new TaskService({ db: old, strict: true });
    for (const id of ["known", "unreadable"])
      seedTask(tasks, { id, title: "Review an older practice release", status: "queued" });
    old.prepare("UPDATE tasks SET shape_json = ? WHERE id = 'known'").run(saved);
    old
      .prepare("UPDATE tasks SET shape_json = ?, delivery_json = ? WHERE id = 'unreadable'")
      .run("{unreadable", "{not-json");
    const before = tasks.get("known");
    old.close();
    const db = openDatabase(dir);
    const upgraded = new TaskService({ db, strict: true });
    expect(upgraded.get("known")).toEqual(before);
    expect(upgraded.get("unreadable")?.shape).toBeNull();
    expect(upgraded.get("unreadable")?.delivery).toBeNull();
    expect(
      db
        .prepare(
          "SELECT unreadable_shape, delivery_json FROM task_record_history WHERE task_id = 'unreadable'",
        )
        .get(),
    ).toEqual({ unreadable_shape: "{unreadable", delivery_json: "{not-json" });
    db.close();
  });
});
