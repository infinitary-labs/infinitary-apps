import { providerLabel } from "@shared/modelSlots";
import type { TaskWait } from "@shared/taskWaits";
import type { AccountHold, WorkPosture } from "@shared/workPosture";
import type { TaskRecord } from "../storage/taskRecords";

/** The posture owner supplies these from the same snapshot, including simultaneous jobs and holds. */
export type TaskWaitFacts = { job: boolean; timerOwned: boolean; hold?: AccountHold };

/** Pure projection of owner-held facts. No reads, command parsing or scheduling. */
export function taskWaitsOf(input: {
  record: TaskRecord;
  holding: readonly TaskRecord[];
  since: Readonly<Record<string, number>>;
  posture?: WorkPosture;
  facts?: TaskWaitFacts;
  decision: boolean;
  /** It has parts of its own, which do its work; absent counts as none. */
  parts?: boolean;
}): TaskWait[] {
  const { record, holding, since, posture, facts, decision, parts } = input;
  if (record.status !== "open" && record.status !== "active") return [];
  const waits: TaskWait[] = holding.map((task) => ({
    id: `dependency:${task.id}`,
    kind: "dependency",
    label: `${task.key || task.id}${task.status === "dropped" ? " (dropped)" : ""}`,
    taskKeys: [task.key || task.id],
    ...(since[task.key || task.id] !== undefined ? { since: since[task.key || task.id] } : {}),
  }));
  const delivery = record.delivery;
  if (record.status === "active") {
    const watch = delivery?.ciWatch;
    if (watch && watch.head === delivery?.headSha)
      waits.push({
        id: `checks:${watch.head}`,
        kind: "checks",
        label: "Checks",
        since: watch.since,
        next: { kind: "next-read", at: watch.nextAt },
      });
    for (const run of delivery?.runWatches ?? [])
      waits.push({
        id: `run:${run.runId}:${run.attempt}`,
        kind: "run",
        label: run.name,
        since: run.since,
        next: { kind: "next-read", at: run.nextAt },
      });
  }
  const gate = record.gate;
  const back = delivery?.checkBack;
  const job = facts?.job ?? posture?.reason === "job";
  const ownsBack = Boolean(
    back &&
      record.backlogSince == null &&
      gate?.kind === "at-time" &&
      gate.until === back.until &&
      (facts?.timerOwned ?? job),
  );
  if (record.status === "active" && (job || ownsBack))
    waits.push({
      id: "job",
      kind: "job",
      label: ownsBack && back ? back.waitingFor : "Background work",
      ...(ownsBack && back
        ? { since: back.at, next: { kind: "check-back" as const, at: back.until } }
        : {}),
    });
  const hold = facts?.hold ?? posture?.hold;
  if (hold?.class === "no_headroom")
    waits.push({
      id: "allowance",
      kind: "allowance",
      label: `${hold.provider} allowance`,
      ...(hold.resetsAt !== undefined
        ? { next: { kind: "reset" as const, at: hold.resetsAt } }
        : {}),
    });
  else if (gate?.kind === "quota-reset")
    waits.push({
      id: "allowance",
      kind: "allowance",
      label: gate.ref?.startsWith("bucket:")
        ? `${gate.ref.slice(7)} model${gate.cause === "pictures" ? " that reads pictures" : gate.cause === "empty" ? "" : " allowance"}`
        : `${gate.ref ? providerLabel(gate.ref) : "Plan"} allowance`,
      ...(record.shape?.start_wait_since?.gate !== undefined
        ? { since: record.shape.start_wait_since.gate }
        : {}),
    });
  if (
    record.backlogSince == null &&
    gate?.kind === "at-time" &&
    !(back && back.until === gate.until) &&
    gate.until !== undefined
  )
    waits.push({
      id: "start",
      kind: "start",
      // A started task's hold names what it waits for (INF-5145).
      label:
        record.status === "open"
          ? "Scheduled start"
          : gate.reason?.trim() || "Scheduled continuation",
      ...(record.shape?.start_wait_since?.gate !== undefined
        ? { since: record.shape.start_wait_since.gate }
        : {}),
      next: { kind: "start", at: gate.until },
    });
  if (
    decision ||
    (record.status === "open" && gate?.kind === "captain") ||
    (posture?.state === "idle" && posture.reason === "captain")
  )
    waits.push({
      id: "decision",
      kind: "decision",
      label: "Waiting for your decision",
      ...(delivery?.captainWait ? { since: delivery.captainWait.at } : {}),
    });
  // A parent's parts do its work and it has no Start, so it never waits for
  // one: its record names what its parts do (INF-6805's plan, item 2).
  if (
    (record.status === "open" && record.startPolicy === "on-request" && !parts) ||
    (record.status === "active" && record.backlogSince != null)
  )
    waits.push({
      id: "backlog",
      kind: "backlog",
      label: "Waiting for Start",
      ...(record.backlogSince != null
        ? { since: record.backlogSince }
        : record.shape?.start_wait_since?.policy !== undefined
          ? { since: record.shape.start_wait_since.policy }
          : {}),
    });
  return waits;
}
