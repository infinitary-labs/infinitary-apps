import { forgeOf } from "@shared/forge";
import type { Forge, ForgeRepo } from "../forge";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";

/** INF-1388: the placement service reads this typed main-repair fact on GitHub. */
const LABEL = "fixes-main";

export class MainRepairLabels {
  private running: Promise<void> | undefined;
  private dirty = false;

  constructor(
    private readonly host: {
      tasks: Pick<TaskService, "list" | "get" | "recordDelivery">;
      repos: Pick<RepoRegistry, "get">;
      forgeFor: (
        repo: ForgeRepo | undefined,
        fallbackDir?: string,
      ) => Pick<Forge, "api" | "pull" | "changeFor">;
      problem: (taskId: string, message: string) => void;
    },
  ) {}

  /** Task commits request a pass; the shared tick also repairs missed writes after a restart. */
  reconcile(): Promise<void> {
    this.dirty = true;
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const owners = new Set<string>();
      for (const task of this.host.tasks.list()) {
        if (task.delivery?.mainRepairLabel && !task.delivery.mainRepairLabel.removed)
          owners.add(task.id);
        for (const diagnosis of task.delivery?.ciRepair?.diagnoses ?? []) {
          // A recorded diagnosis, not prose, priority, a title or a graph edge.
          // Keep its repair marked until merge even if a dependent moves to a newer head.
          if (diagnosis.classification === "baseline-blocked" && diagnosis.dependencyTask)
            owners.add(diagnosis.dependencyTask);
        }
      }
      for (const id of owners) {
        try {
          await this.sync(id);
        } catch (error) {
          this.host.problem(id, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  private async sync(id: string): Promise<void> {
    const task = this.host.tasks.get(id);
    if (!task?.repoId || !task.branch) return;
    const receipt = task.delivery?.mainRepairLabel;
    if (receipt?.removed || (task.delivery?.checkTarget && !receipt)) return;
    const repo = this.host.repos.get(task.repoId);
    if (!repo) return;
    const location = forgeOf(repo.origin);
    if (location.kind !== "github" || !location.owner || !location.name || !repo.origin) return;
    if (receipt && (receipt.origin !== repo.origin || receipt.branch !== task.branch)) return;
    const forge = this.host.forgeFor(repo, repo.path);
    if (!forge.api || !forge.pull) return;
    // The PR can precede the diagnosis, follow it, or have been opened outside the app.
    const number =
      receipt?.number ?? task.delivery?.prNumber ?? (await forge.changeFor(task.branch))?.number;
    if (number === undefined) return;
    const pull = await forge.pull(number);
    if (!pull || pull.branch !== task.branch) return;
    if (!pull.merged && pull.state !== "open") return;
    const path = `/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.name)}/issues/${number}`;
    const issue = await forge.api.call("GET", path);
    if (issue.status !== 200)
      throw new Error(`Could not read main-repair labels (${issue.status}).`);
    const labels = (JSON.parse(issue.body) as { labels: { name: string }[] }).labels;
    const present = labels.some((label) => label.name === LABEL);
    const labelReceipt = { number, branch: task.branch, origin: repo.origin };
    // Persist the exact destination before a write can have an uncertain answer.
    if (!receipt) this.host.tasks.recordDelivery(id, { mainRepairLabel: labelReceipt });
    if (pull.merged ? present : !present) {
      const result = pull.merged
        ? await forge.api.call("DELETE", `${path}/labels/${LABEL}`)
        : await forge.api.call("POST", `${path}/labels`, JSON.stringify({ labels: [LABEL] }));
      if (result.status < 200 || result.status >= 300)
        throw new Error(
          `Could not ${pull.merged ? "remove" : "add"} main-repair label (${result.status}).`,
        );
    }
    if (pull.merged)
      this.host.tasks.recordDelivery(id, { mainRepairLabel: { ...labelReceipt, removed: true } });
  }
}
