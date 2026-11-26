import * as m from "./i18n/messages.generated.ts";
import type { TaskView } from "./tasks.ts";

/** How long a start may prepare before the record says it is still starting. */
const SLOW_START_MS = 15_000;

export type RecordStartInput = Pick<
  TaskView,
  "activity" | "startedAt" | "startAttempt" | "startNotice"
>;

/**
 * What the task record says of its start, read from the task's typed start
 * fields and the time. The desktop record and the phone's (through
 * scripts/generate-phone-scene.ts) both read it here.
 *
 * - `reason`: the status pill's reason while a start is in flight or after
 *   one failed; null where the shared status's own reason stands.
 * - `notice`: why a start could not begin, which the bar says between Drop
 *   task and Try again. It is never said in the title row (INF-3362), so a
 *   failed start leaves the pill's reason empty.
 */
export type RecordStart = { reason: string | null; notice: string | null };

export function recordStartOf(task: RecordStartInput, now: number): RecordStart {
  const notice = task.startNotice
    ? m.cardRecordCouldNotStart({ reason: task.startNotice.reason })
    : null;
  const preparing = task.startAttempt?.phase === "preparing" || task.activity === "starting";
  const since = task.startAttempt?.since ?? (task.activity === "starting" ? task.startedAt : null);
  const reason =
    task.startAttempt?.phase === "checking"
      ? m.cardRecordChecking()
      : preparing && since != null && now - since >= SLOW_START_MS
        ? m.cardRecordStillStarting()
        : notice !== null
          ? ""
          : null;
  return { reason, notice };
}
