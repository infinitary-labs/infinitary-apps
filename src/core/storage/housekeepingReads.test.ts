import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CardStore } from "./cardStore";
import { HOUSEKEEPING_INDEXES_MIGRATION_VERSION, openDatabase } from "./db";
import { TaskEventStore } from "./taskEventStore";

// INF-1348's accepted pass fix: seek a task's cards and feed-worthy events,
// without decoding unrelated historical bodies. Exercise the migrated file,
// actual store results and SQLite's chosen access paths, not source strings.
it("upgrades existing saved data with card/feed seeks and keeps their results", () => {
  const dir = scratchDir("infinitary-housekeeping-reads-");
  const before = openDatabase(dir, HOUSEKEEPING_INDEXES_MIGRATION_VERSION - 1);
  const tasks = new TaskService({ db: before, now: () => 1000 });
  const task = seedTask(tasks, {
    id: "review",
    title: "Review the release notes",
    status: "queued",
    startPolicy: "on-request",
  });
  tasks.note(task.id, "The release notes are ready for review.", { news: true, feed: true });
  tasks.note(task.id, "Compared the notes with the changes.", { news: false });
  // Today's card writer names INF-1610's later `answering` column, lent to
  // the older schema here; its own migration leaves a column already there.
  before.exec("ALTER TABLE cards ADD COLUMN answering INTEGER");
  new CardStore(before).upsert({
    id: "review-card",
    taskId: task.id,
    author: "crewmate",
    priority: 30,
    title: "Release notes are ready",
    meta: "crewmate",
    body: "<p>The release notes match the changes.</p>",
    actions: [],
    status: "ready",
    createdAt: 1000,
  });
  const expectedCards = new CardStore(before).forTask(task.id);
  const expectedFeed = new TaskEventStore(before).listFeed(20);
  before.close();
  const after = openDatabase(dir);
  try {
    expect(new CardStore(after).forTask(task.id)).toEqual(expectedCards);
    expect(new TaskEventStore(after).listFeed(20)).toEqual(expectedFeed);
    const cardPlan = after
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM cards WHERE task_id = ?")
      .all(task.id);
    expect(cardPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining("USING INDEX cards_task_id") }),
      ]),
    );
    const feedPlan = after
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM task_events WHERE feed = 1 ORDER BY at DESC, id DESC LIMIT 20",
      )
      .all();
    expect(feedPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.stringContaining("USING INDEX task_events_feed"),
        }),
      ]),
    );
  } finally {
    after.close();
  }
});
