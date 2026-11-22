import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS,
  appliedVersions,
  columnNames,
  REVERSE_CLOSE_CONTROL_RESTORE,
  REVERSE_MIGRATION_50,
  REVERSE_MIGRATION_57,
  REVERSE_MIGRATION_59,
  REVERSE_MIGRATION_63,
  REVERSE_MIGRATION_65,
  REVERSE_MIGRATION_66,
  REVERSE_MIGRATION_67,
  REVERSE_MIGRATION_69,
  REVERSE_MIGRATION_70,
  REVERSE_MIGRATION_71,
  REVERSE_MIGRATION_76,
  REVERSE_MIGRATION_78,
  REVERSE_MIGRATION_79,
  REVERSE_MIGRATION_80,
  REVERSE_RUNNING_WORK,
  REVERSE_SCHEDULE_NOTES,
  REVERSE_TASK_REFERENCES,
  REVERSE_TASK_SESSIONS,
  tableNames,
  tmpUserData,
} from "../../../tests/helpers/migrations";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { AppDatabase } from "./db";
import { openDatabase, openInMemoryDatabase } from "./db";
import { dropViews } from "./views";

const PROVENANCE_COLUMNS = [
  "card_id",
  "model",
  "prompt_sha",
  "tools_sha",
  "steered",
  "wake_kind",
] as const;

const LABEL_COLUMNS = ["missed_escalation", "missed_note", "missed_at"] as const;

describe("migration 15 (supervision provenance)", () => {
  it("applies every migration on a fresh database, including the provenance columns", () => {
    const db = openInMemoryDatabase();
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);
    const columns = columnNames(db, "supervision_outcomes");
    for (const column of PROVENANCE_COLUMNS) {
      expect(columns).toContain(column);
    }
  });

  it("applies 15 on a database already at 14 without rewriting earlier rows", () => {
    const dir = tmpUserData();
    const atFourteen = openDatabase(dir, 14);
    expect(appliedVersions(atFourteen).at(-1)).toBe(14);
    const preColumns = columnNames(atFourteen, "supervision_outcomes");
    for (const column of PROVENANCE_COLUMNS) {
      expect(preColumns).not.toContain(column);
    }
    atFourteen
      .prepare(
        "INSERT INTO supervision_outcomes (task_id, wake, verdict, summary, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t-pre", "[fm-op] crewmate 1 reported on task t-pre: done", "routine", "Quiet.", 1);
    atFourteen.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded).at(-1)).toBe(ALL_VERSIONS.at(-1));
    const columns = columnNames(upgraded, "supervision_outcomes");
    for (const column of PROVENANCE_COLUMNS) {
      expect(columns).toContain(column);
    }
    const row = upgraded
      .prepare(
        "SELECT task_id, card_id, model, prompt_sha, tools_sha, steered, wake_kind FROM supervision_outcomes",
      )
      .get() as {
      task_id: string;
      card_id: string | null;
      model: string | null;
      prompt_sha: string | null;
      tools_sha: string | null;
      steered: number | null;
      wake_kind: string | null;
    };
    expect(row.task_id).toBe("t-pre");
    expect(row.card_id).toBeNull();
    expect(row.model).toBeNull();
    expect(row.prompt_sha).toBeNull();
    expect(row.tools_sha).toBeNull();
    expect(row.steered).toBeNull();
    expect(row.wake_kind).toBeNull();
    upgraded.close();
  });

  it("migrates a database stuck at 13 (the PoC-0 captain-install schema) through the head", () => {
    const dir = tmpUserData();
    const stuck = openDatabase(dir, 13);
    expect(appliedVersions(stuck).at(-1)).toBe(13);
    expect(columnNames(stuck, "supervision_outcomes")).toEqual([
      "id",
      "task_id",
      "wake",
      "verdict",
      "summary",
      "at",
    ]);
    stuck.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const columns = columnNames(upgraded, "supervision_outcomes");
    for (const column of PROVENANCE_COLUMNS) {
      expect(columns).toContain(column);
    }
    upgraded.close();
  });
});

describe("migration 16 (confirmed missed-escalation label)", () => {
  it("applies 16 on a database already at 15 and leaves existing rows unlabelled", () => {
    const dir = tmpUserData();
    const atFifteen = openDatabase(dir, 15);
    expect(appliedVersions(atFifteen).at(-1)).toBe(15);
    const preColumns = columnNames(atFifteen, "supervision_outcomes");
    for (const column of LABEL_COLUMNS) {
      expect(preColumns).not.toContain(column);
    }
    atFifteen
      .prepare(
        "INSERT INTO supervision_outcomes (task_id, wake, verdict, summary, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t-pre", "[fm-op] crewmate 1 reported on task t-pre: done", "routine", "Quiet.", 1);
    atFifteen.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded).at(-1)).toBe(ALL_VERSIONS.at(-1));
    const row = upgraded
      .prepare(
        "SELECT task_id, missed_escalation, missed_note, missed_at FROM supervision_outcomes",
      )
      .get() as {
      task_id: string;
      missed_escalation: number | null;
      missed_note: string | null;
      missed_at: number | null;
    };
    expect(row.task_id).toBe("t-pre");
    expect(row.missed_escalation).toBeNull();
    expect(row.missed_note).toBeNull();
    expect(row.missed_at).toBeNull();
    upgraded.close();
  });
});

describe("migration 50 (one decision ledger, the primitives review P6)", () => {
  it("moves every routing, account and sort row into one ledger, reads the same through the old names, and reverses", () => {
    const dir = tmpUserData();
    const at49 = openDatabase(dir, 49);
    seedTask(new TaskService({ db: at49, strict: true }), {
      id: "t1",
      title: "Routed and sorted",
      status: "idle",
    });
    const sort = at49.prepare(
      `INSERT INTO supervision_outcomes (task_id, wake, verdict, summary, at, card_id, model, missed_escalation, missed_note, missed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A retired triage's verdict, labelled a miss, and a rule's sort.
    sort.run(
      "t1",
      "[fm-op] reported: tests green",
      "routine",
      "green",
      10,
      null,
      "grok-build-0.1",
      1,
      "mine",
      11,
    );
    sort.run(
      "t1",
      "[fm-op] reported: stopped",
      "captain",
      "stopped",
      20,
      "card-1",
      "rule:stopped",
      null,
      null,
      null,
    );
    const route = at49.prepare(
      "INSERT INTO routing_decisions (task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    route.run("t1", "openai-codex", "gpt-5.5", "high", "R3", "medium", '["shape kind=change"]', 5);
    route.run("t1", null, null, "high", "R3", null, '["nothing served"]', 30);
    at49
      .prepare(
        "INSERT INTO account_decisions (task_id, provider, account_id, reasons_json, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t1", "openai-codex", "acct-1", '["headroom first"]', 6);
    const read = (db: AppDatabase) => ({
      sort: db.prepare("SELECT * FROM supervision_outcomes ORDER BY id").all(),
      routing: db
        .prepare(
          "SELECT task_id, provider, model, bucket, reasons_json, at, rule, served FROM routing_decisions ORDER BY id",
        )
        .all(),
      account: db
        .prepare(
          "SELECT task_id, provider, account_id, reasons_json, at FROM account_decisions ORDER BY id",
        )
        .all(),
      published: db.prepare("SELECT * FROM v_routing_v1 ORDER BY at").all(),
      board: db.prepare("SELECT task_id, model, provider, tier FROM v_tasks_v1").all(),
    });
    const before = read(at49);
    const columnsAt49 = {
      sort: columnNames(at49, "supervision_outcomes"),
      routing: columnNames(at49, "routing_decisions"),
      account: columnNames(at49, "account_decisions"),
    };
    const tablesAt49 = tableNames(at49);
    at49.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const tables = tableNames(upgraded);
    expect(tables).toContain("decisions");
    for (const old of ["routing_decisions", "account_decisions", "supervision_outcomes"]) {
      expect(tables).not.toContain(old);
    }
    // One ledger: a sort row keeps its id (the log and the decided events
    // name it), the rule leaves `model` for `rule`, the rest follow in order.
    expect(
      upgraded.prepare("SELECT id, kind, task_id, rule, model FROM decisions ORDER BY id").all(),
    ).toEqual([
      { id: 1, kind: "sort", task_id: "t1", rule: null, model: "grok-build-0.1" },
      { id: 2, kind: "sort", task_id: "t1", rule: "stopped", model: null },
      { id: 3, kind: "routing", task_id: "t1", rule: "R3", model: "gpt-5.5" },
      { id: 4, kind: "routing", task_id: "t1", rule: "R3", model: null },
      { id: 5, kind: "account", task_id: "t1", rule: null, model: null },
    ]);
    // Every reader of the old names reads the same rows; a sort row adds
    // only its (absent) facts.
    const after = read(upgraded);
    expect(after).toEqual({
      ...before,
      sort: (before.sort as Record<string, unknown>[]).map((row) => ({ ...row, facts_json: null })),
    });
    expect(columnNames(upgraded, "supervision_outcomes")).toEqual([
      ...columnsAt49.sort,
      "facts_json",
    ]);
    expect(columnNames(upgraded, "routing_decisions")).toEqual(columnsAt49.routing);
    expect(columnNames(upgraded, "account_decisions")).toEqual(columnsAt49.account);
    // The old names are views: the ledger has one writer.
    expect(() =>
      upgraded
        .prepare(
          "INSERT INTO routing_decisions (task_id, bucket, reasons_json, at) VALUES ('t1', 'low', '[]', 1)",
        )
        .run(),
    ).toThrow();

    // Reversible: the three tables back from their kinds, every row as it was.
    dropViews(upgraded);
    upgraded.exec(
      REVERSE_SCHEDULE_NOTES +
        REVERSE_CLOSE_CONTROL_RESTORE +
        REVERSE_RUNNING_WORK +
        REVERSE_TASK_REFERENCES +
        REVERSE_TASK_SESSIONS +
        REVERSE_MIGRATION_80 +
        REVERSE_MIGRATION_79 +
        REVERSE_MIGRATION_78 +
        REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    upgraded.exec(REVERSE_MIGRATION_50);
    upgraded.prepare("DELETE FROM schema_migrations WHERE version = 50").run();
    upgraded.close();
    const reversed = openDatabase(dir, 49);
    expect(tableNames(reversed)).toEqual(tablesAt49);
    expect(read(reversed)).toEqual(before);
    reversed.close();
  });
});

describe("migrations 34-35 (the work shape, its rule, and the served tier)", () => {
  it("adds every column to a database that predates the shape, keeps every row, and reverses", () => {
    const dir = tmpUserData();
    const atThirtyThree = openDatabase(dir, 33);
    const tasks = new TaskService({ db: atThirtyThree, strict: true });
    seedTask(tasks, { id: "old1", title: "Routed before the shape", status: "idle" });
    // A database created after this change receives `shape_json` with the
    // task record itself; the one this migration exists for is the captain's,
    // whose tasks table predates the shape entirely.
    atThirtyThree.exec("ALTER TABLE tasks DROP COLUMN shape_json;");
    const taskColumnsAt33 = columnNames(atThirtyThree, "tasks");
    const routingColumnsAt33 = columnNames(atThirtyThree, "routing_decisions");
    atThirtyThree
      .prepare(
        "INSERT INTO routing_decisions (task_id, provider, model, bucket, reasons_json, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("old1", "openai-codex", "gpt-5.5", "medium", '["picked codex/gpt-5.5"]', 1);
    atThirtyThree.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(columnNames(upgraded, "tasks")).not.toContain("shape_json");
    expect(columnNames(upgraded, "task_records")).toContain("shape_json");
    expect(columnNames(upgraded, "routing_decisions")).toContain("rule");
    expect(columnNames(upgraded, "routing_decisions")).toContain("served");
    // Nothing is backfilled: a row routed before the shape existed has no
    // shape and no rule, which is the honest answer, never a guessed kind.
    // `served` is not assumed equal to `bucket` either - what the ladder
    // actually answered with was never recorded on that row.
    expect(
      upgraded
        .prepare("SELECT id, difficulty, shape_json FROM task_records WHERE id = 'old1'")
        .get(),
    ).toEqual({ id: "old1", difficulty: null, shape_json: null });
    expect(
      upgraded.prepare("SELECT task_id, bucket, rule, served FROM routing_decisions").all(),
    ).toEqual([{ task_id: "old1", bucket: "medium", rule: null, served: null }]);

    // Reversible: dropping the columns restores the v33 shape with every row.
    // Migration 42's views read these columns, and migration 50 moved the
    // table into the ledger: undoing the head undoes both first.
    dropViews(upgraded);
    upgraded.exec(
      REVERSE_CLOSE_CONTROL_RESTORE +
        REVERSE_RUNNING_WORK +
        REVERSE_MIGRATION_76 +
        REVERSE_MIGRATION_71 +
        REVERSE_MIGRATION_70 +
        REVERSE_MIGRATION_69 +
        REVERSE_MIGRATION_67 +
        REVERSE_MIGRATION_66 +
        REVERSE_MIGRATION_65 +
        REVERSE_MIGRATION_63 +
        REVERSE_MIGRATION_59 +
        REVERSE_MIGRATION_57,
    );
    upgraded.exec(REVERSE_MIGRATION_50);
    upgraded.exec(
      "ALTER TABLE tasks DROP COLUMN shape_json; ALTER TABLE routing_decisions DROP COLUMN rule; ALTER TABLE routing_decisions DROP COLUMN served;",
    );
    expect(columnNames(upgraded, "tasks")).toEqual(taskColumnsAt33);
    expect(columnNames(upgraded, "routing_decisions")).toEqual(routingColumnsAt33);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    upgraded.close();
  });
});
