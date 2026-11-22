import type { TaskView } from "@shared/tasks";
import type { TaskRecord } from "../storage/taskRecords";

export type WaitChain = NonNullable<TaskView["waitChain"]>;

/**
 * Where a started task's wait on other work stops (INF-5578 finding 4), so
 * its row names that task and until when instead of the first link alone.
 *
 * The first task is the one it waits on: its lone holding wait, or, with
 * none, the change a review waits for once that change's record carries
 * this review's verdict and the change is still live; a review that has not
 * answered yet is not waiting on its change but stalled, and keeps reading
 * so. From there
 * each task's own lone holding wait is followed, through typed links only,
 * until a task holds no lone wait, is held (its `at-time` gate, the hold
 * the first mate gives), or the line comes back on itself. Several waits at
 * any step stop the line there: no one of them stands for the rest.
 */
export function waitChainOf(input: {
  record: TaskRecord;
  /** What `holdingWaits` returned for the record. */
  holding: readonly TaskRecord[];
  /** The waits holding another task now, by the same rule (`holdingWaits`). */
  holdingOf: (task: TaskRecord) => readonly TaskRecord[];
  /** The change a review waits for, when the record is one (`reviewBuilderOf`). */
  reviewed: TaskRecord | undefined;
}): WaitChain | undefined {
  const { record, holding, holdingOf, reviewed } = input;
  if (record.status !== "active") return undefined;
  const first =
    holding.length === 1
      ? holding[0]
      : holding.length === 0 && reviewed && isLive(reviewed) && answered(record, reviewed)
        ? reviewed
        : undefined;
  if (!first) return undefined;
  const seen = new Set([record.id]);
  let end = first;
  while (!seen.has(end.id) && !held(end)) {
    seen.add(end.id);
    const next = holdingOf(end);
    if (next.length !== 1 || !next[0] || seen.has(next[0].id)) break;
    end = next[0];
  }
  const gate = held(end) ? end.gate : undefined;
  return {
    on: keyOf(first),
    ...(end.id !== first.id ? { end: keyOf(end) } : {}),
    ...(gate?.update
      ? { update: true as const }
      : gate?.until !== undefined
        ? { until: gate.until }
        : {}),
  };
}

/** The change's recorded verdict came after this review opened (`TaskGraph.verdictReviewOf`). */
const answered = (review: TaskRecord, change: TaskRecord) => {
  const at = change.delivery?.reviewedAt;
  return change.delivery?.reviewVerdict !== undefined && at !== undefined && review.createdAt <= at;
};

const isLive = (task: TaskRecord) => task.status === "open" || task.status === "active";

const held = (task: TaskRecord) => task.status === "active" && task.gate?.kind === "at-time";

const keyOf = (task: TaskRecord) => task.key || task.id;
