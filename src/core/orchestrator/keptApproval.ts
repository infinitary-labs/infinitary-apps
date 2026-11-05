import { randomUUID } from "node:crypto";
import { currentCheckStatus } from "@shared/checkSnapshot";
import { hasChangeRequests } from "@shared/forge";
import { opensPullRequest } from "@shared/repos";
import { forgeLocationOf, QUEUE_WAITING_WORDS } from "../forge";
import { currentChange } from "../storage/changeProjection";
import type { MergeAuthorization, MergeWait, TaskRecord } from "../storage/taskStore";
import { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { MergeGuard, PrOutcome } from "./changeMerge";
import {
  approvableOffer,
  candidateHead,
  endedAuthorization,
  keptFeedLine,
  outstandingGuidance,
  retryAfter,
  standingAuthorization,
} from "./mergeAuthorization";
import type { SettleOutcome, SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";
import {
  changeName,
  MERGE_PENDING_TITLE,
  MERGE_STOPPED_TITLE,
  mergePendingBody,
  mergePendingCardId,
  placeOf,
} from "./settleWords";

/**
 * The captain's click on a completion offer, as the click handler read it
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
      return result.stop;
    default:
      if (result.refusal?.refused === "not-signed-in") return "sign-in";
      if (result.notGreen) return "checks";
      return "refused";
  }
}

/**
 * The captain's kept merge approval (FI3-304, `./mergeAuthorization.ts`):
 * minting it at the click, the guard each attempt runs under, what an
 * attempt's outcome does to it, how it ends, and the pending-merge note that
 * keeps the click in view. It owns the approval's state on the task record;
 * the attempts themselves run in `./keptMerge.ts`.
 */
export class KeptApproval {
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
   */
  authorizeMerge(
    taskId: string,
    approval: MergeApproval,
    proceedWithOpen: boolean,
    reviewId?: string,
  ): void {
    const record = this.host.tasks.get(taskId);
    if (!record || TaskService.isClosed(record)) return;
    const now = this.host.now();
    const previous = record.delivery?.mergeAuthorization;
    const generation = (previous?.generation ?? 0) + 1;
    const minted = this.mint(record, approval, proceedWithOpen, generation, now, reviewId);
    if (minted) {
      // The approved review is the task's current change from the click on (INF-2490).
      const own = minted.review?.branch === record.branch;
      this.host.tasks.recordPermissionRecords(taskId, {
        mergeAuthorization: minted,
        ...(minted.review && !own ? { checkTarget: minted.review } : {}),
      });
      if (minted.review && own) this.host.tasks.selectOwnChange(taskId, minted.review);
      this.host.tasks.note(
        taskId,
        `The captain approved merging ${changeName(record, minted.target.prNumber)} at ${minted.approvedHead}.`,
        { news: true, data: { mergeAuthorization: minted.id, generation } },
      );
      return;
    }
    if (previous?.status === "standing") {
      this.endAuthorization(taskId, "superseded", "the captain clicked merge on another card");
    }
  }

  private mint(
    record: TaskRecord,
    approval: MergeApproval,
    proceedWithOpen: boolean,
    generation: number,
    now: number,
    reviewId?: string,
  ): MergeAuthorization | undefined {
    const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
    const review = reviewId
      ? record.delivery?.mergeReviews?.find((item) => item.id === reviewId)
      : undefined;
    // The review's own project: another managed one when the task opened it there (INF-2510).
    const reviewRepo = review?.repoId ? this.host.repos.get(review.repoId) : repo;
    const location = reviewRepo ? forgeLocationOf(reviewRepo) : undefined;
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
    const offer = review
      ? { baseline: { headSha: review.headSha, prNumber: review.number }, ...review }
      : approvableOffer(
          record,
          this.changeRepoOf(record, repo),
          this.host.taskDelivery(record.id),
          approval,
        );
    const offerId = approval.offerId;
    if (!offer || !offerId || !record.repoId || !record.branch) return undefined;
    const { baseline } = offer;
    return {
      version: 1,
      id: randomUUID(),
      generation,
      issuer: "captain",
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
        branch: review?.branch ?? currentChange(record.delivery, record.branch).branch,
        delivery: "direct-pr",
        method: "squash",
      },
      ...(review ? { review } : {}),
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
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: { ...authorization, ...patch },
    });
  }

  /** The merge happened under the standing approval: it is spent. */
  consumeStanding(taskId: string, receipt: PrOutcome["receipt"]): void {
    const now = this.host.now();
    const authorization = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
    if (!authorization) return;
    this.host.tasks.recordPermissionRecords(taskId, {
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
  }

  /**
   * End the standing approval (FI3-304 section 6): `revoked` by an
   * interruption or the captain's withdrawal, `invalidated` when the
   * approved work or pull request is no longer the one he approved,
   * `superseded` by a new completion card or click. The generation
   * advances, so a run already under way stops before it sends anything.
   * A revoked or work-changed end holds the task's merge for the captain.
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
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: endedAuthorization(authorization, {
        status,
        reason: why,
        endedAt: this.host.now(),
        generation: authorization.generation + 1,
        ...(options.holds ? { holds: true } : {}),
      }),
    });
    if (status === "superseded") this.clearPendingMerge(taskId, "superseded");
    else
      this.pendingMerge(taskId, `Your merge will not run: ${why}.`, {
        title: MERGE_STOPPED_TITLE,
        raise: false,
      });
    if (!TaskService.isClosed(record)) {
      this.host.tasks.note(taskId, `The captain's kept merge approval ended: ${why}.`, {
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
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: { ...authorization, guidance: { ...before, latest: mark, at: now } },
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
   * idle, no new completion card - which persists the attempt token the
   * restart reconcile reads (FI3-304 section 5). The same look before a
   * queue mark (`mark`) records nothing: no merge request goes out.
   */
  guardOf(taskId: string, authorization: MergeAuthorization, unattended: boolean) {
    const head = candidateHead(authorization);
    const guard: MergeGuard = {
      head,
      prNumber: authorization.target.prNumber,
      unattended,
      // The captain's guidance since his click holds the merge without
      // spending the approval, read right before the last look (FI3-662).
      held: () => {
        const now = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
        const mark = now?.id === authorization.id ? outstandingGuidance(now) : undefined;
        return mark === undefined
          ? undefined
          : `the captain's guidance (mark ${mark}) waits for its crewmate to declare its impact`;
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
        if (unattended && this.host.cards.openMergeAction(taskId)) {
          return "a new completion card is up";
        }
        if (mark) return undefined;
        this.host.tasks.recordPermissionRecords(taskId, {
          mergeAuthorization: {
            ...now,
            attempt: { token: randomUUID(), head: dispatchHead, at: this.host.now() },
          },
        });
        return undefined;
      },
    };
    return guard;
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
    if (!record || !current || current.id !== authorization.id || result.ok) return undefined;
    if (result.stop === "withdrawn") return undefined;
    const now = this.host.now();
    if (result.contention) {
      this.patchStanding(taskId, { retryAt: now });
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
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...current,
        waiting: { on: wait, head, at: now },
        retries,
        retryAt,
        ...(result.stop === "outcome" ? {} : { attempt: undefined }),
      },
    });
    return { wait, head, changed };
  }

  /**
   * The checks a host-run merge makes before it asks anything of GitHub
   * (FI3-304 section 4): the task and pull request are still the approved
   * ones, no new completion card replaced the approval, no round cap holds
   * the task, a declared repair is not still undecided, and a reviewed
   * task's review passed for this change. A failed identity
   * check ends the approval; the others are waits.
   */
  private authorizationIdentity(
    record: TaskRecord,
    authorization: MergeAuthorization,
  ): string | undefined {
    const target = authorization.target;
    const repo = record.repoId ? this.host.repos.get(record.repoId) : undefined;
    const changeRepo = this.changeRepoOf(record, repo);
    const location = changeRepo ? forgeLocationOf(changeRepo) : undefined;
    return !opensPullRequest(this.host.taskDelivery(record.id))
      ? "the project no longer delivers as a pull request"
      : record.repoId !== target.repoId || !repo
        ? "the task's project is no longer the one approved"
        : !hasChangeRequests(changeRepo?.host?.kind) ||
            location?.host !== target.host ||
            location.owner !== target.owner ||
            location.name !== target.name
          ? "where the project lives changed"
          : // The approved change must still be the task's current one (INF-2490).
            currentChange(record.delivery, record.branch).branch !== target.branch ||
              currentChange(record.delivery, record.branch).number !== target.prNumber
            ? "the task's current change is not the one approved"
            : undefined;
  }

  /**
   * The project the task's current change is in: another managed one when
   * open_change opened it there (INF-2510), else the task's own.
   */
  private changeRepoOf(
    record: TaskRecord,
    own: ReturnType<RepoRegistry["get"]>,
  ): ReturnType<RepoRegistry["get"]> {
    const target = record.delivery?.checkTarget;
    return target?.repoId && target.repoId !== record.repoId
      ? this.host.repos.get(target.repoId)
      : own;
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
    if (this.host.cards.openMergeAction(record.id)) {
      this.endAuthorization(record.id, "superseded", "its crewmate put up a new completion card");
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
      this.host.tasks.recordApprovedChangeReading(taskId, {
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
    this.host.tasks.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...current,
        waiting: { on: wait, head, at: now },
        retries,
        retryAt: retryAfter(wait, retries, now),
      },
    });
    return { head, changed };
  }

  /**
   * The captain's merge click stays in view (INF-1275): a note under the
   * task's key, raised at the click and revised in place on each new wait,
   * until the merge goes through (`clearPendingMerge`) or says why not.
   * `raise` false revises only a note already up.
   */
  pendingMerge(
    taskId: string,
    words: string,
    options: { title?: string; raise?: boolean } = {},
  ): void {
    const record = this.host.tasks.get(taskId);
    const id = mergePendingCardId(taskId);
    // A closed task's merge already went through or ended: a report that
    // arrives after the close never puts its note back up.
    if (!record || TaskService.isClosed(record)) return;
    if (options.raise === false && !this.host.cards.get(id)) return;
    this.host.cards.raiseHostCard(
      {
        id,
        title: options.title ?? MERGE_PENDING_TITLE,
        meta: record.key,
        body: mergePendingBody(words, record.title),
        actions: [],
      },
      { note: true },
    );
  }

  /** The merge went through or a new card took its place: the pending note goes. */
  clearPendingMerge(taskId: string, reason: string): void {
    this.host.cards.withdrawHostCard(mergePendingCardId(taskId), reason);
  }

  /** A kept approval's wait, in the pending note's words. */
  pendingWait(taskId: string, wait: MergeWait, raise = true): void {
    const record = this.host.tasks.get(taskId);
    // Only a standing approval waits: one already spent or ended has no wait to show.
    if (!standingAuthorization(record?.delivery)) return;
    this.pendingMerge(
      taskId,
      keptFeedLine(wait, placeOf(this.host.repos, record), currentCheckStatus(record?.delivery)),
      { ...(wait === "queue" ? { title: QUEUE_WAITING_WORDS } : {}), raise },
    );
  }
}
