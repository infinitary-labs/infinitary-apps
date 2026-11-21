import { randomUUID } from "node:crypto";
import { removalAnswer } from "@shared/checkRepair";
import { failedBatch } from "@shared/checkSnapshot";
import { hasChangeRequests } from "@shared/forge";
import { deliveryForRecord, opensPullRequest, ownsBatches } from "@shared/repos";
import { forgeLocationOf } from "../forge";
import { currentChange } from "../storage/changeProjection";
import type {
  MergeAuthorization,
  MergeWait,
  QueueApprovalRemoval,
  TaskRecord,
} from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { MergeGuard, PrOutcome } from "./changeMerge";
import {
  approvableOffer,
  candidateHead,
  carryUnsettled,
  endedAuthorization,
  FAILED_BATCH_NOTE,
  type HostKindAt,
  outstandingGuidance,
  putInFront,
  retryAfter,
  samePullTarget,
  standingAuthorization,
  taskPull,
} from "./mergeAuthorization";
import { publicationRepo } from "./publicationRepo";
import type { SettleOutcome, SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";
import { changeName } from "./settleWords";

/**
 * The captain's click on a merge card's offer, as the click handler read it
 * off the shown card: the card, its occurrence and version, the action and
 * the gesture's own id (FI3-304).
 */
export type MergeApproval = {
  cardId: string;
  lifecycleId?: string;
  offerId?: string;
  actionId: string;
  interactionId?: string;
};

/** What a stopped merge means for a kept approval: the wait it now stands on. */
function waitOf(result: SettleOutcome, undecided: boolean): MergeWait {
  switch (result.stop) {
    case "conflict":
    case "behind":
      return "conflict";
    case "moved":
      return undecided ? "evidence" : "repair";
    case "checks":
      return "checks";
    case "protected":
    case "computing":
    case "draft":
    case "sign-in":
    case "transient":
    case "outcome":
    case "guidance":
    case "queue":
    case "host-queue":
    case "host-removed":
    case "questions":
      return result.stop;
    default:
      if (result.refusal?.refused === "not-signed-in") return "sign-in";
      if (result.notGreen) return "checks";
      return "refused";
  }
}

/** Why an approval ends when its pull request is no longer one of the task's (INF-2746). */
export const PULL_NOT_THE_TASKS =
  "the approved pull request is no longer one of the task's changes";

/**
 * Which of a task's other approvals an ended one ends with it (INF-2746):
 * every one when the end holds the task's merge for the captain; only
 * those the app took under autonomy when the app's own approval is revoked
 * because the task no longer merges on its own, so the captain's clicks
 * still go ahead; none otherwise.
 */
function endsWith(ended: MergeAuthorization): ((item: MergeAuthorization) => boolean) | undefined {
  if (ended.holds) return () => true;
  if (ended.status === "revoked") return (item) => item.issuer === "autonomy";
  return undefined;
}

/** A generation past every approval the task holds, in front or not (INF-2746). */
function nextGeneration(top: MergeAuthorization | undefined): number {
  return Math.max(0, ...[top, ...(top?.queued ?? [])].map((item) => item?.generation ?? 0)) + 1;
}

/** Whether two approvals cover the same pull request where the project lives. */
function samePull(a: MergeAuthorization, b: MergeAuthorization): boolean {
  return (
    a.target.host === b.target.host &&
    a.target.owner === b.target.owner &&
    a.target.name === b.target.name &&
    a.target.prNumber === b.target.prNumber
  );
}

function sameRemoval(a: QueueApprovalRemoval, b: QueueApprovalRemoval): boolean {
  return (
    a.head === b.head &&
    a.target.host === b.target.host &&
    a.target.owner === b.target.owner &&
    a.target.name === b.target.name &&
    a.target.prNumber === b.target.prNumber
  );
}

/**
 * The captain's kept merge approval (FI3-304, `./mergeAuthorization.ts`):
 * minting it at the click, the guard each attempt runs under, what an
 * attempt's outcome does to it, how it ends, and the pending-merge note that
 * keeps the click in view. It owns the approval's state on the task record;
 * the attempts themselves run in `./keptMerge.ts`.
 */
export class KeptApproval {
  /** Only in-flight work; unacknowledged effects live on the existing permission record. */
  private readonly queueRemovals = new Map<string, Promise<void>>();

  private pendingRemovals(taskId: string): QueueApprovalRemoval[] | undefined {
    return this.host.tasks.get(taskId)?.delivery?.mergeAuthorization?.queueRemovals;
  }

  removeQueueMark(taskId: string, authorization: MergeAuthorization): void {
    if (!this.host.removeQueuedApproval) return;
    const top = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization;
    if (!top) return;
    const removal: QueueApprovalRemoval = {
      head: candidateHead(authorization),
      target: authorization.target,
      ...(authorization.review ? { review: authorization.review } : {}),
    };
    if (!top.queueRemovals?.some((item) => sameRemoval(item, removal))) {
      this.host.tasks.delivery.recordPermissionRecords(taskId, {
        mergeAuthorization: { ...top, queueRemovals: [...(top.queueRemovals ?? []), removal] },
      });
    }
    void this.queueMarksSettled(taskId).catch(() => {});
  }

  /** Restore eligibility removals implied by a durable held/ended approval from an older app. */
  restoreQueueMarks(taskId: string, approval: MergeAuthorization): void {
    const guidance = outstandingGuidance(approval) !== undefined;
    if (!guidance && (approval.status === "standing" || approval.status === "consumed")) return;
    this.removeQueueMark(taskId, approval);
    const drop = guidance ? () => true : endsWith(approval);
    if (drop)
      for (const item of approval.queued ?? []) if (drop(item)) this.removeQueueMark(taskId, item);
  }

  async queueMarksSettled(taskId: string): Promise<void> {
    const running = this.queueRemovals.get(taskId);
    if (running) return running;
    if (!this.pendingRemovals(taskId)?.length) return;
    let trying: QueueApprovalRemoval | undefined;
    const operation = Promise.resolve().then(async () => {
      const failed: QueueApprovalRemoval[] = [];
      let firstError: unknown;
      for (;;) {
        const next = this.pendingRemovals(taskId)?.find(
          (item) => !failed.some((prior) => sameRemoval(prior, item)),
        );
        if (!next) {
          if (failed.length) throw firstError;
          return;
        }
        try {
          if (!this.host.removeQueuedApproval)
            throw new Error("This app cannot remove the queued approval.");
          await this.host.removeQueuedApproval(taskId, next);
          const top = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization;
          if (!top) return;
          const pending = top.queueRemovals?.filter((item) => !sameRemoval(item, next));
          this.host.tasks.delivery.recordPermissionRecords(taskId, {
            mergeAuthorization: { ...top, queueRemovals: pending?.length ? pending : undefined },
          });
        } catch (error) {
          if (failed.length === 0) {
            firstError = error;
            trying = next;
          }
          failed.push(next);
        }
      }
    });
    this.queueRemovals.set(taskId, operation);
    const ended = () => {
      if (this.queueRemovals.get(taskId) === operation) this.queueRemovals.delete(taskId);
    };
    void operation.then(ended, (error) => {
      ended();
      const text = `Could not remove the queued merge approval: ${error instanceof Error ? error.message : String(error)}`;
      this.host.tasks.note(taskId, text, { news: true, feed: true });
      this.host.mergeContinued?.(taskId, trying?.review, { ok: false, text });
    });
    return operation;
  }

  constructor(
    private readonly host: SettleServiceHost,
    private readonly locks: SettleLocks,
  ) {}

  /**
   * Mint the captain's merge approval for the offer he clicked (FI3-304),
   * inside the card resolution's transaction and before any work starts.
   * It is minted only on a pull request task (direct-pr or queue-pr) on
   * GitHub or GitLab, for an offer the host published after its checks
   * passed at a known head, on the pull request the task still names;
   * anything else - a seeded or Firstmate card, an offer with no baseline,
   * a plain Git host - approves no head and the click is one attempt, as
   * before. A standing approval the click
   * replaces is superseded either way.
   *
   * On a task whose autonomy is on, the app mints the same approval from
   * the merge card itself as it goes up (INF-2744, `issuer: "autonomy"`),
   * once the merge gate lets the app through.
   *
   * A task may ask for many merges (INF-2746): an approval of another pull
   * request than the one whose approval stands joins it, and each goes
   * ahead on its own (`KeptMerge.runMergeAuthorization`). Returns whether
   * the approval is the one in front now, joined the others (`queued`), or
   * was not minted (undefined).
   */
  authorizeMerge(
    taskId: string,
    approval: MergeApproval,
    proceedWithOpen: boolean,
    reviewId?: string,
    declared: { after?: "close" | "continue"; issuer?: "autonomy" } = {},
  ): "standing" | "queued" | undefined {
    const record = this.host.tasks.get(taskId);
    if (!record || TaskService.isClosed(record)) return undefined;
    const now = this.host.now();
    const previous = record.delivery?.mergeAuthorization;
    const standing = standingAuthorization(record.delivery);
    const generation = nextGeneration(previous);
    const minted = this.mint(
      record,
      approval,
      proceedWithOpen,
      generation,
      now,
      reviewId,
      declared,
    );
    const approvedBy = (authorization: MergeAuthorization) =>
      authorization.issuer === "autonomy"
        ? `The app approved merging ${changeName(record, authorization.target.prNumber)} at ${authorization.approvedHead}, because this task merges on its own.`
        : `The captain approved merging ${changeName(record, authorization.target.prNumber)} at ${authorization.approvedHead}.`;
    if (minted && standing && !samePull(standing, minted)) {
      for (const item of standing.queued ?? [])
        if (samePull(item, minted)) this.removeQueueMark(taskId, item);
      // A task may ask for many merges (INF-2746): an approval of another
      // pull request joins the standing one, never in its place, and goes
      // ahead on its own once its crewmate is idle.
      this.host.tasks.delivery.recordPermissionRecords(taskId, {
        mergeAuthorization: {
          ...standing,
          queueRemovals: this.pendingRemovals(taskId),
          queued: [...(standing.queued ?? []).filter((item) => !samePull(item, minted)), minted],
        },
      });
      this.host.tasks.note(
        taskId,
        `${approvedBy(minted)} It goes ahead on its own beside the approval of ${changeName(record, standing.target.prNumber)}.`,
        {
          news: true,
          feed: minted.issuer === "captain",
          data: { mergeAuthorization: minted.id, queued: true },
        },
      );
      this.locks.retryWhenFree(taskId);
      return "queued";
    }
    if (minted) {
      // Approvals still waiting behind one that just ended wait behind this one.
      const waiting = (previous?.queued ?? []).filter((item) => !samePull(item, minted));
      const kept = {
        ...minted,
        ...(waiting.length > 0 ? { queued: waiting } : {}),
      };
      // The approved pull request is the task's current change from the click on (INF-2490).
      if (standing) this.removeQueueMark(taskId, standing);
      for (const item of previous?.queued ?? [])
        if (samePull(item, minted)) this.removeQueueMark(taskId, item);
      this.recordStanding(taskId, kept);
      this.host.tasks.note(taskId, approvedBy(minted), {
        news: true,
        data: { mergeAuthorization: minted.id, generation },
      });
      return "standing";
    }
    // A click that approves no head asks again only for its own pull request.
    const clicked = reviewId
      ? record.delivery?.mergeReviews?.find((item) => item.id === reviewId)?.number
      : (record.delivery?.completionOffers?.find(
          (offer) => offer.cardId === approval.cardId && offer.offerId === approval.offerId,
        )?.prNumber ?? currentChange(record.delivery, record.branch).number);
    if (standing && (clicked === undefined || clicked === standing.target.prNumber)) {
      this.endAuthorization(
        taskId,
        "superseded",
        declared.issuer === "autonomy"
          ? "its crewmate put up a new merge card"
          : "the captain clicked merge on another card",
      );
    }
    return undefined;
  }

  /**
   * Write an approval as the one that stands. A click (`select`) makes the
   * pull request it approves the task's current change (INF-2490); one the
   * app promotes from the queue leaves the current change alone, and its
   * run selects its pull request only when it merges (INF-2746).
   */
  private recordStanding(taskId: string, authorization: MergeAuthorization, select = true): void {
    // The approval it replaces may carry merges sent whose outcome was never
    // read back; they stay with the record, by pull request (INF-5193).
    const previous = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization;
    this.host.tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...carryUnsettled(previous, authorization, this.hostKindAt),
        queueRemovals: this.pendingRemovals(taskId),
      },
    });
    if (select) this.selectCovered(taskId, authorization);
  }

  /**
   * Make the pull request an approval covers the task's current change
   * (INF-2490): its review, else the task's own change. A merge of the
   * task's own change reads the current change, so the run of an approval
   * without a review selects its pull request right before it merges; a
   * review's merge reads its pull request by number and needs nothing.
   */
  selectCovered(taskId: string, authorization: MergeAuthorization): void {
    const record = this.host.tasks.get(taskId);
    if (!record) return;
    const target = authorization.target;
    const review =
      authorization.review ??
      taskPull(record, this.host.tasks.changesFor(taskId), target.prNumber, {
        repoId: target.repoId,
        branch: target.branch,
      })?.review;
    const current = currentChange(record.delivery, record.branch);
    if (
      !authorization.review &&
      (record.delivery?.checkTarget?.repoId ?? record.repoId) === target.repoId &&
      current.branch === target.branch &&
      current.number === target.prNumber
    )
      return;
    if (target.branch === record.branch)
      this.host.tasks.delivery.selectOwnChange(
        taskId,
        review ?? { number: target.prNumber, headSha: candidateHead(authorization) },
      );
    else if (review?.branch === target.branch)
      this.host.tasks.delivery.recordPermissionRecords(taskId, { checkTarget: review });
  }

  /**
   * The approval in front ended and the task has others (INF-2746): the
   * next one comes to the front, keeping the captain's guidance marks. An
   * end that ends others too (`endsWith`) drops them first. Returns whether
   * one stands in front now.
   */
  promoteQueued(taskId: string): boolean {
    const record = this.host.tasks.get(taskId);
    let ended = record?.delivery?.mergeAuthorization;
    if (!record || !ended || ended.status === "standing" || !ended.queued?.length) return false;
    if (TaskService.isClosed(record)) return false;
    const drop = endsWith(ended);
    if (drop) {
      this.dropQueued(taskId, ended, ended.reason ?? "the merge is the captain's again", drop);
      ended = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization ?? ended;
    }
    const [next, ...rest] = ended.queued ?? [];
    if (!next) return false;
    this.recordStanding(
      taskId,
      {
        ...next,
        generation: nextGeneration(ended),
        guidance: ended.guidance,
        ...(rest.length > 0 ? { queued: rest } : { queued: undefined }),
      },
      false,
    );
    this.host.tasks.note(
      taskId,
      `The kept approval to merge ${changeName(record, next.target.prNumber)} goes on now that the approval of ${changeName(record, ended.target.prNumber)} ended.`,
      { news: true, data: { mergeAuthorization: next.id } },
    );
    return true;
  }

  /**
   * The one in front waits (INF-2746): it steps back behind the task's
   * other approvals, so the next goes ahead without waiting for it to end.
   * Nothing steps back while a merge request is out. Returns whether
   * another is in front now.
   */
  stepBack(taskId: string, id: string): boolean {
    const top = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization;
    if (top?.id !== id) return false;
    const front = putInFront(top, 0, true);
    if (!front) return false;
    this.host.tasks.delivery.recordPermissionRecords(taskId, { mergeAuthorization: front });
    return true;
  }

  /**
   * The task's other approvals end with the one that ended (INF-2746): the
   * timeline and the feed say so, and its crewmate hears once which merges
   * will not run, so it puts their merge cards up again - a card the app
   * took from shows the merging line and no buttons until then.
   */
  dropQueued(
    taskId: string,
    ended: MergeAuthorization,
    why: string,
    drop: (item: MergeAuthorization) => boolean = () => true,
  ): void {
    const record = this.host.tasks.get(taskId);
    const dropped = ended.queued?.filter(drop) ?? [];
    if (!record || dropped.length === 0) return;
    for (const item of dropped) this.removeQueueMark(taskId, item);
    const kept = ended.queued?.filter((item) => !drop(item)) ?? [];
    this.host.tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...ended,
        queueRemovals: this.pendingRemovals(taskId),
        queued: kept.length > 0 ? kept : undefined,
      },
    });
    if (TaskService.isClosed(record)) return;
    const names = dropped.map((item) => changeName(record, item.target.prNumber)).join(", ");
    this.host.tasks.note(taskId, `The kept merge approvals of ${names} ended too: ${why}.`, {
      news: true,
      feed: true,
    });
    this.host.mergeContinued?.(
      taskId,
      undefined,
      {
        ok: false,
        text: `The kept merge approvals of ${names} ended with the approval of ${changeName(record, ended.target.prNumber)}: ${why}. Put up the merge card of each pull request that should still merge; the new card is what the captain or the app approves.`,
      },
      names,
    );
  }

  /**
   * Its crewmate put up a new merge card for a pull request (INF-2744,
   * INF-2746): any approval of that pull request, standing or waiting,
   * ends, since the crewmate is asking again; approvals of the task's other
   * pull requests stand beside the new card. `review` undefined is the
   * task's own change.
   */
  askAgain(taskId: string, review: string | undefined): void {
    const top = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization;
    const waiting = top?.queued?.filter((item) => item.review?.id !== review);
    if (top && waiting && waiting.length !== top.queued?.length) {
      for (const item of top.queued ?? [])
        if (!waiting.includes(item)) this.removeQueueMark(taskId, item);
      this.host.tasks.delivery.recordPermissionRecords(taskId, {
        mergeAuthorization: {
          ...top,
          queueRemovals: this.pendingRemovals(taskId),
          queued: waiting.length > 0 ? waiting : undefined,
        },
      });
    }
    if (top?.status === "standing" && top.review?.id === review)
      this.endAuthorization(taskId, "superseded", "its crewmate put up a new merge card");
  }

  private mint(
    record: TaskRecord,
    approval: MergeApproval,
    proceedWithOpen: boolean,
    generation: number,
    now: number,
    reviewId?: string,
    declared: { after?: "close" | "continue"; issuer?: "autonomy" } = {},
  ): MergeAuthorization | undefined {
    const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
    const review = reviewId
      ? record.delivery?.mergeReviews?.find((item) => item.id === reviewId)
      : undefined;
    // The review's own project: another managed one when the task opened it there (INF-2510).
    const reviewRepo = review?.repoId ? this.host.repos.get(review.repoId) : repo;
    const location = reviewRepo ? forgeLocationOf(publicationRepo(record, reviewRepo)) : undefined;
    // A request review is a typed, head-bound offer. Rule-skipping clicks remain one-shot.
    if (
      reviewId &&
      (!opensPullRequest(this.host.taskDelivery(record.id)) ||
        !review ||
        review.skips ||
        review.receipt ||
        location?.host !== review.host ||
        location.owner !== review.owner ||
        location.name !== review.name)
    )
      return undefined;
    // A click approves the pull request its card was shown for, whichever
    // of the task's is current now (INF-2746).
    const changes = this.host.tasks.changesFor(record.id);
    const shown = record.delivery?.completionOffers?.find(
      (item) => item.cardId === approval.cardId && item.offerId === approval.offerId,
    );
    const pull = shown ? taskPull(record, changes, shown.prNumber, shown.destination) : undefined;
    const targetRepo = shown?.destination
      ? this.host.repos.get(shown.destination.repoId)
      : this.changeRepoOf(record, repo, pull?.review);
    const offer = review
      ? { baseline: { headSha: review.headSha, prNumber: review.number }, ...review }
      : approvableOffer(
          record,
          targetRepo,
          this.host.taskDelivery(record.id),
          approval,
          changes,
          pull,
        );
    const offerId = approval.offerId;
    if (!offer || !offerId || !record.repoId || !record.branch) return undefined;
    const { baseline } = offer;
    const boundReview = review ?? (pull?.review?.repoId ? pull.review : undefined);
    return {
      version: 1,
      id: randomUUID(),
      generation,
      issuer: declared.issuer ?? "captain",
      at: now,
      card: {
        id: approval.cardId,
        ...(approval.lifecycleId ? { lifecycleId: approval.lifecycleId } : {}),
        offerId,
        actionId: approval.actionId,
        ...(approval.interactionId ? { interactionId: approval.interactionId } : {}),
      },
      target: {
        repoId: record.repoId,
        host: offer.host,
        owner: offer.owner,
        name: offer.name,
        prNumber: baseline.prNumber,
        branch:
          review?.branch ?? pull?.branch ?? currentChange(record.delivery, record.branch).branch,
        delivery: "direct-pr",
        method: "squash",
      },
      ...(boundReview ? { review: boundReview } : {}),
      ...(declared.after ? { after: declared.after } : {}),
      approvedHead: baseline.headSha,
      ...(record.delivery?.versionReadings?.[baseline.headSha]
        ? { changeReading: record.delivery.versionReadings[baseline.headSha] }
        : {}),
      lineage: [],
      proceedWithOpen,
      status: "standing",
    };
  }

  /** Patch the standing approval, if one stands. */
  patchStanding(taskId: string, patch: Partial<MergeAuthorization>): void {
    const record = this.host.tasks.get(taskId);
    const authorization = standingAuthorization(record?.delivery);
    if (!record || !authorization) return;
    this.host.tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: { ...authorization, ...patch },
    });
  }

  /** The merge happened under the standing approval: it is spent. */
  consumeStanding(taskId: string, receipt: PrOutcome["receipt"]): void {
    const now = this.host.now();
    const authorization = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
    if (!authorization) return;
    this.host.tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: endedAuthorization(authorization, {
        status: "consumed",
        endedAt: now,
        ...(receipt
          ? {
              receipt: {
                head: receipt.head,
                ...(receipt.sha ? { sha: receipt.sha } : {}),
                at: now,
              },
            }
          : {}),
      }),
    });
    if (authorization.queued?.length) this.locks.retryWhenFree(taskId);
  }

  /**
   * End the standing approval (FI3-304 section 6): `revoked` by an
   * interruption or the captain's withdrawal, both holding the task's merge
   * for the captain, or by the app when its own approval no longer passes
   * the merge gate because the task no longer merges on its own (INF-2744),
   * which holds nothing; `invalidated` when the approved work or pull
   * request is no longer the one he approved; `superseded` by a new merge
   * card or click. The generation advances, so a run already under way
   * stops before it sends anything. Only `options.holds` holds the task's
   * merge for the captain.
   */
  endAuthorization(
    taskId: string,
    status: "revoked" | "invalidated" | "superseded",
    why: string,
    options: { holds?: boolean; feed?: boolean } = {},
  ): boolean {
    const record = this.host.tasks.get(taskId);
    const authorization = standingAuthorization(record?.delivery);
    if (!record || !authorization) return false;
    const ended = endedAuthorization(authorization, {
      status,
      reason: why,
      endedAt: this.host.now(),
      generation: authorization.generation + 1,
      ...(options.holds ? { holds: true } : {}),
    });
    this.host.tasks.delivery.recordPermissionRecords(taskId, { mergeAuthorization: ended });
    this.removeQueueMark(taskId, authorization);
    // An approval of another pull request waiting behind it stands next,
    // unless this end ends it too (INF-2746, `endsWith`).
    const drop = endsWith(ended);
    if (drop) this.dropQueued(taskId, ended, why, drop);
    if (this.host.tasks.get(taskId)?.delivery?.mergeAuthorization?.queued?.length)
      this.locks.retryWhenFree(taskId);
    if (!TaskService.isClosed(record)) {
      const whose = authorization.issuer === "autonomy" ? "The app's" : "The captain's";
      this.host.tasks.note(taskId, `${whose} kept merge approval ended: ${why}.`, {
        news: true,
        feed: options.feed ?? false,
      });
    }
    return true;
  }

  /** The captain's or the Firstmate's interruption withdraws the approval (interrupt = revoke). */
  revokeMergeAuthorization(taskId: string, why: string): boolean {
    return this.endAuthorization(taskId, "revoked", why, { holds: true, feed: true });
  }

  /**
   * The captain's guidance reached the task while his approval stands
   * (FI3-662): it takes the next mark, which rides the message to the
   * crewmate, and the merge holds until the crewmate declares that mark's
   * impact. Called as the steer's row is recorded, so guidance nothing
   * could deliver holds nothing. Undefined when no approval stands.
   */
  holdForGuidance(taskId: string): number | undefined {
    const record = this.host.tasks.get(taskId);
    const authorization = standingAuthorization(record?.delivery);
    if (!record || !authorization || TaskService.isClosed(record)) return undefined;
    const now = this.host.now();
    const before = authorization.guidance ?? { latest: 0, declared: 0, at: now };
    const mark = before.latest + 1;
    const began = outstandingGuidance(authorization) === undefined;
    this.removeQueueMark(taskId, authorization);
    for (const item of authorization.queued ?? []) this.removeQueueMark(taskId, item);
    this.host.tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...authorization,
        queueRemovals: this.pendingRemovals(taskId),
        guidance: { ...before, latest: mark, at: now },
      },
    });
    this.host.tasks.note(
      taskId,
      `The captain's guidance (mark ${mark}) holds the kept merge until its crewmate declares its impact.`,
      { news: true, data: { mergeGuidance: { mark } } },
    );
    if (began) {
      this.host.broadcastEvent({
        type: "firstmate_note",
        text: `Your merge of "${record.title}" is kept and waits until its crewmate says whether your newer words change the work you approved.`,
        taskId,
      });
    }
    return mark;
  }

  /**
   * The guard a merge under the approval runs with: its candidate head and
   * pinned pull request, and the last look right before the request goes
   * out - the same approval, the same generation and head, the crewmate
   * idle, no new merge card - which persists the attempt token the
   * restart reconcile reads (FI3-304 section 5). The same look before a
   * queue mark (`mark`) records nothing: no merge request goes out.
   */
  guardOf(taskId: string, authorization: MergeAuthorization, unattended: boolean) {
    const head = candidateHead(authorization);
    // The attempt this guard records; any other on the approval is a merge
    // sent earlier whose outcome was never read back.
    let sent: string | undefined;
    const guard: MergeGuard = {
      head,
      prNumber: authorization.target.prNumber,
      unattended,
      approvedAt: authorization.at,
      place: authorization.target,
      unresolved: () =>
        this.unresolvedSend(taskId, authorization.target, sent)
          ? // i18n-exempt: served in the merge answer, stays English
            "a merge of this pull request sent earlier is still being read back, so nothing is sent again until it is"
          : undefined,
      // The captain's guidance since his click holds the merge without
      // spending the approval, read right before the last look (FI3-662).
      held: () => {
        const now = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
        const mark = now?.id === authorization.id ? outstandingGuidance(now) : undefined;
        return mark === undefined
          ? undefined
          : `the captain's guidance (mark ${mark}) waits for its crewmate to declare its impact`;
      },
      // The host's own merge queue took this version under this approval:
      // its place there is read before anything is sent again, and a
      // removal is sent again only on its crewmate's answer to it.
      handed: () => {
        const delivery = this.host.tasks.get(taskId)?.delivery;
        const now = standingAuthorization(delivery);
        const handed = now?.id === authorization.id ? now.handed : undefined;
        if (handed?.head !== head) return undefined;
        return {
          answered:
            handed.removed !== undefined &&
            removalAnswer(delivery, head, handed.removed) !== undefined,
        };
      },
      beforeDispatch: (dispatchHead, mark) => {
        const record = this.host.tasks.get(taskId);
        const now = standingAuthorization(record?.delivery);
        if (!record || TaskService.isClosed(record)) return "the task closed";
        if (now?.id !== authorization.id || now.generation !== authorization.generation) {
          return "the captain's merge approval ended";
        }
        const identity = this.authorizationIdentity(record, now);
        if (identity) {
          this.endAuthorization(taskId, "invalidated", identity, { feed: true });
          return identity;
        }
        if (candidateHead(now) !== dispatchHead || dispatchHead !== head) {
          return "the pull request is not at the version the approval covers";
        }
        if (unattended && this.locks.working(taskId)) return "its crewmate started working again";
        if (unattended && this.supersedingCard(taskId, now)) {
          return "a new merge card is up";
        }
        if (mark) return undefined;
        sent = randomUUID();
        this.host.tasks.delivery.recordPermissionRecords(taskId, {
          mergeAuthorization: {
            ...now,
            attempt: { token: sent, head: dispatchHead, at: this.host.now() },
          },
        });
        return undefined;
      },
    };
    return guard;
  }

  /** The forge kind a managed project configured for a host's address. */
  private readonly hostKindAt: HostKindAt = (host) =>
    this.host.repos.list().find((repo) => forgeLocationOf(repo)?.host === host)?.host?.kind;

  /**
   * Whether a merge of this pull request (`samePullTarget`) was sent, from
   * this task or another, closed ones included, and its outcome never read
   * back (`KeptMerge.reconcileUnsettledSends` reads those no standing
   * approval reads): an approval's attempt or an unsettled entry carried
   * past it, other than the attempt this send recorded (`own`).
   */
  private unresolvedSend(
    taskId: string,
    target: MergeAuthorization["target"],
    own: string | undefined,
  ): boolean {
    const records = [
      this.host.tasks.get(taskId),
      ...this.host.tasks.unresolvedMergeSends().filter((record) => record.id !== taskId),
    ];
    return records.some((record) => {
      const kept = record?.delivery?.mergeAuthorization;
      if (!kept) return false;
      const sends = [
        ...(kept.attempt ? [{ target: kept.target, attempt: kept.attempt }] : []),
        ...(kept.unsettled ?? []),
      ];
      return sends.some(
        (item) =>
          item.attempt.token !== own && samePullTarget(item.target, target, this.hostKindAt),
      );
    });
  }

  /**
   * What an attempt's outcome does to the approval it ran under: a merge
   * already spent it; a pull request closed or swapped ends it; every
   * other stop leaves it standing, waiting on that stop - with a time to
   * look again where nothing else will wake it. Returns the wait and
   * whether it is new, or undefined when the approval no longer stands.
   */
  afterAttempt(
    taskId: string,
    authorization: MergeAuthorization,
    result: SettleOutcome,
  ): { wait: MergeWait; head: string; changed: boolean } | undefined {
    const record = this.host.tasks.get(taskId);
    const current = standingAuthorization(record?.delivery);
    if (
      !record ||
      !current ||
      current.id !== authorization.id ||
      current.generation !== authorization.generation ||
      result.ok
    )
      return undefined;
    // A last-look refusal is not a withdrawn approval when this exact
    // approval still stands. Keep its refusal visible and back off through
    // the existing refused wait; an ended or replaced approval returned above.
    const now = this.host.now();
    if (result.contention) {
      // Due now for the tick and a restart; run again as soon as the
      // settle that holds the task ends.
      this.patchStanding(taskId, { retryAt: now });
      this.locks.retryWhenFree(taskId);
      return undefined;
    }
    if (result.stop === "closed" || result.stop === "identity") {
      this.endAuthorization(
        taskId,
        "invalidated",
        result.stop === "closed"
          ? "its pull request was closed without merging"
          : "the branch's pull request is not the one approved",
        { feed: true },
      );
      return undefined;
    }
    const wait = waitOf(result, current.undecided !== undefined);
    const head = candidateHead(current);
    const changed = current.waiting?.on !== wait || current.waiting.head !== head;
    const retries = changed ? 0 : (current.retries ?? 0) + 1;
    const retryAt = retryAfter(wait, retries, now);
    // The host's own merge queue took this version, or was read to have
    // removed it: kept apart from the wait, which any later stop replaces.
    const handed =
      wait === "host-queue"
        ? current.handed?.head === head && current.handed.removed === undefined
          ? current.handed
          : { head, at: now }
        : wait === "host-removed" && current.handed?.head === head
          ? { ...current.handed, removed: current.handed.removed ?? now }
          : current.handed;
    this.host.tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...current,
        waiting: { on: wait, head, at: now },
        retries,
        retryAt,
        ...(handed ? { handed } : {}),
        // Only the attempt this run recorded is spent by its answer: one
        // standing from before it is a merge still to read back.
        ...(result.stop !== "outcome" && current.attempt?.token !== authorization.attempt?.token
          ? { attempt: undefined }
          : current.attempt && result.mergeTask
            ? { attempt: { ...current.attempt, task: result.mergeTask } }
            : {}),
      },
    });
    return { wait, head, changed };
  }

  /**
   * The checks a host-run merge makes before it asks anything of GitHub
   * (FI3-304 section 4): the task and pull request are still the approved
   * ones, no new merge card replaced the approval, and a declared repair
   * is not still undecided; no review is read (INF-1876). A failed
   * identity check ends the approval; the others are waits.
   */
  private authorizationIdentity(
    record: TaskRecord,
    authorization: MergeAuthorization,
  ): string | undefined {
    const target = authorization.target;
    const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
    // The approval is kept to its own pull request, never to whichever of
    // the task's is current (INF-2746).
    const pull = authorization.review
      ? { branch: authorization.review.branch, review: authorization.review }
      : taskPull(record, this.host.tasks.changesFor(record.id), target.prNumber, {
          repoId: target.repoId,
          branch: target.branch,
        });
    const changeRepo = this.changeRepoOf(record, repo, authorization.review ?? pull?.review);
    const location = changeRepo ? forgeLocationOf(publicationRepo(record, changeRepo)) : undefined;
    return !opensPullRequest(this.host.taskDelivery(record.id))
      ? "the project no longer delivers as a pull request"
      : record.repoId !== target.repoId || !repo
        ? "the task's project is no longer the one approved"
        : !hasChangeRequests(changeRepo?.host?.kind) ||
            location?.host !== target.host ||
            location.owner !== target.owner ||
            location.name !== target.name
          ? "where the project lives changed"
          : // The approved pull request must still be one of the task's (INF-2746).
            pull?.branch !== target.branch
            ? PULL_NOT_THE_TASKS
            : undefined;
  }

  /**
   * The project a pull request of the task is in: another managed one when
   * open_change opened it there (INF-2510), else the task's own. `review`
   * names it; undefined is the task's own change.
   */
  private changeRepoOf(
    record: TaskRecord,
    own: ReturnType<RepoRegistry["get"]>,
    review: { repoId?: string } | undefined,
  ): ReturnType<RepoRegistry["get"]> {
    const target = review;
    return target?.repoId && target.repoId !== record.repoId
      ? this.host.repos.get(target.repoId)
      : own;
  }

  /**
   * Whether an open merge card asks again for the change this approval
   * covers: a new card for the same change supersedes it, while a card for
   * another of the task's pull requests stands beside it (INF-2744).
   */
  private supersedingCard(taskId: string, authorization: MergeAuthorization): boolean {
    const open = this.host.cards.openMergeAction(taskId, { review: authorization.review?.id });
    return open !== undefined;
  }

  preflight(
    record: TaskRecord,
    authorization: MergeAuthorization,
  ): { ended: true } | { wait: MergeWait } | undefined {
    const identity = this.authorizationIdentity(record, authorization);
    if (identity) {
      this.endAuthorization(record.id, "invalidated", identity, { feed: true });
      return { ended: true };
    }
    if (this.supersedingCard(record.id, authorization)) {
      this.endAuthorization(record.id, "superseded", "its crewmate put up a new merge card");
      return { ended: true };
    }
    if (outstandingGuidance(authorization) !== undefined) return { wait: "guidance" };
    if (authorization.undecided) {
      // Its crewmate could not judge the repair: one independent assessment
      // decides it. An end it brings tells the crewmate itself, so the wait
      // below then records nothing.
      this.host.assessRepair?.(record.id);
      return { wait: "evidence" };
    }
    return undefined;
  }

  /**
   * Store the approved head's change reading on the approval (INF-416 G)
   * when a review was recorded on the task. The click is the moment that
   * version enters the record. A later kept merge compares this stored
   * fact and does not read the branch again. An unreadable commit stores
   * nothing.
   */
  async storeApprovalReading(taskId: string, authorization: MergeAuthorization): Promise<void> {
    if (authorization.changeReading) return;
    const record = this.host.tasks.get(taskId);
    if (!record?.delivery?.reviewVerdict) return;
    const read = this.host.workspace.reviewChangeReading;
    if (typeof read !== "function") return;
    try {
      const home = record.deviceId ? await this.host.placed?.bringBranchHome(taskId) : undefined;
      const fresh = this.host.tasks.get(taskId) ?? record;
      const repo = fresh.repoId ? this.host.repos.get(fresh.repoId) : undefined;
      const dir = home ?? repo?.path ?? fresh.repoDir;
      if (!dir) return;
      const reading = await read.call(this.host.workspace, dir, authorization.approvedHead);
      if (!reading) return;
      const current = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
      if (
        !current ||
        current.id !== authorization.id ||
        current.approvedHead !== authorization.approvedHead ||
        current.changeReading
      ) {
        return;
      }
      const delivery = this.host.tasks.get(taskId)?.delivery;
      this.host.tasks.delivery.recordApprovedChangeReading(taskId, {
        mergeAuthorization: { ...current, changeReading: reading },
        versionReadings: { ...delivery?.versionReadings, [authorization.approvedHead]: reading },
      });
    } catch {
      // An unreadable version stores nothing: the pass does not carry to it.
    }
  }

  /** Record a preflight wait on the standing approval; whether it is new for this head. */
  markWaiting(taskId: string, wait: MergeWait): { head: string; changed: boolean } | undefined {
    const current = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
    if (!current) return undefined;
    const head = candidateHead(current);
    const now = this.host.now();
    const changed = current.waiting?.on !== wait || current.waiting.head !== head;
    const retries = changed ? 0 : (current.retries ?? 0) + 1;
    this.host.tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...current,
        waiting: { on: wait, head, at: now },
        retries,
        retryAt: retryAfter(wait, retries, now),
      },
    });
    return { head, changed };
  }

  /** Whether the task's own change merges in this person's batch (docs/forge.md, "Batches of your own"). */
  private ownBatch(
    record: TaskRecord,
    repo: ReturnType<RepoRegistry["get"]>,
    review: { repoId?: string } | undefined,
  ): boolean {
    return (
      !review &&
      repo !== undefined &&
      ownsBatches(deliveryForRecord(record, repo.delivery), repo) === true
    );
  }

  /**
   * What the first mate is told beside a checks wait whose failure is the
   * batch's check at the version the change is at (INF-3208, docs/forge.md,
   * "Batches of your own"); undefined on any other wait.
   */
  batchWarning(taskId: string, wait: MergeWait): string | undefined {
    if (wait !== "checks") return undefined;
    const record = this.host.tasks.get(taskId);
    const repo = record?.repoId ? this.host.repos.get(record.repoId) : undefined;
    const head = record?.delivery?.headSha;
    return record &&
      head &&
      deliveryForRecord(record, repo?.delivery) === "queue-pr" &&
      failedBatch(record.delivery, head)
      ? FAILED_BATCH_NOTE
      : undefined;
  }
}
