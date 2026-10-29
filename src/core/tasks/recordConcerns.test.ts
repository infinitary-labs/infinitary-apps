import { taskFactsOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { openInMemoryDatabase } from "../storage/db";
import { ACTIVITY_PLACES } from "./recordActivity";
import { seedTask } from "./seedTask";
import { exportTaskRecords, parseTaskExport } from "./taskExport";
import { TaskProtocol } from "./taskProtocol";
import { carriedOnClose, TaskGraphRefusal, TaskService, TIMELINE_CAP } from "./taskService";

/**
 * Whom an event concerns (FI3-1189's rule 1; docs/task-record.md). Each
 * event is written once, on its own task, and names the other tasks it
 * concerns from the typed links; those tasks' Activity reads it as a row
 * from that task. One case per link: filed from, blocks, parent and child,
 * and replaced by - each written through the one writer and read through
 * the record's own read.
 */

function setup() {
  const db = openInMemoryDatabase();
  let now = 1_000_000;
  const tasks = new TaskService({ db, now: () => (now += 1000), strict: true });
  const protocol = new TaskProtocol({
    tasks,
    repos: { get: () => undefined },
    cards: { listOpen: () => [], snapshot: () => [] },
    broadcastEvent: () => {},
    emit: () => {},
    now: () => now,
    coalesceMs: 0,
  });
  const detail = (id: string): TaskDetail => protocol.detail(id);
  const keyOf = (id: string) => tasks.get(id)?.key ?? id;
  /** The rows another task wrote on this record, by that task's key, in time order. */
  const fromOthers = (id: string) =>
    detail(id).activityLog.flatMap((row) => (row.from ? [[row.from.key, row.text]] : []));
  /** Every line of the record, folded ones included, as [kind, text, from key]. */
  const everyLine = (id: string) =>
    detail(id).activityLog.flatMap((row) => [
      [row.kind, row.text, row.from?.key ?? null],
      ...(row.folded ?? []).map((line) => [line.kind, line.text, line.from?.key ?? null]),
    ]);
  return { db, tasks, protocol, detail, keyOf, fromOthers, everyLine };
}

/** A task the way a crewmate takes it, so its milestones are real. */
function work(tasks: TaskService, id: string, title: string, parentId?: string) {
  tasks.create({
    id,
    title,
    prompt: "p",
    repoId: null,
    actor: "firstmate",
    ...(parentId ? { parentId } : {}),
  });
  tasks.dispatch(id, {
    workspace: { repoDir: "", worktreeDir: `/w/${id}`, branch: `fm/task-${id}` },
    accountId: null,
    assignee: `crewmate ${id}`,
  });
}

function merge(tasks: TaskService, id: string, pr: number) {
  seedDelivery(
    tasks,
    id,
    { prNumber: pr, changeLabel: `#${pr}` },
    { kind: "pr_opened", text: `PR #${pr}` },
  );
  tasks.close(id, { status: "done", reason: "merged", actor: "captain", text: "merged" });
}

describe("whom an event concerns (FI3-1189's rule 1)", () => {
  it("filed from: a follow-up's milestones reach the task it was filed from, and the filing reads on both ends", () => {
    const { tasks, keyOf, fromOthers, everyLine } = setup();
    seedTask(tasks, { id: "origin", title: "Cut the alpha", status: "idle" });
    tasks.fileFollowup({
      id: "hang",
      originId: "origin",
      title: "Journey hangs",
      goal: "It finishes.",
      prompt: "p",
      why: "It hung.",
    });
    tasks.dispatch("hang", {
      workspace: { repoDir: "", worktreeDir: "/w/hang", branch: "fm/task-hang" },
      accountId: null,
      assignee: "crewmate 4",
    });
    merge(tasks, "hang", 12);
    const hang = keyOf("hang");
    expect(fromOthers("origin")).toEqual([
      [hang, `${hang}, filed by this task, started.`],
      [hang, `${hang}, filed by this task, opened pull request #12.`],
      [hang, `${hang}, filed by this task, merged pull request #12.`],
    ]);
    // The follow-up's own record: the filing note says it, and the far end
    // of the link folds under it rather than saying it twice.
    expect(everyLine("hang")).toContainEqual([
      "linked",
      `Filed while working on ${keyOf("origin")}.`,
      keyOf("origin"),
    ]);
    expect(fromOthers("hang")).toEqual([]);
  });

  it("blocks: the blocker reads who waits for it, and the waiting task reads the blocker's milestones", () => {
    const { tasks, keyOf, fromOthers, detail } = setup();
    seedTask(tasks, { id: "waiter", title: "Ship the alpha", status: "idle" });
    work(tasks, "runner", "Bring the Mac runner back");
    tasks.link("runner", "waiter", "blocks", "firstmate");
    tasks.close("runner", { status: "done", reason: "finished", actor: "host" });
    tasks.unlink("runner", "waiter", "blocks", "firstmate");
    const [waiter, runner] = [keyOf("waiter"), keyOf("runner")];
    // The waiting task's own lines, and the blocker's close.
    expect(detail("waiter").activityLog.map((row) => row.text)).toEqual(
      expect.arrayContaining([
        `waits for "Bring the Mac runner back" (${runner})`,
        `${runner}, which this task waits for, finished.`,
        `no longer blocked by "Bring the Mac runner back"`,
      ]),
    );
    // A link reads on both ends.
    expect(fromOthers("runner")).toEqual([
      [waiter, `${waiter} waits for this task.`],
      [waiter, `${waiter} no longer waits for this task.`],
    ]);
  });

  it("parent and child: a part's milestones, why it closed included, reach its parent", () => {
    const { tasks, keyOf, fromOthers } = setup();
    seedTask(tasks, { id: "parent", title: "Cut the alpha", status: "idle" });
    work(tasks, "notes", "Write the notes", "parent");
    tasks.create({
      id: "icons",
      title: "Redraw icons",
      prompt: "p",
      repoId: null,
      parentId: "parent",
    });
    tasks.dropWithChildren("icons", { reason: "the old icons stay", actor: "firstmate" });
    tasks.close("notes", { status: "dropped", reason: "failed", actor: "host", error: "boom" });
    const [notes, icons] = [keyOf("notes"), keyOf("icons")];
    expect(fromOthers("parent")).toEqual([
      [notes, `${notes}, a part of this task, was filed.`],
      [notes, `${notes}, a part of this task, started.`],
      [icons, `${icons}, a part of this task, was filed.`],
      [icons, `${icons}, a part of this task, was dropped: the old icons stay.`],
      [notes, `${notes}, a part of this task, failed.`],
    ]);
  });

  it("replaced by: a drop names its replacement, and the replacement's merge reaches whatever the dropped task concerned", () => {
    const { tasks, keyOf, fromOthers, detail } = setup();
    seedTask(tasks, { id: "origin", title: "Cut the alpha", status: "idle" });
    tasks.fileFollowup({
      id: "hang",
      originId: "origin",
      title: "Journey hangs",
      goal: "It finishes.",
      prompt: "p",
      why: "It hung.",
    });
    work(tasks, "fix", "Stop the hang");
    tasks.dropWithChildren("hang", {
      reason: "the fix is underway as its own task",
      actor: "firstmate",
      replacedBy: "fix",
    });
    merge(tasks, "fix", 977);
    const [hang, fix] = [keyOf("hang"), keyOf("fix")];
    // The first task lists all three: the filing, the close for its
    // replacement, and the replacement's merge. Work another task carries
    // on closes done through it, never dropped (INF-1825).
    const origin = detail("origin").activityLog.map((row) => row.text);
    expect(origin).toContainEqual(`follow-up filed: "Journey hangs" (${hang})`);
    expect(fromOthers("origin")).toEqual([
      [hang, `${hang}, filed by this task, closed: ${fix} carries on its work.`],
      [fix, `${fix}, which replaced ${hang}, opened pull request #977.`],
      [fix, `${fix}, which replaced ${hang}, merged pull request #977.`],
    ]);
    // The link reads on both ends, and the dropped task hears its replacement.
    expect(tasks.linksTo("fix")).toContainEqual(
      expect.objectContaining({ fromId: "hang", toId: "fix", type: "replaced-by" }),
    );
    expect(detail("fix").activityLog.map((row) => row.text)).toContainEqual(
      `replaces "Journey hangs" (${hang})`,
    );
    expect(fromOthers("hang")).toEqual([
      [fix, `${fix} replaces this task.`],
      [fix, `${fix}, which replaced this task, opened pull request #977.`],
      [fix, `${fix}, which replaced this task, merged pull request #977.`],
    ]);
  });

  // INF-1825, the captain's words: "its record reads \"Done through
  // INF-1737\"". The status is Done from the close; the words beside it
  // follow the task carrying the work, so "Done through" is never said
  // before that task is done, and a chain names its last task.
  it("carried on: the record reads where the work stands, through the last task carrying it", () => {
    const { tasks, keyOf, detail } = setup();
    work(tasks, "old", "Fix the notice");
    work(tasks, "next", "Fix the notice in its own pull request");
    tasks.link("old", "next", "replaced-by", "firstmate");
    tasks.close("old", carriedOnClose({ id: "next", key: keyOf("next") }, "firstmate"));
    const [old, next] = [keyOf("old"), keyOf("next")];
    const reads = (id: string) => ({
      status: detail(id).status,
      note: detail(id).closing?.note,
      replacedBy: detail(id).replacedBy,
    });
    expect(reads("old")).toEqual({
      status: "done",
      note: `Carried on by ${next}`,
      replacedBy: next,
    });
    // The task carrying it says whose work it carries on.
    expect(detail("next").activityLog.map((row) => row.text)).toContainEqual(
      `replaces "Fix the notice" (${old})`,
    );

    // The task carrying it was carried on in turn: the last one is named.
    work(tasks, "last", "Finish the notice");
    tasks.link("next", "last", "replaced-by", "firstmate");
    tasks.close("next", carriedOnClose({ id: "last", key: keyOf("last") }, "firstmate"));
    const last = keyOf("last");
    expect(detail("old").closing?.note).toBe(`Carried on by ${last}`);

    merge(tasks, "last", 675);
    expect(detail("old").closing?.note).toBe(`Done through ${last}`);
    expect(detail("next").closing?.note).toBe(`Done through ${last}`);

    // A carrier dropped later is said as it is; the close stays done.
    work(tasks, "lost", "Fix the banner");
    work(tasks, "taker", "Fix the banner elsewhere");
    tasks.link("lost", "taker", "replaced-by", "firstmate");
    tasks.close("lost", carriedOnClose({ id: "taker", key: keyOf("taker") }, "firstmate"));
    tasks.close("taker", { status: "dropped", reason: "cancelled", actor: "firstmate" });
    expect(detail("lost")).toMatchObject({
      status: "done",
      closing: { note: `Carried on by ${keyOf("taker")}, which was dropped` },
    });
  });

  // INF-976: INF-926 built INF-797's answer and merged, and nothing on
  // INF-797's record said so, so the same build was filed again.
  it("basis: the milestones of work built on an answer reach the answer, by key or id", () => {
    const { tasks, keyOf, fromOthers } = setup();
    seedTask(tasks, {
      id: "answer",
      kind: "question",
      title: "Why it sat idle",
      status: "idle",
      outcome: "Use the same task facts everywhere.",
    });
    tasks.create({
      id: "builder",
      title: "Build the plan",
      prompt: "p",
      repoId: null,
      actor: "firstmate",
      shape: { kind: "implement", basis: keyOf("answer") },
    });
    tasks.dispatch("builder", {
      workspace: { repoDir: "", worktreeDir: "/w/builder", branch: "fm/task-builder" },
      accountId: null,
      assignee: "crewmate builder",
    });
    merge(tasks, "builder", 364);
    tasks.create({
      id: "again",
      title: "Build the plan again",
      prompt: "p",
      repoId: null,
      actor: "firstmate",
      shape: { kind: "implement", basis: "answer" },
    });
    tasks.close("again", { status: "dropped", reason: "cancelled", actor: "firstmate" });
    const [builder, again] = [keyOf("builder"), keyOf("again")];
    expect(fromOthers("answer")).toEqual([
      [builder, `${builder}, built on this task, was filed.`],
      [builder, `${builder}, built on this task, started.`],
      [builder, `${builder}, built on this task, opened pull request #364.`],
      [builder, `${builder}, built on this task, merged pull request #364.`],
      [again, `${again}, built on this task, was filed.`],
      [again, `${again}, built on this task, was dropped.`],
    ]);
  });

  it("refuses a replacement that is the task itself, under it, or dropped, writing nothing", () => {
    const { tasks } = setup();
    seedTask(tasks, { id: "a", title: "A", status: "queued" });
    tasks.create({ id: "a-part", title: "A part", prompt: "p", repoId: null, parentId: "a" });
    seedTask(tasks, { id: "gone", title: "Gone", status: "cancelled" });
    const before = tasks.timeline("a").length;
    for (const replacedBy of ["a", "a-part", "gone"]) {
      expect(() =>
        tasks.dropWithChildren("a", { reason: "r", actor: "firstmate", replacedBy }),
      ).toThrow(TaskGraphRefusal);
    }
    expect(tasks.get("a")?.status).toBe("open");
    expect(tasks.timeline("a")).toHaveLength(before);
    expect(tasks.allLinks().filter((link) => link.type === "replaced-by")).toEqual([]);
  });

  it("a refused merge reads on the tasks it names, by the link that joins them", () => {
    const { tasks, keyOf, fromOthers } = setup();
    seedTask(tasks, { id: "waiter", title: "Ship", status: "idle" });
    seedTask(tasks, { id: "runner", title: "Runner", status: "idle" });
    seedTask(tasks, { id: "stranger", title: "Unlinked", status: "idle" });
    tasks.link("runner", "waiter", "blocks", "firstmate");
    tasks.note("waiter", "Cannot merge: it waits on Runner.", {
      news: true,
      data: { refused: "merge-pr" },
      about: ["runner", "stranger"],
    });
    const waiter = keyOf("waiter");
    expect(fromOthers("runner")).toContainEqual([
      waiter,
      `${waiter}, which waits for this task, could not merge.`,
    ]);
    // Only typed links say whom it concerns: no link, no row.
    expect(fromOthers("stranger")).toEqual([]);
  });

  it("writes each event once, leaves nothing out of the record that reads it, and keeps Now the task's own", () => {
    const { db, tasks, detail } = setup();
    seedTask(tasks, { id: "parent", title: "Parent", status: "idle" });
    work(tasks, "child", "Child", "parent");
    merge(tasks, "child", 5);
    // Written once: on the child's timeline, named on the parent's.
    const rows = db.prepare("SELECT task_id FROM task_events WHERE kind = 'merged'").all();
    expect(rows).toEqual([{ task_id: "child" }]);
    const read = detail("parent");
    const ids = read.activityLog.flatMap((row) => [
      row.id,
      ...(row.folded ?? []).map((line) => line.id),
    ]);
    const concerned = tasks.concerning("parent").map((event) => event.id);
    const own = read.events
      .filter((event) => ACTIVITY_PLACES[event.kind] !== "evidence")
      .map((event) => event.id);
    expect([...ids].sort((a, b) => a - b)).toEqual([...own, ...concerned].sort((a, b) => a - b));
    // The newest line is the child's merge; Now is still the parent's own.
    expect(read.activityLog.at(-1)?.from?.id).toBe("child");
    const now = taskFactsOf({ ...read, activityLog: read.activityLog }, (model) => model).now;
    expect(now?.text).toBe(read.activityLog.findLast((row) => !row.from)?.text);
  });

  it("keeps an event another task reads through its own timeline's compaction", () => {
    const { tasks, keyOf, fromOthers } = setup();
    seedTask(tasks, { id: "parent", title: "Parent", status: "idle" });
    work(tasks, "child", "Child", "parent");
    for (let i = 0; i < TIMELINE_CAP + 20; i += 1) tasks.noteProgress("child", `step ${i}`);
    const child = keyOf("child");
    expect(tasks.timeline("child").some((event) => event.kind === "compacted")).toBe(true);
    expect(fromOthers("parent")).toEqual([
      [child, `${child}, a part of this task, was filed.`],
      [child, `${child}, a part of this task, started.`],
    ]);
  });

  it("carries whom each event concerns through the task export and back", () => {
    const source = setup();
    seedTask(source.tasks, { id: "origin", title: "Origin", status: "idle" });
    work(source.tasks, "part", "Part", "origin");
    merge(source.tasks, "part", 8);
    const lines = exportTaskRecords(source.tasks, 5_000);
    const target = setup();
    target.tasks.importRecords(parseTaskExport(lines));
    expect(target.fromOthers("origin")).toEqual(source.fromOthers("origin"));
    expect(exportTaskRecords(target.tasks, 5_000)).toEqual(lines);
  });
});
