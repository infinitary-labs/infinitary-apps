import type { PanelSummaryPart, PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import {
  foldForSearch,
  NOW_GROUP_LABELS,
  NOW_GROUPS,
  type NowGroup,
  nowGroupOf,
  nowGroupsOf,
  taskStatusOf,
} from "@infinitary/ui";
import {
  EARLIER_LABEL,
  foundOnWords,
  ROW_REACH_WORDS,
  ROW_START_LABEL,
  ROW_TRY_AGAIN_LABEL,
  ROW_WORDS,
} from "./words";

/**
 * What the Tasks panel lists, and how each row reads (task-system design
 * section 10, P4; the design skill's NowPanel). Pure, so the panel
 * (./panel.tsx) renders it and a unit test reads it. Which group a row is
 * in is the app's shared rule, from the panel library (`nowGroupsOf`): the
 * same one the task board names its lanes by.
 */

export { NOW_GROUPS, type NowGroup };

/**
 * `earlier` is the search's own group (FI3-579 piece 3): closed work the
 * board does not list, found only by typed words. It is not a board group.
 */
export type PanelGroup = NowGroup | "earlier";

export const PANEL_GROUP_LABELS: Record<PanelGroup, string> = {
  ...NOW_GROUP_LABELS,
  earlier: EARLIER_LABEL,
};

/** Groups whose rows show without a click. */
export const OPEN_BY_DEFAULT: ReadonlySet<PanelGroup> = new Set([
  "waiting",
  "working",
  "queued",
  "earlier",
]);

/** How deep a child row indents at most. */
export const MAX_DEPTH = 3;

export type NowRow = { task: PanelTaskRow; group: PanelGroup; depth: number };

export type NowFilter = { query: string; projectId: string | null };

type StartMarks = {
  startAttempt?: { phase: "preparing" | "checking" };
  startNotice?: { reason: string };
};

function startMarks(task: PanelTaskRow): StartMarks {
  return task as PanelTaskRow & StartMarks;
}

/**
 * The one dim word a row may carry. A crew filing reads "found on X"; work
 * waiting on its checks reads "checks".
 */
export function wordOf(task: PanelTaskRow): string {
  const marks = startMarks(task);
  if (
    marks.startAttempt?.phase === "preparing" ||
    marks.startAttempt?.phase === "checking" ||
    task.activity === "starting"
  ) {
    return ROW_WORDS.starting;
  }
  if (marks.startNotice) return ROW_WORDS.couldNotStart;
  // The row shows no reason, so the checks watch says itself (INF-676), and
  // so does a started crewmate idle on the tasks it waits on (INF-38): the
  // row's margin arrow points at them and its summary names each one.
  const reading = task.status === "active" ? taskStatusOf(task) : null;
  if (reading?.wait === "checks") return ROW_WORDS.checks;
  if (reading?.waitsOn) return ROW_WORDS.waiting;
  if (task.status !== "open") return "";
  if (task.flags.blocked) return ROW_WORDS.blocked;
  if (task.flags.held) return ROW_WORDS.held;
  if (task.foundOn) return foundOnWords(task.foundOn);
  return "";
}

/** A backlog row's Start: its words, and why it cannot start now, or null when it can. */
export type RowStart = { label: string; reason: string | null };

/**
 * The Start a backlog row offers on rest (INF-1663, the captain's direction
 * A on INF-1662): the record's own Start, read from the move the row already
 * carries (`moves`, the record's rule), so the row starts exactly what the
 * record would, and says the record's reason where it cannot. Null on a row
 * with no moves: a decision, a question, or an older home.
 */
export function rowStartOf(task: PanelTaskRow): RowStart | null {
  const allowance = task.moves?.["start-task"];
  if (!allowance) return null;
  return {
    label: startMarks(task).startNotice ? ROW_TRY_AGAIN_LABEL : ROW_START_LABEL,
    reason: allowance.ok ? null : allowance.text,
  };
}

/** Crew-filed rows in this group the captain has not opened. */
export function newFilingCount(rows: readonly NowRow[]): number {
  return rows.filter((row) => row.task.filingNew).length;
}

/** The trailing chrome: the project's display name, never the task key. */
export function projectNameOf(board: Pick<PanelTaskBoard, "projects">, task: PanelTaskRow): string {
  return board.projects.find((project) => project.id === task.projectId)?.name ?? "";
}

/**
 * What a row says after its title (the design skill's RunsOn): the
 * project's name - left out where only one project could be meant - then,
 * for a task another computer runs, where ("on Mac mini"); and whether that
 * computer is out of reach, which the row says last.
 */
export function trailingOf(
  board: PanelTaskBoard,
  task: PanelTaskRow,
  singleProject = hasSingleRegisteredRepoProject(board),
): RowTrailing {
  return rowTrailing(task, singleProject ? "" : projectNameOf(board, task));
}

export type RowTrailing = {
  name: string;
  place: string;
  outOfReach: boolean;
  connecting: boolean;
  reach: string;
};

/**
 * The trailing chrome from the project's name the row shows ("" where only
 * one project could be meant): what a row's paint reads, so a row takes the
 * name as a value and paints again only when it or the task changed.
 */
export function rowTrailing(task: PanelTaskRow, name: string): RowTrailing {
  const connecting = task.place?.reach === "connecting";
  return {
    name,
    place: task.place?.where ?? "",
    // The row says why its computer cannot take work now: out of reach, or connecting.
    outOfReach: task.place?.reach !== undefined && task.place.reach !== "in-reach",
    connecting,
    reach: connecting
      ? ROW_REACH_WORDS.connecting
      : task.place?.noNewWork
        ? ROW_REACH_WORDS.noNewWork
        : ROW_REACH_WORDS.away,
  };
}

/**
 * The groups of a board, read once per board: the panel reads them for its
 * rows, its project chips and the newest listed write on every push, and
 * a push's board holds its identity until the next change (INF-2105).
 */
const groupsByBoard = new WeakMap<PanelTaskBoard, ReadonlyMap<string, NowGroup | null>>();

function groupsOf(board: PanelTaskBoard): ReadonlyMap<string, NowGroup | null> {
  let groups = groupsByBoard.get(board);
  if (!groups) {
    groups = nowGroupsOf(board);
    groupsByBoard.set(board, groups);
  }
  return groups;
}

function matches(task: PanelTaskRow, filter: NowFilter): boolean {
  if (filter.projectId && task.projectId !== filter.projectId) return false;
  const q = foldForSearch(filter.query.trim());
  if (!q) return true;
  return foldForSearch(task.title).includes(q) || foldForSearch(task.key).includes(q);
}

/**
 * Rows per group: sorted by priority then age (landed newest first), a
 * child placed under its parent when both are in the same group.
 */
export function rowsOf(board: PanelTaskBoard, filter: NowFilter): Map<NowGroup, NowRow[]> {
  const taskGroups = groupsOf(board);
  const byGroup = new Map<NowGroup, PanelTaskRow[]>();
  const groupById = new Map<string, NowGroup>();
  for (const task of board.tasks) {
    const group = taskGroups.get(task.id) ?? null;
    if (!group || !matches(task, filter)) continue;
    groupById.set(task.id, group);
    const list = byGroup.get(group) ?? [];
    list.push(task);
    byGroup.set(group, list);
  }
  const rows = new Map<NowGroup, NowRow[]>();
  for (const [group, tasks] of byGroup) {
    tasks.sort((a, b) =>
      group === "landed"
        ? (b.closedAt ?? 0) - (a.closedAt ?? 0)
        : a.priority - b.priority || a.createdAt - b.createdAt,
    );
    const childrenOf = new Map<string, PanelTaskRow[]>();
    const roots: PanelTaskRow[] = [];
    for (const task of tasks) {
      if (task.parentId !== null && groupById.get(task.parentId) === group) {
        const siblings = childrenOf.get(task.parentId) ?? [];
        siblings.push(task);
        childrenOf.set(task.parentId, siblings);
      } else {
        roots.push(task);
      }
    }
    const ordered: NowRow[] = [];
    const place = (task: PanelTaskRow, depth: number) => {
      ordered.push({ task, group, depth: Math.min(depth, MAX_DEPTH) });
      for (const child of childrenOf.get(task.id) ?? []) place(child, depth + 1);
    };
    for (const root of roots) place(root, 0);
    rows.set(group, ordered);
  }
  return rows;
}

/**
 * The `earlier` rows for typed words: what the app found (closed beyond the
 * board's window, or dropped), minus any row the panel already lists,
 * narrowed by the project chip, newest closed first. Nothing without words.
 */
export function earlierRowsOf(
  found: readonly PanelTaskRow[],
  listed: ReadonlyMap<PanelGroup, NowRow[]>,
  filter: NowFilter,
): NowRow[] {
  if (!filter.query.trim()) return [];
  const shown = new Set([...listed.values()].flatMap((rows) => rows.map((row) => row.task.id)));
  return found
    .filter(
      (task) => !shown.has(task.id) && (!filter.projectId || task.projectId === filter.projectId),
    )
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .map((task) => ({ task, group: "earlier" as const, depth: 0 }));
}

export function hasSingleRegisteredRepoProject(board: PanelTaskBoard): boolean {
  return (
    board.projects.filter((project) => project.repo !== null && !project.archived).length === 1
  );
}

export type ProjectChip = { id: string | null; key: string };

/**
 * The project chips: the project key as the filter handle, only for
 * projects with rows, and only when more than one has any.
 */
export function projectChipsOf(board: PanelTaskBoard): ProjectChip[] {
  const groups = groupsOf(board);
  const withRows = new Set(
    board.tasks.filter((task) => groups.get(task.id) != null).map((task) => task.projectId),
  );
  const projects = board.projects.filter((project) => withRows.has(project.id));
  if (projects.length < 2) return [];
  return [{ id: null, key: "all" }, ...projects.map((p) => ({ id: p.id, key: p.key }))];
}

/** The newest write among the rows the panel lists, for the lag measure. */
export function newestListedWrite(board: PanelTaskBoard): number {
  const groups = groupsOf(board);
  let newest = 0;
  for (const task of board.tasks) {
    if (groups.get(task.id) != null && task.updatedAt > newest) newest = task.updatedAt;
  }
  return newest;
}

/**
 * Whether the panel is on its rail: while the board has a row it lists, or
 * the record of an ask - the welcome's, on a new profile, so the words "Every
 * ask gets a record here" point at something from the welcome on (FI3-1164).
 * An `operation` row alone, the trail of an app change, docks nothing.
 */
export function onRail(board: PanelTaskBoard): boolean {
  return board.tasks.some((task) => nowGroupOf(task) !== null || task.kind !== "operation");
}

/**
 * What the collapsed panel says it holds: how many tasks wait on the
 * captain, the part that matters while any do, and how many are working.
 * Each task counts by its own state (`nowGroupOf`): a parent the Working
 * group shows only beside a working child is not working itself (FI3-1049).
 * Focused on a project, only its tasks count, as the top bar's pill counts
 * them (src/shared/projectFocus.ts).
 */
export function failedStartCount(tasks: readonly PanelTaskRow[]): number {
  return tasks.filter((task) => startMarks(task).startNotice != null).length;
}

export function summaryOf(
  board: PanelTaskBoard,
  projectId: string | null = null,
): PanelSummaryPart[] {
  let waiting = 0;
  let working = 0;
  const tasks =
    projectId === null ? board.tasks : board.tasks.filter((task) => task.projectId === projectId);
  for (const task of tasks) {
    const group = nowGroupOf(task);
    if (group === "waiting") waiting += 1;
    else if (group === "working") working += 1;
  }
  const failed = failedStartCount(tasks);
  return [
    { text: `${waiting} waiting`, ...(waiting > 0 ? { strong: true } : {}) },
    { text: `${working} working` },
    ...(failed > 0 ? [{ text: `${failed} could not start` }] : []),
  ];
}
