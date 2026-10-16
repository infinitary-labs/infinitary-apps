import type { PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import { foldForSearch, NOW_GROUP_LABELS, type NowGroup, nowGroupOf } from "@infinitary/ui";

/**
 * What the task board lists and where (docs/task-board.md; the design
 * skill's `components/now/TaskBoard`). Pure, so the board (./cards/board.tsx)
 * paints it and a unit test reads it.
 *
 * The board reads the Tasks panel's set and names: each task under its own
 * shared group (`nowGroupOf`, from the panel library), so a tile and a row
 * never disagree on a task's own state. The panel keeps a working parent's
 * tree together; the board shows each task once under its own state
 * instead, and a child nests under its parent only when both are in the
 * same lane - otherwise it stands alone, its word "part of KEY".
 *
 * It is a focused board: Waiting on you above whichever view is open, the
 * Board view's three columns of work not yet done, Backlog, Queued and
 * Working, and the paged lists the rest of the work is browsed in - Backlog,
 * Done · 7d, Waiting on you, Dropped · 7d, and the earlier matches Find
 * reaches. Nothing draws more than a page at once.
 */

/** The four columns, left to right: the order work moves through. */
export const BOARD_COLUMNS = ["backlog", "queued", "working", "landed"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/**
 * Every place a tile can be: Waiting on you, a column, the dropped list, or
 * the earlier matches Find reached beyond the board's seven days.
 */
export type BoardLane = "waiting" | BoardColumn | "dropped" | "earlier";

/** Each lane's micro label: the panel's group names, the dropped list's and the earlier matches'. */
export const BOARD_LANE_LABELS: Record<BoardLane, string> = {
  ...(NOW_GROUP_LABELS as Record<NowGroup, string>),
  dropped: "dropped · 7d",
  earlier: "earlier matches",
};

/** The Board view's columns, left to right: the work not yet done. Done · 7d is a list. */
export const BOARD_FOCUS_COLUMNS = ["backlog", "queued", "working"] as const;

/**
 * What the board shows under Waiting on you: the Board view's columns, or
 * one lane as a paged list. Board opens first.
 */
export type BoardView = "board" | "backlog" | "landed" | "waiting" | "dropped" | "earlier";

/** How many tiles a Board column shows at once: a display batch, never a work-in-progress limit. */
export const BOARD_COLUMN_PAGE = 5;
/** How many rows a list shows at once. */
export const BOARD_LIST_PAGE = 20;
/** How many of Waiting on you show above every view before its own list. */
export const BOARD_WAITING_SHOWN = 3;
/**
 * How many earlier tasks one search answers at most, as the panel contract
 * names it (`PanelTaskSearch`): an answer this long may have been cut, so
 * the board asks for narrower words.
 */
export const EARLIER_SEARCH_LIMIT = 50;

/** What an empty lane says, in place of its tiles. */
export const BOARD_EMPTY_WORDS: Record<BoardLane, string> = {
  waiting: "Nothing waits on you",
  backlog: "Nothing in the backlog",
  queued: "Nothing queued",
  working: "Nothing working",
  landed: "Nothing done this week",
  dropped: "Nothing dropped this week",
  earlier: "No earlier tasks match",
};

/** How deep a child tile indents at most, as a Tasks row does. */
export const MAX_TILE_DEPTH = 2;

export type BoardTile = {
  task: PanelTaskRow;
  /** Nesting under a parent in the same lane. */
  depth: number;
  /** The one dim word, or "". */
  word: string;
};

export type BoardFilter = { query: string; projectId: string | null };

/** Where a task's tile is, or null when the board leaves it out. */
export function boardLaneOf(task: PanelTaskRow): BoardLane | null {
  if (task.status === "dropped") return task.kind === "work" ? "dropped" : null;
  return nowGroupOf(task);
}

/**
 * A tile's one dim word: blocked or held open work first, urgent work at the
 * top priority, a crew filing's origin, then the parent of a child standing
 * alone.
 */
export function tileWordOf(task: PanelTaskRow, partOf: string | null): string {
  if (task.status === "open" && task.flags.blocked) return "blocked";
  if (task.status === "open" && task.flags.held) return "held";
  if (task.priority === 0 && (task.status === "open" || task.status === "active")) return "urgent";
  if (task.status === "open" && task.foundOn) return `found on ${task.foundOn}`;
  return partOf ? `part of ${partOf}` : "";
}

function matches(task: PanelTaskRow, filter: BoardFilter): boolean {
  if (filter.projectId && task.projectId !== filter.projectId) return false;
  const q = foldForSearch(filter.query.trim());
  if (!q) return true;
  return foldForSearch(task.title).includes(q) || foldForSearch(task.key).includes(q);
}

/**
 * Tiles per lane, every lane present: by priority then oldest first, Done
 * and Dropped newest first, a child under its parent when both share a
 * column.
 */
export function boardTilesOf(
  board: PanelTaskBoard,
  filter: BoardFilter,
): Map<BoardLane, BoardTile[]> {
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const laneOf = new Map<string, BoardLane>();
  const lists = new Map<BoardLane, PanelTaskRow[]>();
  for (const lane of ["waiting", ...BOARD_COLUMNS, "dropped"] as const) lists.set(lane, []);
  for (const task of board.tasks) {
    const lane = boardLaneOf(task);
    if (!lane || !matches(task, filter)) continue;
    laneOf.set(task.id, lane);
    lists.get(lane)?.push(task);
  }
  const tiles = new Map<BoardLane, BoardTile[]>();
  for (const [lane, tasks] of lists) {
    tasks.sort((a, b) =>
      lane === "landed" || lane === "dropped"
        ? (b.closedAt ?? 0) - (a.closedAt ?? 0)
        : a.priority - b.priority || a.createdAt - b.createdAt,
    );
    // Only a column nests; Waiting on you and Dropped list each tile alone.
    const nests = (BOARD_COLUMNS as readonly BoardLane[]).includes(lane);
    const childrenOf = new Map<string, PanelTaskRow[]>();
    const roots: PanelTaskRow[] = [];
    for (const task of tasks) {
      if (nests && task.parentId !== null && laneOf.get(task.parentId) === lane) {
        childrenOf.set(task.parentId, [...(childrenOf.get(task.parentId) ?? []), task]);
      } else {
        roots.push(task);
      }
    }
    const ordered: BoardTile[] = [];
    const place = (task: PanelTaskRow, depth: number) => {
      const alone = depth === 0 && task.parentId !== null;
      const partOf = alone ? (byId.get(task.parentId ?? "")?.key ?? null) : null;
      ordered.push({
        task,
        depth: Math.min(depth, MAX_TILE_DEPTH),
        word: tileWordOf(task, partOf),
      });
      for (const child of childrenOf.get(task.id) ?? []) place(child, depth + 1);
    };
    for (const root of roots) place(root, 0);
    tiles.set(lane, ordered);
  }
  return tiles;
}

/** One page of a lane: its tiles as drawn, and where the page sits in the whole lane. */
export type BoardPage = {
  tiles: BoardTile[];
  /** The page shown, clamped to the lane's pages. */
  page: number;
  /** How many pages the lane has; at least one, empty or not. */
  pages: number;
  /** The first and last tile shown, counted from 1; 0 and 0 for an empty lane. */
  first: number;
  last: number;
  total: number;
};

/** A page within a lane of `total` tiles, clamped: a lane that shrank shows its last page. */
export function clampPage(page: number, total: number, size: number): number {
  const last = Math.max(0, Math.ceil(total / size) - 1);
  return Math.min(Math.max(0, Math.floor(page)), last);
}

/**
 * One page of a lane's tiles. A child whose parent sits on another page
 * stands alone here, its word "part of KEY", so paging never hides a child
 * under a parent that is not drawn, and no tile is drawn twice.
 */
export function boardPageOf(tiles: readonly BoardTile[], page: number, size: number): BoardPage {
  const total = tiles.length;
  const at = clampPage(page, total, size);
  const slice = tiles.slice(at * size, at * size + size);
  const keyOf = new Map(tiles.map((tile) => [tile.task.id, tile.task.key]));
  const depthOf = new Map<string, number>();
  const shown = slice.map((tile) => {
    const parentId = tile.task.parentId;
    if (tile.depth > 0 && parentId !== null) {
      const parentDepth = depthOf.get(parentId);
      if (parentDepth === undefined) {
        depthOf.set(tile.task.id, 0);
        return {
          ...tile,
          depth: 0,
          word: tileWordOf(tile.task, keyOf.get(parentId) ?? null),
        };
      }
      const depth = Math.min(parentDepth + 1, MAX_TILE_DEPTH);
      depthOf.set(tile.task.id, depth);
      return depth === tile.depth ? tile : { ...tile, depth };
    }
    depthOf.set(tile.task.id, tile.depth);
    return tile;
  });
  return {
    tiles: shown,
    page: at,
    pages: Math.max(1, Math.ceil(total / size)),
    first: total === 0 ? 0 : at * size + 1,
    last: at * size + slice.length,
    total,
  };
}

/** What Find found earlier: the rows, and whether the search's answer may have been cut. */
export type BoardEarlier = { tiles: BoardTile[]; capped: boolean };

/**
 * The earlier matches for Find's words: done work the search found beyond
 * the board's seven days - never dropped work, an answered question or a
 * decision, never a task the board already lists, each once - narrowed by the project chip and the words,
 * newest closed first. An answer as long as the search's limit may have
 * been cut before this narrowing, so it is `capped`: partial results,
 * never a total. Nothing without words.
 */
export function boardEarlierOf(
  found: readonly PanelTaskRow[],
  board: PanelTaskBoard,
  filter: BoardFilter,
): BoardEarlier {
  if (!filter.query.trim()) return { tiles: [], capped: false };
  const seen = new Set(board.tasks.map((task) => task.id));
  const tiles: BoardTile[] = [];
  for (const task of found) {
    if (task.kind !== "work" || task.status !== "done") continue;
    if (seen.has(task.id) || !matches(task, filter)) continue;
    seen.add(task.id);
    tiles.push({ task, depth: 0, word: "" });
  }
  tiles.sort((a, b) => (b.task.closedAt ?? 0) - (a.task.closedAt ?? 0));
  return { tiles, capped: found.length >= EARLIER_SEARCH_LIMIT };
}

/** The board's count: every task in Waiting on you and the four lanes of work, every page of them. */
export function boardCountOf(tiles: ReadonlyMap<BoardLane, readonly BoardTile[]>): number {
  return (["waiting", ...BOARD_COLUMNS] as const).reduce(
    (sum, lane) => sum + (tiles.get(lane)?.length ?? 0),
    0,
  );
}

/** Crew filings in the backlog the captain has not opened, for its "· N new". */
export function newInBacklog(tiles: ReadonlyMap<BoardLane, readonly BoardTile[]>): number {
  return (tiles.get("backlog") ?? []).filter((tile) => tile.task.filingNew).length;
}

export type BoardChip = { id: string | null; label: string };

/**
 * The project chips: All projects, then each project's key, only when two
 * or more projects have tiles on the unfiltered board.
 */
export function boardChipsOf(board: PanelTaskBoard): BoardChip[] {
  const withTiles = new Set(
    board.tasks.filter((task) => boardLaneOf(task) !== null).map((task) => task.projectId),
  );
  const projects = board.projects.filter((project) => withTiles.has(project.id));
  if (projects.length < 2) return [];
  return [
    { id: null, label: "All projects" },
    ...projects.map((project) => ({ id: project.id, label: project.key })),
  ];
}

/** A tile's centre on screen, which the arrows read to find the nearest tile. */
export type TilePoint = { x: number; y: number };

/** The tiles the keys move through, by their task ids. */
export type BoardNavLayout = {
  /** Waiting on you as drawn above the view, top to bottom. */
  row: readonly string[];
  /**
   * The lanes under it, left to right - the Board view's columns, or the
   * one list a list view shows - each whole, top to bottom: the tiles on
   * its other pages too, which `at` does not place.
   */
  columns: readonly (readonly string[])[];
};

const BOARD_NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** The tile in `ids` nearest `point` along `axis`, or null when there are none. */
function nearest(
  ids: readonly string[],
  point: TilePoint,
  axis: "x" | "y",
  at: (id: string) => TilePoint | undefined,
): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const p = at(id);
    if (!p) continue;
    const d = Math.abs(p[axis] - point[axis]);
    if (d < distance) {
      best = id;
      distance = d;
    }
  }
  return best;
}

/**
 * Where an arrow, Home or End moves from tile `from` (docs/keyboard.md,
 * "Lists and Settings"; docs/task-board.md, "Keys"), or null for a key the
 * board does not move on or a move off its edge: ↑ ↓ within a lane and
 * onto its other pages, Home and End to the lane's real ends, ← → to the
 * nearest drawn tile in the next lane that has one, ↓ from Waiting on
 * you's last row to the first lane's top and ↑ from a lane's top back to
 * it. The answer may be a tile on another page: the board turns to it.
 */
export function boardNavMove(
  layout: BoardNavLayout,
  from: string,
  key: string,
  at: (id: string) => TilePoint | undefined,
): string | null {
  if (!BOARD_NAV_KEYS.has(key)) return null;
  const point = at(from);
  if (!point) return null;
  const drawn = (lane: readonly string[]) => lane.filter((id) => at(id) !== undefined);
  const row = layout.row;
  if (row.includes(from)) {
    const index = row.indexOf(from);
    switch (key) {
      case "ArrowUp":
        return row[index - 1] ?? null;
      case "ArrowDown":
        return (
          row[index + 1] ??
          layout.columns.map((column) => drawn(column)[0]).find((id) => id !== undefined) ??
          null
        );
      case "Home":
        return row[0] ?? null;
      case "End":
        return row.at(-1) ?? null;
      default:
        return null;
    }
  }
  const c = layout.columns.findIndex((column) => column.includes(from));
  const column = layout.columns[c];
  if (!column) return null;
  const index = column.indexOf(from);
  switch (key) {
    case "ArrowUp":
      return column[index - 1] ?? row.at(-1) ?? null;
    case "ArrowDown":
      return column[index + 1] ?? null;
    case "Home":
      return column[0] ?? null;
    case "End":
      return column.at(-1) ?? null;
    default: {
      const step = key === "ArrowLeft" ? -1 : 1;
      for (let next = c + step; next >= 0 && next < layout.columns.length; next += step) {
        const beside = drawn(layout.columns[next] ?? []);
        if (beside.length > 0) return nearest(beside, point, "y", at);
      }
      return null;
    }
  }
}
