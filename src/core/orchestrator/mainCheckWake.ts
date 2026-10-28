import type { ForgeCheckState } from "../forge";
import type { InboxStore } from "../storage/inboxStore";
import { standingBaselineChecks } from "../tasks/dependencyWaits";
import type { TaskService } from "../tasks/taskService";
import { CHECK_WATCH_SLOW_MS } from "./checkWatch";
import type { TypedWake } from "./wakes";

/**
 * Default-branch observations for tasks waiting on baseline checks.
 * Each commit is relayed once when its checks finish; the crew judges whether it clears the wait.
 * One read per project per tick shares the check watch's clock.
 * A host that cannot read these checks leaves the task-close notification in place.
 */

/** What one read of the default branch's checks found. */
export type MainBranchReading =
  | {
      kind: "read";
      sha: string;
      items: { name: string; state: ForgeCheckState }[];
      complete?: boolean;
      problem?: string;
    }
  | { kind: "unsupported" }
  | { kind: "failed"; problem?: string };

export type MainCheckWakeHost = {
  tasks: TaskService;
  inbox: Pick<InboxStore, "woken">;
  /** The default branch's checks where this project lives. */
  read(repoId: string): Promise<MainBranchReading>;
  /** The supervisor's own steer on the task's durable lane. */
  steer(taskId: string, wake: TypedWake): Promise<unknown>;
};

const BRANCH_SHA = /^[0-9a-f]{40,64}$/;

export class MainCheckWatcher {
  /** Projects whose read is out: a slow read is never doubled by the next tick. */
  private readonly reading = new Set<string>();
  /** Hosts that cannot read a default branch's checks: the close remains the resume. */
  private readonly unsupported = new Set<string>();
  /** A failed read waits out the check watch's slow pause before the next try. */
  private readonly retryAfter = new Map<string, number>();

  constructor(private readonly host: MainCheckWakeHost) {}

  /** One pass on the shared tick: each project with a standing baseline wait is read once. */
  async poll(now: number): Promise<void> {
    const waiting = new Map<string, string[]>();
    for (const record of this.host.tasks.listActive()) {
      if (record.kind !== "work" || !record.repoId) continue;
      if (standingBaselineChecks(record.delivery).length === 0) continue;
      const ids = waiting.get(record.repoId) ?? [];
      ids.push(record.id);
      waiting.set(record.repoId, ids);
    }
    await Promise.all(
      [...waiting].map(([repoId, taskIds]) =>
        this.pollRepo(repoId, taskIds, now).catch((caught: unknown) => {
          console.warn("[crew] main check wake could not read a project:", caught);
        }),
      ),
    );
  }

  private async pollRepo(repoId: string, taskIds: readonly string[], now: number): Promise<void> {
    if (this.reading.has(repoId) || this.unsupported.has(repoId)) return;
    if ((this.retryAfter.get(repoId) ?? 0) > now) return;
    this.reading.add(repoId);
    let read: MainBranchReading;
    try {
      read = await this.host.read(repoId);
    } catch (caught) {
      console.warn("[crew] main check wake could not read the default branch:", caught);
      read = { kind: "failed", problem: caught instanceof Error ? caught.message : String(caught) };
    } finally {
      this.reading.delete(repoId);
    }
    // Captain F14: retain the reason on each waiting task without creating a
    // non-final main-check wake (F5). The existing task record deduplicates it.
    if (read.kind !== "unsupported" && read.problem) {
      const problem = { ...(read.kind === "read" ? { sha: read.sha } : {}), problem: read.problem };
      for (const taskId of taskIds) {
        const record = this.host.tasks.get(taskId);
        if (!record || record.status !== "active") continue;
        const previous = this.host.tasks
          .timeline(taskId)
          .findLast((event) => event.data?.mainCheckReadProblem);
        if (JSON.stringify(previous?.data?.mainCheckReadProblem) === JSON.stringify(problem))
          continue;
        this.host.tasks.note(
          taskId,
          `The default branch's checks cannot be read: ${read.problem}`,
          {
            news: true,
            feed: false,
            data: { mainCheckReadProblem: problem },
          },
        );
      }
    }
    if (read.kind === "unsupported") {
      this.unsupported.add(repoId);
      return;
    }
    if (read.kind !== "read" || !BRANCH_SHA.test(read.sha)) {
      this.retryAfter.set(repoId, now + CHECK_WATCH_SLOW_MS);
      return;
    }
    const sha = read.sha;
    this.retryAfter.delete(repoId);
    // Captain F5: absence and incomplete/running readings are not final results.
    if (
      read.complete === false ||
      read.problem ||
      read.items.length === 0 ||
      read.items.some((item) => item.state === "pending")
    )
      return;
    for (const taskId of taskIds) {
      const record = this.host.tasks.get(taskId);
      if (!record || record.status !== "active") continue;
      const once = `main-check-finished:${sha}`;
      if (this.host.inbox.woken(taskId, once)) continue;
      try {
        await this.host.steer(taskId, {
          facts: { kind: "main-check-observed", sha, checks: read.items },
          once,
        });
      } catch (caught) {
        console.warn("[crew] a main check's steer not delivered:", caught);
      }
    }
  }
}
