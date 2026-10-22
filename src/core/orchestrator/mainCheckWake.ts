import type { ForgeCheckState } from "../forge";
import type { InboxStore } from "../storage/inboxStore";
import { standingBaselineChecks } from "../tasks/dependencyWaits";
import type { TaskService } from "../tasks/taskService";
import { CHECK_WATCH_SLOW_MS } from "./checkWatch";
import { mainCheckPassedOnce, mainCheckPassedWake, type TypedWake } from "./wakes";

/**
 * A main failure's wake (INF-833 Fix 4, docs/forge.md "A main failure's
 * wake"): pull requests held because a check also fails on the default
 * branch are woken when that branch's own run of the check passes, instead
 * of waiting until the named task closes (FI3-250). One read per project
 * per tick, on the check watch's clock. A host that cannot read the
 * default branch's checks leaves the close as the only resume.
 */

/** What one read of the default branch's checks found. */
export type MainBranchReading =
  | { kind: "read"; sha: string; items: { name: string; state: ForgeCheckState }[] }
  | { kind: "unsupported" }
  | { kind: "failed" };

export type MainCheckWakeHost = {
  tasks: TaskService;
  inbox: Pick<InboxStore, "woken">;
  /** The default branch's checks where this project lives. */
  read(repoId: string): Promise<MainBranchReading>;
  /** The supervisor's own steer on the task's durable lane. */
  steer(taskId: string, wake: TypedWake): Promise<unknown>;
};

/**
 * The waited-on checks whose every run of that name on this reading is
 * success. A skip is not a pass, a second run still pending is not a pass,
 * and a name the reading does not list has not passed.
 */
export function passedCheckNames(
  items: readonly { name: string; state: ForgeCheckState }[],
  wanted: readonly string[],
): string[] {
  return wanted.filter((name) => {
    const matching = items.filter((item) => item.name === name);
    return matching.length > 0 && matching.every((item) => item.state === "success");
  });
}

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
      read = { kind: "failed" };
    } finally {
      this.reading.delete(repoId);
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
    for (const taskId of taskIds) {
      const record = this.host.tasks.get(taskId);
      if (!record || record.status !== "active") continue;
      const fresh = passedCheckNames(read.items, standingBaselineChecks(record.delivery)).filter(
        (check) => !this.host.inbox.woken(taskId, mainCheckPassedOnce(check, sha)),
      );
      for (const check of fresh) {
        try {
          await this.host.steer(taskId, mainCheckPassedWake(check, sha));
        } catch (caught) {
          console.warn("[crew] a main check's steer not delivered:", caught);
        }
      }
    }
  }
}
