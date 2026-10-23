import { overridePasses } from "@shared/holds";
import type { TaskRecord } from "../storage/taskStore";
import { standingDependencyWaits } from "./dependencyWaits";

/**
 * What a task's Blocked by names: the waits that hold it now, one rule for
 * the board (`TaskProtocol`, which the stage's arrows read) and the tasks
 * reader the crew and the first mate query (`taskQuery.ts`), INF-999.
 *
 * - Open work: every live blocker, since each holds its start.
 * - Active work: a blocker whose edge holds its merge, unless the captain's
 *   words passed that hold (the recorded override, `overridePasses`); the
 *   live work its standing baseline wait names; and a recorded wait - an
 *   edge that holds no merge - only while its crewmate stands idle on its
 *   waits (posture idle, reason dependency), since the idle ladder holds it
 *   there. A crewmate working past a recorded wait is not held by it.
 * - Closed work: nothing.
 *
 * Closed blockers stay graph history and are never named here.
 */
export function holdingWaits(input: {
  record: TaskRecord;
  /** Every task a `blocks` edge into this one runs from. */
  blockers: readonly TaskRecord[];
  /** Whether that edge carries the must-merge-first mark. */
  holdsMerge: (blocker: TaskRecord) => boolean;
  /** Reads the task a standing baseline wait names. */
  tasks: { get(id: string): TaskRecord | undefined };
  /** Its crewmate is idle on its waits now (work posture idle, reason dependency). */
  idleOnWaits: boolean;
}): TaskRecord[] {
  const { record, blockers, holdsMerge, tasks, idleOnWaits } = input;
  const live = blockers.filter(isLive);
  if (record.status === "open") return live;
  if (record.status !== "active") return [];
  const delivery = record.delivery;
  const held = live.filter((blocker) =>
    holdsMerge(blocker)
      ? !overridePasses(delivery, holdKindOf(record, blocker), delivery?.headSha)
      : idleOnWaits,
  );
  const baseline = standingDependencyWaits(tasks, delivery)
    .map((wait) => wait.task)
    .filter((task) => isLive(task) && !isDeliveryChild(task));
  return [...new Map([...held, ...baseline].map((task) => [task.id, task])).values()];
}

/**
 * Which hold an override passes for this blocker: the host's review edge
 * passes with the review itself, every other marked edge with the waits.
 */
export function holdKindOf(record: TaskRecord, blocker: TaskRecord): "review" | "waits" {
  return blocker.parentId === record.id &&
    isDeliveryChild(blocker) &&
    blocker.shape?.kind === "review"
    ? "review"
    : "waits";
}

const isLive = (task: TaskRecord) => task.status === "open" || task.status === "active";

const isDeliveryChild = (task: TaskRecord) => task.shape?.kind_source?.startsWith("host:") ?? false;
