import type { AlreadyAllowed, ServedAllowance } from "@shared/captainAllowances";
import { standingOverride } from "@shared/holds";
import type { TaskRecord } from "../storage/taskStore";
import type { TaskService } from "./taskService";

type AllowedReaderTasks = Pick<TaskService, "get" | "byKey"> & {
  graph: Pick<TaskService["graph"], "escalatedFrom">;
  capture: Pick<TaskService["capture"], "handedOver">;
};

/**
 * The tasks whose work this one does again (INF-3170 piece 2, the
 * captain's pick "That task, its reviewer, a stronger-model retry and a
 * takeover of its work", and "Count branch takeovers" for a filing that
 * continues another task's branch): the task itself and every task whose
 * work it was handed (`TaskCapture.handedOver`: a `replaced-by` link into
 * it, the attempt it retries, the branch it continues) or that an older
 * stronger-model move names, through any number of earlier tasks. A follow-up a
 * merge filed is new work and is not in it. Its reviewer reads the builder's
 * list (`Reviews.reviewFacts`).
 */
export function sameWorkLineage(tasks: AllowedReaderTasks, record: TaskRecord): TaskRecord[] {
  const seen = new Set<string>();
  const lineage: TaskRecord[] = [];
  const pending: TaskRecord[] = [record];
  for (let task = pending.shift(); task; task = pending.shift()) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    lineage.push(task);
    const refs = [...tasks.capture.handedOver(task.id), ...tasks.graph.escalatedFrom(task.id)];
    for (const ref of refs) {
      const earlier = ref ? (tasks.get(ref) ?? tasks.byKey(ref)) : undefined;
      if (earlier && !seen.has(earlier.id)) pending.push(earlier);
    }
  }
  return lineage;
}

/**
 * What a turn on this task is served as already allowed: the captain's
 * override standing on the task itself at this version, and every yes the
 * app recorded on the task or on a task whose work it does again, oldest
 * first. The app reads none of the words.
 */
export function alreadyAllowed(
  tasks: AllowedReaderTasks,
  record: TaskRecord,
  head = record.delivery?.headSha,
): AlreadyAllowed {
  const override = standingOverride(record.delivery, head);
  const allowances: ServedAllowance[] = sameWorkLineage(tasks, record)
    .flatMap((task) =>
      (task.delivery?.captainAllowances ?? []).map((entry) =>
        task.id === record.id
          ? entry
          : { ...entry, from: { key: task.key || task.id, title: task.title } },
      ),
    )
    .sort((a, b) => a.at - b.at);
  return {
    ...(override
      ? { override: { words: override.words, holds: override.holds, until: override.until } }
      : {}),
    allowances,
  };
}
