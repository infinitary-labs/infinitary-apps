import { regionalLocale } from "@shared/i18n/current";
import { dateTimeFormat } from "@shared/i18n/format";
import { providerLabel } from "@shared/modelSlots";
import type { TaskView } from "@shared/tasks";
import type { TaskRecord } from "../storage/taskRecords";

/** Only unstarted work reads a start wait; callers can avoid fetching its unused inputs. */
export function hasStartQueueWait(
  record: Pick<TaskRecord, "status" | "kind" | "activity">,
): boolean {
  return record.status === "open" && record.kind === "work" && record.activity !== "starting";
}

/**
 * The clock words of a wait's start, in this computer's language and time
 * zone. `toLocaleString` with options builds a new formatter on every call,
 * about half a millisecond each, and a board build reads one for every
 * unstarted row (INF-3453), so the formatter is kept for the zone and
 * language it was built in and built again once either moves.
 */
const SINCE_FORMAT = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
} as const;
let sinceFormat: { place: string; format: Intl.DateTimeFormat } | undefined;
function sinceWords(since: number): string {
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  const place = `${regionalLocale() ?? locale} ${timeZone}`;
  if (sinceFormat?.place !== place) sinceFormat = { place, format: dateTimeFormat(SINCE_FORMAT) };
  return sinceFormat.format.format(since);
}

/** A start wait reads typed sources only. No scheduler decision or cached readiness. */
export function queueWaitOf(
  record: TaskRecord,
  blockers: readonly TaskRecord[],
  links: readonly { fromId: string; toId: string; type: string; createdAt: number }[],
  parts: readonly TaskRecord[] = [],
): TaskView["queueWait"] {
  if (!hasStartQueueWait(record)) return undefined;
  const dated = (reason: string, since?: number): NonNullable<TaskView["queueWait"]> => ({
    line: `${reason} · ${since === undefined ? "start of wait not recorded" : `since ${sinceWords(since)}`}`,
    ...(since === undefined ? {} : { since }),
  });
  // A dropped prerequisite still holds START; name it rather than inventing readiness.
  const holding = blockers.filter((task) => task.status !== "done");
  if (holding.length) {
    const sinceByBlocker = new Map<string, number>();
    for (const link of links) {
      if (link.type === "blocks" && link.toId === record.id && !sinceByBlocker.has(link.fromId))
        sinceByBlocker.set(link.fromId, link.createdAt);
    }
    const dates = holding.map((task) => sinceByBlocker.get(task.id));
    return dated(
      `Waiting for ${holding.map((task) => `${task.key || task.id}${task.status === "dropped" ? " (dropped)" : ""}`).join(", ")}`,
      dates.every((at) => at !== undefined) ? Math.min(...(dates as number[])) : undefined,
    );
  }
  const holdingParts = parts.filter((part) => part.status === "open" || part.status === "active");
  if (holdingParts.length) {
    return dated("Waiting for its parts", Math.min(...holdingParts.map((part) => part.createdAt)));
  }
  const gate = record.gate;
  const stamps = record.shape?.start_wait_since;
  if (gate) {
    const reason =
      gate.kind === "captain"
        ? "Waiting for your decision"
        : gate.kind === "at-time"
          ? "Waiting for its start time"
          : gate.ref?.startsWith("bucket:")
            ? `Waiting for a ${gate.ref.slice("bucket:".length)} model with allowance`
            : `Waiting for ${gate.ref ? providerLabel(gate.ref) : "a plan’s"} allowance`;
    return dated(reason, stamps?.gate);
  }
  const since = Math.max(
    record.createdAt,
    stamps?.policy ?? 0,
    stamps?.gate ?? 0,
    stamps?.dependencies ?? 0,
    ...blockers.map((task) => task.closedAt ?? record.createdAt),
    ...parts.map((part) => part.closedAt ?? record.createdAt),
  );
  if (record.startPolicy === "on-request") return dated("Waiting for the first mate’s go", since);
  const placement = record.shape?.placement_wait;
  if (placement)
    return dated(
      placement.words,
      placement.since === undefined ? undefined : Math.max(since, placement.since),
    );
  return dated("Waiting for a computer to start it", since);
}
