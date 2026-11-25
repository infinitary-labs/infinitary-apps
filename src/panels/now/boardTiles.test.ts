import type { PanelProject, PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import { BOARD_RECENT_MS } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import {
  type BoardLane,
  type BoardTile,
  boardChipsOf,
  boardCountOf,
  boardEarlierOf,
  boardLaneOf,
  boardNavMove,
  boardPageOf,
  boardTagChipsOf,
  boardTagRowsOf,
  boardTilesOf,
  clampPage,
  EARLIER_SEARCH_LIMIT,
  newInBacklog,
  type TilePoint,
  tileWordOf,
} from "./boardTiles";

/**
 * What the task board lists, where, and how its arrows move
 * (./boardTiles.ts), driven through the functions the board paints
 * from. The board's DOM and its keys in the window are read off the real
 * app by tests/e2e/task-board.spec.ts.
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
    status: "open",
    activity: null,
    closedReason: null,
    startPolicy: "on-request",
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

function board(tasks: PanelTaskRow[], projects: PanelProject[] = [project()]): PanelTaskBoard {
  return { seq: 1, at: 1, projects, tasks };
}

const noFilter = { query: "", projectId: null };
const DAY = 24 * 60 * 60 * 1000;
const WEEK = BOARD_RECENT_MS;
const keys = (tiles: Map<BoardLane, BoardTile[]>, lane: BoardLane) =>
  (tiles.get(lane) ?? []).map((tile) => tile.task.key);

describe("the task board's lanes", () => {
  it("places each task once under its own state, in the panel's names", () => {
    const tasks = [
      task({ id: "b", key: "FI3-1", startPolicy: "on-request" }),
      task({ id: "q", key: "FI3-2", startPolicy: "when-ready" }),
      task({ id: "w", key: "FI3-3", status: "active", activity: "running" }),
      task({ id: "i", key: "FI3-4", status: "active", activity: "interrupted" }),
      task({ id: "y", key: "FI3-5", status: "active", activity: "idle", captainWait: true }),
      task({ id: "c", key: "FI3-6", status: "open", waitingCardId: "card-1" }),
      task({ id: "d", key: "FI3-7", status: "done", closedAt: 5 }),
      task({ id: "x", key: "FI3-8", status: "dropped", closedAt: 6 }),
      // An answered question and a dropped operation stay off the board.
      task({ id: "a", key: "FI3-9", kind: "question", status: "done", closedAt: 7 }),
      task({ id: "o", key: "FI3-10", kind: "operation", status: "dropped", closedAt: 8 }),
    ];
    const tiles = boardTilesOf(board(tasks), noFilter);
    expect(keys(tiles, "waiting")).toEqual(["FI3-6"]);
    expect(keys(tiles, "backlog")).toEqual(["FI3-1"]);
    expect(keys(tiles, "queued")).toEqual(["FI3-2"]);
    expect(keys(tiles, "working")).toEqual(["FI3-3", "FI3-4", "FI3-5"]);
    expect(keys(tiles, "landed")).toEqual(["FI3-7"]);
    expect(keys(tiles, "dropped")).toEqual(["FI3-8"]);
    expect(boardLaneOf(tasks[8] as PanelTaskRow, 1)).toBeNull();
    expect(boardLaneOf(tasks[9] as PanelTaskRow, 1)).toBeNull();
    // The count is Waiting on you and the four lanes of work; Dropped is aside.
    expect(boardCountOf(tiles)).toBe(7);
  });

  // INF-3127, the approved plan's rule that a pinned task lists in Pinned
  // and nowhere else: pinned work closed before the week is on the board
  // only for Tasks' Pinned, so no 7d list or the chips count it.
  it("keeps pinned work closed before the week out of Done · 7d and Dropped · 7d", () => {
    const at = 4 * WEEK;
    const tasks = [
      task({
        id: "old",
        key: "FI3-1",
        status: "done",
        closedAt: at - WEEK - DAY,
        pinnedAt: at - DAY,
      }),
      task({
        id: "gone",
        key: "FI3-2",
        status: "dropped",
        closedAt: at - WEEK - DAY,
        pinnedAt: at - DAY,
      }),
      task({ id: "new", key: "FI3-3", status: "done", closedAt: at - DAY, pinnedAt: at - DAY }),
    ];
    const read = { ...board(tasks), at };
    const tiles = boardTilesOf(read, noFilter);
    expect(keys(tiles, "landed")).toEqual(["FI3-3"]);
    expect(keys(tiles, "dropped")).toEqual([]);
    expect(boardLaneOf(tasks[0] as PanelTaskRow, at)).toBeNull();
  });

  it("folds only program parts across lanes, while Find reaches a part (INF-1137 friction 8)", () => {
    const program = task({
      id: "program",
      key: "FI3-1",
      program: true,
      children: { total: 3, closed: 1 },
    });
    const parts = [
      task({ id: "part-1", key: "FI3-2", parentId: program.id }),
      task({
        id: "part-2",
        key: "FI3-3",
        parentId: program.id,
        status: "active",
        activity: "running",
      }),
      task({ id: "part-3", key: "FI3-4", parentId: program.id, status: "done" }),
    ];
    const ordinary = task({ id: "ordinary", key: "FI3-5" });
    const child = task({ id: "child", key: "FI3-6", parentId: ordinary.id });
    const reading = board([program, ...parts, ordinary, child]);
    const tiles = boardTilesOf(reading, noFilter);
    expect(keys(tiles, "backlog")).toEqual([program.key, ordinary.key, child.key]);
    expect(keys(tiles, "working")).toEqual([]);
    expect(keys(tiles, "landed")).toEqual([]);
    expect(tiles.get("backlog")?.[0]?.task.children).toEqual({ total: 3, closed: 1 });
    expect(keys(boardTilesOf(reading, { ...noFilter, query: "FI3-3" }), "working")).toEqual([
      "FI3-3",
    ]);
    expect(keys(boardTilesOf(board(parts), noFilter), "working")).toEqual(["FI3-3"]);
  });

  it("keeps blocked and held work in its start policy's column", () => {
    const tiles = boardTilesOf(
      board([
        task({
          id: "b",
          key: "FI3-1",
          startPolicy: "when-ready",
          flags: { ...task().flags, blocked: true },
        }),
        task({
          id: "h",
          key: "FI3-2",
          startPolicy: "on-request",
          flags: { ...task().flags, held: true },
        }),
      ]),
      noFilter,
    );
    expect(keys(tiles, "queued")).toEqual(["FI3-1"]);
    expect(keys(tiles, "backlog")).toEqual(["FI3-2"]);
  });

  it("sorts by priority then oldest, and Done and Dropped newest first", () => {
    const tiles = boardTilesOf(
      board([
        task({ id: "a", key: "FI3-1", priority: 2, createdAt: 1 }),
        task({ id: "b", key: "FI3-2", priority: 0, createdAt: 3 }),
        task({ id: "c", key: "FI3-3", priority: 2, createdAt: 0 }),
        task({ id: "d", key: "FI3-4", status: "done", closedAt: 1 }),
        task({ id: "e", key: "FI3-5", status: "done", closedAt: 9 }),
        task({ id: "f", key: "FI3-6", status: "dropped", closedAt: 2 }),
        task({ id: "g", key: "FI3-7", status: "dropped", closedAt: 4 }),
      ]),
      noFilter,
    );
    expect(keys(tiles, "backlog")).toEqual(["FI3-2", "FI3-3", "FI3-1"]);
    expect(keys(tiles, "landed")).toEqual(["FI3-5", "FI3-4"]);
    expect(keys(tiles, "dropped")).toEqual(["FI3-7", "FI3-6"]);
  });

  it("nests a child under its parent in the same column, else it stands alone as part of it", () => {
    const tiles = boardTilesOf(
      board([
        task({ id: "p", key: "WEB-7", children: { total: 2, closed: 0 } }),
        task({ id: "c1", key: "WEB-8", parentId: "p" }),
        task({ id: "c2", key: "WEB-9", parentId: "p", status: "active", activity: "running" }),
      ]),
      noFilter,
    );
    expect(
      (tiles.get("backlog") ?? []).map((tile) => [tile.task.key, tile.depth, tile.word]),
    ).toEqual([
      ["WEB-7", 0, ""],
      ["WEB-8", 1, ""],
    ]);
    expect(
      (tiles.get("working") ?? []).map((tile) => [tile.task.key, tile.depth, tile.word]),
    ).toEqual([["WEB-9", 0, "part of WEB-7"]]);
  });

  it("filters by Find on the key or title and by the project chip", () => {
    const tasks = [
      task({ id: "a", key: "FI3-1", title: "Search task history" }),
      task({ id: "b", key: "WEB-2", title: "Refresh the website", projectId: "proj-web" }),
    ];
    expect(
      keys(boardTilesOf(board(tasks), { query: "history", projectId: null }), "backlog"),
    ).toEqual(["FI3-1"]);
    expect(
      keys(boardTilesOf(board(tasks), { query: "web-2", projectId: null }), "backlog"),
    ).toEqual(["WEB-2"]);
    expect(
      keys(boardTilesOf(board(tasks), { query: "", projectId: "proj-web" }), "backlog"),
    ).toEqual(["WEB-2"]);
  });

  it("finds a title with a curly apostrophe or quote from the plain one typed (FI3-930)", () => {
    const tasks = [
      task({ id: "a", key: "FI3-1", title: "Keep the captain’s “Later” group" }),
      task({ id: "b", key: "FI3-2", title: "Don't rename it" }),
    ];
    const found = (query: string) =>
      keys(boardTilesOf(board(tasks), { query, projectId: null }), "backlog");
    expect(found("captain's")).toEqual(["FI3-1"]);
    expect(found('"later"')).toEqual(["FI3-1"]);
    expect(found("don’t")).toEqual(["FI3-2"]);
  });

  it("counts crew filings in the backlog the captain has not opened", () => {
    const tiles = boardTilesOf(
      board([
        task({ id: "a", key: "FI3-1", foundOn: "FI3-9", filingNew: true }),
        task({ id: "b", key: "FI3-2", foundOn: "FI3-9", filingNew: false }),
        task({
          id: "c",
          key: "FI3-3",
          startPolicy: "when-ready",
          foundOn: "FI3-9",
          filingNew: true,
        }),
      ]),
      noFilter,
    );
    expect(newInBacklog(tiles)).toBe(1);
  });
});

describe("a tile's one dim word", () => {
  it("names blocked, held, urgent, a filing's origin, then a lone child's parent", () => {
    const flags = task().flags;
    expect(tileWordOf(task({ flags: { ...flags, blocked: true }, priority: 0 }), "WEB-7")).toBe(
      "blocked",
    );
    expect(tileWordOf(task({ flags: { ...flags, held: true }, priority: 0 }), null)).toBe("held");
    expect(tileWordOf(task({ priority: 0, foundOn: "FI3-9" }), null)).toBe("urgent");
    expect(tileWordOf(task({ foundOn: "FI3-9" }), "WEB-7")).toBe("found on FI3-9");
    expect(tileWordOf(task({ status: "done" }), "WEB-7")).toBe("part of WEB-7");
    // Done work is never urgent.
    expect(tileWordOf(task({ status: "done", priority: 0 }), null)).toBe("");
  });
});

describe("the project chips", () => {
  it("lists All projects then each project with tiles, only for two or more", () => {
    const web = project({ id: "proj-web", key: "WEB", name: "website" });
    const idle = project({ id: "proj-idle", key: "IDL", name: "idle" });
    expect(boardChipsOf(board([task()], [project(), web, idle]))).toEqual([]);
    expect(
      boardChipsOf(
        board(
          [task(), task({ id: "w", key: "WEB-1", projectId: "proj-web" })],
          [project(), web, idle],
        ),
      ),
    ).toEqual([
      { id: null, label: "All projects" },
      { id: "proj-r1", label: "FI3" },
      { id: "proj-web", label: "WEB" },
    ]);
  });
});

describe("a page of a lane", () => {
  const lane = (n: number): BoardTile[] =>
    Array.from({ length: n }, (_, i) => ({
      task: task({ id: `t${i}`, key: `FI3-${i + 1}` }),
      depth: 0,
      word: "",
    }));
  const shownKeys = (tiles: BoardTile[]) => tiles.map((tile) => tile.task.key);

  it("shows one page, with its range in the whole lane, and clamps a page past the end", () => {
    const sixty = lane(60);
    const third = boardPageOf(sixty, 2, 20);
    expect([third.first, third.last, third.total, third.pages]).toEqual([41, 60, 60, 3]);
    expect(shownKeys(third.tiles)).toHaveLength(20);
    expect(third.tiles[0]?.task.key).toBe("FI3-41");
    // A lane that shrank under a later page shows its last page.
    expect(boardPageOf(lane(7), 4, 5).page).toBe(1);
    expect(shownKeys(boardPageOf(lane(7), 4, 5).tiles)).toEqual(["FI3-6", "FI3-7"]);
    expect(clampPage(3, 0, 5)).toBe(0);
    const empty = boardPageOf([], 2, 20);
    expect([empty.page, empty.pages, empty.first, empty.last, empty.total]).toEqual([
      0, 1, 0, 0, 0,
    ]);
  });

  it("stands a child alone as part of its parent when the parent is on another page, and draws each task once", () => {
    const tiles = boardTilesOf(
      board([
        task({ id: "a", key: "FI3-1", createdAt: 1 }),
        task({ id: "p", key: "FI3-2", createdAt: 2, children: { total: 2, closed: 0 } }),
        task({ id: "c1", key: "FI3-3", createdAt: 3, parentId: "p" }),
        task({ id: "c2", key: "FI3-4", createdAt: 4, parentId: "p" }),
        task({ id: "g", key: "FI3-5", createdAt: 5, parentId: "c2" }),
      ]),
      noFilter,
    ).get("backlog") as BoardTile[];
    const read = (page: number) =>
      boardPageOf(tiles, page, 2).tiles.map((tile) => [tile.task.key, tile.depth, tile.word]);
    expect(read(0)).toEqual([
      ["FI3-1", 0, ""],
      ["FI3-2", 0, ""],
    ]);
    expect(read(1)).toEqual([
      ["FI3-3", 0, "part of FI3-2"],
      ["FI3-4", 0, "part of FI3-2"],
    ]);
    expect(read(2)).toEqual([["FI3-5", 0, "part of FI3-4"]]);
    const all = [0, 1, 2].flatMap((page) => shownKeys(boardPageOf(tiles, page, 2).tiles));
    expect(all).toEqual(["FI3-1", "FI3-2", "FI3-3", "FI3-4", "FI3-5"]);
    // On one page together, the child nests under its parent as before.
    expect(boardPageOf(tiles, 0, 5).tiles.map((tile) => tile.depth)).toEqual([0, 0, 1, 1, 2]);
  });
});

describe("Find's earlier matches", () => {
  const listed = board([
    task({ id: "recent", key: "FI3-1", title: "Search history", status: "done", closedAt: 50 }),
  ]);
  const filter = { query: "search", projectId: null };

  it("keeps done work the board does not list, once each, newest first", () => {
    const found = [
      task({ id: "old1", key: "FI3-2", title: "Search older", status: "done", closedAt: 5 }),
      task({ id: "old2", key: "FI3-3", title: "Search oldest", status: "done", closedAt: 9 }),
      task({ id: "old1", key: "FI3-2", title: "Search older", status: "done", closedAt: 5 }),
      // Dropped work is not completed work, an answered question is not work,
      // and the board already lists FI3-1.
      task({ id: "gone", key: "FI3-4", title: "Search gone", status: "dropped", closedAt: 7 }),
      task({
        id: "asked",
        key: "FI3-5",
        title: "Search asked",
        kind: "question",
        status: "done",
        closedAt: 8,
      }),
      task({ id: "recent", key: "FI3-1", title: "Search history", status: "done", closedAt: 50 }),
    ];
    const earlier = boardEarlierOf(found, listed, filter);
    expect(earlier.tiles.map((tile) => tile.task.key)).toEqual(["FI3-3", "FI3-2"]);
    expect(earlier.capped).toBe(false);
  });

  // INF-3127: pinned work closed before the week rides the board for Tasks'
  // Pinned but sits in no lane, so Find still reaches it as older done work.
  it("reaches pinned work past the week, which the board lists in no lane", () => {
    const at = 4 * WEEK;
    const old = task({
      id: "pinned-old",
      key: "FI3-7",
      title: "Search pinned",
      status: "done",
      closedAt: at - WEEK - DAY,
      pinnedAt: at - DAY,
    });
    const read = { ...board([old]), at };
    expect(boardEarlierOf([old], read, filter).tiles.map((tile) => tile.task.key)).toEqual([
      "FI3-7",
    ]);
  });

  it("narrows by the project chip and the words, and reads nothing without words", () => {
    const found = [
      task({ id: "a", key: "FI3-2", title: "Search older", status: "done", closedAt: 5 }),
      task({
        id: "b",
        key: "WEB-2",
        title: "Search the site",
        status: "done",
        closedAt: 6,
        projectId: "proj-web",
      }),
      task({ id: "c", key: "FI3-9", title: "Unrelated", status: "done", closedAt: 7 }),
    ];
    expect(
      boardEarlierOf(found, listed, { query: "search", projectId: "proj-web" }).tiles.map(
        (tile) => tile.task.key,
      ),
    ).toEqual(["WEB-2"]);
    expect(boardEarlierOf(found, listed, filter).tiles.map((tile) => tile.task.key)).toEqual([
      "WEB-2",
      "FI3-2",
    ]);
    expect(boardEarlierOf(found, listed, { query: "  ", projectId: null })).toEqual({
      tiles: [],
      capped: false,
    });
  });

  it("says an answer as long as the search's limit may have been cut, before narrowing it", () => {
    const full = Array.from({ length: EARLIER_SEARCH_LIMIT }, (_, i) =>
      task({
        id: `x${i}`,
        key: `WEB-${i}`,
        title: "Search the site",
        status: "done",
        closedAt: i,
        projectId: "proj-web",
      }),
    );
    const narrowed = boardEarlierOf(full, listed, { query: "search", projectId: "proj-r1" });
    expect(narrowed.tiles).toEqual([]);
    expect(narrowed.capped).toBe(true);
  });
});

describe("the board's arrows", () => {
  // Waiting on you as rows above three columns 200 px apart.
  const points: Record<string, TilePoint> = {
    w1: { x: 400, y: 50 },
    w2: { x: 400, y: 80 },
    q1: { x: 100, y: 300 },
    q2: { x: 100, y: 400 },
    q3: { x: 100, y: 500 },
    k1: { x: 300, y: 300 },
    k2: { x: 300, y: 410 },
    d1: { x: 500, y: 300 },
  };
  const at = (id: string) => points[id];
  const layout = {
    row: ["w1", "w2"],
    columns: [["q1", "q2", "q3"], ["k1", "k2"], ["d1"]],
  };
  const move = (from: string, key: string, shape = layout) => boardNavMove(shape, from, key, at);

  it("moves up and down a column, and to its ends with Home and End", () => {
    expect(move("q1", "ArrowDown")).toBe("q2");
    expect(move("q2", "ArrowUp")).toBe("q1");
    expect(move("q1", "End")).toBe("q3");
    expect(move("q3", "Home")).toBe("q1");
    expect(move("q3", "ArrowDown")).toBeNull();
  });

  it("reaches a lane's tiles on its other pages, and its real ends", () => {
    // Page two of a list: q1..q3 drawn, the rest of the lane not.
    const paged = {
      row: ["w1"],
      columns: [["p1", "p2", "p3", "q1", "q2", "q3", "z1", "z2"]],
    };
    expect(move("q1", "ArrowUp", paged)).toBe("p3");
    expect(move("q3", "ArrowDown", paged)).toBe("z1");
    expect(move("q2", "Home", paged)).toBe("p1");
    expect(move("q2", "End", paged)).toBe("z2");
    // Up from the lane's real top goes into Waiting on you; down from there to a drawn tile.
    expect(move("q1", "ArrowUp", { ...paged, columns: [["q1", "q2", "q3", "z1"]] })).toBe("w1");
    expect(move("w1", "ArrowDown", paged)).toBe("q1");
  });

  it("moves left and right to the nearest drawn tile in the next column that has one", () => {
    expect(move("q2", "ArrowRight")).toBe("k2");
    expect(move("k1", "ArrowRight")).toBe("d1");
    expect(move("k2", "ArrowLeft")).toBe("q2");
    expect(move("q2", "ArrowLeft")).toBeNull();
    expect(move("d1", "ArrowRight")).toBeNull();
    // An empty column, or one whose page draws nothing, is passed over.
    expect(move("q2", "ArrowRight", { ...layout, columns: [["q1", "q2", "q3"], [], ["d1"]] })).toBe(
      "d1",
    );
    expect(
      move("q2", "ArrowRight", { ...layout, columns: [["q1", "q2", "q3"], ["off"], ["d1"]] }),
    ).toBe("d1");
  });

  it("walks Waiting on you's rows, goes down into the first column, and up again to its last row", () => {
    expect(move("w1", "ArrowDown")).toBe("w2");
    expect(move("w2", "ArrowUp")).toBe("w1");
    expect(move("w1", "End")).toBe("w2");
    expect(move("w2", "Home")).toBe("w1");
    expect(move("w1", "ArrowUp")).toBeNull();
    expect(move("w1", "ArrowRight")).toBeNull();
    // Down from its last row into the first column that draws a tile.
    expect(move("w2", "ArrowDown")).toBe("q1");
    expect(move("w2", "ArrowDown", { ...layout, columns: [[], ["k1", "k2"], ["d1"]] })).toBe("k1");
    // Up from any column's top lands on its last row.
    expect(move("q1", "ArrowUp")).toBe("w2");
    expect(move("d1", "ArrowUp")).toBe("w2");
    expect(move("k1", "ArrowUp", { ...layout, row: [] })).toBeNull();
  });

  it("moves on no other key", () => {
    expect(move("q1", "Enter")).toBeNull();
    expect(move("q1", "a")).toBeNull();
  });
});

/**
 * The board's tag row and its By tag view (the approved plan for tags on
 * the task board: whole counts, a two-tag task in both rows, the project
 * chip and Find narrowing them).
 */
describe("the board's tags", () => {
  const tagOf = (id: string, name: string) => ({
    id,
    name,
    description: `Tasks about ${name}.`,
    revision: 1,
    tasks: 0,
  });
  const carried = (...tags: [string, string][]) =>
    tags.map(([id, name]) => ({ id, name, by: "captain" as const }));
  const bug: [string, string] = ["tag-b", "bug"];
  const ios: [string, string] = ["tag-i", "ios"];
  const tagged = project({ tags: [tagOf(...bug), tagOf("tag-d", "docs"), tagOf(...ios)] });
  const other = project({ id: "proj-r2", key: "TID", name: "tide" });
  const tasks = [
    task({ id: "c", key: "FI3-1", waitingCardId: "card-1", tags: carried(bug) }),
    task({ id: "b", key: "FI3-2", title: "Crash on a photo", tags: carried(bug, ios) }),
    task({ id: "q", key: "FI3-3", startPolicy: "when-ready", tags: carried(ios) }),
    task({ id: "w", key: "FI3-4", status: "active", activity: "running", title: "Crash at start" }),
    task({ id: "d", key: "FI3-5", status: "done", closedAt: 5, tags: carried(bug) }),
    task({ id: "t", key: "TID-1", projectId: "proj-r2" }),
  ];
  const current = board(tasks, [tagged, other]);
  const table = (filter: { query: string; projectId: string | null }) =>
    boardTagRowsOf(current, filter).map((row) => [
      row.name,
      row.counts.waiting,
      row.counts.backlog,
      row.counts.queued,
      row.counts.working,
      row.counts.landed,
    ]);

  it("counts each tag and No tag in Waiting on you and the four lanes, a two-tag task in both rows", () => {
    expect(table(noFilter)).toEqual([
      // name, waiting, backlog, queued, working, done
      ["bug", 1, 1, 0, 0, 1],
      ["docs", 0, 0, 0, 0, 0],
      ["ios", 0, 1, 1, 0, 0],
      ["No tag", 0, 1, 0, 1, 0],
    ]);
  });

  it("narrows its counts by the project chip and Find", () => {
    expect(table({ query: "", projectId: "proj-r1" })).toContainEqual(["No tag", 0, 0, 0, 1, 0]);
    expect(table({ query: "crash", projectId: null })).toEqual([
      ["bug", 0, 1, 0, 0, 0],
      ["docs", 0, 0, 0, 0, 0],
      ["ios", 0, 1, 0, 0, 0],
      ["No tag", 0, 0, 0, 1, 0],
    ]);
  });

  it("offers All tags, each tag even at 0, then No tag, with what a press would show", () => {
    expect(boardTagChipsOf(current, noFilter).map((chip) => [chip.label, chip.count])).toEqual([
      ["All tags", null],
      ["bug", 3],
      ["docs", 0],
      ["ios", 2],
      ["No tag", 2],
    ]);
    expect(boardTagChipsOf(current, { query: "", projectId: "proj-r2" })).toEqual([]);
    expect(boardTagRowsOf(current, { query: "", projectId: "proj-r2" })).toEqual([]);
  });

  it("a pressed tag narrows every lane", () => {
    const tiles = boardTilesOf(current, { ...noFilter, tag: "tag-b" });
    expect(keys(tiles, "waiting")).toEqual(["FI3-1"]);
    expect(keys(tiles, "backlog")).toEqual(["FI3-2"]);
    expect(keys(tiles, "queued")).toEqual([]);
    expect(keys(tiles, "landed")).toEqual(["FI3-5"]);
  });
});
