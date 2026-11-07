import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import { queueMissing, type RepoPolicyPatch, type RepoView } from "@shared/repos";
import { PROJECT_DELIVERY_WORDS } from "@shared/vocabulary";
import type { CoreDispatch } from "../dispatcher";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { escapeCardText } from "./cardText";
import type { ProjectQueue } from "./projectQueue";
import type { WakeFacts } from "./wakes";

/** The not-set-up card's id for one project. */
export function queueSetupCardId(repoId: string): string {
  return `card-queue-setup-${repoId}`;
}

/** The not-set-up card's words, in one module so a journey reads them from their owner. */
export const QUEUE_SETUP_WORDS = {
  title: (name: string) => `${name} is not set up for batched pull requests yet`,
  plan: "Ask the first mate to plan it",
  notNow: "Not now",
  /** What the workflow read found: nothing mentions the batch check. */
  missing: (name: string) => `No workflow in ${name} mentions its batch check yet.`,
  /** What the workflow read found: the one that mentions it is turned off. */
  turnedOff: (name: string) =>
    `The workflow in ${name} that mentions its batch check is turned off.`,
  /** The feed's line once a waiting choice switches on. */
  switched: (name: string) =>
    `${name} now uses batched pull requests: a workflow in it mentions its batch check.`,
} as const;

/** What the app's read of the project's workflows found, in the card's words. */
function foundWords(repo: Pick<RepoView, "name" | "queueWorkflows">): string {
  return (repo.queueWorkflows ?? []).length > 0
    ? QUEUE_SETUP_WORDS.turnedOff(repo.name)
    : QUEUE_SETUP_WORDS.missing(repo.name);
}

/**
 * The card the app puts up when batched pull requests is chosen for a
 * project the app's reads find nothing to answer (INF-2885 direction B):
 * the choice waits, the project keeps where its changes go, and the
 * captain may ask the first mate to plan the project's queue workflow.
 */
export function queueSetupCard(
  repo: Pick<RepoView, "id" | "name" | "delivery" | "queueWorkflows">,
): Omit<Card, "author" | "priority" | "status" | "createdAt"> {
  const name = escapeCardText(repo.name);
  const now = escapeCardText(PROJECT_DELIVERY_WORDS[repo.delivery]);
  return {
    id: queueSetupCardId(repo.id),
    title: QUEUE_SETUP_WORDS.title(repo.name),
    meta: FIRSTMATE_CARD_META,
    body: [
      `<p>A batched pull request merges only once a queue workflow in your project on GitHub passes it. ${escapeCardText(foundWords(repo))}</p>`,
      `<p>Until one merges, ${name}'s changes still go as ${now}. Once a workflow that mentions its batch check merges, the app switches ${name} to batched pull requests by itself.</p>`,
      `<p>Your first mate can plan that workflow with you, from the checks your project already runs. ${escapeCardText(QUEUE_SETUP_WORDS.notNow)} keeps ${now}.</p>`,
    ].join(""),
    actions: [
      {
        id: "plan-queue",
        label: QUEUE_SETUP_WORDS.plan,
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "plan-queue", arg: repo.id },
      },
      {
        id: "keep-delivery",
        label: QUEUE_SETUP_WORDS.notNow,
        variant: "ghost",
        effect: { kind: "host", op: "keep-delivery", arg: repo.id },
      },
    ],
  };
}

/**
 * A project's batched choice before its queue exists (INF-2885 direction B,
 * docs/forge.md "Choosing batched pull requests before a queue exists").
 * Every delivery change passes the core dispatcher's configure, which asks
 * this first: a choice of batched pull requests the app's workflow read
 * finds nothing to answer waits on the project's row instead of applying,
 * and its card asks whether the first mate should plan the workflow. A
 * merge in the project reads its workflows again, and the waiting choice
 * applies once a workflow that is on mentions the queue status.
 */
export class QueueChoice {
  private dispatch: CoreDispatch | undefined;

  constructor(
    private readonly options: {
      repos: RepoRegistry;
      queue: Pick<ProjectQueue, "readWorkflows">;
      raiseCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
      withdrawCard: (id: string, reason: string) => void;
      tell: (facts: Extract<WakeFacts, { kind: "queue-plan-asked" }>) => void;
      note: (text: string) => void;
      now: () => number;
    },
  ) {}

  /** The core's dispatcher, through which a waiting choice applies as any other change does. */
  bindDispatch(dispatch: CoreDispatch): void {
    this.dispatch = dispatch;
  }

  /**
   * Apply a project's settings change through `apply`, holding a choice of
   * batched pull requests the project cannot answer yet: the rest of the
   * patch applies, the project keeps its delivery, the choice waits and
   * its card goes up. Answers the project as it now stands.
   */
  async configure(
    repoId: string,
    changes: RepoPolicyPatch,
    apply: (changes: RepoPolicyPatch) => RepoView,
  ): Promise<RepoView> {
    const repo = this.options.repos.get(repoId);
    if (
      repo &&
      changes.delivery === "queue-pr" &&
      repo.delivery !== "queue-pr" &&
      changes.origin === undefined
    ) {
      const read = await this.read(repoId);
      if (read && queueMissing(read)) {
        const { delivery: _held, ...rest } = changes;
        const kept = Object.keys(rest).length > 0 ? apply(rest) : read;
        const waiting =
          kept.queuePendingAt === undefined
            ? (this.options.repos.waitForQueue(repoId, this.options.now()) ?? kept)
            : kept;
        this.options.raiseCard(queueSetupCard(waiting));
        return waiting;
      }
    }
    const next = apply(changes);
    if (changes.delivery !== undefined)
      this.options.withdrawCard(queueSetupCardId(repoId), "Where its changes go was chosen again.");
    return next;
  }

  /** The card's Ask the first mate to plan it: the choice keeps waiting, and the first mate hears once. */
  plan(repoId: string | undefined): void {
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    if (!repo || repo.queuePendingAt === undefined) return;
    this.options.tell({
      kind: "queue-plan-asked",
      project: { id: repo.id, name: repo.name },
      delivery: repo.delivery,
      ...(repo.queueWorkflows ? { workflows: repo.queueWorkflows } : {}),
    });
  }

  /** The card's Not now: the choice stops waiting, and the project keeps where its changes go. */
  keep(repoId: string | undefined): void {
    if (repoId) this.options.repos.waitForQueue(repoId, null);
  }

  /**
   * Read a waiting project's workflows again, after a merge in it or at
   * start, and apply its batched choice once a workflow that is on mentions
   * the queue status or the queue has answered. A read that fails changes
   * nothing.
   */
  async recheck(repoId: string): Promise<void> {
    if (this.options.repos.get(repoId)?.queuePendingAt === undefined) return;
    const read = await this.read(repoId);
    if (!read || read.queuePendingAt === undefined || !queueAnswers(read)) return;
    if (!this.dispatch) return;
    const next = await this.dispatch("inf:repos:configure", [repoId, { delivery: "queue-pr" }]);
    if (next.delivery === "queue-pr") this.options.note(QUEUE_SETUP_WORDS.switched(next.name));
  }

  /** Every waiting project, read again (at start). */
  async recheckAll(): Promise<void> {
    for (const repo of this.options.repos.list())
      if (repo.queuePendingAt !== undefined) await this.recheck(repo.id);
  }

  private async read(repoId: string): Promise<RepoView | undefined> {
    try {
      return await this.options.queue.readWorkflows(repoId);
    } catch {
      return this.options.repos.get(repoId);
    }
  }
}

/** The reads show something answers the queue: it answered before, or a workflow that is on mentions it. */
function queueAnswers(repo: Pick<RepoView, "queueWorkflows" | "queueAnsweredAt">): boolean {
  return (
    repo.queueAnsweredAt !== undefined ||
    (repo.queueWorkflows ?? []).some((workflow) => workflow.active)
  );
}
