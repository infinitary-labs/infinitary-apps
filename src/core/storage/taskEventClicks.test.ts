import { expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openDatabase } from "./db";
import { TaskEventStore } from "./taskEventStore";

// INF-2284, captain: "Fix the full check failures first". The freeze
// journey found the captain-click read walking recent crewmate history.
// Exercise its real statement and SQLite access path, not source text or
// returned-row counts (a walk can return nothing).
it("seeks the captain's recent clicks without walking other actors' history after reopening", () => {
  const dir = scratchDir("infinitary-task-event-clicks-");
  const before = openDatabase(dir);
  const tasks = new TaskService({ db: before, now: () => 1000 });
  seedTask(tasks, { id: "panels", title: "Build personal panels", status: "running" });
  const events = new TaskEventStore(before);
  const click = {
    taskId: "panels",
    actor: "captain",
    kind: "steered",
    text: "Continue the work.",
    data: { via: "task-card" },
  } as const;
  events.insert({ ...click, at: 999 });
  const boundary = events.insert({ ...click, at: 1000 });
  const first = events.insert({ ...click, at: 1001 });
  const second = events.insert({ ...click, at: 1001 });
  events.insert({ ...click, at: 1002, data: { via: "card" } });
  events.insert({ ...click, at: 1002, data: null });
  // Real progress events beside the clicks, as in captainSizedRecord.ts.
  tasks.noteProgress("panels", "Checked the panel's drawing.");
  events.insert({ ...click, at: 1002, actor: "firstmate" });
  // Upgrade a saved record from a build without the query index.
  before.exec("DROP INDEX IF EXISTS task_events_actor_at");
  before.close();

  const db = openDatabase(dir);
  try {
    const reopened = new TaskEventStore(db);
    const prepare = vi.spyOn(db, "prepare");
    const found = reopened.listByActorViaSince("captain", "task-card", 1000);
    const sql = prepare.mock.calls.at(-1)?.[0];
    prepare.mockRestore();
    expect(found.map(({ id }) => id)).toEqual([second, first, boundary]);
    expect(reopened.listByActorViaSince("captain", "task-card", 1002)).toEqual([]);
    if (!sql) throw new Error("The captain-click read prepared no statement.");
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1000, "captain", "task-card") as {
        detail: string;
      }[]
    )
      .map(({ detail }) => detail)
      .join("; ");
    expect(plan).toMatch(/SEARCH task_events USING INDEX \S+ \(actor=\? AND at>\?\)/);
    expect(plan).not.toContain("TEMP B-TREE");
  } finally {
    db.close();
  }
});
