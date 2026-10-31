import { expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { type AppDatabase, openDatabase } from "./db";
import { TaskEventStore } from "./taskEventStore";

// INF-2059 (the captain: "every several seconds it freezes for a few
// seconds"): each lookup of the tasks a message attached to walked every
// task event. Exercise the store's own statements on reopened saved data
// and read SQLite's chosen access path, never the source text.
function statementOf(db: AppDatabase, read: () => unknown): string {
  const prepare = vi.spyOn(db, "prepare");
  try {
    read();
    const sql = prepare.mock.calls.at(-1)?.[0];
    if (typeof sql !== "string") throw new Error("The read prepared no statement.");
    return sql;
  } finally {
    prepare.mockRestore();
  }
}

it("seeks a message's and a card's tasks by kind and ref on saved data opened again", () => {
  const dir = scratchDir("infinitary-task-event-refs-");
  const before = openDatabase(dir);
  const tasks = new TaskService({ db: before, now: () => 1000 });
  seedTask(tasks, { id: "panels", title: "Build personal panels", status: "running" });
  seedTask(tasks, { id: "meter", title: "Fix the meter", status: "running" });
  tasks.openAsk({ id: "m1", text: "build the personal panels" });
  tasks.attachAsk("m1", "panels", "tool:spawn_crewmate");
  tasks.attachAsk("m1", "meter", "tool:steer_crewmate");
  tasks.note("panels", "Started the panels.", { news: false });
  // Saved data from a build without the index.
  before.exec("DROP INDEX IF EXISTS task_events_ref");
  before.close();

  const db = openDatabase(dir);
  try {
    const events = new TaskEventStore(db);
    expect(events.taskIdsWithRef("ask", "m1").sort()).toEqual(["meter", "panels"]);
    expect(events.latestTaskForRef("ask", "m1")).toBe("meter");
    const plans = [
      statementOf(db, () => events.taskIdsWithRef("ask", "m1")),
      statementOf(db, () => events.latestTaskForRef("ask", "m1")),
    ].map((sql) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("ask", "m1") as { detail: string }[])
        .map((row) => row.detail)
        .join("; "),
    );
    for (const plan of plans)
      expect(plan).toMatch(/SEARCH task_events USING INDEX task_events_ref \(kind=\? AND ref=\?\)/);
  } finally {
    db.close();
  }
});

// INF-2070: the board names what replaced each dropped row it shows, and
// found a stronger-model move by reading the row's whole timeline. The moves
// are read through the same index, so the read grows with the moves alone.
it("seeks every stronger-model move by kind and ref on saved data opened again", () => {
  const dir = scratchDir("infinitary-task-event-escalations-");
  const before = openDatabase(dir);
  const tasks = new TaskService({ db: before, now: () => 1000 });
  for (const id of ["first", "second", "third"])
    seedTask(tasks, { id, title: `Attempt ${id}`, status: "running" });
  tasks.recordEscalation({
    from: { id: "first", key: "first" },
    to: { id: "second", key: "second" },
    attempt: 1,
    tier: "premium",
  });
  tasks.recordEscalation({
    from: { id: "second", key: "second" },
    to: { id: "third", key: "third" },
    attempt: 2,
    tier: "premium",
  });
  tasks.note("first", "Checked the meter.", { news: false });
  before.exec("DROP INDEX IF EXISTS task_events_ref");
  before.close();

  const db = openDatabase(dir);
  try {
    const events = new TaskEventStore(db);
    expect(events.escalatedTo()).toEqual(
      new Map([
        ["first", "second"],
        ["second", "third"],
      ]),
    );
    const sql = statementOf(db, () => events.escalatedTo());
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("escalated") as { detail: string }[])
      .map((row) => row.detail)
      .join("; ");
    expect(plan).toMatch(/SEARCH task_events USING INDEX task_events_ref \(kind=\? AND ref>\?\)/);
  } finally {
    db.close();
  }
});
