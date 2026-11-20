import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS,
  appliedVersions,
  columnNames,
  tmpUserData,
} from "../../../tests/helpers/migrations";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { AppDatabase } from "./db";
import { openDatabase, openInMemoryDatabase } from "./db";

// The task record's migrations (taskRecordMigrations.ts): the record itself, its hygiene
// backfill, follow-ups, parked decisions and the delivered status.

describe("migrations 17-19 (the task record, P0)", () => {
  type MappedRow = {
    id: string;
    key: string;
    seq: number;
    project_id: string;
    kind: string;
    status: string;
    activity: string | null;
    closed_reason: string | null;
    workspace_state: string;
    gate_kind: string | null;
    gate_ref: string | null;
    updated_at: number;
    priority: number;
    start_policy: string;
  };

  /**
   * A version-16 database with every pre-P0 status value, a parked
   * decision, an after-task gate, and one managed repo - the shape a
   * captain install carries into the upgrade.
   */
  function seedVersion16(dir: string): void {
    const db = openDatabase(dir, 16);
    expect(appliedVersions(db).at(-1)).toBe(16);
    db.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'adopt', NULL, 'local-only', 0)",
    ).run("r1", "/tmp/infinitary-fixture/firstmate-3000", "firstmate-3000", 100);
    const insert = db.prepare(
      `INSERT INTO tasks (id, kind, title, prompt, repo_id, repo_dir, worktree_dir, branch, session_file, account_id, difficulty, gate_kind, gate_ref, gate_until, gate_reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const worked = (id: string, status: string, repoId: string | null, at: number) =>
      insert.run(
        id,
        "work",
        `task ${id}`,
        "brief",
        repoId,
        "/repo",
        `/worktrees/${id}`,
        `fm/task-${id}`,
        `/sessions/${id}.jsonl`,
        null,
        null,
        null,
        null,
        null,
        null,
        status,
        at,
      );
    worked("running1", "running", "r1", 1_000);
    worked("idle1", "idle", "r1", 2_000);
    worked("intr1", "interrupted", null, 3_000);
    worked("done1", "completed", "r1", 4_000);
    worked("canc1", "cancelled", null, 5_000);
    worked("fail1", "failed", "r1", 6_000);
    // A completed row whose worktree is gone (an old cleanup left the row).
    insert.run(
      "done2",
      "work",
      "task done2",
      "brief",
      null,
      "",
      "",
      "",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "completed",
      6_500,
    );
    // Queued behind a time gate, behind another task, and behind a task
    // that no longer exists.
    insert.run(
      "q-time",
      "work",
      "nightly",
      "brief",
      "r1",
      "",
      "",
      "",
      null,
      null,
      null,
      "at-time",
      null,
      9_999_999_999_999,
      null,
      "queued",
      7_000,
    );
    insert.run(
      "q-after",
      "work",
      "dependent",
      "brief",
      "r1",
      "",
      "",
      "",
      null,
      null,
      "high",
      "after-task",
      "idle1",
      null,
      null,
      "queued",
      8_000,
    );
    insert.run(
      "q-gone",
      "work",
      "orphan wait",
      "brief",
      null,
      "",
      "",
      "",
      null,
      null,
      null,
      "after-task",
      "missing",
      null,
      null,
      "queued",
      9_000,
    );
    // A parked decision (R1) held by its card id.
    insert.run(
      "park-card-fm-1",
      "decision",
      "Which port?",
      "",
      null,
      "",
      "",
      "",
      null,
      null,
      null,
      "captain",
      "card-fm-1",
      9_999_999_999_999,
      null,
      "queued",
      10_000,
    );
    db.close();
  }

  it("migrates a version-16 fixture through 19 with the status mapping and durable keys", () => {
    const dir = tmpUserData();
    seedVersion16(dir);
    const db = openDatabase(dir);
    expect(appliedVersions(db)).toEqual(ALL_VERSIONS);

    const projects = db
      .prepare(
        "SELECT id, key, name, kind, repo_id, next_seq, archived_at FROM projects ORDER BY created_at, id",
      )
      .all() as {
      id: string;
      key: string;
      name: string;
      kind: string;
      repo_id: string | null;
      next_seq: number;
      archived_at: number | null;
    }[];
    expect(projects.map((p) => [p.id, p.key, p.kind, p.repo_id])).toEqual([
      ["proj-r1", "FI3", "repo", "r1"],
      ["scratch", "SCR", "scratch", null],
    ]);
    expect(projects.every((p) => p.archived_at === null)).toBe(true);

    const rows = new Map(
      (db.prepare("SELECT * FROM tasks").all() as MappedRow[]).map((row) => [row.id, row]),
    );
    const mapped = (id: string) => {
      const row = rows.get(id) as MappedRow;
      return [
        row.project_id,
        row.key,
        row.kind,
        row.status,
        row.activity,
        row.closed_reason,
        row.workspace_state,
      ];
    };
    expect(mapped("running1")).toEqual([
      "proj-r1",
      "FI3-1",
      "work",
      "active",
      "running",
      null,
      "present",
    ]);
    expect(mapped("idle1")).toEqual([
      "proj-r1",
      "FI3-2",
      "work",
      "active",
      "idle",
      null,
      "present",
    ]);
    expect(mapped("intr1")).toEqual([
      "scratch",
      "SCR-1",
      "work",
      "active",
      "interrupted",
      null,
      "present",
    ]);
    // A completed legacy row is closed history (WI-11 retired `delivered`):
    // it maps straight to done/finished, its worktree flag untouched.
    expect(mapped("done1")).toEqual([
      "proj-r1",
      "FI3-3",
      "work",
      "done",
      null,
      "finished",
      "present",
    ]);
    // Mapped `present` at 17; the fixture's worktree path was never on disk,
    // so migration 23 clears the flag on the cancelled row (WI-7).
    expect(mapped("canc1")).toEqual([
      "scratch",
      "SCR-2",
      "work",
      "dropped",
      null,
      "cancelled",
      "removed",
    ]);
    expect(mapped("fail1")).toEqual([
      "proj-r1",
      "FI3-4",
      "work",
      "dropped",
      null,
      "failed",
      "present",
    ]);
    expect(mapped("done2")).toEqual(["scratch", "SCR-3", "work", "done", null, "finished", "none"]);
    expect(mapped("q-time")).toEqual(["proj-r1", "FI3-5", "work", "open", null, null, "none"]);
    expect(mapped("q-after")).toEqual(["proj-r1", "FI3-6", "work", "open", null, null, "none"]);
    expect(mapped("q-gone")).toEqual(["scratch", "SCR-4", "work", "open", null, null, "none"]);
    // The park row P1 made of a deferred decision is closed by migration 28
    // (cards/tasks/agents P0): parked decisions are retired.
    expect(mapped("park-card-fm-1")).toEqual([
      "scratch",
      "SCR-5",
      "decision",
      "dropped",
      null,
      "superseded",
      "none",
    ]);

    // Holds survive as gates; the after-task wait became a blocks edge and
    // its gate cleared (a missing target simply clears).
    expect(rows.get("q-time")).toMatchObject({ gate_kind: "at-time" });
    // The park's hold went with the row (migration 28), logged for reversal.
    expect(rows.get("park-card-fm-1")).toMatchObject({ gate_kind: null, gate_ref: null });
    expect(db.prepare("SELECT task_id, gate_ref FROM park_row_backfill").all()).toEqual([
      { task_id: "park-card-fm-1", gate_ref: "card-fm-1" },
    ]);
    expect(rows.get("q-after")).toMatchObject({ gate_kind: null, gate_ref: null });
    expect(rows.get("q-gone")).toMatchObject({ gate_kind: null, gate_ref: null });
    const links = db
      .prepare("SELECT from_id, to_id, type, actor FROM task_links ORDER BY from_id")
      .all();
    expect(links).toEqual([{ from_id: "idle1", to_id: "q-after", type: "blocks", actor: "host" }]);

    // Every row carries the record invariants and a birth event.
    for (const row of rows.values()) {
      expect(row.updated_at).toBeGreaterThan(0);
      expect(row.priority).toBe(2);
      expect(row.start_policy).toBe("when-ready");
    }
    const events = db
      .prepare("SELECT task_id, kind, actor, feed FROM task_events ORDER BY at, id")
      .all() as { task_id: string; kind: string; actor: string; feed: number }[];
    // Every row has a birth event; the park's close (migration 28) adds one.
    expect(events).toHaveLength(rows.size + 1);
    expect(events.filter((e) => e.kind === "status")).toEqual([
      { task_id: "park-card-fm-1", kind: "status", actor: "host", feed: 0 },
    ]);
    expect(events.filter((e) => e.kind !== "status").every((e) => e.kind === "created")).toBe(true);
    expect(events.every((e) => e.actor === "host" && e.feed === 0)).toBe(true);
    // The per-project sequence continues after the backfilled rows.
    expect(projects.find((p) => p.id === "proj-r1")?.next_seq).toBe(7);
    expect(projects.find((p) => p.id === "scratch")?.next_seq).toBe(6);
    expect(columnNames(db, "captain_asks")).toContain("turn_state");
    db.close();
  });

  it("is idempotent across reopen and leaves a fresh database with Scratch only", () => {
    const dir = tmpUserData();
    seedVersion16(dir);
    openDatabase(dir).close();
    const again = openDatabase(dir);
    expect(appliedVersions(again)).toEqual(ALL_VERSIONS);
    expect((again.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(11);
    again.close();

    const fresh = openInMemoryDatabase();
    expect(fresh.prepare("SELECT id, key FROM projects").all()).toEqual([
      { id: "scratch", key: "SCR" },
    ]);
    expect(columnNames(fresh, "task_records")).toEqual(
      expect.arrayContaining([
        "key",
        "seq",
        "project_id",
        "parent_id",
        "activity",
        "closed_reason",
        "priority",
        "goal",
        "intent_json",
        "outcome",
        "outcome_summary",
        "delivery_json",
        "assignee",
        "model",
        "start_policy",
        "workspace_state",
        "updated_at",
        "started_at",
        "closed_at",
      ]),
    );
  });
});

describe("migration 23 (fleet hygiene backfill, WI-7)", () => {
  type HygieneRow = {
    id: string;
    status: string;
    closed_reason: string | null;
    closed_at: number | null;
    workspace_state: string;
  };
  const rows = (db: AppDatabase) =>
    db
      .prepare(
        "SELECT id, status, closed_reason, closed_at, workspace_state FROM tasks ORDER BY id",
      )
      .all() as HygieneRow[];

  it("stamps closed_at on closed rows, clears present only where the worktree is gone, and reverses", () => {
    const dir = tmpUserData();
    const survivingWorktree = scratchDir("infinitary-wt-");
    const atTwentyTwo = openDatabase(dir, 22);
    let now = 5_000;
    const tasks = new TaskService({ db: atTwentyTwo, now: () => now, strict: true });
    seedTask(tasks, { id: "active", title: "Live", status: "idle", worktreeDir: "/gone/active" });
    now = 6_000;
    seedTask(tasks, {
      id: "cancelled-gone",
      title: "A",
      status: "cancelled",
      worktreeDir: "/gone/a",
    });
    now = 7_000;
    seedTask(tasks, {
      id: "discarded-kept",
      title: "B",
      status: "idle",
      worktreeDir: survivingWorktree,
    });
    tasks.close("discarded-kept", { status: "dropped", reason: "discarded", actor: "host" });
    now = 8_000;
    // A legacy completed row, closed to done/finished the way migration 17
    // leaves one (WI-11 retired `delivered`, so a completed row is done).
    seedTask(tasks, { id: "done-legacy", title: "C", status: "idle" });
    tasks.close("done-legacy", { status: "done", reason: "finished", actor: "host" });
    // What migration 17 left behind on real installs: closed, no closed_at.
    atTwentyTwo.exec("UPDATE tasks SET closed_at = NULL WHERE status <> 'active'");
    const before = rows(atTwentyTwo);
    atTwentyTwo.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    expect(rows(upgraded)).toEqual([
      {
        id: "active",
        status: "active",
        closed_reason: null,
        closed_at: null,
        workspace_state: "present",
      },
      // The close event's own time, not the upgrade's.
      {
        id: "cancelled-gone",
        status: "dropped",
        closed_reason: "cancelled",
        closed_at: 6_000,
        workspace_state: "removed",
      },
      // Its worktree is still on disk, so `present` is still the truth.
      {
        id: "discarded-kept",
        status: "dropped",
        closed_reason: "discarded",
        closed_at: 7_000,
        workspace_state: "present",
      },
      {
        id: "done-legacy",
        status: "done",
        closed_reason: "finished",
        closed_at: 8_000,
        workspace_state: "none",
      },
    ]);
    const log = upgraded
      .prepare(
        "SELECT task_id, column_name, old_value, new_value FROM task_hygiene_backfill ORDER BY task_id, column_name",
      )
      .all();
    expect(log).toEqual([
      { task_id: "cancelled-gone", column_name: "closed_at", old_value: null, new_value: "6000" },
      {
        task_id: "cancelled-gone",
        column_name: "workspace_state",
        old_value: "present",
        new_value: "removed",
      },
      { task_id: "discarded-kept", column_name: "closed_at", old_value: null, new_value: "7000" },
      { task_id: "done-legacy", column_name: "closed_at", old_value: null, new_value: "8000" },
    ]);

    // Reversible: restoring every logged old value and dropping the log
    // table gives back the v22 rows exactly.
    upgraded.exec(`
      UPDATE tasks SET closed_at = NULL
        WHERE id IN (SELECT task_id FROM task_hygiene_backfill WHERE column_name = 'closed_at');
      UPDATE tasks SET workspace_state = (
          SELECT old_value FROM task_hygiene_backfill b
          WHERE b.task_id = tasks.id AND b.column_name = 'workspace_state')
        WHERE id IN (SELECT task_id FROM task_hygiene_backfill WHERE column_name = 'workspace_state');
      DROP TABLE task_hygiene_backfill;
    `);
    expect(rows(upgraded)).toEqual(before);
    upgraded.close();
  });
});

describe("migration 26 (follow-ups stop being children)", () => {
  it("detaches a filed follow-up from its origin, keeps blocks edges, and reverses", () => {
    const dir = tmpUserData();
    const atTwentyFive = openDatabase(dir, 25);
    const task = (id: string, parent: string | null, status: string) =>
      atTwentyFive
        .prepare(
          `INSERT INTO tasks (id, key, seq, project_id, parent_id, kind, title, prompt, repo_dir,
             worktree_dir, branch, status, priority, start_policy, workspace_state, created_at, updated_at)
           VALUES (?, ?, 1, 'proj', ?, 'work', ?, 'p', '', '', '', ?, 2, 'on-request', 'none', 1, 1)`,
        )
        .run(id, id.toUpperCase(), parent, id, status);
    const link = (from: string, to: string, type: string) =>
      atTwentyFive
        .prepare(
          "INSERT INTO task_links (from_id, to_id, type, actor, created_at) VALUES (?, ?, ?, 'crewmate', 1)",
        )
        .run(from, to, type);
    task("origin", null, "active");
    task("followup", "origin", "open");
    task("blocking", "origin", "open");
    task("closed-followup", "origin", "done");
    task("real-child", "origin", "open");
    link("followup", "origin", "discovered-from");
    link("blocking", "origin", "discovered-from");
    link("blocking", "origin", "blocks");
    link("closed-followup", "origin", "discovered-from");
    atTwentyFive.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const parents = Object.fromEntries(
      (
        upgraded.prepare("SELECT id, parent_id FROM tasks ORDER BY id").all() as {
          id: string;
          parent_id: string | null;
        }[]
      ).map((row) => [row.id, row.parent_id]),
    );
    // Both live follow-ups detach - including the one that blocks, which
    // keeps holding its origin through the blocks edge instead.
    expect(parents.followup).toBeNull();
    expect(parents.blocking).toBeNull();
    // A child that was never a follow-up is real containment, and a closed
    // follow-up keeps the history it was filed with.
    expect(parents["real-child"]).toBe("origin");
    expect(parents["closed-followup"]).toBe("origin");
    expect(
      upgraded.prepare("SELECT from_id, to_id, type FROM task_links WHERE type = 'blocks'").all(),
    ).toEqual([{ from_id: "blocking", to_id: "origin", type: "blocks" }]);

    // Reversible: every detached parent is recorded, so restoring them and
    // dropping the table returns the version-25 shape.
    const backfill = upgraded
      .prepare("SELECT task_id, parent_id FROM followup_parent_backfill ORDER BY task_id")
      .all() as { task_id: string; parent_id: string }[];
    expect(backfill).toEqual([
      { task_id: "blocking", parent_id: "origin" },
      { task_id: "followup", parent_id: "origin" },
    ]);
    const restore = upgraded.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?");
    for (const row of backfill) restore.run(row.parent_id, row.task_id);
    upgraded.exec("DROP TABLE followup_parent_backfill;");
    expect(
      upgraded.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = 'origin'").get(),
    ).toEqual({ n: 4 });
    upgraded.close();
  });
});

describe("migration 28 (parked decisions retire, cards/tasks/agents P0)", () => {
  it("closes every open park row with a timeline note, leaves live decision rows alone, and reverses", () => {
    const dir = tmpUserData();
    const atTwentySeven = openDatabase(dir, 27);
    const decision = (
      id: string,
      status: string,
      gateRef: string | null,
      gateUntil: number | null,
    ) =>
      atTwentySeven
        .prepare(
          `INSERT INTO tasks (id, key, seq, project_id, parent_id, kind, title, prompt, repo_dir,
             worktree_dir, branch, status, priority, start_policy, workspace_state,
             gate_kind, gate_ref, gate_until, created_at, updated_at)
           VALUES (?, ?, 1, 'proj', NULL, 'decision', ?, '', '', '', '', ?, 2, 'on-request', 'none',
             ?, ?, ?, 1, 1)`,
        )
        .run(id, id.toUpperCase(), id, status, gateRef ? "captain" : null, gateRef, gateUntil);
    // Two parks from before P1 (rows keyed park-<card id>), a P1 decision
    // row Later parked (a gate deadline), a live P1 decision row whose card
    // is on the stack, and a park that already closed.
    decision("park-card-fm-a", "open", "card-fm-a", 999);
    decision("park-card-t1-2", "open", "card-t1-2", 999);
    decision("d-parked", "open", "card-fm-parked", 777);
    decision("d-live", "open", "card-fm-live", null);
    decision("park-old", "done", null, null);
    atTwentySeven.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    const rows = upgraded
      .prepare(
        "SELECT id, status, closed_reason, gate_kind, gate_ref, gate_until FROM tasks ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      {
        id: "d-live",
        status: "open",
        closed_reason: null,
        gate_kind: "captain",
        gate_ref: "card-fm-live",
        gate_until: null,
      },
      {
        id: "d-parked",
        status: "dropped",
        closed_reason: "superseded",
        gate_kind: null,
        gate_ref: null,
        gate_until: null,
      },
      {
        id: "park-card-fm-a",
        status: "dropped",
        closed_reason: "superseded",
        gate_kind: null,
        gate_ref: null,
        gate_until: null,
      },
      {
        id: "park-card-t1-2",
        status: "dropped",
        closed_reason: "superseded",
        gate_kind: null,
        gate_ref: null,
        gate_until: null,
      },
      {
        id: "park-old",
        status: "done",
        closed_reason: null,
        gate_kind: null,
        gate_ref: null,
        gate_until: null,
      },
    ]);
    // Each close explains itself on the timeline, off the feed.
    expect(
      upgraded.prepare("SELECT task_id, kind, text, feed FROM task_events ORDER BY task_id").all(),
    ).toEqual(
      ["d-parked", "park-card-fm-a", "park-card-t1-2"].map((task_id) => ({
        task_id,
        kind: "status",
        text: "parked decisions are retired; nothing brings this card back",
        feed: 0,
      })),
    );
    expect(
      upgraded
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'dropped' AND closed_at IS NULL")
        .get(),
    ).toEqual({ n: 0 });

    // Reversible: the backfill table names every closed row with its gate.
    const backfill = upgraded
      .prepare("SELECT task_id, gate_ref, gate_until FROM park_row_backfill ORDER BY task_id")
      .all() as { task_id: string; gate_ref: string; gate_until: number }[];
    expect(backfill).toEqual([
      { task_id: "d-parked", gate_ref: "card-fm-parked", gate_until: 777 },
      { task_id: "park-card-fm-a", gate_ref: "card-fm-a", gate_until: 999 },
      { task_id: "park-card-t1-2", gate_ref: "card-t1-2", gate_until: 999 },
    ]);
    const restore = upgraded.prepare(
      `UPDATE tasks SET status = 'open', closed_reason = NULL, closed_at = NULL,
         gate_kind = 'captain', gate_ref = ?, gate_until = ? WHERE id = ?`,
    );
    for (const row of backfill) restore.run(row.gate_ref, row.gate_until, row.task_id);
    upgraded.exec(`
      DELETE FROM task_events WHERE text = 'parked decisions are retired; nothing brings this card back';
      DROP TABLE park_row_backfill;
    `);
    expect(
      upgraded
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'decision' AND status = 'open'")
        .get(),
    ).toEqual({ n: 4 });
    upgraded.close();
  });
});

describe("migration 30 (retire the delivered status, cards/tasks/agents P2)", () => {
  it("rewrites every delivered row to done, records each for reversal, and leaves other rows alone", () => {
    const dir = tmpUserData();
    const atTwentyNine = openDatabase(dir, 29);
    const task = (id: string, status: string, closedReason: string | null) =>
      atTwentyNine
        .prepare(
          `INSERT INTO tasks (id, key, seq, project_id, parent_id, kind, title, prompt, repo_dir,
             worktree_dir, branch, status, activity, closed_reason, closed_at, priority, start_policy,
             workspace_state, created_at, updated_at)
           VALUES (?, ?, 1, 'proj', NULL, 'work', ?, '', '', '', '', ?, NULL, ?, 100, 2, 'when-ready',
             'present', 1, 1)`,
        )
        .run(id, id.toUpperCase(), id, status, closedReason);
    // Two delivered rows from before WI-11 - one finished, one that closed
    // under a landing - plus a done row and a live active row that must not move.
    task("deliv-finished", "delivered", "finished");
    task("deliv-landed", "delivered", "landed");
    task("already-done", "done", "settled");
    task("still-active", "active", null);
    atTwentyNine.close();

    const upgraded = openDatabase(dir);
    expect(appliedVersions(upgraded)).toEqual(ALL_VERSIONS);
    // Every delivered row is done now; its closed_reason already records how
    // it closed, so nothing else moves.
    expect(
      upgraded.prepare("SELECT id, status, closed_reason FROM tasks ORDER BY id").all(),
    ).toEqual([
      { id: "already-done", status: "done", closed_reason: "settled" },
      { id: "deliv-finished", status: "done", closed_reason: "finished" },
      { id: "deliv-landed", status: "done", closed_reason: "landed" },
      { id: "still-active", status: "active", closed_reason: null },
    ]);
    expect(
      upgraded.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'delivered'").get(),
    ).toEqual({ n: 0 });

    // Reversible: the backfill names every rewritten row with the reason it
    // closed under, so restoring status per row and dropping the table undoes it.
    const backfill = upgraded
      .prepare("SELECT task_id, closed_reason FROM delivered_status_backfill ORDER BY task_id")
      .all() as { task_id: string; closed_reason: string | null }[];
    expect(backfill).toEqual([
      { task_id: "deliv-finished", closed_reason: "finished" },
      { task_id: "deliv-landed", closed_reason: "landed" },
    ]);
    const restore = upgraded.prepare("UPDATE tasks SET status = 'delivered' WHERE id = ?");
    for (const row of backfill) restore.run(row.task_id);
    upgraded.exec("DROP TABLE delivered_status_backfill;");
    expect(
      upgraded.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'delivered'").get(),
    ).toEqual({ n: 2 });
    upgraded.close();
  });
});
