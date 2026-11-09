/**
 * A hold the host placed on a task, and how to get out of it (contract v3.6,
 * captain lock 3 of 2026-09-19 on the visual-density audit, 4.4b rows 7 and
 * 8). Three host state machines - the CI round cap, the review round cap, and
 * the escalation gate a crewmate's own "I am blocked" runs into - each need
 * the captain, and each reached him the same way: a wake or a refusal that
 * SPELLED OUT the card to write, in prose, in three places, while the host
 * already held every fact and every option. The audit found all eight cap
 * cards carrying the same three options under five different labelings.
 *
 * So a hold is an OUTCOME with ways out, the way a close refusal has been
 * since WI-12 (`SettleRefusal`): `text` is the facts in one line, for the
 * wake's prose and the feed, and `ways` is what the Firstmate runs to take
 * each one - a pointing gesture, never a host mutation of its own. The
 * Firstmate turns them into the card's actions; nothing here says "emit a
 * card", because the card rule in its prompt already does.
 */

import type { HoldKind } from "@shared/holds";
import { DROP_TASK_LABEL } from "@shared/recordDrop";
import { type RecoveryWay, recoveryConsent } from "@shared/recovery";
import { escalationFloor } from "../routing/policy";

/**
 * The stall's park (INF-3143, direction A): a blocker no steer can change
 * waits in the backlog, its work kept, instead of the idle ladder starting
 * over on every steer.
 */
export const BACKLOG_PARK_LABEL = "Park it in the backlog until something changes";

/** One way out of a hold: exactly what the Firstmate runs to take it. */
export type HoldWay = {
  hold?: HoldKind;
  approach?: RecoveryWay["approach"];
  label: string;
  tool: "steer_crewmate" | "spawn_crewmate" | "settle_task" | "interrupt_crewmate" | "update_task";
  args: Record<string, unknown>;
};

export type HoldRefusal = {
  held: "ci-cap" | "review-cap" | "escalation-needs-captain" | "idle-stall" | "captain-gate";
  task: { id: string; title?: string };
  ways: HoldWay[];
  text: string;
};

/**
 * The three ways out of a crew hold, in the order the audit found every cap
 * card offering them: keep going, go stronger, or stop. Named once here so
 * the CI cap, the review cap and the escalation gate cannot drift apart the
 * way their prose did.
 */
export function premiumRetryPossible(task?: {
  difficulty?: "low" | "medium" | "high" | "premium" | null;
  shape?: { escalation?: { attempt: number } } | null;
}): boolean {
  if (!task) return true;
  return !(
    "refused" in
    escalationFloor(task.difficulty ?? "medium", (task.shape?.escalation?.attempt ?? 0) + 1)
  );
}

export function crewHoldWays(
  taskId: string,
  task?: Parameters<typeof premiumRetryPossible>[0],
  eligible = premiumRetryPossible(task),
  premiumCanServe = true,
): HoldWay[] {
  return [
    {
      label: "Retry with the captain's guidance",
      tool: "steer_crewmate",
      args: { task_id: taskId },
    },
    ...(eligible
      ? [
          {
            label: premiumCanServe ? "Try a premium model" : "Try a stronger model",
            tool: "spawn_crewmate" as const,
            args: {
              shape: {
                escalate_from: taskId,
                ...(premiumCanServe ? { premium_ask: true } : {}),
              },
            },
          },
        ]
      : []),
    {
      label: "Discard the work",
      tool: "settle_task",
      args: { task_id: taskId, mode: "discard" },
    },
  ];
}

/**
 * The ways out of an idle stall (docs/report-sort.md, "The idle ladder"):
 * a crewmate that stopped with nothing running, no card up and nothing
 * queued, after the host's own nudge did not move it. Tell it what to do,
 * park it in the backlog with its work kept until news reaches it or a
 * Start (INF-3143's direction A: a blocker no steer can change parks
 * where its wait shows, rather than starting the cycle again), drop the
 * task, or throw the work away. Its host card offers the captain the same
 * steer, park and discard if the Firstmate takes none.
 */
export function idleStallWays(taskId: string): HoldWay[] {
  return [
    {
      hold: "waits",
      approach: "workaround",
      label: "Tell it what to do next",
      tool: "steer_crewmate",
      args: { task_id: taskId },
    },
    {
      hold: "waits",
      approach: "workaround",
      label: BACKLOG_PARK_LABEL,
      tool: "update_task",
      args: { task: taskId, start_policy: "on-request" },
    },
    {
      label: DROP_TASK_LABEL,
      tool: "interrupt_crewmate",
      args: { task_id: taskId, mode: "cancel" },
    },
    {
      label: "Discard the work",
      tool: "settle_task",
      args: { task_id: taskId, mode: "discard" },
    },
  ];
}

/**
 * A hold as it rides a wake or a tool result: the facts in prose, then the
 * ways as a fenced JSON block - the same shape `wakeOnSettle` uses for a
 * structured close refusal, so the Firstmate reads one format. `text` is
 * deliberately left OUT of the block: the prose above it IS that sentence,
 * and repeating it would put the same claim in the model's context twice.
 */
export function renderHold(hold: HoldRefusal): string {
  const { text, ...structured } = hold;
  structured.ways = hold.ways.map(({ hold, approach, ...way }) => ({
    ...way,
    ...recoveryConsent(hold ?? "asks-first", approach),
  }));
  return `${text}\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``;
}
