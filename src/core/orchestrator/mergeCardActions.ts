import { type Card, mergeEffectOf } from "@shared/cards";
import { readyPresentation } from "@shared/changePresentation";
import { currentCheckStatus, failedBatch } from "@shared/checkSnapshot";
import { hasChangeRequests, sameRequestLink } from "@shared/forge";
import { changePageUrl } from "@shared/forgeKinds";
import { choiceWords, type HoldOverride, overridePasses, overrideWords } from "@shared/holds";
import { storyAtOrigin } from "@shared/presentationDestination";
import { opensPullRequest } from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import { MERGE_WORDS, mergeWordsFor, REVIEW_CAREFULLY_WORDS } from "@shared/vocabulary";
import { currentChange } from "../storage/changeProjection";
import { TaskGraphRefusal } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import type { CardActionUndone } from "./captainWakes";
import type { CrewCore } from "./crewCore";
import { approvableOffer, matchesOfferDestination, taskPull } from "./mergeAuthorization";
import { publicationRepo } from "./publicationRepo";
import { servedCardLine } from "./readerData";
import type { MergeBehind } from "./settleCardFacts";
import { mergesInOwnBatch } from "./workShape";

/**
 * The merge card's part of the captain's card actions (`CardActions`, which
 * composes it): which version a merge click approves and what the card says
 * its merge does, both read the same way by the click and by the card's
 * drawing, and the buttons beside the merge - Review carefully and Merge
 * anyway - that change the task before the merge runs.
 */
export class MergeCardActions {
  constructor(private readonly core: CrewCore) {}

  /**
   * A merge effect in the task's own words: the PR on a direct-pr repo, the
   * branch into the local checkout otherwise. The agent that declared the
   * effect never learns the difference (ruling D2).
   */
  mergeModeFor(taskId: string): "merge-pr" | "land" {
    return opensPullRequest(this.core.facts.taskDelivery(taskId)) ? "merge-pr" : "land";
  }

  /**
   * Why an open merge card no longer shows its task's current change
   * (INF-4031), the one fact its click and its drawing both read. A card
   * shown for another change than the current one is behind it (INF-2490),
   * unless its click is kept to the pull request it showed (INF-2746).
   * Approval follows the code, never the story's words (INF-3623): a card
   * with a story is behind after another commit - the newest story's
   * version, or the pull request's own newer one; a newer story at the
   * version it showed only asks for a redraw.
   */
  mergeBehind(
    card: Card,
    associated = card.taskId ? this.core.options.tasks.get(card.taskId) : undefined,
  ): MergeBehind | null | undefined {
    if (!associated || TaskService.isClosed(associated)) return undefined;
    const delivery = associated.delivery;
    const offered = delivery?.completionOffers?.find(
      (offer) => offer.cardId === card.id && offer.offerId === card.offerId,
    );
    // A card with no offer of its own shows no version to fall behind.
    if (!offered) return undefined;
    if (offered.retired) return { why: "other", shown: offered.headSha };
    const shownFor = offered.shownFor ?? offered.prNumber;
    const current = currentChange(delivery, associated.branch);
    const changes = this.core.options.tasks.changesFor(associated.id);
    const candidate = taskPull(associated, changes, shownFor, offered.destination);
    const repoId = offered.destination?.repoId ?? candidate?.review?.repoId ?? associated.repoId;
    const repo = repoId ? this.core.options.repos.get(repoId) : undefined;
    const another =
      shownFor !== undefined &&
      (shownFor !== current.number ||
        (current.branch !== offered.destination?.branch && offered.destination !== undefined) ||
        (delivery?.checkTarget?.repoId ?? associated.repoId) !== repoId);
    const elsewhere =
      another &&
      candidate &&
      approvableOffer(
        associated,
        repo,
        this.core.facts.taskDelivery(associated.id),
        { cardId: card.id, offerId: card.offerId },
        changes,
        candidate,
      )
        ? candidate
        : undefined;
    const shown = { shown: offered.headSha };
    if (
      (repo &&
        !matchesOfferDestination(associated, repo, offered, candidate?.branch ?? current.branch)) ||
      (offered.destination && !repo)
    )
      // An offer an earlier version saved names no destination: its click
      // approves nothing, though nothing else became the current change.
      return { why: !offered.destination && !another ? "earlier" : "other", ...shown };
    if (another && !elsewhere) return { why: "other", ...shown };
    const ledger = this.core.options.tasks.delivery.changePresentation(
      associated.id,
      elsewhere?.branch ?? current.branch,
      shownFor ?? current.number,
    );
    const newest = ledger?.revisions.at(-1);
    // Older plain-host cards did not bind the address. Keep their click only where
    // the currently confirmed story still identifies exactly what the card showed.
    if (
      repo?.origin &&
      opensPullRequest(this.core.facts.taskDelivery(associated.id)) &&
      !hasChangeRequests(repo.host?.kind) &&
      offered.presentationRevision !== undefined &&
      (!newest ||
        !storyAtOrigin(newest.destination, publicationRepo(associated, repo).origin ?? null) ||
        (!offered.destination &&
          (!offered.presentationContentHash ||
            readyPresentation(ledger)?.contentHash !== offered.presentationContentHash)))
    )
      return { why: "other", ...shown };
    // A branch-only change of a project that merges in batches of its own
    // records its pushed version the same way (INF-6241).
    const branchOnly =
      current.number === undefined &&
      current.branch === associated.branch &&
      mergesInOwnBatch(associated, repo);
    const read =
      !elsewhere && (current.number !== undefined || branchOnly) ? delivery?.headSha : undefined;
    const pushed = read !== undefined && read !== offered?.headSha;
    const story = ledger !== undefined || offered?.presentationRevision !== undefined;
    // Its publication is part of the reading, so a story confirmed published
    // after it was saved is read again and redrawn (INF-4031).
    const revision = newest
      ? {
          newest: newest.revision,
          published: `${ledger?.published?.revision ?? "-"}:${ledger?.publication?.state ?? "-"}`,
        }
      : {};
    if (story && (!offered?.presentationRevision || pushed || offered.headSha !== newest?.head)) {
      const now = pushed ? read : newest?.head;
      return { why: "pushed", ...shown, ...(now ? { current: now } : {}), ...revision };
    }
    if (newest && offered?.presentationRevision && newest.revision > offered.presentationRevision)
      return { why: "story", ...shown, current: newest.head, ...revision };
    return null;
  }

  /**
   * A merge click on a card with no offer of its own while the task's change
   * has a saved story (INF-3623): it shows no version the click could
   * approve, so it is refused, as before INF-4031.
   */
  unboundStoryClick(card: Card, associated: NonNullable<ReturnType<TaskService["get"]>>): boolean {
    const delivery = associated.delivery;
    if (delivery?.completionOffers?.some((o) => o.cardId === card.id && o.offerId === card.offerId))
      return false;
    const current = currentChange(delivery, associated.branch);
    return (
      this.core.options.tasks.delivery.changePresentation(
        associated.id,
        current.branch,
        current.number,
      ) !== undefined
    );
  }

  /**
   * What a completion card's merge says it does (captain INF-1555 F12):
   * pending checks keep the captain's approval and read Merge when checks pass;
   * failed checks read Merge after fixing errors (captain INF-1555 F20);
   * otherwise Merge the pull request. Raw check results remain separate. The captain's override on the checks
   * at the card's version passes either, so a click merges now and it reads
   * Merge the pull request (INF-756). Undefined - the
   * label as it stands - on a card whose click approves nothing
   * (`approvableOffer`), where a click on such checks is only refused.
   */
  mergeLabel(card: Card): string | undefined {
    const record = card.taskId ? this.core.options.tasks.get(card.taskId) : undefined;
    if (!record) return undefined;
    const repo = record.repoId ? this.core.options.repos.get(record.repoId) : undefined;
    const offer = approvableOffer(record, repo, this.core.facts.taskDelivery(record.id), {
      cardId: card.id,
      offerId: card.offerId,
    });
    if (!offer) return undefined;
    // A merge of a reviewed pull request merges it; the task's own change
    // goes in by its project's way, a batched one in the next batch (INF-4196).
    const delivery = this.core.facts.taskDelivery(record.id);
    const merge = card.actions.map(mergeEffectOf).find(Boolean);
    const passed = merge?.review
      ? MERGE_WORDS["merge-pr"]
      : mergeWordsFor(delivery, mergesInOwnBatch(record, repo));
    const head = offer.baseline.headSha;
    if (
      record.delivery?.headSha === head &&
      overridePasses(
        record.delivery,
        "checks",
        head,
        record.delivery?.prNumber === undefined ? undefined : (record.delivery.prUrl ?? null),
      )
    )
      return passed;
    const ci = currentCheckStatus(record.delivery);
    if (ci === "red") return MERGE_WORDS.afterFixing;
    return ci === "pending" ? MERGE_WORDS.whenChecksPass : passed;
  }

  /**
   * Whether a completion card offers Merge anyway beside its merge
   * (INF-1137 friction 6): on an offer a click would approve, while the
   * pull request is still at the card's version and its checks failed,
   * and the captain's override does not already pass them.
   * It goes when the checks no longer fail or a new version comes. Never
   * beside a failed batch check of a change that merges in a batch: no
   * checks override passes a batch, so it could do nothing a fix does not
   * (INF-3208).
   */
  mergeAnyway(card: Card): boolean {
    return this.checkExceptionTarget(card) !== undefined;
  }

  checkExceptionTarget(card: Card): { head: string; prNumber: number; prUrl: string } | undefined {
    const record = card.taskId ? this.core.options.tasks.get(card.taskId) : undefined;
    if (!record?.delivery) return undefined;
    const offered = record.delivery.completionOffers?.find(
      (item) => item.cardId === card.id && item.offerId === card.offerId,
    );
    const destination = offered?.destination;
    if (!offered || !destination || offered.prNumber === undefined) return undefined;
    const repo = this.core.options.repos.get(destination.repoId);
    const changes = this.core.options.tasks.changesFor(record.id);
    const pull = taskPull(record, changes, offered.prNumber, destination);
    const offer =
      pull &&
      approvableOffer(
        record,
        repo,
        this.core.facts.taskDelivery(record.id),
        { cardId: card.id, offerId: card.offerId },
        changes,
        pull,
      );
    if (!offer || !repo?.host) return undefined;
    const { headSha: head } = offer.baseline;
    const { host, owner, name } = offer;
    const prNumber = offered.prNumber;
    const prUrl = changePageUrl(repo.host.kind, host, `${owner}/${name}`, prNumber);
    const saved = changes.find(
      (item) =>
        item.repoId === destination.repoId &&
        item.head.branch === destination.branch &&
        sameRequestLink(item.handle?.url, prUrl),
    );
    const current = sameRequestLink(record.delivery.prUrl, prUrl);
    const red = current
      ? record.delivery.headSha === head && currentCheckStatus(record.delivery) === "red"
      : saved?.versions.at(-1)?.head === head && saved.versions.at(-1)?.checks?.state === "red";
    if (
      !red ||
      (current && failedBatch(record.delivery, head)) ||
      overridePasses(record.delivery, "checks", head, prUrl)
    )
      return undefined;
    return { head, prNumber, prUrl };
  }

  /**
   * The captain's care from a card's button (INF-562): the same writer and
   * notice as update_task, with the captain as its author and the merge
   * card as where it came from. A refusal is a feed line and the first
   * mate's wake, never a silent no-op.
   */
  careFromCard(card: Card, taskId: string, label: string, care: Rigor): boolean {
    const before = this.core.options.tasks.policiesOf(this.core.options.tasks.get(taskId));
    try {
      this.core.options.tasks.updateFields(
        taskId,
        { policies: { rigor: care }, direction: "the merge card" },
        "captain",
      );
    } catch (caught) {
      if (!(caught instanceof TaskGraphRefusal)) throw caught;
      this.core.options.broadcastEvent({ type: "firstmate_note", text: caught.message, taskId });
      this.cardActionUndone(card, taskId, label, "set-rigor", caught.message);
      return false;
    }
    this.core.policiesChanged(taskId, { rigor: care }, before);
    return true;
  }

  /**
   * The review the captain's Review carefully asks for (INF-1875): the app
   * starts it on the builder's committed version - the one its merge card
   * offered - as soon as the care is on the record. The click is a typed
   * fact starting an operation, never a judgment; the reviewer's brief
   * carries the card the captain read. A task whose record holds no words
   * of the captain's is reviewed against its goal (INF-4072 finding 1).
   * What the app cannot start it says in the feed and wakes the first mate
   * with at once, to start the review as on any Careful task.
   */
  async reviewFromCard(card: Card, taskId: string, label: string): Promise<void> {
    const builder = this.core.options.tasks.get(taskId);
    if (!builder || TaskService.isClosed(builder)) return;
    try {
      const { taskId: reviewId, review: assigned } = await this.core.intake.commissionReview(
        {
          title: `Review: ${builder.title}`,
          intent: builder.intent ?? { goal: builder.goal?.trim() || builder.title, userWords: "" },
          ...(builder.repoId ? { repoId: builder.repoId } : {}),
        },
        builder.id,
      );
      const review = this.core.options.tasks.get(reviewId);
      // The review reads the builder's newest commit, which can be newer
      // than the version the merge card offered: the note names both
      // when they differ (INF-3141).
      const offered = builder.delivery?.headSha;
      const at = assigned.head.slice(0, 7);
      if (this.core.options.tasks.get(taskId))
        this.core.options.tasks.note(
          taskId,
          `the app started review ${review?.key || reviewId} of version ${at}${
            offered && offered !== assigned.head
              ? `, newer than ${offered.slice(0, 7)} on the merge card`
              : ""
          }${assigned.uncommitted ? "; edits not yet committed are not in it" : ""}`,
          { news: true, data: { reviewTaskId: reviewId } },
        );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        text: `${REVIEW_CAREFULLY_WORDS}: the app could not start the review of ${builder.key || builder.id}: ${message}`,
        taskId,
      });
      this.cardActionUndone(card, taskId, label, "start-review", message);
    }
  }

  /**
   * A card button the app could not carry out (INF-4072 finding 1): the
   * first mate hears it at once, with the reason, on the task's ref.
   */
  private cardActionUndone(
    card: Card,
    taskId: string,
    label: string,
    undone: CardActionUndone,
    reason: string,
  ): void {
    const record = this.core.options.tasks.get(taskId);
    this.core.hooks().notifyOp(
      {
        facts: {
          kind: "card-action-undone",
          card: { id: card.id, title: servedCardLine(this.core.options.tasks, card, card.title) },
          task: {
            id: taskId,
            key: record?.key || taskId,
            title: record?.title ?? servedCardLine(this.core.options.tasks, card, card.title),
          },
          label: servedCardLine(this.core.options.tasks, card, label),
          undone,
          reason,
        },
      },
      "agent",
      taskId,
    );
  }

  /**
   * The captain's Merge anyway click (INF-1137 friction 6): his own word,
   * one click, that the failed checks do not hold the version the card
   * offers. It is the recorded override on the checks for that version
   * (`HoldOverride`), in his name and with the button's words as its
   * reason, so the merge it starts and every other site that reads the
   * checks hold see the same record. A new version brings the hold back.
   */
  passChecksFromCard(
    card: Card,
    target: { head: string; prNumber: number; prUrl: string },
    label: string,
    written?: string,
  ): void {
    const taskId = card.taskId;
    if (!taskId) return;
    const override: HoldOverride = {
      words: choiceWords(label, card.title, written),
      holds: ["checks"],
      until: "version",
      ...target,
      at: this.core.now(),
    };
    this.core.options.tasks.delivery.recordPermissionRecords(
      taskId,
      { override },
      {
        kind: "note",
        actor: "captain",
        feed: true,
        text: overrideWords(override),
        data: { news: true },
      },
    );
    this.core.overrides.overrideNoticed(taskId, override);
  }
}
