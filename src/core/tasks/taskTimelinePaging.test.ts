import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  createTasksQueryTool,
  parseTasksFieldPage,
  TASK_QUERY_PAGE_CHARACTERS,
  TIMELINE_PAGING_RESTART,
} from "../pi/taskTools";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "./seedTask";
import { queryTasks } from "./taskQuery";
import { TaskService } from "./taskService";
import { TaskTimeline } from "./taskTimeline";

// INF-1296 B: stable source/file cuts must also survive the agent tool's
// transport paging, not only TaskTimeline.read's entry paging.
it("holds an incomplete agent timeline read at its first cut when backdated history arrives", async () => {
  const recorded = JSON.parse(
    readFileSync(
      new URL("../../../tests/fixtures/replay/sep14-real/tables.json", import.meta.url),
      "utf8",
    ),
  ) as { tasks: { outcome: string | null }[] };
  const reports = recorded.tasks.flatMap((row) => (row.outcome ? [row.outcome] : []));
  expect(reports.length).toBeGreaterThan(0);
  const db = openInMemoryDatabase();
  let at = Date.parse("2026-10-20T16:00:00.000Z");
  const tasks = new TaskService({ db, strict: true, now: () => at });
  const task = seedTask(tasks, {
    id: "paged",
    title: "Read the earlier release reports",
    status: "queued",
  });
  const timeline = new TaskTimeline({ tasks });
  // Extend the retained corpus to the transport's actual page boundary;
  // no invented prose or independently pinned character count.
  while (JSON.stringify(timeline.sources(task.id)).length <= TASK_QUERY_PAGE_CHARACTERS)
    for (const text of reports) tasks.turns.recordReport(task.id, { text });
  let reads = 0;
  const tool = createTasksQueryTool((input) => {
    reads++;
    return queryTasks(tasks, input, undefined, undefined, undefined, { timeline });
  });
  const expected = timeline.sources(task.id);
  const first = parseTasksFieldPage((await tool.run({ key: task.key, field: "timeline" })).text);
  expect(first?.nextOffset).not.toBeNull();
  expect(first).toBeDefined();
  at--;
  tasks.note(task.id, "An earlier check's result arrived after the history read began.", {
    news: true,
  });
  let page = first;
  let text = page?.text ?? "";
  while (page?.nextOffset) {
    page = parseTasksFieldPage(
      (await tool.run({ key: task.key, field: "timeline", offset: page.nextOffset })).text,
    );
    expect(page).toBeDefined();
    text += page?.text;
  }
  expect(JSON.parse(text)).toEqual(expected);
  expect(reads).toBe(1);
  const fresh = parseTasksFieldPage((await tool.run({ key: task.key, field: "timeline" })).text);
  expect(reads).toBe(2);
  expect(fresh?.length).toBe(JSON.stringify(timeline.sources(task.id)).length);
  expect(timeline.sources(task.id)).toHaveLength(expected.length + 1);
  db.close();
});

function pagedTask(tasks: TaskService, timeline: TaskTimeline, id: string) {
  const recorded = JSON.parse(
    readFileSync(
      new URL("../../../tests/fixtures/replay/sep14-real/tables.json", import.meta.url),
      "utf8",
    ),
  ) as { tasks: { outcome: string | null }[] };
  const reports = recorded.tasks.flatMap((row) => (row.outcome ? [row.outcome] : []));
  expect(reports.length).toBeGreaterThan(0);
  const task = seedTask(tasks, { id, title: "Read the earlier release reports", status: "queued" });
  while (JSON.stringify(timeline.sources(task.id)).length <= TASK_QUERY_PAGE_CHARACTERS)
    for (const text of reports) tasks.turns.recordReport(task.id, { text });
  return task;
}

it("loads the retained timeline only for the captain-approved explicit field request", () => {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  const timeline = new TaskTimeline({ tasks });
  const task = pagedTask(tasks, timeline, "on-ask");
  const read = vi.spyOn(timeline, "sources");
  const reach = { timeline };
  const ordinary = queryTasks(tasks, { key: task.key }, undefined, undefined, undefined, reach);
  const otherField = queryTasks(
    tasks,
    { key: task.key, field: "reports" },
    undefined,
    undefined,
    undefined,
    reach,
  );
  expect(ordinary.rows[0]).not.toHaveProperty("timeline");
  expect(otherField.rows[0]).not.toHaveProperty("timeline");
  expect(read).not.toHaveBeenCalled();
  const explicit = queryTasks(
    tasks,
    { key: task.key, field: "timeline" },
    undefined,
    undefined,
    undefined,
    reach,
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(explicit.rows[0]?.timeline).toEqual(read.mock.results[0]?.value);
  read.mockRestore();
  db.close();
});

it("shares one captured cut between a mixed-case key and canonical id, then releases it on completion", async () => {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  const timeline = new TaskTimeline({ tasks });
  const task = pagedTask(tasks, timeline, "shared-cut");
  let reads = 0;
  const tool = createTasksQueryTool((input) => {
    reads++;
    return queryTasks(tasks, input, undefined, undefined, undefined, { timeline });
  });
  const expected = timeline.sources(task.id);
  let page = parseTasksFieldPage(
    (await tool.run({ key: task.key.toLowerCase(), field: "timeline" })).text,
  );
  expect(page?.nextOffset).toBeTruthy();
  const offset = page?.nextOffset;
  let text = page?.text ?? "";
  tasks.note(task.id, "Another retained result arrived while the read was open.", { news: true });
  while (page?.nextOffset) {
    page = parseTasksFieldPage(
      (await tool.run({ key: task.id, field: "timeline", offset: page.nextOffset })).text,
    );
    text += page?.text ?? "";
  }
  expect(JSON.parse(text)).toEqual(expected);
  expect(reads).toBe(1);
  expect((await tool.run({ key: task.key, field: "timeline", offset: offset ?? 1 })).text).toBe(
    TIMELINE_PAGING_RESTART,
  );
  expect(reads).toBe(1);
  db.close();
});

it("supersedes the previous incomplete field read rather than retaining every abandoned task", async () => {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  const timeline = new TaskTimeline({ tasks });
  const first = pagedTask(tasks, timeline, "earlier-cut");
  const second = pagedTask(tasks, timeline, "current-cut");
  let reads = 0;
  const tool = createTasksQueryTool((input) => {
    reads++;
    return queryTasks(tasks, input, undefined, undefined, undefined, { timeline });
  });
  const earlier = parseTasksFieldPage((await tool.run({ key: first.key, field: "timeline" })).text);
  expect(earlier?.nextOffset).toBeTruthy();
  const current = parseTasksFieldPage(
    (await tool.run({ key: second.key, field: "timeline" })).text,
  );
  expect(current?.nextOffset).toBeTruthy();
  expect(
    (await tool.run({ key: first.id, field: "timeline", offset: earlier?.nextOffset ?? 1 })).text,
  ).toBe(TIMELINE_PAGING_RESTART);
  expect(reads).toBe(2);
  const next = parseTasksFieldPage(
    (await tool.run({ key: second.id, field: "timeline", offset: current?.nextOffset ?? 1 })).text,
  );
  expect(next).toBeDefined();
  expect(reads).toBe(2);
  db.close();
});
