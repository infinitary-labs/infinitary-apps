import { hostTakesBatches, type RepoView } from "@shared/repos";
import type { Forge } from "../forge";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { WakeFacts } from "./wakes";

/** The card a batched choice once put up while it waited for a queue workflow, by project. */
export function queueSetupCardId(repoId: string): string {
  return `card-queue-setup-${repoId}`;
}

/** Why that card comes down: batched pull requests wait on nothing in the project now. */
export const QUEUE_SETUP_WITHDRAWN =
  "Batched pull requests need no queue workflow in the project now: choose them in Settings, under Projects.";

/**
 * What a project still carries of the team queue the app once shipped
 * (docs/forge.md, "A project that still carries the team queue's files").
 * Nothing in the app reads those files now. Each project is looked at once:
 * the first mate hears of the files found there, once, and offers their
 * removal. The card a waiting batched choice put up comes down too.
 */
export class TeamQueueLeft {
  /** Projects a look is reading now, so two looks at one project tell once. */
  private readonly looking = new Set<string>();

  constructor(
    private readonly options: {
      repos: Pick<RepoRegistry, "list" | "get" | "teamQueueLooked" | "recordTeamQueueLooked">;
      forgeFor: (repo: RepoView) => Pick<Forge, "teamQueueLeftovers">;
      tell: (facts: Extract<WakeFacts, { kind: "team-queue-left" }>) => void;
      withdrawCard: (id: string, reason: string) => void;
    },
  ) {}

  /** Every project not looked at yet, one after another (at start). */
  async lookAll(): Promise<void> {
    for (const repo of this.options.repos.list()) await this.look(repo.id);
  }

  /**
   * Look once in a project whose host could run the team queue. A read that
   * fails, such as one with no sign-in, marks nothing, so a later look reads
   * again.
   */
  async look(repoId: string): Promise<void> {
    const repo = this.options.repos.get(repoId);
    if (!repo || repo.kind !== "project") return;
    this.options.withdrawCard(queueSetupCardId(repoId), QUEUE_SETUP_WITHDRAWN);
    if (!hostTakesBatches(repo.host) || this.looking.has(repoId)) return;
    if (this.options.repos.teamQueueLooked(repoId)) return;
    this.looking.add(repoId);
    try {
      const left = await this.options.forgeFor(repo).teamQueueLeftovers?.();
      if (!left) return;
      this.options.repos.recordTeamQueueLooked(repoId);
      if (left.files.length > 0)
        this.options.tell({
          kind: "team-queue-left",
          project: { id: repo.id, name: repo.name },
          files: left.files,
          ...(left.rule ? { rule: left.rule } : {}),
        });
    } catch {
      // Unread: the next look reads again.
    } finally {
      this.looking.delete(repoId);
    }
  }
}
