import { keepsCommits, type MergeWays, SQUASH_ONLY_WORDS } from "@shared/batches";
import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import {
  hostRunsQueue,
  ownsBatches,
  queueMissing,
  queueShipped,
  type RepoPolicyPatch,
  type RepoView,
} from "@shared/repos";
import { PROJECT_DELIVERY_WORDS } from "@shared/vocabulary";
import type { CoreDispatch } from "../dispatcher";
import { queuePartFor } from "../queue/shipped";
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
  /** What the workflow read found: the one that mentions it is turned off. */
  turnedOff: (name: string) =>
    `The workflow in ${name} that mentions its batch check is turned off.`,
  /** The feed's line once a waiting choice switches on. */
  switched: (name: string) =>
    `${name} now uses batched pull requests: a workflow in it mentions its batch check.`,
  /** The feed's line once a choice that waited for a queue applies with batches of this person's own. */
  own: (name: string) =>
    `${name} now uses batched pull requests: your approved changes combine into one batch pull request, with no queue to set up.`,
  /** The feed's line when a choice that waited for a queue cannot apply: the project allows only squash merges. */
  squashOnly: (name: string) => `${name} keeps where its changes go. ${SQUASH_ONLY_WORDS}`,
  /** The feed's line when the project's own shipped queue makes it batched here too. */
  adopted: (name: string) =>
    `${name} now uses batched pull requests: your project runs Infinitary's queue, so its changes go through it for everyone.`,
  /** Why a project that runs the shipped queue cannot choose another way for its changes. */
  shippedRefusal: (name: string) =>
    `${name} runs Infinitary's queue on its default branch, so its changes go as batched pull requests for everyone working on it. Remove the queue from the project to choose another way.`,
} as const;

/**
 * The card the app puts up when batched pull requests is chosen for a
 * project that still carries a team queue's files with every one of them
 * turned off (INF-2885 direction B): the choice waits, the project keeps
 * where its changes go, and the captain may ask the first mate to plan
 * the project's queue workflow. A project with no such file gets batches
 * of this person's own and no card (docs/forge.md, "Batches of your own").
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
      `<p>A batched pull request merges only once your project's queue passes it, in a batch with the other approved changes. ${escapeCardText(QUEUE_SETUP_WORDS.turnedOff(repo.name))}</p>`,
      `<p>Until a queue merges, ${name}'s changes still go as ${now}. Once one does, the app switches ${name} to batched pull requests by itself, for everyone working on it.</p>`,
      `<p>Your first mate can plan the queue Infinitary ships with you: you choose which of your project's checks each batch runs, and change the plan before anything is built. A batch that fails pauses until a fix is approved, instead of failing every change in it. ${escapeCardText(QUEUE_SETUP_WORDS.notNow)} keeps ${now}.</p>`,
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
 * A project's batched choice (docs/forge.md, "Choosing batched pull
 * requests"). Every delivery change passes the core dispatcher's
 * configure, which asks this first. A project with no file of a team
 * queue gets batches of this person's own at once, unless it allows only
 * squash merges, which is refused with its reason. A project whose team
 * queue files are all turned off keeps the choice waiting on its row
 * (INF-2885 direction B): its card asks whether the first mate should
 * plan the workflow, a merge in the project reads its workflows again, and
 * the waiting choice applies once a workflow that is on mentions the queue
 * status.
 */
export class QueueChoice {
  private dispatch: CoreDispatch | undefined;
  /** Projects `follow` is acting on now, so two reads of one project act once. */
  private readonly following = new Set<string>();

  constructor(
    private readonly options: {
      repos: RepoRegistry;
      queue: Pick<ProjectQueue, "readWorkflows">;
      raiseCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
      /** Answers whether the first mate was told to offer a queue version for a project, and keeps that it was. */
      offers?: {
        offered: (repoId: string) => number | undefined;
        record: (repoId: string, version: number) => void;
      };
      /** The shipped queue's version this Infinitary carries for every host; its host part's own unless a test names a later one. */
      version?: number;
      /** The merges the project allows, read where it lives; undefined when they cannot be read. */
      ways?: (repoId: string) => Promise<MergeWays | undefined>;
      withdrawCard: (id: string, reason: string) => void;
      tell: (facts: Extract<WakeFacts, { kind: "queue-plan-asked" | "queue-offered" }>) => void;
      note: (text: string) => void;
      now: () => number;
    },
  ) {}

  /** The core's dispatcher, through which a waiting choice applies as any other change does. */
  bindDispatch(dispatch: CoreDispatch): void {
    this.dispatch = dispatch;
  }

  /**
   * Apply a project's settings change through `apply`. A choice of batched
   * pull requests for a project that allows only squash merges is refused
   * with its reason. One a turned-off team queue cannot answer yet is
   * held: the rest of the patch applies, the project keeps its delivery,
   * the choice waits and its card goes up. Answers the project as it now
   * stands.
   */
  async configure(
    repoId: string,
    changes: RepoPolicyPatch,
    apply: (changes: RepoPolicyPatch) => RepoView,
  ): Promise<RepoView> {
    const repo = this.options.repos.get(repoId);
    // A project that runs the shipped queue is batched for everyone on it
    // (the captain's shipped-queue choice): its own queue decides, not one
    // teammate's Settings.
    if (
      repo &&
      changes.delivery !== undefined &&
      changes.delivery !== "queue-pr" &&
      changes.origin === undefined &&
      queueShipped(repo) !== undefined
    )
      throw new Error(QUEUE_SETUP_WORDS.shippedRefusal(repo.name));
    if (
      repo &&
      changes.delivery === "queue-pr" &&
      repo.delivery !== "queue-pr" &&
      changes.origin === undefined
    ) {
      const read = await this.read(repoId, true);
      if (read && ownsBatches("queue-pr", read) === true) {
        // No file of a team queue: batches of this person's own, which keep
        // one commit for each change, so a squash-only project is not offered them.
        const ways = await this.options.ways?.(repoId).catch(() => undefined);
        if (ways && !keepsCommits(ways)) throw new Error(SQUASH_ONLY_WORDS);
        if (read.queuePendingAt !== undefined) this.options.repos.waitForQueue(repoId, null);
      } else if (read && queueMissing(read)) {
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
    if (!read || read.queuePendingAt === undefined || !this.dispatch) return;
    // A choice that waited for a queue the project never got: it needs none now.
    if (ownsBatches("queue-pr", read) === true) {
      try {
        const next = await this.dispatch("inf:repos:configure", [repoId, { delivery: "queue-pr" }]);
        if (next.delivery === "queue-pr") this.options.note(QUEUE_SETUP_WORDS.own(next.name));
      } catch (caught) {
        if (!(caught instanceof Error) || !caught.message.includes(SQUASH_ONLY_WORDS)) throw caught;
        // Refused: the project allows only squash merges. The wait ends with its reason.
        this.options.repos.waitForQueue(repoId, null);
        this.options.withdrawCard(queueSetupCardId(repoId), SQUASH_ONLY_WORDS);
        this.options.note(QUEUE_SETUP_WORDS.squashOnly(read.name));
      }
      return;
    }
    if (!queueAnswers(read)) return;
    const next = await this.dispatch("inf:repos:configure", [repoId, { delivery: "queue-pr" }]);
    if (next.delivery === "queue-pr") this.options.note(QUEUE_SETUP_WORDS.switched(next.name));
  }

  /**
   * Every project whose host runs the shipped queue, read again (at start):
   * a waiting choice applies once its queue is there, and a queue the
   * project set up itself is followed (`follow`).
   */
  async recheckAll(): Promise<void> {
    for (const repo of this.options.repos.list()) {
      if (repo.queuePendingAt !== undefined) await this.recheck(repo.id);
      else if (hostRunsQueue(repo.host)) {
        const read = await this.read(repo.id);
        if (read) await this.follow(read);
      }
    }
  }

  /**
   * A project's queue as its latest read found it, for every teammate (the
   * captain's shipped-queue and keep-and-offer choices, docs/forge.md "The
   * shipped queue"): a project that runs the shipped queue goes as batched
   * pull requests here too; one whose stamp is older than this Infinitary's
   * queue is offered the update once. A batched project whose own
   * workflow answers the queue status keeps it, and is no longer offered
   * the shipped queue (docs/forge.md, "Batches of your own"). A waiting
   * choice is `recheck`'s.
   */
  async follow(repo: RepoView): Promise<void> {
    if (repo.queuePendingAt !== undefined || this.following.has(repo.id)) return;
    this.following.add(repo.id);
    try {
      await this.followOnce(repo);
    } finally {
      this.following.delete(repo.id);
    }
  }

  private async followOnce(repo: RepoView): Promise<void> {
    const shipped = queueShipped(repo);
    if (shipped !== undefined && repo.delivery !== "queue-pr" && this.dispatch) {
      const next = await this.dispatch("inf:repos:configure", [repo.id, { delivery: "queue-pr" }]);
      if (next.delivery === "queue-pr") this.options.note(QUEUE_SETUP_WORDS.adopted(next.name));
      return;
    }
    const offers = this.options.offers;
    const version = this.options.version ?? queuePartFor(repo.host?.kind)?.version;
    if (!offers || version === undefined || offers.offered(repo.id) === version) return;
    const project = { id: repo.id, name: repo.name };
    if (shipped !== undefined && shipped < version) {
      offers.record(repo.id, version);
      this.options.tell({
        kind: "queue-offered",
        project,
        offer: "update",
        from: shipped,
        to: version,
      });
    }
  }

  private async read(repoId: string, all?: boolean): Promise<RepoView | undefined> {
    try {
      return await this.options.queue.readWorkflows(repoId, all);
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
