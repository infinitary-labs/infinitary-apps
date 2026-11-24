import { expect, it, vi } from "vitest";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openInMemoryDatabase } from "./db";
import { TaskEventStore } from "./taskEventStore";

// INF-6434: the open-message walk reads each open card's task origin on
// card clicks, first mate turns and task closes. INF-6435 measured the read
// searching task_events by (task_id, at) and testing every row of the task,
// 21,679 rows to return 382 on the captain's record. The read must seek its
// ask and origin-note rows alone, whatever else the task's history holds.
it("seeks a task's ask and origin-note events without reading the rest of its history", () => {
  const db = openInMemoryDatabase();
  let now = 1_000;
  const tasks = new TaskService({ db, now: () => (now += 1) });
  try {
    seedTask(tasks, { id: "fix", title: "Fix the stalls", status: "running" });
    tasks.capture.openAsk({ id: "m1", text: "fix the stalls" });
    tasks.capture.attachAsk("m1", "fix", "tool:spawn_crewmate", true);
    tasks.note("fix", 'Filed while answering the automation "Nightly"', {
      news: false,
      data: { origin: { kind: "automation", ruleId: "nightly", name: "Nightly" } },
    });
    for (let step = 0; step < 200; step += 1)
      tasks.note("fix", `Ran check ${step}.`, { news: false, data: { step } });

    const events = new TaskEventStore(db);
    const prepare = vi.spyOn(db, "prepare");
    let found: ReturnType<TaskEventStore["listOriginEvents"]>;
    let sql: unknown;
    try {
      found = events.listOriginEvents("fix");
      sql = prepare.mock.calls.at(-1)?.[0];
    } finally {
      prepare.mockRestore();
    }
    expect(found.map((event) => [event.kind, event.ref ?? event.text])).toEqual([
      ["ask", "m1"],
      ["note", 'Filed while answering the automation "Nightly"'],
    ]);
    if (typeof sql !== "string") throw new Error("The read prepared no statement.");
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("fix") as { detail: string }[]).map(
      (step) => step.detail,
    );
    console.info(JSON.stringify({ intent: "INF-6434 origin read", events: 202, plan }));
    const originIndexes = (
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_events'",
        )
        .all() as { name: string; sql: string | null }[]
    ).filter((index) => index.sql?.includes("'$.origin'"));
    expect(originIndexes).toHaveLength(1);
    expect(plan).toEqual([`SEARCH task_events USING INDEX ${originIndexes[0]?.name} (task_id=?)`]);
  } finally {
    db.close();
  }
});
