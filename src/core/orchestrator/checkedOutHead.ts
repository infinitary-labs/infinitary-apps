import type { CrewMachines } from "../placed/crewMachines";
import type { TaskRecord } from "../storage/taskRecords";
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
