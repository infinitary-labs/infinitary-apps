import {
  keptRecoveryWaySchema,
  recoveryWay,
  type WorkWait,
  workWaitSchema,
} from "@shared/recovery";
import type { TaskEvent, TaskEventActor } from "../storage/taskEventStore";

/**
 * A report as a typed durable entry (INF-1296 piece 1, docs/task-record.md
 * "Reports and results"): the `report` event `TaskService.recordReport`
 * commits is the one record of a report and the result it carried. The
 * task row's `outcome` columns are the newest report's index, kept in the
 * same transaction, and the latest result is read from the entries
 * (`latestResult`), never from a second copy.
 *
 * Reading never throws: a field an older writer stored in another shape is
 * left out, never guessed, and the report's words stay whole.
 */
export const REPORT_ENTRY_VERSION = 1;

export type ReportEntry = {
  version: typeof REPORT_ENTRY_VERSION;
  eventId: number;
  taskId: string;
  at: number;
  actor: TaskEventActor;
  /** The report's words, whole. */
  text: string;
  /** The one-line summary the writer stored with it; null when it stored none. */
  summary: string | null;
  /** The typed result it carried, as the host checked it; null when it carried none. */
  result: Record<string, unknown> | null;
  /** What it declared about whose turn followed it, as recorded then (it no longer stands). */
  declared: {
    workWait?: WorkWait;
    recoveryWays?: ReturnType<typeof recoveryWay>[];
    waitingOnCaptain?: { reason: string; cardId?: string };
    finished?: true;
    needsFirstmate?: string;
    checkBack?: { until: number; waitingFor: string };
  };
};

/** A task's latest typed result: the newest one a report carried. */
export type TaskResult = { at: number; value: Record<string, unknown> };

/** A `report` event as its typed entry. */
export function reportEntryOf(event: TaskEvent): ReportEntry {
  if (event.kind !== "report") throw new Error(`Event ${event.id} is not a report.`);
  const data = event.data ?? {};
  const wait = plainObject(data.waitingOnCaptain);
  const checkBack = plainObject(data.checkBack);
  const workWait = workWaitSchema.safeParse(data.workWait);
  const recoveryWays = Array.isArray(data.recoveryWays)
    ? data.recoveryWays.flatMap((way) => {
        const read = keptRecoveryWaySchema.safeParse(way);
        return read.success ? [recoveryWay(read.data)] : [];
      })
    : undefined;
  const declared: ReportEntry["declared"] = {
    ...(workWait.success ? { workWait: workWait.data } : {}),
    ...(recoveryWays?.length ? { recoveryWays } : {}),
    ...(wait && typeof wait.reason === "string"
      ? {
          waitingOnCaptain: {
            reason: wait.reason,
            ...(typeof wait.cardId === "string" ? { cardId: wait.cardId } : {}),
          },
        }
      : {}),
    ...(data.finished === true ? { finished: true as const } : {}),
    ...(typeof data.needsFirstmate === "string" ? { needsFirstmate: data.needsFirstmate } : {}),
    ...(checkBack && typeof checkBack.until === "number" && typeof checkBack.waitingFor === "string"
      ? { checkBack: { until: checkBack.until, waitingFor: checkBack.waitingFor } }
      : {}),
  };
  return {
    version: REPORT_ENTRY_VERSION,
    eventId: event.id,
    taskId: event.taskId,
    at: event.at,
    actor: event.actor,
    text: event.text,
    summary: typeof data.summary === "string" && data.summary ? data.summary : null,
    result: plainObject(data.result) ?? null,
    declared,
  };
}

/**
 * The latest result between the newest report entry that carried one and
 * a copy an older release kept on the task's delivery facts
 * (`TaskDelivery.result`, written until INF-1296 piece 1). The copy is
 * kept as it was and still read, with the precedence it had: it stands
 * unless a report written after it carried a newer result.
 */
export function latestResultOf(
  entry: ReportEntry | undefined,
  legacy: TaskResult | undefined,
): TaskResult | undefined {
  const fromEntry = entry?.result ? { at: entry.at, value: entry.result } : undefined;
  if (legacy && (!fromEntry || legacy.at >= fromEntry.at)) return legacy;
  return fromEntry;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
