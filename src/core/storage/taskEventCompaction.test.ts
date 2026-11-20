import { expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openDatabase } from "./db";
import { TaskEventStore } from "./taskEventStore";

// INF-2238: a turn-end steer spent 270 ms of main-thread CPU in history
// trimming, sampled in better-sqlite3's rowFactory. It compiles a row
// constructor for each newly prepared statement. Count that repeated work
// at the compaction readers, not elapsed time, and read actual changed rows
// to ensure statement reuse never means reusing an old result or binding.
it("reuses compaction statements while reading fresh history and parameters", () => {
  const db = freshDatabase();
  try {
    const tasks = new TaskService({ db, now: () => 1000 });
    seedTask(tasks, { id: "checks", title: "Check the fix", status: "running" });
    seedTask(tasks, { id: "review", title: "Review the fix", status: "running" });
    const events = new TaskEventStore(db);
    const read = (taskId: string, limit: number, at: number) => ({
      total: events.countFor(taskId),
      ordinary: events.countCompactable(taskId),
      oldest: events.oldestCompactable(taskId, limit),
      upTo: events.compactableUpTo(taskId, at),
    });
    const first = read("checks", 1, 1000);
    expect(first.total).toBeGreaterThan(0);
    expect(first.oldest).toHaveLength(1);

    // A different task and new rows go through the same statements.
    tasks.turns.recordSteer("review", {
      text: "Report when you will check the running job again.",
      actor: "supervisor",
      outcome: "queued-next-turn",
      via: "supervision",
      decision: null,
      cardId: null,
      inboxId: null,
    });
    tasks.note("review", "The job is still running.", {
      news: false,
      data: { journal: true, jobId: "build" },
    });
    tasks.noteProgress("review", "The build passed.");
    const all = events.listFor("review");
    const ordinary = all.filter((event) => event.kind !== "steered" && !event.data?.journal);

    const prepare = vi.spyOn(db, "prepare");
    try {
      const next = read("review", all.length, 1000);
      expect(next).toEqual({
        total: all.length,
        ordinary: ordinary.length,
        oldest: ordinary,
        upTo: ordinary,
      });
      const earlier = read("checks", 1, 999);
      expect(earlier.oldest).toEqual(first.oldest);
      expect(earlier.upTo).toEqual([]);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  } finally {
    db.close();
  }
});

// INF-2238's scaling reproduction: recompilation was not the whole cost.
// Trimming revisited protected payloads on every over-cap write. Exercise
// the installed index on saved data, and ask SQLite for each actual plan.
it("seeks compactable candidates after reopening saved data and keeps every exemption", () => {
  const dir = scratchDir("infinitary-compaction-index-");
  const before = openDatabase(dir);
  const tasks = new TaskService({ db: before, now: () => 1000 });
  seedTask(tasks, { id: "checks", title: "Check the fix", status: "running" });
  seedTask(tasks, { id: "review", title: "Review the fix", status: "running" });
  const stored = new TaskEventStore(before);
  const ordinary = stored.listFor("checks");
  for (const kind of [
    "decided",
    "steered",
    "interrupted",
    "report",
    "card_resolved",
    "briefed",
  ] as const)
    stored.insert({
      taskId: "checks",
      at: 1001,
      actor: "host",
      kind,
      text: `Kept ${kind} evidence`,
    });
  tasks.note("checks", "The check is still running.", {
    news: false,
    data: { journal: true, jobId: "build" },
  });
  const concerned = stored.insert({
    taskId: "checks",
    at: 1001,
    actor: "host",
    kind: "note",
    text: "The review waits for this check.",
  });
  stored.insertConcerns(concerned, [{ taskId: "review", relation: "waiter", via: null }]);
  const retained = stored.listFor("checks");
  before.exec("DROP INDEX task_events_compaction");
  before.close();

  const db = openDatabase(dir);
  try {
    const events = new TaskEventStore(db);
    const reads: { run: () => unknown; args: (string | number)[]; expected: unknown }[] = [
      { run: () => events.countCompactable("checks"), args: ["checks"], expected: ordinary.length },
      {
        run: () => events.oldestCompactable("checks", retained.length),
        args: ["checks", retained.length],
        expected: ordinary,
      },
      {
        run: () => events.compactableUpTo("checks", 1001),
        args: ["checks", 1001],
        expected: ordinary,
      },
    ];
    for (const read of reads) {
      const prepare = vi.spyOn(db, "prepare");
      let sql: string | undefined;
      try {
        expect(read.run()).toEqual(read.expected);
        sql = prepare.mock.calls.at(-1)?.[0];
      } finally {
        prepare.mockRestore();
      }
      expect(sql).toBeDefined();
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...read.args) as {
        detail: string;
      }[];
      expect(
        plan.some((row) =>
          /SEARCH task_events USING INDEX task_events_compaction/.test(row.detail),
        ),
      ).toBe(true);
      expect(plan.some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false);
    }
    expect(events.listFor("checks")).toEqual(retained);
  } finally {
    db.close();
  }
});
