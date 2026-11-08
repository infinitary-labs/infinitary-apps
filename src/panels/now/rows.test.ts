import type { PanelProject, PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import { describe, expect, it } from "vitest";
import { RECORD_NEXT_LABELS } from "../../shared/recordBar";
import { taskMovesOf } from "../../shared/taskMoves";
import {
  earlierRowsOf,
  hasSingleRegisteredRepoProject,
  newestListedWrite,
  newFilingCount,
  onRail,
  projectChipsOf,
  projectNameOf,
  rowStartOf,
  rowsOf,
  rowTrailing,
  summaryOf,
  trailingOf,
  wordOf,
} from "./rows";

/**
 * What the Tasks panel lists and how each row reads (./rows.ts), driven
 * through the functions the panel renders from, on the board a panel
 * reads. The panel's DOM - the key before the title, the project name at
 * the right, the open row - is read off the real frame by
 * tests/e2e/now-panel.spec.ts.
 */

function task(overrides: Partial<PanelTaskRow> = {}): PanelTaskRow {
  return {
    id: "t1",
    key: "FI3-12",
    projectId: "proj-r1",
    parentId: null,
    kind: "work",
    title: "Ship the row chrome",
    goal: null,
    priority: 2,
    status: "active",
    activity: "idle",
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: true },
    blockedBy: [],
    children: { total: 0, closed: 0 },
    assignee: null,
    model: null,
    repo: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 0,
    updatedAt: 1,
    startedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<PanelProject> = {}): PanelProject {
  return {
    id: "proj-r1",
    key: "FI3",
    name: "firstmate-3000",
    repo: { name: "firstmate-3000" },
    archived: false,
    counts: { needsYou: 0, waitingOnYou: 0, open: 0, active: 1, doneRecent: 0 },
    ...overrides,
  };
}

function board(overrides: Partial<PanelTaskBoard> = {}): PanelTaskBoard {
  return { seq: 1, at: 1, projects: [project()], tasks: [task()], ...overrides };
}

const scratch = project({
  id: "scratch",
  key: "SCR",
  name: "Scratch",
  repo: null,
  counts: { needsYou: 0, waitingOnYou: 0, open: 0, active: 1, doneRecent: 0 },
});

const noFilter = { query: "", projectId: null };

describe("the Tasks panel's rows", () => {
  it("counts one registered, non-archived repo project from the full board", () => {
    expect(hasSingleRegisteredRepoProject(board())).toBe(true);
    expect(hasSingleRegisteredRepoProject(board({ projects: [project(), scratch] }))).toBe(true);
    expect(
      hasSingleRegisteredRepoProject(
        board({ projects: [project(), project({ id: "proj-r2", archived: true })] }),
      ),
    ).toBe(true);
    expect(
      hasSingleRegisteredRepoProject(board({ projects: [project(), project({ id: "proj-r2" })] })),
    ).toBe(false);
    expect(hasSingleRegisteredRepoProject(board({ projects: [scratch] }))).toBe(false);
  });

  it("keeps a parent tree together under working when any child is working", () => {
    const parent = task({ id: "parent", key: "FI3-20", status: "open", activity: null });
    const child = task({
      id: "child",
      key: "FI3-21",
      parentId: "parent",
      status: "active",
      activity: "running",
    });
    const sibling = task({
      id: "sibling",
      key: "FI3-22",
      parentId: "parent",
      status: "open",
      activity: null,
    });
    const rows = rowsOf(board({ tasks: [parent, child, sibling] }), noFilter);
    expect([...rows.keys()]).toEqual(["working"]);
    expect(rows.get("working")?.map((row) => [row.task.key, row.depth])).toEqual([
      ["FI3-20", 0],
      ["FI3-21", 1],
      ["FI3-22", 1],
    ]);
  });

  it("sorts by priority then age, and lists done work newest first", () => {
    const rows = rowsOf(
      board({
        tasks: [
          task({ id: "a", key: "FI3-1", priority: 2, createdAt: 5 }),
          task({ id: "b", key: "FI3-2", priority: 1, createdAt: 9 }),
          task({ id: "c", key: "FI3-3", priority: 2, createdAt: 1 }),
          task({ id: "d", key: "FI3-4", status: "done", activity: null, closedAt: 10 }),
          task({ id: "e", key: "FI3-5", status: "done", activity: null, closedAt: 20 }),
          // Closed chit-chat never lists.
          task({ id: "f", key: "FI3-6", kind: "question", status: "done", activity: null }),
        ],
      }),
      noFilter,
    );
    expect(rows.get("working")?.map((row) => row.task.key)).toEqual(["FI3-2", "FI3-3", "FI3-1"]);
    expect(rows.get("landed")?.map((row) => row.task.key)).toEqual(["FI3-5", "FI3-4"]);
    expect([...rows.keys()].sort()).toEqual(["landed", "working"]);
  });

  it("splits open work into queued and backlog by its start policy, blocked or held included", () => {
    const open = { status: "open" as const, activity: null };
    const rows = rowsOf(
      board({
        tasks: [
          task({ ...open, id: "q", key: "FI3-30" }),
          task({ ...open, id: "qb", key: "FI3-31", flags: { ...task().flags, blocked: true } }),
          task({ ...open, id: "qh", key: "FI3-32", flags: { ...task().flags, held: true } }),
          task({ ...open, id: "b", key: "FI3-33", startPolicy: "on-request" }),
          task({
            ...open,
            id: "bb",
            key: "FI3-34",
            startPolicy: "on-request",
            flags: { ...task().flags, blocked: true },
          }),
        ],
      }),
      noFilter,
    );
    expect(rows.get("queued")?.map((row) => row.task.key)).toEqual(["FI3-30", "FI3-31", "FI3-32"]);
    expect(rows.get("backlog")?.map((row) => row.task.key)).toEqual(["FI3-33", "FI3-34"]);
  });

  it("filters by key or title and by project, and offers chips only for two projects with rows", () => {
    const current = board({
      projects: [project(), scratch],
      tasks: [task(), task({ id: "t2", key: "SCR-4", projectId: "scratch", title: "A note" })],
    });
    const keys = (filter: { query: string; projectId: string | null }) =>
      [...rowsOf(current, filter).values()].flat().map((row) => row.task.key);
    expect(keys(noFilter)).toEqual(["FI3-12", "SCR-4"]);
    expect(keys({ query: "scr-", projectId: null })).toEqual(["SCR-4"]);
    expect(keys({ query: "row chrome", projectId: null })).toEqual(["FI3-12"]);
    expect(keys({ query: "", projectId: "scratch" })).toEqual(["SCR-4"]);
    expect(projectChipsOf(current)).toEqual([
      { id: null, key: "all" },
      { id: "proj-r1", key: "FI3" },
      { id: "scratch", key: "SCR" },
    ]);
    expect(projectChipsOf(board({ projects: [project(), scratch] }))).toEqual([]);
  });

  it("finds a title with a curly apostrophe or quote from the plain one typed (FI3-930)", () => {
    const current = board({
      projects: [project()],
      tasks: [
        task({ title: "Keep the captain’s “Later” group" }),
        task({ id: "t2", key: "FI3-13", title: "Don't rename it" }),
      ],
    });
    const keys = (query: string) =>
      [...rowsOf(current, { query, projectId: null }).values()].flat().map((row) => row.task.key);
    expect(keys("captain's")).toEqual(["FI3-12"]);
    expect(keys('"later"')).toEqual(["FI3-12"]);
    expect(keys("don’t")).toEqual(["FI3-13"]);
  });

  it("reads the trailing chrome as the project's name, never the task key", () => {
    const current = board({ projects: [project(), scratch] });
    expect(projectNameOf(current, task())).toBe("firstmate-3000");
    expect(projectNameOf(current, task({ projectId: "scratch" }))).toBe("Scratch");
    expect(projectNameOf(current, task({ projectId: "gone" }))).toBe("");
  });

  it("carries one dim word for an open row", () => {
    const open = { status: "open" as const, activity: null };
    expect(wordOf(task({ ...open, flags: { ...task().flags, blocked: true } }))).toBe("blocked");
    expect(wordOf(task({ ...open, flags: { ...task().flags, held: true } }))).toBe("held");
    expect(wordOf(task({ flags: { ...task().flags, blocked: true } }))).toBe("");
    // INF-676: the row shows no reason, so the checks watch carries its own word.
    const active = { status: "active" as const, activity: "idle" as const };
    expect(
      wordOf(
        task({
          ...active,
          workPosture: { state: "active", reason: "checks" },
        } as Partial<PanelTaskRow>),
      ),
    ).toBe("checks");
    expect(
      wordOf(
        task({
          ...active,
          workPosture: { state: "active", reason: "turn" },
        } as Partial<PanelTaskRow>),
      ),
    ).toBe("");
    // INF-38: a started crewmate idle on the tasks it waits on says so.
    expect(
      wordOf(
        task({
          ...active,
          blockedBy: ["FI3-12"],
          workPosture: { state: "idle", reason: "dependency" },
        } as Partial<PanelTaskRow>),
      ),
    ).toBe("waiting");
    const filed = task({
      ...open,
      foundOn: "FI3-12",
      filingNew: true,
    });
    expect(wordOf(filed)).toBe("found on FI3-12");
    expect(
      wordOf(task({ ...open, foundOn: "FI3-12", flags: { ...task().flags, blocked: true } })),
    ).toBe("blocked");
    expect(newFilingCount([{ task: filed, group: "backlog", depth: 0 }])).toBe(1);
    expect(
      newFilingCount([
        {
          task: task({ ...open, foundOn: "FI3-12", filingNew: false }),
          group: "backlog",
          depth: 0,
        },
      ]),
    ).toBe(0);
  });

  it("measures the lag from the newest listed write only", () => {
    expect(
      newestListedWrite(
        board({
          tasks: [
            task({ updatedAt: 5 }),
            task({ id: "q", kind: "question", status: "done", activity: null, updatedAt: 99 }),
          ],
        }),
      ),
    ).toBe(5);
  });
});

describe("the earlier group (FI3-579 piece 3)", () => {
  const old = task({
    id: "old",
    key: "FI3-81",
    status: "done",
    closedAt: 5,
    title: "Idle cleanup",
  });
  const dropped = task({
    id: "dropped",
    key: "FI3-80",
    status: "dropped",
    closedAt: 9,
    projectId: "proj-r2",
  });
  const listed = rowsOf(board({ tasks: [task({ id: "live", status: "active" })] }), noFilter);

  it("lists nothing without typed text, whatever the core found", () => {
    expect(earlierRowsOf([old, dropped], listed, noFilter)).toEqual([]);
    expect(earlierRowsOf([old, dropped], listed, { query: "  ", projectId: null })).toEqual([]);
  });

  it("lists what was found, newest closed first, under the earlier group", () => {
    const rows = earlierRowsOf([old, dropped], listed, { query: "fi3", projectId: null });
    expect(rows.map((row) => [row.task.id, row.group, row.depth])).toEqual([
      ["dropped", "earlier", 0],
      ["old", "earlier", 0],
    ]);
  });

  it("skips rows the panel already lists and honours the project chip", () => {
    const withOld = rowsOf(board({ tasks: [{ ...old, closedAt: Date.now() }] }), noFilter);
    expect(withOld.get("landed")?.map((row) => row.task.id)).toEqual(["old"]);
    expect(earlierRowsOf([old, dropped], withOld, { query: "x", projectId: null })).toHaveLength(1);
    expect(
      earlierRowsOf([old, dropped], listed, { query: "x", projectId: "proj-r2" }).map(
        (row) => row.task.id,
      ),
    ).toEqual(["dropped"]);
  });
});

describe("what the collapsed panel says it holds", () => {
  it("is on its rail once the board holds an ask's record or a row it lists", () => {
    expect(onRail(board({ tasks: [] }))).toBe(false);
    // The trail of an app change alone, closed, docks nothing.
    expect(onRail(board({ tasks: [task({ kind: "operation", status: "done" })] }))).toBe(false);
    // An answered ask's record - the welcome's on a new profile - docks it, though no row lists it.
    expect(onRail(board({ tasks: [task({ kind: "question", status: "done" })] }))).toBe(true);
    expect(onRail(board({ tasks: [task({ status: "dropped", activity: null })] }))).toBe(true);
    expect(onRail(board())).toBe(true);
  });

  it("says how many wait and how many work, the waiting part strong while any do", () => {
    expect(summaryOf(board({ tasks: [] }))).toEqual([{ text: "0 waiting" }, { text: "0 working" }]);
    expect(
      summaryOf(
        board({
          tasks: [
            task({ id: "a", waitingCardId: "card-a" }),
            task({ id: "b", status: "open", activity: null, waitingCardId: "card-b" }),
            task({ id: "c" }),
          ],
        }),
      ),
    ).toEqual([{ text: "2 waiting", strong: true }, { text: "1 working" }]);
  });

  it("counts working by each task's own state, not the tree the Working group shows (FI3-1049)", () => {
    const parent = task({ id: "p", key: "FI3-20", status: "open", activity: null });
    const child = task({ id: "c", key: "FI3-21", parentId: "p", activity: "running" });
    const sibling = task({ id: "s", key: "FI3-22", parentId: "p", status: "open", activity: null });
    const done = task({ id: "d", key: "FI3-23", parentId: "p", status: "done", activity: null });
    const current = board({ tasks: [parent, child, sibling, done] });
    // The Working group shows the live tree beside its working child...
    expect(
      rowsOf(current, noFilter)
        .get("working")
        ?.map((row) => row.task.key),
    ).toEqual(["FI3-20", "FI3-21", "FI3-22"]);
    // ...and the summary counts only the one task that is working.
    expect(summaryOf(current)).toEqual([{ text: "0 waiting" }, { text: "1 working" }]);
  });

  it("counts own states across nested trees, waiting relatives and several workers", () => {
    const tasks = [
      task({ id: "root", status: "open", activity: null, startPolicy: "on-request" }),
      task({ id: "middle", parentId: "root", status: "open", activity: null }),
      task({ id: "leaf", parentId: "middle" }),
      task({ id: "done", parentId: "middle", status: "done", activity: null }),
      task({ id: "waits", parentId: "root", waitingCardId: "card-w" }),
      task({ id: "dropped", parentId: "root", status: "dropped", activity: null }),
    ];
    expect(summaryOf(board({ tasks }))).toEqual([
      { text: "1 waiting", strong: true },
      { text: "1 working" },
    ]);
    tasks.push(task({ id: "worker2", parentId: "root", activity: "running" }));
    expect(summaryOf(board({ tasks }))).toEqual([
      { text: "1 waiting", strong: true },
      { text: "2 working" },
    ]);
  });

  it("counts only the focused project's tasks while the window is focused on one (INF-1091)", () => {
    const current = board({
      projects: [project(), scratch],
      tasks: [
        task({ id: "a", waitingCardId: "card-a" }),
        task({ id: "b" }),
        task({ id: "c", projectId: "scratch", waitingCardId: "card-c" }),
        task({ id: "d", projectId: "scratch" }),
        task({ id: "e", projectId: "scratch" }),
      ],
    });
    expect(summaryOf(current, "scratch")).toEqual([
      { text: "1 waiting", strong: true },
      { text: "2 working" },
    ]);
    expect(summaryOf(current, null)).toEqual([
      { text: "2 waiting", strong: true },
      { text: "3 working" },
    ]);
  });
});

describe("what a row says after its title about its computer", () => {
  it("says connecting while its computer's connection is being made, out of reach otherwise", () => {
    const place = { name: "Mac mini", where: "on Mac mini" };
    const reach = (task: PanelTaskRow) => trailingOf(board(), task, true);
    expect(reach(task({ place: { ...place, reach: "out-of-reach" } }))).toMatchObject({
      outOfReach: true,
      connecting: false,
      reach: "out of reach",
    });
    expect(reach(task({ place: { ...place, reach: "connecting" } }))).toMatchObject({
      outOfReach: true,
      connecting: true,
      reach: "connecting",
    });
    expect(reach(task({ place }))).toMatchObject({ outOfReach: false, connecting: false });
  });

  // INF-1810 finding 7: connected and catching up is not out of reach.
  it("says catching up, in the quiet color, while its connected computer is catching up", () => {
    const place = { name: "Mac mini", where: "on Mac mini", reach: "in-reach" as const };
    const catching = rowTrailing(task({ place: { ...place, catchingUpSince: 1_000 } }), "");
    expect(catching).toEqual({
      name: "",
      place: "on Mac mini",
      outOfReach: true,
      connecting: false,
      catchingUp: true,
      reach: "catching up",
    });
    // Caught up: the row says only where it runs.
    const caught = rowTrailing(task({ place }), "");
    expect(caught).toMatchObject({ outOfReach: false });
    expect(caught).not.toHaveProperty("catchingUp");
  });
});

describe("a backlog row's Start (INF-1663)", () => {
  // Backlog work as the board lists it, with the moves the host derives from
  // the record's own rule, as `tasks.board` carries them.
  const backlog = (
    overrides: Partial<PanelTaskRow> & { startNotice?: { reason: string } } = {},
  ) => {
    const row = task({ status: "open", activity: null, startPolicy: "on-request", ...overrides });
    return { ...row, moves: taskMovesOf(row) } as PanelTaskRow;
  };

  it("starts what the record's Start would, in the record's words", () => {
    expect(rowStartOf(backlog())).toEqual({ label: RECORD_NEXT_LABELS.start, reason: null });
    // Held work on request still starts from its record.
    expect(
      rowStartOf(backlog({ flags: { blocked: false, held: true, needsYou: false, ready: false } })),
    ).toEqual({ label: RECORD_NEXT_LABELS.start, reason: null });
  });

  it("reads Try again on a row whose start failed", () => {
    expect(rowStartOf(backlog({ startNotice: { reason: "no working copy" } }))).toEqual({
      label: RECORD_NEXT_LABELS["try-again"],
      reason: null,
    });
  });

  it("says why it cannot start: what it waits on, or its parts", () => {
    const blocked = backlog({
      blockedBy: ["FI3-3"],
      flags: { blocked: true, held: false, needsYou: false, ready: false },
    });
    expect(rowStartOf(blocked)).toEqual({
      label: RECORD_NEXT_LABELS.start,
      reason: blocked.moves?.["start-task"].ok === false ? blocked.moves["start-task"].text : "",
    });
    expect(rowStartOf(blocked)?.reason).toContain("FI3-3");
    const parent = backlog({ children: { total: 2, closed: 0 } });
    expect(rowStartOf(parent)?.reason).toBeTruthy();
  });

  it("offers nothing on a row with no moves", () => {
    expect(rowStartOf(task({ kind: "decision", status: "open" }))).toBeNull();
  });
});
