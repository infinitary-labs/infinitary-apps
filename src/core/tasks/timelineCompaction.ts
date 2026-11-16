import { PERSONAL_READ_FIELD } from "@shared/personalSet";
import type { InsertTaskEvent, TaskEvent, TaskEventStore } from "../storage/taskEventStore";

/**
 * A timeline targets at most this many events (design section 5). Past it
 * the oldest fold into one `compacted` event down to TIMELINE_KEEP rows,
 * so the fold runs once per hundred events rather than on every write;
 * a fold that meets an earlier `compacted` row absorbs its counts, so the
 * head of a long timeline always says how much it stands for. Counts are
 * folded, never content summarized (design section 2.4: no memory decay).
 * Prospective provenance is exempt, so a provenance-heavy timeline may
 * exceed the target rather than discard its evidence, and so is every
 * event another task's Activity reads (docs/task-record.md, "Whom an event
 * concerns"), and so is every event whose data marks it `journal: true`,
 * a record a replay reads back (docs/programs.md, "The journal and replay").
 */
export const TIMELINE_CAP = 500;
export const TIMELINE_KEEP = 400;

/** What a `compacted` event carries in `data`. */
export type CompactedEventData = {
  folded: number;
  firstAt: number;
  lastAt: number;
  kinds: Record<string, number>;
  /**
   * The newest plan among the folded events, and when it was written, so a
   * reader of the newest plan still finds it (docs/task-record.md).
   */
  plan?: unknown[];
  planAt?: number;
  /**
   * The newest version of the home's personal set the folded events say a
   * conversation read, under the field they carried it in, so the Info tab
   * still names it (`personalReadOf`).
   */
  personal?: unknown;
  /** The highest folded program line number per op (docs/programs.md). */
  programLines?: Partial<Record<"log" | "phase", number>>;
};

function asCompacted(data: Record<string, unknown> | null): CompactedEventData | null {
  if (!data || typeof data.folded !== "number") return null;
  const kinds: Record<string, number> = {};
  if (data.kinds && typeof data.kinds === "object") {
    for (const [kind, n] of Object.entries(data.kinds as Record<string, unknown>)) {
      if (typeof n === "number") kinds[kind] = n;
    }
  }
  return {
    folded: data.folded,
    firstAt: typeof data.firstAt === "number" ? data.firstAt : Number.POSITIVE_INFINITY,
    lastAt: typeof data.lastAt === "number" ? data.lastAt : 0,
    kinds,
    ...(Array.isArray(data.plan) && typeof data.planAt === "number"
      ? { plan: data.plan, planAt: data.planAt }
      : {}),
    ...(data.programLines && typeof data.programLines === "object"
      ? { programLines: data.programLines as CompactedEventData["programLines"] }
      : {}),
  };
}

/** Keep the folded events' newest plan and highest program line numbers on the fold. */
function keepLatest(
  data: CompactedEventData,
  plan: unknown,
  planAt: number,
  lines: CompactedEventData["programLines"],
): void {
  if (Array.isArray(plan) && planAt >= (data.planAt ?? Number.NEGATIVE_INFINITY)) {
    data.plan = plan;
    data.planAt = planAt;
  }
  for (const op of ["log", "phase"] as const) {
    const n = lines?.[op];
    if (typeof n === "number" && n > (data.programLines?.[op] ?? 0))
      data.programLines = { ...data.programLines, [op]: n };
  }
}

/**
 * Fold the oldest ordinary events of an over-cap timeline into one
 * `compacted` row. Prospective provenance stays verbatim so its contract,
 * lineage and control evidence remain available to offline readers. Runs
 * inside the write that pushed the timeline past the target. The fold
 * takes whole timestamps: compactable events sharing the boundary's
 * millisecond go with it, so the compacted row - stamped at the boundary -
 * sorts before everything it stands for.
 */
export function compactTimeline(events: TaskEventStore, taskId: string): TaskEvent | undefined {
  const count = events.countFor(taskId);
  if (count <= TIMELINE_CAP) return undefined;
  const oldest = events.oldestCompactable(taskId, count - TIMELINE_KEEP + 1);
  const boundary = oldest.at(-1)?.at;
  if (boundary === undefined) return undefined;
  const upTo = events.compactableUpTo(taskId, boundary);
  const compactableCount = events.countCompactable(taskId);
  const folded = upTo.length < compactableCount ? upTo : oldest;
  if (folded.length <= 1) return undefined;
  const data: CompactedEventData = { folded: 0, firstAt: boundary, lastAt: boundary, kinds: {} };
  for (const event of folded) {
    const prior = event.kind === "compacted" ? asCompacted(event.data) : null;
    if (prior) {
      data.folded += prior.folded;
      data.firstAt = Math.min(data.firstAt, prior.firstAt);
      for (const [kind, n] of Object.entries(prior.kinds)) {
        data.kinds[kind] = (data.kinds[kind] ?? 0) + n;
      }
      keepLatest(data, prior.plan, prior.planAt ?? 0, prior.programLines);
      if (event.data?.[PERSONAL_READ_FIELD] !== undefined)
        data.personal = event.data[PERSONAL_READ_FIELD];
      continue;
    }
    data.folded += 1;
    data.firstAt = Math.min(data.firstAt, event.at);
    data.kinds[event.kind] = (data.kinds[event.kind] ?? 0) + 1;
    if (event.data?.[PERSONAL_READ_FIELD] !== undefined)
      data.personal = event.data[PERSONAL_READ_FIELD];
    const line = event.data?.programLine as { op?: unknown; n?: unknown } | undefined;
    keepLatest(
      data,
      event.kind === "progress" ? event.data?.plan : undefined,
      event.at,
      (line?.op === "log" || line?.op === "phase") && typeof line.n === "number"
        ? { [line.op]: line.n }
        : undefined,
    );
  }
  events.deleteIds(folded.map((event) => event.id));
  const compacted: InsertTaskEvent = {
    taskId,
    at: boundary,
    actor: "host",
    kind: "compacted",
    text: `${data.folded} earlier events folded`,
    data,
    feed: false,
  };
  const id = events.insert(compacted);
  return { ...compacted, id, data, ref: null, feed: false };
}
