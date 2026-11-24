import { existsSync } from "node:fs";
import { errorText } from "../personal/errorText";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskGraphRefusal } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import { defaultTaskBranch } from "../workspace/taskBranches";
import type { SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";

/** What a move to another repository needs beside what settling has (`CrewSupervisor`). */
export type RepositoryMoveHost = Pick<
  SettleServiceHost,
  "now" | "tasks" | "workspace" | "stopRuntime" | "killJobs" | "endLiveTask"
> & {
  /** What a task's working copy on a computer that runs work holds unmerged; null while nobody can tell. */
  placedStatus?: (taskId: string) => Promise<{ dirty: boolean; unlandedCommits: number } | null>;
  /** Closes the task's conversation on that computer and removes its working copy there. */
  retireThere?: (deviceId: string, taskId: string) => Promise<void>;
  /** Whether a move to another model or computer holds the task now (`TaskMoves.isMoving`). */
  moving: (taskId: string) => boolean;
  /** The moved task goes where its next start runs (`TaskPlacement.runsOnChanged`). */
  repoint: (taskId: string) => void;
  sweepGates: (now: number) => unknown;
};

export type RepositoryMoveOutcome = { ok: boolean; text: string };

/**
 * A started task whose change lives in another repository of its project
 * moves there while it has no commits of its own (INF-6536 finding 1): its
 * crewmate stops, its empty working copy goes, and it starts again in that
 * repository with its key, record, the captain's words and consents. The
 * app never judges where a change belongs: the crewmate reports it, and the
 * first mate asks for the move through update_task's `repository`. A task
 * with commits or edits of its own keeps its work: a takeover carries it.
 */
export class RepositoryMoves {
  constructor(
    private readonly host: RepositoryMoveHost,
    private readonly locks: Pick<SettleLocks, "holder" | "claim" | "turnEnded">,
  ) {}

  /**
   * Whether this is started work, which moves here rather than in the
   * record's own edit: active, which includes started work the backlog holds
   * (`backlogSince`), or open work that still has a working copy,
   * placement or conversation.
   */
  static started(record: TaskRecord): boolean {
    if (record.kind !== "work") return false;
    if (record.status === "active") return true;
    return (
      record.status === "open" &&
      Boolean(record.worktreeDir || record.placement || record.sessionFile)
    );
  }

  async move(
    taskId: string,
    repository: string,
    actor: "captain" | "firstmate",
  ): Promise<RepositoryMoveOutcome> {
    const record = this.host.tasks.get(taskId);
    // i18n-exempt: a tool answer served to the first mate, not shown to a person
    if (!record) return { ok: false, text: `Unknown task "${taskId}".` };
    const key = record.key || record.id;
    let target: { id: string; name: string };
    try {
      target = this.host.tasks.repositoryInProject(taskId, repository);
    } catch (caught) {
      if (caught instanceof TaskGraphRefusal) return { ok: false, text: caught.message };
      throw caught;
    }
    if (target.id === record.repoId)
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return { ok: true, text: `${key} already works in the ${target.name} repository.` };
    const refused = this.refusal(record, target);
    if (refused) return { ok: false, text: refused };
    // i18n-exempt: the lock's label, read only in tool answers to the first mate
    const lease = this.locks.claim(taskId, "a move to another repository");
    try {
      const held = await this.workRefusal(record, target.name);
      if (held) return { ok: false, text: held };
      this.host.killJobs?.(taskId);
      this.host.endLiveTask(taskId);
      const stopping = this.host.stopRuntime(taskId);
      if (stopping) {
        await stopping;
        this.locks.turnEnded(taskId);
      }
      // The crewmate could commit or edit until it stopped, so the copy is
      // read again before anything removes it.
      const after = await this.workRefusal(record, target.name);
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      if (after) return { ok: false, text: `${key}'s crewmate stopped, but ${after}` };
      const removed = await this.removeCopy(record);
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      if (removed) return { ok: false, text: `${key}'s crewmate stopped, but ${removed}` };
      const now = this.host.tasks.get(taskId);
      if (!now || TaskService.isClosed(now))
        // i18n-exempt: a tool answer served to the first mate, not shown to a person
        return { ok: false, text: `${key} closed while it was moving, so it stays closed.` };
      this.host.tasks.restartInRepository(taskId, target, actor);
      this.host.repoint(taskId);
      void this.host.sweepGates(this.host.now());
      return {
        ok: true,
        // i18n-exempt: a tool answer served to the first mate, not shown to a person
        text: `Moved ${key} to the ${target.name} repository: its crewmate stopped, its empty working copy was removed, and it starts again there with its key, brief and the captain's consents.`,
      };
    } finally {
      lease.release();
    }
  }

  /** The refusals that need no reading of its working copy. */
  private refusal(record: TaskRecord, target: { id: string; name: string }): string | undefined {
    const key = record.key || record.id;
    const name = target.name;
    if (!RepositoryMoves.started(record))
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return `${key} is not started work, so this move does not apply: update_task's repository moves open work that has not started on its own.`;
    const holder = this.locks.holder(record.id);
    // i18n-exempt: a tool answer served to the first mate, not shown to a person
    if (holder) return `${key} cannot move now: ${holder} is in progress. Wait for its outcome.`;
    if (this.host.moving(record.id))
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return `${key} cannot move to the ${name} repository while it moves to another model or computer.`;
    if (record.delivery?.prNumber !== undefined || record.delivery?.prUrl)
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return `${key} already has a change where its project lives, so it keeps its repository; a takeover in the ${name} repository carries its work.`;
    if (record.shape?.branch_from)
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return `${key} started from ${record.shape.branch_from}'s work in its own repository, so it keeps that repository.`;
    const part = this.host.tasks.graph
      .children(record.id)
      .find((child) => !TaskService.isClosed(child));
    if (part)
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return `${key} has an open part, ${part.key || part.id}, so it cannot start again in the ${name} repository; move or close its parts first.`;
    return this.host.tasks.repositoryMoveRefusal(record.id, target);
  }

  /** Refused while its working copy holds commits or edits, or nobody can read it. */
  private async workRefusal(record: TaskRecord, name: string): Promise<string | undefined> {
    const key = record.key || record.id;
    if (record.workspaceState !== "present") return undefined;
    const work = record.deviceId
      ? await (this.host.placedStatus?.(record.id) ?? Promise.resolve(null))
      : await this.host.workspace
          .taskWorkStatus(
            {
              taskId: record.id,
              cwd: record.worktreeDir,
              branch: record.branch,
              repoDir: record.repoDir,
            },
            // A failed git read is not an empty copy.
            { strict: true },
          )
          .catch(() => null);
    if (!work)
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return `${key}'s working copy cannot be read now, so nobody can tell whether it holds work of its own; try the move again once its computer is in reach.`;
    if (work.dirty || work.unlandedCommits > 0)
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return `${key} has ${work.unlandedCommits > 0 ? "commits" : "edits"} of its own, so it keeps its repository: only a task with none moves. A takeover in the ${name} repository carries its work.`;
    return undefined;
  }

  /** Removes its empty working copy; answers why it could not, else undefined. */
  private async removeCopy(record: TaskRecord): Promise<string | undefined> {
    try {
      if (record.deviceId) {
        // i18n-exempt: a tool answer served to the first mate, not shown to a person
        if (!this.host.retireThere) return "its computer cannot remove its working copy.";
        await this.host.retireThere(record.deviceId, record.id);
      } else if (record.worktreeDir && existsSync(record.worktreeDir)) {
        // Whatever it holds that never landed is saved on the task's kept
        // ref first, and the copy stays when that save fails.
        const retired = await this.host.workspace.retireTaskWorktree({
          taskId: record.id,
          cwd: record.worktreeDir,
          branch: record.branch || defaultTaskBranch(record.id),
          repoDir: record.repoDir,
        });
        if (retired.outcome === "kept")
          // i18n-exempt: a tool answer served to the first mate, not shown to a person
          return `its working copy could not be saved before removal (${retired.reason}), so it keeps its repository; try the move again.`;
      }
      return undefined;
    } catch (caught) {
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      return `its working copy could not be removed (${errorText(caught)}), so it keeps its repository; try the move again.`;
    }
  }
}
