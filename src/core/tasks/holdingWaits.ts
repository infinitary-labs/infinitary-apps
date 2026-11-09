import { overridePasses } from "@shared/holds";
import type { TaskRecord } from "../storage/taskStore";
import { type DependencyWait, standingDependencyWaits } from "./dependencyWaits";

/**
 * What a task's Blocked by names: the waits that hold it now, one rule for
 * the board (`TaskProtocol`, which the stage's arrows read) and the tasks
 * reader the crew and the first mate query (`taskQuery.ts`), INF-999.
 *
 * - Open work: every live blocker, since each holds its start.
 * - Active work: every live blocker, since each holds its merge until that
 *   work closes (INF-3167, the captain's choice A), unless the captain's
 *   words passed that hold (the recorded override, `overridePasses`); and
 *   the live work its standing baseline wait names.
 * - Closed work: nothing.
 *
 * Closed blockers stay graph history and are never named here.
 */
export function holdingWaits(input: {
  record: TaskRecord;
  /** Every task a `blocks` edge into this one runs from. */
  blockers: readonly TaskRecord[];
  /** Reads the task a standing baseline wait names. */
  tasks: { get(id: string): TaskRecord | undefined };
  /** A projection shares this row's derived baseline waits with its date read. */
  baseline?: readonly DependencyWait[];
}): TaskRecord[] {
  const { record, blockers, tasks } = input;
  const live = blockers.filter(isLive);
  if (record.status === "open") return live;
  if (record.status !== "active") return [];
  const delivery = record.delivery;
  const held = overridePasses(delivery, "waits", delivery?.headSha) ? [] : live;
  const baseline = (input.baseline ?? standingDependencyWaits(tasks, delivery))
    .map((wait) => wait.task)
    .filter((task) => isLive(task) && !isDeliveryChild(task));
  return [...new Map([...held, ...baseline].map((task) => [task.id, task])).values()];
}

const isLive = (task: TaskRecord) => task.status === "open" || task.status === "active";

const isDeliveryChild = (task: TaskRecord) => task.shape?.kind_source?.startsWith("host:") ?? false;

/**
 * When each wait that holds a task now was recorded, by blocker key (INF-38):
 * the `blocks` edge's own time and the declaration time of a standing
 * baseline wait that names the same task. Several sources take the
 * earliest, and only when every one is dated; a blocker with any undated
 * source is left out, so the time is never guessed. Never the task's
 * update time, its last report or its idle clock.
 */
export function waitsSince(input: {
  record: TaskRecord;
  /** What `holdingWaits` returned for it. */
  holding: readonly TaskRecord[];
  /** The graph's edges; only `blocks` edges into this task are read. */
  links: readonly { fromId: string; toId: string; type: string; createdAt: number }[];
  tasks: { get(id: string): TaskRecord | undefined };
  baseline?: readonly DependencyWait[];
}): Record<string, number> {
  const { record, holding, links, tasks } = input;
  if (holding.length === 0) return {};
  const sources = new Map<string, (number | undefined)[]>();
  const add = (id: string, at: number | undefined) =>
    sources.set(id, [...(sources.get(id) ?? []), at]);
  for (const link of links) {
    if (link.type === "blocks" && link.toId === record.id) add(link.fromId, link.createdAt);
  }
  for (const wait of input.baseline ?? standingDependencyWaits(tasks, record.delivery))
    add(wait.task.id, wait.since);
  const since: Record<string, number> = {};
  for (const blocker of holding) {
    const times = sources.get(blocker.id) ?? [];
    if (times.length === 0 || times.some((at) => at === undefined)) continue;
    since[blocker.key || blocker.id] = Math.min(...(times as number[]));
  }
  return since;
}
