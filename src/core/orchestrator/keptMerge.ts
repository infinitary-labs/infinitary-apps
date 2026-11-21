import { currentCheckStatus } from "@shared/checkSnapshot";
import { forgePlace } from "@shared/forge";
import type { ForgePull } from "../forge";
import type { MergeAuthorization, MergeWait } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { mergedReceipt, otherMergedFacts } from "./changeMerge";
import type { KeptApproval } from "./keptApproval";
import {
  candidateHead,
  keptFeedLine,
  keptFeedSaid,
  keptNote,
  retryAfter,
  standingAuthorization,
  wakesFirstmate,
} from "./mergeAuthorization";
import { pinnedRequestRepo } from "./publicationRepo";
import type { SettleOutcome, SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";
import { describeStatus, type SettleService } from "./settleService";
import { changeName, placeOf } from "./settleWords";
import type { TaskClosing } from "./taskClose";

/**
 * Merges run under the captain's kept approval (FI3-304): the click's own
 * attempt, the retries the approval's waits schedule, reconciling an attempt
 * whose answer never came, and the approvals a restart finds standing. The
 * approval's state is `./keptApproval.ts`'s; a merge settles through
 * `./settleService.ts`.
 */
export class KeptMerge {
  constructor(
    private readonly host: SettleServiceHost,
    private readonly locks: SettleLocks,
    private readonly approvals: KeptApproval,
    private readonly closing: TaskClosing,
    private readonly settle: SettleService,
  ) {}

  /**
   * A merge card's merge of a reviewed pull request (INF-2490, INF-2744):
   * the captain's click, or the run of an approval the click or the app
   * kept. Declaring the action merged nothing. What follows is the card's
   * own declaration: `continue` keeps the task and its working copy and its
   * crewmate hears the outcome once; `close` closes the task as merged once
   * nothing else on it is open.
   */
  async requestMerge(
    taskId: string,
    reviewId: string,
    unattended = false,
    declared?: "close" | "continue",
  ): Promise<SettleOutcome & { continued?: boolean }> {
    const refuse = (result: SettleOutcome): SettleOutcome => {
      const review = this.host.tasks
        .get(taskId)
        ?.delivery?.mergeReviews?.find((item) => item.id === reviewId);
      if (!unattended) this.host.mergeContinued?.(taskId, review, result);
      return result;
    };
    if (this.locks.holder(taskId)) {
      return refuse({
        ok: false,
        text: "Cannot merge: another settle is already in progress.",
        contention: true,
      });
    }
    const record = this.host.tasks.get(taskId);
    if (!record) return refuse({ ok: false, text: `Cannot merge: unknown task ${taskId}.` });
    if (record.status === "done" || record.status === "dropped") {
      return refuse({
        ok: false,
        text: `Cannot merge: task ${taskId} is already ${describeStatus(record)}.`,
      });
    }
    if (!this.host.mergeReview) {
      return refuse({
        ok: false,
        text: "Cannot merge: where the project lives is not reachable from here.",
      });
    }
    const authorization = standingAuthorization(record.delivery);
    const approved = authorization?.review?.id === reviewId ? authorization : undefined;
    const review =
      approved?.review ?? record.delivery?.mergeReviews?.find((item) => item.id === reviewId);
    if (unattended && !approved)
      return { ok: false, stop: "withdrawn", text: "The kept merge approval no longer stands." };
    const lease = this.locks.claim(taskId, "merge-pr");
    try {
      await this.approvals.queueMarksSettled(taskId);
      const result = await this.host.mergeReview(
        taskId,
        reviewId,
        approved ? this.approvals.guardOf(taskId, approved, unattended) : undefined,
      );
      if (!result.ok) {
        const kept = approved ? this.approvals.afterAttempt(taskId, approved, result) : undefined;
        const outcome = kept
          ? {
              ...result,
              text: `${result.text}\n\n${keptNote(kept.wait, kept.head, placeOf(this.host.repos, record), currentCheckStatus(this.host.tasks.get(taskId)?.delivery), this.approvals.batchWarning(taskId, kept.wait), result.skip)}`,
            }
          : result;
        if (kept?.changed && unattended)
          this.noteWait(taskId, record.title, kept.head, result, kept.wait);
        else if (kept?.changed) {
          this.settle.settleLine(
            taskId,
            keptFeedSaid(
              kept.wait,
              placeOf(this.host.repos, record, ""),
              currentCheckStatus(this.host.tasks.get(taskId)?.delivery),
            ),
          );
        }
        if (!unattended && review && kept?.wait !== "host-queue" && kept?.wait !== "queue")
          this.host.mergeContinued?.(taskId, review, outcome);
        return outcome;
      }
      const then = declared ?? approved?.after ?? "continue";
      const actor = approved?.issuer === "autonomy" ? "app" : "captain";
      return await this.settle.finishReviewMerge(taskId, review, result, then, actor);
    } finally {
      lease.release();
    }
  }

  /**
   * Run the standing approval once, as the host on the captain's behalf: at
   * every crewmate idle boundary, on the tick when a timed wait comes due,
   * and at boot. It merges only the candidate head, only after the
   * preflight, GitHub's own readiness, every page of the checks and the
   * last look before the request; what stops it is a wait on the approval
   * (a quiet timeline line, and one wake where someone else must move) or
   * an end that the feed and the Firstmate hear.
   * It reads no review (INF-1876).
   */
  async runMergeAuthorization(taskId: string): Promise<void> {
    await this.approvals.queueMarksSettled(taskId);
    // Each approved pull request on the task goes ahead on its own
    // (INF-2746): the one in front runs, and when it did not merge or end
    // it steps back so the next runs in the same pass. Each runs once.
    const ran = new Set<string>();
    for (;;) {
      // Another settle holds the task: the pass ends, and a run that tried
      // nothing yet comes back once it ends. A run that tried an approval arms
      // no retry, or two runs started together would re-arm each other's
      // settles without end.
      if (this.locks.holder(taskId)) {
        if (ran.size === 0) this.locks.retryWhenFree(taskId);
        return;
      }
      // The next approval comes to the front when the one there ended.
      this.approvals.promoteQueued(taskId);
      const front = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
      if (!front || ran.has(front.id)) return;
      ran.add(front.id);
      if (!(await this.runFront(taskId, front))) return;
      this.approvals.stepBack(taskId, front.id);
    }
  }

  /**
   * One run of the approval in front; whether the next may run in this
   * pass - not while its crewmate works, a request is out or another
   * settle holds the task.
   */
  private async runFront(taskId: string, authorization: MergeAuthorization): Promise<boolean> {
    const record = this.host.tasks.get(taskId);
    if (!record || TaskService.isClosed(record)) return false;
    if (record.pendingSettle || this.locks.working(taskId)) return false;
    if (authorization.attempt) {
      await this.reconcileAttempt(taskId, authorization);
      return false;
    }
    const title = record.title;
    // An approval the app kept from the merge card passes the one merge gate
    // again on every run (INF-2744): autonomy turned off, a crewmate's
    // asks-first or a hold ends it, and the merge is the captain's.
    if (authorization.issuer === "autonomy") {
      const held = this.settle.mergeRefusal(record, "merge-pr", "app", undefined, {
        review: authorization.review?.id,
      });
      if (held) {
        this.approvals.endAuthorization(taskId, "revoked", "this task no longer merges on its own");
        this.reportEnded(taskId, title);
        return true;
      }
    }
    const checked = this.approvals.preflight(this.host.tasks.get(taskId) ?? record, authorization);
    if (checked && "ended" in checked) {
      this.reportEnded(taskId, title);
      return true;
    }
    if (checked) {
      const wait = this.approvals.markWaiting(taskId, checked.wait);
      if (wait?.changed) {
        this.noteWait(
          taskId,
          title,
          wait.head,
          {
            ok: false,
            text: keptFeedLine(
              checked.wait,
              placeOf(this.host.repos, record),
              currentCheckStatus(this.host.tasks.get(taskId)?.delivery),
            ),
          },
          checked.wait,
        );
      }
      return true;
    }
    if (authorization.review) {
      const result = await this.requestMerge(taskId, authorization.review.id, true);
      if (result.contention) return false;
      if (
        !result.ok &&
        standingAuthorization(this.host.tasks.get(taskId)?.delivery)?.id !== authorization.id
      )
        this.reportEnded(taskId, title, result);
      return true;
    }
    // The task's own change merges as its current change: an approval that
    // waited while another pull request was selected selects its own now,
    // with its crewmate idle (INF-2746).
    this.approvals.selectCovered(taskId, authorization);
    let result: SettleOutcome;
    try {
      result = await this.settle.settleTaskGuarded(
        taskId,
        "merge-pr",
        undefined,
        authorization.issuer === "autonomy" ? "app" : "captain",
        authorization.proceedWithOpen,
        this.approvals.guardOf(taskId, authorization, true),
        authorization.after,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      result = {
        ok: false,
        text: `Could not complete merge-pr for task ${taskId}: ${message}`,
        problem: message,
      };
    }
    if (result.contention) return false;
    if (result.ok) {
      this.settle.reportOutcome(taskId, title, "merge-pr", undefined, result, undefined);
      return true;
    }
    const kept = this.approvals.afterAttempt(taskId, authorization, result);
    if (!kept) {
      if (result.stop !== "withdrawn") this.reportEnded(taskId, title, result);
      return true;
    }
    if (kept.changed) this.noteWait(taskId, title, kept.head, result, kept.wait);
    return true;
  }

  /**
   * A wait that is new for this head: a quiet line on the task's timeline
   * with the raw words, and one wake to the Firstmate when someone other
   * than the crewmate the check watch already wakes has to move.
   */
  private noteWait(
    taskId: string,
    title: string,
    head: string,
    result: SettleOutcome,
    wait: MergeWait,
  ): void {
    this.host.tasks.note(taskId, `The kept merge did not run yet: ${result.text}`, {
      news: true,
      ...(result.problem || result.plain
        ? { data: { problem: result.problem ?? result.plain } }
        : {}),
    });
    if (!wakesFirstmate(wait)) return;
    const record = this.host.tasks.get(taskId);
    const place = placeOf(this.host.repos, record);
    this.settle.settleLine(
      taskId,
      keptFeedSaid(
        wait,
        placeOf(this.host.repos, record, ""),
        currentCheckStatus(record?.delivery),
      ),
    );
    this.settle.wakeOnSettle(
      taskId,
      title,
      "merge-pr (kept)",
      {
        ...result,
        text: `${result.text}\n\n${keptNote(wait, head, place, currentCheckStatus(record?.delivery), this.approvals.batchWarning(taskId, wait), result.skip)}`,
      },
      [],
      standingAuthorization(record?.delivery)?.issuer !== "autonomy",
    );
  }

  /**
   * The approval ended on a host-run attempt: the Firstmate hears why. A
   * new merge card superseding it needs no word - the card is up.
   */
  private reportEnded(taskId: string, title: string, result?: SettleOutcome): void {
    const ended = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization;
    if (ended?.status === "superseded") return;
    const reason = ended?.reason;
    const whose = ended?.issuer === "autonomy" ? "The app's" : "The captain's";
    const text = `${whose} kept merge approval for "${title}" ended: ${reason ?? "it no longer stands"}. A new merge card is the way to merge it.`;
    this.settle.wakeOnSettle(
      taskId,
      title,
      "merge-pr (kept)",
      { ok: false, text: result ? `${result.text}\n\n${text}` : text },
      [],
      ended?.issuer !== "autonomy",
    );
  }

  /**
   * An attempt token outlived its answer - the app quit or the answer
   * never came (FI3-304 section 5). The pinned pull request decides: merged
   * means the approval is spent and the task closes once; closed ends it;
   * open clears the token and runs every gate again, except on a host whose
   * merge names no version, where open proves nothing and it waits like an
   * unreadable one, never sending again, until it reads merged or closed;
   * a host refusing the read of the merge it took (`attempt.task`) keeps
   * that wait.
   */
  private async reconcileAttempt(taskId: string, authorization: MergeAuthorization): Promise<void> {
    const readPull = this.host.readPull;
    let pull: ForgePull | undefined;
    try {
      const number = authorization.target.prNumber;
      pull =
        readPull && number !== undefined
          ? await readPull(taskId, number, authorization.attempt?.task, authorization.target)
          : undefined;
    } catch {
      pull = undefined;
    }
    const record = this.host.tasks.get(taskId);
    const current = standingAuthorization(record?.delivery);
    if (
      !record ||
      current?.id !== authorization.id ||
      current.generation !== authorization.generation
    ) {
      return;
    }
    const now = this.host.now();
    // An open read cannot show that a merge sent to a host naming no version
    // did not go in (a 202 still merging, or an answer that never came): it
    // stays read-only, and only a read showing it merged or closed moves it.
    // The attempt is carried into any later approval of the same pull
    // request, so no click sends again while the outcome is unknown.
    if (!pull || (pull.state === "open" && !pull.merged && pull.mergeNamesNoVersion)) {
      const retries = (current.retries ?? 0) + 1;
      // The host refused the read of the merge it took: the merge may have
      // failed, or the task may not be this pull request's, and nothing says
      // which. The reference is dropped, so it is asked about once, and the
      // task says once that the pull request is merged or closed on the host.
      const refused = pull?.mergeTaskRefused && current.attempt?.task !== undefined;
      this.approvals.patchStanding(taskId, {
        waiting: { on: "outcome", head: candidateHead(current), at: now },
        retries,
        retryAt: retryAfter("outcome", retries, now),
        ...(refused && current.attempt ? { attempt: { ...current.attempt, task: undefined } } : {}),
      });
      if (refused)
        this.host.tasks.note(
          taskId,
          // i18n-exempt: an English timeline note, like the approval's other notes
          "The host would not say how the merge it took ended, so the merge stays unsent until its pull request reads merged or closed on the host; nothing is sent again.",
          { news: true, feed: true },
        );
      return;
    }
    if (pull.merged) {
      await this.finishMerged(taskId, record.title, pull);
      return;
    }
    if (pull.state !== "open") {
      // Closed without merging: the merge sent did not go in, so nothing is
      // left unsettled for a later approval to read back.
      this.approvals.patchStanding(taskId, { attempt: undefined });
      this.approvals.endAuthorization(
        taskId,
        "invalidated",
        "its pull request was closed without merging",
        {
          feed: true,
        },
      );
      this.reportEnded(taskId, record.title);
      return;
    }
    this.approvals.patchStanding(taskId, { attempt: undefined, retryAt: now });
    await this.runMergeAuthorization(taskId);
  }

  /** A merge the reconcile found already done: spend the approval and close the task once. */
  private async finishMerged(taskId: string, title: string, pull: ForgePull): Promise<void> {
    if (this.locks.holder(taskId)) return;
    const lease = this.locks.claim(taskId, "merge-pr");
    try {
      const authorization = standingAuthorization(this.host.tasks.get(taskId)?.delivery);
      const named = this.host.tasks.get(taskId);
      // The version it merged against the approved one, said as the merge
      // said it at once (INF-5193): a push after approval is told.
      const other = otherMergedFacts(
        placeOf(this.host.repos, named, "") || null,
        changeName(named, pull.number),
        pull.headSha,
        // The version the original send was approved at, not a later
        // approval's: a push after that click is told even when a newer
        // approval stands (INF-5193).
        authorization ? (authorization.attempt?.head ?? candidateHead(authorization)) : undefined,
      );
      // A kept approval of a reviewed pull request merged it (INF-2490):
      // its merge card declared what follows (INF-2744).
      if (authorization?.review) {
        const then = authorization.after ?? "continue";
        const result = await this.settle.finishReviewMerge(
          taskId,
          authorization.review,
          {
            ok: true,
            text: `Merged ${changeName(named, pull.number)} on ${placeOf(this.host.repos, named)}.${other.told}${then === "continue" ? " The task stays open." : ""}`,
            ...other.line,
            receipt: mergedReceipt(pull),
          },
          then,
          authorization.issuer === "autonomy" ? "app" : "captain",
        );
        if (!result.continued)
          this.settle.reportOutcome(taskId, title, "merge-pr", undefined, result, undefined);
        return;
      }
      this.approvals.consumeStanding(taskId, mergedReceipt(pull));
      const record = this.host.tasks.get(taskId);
      const text = `Merged ${changeName(record, pull.number)} on ${placeOf(this.host.repos, record)}.${other.told}`;
      // Something else on the task still open keeps it open (INF-2525).
      const stillOpen = record
        ? await this.settle.stillOpen(record, pull.number, authorization?.after)
        : undefined;
      if (stillOpen) {
        this.host.tasks.delivery.recordChangeEvidence(taskId, {
          ci: "merged",
          headSha: pull.headSha,
          ciAt: this.host.now(),
          ciWatch: undefined,
        });
        const continued = { ok: true, text, continued: true, stillOpen };
        this.settle.finishContinued(taskId, undefined, continued);
        this.settle.reportOutcome(taskId, title, "merge-pr", undefined, continued, undefined);
        return;
      }
      await this.closing.closeTask(taskId, {
        status: "done",
        reason: "merged",
        actor: authorization?.issuer === "autonomy" ? "host" : "captain",
        text,
        ...(other.line ? { data: { line: other.line.line, lineSaid: other.line.lineSaid } } : {}),
        delivery: { landedMode: "pr", ...(pull.mergedSha ? { mergedSha: pull.mergedSha } : {}) },
      });
      this.settle.reportOutcome(
        taskId,
        title,
        "merge-pr",
        undefined,
        { ok: true, text },
        undefined,
      );
    } finally {
      lease.release();
    }
  }

  /**
   * The tick's rider: every standing approval whose timed wait came due
   * runs again (FI3-304: persisted delayed reconciliation, never a hot loop
   * that a restart resets), and every send no standing approval reads is
   * read back (`reconcileUnsettledSends`).
   */
  reconcileMergeAuthorizations(now: number): void {
    for (const record of this.host.tasks.listLive()) {
      const top = record.delivery?.mergeAuthorization;
      const others = top?.queued ?? [];
      const due =
        // Any of the task's approvals whose timed wait came due (INF-2746),
        // or others still there after the one in front ended.
        [...(top?.status === "standing" ? [top] : []), ...others].some(
          (item) => item.retryAt !== undefined && item.retryAt <= now,
        ) ||
        (top?.status !== "standing" && others.length > 0);
      if (!due) continue;
      void this.runMergeAuthorization(record.id).catch((caught: unknown) => {
        console.warn("[settle] a kept merge approval could not run:", caught);
      });
    }
    // One pass at a time: a slow read is never overtaken by the next tick's.
    if (this.readingUnsettled) return;
    this.readingUnsettled = true;
    void this.reconcileUnsettledSends(now)
      .catch((caught: unknown) => {
        console.warn("[settle] a merge sent earlier could not be read back:", caught);
      })
      .finally(() => {
        this.readingUnsettled = false;
      });
  }

  private readingUnsettled = false;
  /** When each unsettled send was last read, by task and attempt token: the minute pass's backoff. */
  private readonly unsettledReads = new Map<string, { retries: number; retryAt?: number }>();

  /**
   * Merges sent whose outcome was never read back that no standing approval
   * reads (INF-5193): an ended approval's attempt and the unsettled entries
   * carried past it, on any task, closed ones included. Each is read in the
   * repository its approval pinned: one reading merged or closed is settled
   * and leaves the record, so it holds no send of that pull request any
   * more (`KeptApproval.unresolvedSend`); one reading open, or unreadable,
   * stays, read again on the outcome wait's backoff. A merge it finds made
   * is said once on its task. Nothing is ever sent from here.
   */
  async reconcileUnsettledSends(now: number): Promise<void> {
    const readPull = this.host.readPull;
    if (!readPull) return;
    for (const record of this.host.tasks.unresolvedMergeSends()) {
      const top = record.delivery?.mergeAuthorization;
      if (!top) continue;
      const sends = [
        ...(top.attempt && top.status !== "standing"
          ? [{ target: top.target, attempt: top.attempt }]
          : []),
        ...(top.unsettled ?? []),
      ];
      for (const send of sends) {
        const key = `${record.id}:${send.attempt.token}`;
        const due = this.unsettledReads.get(key);
        if (due?.retryAt !== undefined && due.retryAt > now) continue;
        const number = send.target.prNumber;
        let pull: ForgePull | undefined;
        try {
          pull =
            number === undefined
              ? undefined
              : await readPull(record.id, number, send.attempt.task, send.target);
        } catch {
          pull = undefined;
        }
        const settled = pull && (pull.merged || pull.state !== "open");
        if (!settled) {
          const retries = (due?.retries ?? 0) + 1;
          this.unsettledReads.set(key, { retries, retryAt: retryAfter("outcome", retries, now) });
          if (pull?.mergeTaskRefused) this.leaveUnsettled(record.id, send.attempt.token, true);
          continue;
        }
        this.unsettledReads.delete(key);
        if (!this.leaveUnsettled(record.id, send.attempt.token, false) || !pull?.merged) continue;
        const named = this.host.tasks.get(record.id);
        // Said where it was read, and against the version that send was
        // approved at: a push after that click is told (INF-5193).
        const destination = named
          ? pinnedRequestRepo(named, this.host.repos, send.target)
          : undefined;
        const place =
          (destination?.host
            ? forgePlace({ kind: destination.host.kind, host: destination.host.name })
            : null) ?? placeOf(this.host.repos, named, "");
        const change = changeName(named, pull.number);
        const other = otherMergedFacts(place || null, change, pull.headSha, send.attempt.head);
        this.host.tasks.note(
          record.id,
          // i18n-exempt: an English timeline note, like the approval's other notes
          `The merge sent earlier of ${change} went in on ${place || "the project's host"}.${other.told}`,
          {
            news: true,
            feed: true,
            ...(other.line
              ? { data: { line: other.line.line, lineSaid: other.line.lineSaid } }
              : {}),
          },
        );
      }
    }
  }

  /**
   * Settle one unsettled send on the task's approval record, read again now:
   * drop it, or with `taskOnly` only the host's reference to it, which was
   * refused and is asked about once. Only a send still where it was read
   * moves: one a standing approval took meanwhile is that approval's to read.
   */
  private leaveUnsettled(taskId: string, token: string, taskOnly: boolean): boolean {
    const top = this.host.tasks.get(taskId)?.delivery?.mergeAuthorization;
    if (!top) return false;
    const settle = <T extends { token: string; task?: string }>(attempt: T): T | undefined =>
      taskOnly ? { ...attempt, task: undefined } : undefined;
    if (top.attempt?.token === token && top.status !== "standing") {
      this.host.tasks.delivery.recordPermissionRecords(taskId, {
        mergeAuthorization: { ...top, attempt: settle(top.attempt) },
      });
      return true;
    }
    const entry = top.unsettled?.find((item) => item.attempt.token === token);
    if (!entry) return false;
    const rest = (top.unsettled ?? []).flatMap((item) => {
      if (item !== entry) return [item];
      const attempt = settle(item.attempt);
      return attempt ? [{ ...item, attempt }] : [];
    });
    this.host.tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: { ...top, unsettled: rest.length > 0 ? rest : undefined },
    });
    return true;
  }

  /**
   * At boot: contract 4.66's unversioned kept click names no approved head,
   * so it is retired and said, never carried forward; every standing
   * approval runs once - an attempt token first reads its pull request back.
   */
  resumeMergeAuthorizations(): void {
    for (const record of this.host.tasks.pendingQueueRemovals())
      void this.approvals.queueMarksSettled(record.id).catch(() => {});
    for (const record of this.host.tasks.listLive()) {
      if (record.delivery?.mergeOrder) {
        this.host.tasks.delivery.recordPermissionRecords(record.id, { mergeOrder: undefined });
        const text = `The kept merge click for "${record.title}" was made before this version and names no approved version, so it could not be carried forward. Its crewmate puts up its merge card again once the checks pass.`;
        this.host.tasks.note(record.id, text, { news: true, feed: true });
        this.settle.wakeOnSettle(record.id, record.title, "merge-pr (kept before this version)", {
          ok: false,
          text,
        });
      }
      const approval = record.delivery?.mergeAuthorization;
      if (approval) this.approvals.restoreQueueMarks(record.id, approval);
      if (
        !standingAuthorization(record.delivery) &&
        !record.delivery?.mergeAuthorization?.queued?.length
      )
        continue;
      void this.runMergeAuthorization(record.id).catch((caught: unknown) => {
        console.warn("[settle] a kept merge approval could not resume:", caught);
      });
    }
  }
}
