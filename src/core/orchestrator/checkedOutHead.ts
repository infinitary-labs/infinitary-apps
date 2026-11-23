import { existsSync } from "node:fs";
import type { CrewMachines } from "../placed/crewMachines";
import type { TaskRecord } from "../storage/taskRecords";
import { git } from "../workspace/git";
import type { WorkspaceService } from "../workspace/workspaceService";

/**
 * The commit a task's working copy has checked out, read where it lives:
 * the version its crewmate committed, as a story reads it (INF-2490). A
 * crewmate that commits on another branch it checked out, and pushes that
 * to the task's branch where the project lives, leaves the task's own
 * branch behind, so a review or a proof read there judges a version nobody
 * built. Undefined where nothing answers, such as a computer on an older
 * contract, and the caller reads the task's branch.
 */
export async function checkedOutHead(
  options: {
    machines?: Pick<CrewMachines, "checkedOut">;
    workspace: Pick<WorkspaceService, "branchHead">;
  },
  record: TaskRecord,
): Promise<string | undefined> {
  if (record.deviceId) return (await options.machines?.checkedOut(record.id))?.head;
  if (!record.worktreeDir) return undefined;
  return (await options.workspace.branchHead(record.worktreeDir, "HEAD")) ?? undefined;
}

/**
 * The branch a task's working copy has checked out where it lives, when
 * that is not the task's own: the branch its crewmate committed on, as a
 * story follows it (INF-2490). A successor handed the task's own branch
 * then starts from work nobody built. Undefined on the task's own branch,
 * on a detached checkout, or where nothing answers, as a computer on an
 * older contract does: the caller hands on the task's own branch, as a
 * story does then.
 */
export async function otherCheckedOutBranch(
  options: { machines?: Pick<CrewMachines, "checkedOut"> },
  record: TaskRecord,
): Promise<string | undefined> {
  const dir = record.worktreeDir;
  const branch = record.deviceId
    ? (await options.machines?.checkedOut(record.id))?.branch
    : dir && existsSync(dir)
      ? await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined)
      : undefined;
  return branch && branch !== record.branch ? branch : undefined;
}
