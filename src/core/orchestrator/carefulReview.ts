import type { Rigor } from "@shared/rigor";
import type { CrewMachines } from "../placed/crewMachines";
import type { TaskDelivery, TaskRecord } from "../storage/taskRecords";
import type { WorkspaceService } from "../workspace/workspaceService";
import { checkedOutHead } from "./checkedOutHead";
import { reviewCoversHead } from "./reviewCarry";

/** The committed version of Careful work that waits for its independent review. */
export type CarefulReviewOwed = { head: string };

/**
 * Careful work committed with no review open (INF-7116 fix 3): the task's
 * rigor is Careful, its branch holds commits of its own at `committedHead`,
 * no passed review covers that version and no review of the task is open.
 * The host starts no Careful review by itself, so only the first mate can
 * start one; this is the typed fact that wakes it. A review task reads a
 * change and owes no review of its own.
 */
export function carefulReviewOwed(input: {
  rigor: Rigor | undefined;
  kind: string | undefined;
  committedHead: string | undefined;
  reviewOpen: boolean;
  delivery: TaskDelivery | null | undefined;
}): CarefulReviewOwed | undefined {
  if (input.rigor !== "reviewed" || input.kind === "review") return undefined;
  if (!input.committedHead || input.reviewOpen) return undefined;
  if (reviewCoversHead(input.delivery, input.committedHead)) return undefined;
  return { head: input.committedHead };
}

/**
 * The version a task's branch holds commits of its own at, read where its
 * working copy lives, or undefined while it holds none or nothing answers.
 * Async git work: the report call reads it, so the report's sort at the
 * turn's end stays synchronous.
 */
export async function committedVersion(
  options: {
    machines?: Pick<CrewMachines, "checkedOut" | "workStatus">;
    workspace: Pick<WorkspaceService, "branchHead" | "taskWorkStatus">;
  },
  record: TaskRecord,
): Promise<string | undefined> {
  if (!record.branch) return undefined;
  const status = record.deviceId
    ? await options.machines?.workStatus(record.id)
    : record.worktreeDir
      ? await options.workspace.taskWorkStatus({
          taskId: record.id,
          cwd: record.worktreeDir,
          repoDir: record.repoDir,
          branch: record.branch,
        })
      : undefined;
  if (!status || status.unlandedCommits === 0) return undefined;
  return (
    (await checkedOutHead(options, record)) ??
    (record.deviceId
      ? undefined
      : ((await options.workspace.branchHead(record.repoDir, record.branch)) ?? undefined))
  );
}
