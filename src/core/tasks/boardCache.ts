import type { Card } from "@shared/cards";
import type { Slot } from "@shared/modelSlots";
import { pinnedPastWeek } from "@shared/taskPin";
import {
  BOARD_RECENT_MS,
  sortBoardLinks,
  sortBoardTasks,
  type TaskLinkView,
  type TaskView,
} from "@shared/tasks";
import type { TaskLink } from "../storage/taskLinkStore";
import type { PartCounts, TaskRecord } from "../storage/taskRecords";
import type { TaskProtocolOptions } from "./taskProtocolOptions";
import { TaskService } from "./taskService";
import {
  cardFactsOf,
  factsKey,
  type Graph,
  graphOf,
  type LiveFacts,
  replaced,
  tiersOf,
  viewOf,
} from "./taskView";

/**
 * The board's row cache (INF-2078): what the task protocol's last board
 * read, kept between reads so one change rebuilds only the rows it reached
 * (`TaskProtocol`, `taskProtocol.ts`, says which rows those are). The board
 * from nothing (`rebuild`, `rebuildParts`) and the board brought up to date
 * (`refresh`) both build here; the protocol keeps when each runs.
 */

/**
 * What the row cache reads beside the records: the protocol's options, the
 * rows written since the cache was last brought up to date, whether a host
 * fact moved with no row written, and each row's live facts as the
 * protocol's current read holds them.
 */
export type BoardReads = {
  options: Pick<TaskProtocolOptions, "tasks" | "cards" | "tiers">;
  /**
   * The rows written or removed since the cache was last brought up to
   * date, each as its last write left it (a removed row has none).
   */
  touched: ReadonlyMap<string, TaskRecord | undefined>;
  /** A host fact moved with no row written: every kept row's live facts are read again. */
  recheckFacts(): boolean;
  /** The host's own facts a view reads, which no write of the row reports. */
  liveFacts(record: TaskRecord): LiveFacts;
};

/** A shown row's view, with the live facts and card facts it was built from. */
export type CachedView = { view: TaskView; facts: string; cards: string };

/**
 * What the last board was built from, kept between reads so one change
 * rebuilds only the rows it reached (INF-2078, the row cache).
 */
export type BoardCache = {
  /** Every record the board reads: the shown rows and the rows at the other ends of their edges. */
  records: Map<string, TaskRecord>;
  /** The rows on the board. */
  shown: Set<string>;
  /** The edges touching a shown row, by `edgeKey`. */
  links: Map<string, TaskLink>;
  /** Each shown parent's child counts (`TaskService.childCounts`). */
  childCounts: Map<string, PartCounts>;
  /** What replaced each shown dropped or superseded row (`TaskService.graph.replacementsOf`). */
  replacedBy: Map<string, string>;
  /** The graph around the shown rows, as the last read built it. */
  graph: Graph;
  /** Each shown row's view. */
  views: Map<string, CachedView>;
  /** The rows in canonical order, as the last board carried them. */
  tasks: TaskView[];
  /** The edges across shown rows in canonical order, and their keys. */
  linkViews: TaskLinkView[];
  linkKeys: Set<string>;
};

/**
 * The board from nothing: the first read, and the read after rows
 * vanished wholesale. Only the rows the board shows are read: the live
 * set, the last week's closed work, any minimized card's task and the
 * pinned tasks, through their partial index (INF-3127). A long
 * record is mostly closed rows from before that, and a crew event pushes
 * the board, so reading them all stalled the main process (INF-703).
 */
export function rebuild(
  reads: BoardReads,
  cutoff: number,
  minimized: ReadonlySet<string>,
  cards: readonly Card[],
): BoardCache {
  const parts = rebuildParts(reads, cutoff, minimized, cards);
  for (;;) {
    const part = parts.next();
    if (part.done) return part.value;
  }
}

/**
 * `rebuild` in its parts: the records the board shows, what joins them
 * (their edges, counts, replacements and graph), and the rows' views in
 * order. Each pause answers the records in hand, so a part run on a later
 * turn reads them as the parts before it did.
 */
export function* rebuildParts(
  reads: BoardReads,
  cutoff: number,
  minimized: ReadonlySet<string>,
  cards: readonly Card[],
): Generator<ReadonlyMap<string, TaskRecord>, BoardCache, void> {
  const { tasks } = reads.options;
  const records = new Map<string, TaskRecord>();
  for (const record of tasks.listLiveOrClosedSince(cutoff)) records.set(record.id, record);
  for (const record of tasks.getMany([...minimized].filter((id) => !records.has(id))))
    records.set(record.id, record);
  // A pinned task lists whatever its state or age (INF-3127).
  for (const record of tasks.listPinned())
    if (!records.has(record.id)) records.set(record.id, record);
  yield records;
  const shown = shownOf(reads, records, cutoff, minimized);
  const ids = [...shown];
  const links = new Map<string, TaskLink>();
  for (const link of tasks.graph.linksTouching(ids)) links.set(edgeKey(link), link);
  readEnds(reads, records, shown, links);
  const childCounts = tasks.childCounts(ids);
  const rows = ids.map((id) => records.get(id) as TaskRecord);
  // What replaced each dropped row, read for all of them at once; one at
  // a time, each read its task's whole timeline (INF-2070).
  const replacedBy = tasks.graph.replacementsOf(rows.filter(replaced).map((record) => record.id));
  const graph = graphOf(
    reads.options,
    [...records.values()],
    [...links.values()],
    replacedBy,
    childCounts,
    cards,
  );
  const tiers = tiersOf(reads.options, rows);
  yield records;
  const views = new Map<string, CachedView>();
  for (const record of rows) views.set(record.id, cachedView(reads, record, graph, tiers));
  return {
    records,
    shown,
    links,
    childCounts,
    replacedBy,
    graph,
    views,
    tasks: sortBoardTasks([...views.values()].map((cached) => cached.view)),
    ...linkViewsOf(links, shown),
  };
}

/**
 * The board brought up to date with the rows written since the last
 * read. It rebuilds the rows a change reached: the touched rows, the rows
 * that entered the board, the shown rows at the other ends of a touched
 * row's edges (its blockers, what it blocks, its origin, its
 * replacement), a touched row's parents (their counts and parts), the
 * active rows whose standing waits name a touched row, and any row whose
 * card facts moved. After a host fact moved with no row written, every
 * row's live facts are read again and the rows they moved on are rebuilt
 * too. Every other row keeps its view, and a touched row closed before
 * the board's window that no shown row holds is ruled out from the
 * record its write left, with no read.
 */
export function refresh(
  reads: BoardReads,
  cache: BoardCache,
  cutoff: number,
  minimized: ReadonlySet<string>,
  cards: readonly Card[],
): BoardCache {
  const { tasks } = reads.options;
  const { records, links } = cache;
  // The touched rows the board can reach: those in hand (shown, or at the
  // other end of a shown row's edge) and those their last write left
  // live, closed within the window or minimized. A row closed before the
  // window that no shown row holds stays off the board whatever was
  // written to it, so the record its write left rules it out and it is
  // never read: closed history written since the last read costs the
  // update nothing (the scale check, INF-2061).
  const reaches = (record: TaskRecord) =>
    !TaskService.isClosed(record) ||
    (record.closedAt ?? 0) >= cutoff ||
    minimized.has(record.id) ||
    record.pinnedAt != null;
  const touched = [...reads.touched]
    .filter(([id, written]) => records.has(id) || (written !== undefined && reaches(written)))
    .map(([id]) => id);
  // The touched rows as they stand now; a row the writer deleted leaves.
  const before = new Map<string, TaskRecord | undefined>();
  const fresh = new Map(tasks.getMany(touched).map((record) => [record.id, record]));
  for (const id of touched) {
    before.set(id, records.get(id));
    const record = fresh.get(id);
    if (record) records.set(id, record);
    else records.delete(id);
  }
  for (const record of tasks.getMany([...minimized].filter((id) => !records.has(id))))
    records.set(record.id, record);
  const shown = shownOf(reads, records, cutoff, minimized);
  const entered = [...shown].filter((id) => !cache.shown.has(id));
  const left = [...cache.shown].filter((id) => !shown.has(id));
  // The parents to count and rebuild: the parents a touched row had or
  // has (a row ruled out above included: its parent counts it), the
  // entered rows, and the parents of the rows that entered or left,
  // since a parent's start wait reads the parts in hand.
  const parents = new Set<string>(entered);
  for (const id of [...entered, ...left]) {
    const parentId = records.get(id)?.parentId;
    if (parentId) parents.add(parentId);
  }
  for (const [id, written] of reads.touched) {
    const was = before.get(id)?.parentId;
    const is = (records.get(id) ?? written)?.parentId;
    if (was) parents.add(was);
    if (is) parents.add(is);
  }
  // The edges around the touched and entered rows, read again, and the
  // rows at the other ends of a touched row's edges, before and after.
  const reread = new Set([...touched, ...entered]);
  const neighbors = new Set<string>();
  const around = (link: TaskLink) => {
    if (!reads.touched.has(link.fromId) && !reads.touched.has(link.toId)) return;
    neighbors.add(link.fromId);
    neighbors.add(link.toId);
  };
  for (const [key, link] of links) {
    if (!reread.has(link.fromId) && !reread.has(link.toId)) continue;
    links.delete(key);
    around(link);
  }
  for (const link of tasks.graph.linksTouching([...reread])) {
    links.set(edgeKey(link), link);
    around(link);
  }
  for (const [key, link] of links)
    if (!shown.has(link.fromId) && !shown.has(link.toId)) links.delete(key);
  readEnds(reads, records, shown, links);
  const counted = [...parents].filter((id) => shown.has(id));
  const counts = tasks.childCounts(counted);
  for (const id of counted) {
    const count = counts.get(id);
    if (count) cache.childCounts.set(id, count);
    else cache.childCounts.delete(id);
  }
  for (const id of left) cache.childCounts.delete(id);
  const rebuild = new Set<string>(counted);
  for (const id of touched) if (shown.has(id)) rebuild.add(id);
  for (const id of neighbors) if (shown.has(id)) rebuild.add(id);
  if (touched.length > 0) {
    for (const id of shown) {
      const record = records.get(id);
      const diagnoses = record?.delivery?.ciRepair?.diagnoses;
      if (record?.status !== "active" || !diagnoses) continue;
      if (diagnoses.some((d) => d.dependencyTask && reads.touched.has(d.dependencyTask)))
        rebuild.add(id);
    }
  }
  // What replaced the rebuilt dropped rows.
  const replacedIds = [...rebuild].filter((id) => replaced(records.get(id) as TaskRecord));
  const replacements = tasks.graph.replacementsOf(replacedIds);
  for (const id of replacedIds) {
    const replacement = replacements.get(id);
    if (replacement) cache.replacedBy.set(id, replacement);
    else cache.replacedBy.delete(id);
  }
  for (const id of left) cache.replacedBy.delete(id);
  const graph = graphOf(
    reads.options,
    [...records.values()],
    [...links.values()],
    cache.replacedBy,
    cache.childCounts,
    cards,
  );
  // The kept rows whose card facts moved, or whose live facts moved after a host fact did.
  for (const id of shown) {
    if (rebuild.has(id)) continue;
    const cached = cache.views.get(id);
    const record = records.get(id) as TaskRecord;
    if (
      !cached ||
      cached.cards !== cardFactsOf(record, graph) ||
      (reads.recheckFacts() && cached.facts !== factsKey(reads.liveFacts(record)))
    )
      rebuild.add(id);
  }
  for (const id of left) cache.views.delete(id);
  const rebuilt = [...rebuild].map((id) => records.get(id) as TaskRecord);
  const tiers = tiersOf(reads.options, rebuilt);
  for (const record of rebuilt) cache.views.set(record.id, cachedView(reads, record, graph, tiers));
  // The rows in order: a changed membership sorts again; otherwise each
  // rebuilt view takes its row's place, and a board nothing reached
  // keeps its array.
  let rows = cache.tasks;
  if (entered.length > 0 || left.length > 0)
    rows = sortBoardTasks([...cache.views.values()].map((cached) => cached.view));
  else if (rebuild.size > 0)
    rows = cache.tasks.map((view) => cache.views.get(view.id)?.view ?? view);
  return { ...cache, shown, graph, tasks: rows, ...linkViewsOf(links, shown, cache) };
}

/**
 * The rows the board shows, from the records in hand: the live set, the
 * week's closed work and any minimized card's task, and the parents of
 * each of those, however old, so a child is never orphaned on the board;
 * and every pinned task, whose parents come only by those rules.
 * A parent not in hand is read; the walk is bounded by the hierarchy cap.
 */
function shownOf(
  reads: BoardReads,
  records: Map<string, TaskRecord>,
  cutoff: number,
  minimized: ReadonlySet<string>,
): Set<string> {
  const shown = new Set<string>();
  // The rows whose parents come with them: pinned work closed before the
  // week lists in Pinned alone and pulls no old closed parent along.
  const reached = new Set<string>();
  const at = cutoff + BOARD_RECENT_MS;
  for (const record of records.values()) {
    if (
      !TaskService.isClosed(record) ||
      (record.closedAt ?? 0) >= cutoff ||
      minimized.has(record.id)
    ) {
      shown.add(record.id);
      reached.add(record.id);
    } else if (pinnedPastWeek(record, at)) shown.add(record.id);
  }
  for (const id of [...reached]) {
    let parentId = records.get(id)?.parentId;
    let depth = 0;
    while (parentId && !reached.has(parentId) && depth < 64) {
      let parent = records.get(parentId);
      if (!parent) {
        parent = reads.options.tasks.get(parentId);
        if (!parent) break;
        records.set(parent.id, parent);
      }
      shown.add(parent.id);
      reached.add(parent.id);
      parentId = parent.parentId;
      depth += 1;
    }
  }
  return shown;
}

/**
 * The rows at the other ends of the shown rows' edges, read when not in
 * hand (a view reads its blockers and its origin); a row no edge or row
 * needs leaves.
 */
function readEnds(
  reads: BoardReads,
  records: Map<string, TaskRecord>,
  shown: ReadonlySet<string>,
  links: ReadonlyMap<string, TaskLink>,
): void {
  const ends = new Set<string>();
  for (const link of links.values()) {
    if (!shown.has(link.fromId)) ends.add(link.fromId);
    if (!shown.has(link.toId)) ends.add(link.toId);
  }
  for (const record of reads.options.tasks.getMany([...ends].filter((id) => !records.has(id))))
    records.set(record.id, record);
  for (const id of [...records.keys()]) if (!shown.has(id) && !ends.has(id)) records.delete(id);
}

function cachedView(
  reads: BoardReads,
  record: TaskRecord,
  graph: Graph,
  tiers: ReadonlyMap<string, Slot>,
): CachedView {
  const facts = reads.liveFacts(record);
  return {
    view: viewOf(reads.options, record, graph, tiers, facts),
    facts: factsKey(facts),
    cards: cardFactsOf(record, graph),
  };
}

/** The edges across shown rows in canonical order; the last array while the set is the same. */
function linkViewsOf(
  links: ReadonlyMap<string, TaskLink>,
  shown: ReadonlySet<string>,
  previous?: Pick<BoardCache, "linkViews" | "linkKeys">,
): Pick<BoardCache, "linkViews" | "linkKeys"> {
  const linkKeys = new Set<string>();
  const views: TaskLinkView[] = [];
  for (const [key, link] of links) {
    if (!shown.has(link.fromId) || !shown.has(link.toId)) continue;
    linkKeys.add(key);
    views.push({ fromId: link.fromId, toId: link.toId, type: link.type });
  }
  if (
    previous &&
    previous.linkKeys.size === linkKeys.size &&
    [...linkKeys].every((key) => previous.linkKeys.has(key))
  )
    return { linkViews: previous.linkViews, linkKeys: previous.linkKeys };
  return { linkViews: sortBoardLinks(views), linkKeys };
}

function edgeKey(link: TaskLink): string {
  return `${link.fromId} ${link.toId} ${link.type}`;
}
