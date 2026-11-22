import { z } from "zod";
import { dateTimeFormat } from "./i18n/format.ts";
import { type TaskStatusInput, type TaskStatusReading, waitChainWords } from "./taskPresentation";

/** Read-only standing facts; absent on older homes, empty when nothing stands. */
export const taskWaitSchema = z.object({
  id: z.string(),
  kind: z.enum(["dependency", "checks", "run", "job", "allowance", "start", "decision", "backlog"]),
  label: z.string(),
  taskKeys: z.array(z.string()).optional(),
  since: z.number().optional(),
  next: z
    .object({ kind: z.enum(["next-read", "check-back", "reset", "start"]), at: z.number() })
    .optional(),
});
export type TaskWait = z.infer<typeof taskWaitSchema>;

/** Self-contained so the sandboxed record uses exactly the same local-clock formatter. */
export function taskWaitText(
  wait: TaskWait,
  now: number,
  detail = true,
  zone?: string,
  line?: NonNullable<TaskStatusInput["waitChain"]>,
): string {
  const clock = (at: number) => {
    const date = new Date(at);
    const day = (value: number) =>
      dateTimeFormat({
        timeZone: zone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).format(value);
    // Always include the zone: the repeated daylight-saving hour must identify an instant.
    return dateTimeFormat({
      timeZone: zone,
      ...(day(at) !== day(now) ? { month: "short" as const, day: "numeric" as const } : {}),
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  };
  const words = {
    "next-read": "next read",
    "check-back": "check-back",
    reset: "reset",
    start: "start time",
  };
  const event = wait.next
    ? `${words[wait.next.kind]}${wait.next.at <= now ? " was due" : ""} ${clock(wait.next.at)}`
    : "time unknown";
  const recorded =
    detail && wait.since !== undefined ? ` · wait recorded ${clock(wait.since)}` : "";
  // A lone task wait whose line goes further, or ends in a hold, says where
  // it stops in place of its label and unknown time, as the tile does (INF-5578).
  if (line) return `${waitChainWords(line, now)}${recorded}`;
  return `${detail ? `${wait.label} · ` : ""}${event}${recorded}`;
}

/** Group only names, never facts; a standing overdue event stays before a later event. */
export function taskWaitSummary(
  waits: readonly TaskWait[],
  now: number,
): { names: string; event: string } | null {
  if (!waits.length) return null;
  const groups = new Map<TaskWait["kind"], TaskWait[]>();
  for (const wait of waits) groups.set(wait.kind, [...(groups.get(wait.kind) ?? []), wait]);
  const plurals: Partial<Record<TaskWait["kind"], string>> = {
    dependency: "tasks",
    checks: "check watches",
    run: "watched runs",
    job: "jobs",
  };
  const names = [...groups]
    .map(([kind, entries]) =>
      entries.length === 1 ? entries[0]?.label : `${entries.length} ${plurals[kind] ?? "waits"}`,
    )
    .join(" + ");
  const events = waits
    .flatMap((wait) => (wait.next ? [{ wait, next: wait.next }] : []))
    .sort((a, b) => a.next.at - b.next.at);
  const first = events[0];
  if (!first) return { names, event: "time unknown" };
  const tied = events.filter((wait) => wait.next.at === first.next.at);
  const kinds = new Set(tied.map((wait) => wait.next.kind));
  const event =
    kinds.size === 1
      ? taskWaitText(first.wait, now, false)
      : taskWaitText(first.wait, now, false).replace(
          /^(next read|check-back|reset|start time)/,
          "next events",
        );
  return { names, event };
}

export const checksWait = (wait: TaskWait): boolean =>
  wait.kind === "checks" || wait.kind === "run";

/**
 * Where a lone task wait's line stops (`TaskView.waitChain`), only when that
 * says more than the task waited on: a further task, a time or an app
 * update (INF-5578). The board tile and the task card both name it.
 */
export function waitStopsOf(task: {
  waits?: readonly TaskWait[];
  waitChain?: TaskStatusInput["waitChain"];
}): { wait: TaskWait; line: NonNullable<TaskStatusInput["waitChain"]> } | undefined {
  const wait = task.waits?.length === 1 ? task.waits[0] : undefined;
  const line = task.waitChain;
  return wait?.kind === "dependency" &&
    line &&
    wait.label === line.on &&
    (line.end !== undefined || line.until !== undefined || line.update)
    ? { wait, line }
    : undefined;
}

/** The record's existing attention box owns everything except checks and a lone job check-back. */
export function recordAttentionWaits(task: {
  waits?: readonly TaskWait[];
  blockedBy?: readonly string[];
  hold?: unknown;
  queueWait?: unknown;
  activity?: string | null;
  waitingCardId?: string | null;
}): TaskWait[] {
  const waits =
    task.waits?.filter(
      (wait) =>
        wait.kind !== "checks" &&
        wait.kind !== "run" &&
        (wait.kind !== "decision" || !task.waitingCardId),
    ) ?? [];
  const box = Boolean(
    task.hold ||
      task.queueWait ||
      task.blockedBy?.length ||
      task.activity === "interrupted" ||
      waits.some((wait) => wait.kind !== "job"),
  );
  return box ? waits : [];
}

/**
 * Only the task card calls this; the shared list status, and the hover
 * preview's, keep their short reason (INF-2528), except that a lone wait
 * names where its line stops and that task's hold (INF-5578, `taskStatusOf`).
 */
export function taskWaitStatus(
  task: TaskStatusInput & { waits?: readonly TaskWait[]; hold?: unknown },
  reading: TaskStatusReading,
  now: number,
): TaskStatusReading {
  if (!task.waits?.length || reading.mark === "done" || reading.mark === "dropped") return reading;
  const owned = new Set(recordAttentionWaits(task).map((wait) => wait.id));
  const remaining = task.waits.filter((wait) => !checksWait(wait) && !owned.has(wait.id));
  const reason = remaining
    .map((wait) =>
      taskWaitText(
        wait.kind === "decision" && reading.mark === "waiting" && reading.reason
          ? { ...wait, label: reading.reason }
          : wait,
        now,
      ),
    )
    .join("; ");
  if (reading.mark === "waiting" && remaining.some((wait) => wait.kind === "decision"))
    return { ...reading, reason };
  // Do not discard a distinct typed warning merely because another wait exists.
  const represented =
    !reading.reason ||
    task.workPosture?.reason === "checks" ||
    task.workPosture?.reason === "job" ||
    task.workPosture?.reason === "dependency" ||
    (task.workPosture?.reason === "captain" &&
      task.waits.some((wait) => owned.has(wait.id) && wait.kind === "decision")) ||
    task.workPosture?.reason === "timed-wait" ||
    (task.workPosture?.reason === "access" && task.workPosture.hold?.class === "no_headroom") ||
    task.status === "open";
  const warning =
    reading.outOfReach ||
    reading.mark === "starting" ||
    reading.mark === "interrupted" ||
    reading.mark === "waiting" ||
    task.startNotice;
  if (!warning && represented) return { ...reading, reason };
  return reason
    ? { ...reading, reason: [reading.reason, reason].filter(Boolean).join(" · ") }
    : reading;
}
