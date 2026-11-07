import { afterEach, expect, it } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { AppDatabase } from "./db";
import { TaskEventStore } from "./taskEventStore";

// INF-2971's first finding, which the captain chose to start: the feed read
// grouped every feed-worthy event in the record on each read, about a third
// of the main thread's stalls on a record of 42,738 feed lines. The feed
// keeps its grouped view (a program and its parts share one row, INF-1137)
// and reads only what was written since. The reference below is the
// grouping the feed read made before, run over the whole record.
const WHOLE_HISTORY = `
  WITH grouped AS (
    SELECT e.id, CASE
      WHEN json_type(parent_program.value_json, '$.program') = 'object' THEN t.parent_id
      WHEN json_type(own_program.value_json, '$.program') = 'object' THEN t.id
    END AS program_id, e.at
    FROM task_events e
    JOIN tasks t ON t.id = e.task_id
    LEFT JOIN task_programs parent_program ON parent_program.task_id = t.parent_id
    LEFT JOIN task_programs own_program ON own_program.task_id = t.id
    WHERE e.feed = 1
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY program_id, CASE WHEN program_id IS NULL THEN id ELSE 0 END
      ORDER BY at DESC, id DESC
    ) AS position FROM grouped
  )
  SELECT id FROM ranked WHERE position = 1 ORDER BY at DESC, id DESC LIMIT ?`;

const LIMIT = 4;

let db: AppDatabase | undefined;
afterEach(() => db?.close());

function setup() {
  const open = freshDatabase();
  db = open;
  let now = Date.parse("2026-11-06T16:00:00Z");
  const tasks = new TaskService({ db: open, now: () => (now += 1000) });
  const events = new TaskEventStore(open);
  const program = seedTask(tasks, {
    id: "release",
    title: "Prepare the next release",
    status: "queued",
    startPolicy: "on-request",
    shape: { kind: "research", program: { script: "return null;", bound: 2 } },
  });
  for (const id of ["notes", "pictures"])
    seedTask(tasks, {
      id,
      parentId: program.id,
      title: `Write the ${id}`,
      status: "queued",
      startPolicy: "on-request",
    });
  for (const id of ["home-page", "sign-in", "pricing", "search", "settings"])
    seedTask(tasks, {
      id,
      title: `Review the ${id} page`,
      status: "queued",
      startPolicy: "on-request",
    });
  const report = (id: string, text: string) => tasks.turns.recordReport(id, { text });
  for (const id of ["notes", "home-page", "pictures", "sign-in", "pricing", "search", "settings"])
    report(id, `Started on ${id}.`);
  const fed = () => events.listFeed(LIMIT).map((event) => event.id);
  const whole = () =>
    (open.prepare(WHOLE_HISTORY).all(LIMIT) as { id: number }[]).map((row) => row.id);
  return { db: open, tasks, events, report, fed, whole };
}

it("answers what grouping the whole history answers as the record changes", () => {
  const { tasks, events, report, fed, whole } = setup();
  expect(fed()).toEqual(whole());
  // New lines fold in: an ordinary task's, and a part's, which moves its program's row.
  report("home-page", "The home page review is ready.");
  expect(fed()).toEqual(whole());
  report("pictures", "The pictures are ready.");
  expect(fed()).toEqual(whole());
  // A line written with an earlier time than the newest it shows.
  const earlier = events.insert({
    taskId: "sign-in",
    at: Date.parse("2026-11-06T15:00:00Z"),
    actor: "crewmate",
    kind: "report",
    text: "An earlier report.",
    feed: true,
  });
  expect(fed()).toEqual(whole());
  // A task moved under the program joins the program's row.
  tasks.setParent("search", "release", "firstmate");
  expect(fed()).toEqual(whole());
  // Lines removed, as compaction removes them.
  const shown = fed();
  events.deleteIds([shown[0] as number, earlier]);
  expect(fed()).toEqual(whole());
  // A task whose timeline is erased.
  events.deleteFor("settings");
  expect(fed()).toEqual(whole());
  report("pricing", "The pricing review is ready.");
  expect(fed()).toEqual(whole());
  expect(fed().length).toBe(LIMIT);
});

it("reads only the lines written since the last read", () => {
  const { db, report, fed, whole } = setup();
  fed();
  // With nothing new the read takes no feed row; with two new lines, those two.
  const unchanged = rowsRead(db, fed);
  report("home-page", "The home page review is ready.");
  report("pictures", "The pictures are ready.");
  expect(rowsRead(db, fed)).toBe(unchanged + 2);
  expect(rowsRead(db, fed)).toBe(unchanged);
  expect(fed()).toEqual(whole());
});
