import { providerLabel } from "@shared/modelSlots";
import type { TaskView } from "@shared/tasks";
import type { TaskRecord } from "../storage/taskStore";

/** A start wait reads typed sources only. No scheduler decision or cached readiness. */
export function queueWaitOf(
  record: TaskRecord,
  blockers: readonly TaskRecord[],
  links: readonly { fromId: string; toId: string; type: string; createdAt: number }[],
  parts: readonly TaskRecord[] = [],
): TaskView["queueWait"] {
  if (record.status !== "open" || record.kind !== "work" || record.activity === "starting")
    return undefined;
  const dated = (reason: string, since?: number): NonNullable<TaskView["queueWait"]> => ({
    line: `${reason} · ${since === undefined ? "start of wait not recorded" : `since ${new Date(since).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}`,
    ...(since === undefined ? {} : { since }),
  });
  // A dropped prerequisite still holds START; name it rather than inventing readiness.
  const holding = blockers.filter((task) => task.status !== "done");
  if (holding.length) {
    const dates = holding.map(
      (task) =>
        links.find(
          (link) => link.type === "blocks" && link.fromId === task.id && link.toId === record.id,
        )?.createdAt,
    );
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
