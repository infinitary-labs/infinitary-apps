import type {
  ChangeChecks,
  ChangeConsent,
  ChangeHandle,
  ChangeOverride,
  ChangeReceipt,
  ChangeRecord,
  ChangeReview,
  ChangeStory,
  ChangeVersion,
} from "@shared/change";
import type { ChangePresentationRecord } from "@shared/changePresentation";
import { type ForgeKind, forgeOf, hasChangeRequests, sameRequestLink } from "@shared/forge";
import { changeHostOf, changePageUrl } from "@shared/forgeKinds";
import { isForkReview, type MergeReview } from "@shared/mergeReview";
import type { RepoKind } from "@shared/repos";
import type { TaskPullRequest } from "@shared/tasks";
import type { TaskDelivery, TaskRecord } from "./taskRecords";

/**
 * What a task's delivery slot says about its changes, read as the change
 * record (INF-1868 piece 1, `docs/task-record.md` "A task's change"): the
 * task's own change, on its own branch, and one change for every other pull
 * request it names, whoever opened it (INF-2490). Pure: every value comes
 * from the record and the project's row, and a fact the slot does not name
 * is left out, never made up.
 */

/** The project facts the change reads: that it is a project, and the host it lives on. */
export type ChangeRepo = { kind: RepoKind; forge: ForgeKind };

/** A change the record keeps, less what the store assigns: its id and its clock. */
export type ProjectedChange = Omit<ChangeRecord, "id" | "createdAt" | "updatedAt" | "versions"> & {
  versions: Omit<ChangeRecord["versions"][number], "seq">[];
};

/**
 * A task the host raised on another task's change - a review of its pull
 * request, a repair assessment - stamped `kind_source: host:…` by the host.
 * It carries no change of its own.
 */
export function isHostRaisedShape(shape: { kind_source?: string } | null | undefined): boolean {
  return shape?.kind_source?.startsWith("host:") ?? false;
}

/**
 * Whether this task carries a change the record keeps: work on a project
 * the app manages, on a branch of its own, not building in place and not
 * raised by the host on another task's change, while the task is open.
 */
export function carriesChange(record: TaskRecord, repo: ChangeRepo | undefined): boolean {
  if (record.kind !== "work") return false;
  if (record.status !== "open" && record.status !== "active") return false;
  if (!record.repoId || !record.branch) return false;
  if (repo?.kind !== "project") return false;
  if (record.delivery?.mode === "in-place") return false;
  return !isHostRaisedShape(record.shape);
}

const MERGED_CLOSES = new Set<string>(["merged", "landed", "released"]);

/** Whether a task's close is the one that merged its change. */
export function mergingClose(reason: string | null | undefined): boolean {
  return MERGED_CLOSES.has(reason ?? "");
}

/**
 * The task's current change (INF-2490, `primitives/changes.md`): the pull
 * request a review selected on another branch, else the task's own. The
 * slot's readings follow it, and every merge card is shown for it and
 * merges it.
 */
export function currentChange(
  delivery: Pick<TaskDelivery, "checkTarget" | "prNumber"> | null | undefined,
  ownBranch: string,
): { number: number | undefined; branch: string } {
  const target = delivery?.checkTarget;
  return target
    ? { number: target.number, branch: target.branch }
    : { number: delivery?.prNumber, branch: ownBranch };
}

/** Every story ledger the slot keeps: the current change's, then each other change's. */
export function storyLedgers(
  delivery: Pick<TaskDelivery, "presentation" | "presentations"> | null | undefined,
): ChangePresentationRecord[] {
  return [
    ...(delivery?.presentation ? [delivery.presentation] : []),
    ...(delivery?.presentations ?? []),
  ];
}

/**
 * The story ledger of the change on `branch` (INF-2490): each change keeps
 * its own. A ledger saved before then names no branch and is the task's own
 * branch's.
 */
export function storyLedgerOf(
  delivery: Pick<TaskDelivery, "presentation" | "presentations"> | null | undefined,
  ownBranch: string,
  branch: string,
  forkNumber?: number,
): ChangePresentationRecord | undefined {
  return storyLedgers(delivery).find(
    (ledger) => (ledger.branch ?? ownBranch) === branch && ledger.forkNumber === forkNumber,
  );
}

/**
 * A story ledger nothing of which has left this computer (INF-3995): no
 * publication claimed, published, reconciled or confirmed on a pushed
 * branch, and no attachment sent. Only such a story can move to another
 * change's branch.
 */
export function storyNeverSent(ledger: ChangePresentationRecord): boolean {
  return (
    !ledger.publication &&
    !ledger.published &&
    !ledger.reconciled &&
    !ledger.completion &&
    ledger.receipts.every((receipt) => receipt.state === "prepared")
  );
}

/**
 * The story ledgers placed for the current change: its own in
 * `presentation`, the one field older readers read, and every other
 * change's in `presentations`.
 */
export function placeStories(
  ledgers: readonly ChangePresentationRecord[],
  ownBranch: string,
  currentBranch: string,
  forkNumber?: number,
): Pick<TaskDelivery, "presentation" | "presentations"> {
  const current = ledgers.find(
    (ledger) => (ledger.branch ?? ownBranch) === currentBranch && ledger.forkNumber === forkNumber,
  );
  const others = ledgers.filter((ledger) => ledger !== current);
  return { presentation: current, presentations: others.length > 0 ? others : undefined };
}

/** Every review the slot keeps: its reviews, its selection and its approval's. */
function reviewsOf(delivery: TaskDelivery): MergeReview[] {
  return [
    ...(delivery.mergeReviews ?? []),
    ...(delivery.checkTarget ? [delivery.checkTarget] : []),
    ...(delivery.mergeAuthorization?.review ? [delivery.mergeAuthorization.review] : []),
  ];
}

/**
 * The pull requests the slot records that are not on the task's own branch,
 * by number: each is a change of its own (INF-2490). A review saved before
 * then also names whose it was; its branch says the same.
 */
function referencedNumbers(delivery: TaskDelivery, branch: string): Set<number> {
  const numbers = new Set<number>();
  for (const review of reviewsOf(delivery))
    if (review.branch !== branch || isForkReview(review)) numbers.add(review.number);
  return numbers;
}

/** The slot's override as its writers save it: the record keeps it without the pull request it binds it by. */
type SlotOverride = ChangeOverride & { prNumber?: number; prUrl?: string };

/**
 * The slot's facts about the task's own change (`docs/forge.md`, "A
 * requested merge"): a reading of a referenced pull request writes its
 * number, page, label and base and the head it read with its checks, and an
 * approval of it is consent to merge that pull request, not this change.
 * Each fact names the pull request it belongs to, and the record binds it by
 * that number alone: the number group carries it, the checks are stamped
 * with the number of the pull request they were read of
 * (`CheckSnapshot.prNumber`) and the head, state and times read with them
 * go with that stamp, a head read with no checks goes with the number group
 * it was written beside, an approval names the review it approved, and an
 * override given for one version names the pull request that version
 * belonged to. A fact that names a referenced pull request is not this
 * change's, whatever the current selection. The task's own number is read
 * from the facts that never follow a selection - its owned reviews and
 * completion offers - because a reading never transfers branch ownership. A
 * reading or a version override saved before its writer stamped it is this
 * change's only in a slot that records no referenced pull request; in one
 * that does, the host cannot tell whose it was, so it is nobody's and the
 * record leaves it out.
 */
function ownFacts(delivery: TaskDelivery, branch: string): TaskDelivery {
  const referenced = referencedNumbers(delivery, branch);
  const own: TaskDelivery = { ...delivery };
  const numberReferenced = delivery.prNumber !== undefined && referenced.has(delivery.prNumber);
  // A completion offer names the change that was current when it went up,
  // which may be another branch's pull request (INF-2490).
  own.completionOffers = delivery.completionOffers?.filter(
    (offer) => offer.prNumber === undefined || !referenced.has(offer.prNumber),
  );
  if (!own.completionOffers) delete own.completionOffers;
  if (numberReferenced) {
    delete own.prNumber;
    delete own.prUrl;
    delete own.changeLabel;
    delete own.prBase;
    const number =
      (delivery.mergeReviews ?? []).find(
        (review) => review.branch === branch && !isForkReview(review),
      )?.number ?? own.completionOffers?.find((offer) => offer.prNumber !== undefined)?.prNumber;
    if (number !== undefined) own.prNumber = number;
  }
  if (
    delivery.mergeAuthorization &&
    (delivery.mergeAuthorization.target.branch !== branch ||
      (delivery.mergeAuthorization.target.prNumber !== undefined &&
        referenced.has(delivery.mergeAuthorization.target.prNumber)))
  )
    delete own.mergeAuthorization;
  own.mergeReviews = delivery.mergeReviews?.filter((review) => !referenced.has(review.number));
  if (delivery.checkTarget && referenced.has(delivery.checkTarget.number)) delete own.checkTarget;
  // Each change keeps its own story (INF-2490): this change's is the ledger
  // kept for its branch, while it was not published on another's pull request.
  const story = storyLedgerOf(delivery, branch, branch);
  const storyNumber = story?.published?.number ?? story?.publication?.number;
  delete own.presentations;
  if (story && (storyNumber === undefined || !referenced.has(storyNumber)))
    own.presentation = story;
  else delete own.presentation;
  const ownNumber = (number: number | undefined): boolean =>
    number !== undefined &&
    !referenced.has(number) &&
    (own.prNumber === undefined || number === own.prNumber);
  const stamp = delivery.checks?.prNumber;
  const readingOwn =
    stamp !== undefined
      ? ownNumber(stamp)
      : delivery.checks !== undefined
        ? referenced.size === 0
        : !numberReferenced;
  if (!readingOwn) {
    delete own.headSha;
    delete own.checks;
    delete own.ci;
    delete own.ciAt;
    delete own.ciStartedAt;
    delete own.ciFinishedAt;
    delete own.mainChecks;
  }
  const override = delivery.override as SlotOverride | undefined;
  if (override) {
    const version = override.until !== "task" && override.head !== undefined;
    const foreign =
      override.prNumber !== undefined
        ? !ownNumber(override.prNumber)
        : version && referenced.size > 0;
    if (foreign) delete own.override;
  }
  return own;
}

function handleOf(delivery: TaskDelivery | null, repo: ChangeRepo): ChangeHandle | null {
  if (!delivery?.prNumber || !hasChangeRequests(repo.forge)) return null;
  return {
    kind: changeHostOf(repo.forge).handle,
    number: delivery.prNumber,
    ...(delivery.prUrl ? { url: delivery.prUrl } : {}),
    ...(delivery.changeLabel ? { label: delivery.changeLabel } : {}),
  };
}

/**
 * The base the slot names for this pull request: the one the host named at
 * the last reading or the open (`prBase`), else its newest owned merge
 * review's, else the approval's.
 */
function baseOf(delivery: TaskDelivery | null, branch: string): string | null {
  const number = delivery?.prNumber;
  if (!delivery || number === undefined) return null;
  if (delivery.prBase) return delivery.prBase;
  const owned = (delivery.mergeReviews ?? [])
    .filter((review) => review.branch === branch && review.number === number)
    .sort((a, b) => b.at - a.at)[0];
  if (owned) return owned.base;
  const approved = delivery.mergeAuthorization?.review;
  if (approved?.number === number) return approved.base;
  const target = delivery.checkTarget;
  if (target?.branch === branch && target.number === number) return target.base;
  return null;
}

/**
 * The slot's override as the record keeps it: for the whole task, or for one
 * version. A version override the slot still names after `ownFacts` is this
 * change's, so its head is a pushed one (`pushed`): it was given for a
 * version the host held.
 */
function overrideOf(delivery: TaskDelivery | null): {
  task: ChangeOverride | null;
  version: ChangeOverride | null;
  pushed: ChangeOverride | null;
} {
  const slot = delivery?.override as SlotOverride | undefined;
  if (!slot) return { task: null, version: null, pushed: null };
  const { prNumber: _bound, prUrl: _request, ...override } = slot;
  if (
    override.until !== "task" &&
    (slot.prNumber !== undefined || slot.prUrl !== undefined) &&
    !sameRequestLink(slot.prUrl, delivery?.prUrl)
  )
    return { task: null, version: null, pushed: null };
  if (override.until === "task" || !override.head)
    return { task: override, version: null, pushed: null };
  return { task: null, version: override, pushed: override };
}

/**
 * The heads the project's host saw, oldest first - a version is a head
 * pushed (the captain's plan): a check read, an owned merge review, a
 * published story, a merge click and the repairs it was carried to, a
 * completion offer, and an override given for one version (`pushed`, as
 * `overrideOf` binds it). A review, a lines reading or a story prepared at a
 * head the host has not seen makes no version; they attach once it is
 * pushed. A dated version sorts by its earliest date, an undated one after
 * them in the order the slot names it, and the current head last, followed
 * only by the versions a declared repair carried the approval to after it,
 * in the lineage's own order. A head the record already holds (`recorded`)
 * follows them, so what the slot says at it refreshes whether or not a
 * pushed-head fact still names it.
 */
function headsOf(
  delivery: TaskDelivery,
  recorded: readonly string[],
  pushed: ChangeOverride | null,
  branch: string,
): { head: string; at: number | null }[] {
  const seen = new Map<string, number | null>();
  const note = (head: string | null | undefined, at: number | null | undefined): void => {
    if (!head) return;
    const time = at ?? null;
    const known = seen.get(head);
    if (known === undefined) seen.set(head, time);
    else if (time !== null && (known === null || time < known)) seen.set(head, time);
  };
  const authorization = delivery.mergeAuthorization;
  const offers = delivery.completionOffers ?? [];
  if (authorization) {
    const offer = offers.find((entry) => entry.headSha === authorization.approvedHead);
    note(authorization.approvedHead, offer?.at ?? authorization.at);
    for (const step of authorization.lineage) note(step.toHead, step.at);
  }
  for (const offer of offers) note(offer.headSha, offer.at);
  for (const review of delivery.mergeReviews ?? [])
    if (review.branch === branch && review.number === delivery.prNumber)
      note(review.headSha, review.at);
  note(delivery.checks?.headSha, delivery.ciAt);
  note(delivery.presentation?.completion?.head, null);
  note(delivery.presentation?.published?.head, null);
  note(delivery.presentation?.publication?.head, null);
  note(pushed?.head, pushed?.at);
  note(
    delivery.headSha,
    !delivery.checks || delivery.checks.headSha === delivery.headSha ? delivery.ciAt : null,
  );
  const current = delivery.headSha;
  // A declared repair names the version it carried the approval to before
  // the host reads it, so the approval's lineage - the approved head, then
  // each repair's head in turn - is the one typed order that places a head
  // the host was told of after the one it last read.
  const chain = authorization
    ? [authorization.approvedHead, ...authorization.lineage.map((step) => step.toHead)]
    : [];
  const position = current ? chain.indexOf(current) : -1;
  const later = position >= 0 ? chain.slice(position + 1) : [];
  const others = [...seen.entries()].filter(([head]) => head !== current && !later.includes(head));
  const dated = others
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .sort((a, b) => a[1] - b[1]);
  const undated = others.filter((entry) => entry[1] === null);
  const known = recorded
    .filter((head) => !seen.has(head))
    .map((head) => [head, null] as [string, number | null]);
  return [
    ...dated,
    ...undated,
    ...(current ? [[current, seen.get(current) ?? null] as [string, number | null]] : []),
    ...later
      .filter((head) => seen.has(head))
      .map((head) => [head, seen.get(head) ?? null] as [string, number | null]),
    ...known,
  ].map(([head, at]) => ({ head, at }));
}

function checksAt(delivery: TaskDelivery, head: string): ChangeChecks | null {
  const checks: ChangeChecks = {};
  if (delivery.checks?.headSha === head) checks.snapshot = delivery.checks;
  if ((delivery.checks?.headSha === head || delivery.headSha === head) && delivery.ci) {
    checks.state = delivery.ci;
    if (delivery.ciAt !== undefined) checks.at = delivery.ciAt;
    if (delivery.ciStartedAt !== undefined) checks.startedAt = delivery.ciStartedAt;
    if (delivery.ciFinishedAt !== undefined) checks.finishedAt = delivery.ciFinishedAt;
  }
  if (delivery.changeLines?.head === head) {
    const { base, added, deleted, at } = delivery.changeLines;
    checks.lines = { base, added, deleted, at };
  }
  if (delivery.mainChecks?.head === head && delivery.checks?.headSha === head) {
    const { sha, at, items } = delivery.mainChecks;
    checks.main = { sha, at, items };
  }
  return Object.keys(checks).length > 0 ? checks : null;
}

function reviewAt(delivery: TaskDelivery, head: string): ChangeReview | null {
  if (delivery.reviewSha !== head || !delivery.reviewVerdict) return null;
  // The typed review record at this version (INF-1875) carries the findings
  // the verdict rests on; an older record without one carries none.
  const findings = delivery.liveValidation?.reviews.findLast(
    (review) => review.head === head && review.findings !== undefined,
  )?.findings;
  return {
    verdict: delivery.reviewVerdict,
    ...(findings ? { findings } : {}),
    ...(delivery.reviewRisk ? { risk: delivery.reviewRisk } : {}),
    ...(delivery.reviewRiskNote ? { riskNote: delivery.reviewRiskNote } : {}),
    ...(delivery.reviewedAt !== undefined ? { at: delivery.reviewedAt } : {}),
    ...(delivery.reviewChange ? { reading: delivery.reviewChange } : {}),
  };
}

function storyAt(delivery: TaskDelivery, head: string): ChangeStory | null {
  const presentation = delivery.presentation;
  if (!presentation) return null;
  const revisions = presentation.revisions
    .filter((revision) => revision.head === head)
    .map((revision) => ({ revision: revision.revision, title: revision.title }));
  const publication =
    presentation.published?.head === head
      ? presentation.published
      : presentation.publication?.head === head
        ? presentation.publication
        : undefined;
  if (revisions.length === 0 && !publication) return null;
  return {
    revisions,
    ...(publication
      ? {
          published: {
            revision: publication.revision,
            state: publication.state,
            ...(publication.number !== undefined ? { number: publication.number } : {}),
          },
        }
      : {}),
  };
}

function consentAt(
  delivery: TaskDelivery,
  head: string,
  override: ChangeOverride | null,
): ChangeConsent | null {
  const consent: ChangeConsent = {};
  const authorization = delivery.mergeAuthorization;
  if (authorization?.approvedHead === head)
    consent.click = {
      authorization: authorization.id,
      generation: authorization.generation,
      card: {
        id: authorization.card.id,
        offerId: authorization.card.offerId,
        actionId: authorization.card.actionId,
      },
      status: authorization.status,
      at: authorization.at,
    };
  const step = authorization?.lineage.find((entry) => entry.toHead === head);
  if (authorization && step)
    consent.carried = {
      authorization: authorization.id,
      from: step.fromHead,
      impact: step.impact,
      generation: step.generation,
      at: step.at,
    };
  if (override?.head === head) consent.override = override;
  return Object.keys(consent).length > 0 ? consent : null;
}

/**
 * Where the change stands (INF-2490): merged once a merge of it is on the
 * record - its approval's receipt, its review's, or a reading of it that
 * found it merged. The slot's own merge facts and the task's close are the
 * current change's: the change current when the task closed is the one
 * whose merge closed it, so only it takes them. Of a closed task's other
 * changes, its own change reads closed, with no reason naming another's
 * merge, and a pull request it named takes nothing from the close.
 */
function receiptOf(
  record: TaskRecord,
  delivery: TaskDelivery | null,
  branch: string,
  place: { own: boolean; current: boolean },
): ChangeReceipt | null {
  const authorization = delivery?.mergeAuthorization;
  const reviewed = (delivery ? reviewsOf(delivery) : []).find(
    (review) =>
      review.branch === branch &&
      review.receipt &&
      (delivery?.prNumber === undefined || review.number === delivery.prNumber),
  )?.receipt;
  // The task's finishing merge and its close are the current change's: read
  // from the whole slot, since they name no pull request of their own.
  const closing = place.current ? record : undefined;
  const finished = place.current ? record.delivery : undefined;
  const merged =
    Boolean(authorization?.receipt) ||
    Boolean(reviewed) ||
    delivery?.ci === "merged" ||
    Boolean(finished?.mergedSha) ||
    Boolean(finished?.landedMode) ||
    MERGED_CLOSES.has(closing?.closedReason ?? "");
  if (merged) {
    const head =
      authorization?.receipt?.head ?? reviewed?.head ?? finished?.landedHead ?? delivery?.headSha;
    const sha = finished?.mergedSha ?? authorization?.receipt?.sha ?? reviewed?.sha;
    return {
      outcome: "merged",
      ...(closing?.closedReason ? { reason: closing.closedReason } : {}),
      ...(head ? { head } : {}),
      ...(sha ? { sha } : {}),
      // The app's own merge under autonomy is not the captain's (INF-2744).
      ...((authorization?.receipt && authorization.issuer !== "autonomy") ||
      reviewed?.by === "captain"
        ? { by: "captain" as const }
        : {}),
      // A merge that kept its task open has no merging close: the reading
      // that saw it merged keeps its time, even after a later close
      // (INF-2678).
      at:
        authorization?.receipt?.at ??
        reviewed?.at ??
        (mergingClose(closing?.closedReason) ? closing?.closedAt : undefined) ??
        (delivery?.ci === "merged" || finished?.landedMode ? delivery?.ciAt : undefined) ??
        closing?.closedAt ??
        null,
    };
  }
  if (record.status !== "done" && record.status !== "dropped") return null;
  if (!place.own && !place.current) return null;
  return {
    outcome: record.closedReason === "discarded" ? "discarded" : "closed",
    ...(closing?.closedReason ? { reason: closing.closedReason } : {}),
    at: record.closedAt ?? null,
  };
}

/**
 * The receipt of the change the task's record names now, read from the
 * record itself (INF-2678): the same fact its change row keeps, for a task
 * with a project or without one.
 */
export function currentReceipt(record: TaskRecord): ChangeReceipt | null {
  const delivery = record.delivery ? ownFacts(record.delivery, record.branch) : null;
  return receiptOf(record, delivery, record.branch, {
    own: true,
    current:
      currentChange(record.delivery, record.branch).branch === record.branch &&
      !(record.delivery?.checkTarget && isForkReview(record.delivery.checkTarget)),
  });
}

/**
 * The change this task's record describes, every fact as the slot names it.
 * `recorded` names the heads the change already has versions of: what the
 * slot says at them is read too, while a new version still takes a pushed head.
 */
export function projectChange(
  record: TaskRecord,
  repo: ChangeRepo,
  recorded: readonly string[] = [],
): ProjectedChange {
  const delivery = record.delivery ? ownFacts(record.delivery, record.branch) : null;
  return projected(record, repo, delivery, record.branch, recorded, {
    own: true,
    current:
      currentChange(record.delivery, record.branch).branch === record.branch &&
      !(record.delivery?.checkTarget && isForkReview(record.delivery.checkTarget)),
  });
}

function projected(
  record: TaskRecord,
  repo: ChangeRepo,
  delivery: TaskDelivery | null,
  branch: string,
  recorded: readonly string[],
  place: { own: boolean; current: boolean },
): ProjectedChange {
  const override = overrideOf(delivery);
  return {
    repoId: record.repoId ?? "",
    base: baseOf(delivery, branch),
    head: { branch },
    handle: handleOf(delivery, repo),
    raisedBy: { kind: "task", task: record.id },
    taskId: record.id,
    override: override.task,
    receipt: receiptOf(record, delivery, branch, place),
    versions: delivery
      ? headsOf(delivery, recorded, override.pushed, branch).map(({ head, at }) => ({
          head,
          at,
          checks: checksAt(delivery, head),
          review: reviewAt(delivery, head),
          story: storyAt(delivery, head),
          consent: consentAt(delivery, head, override.version),
        }))
      : [],
  };
}

/**
 * The pull requests a task names besides its own change, by number: every
 * one it reviewed, selected or was approved to merge on another branch
 * (INF-2490). Each is a change of its own.
 */
export function otherChangeNumbers(record: TaskRecord): number[] {
  return record.delivery ? [...referencedNumbers(record.delivery, record.branch)] : [];
}

/**
 * The slot's facts about one other pull request the task names (INF-2490):
 * each fact that names that number, by the same stamps `ownFacts` reads -
 * its reviews, the approval that targets it, the offers and the override
 * given for it, the reading stamped with its number, and the story published
 * on it. A reading or an override saved before its writer stamped it names
 * no number, so it is never another change's.
 */
function factsFor(
  delivery: TaskDelivery,
  number: number,
  story: ChangePresentationRecord | undefined,
): TaskDelivery {
  const mode = delivery.mode;
  const named = delivery.prNumber === number;
  const reading = delivery.checks?.prNumber === number;
  const approval = delivery.mergeAuthorization;
  const override = delivery.override as SlotOverride | undefined;
  const reviews = reviewsOf(delivery).filter((review) => review.number === number);
  const storyNumber = story?.published?.number ?? story?.publication?.number;
  return {
    mode,
    prNumber: number,
    ...(named && delivery.prUrl ? { prUrl: delivery.prUrl } : {}),
    ...(named && delivery.changeLabel ? { changeLabel: delivery.changeLabel } : {}),
    ...(named && delivery.prBase ? { prBase: delivery.prBase } : {}),
    mergeReviews: reviews,
    ...(approval?.target.prNumber === number ? { mergeAuthorization: approval } : {}),
    completionOffers: (delivery.completionOffers ?? []).filter(
      (offer) => offer.prNumber === number,
    ),
    ...(reading
      ? {
          checks: delivery.checks,
          ...(named && delivery.headSha ? { headSha: delivery.headSha } : {}),
          ...(delivery.ci ? { ci: delivery.ci } : {}),
          ...(delivery.ciAt !== undefined ? { ciAt: delivery.ciAt } : {}),
          ...(delivery.ciStartedAt !== undefined ? { ciStartedAt: delivery.ciStartedAt } : {}),
          ...(delivery.ciFinishedAt !== undefined ? { ciFinishedAt: delivery.ciFinishedAt } : {}),
          ...(delivery.mainChecks ? { mainChecks: delivery.mainChecks } : {}),
        }
      : {}),
    ...(override?.until === "task" || override?.prNumber === number
      ? { override: delivery.override }
      : {}),
    // Its own story: the ledger kept for its branch, while it was published on this pull request.
    ...(story && (storyNumber === undefined || storyNumber === number)
      ? { presentation: story }
      : {}),
  };
}

/**
 * One other pull request the task names, as a change of its own (INF-2490):
 * on the branch its reviews name, raised on this task's record. It is
 * merged once a merge of it is on the record; the task's close is its own
 * only when it was the current change then.
 */
export function projectOtherChange(
  record: TaskRecord,
  repo: ChangeRepo,
  number: number,
  recorded: readonly string[] = [],
): ProjectedChange {
  if (!record.delivery) throw new Error(`Task ${record.id} names no pull request #${number}.`);
  const branch = otherBranchOf(record.delivery, number);
  const delivery = factsFor(
    record.delivery,
    number,
    storyLedgerOf(
      record.delivery,
      record.branch,
      branch,
      record.delivery.mergeReviews?.some(
        (review) => review.number === number && isForkReview(review),
      )
        ? number
        : undefined,
    ),
  );
  const review =
    record.delivery.checkTarget?.number === number
      ? record.delivery.checkTarget
      : [...(delivery.mergeReviews ?? [])].sort((a, b) => b.at - a.at)[0];
  // A typed review supplies the request's repository even when the host does not send a page.
  const page =
    review &&
    changePageUrl(
      review.kind,
      review.host,
      [review.owner, review.name]
        .flatMap((part) => part.split("/"))
        .map(encodeURIComponent)
        .join("/"),
      number,
    );
  const previousPage = delivery.prUrl;
  // Selection is recorded before the new reading: a URL still in the slot can belong to the previous request.
  const sameSlot = sameRequestLink(page, previousPage);
  if (page && !sameSlot) {
    delivery.prUrl = undefined;
    delivery.prBase = undefined;
    delivery.changeLabel = undefined;
    if (delivery.override?.until !== "task") delivery.override = undefined;
    delivery.checks = undefined;
    delivery.headSha = undefined;
    delivery.ci = undefined;
    delivery.ciAt = undefined;
    delivery.ciStartedAt = undefined;
    delivery.ciFinishedAt = undefined;
    delivery.mainChecks = undefined;
  }
  if (review && page) {
    const matches = (host: string, owner: string, name: string) =>
      sameRequestLink(page, changePageUrl(review.kind, host, `${owner}/${name}`, number));
    delivery.mergeReviews = delivery.mergeReviews?.filter(
      (item) => item.kind === review.kind && matches(item.host, item.owner, item.name),
    );
    const target = delivery.mergeAuthorization?.target;
    if (target && !matches(target.host, target.owner, target.name))
      delivery.mergeAuthorization = undefined;
    delivery.completionOffers = delivery.completionOffers?.filter((offer) => {
      if (!offer.destination) return sameSlot;
      const { host, owner, name } = forgeOf(offer.destination.origin);
      return !!host && !!owner && !!name && matches(host, owner, name);
    });
    const published = delivery.presentation?.published ?? delivery.presentation?.publication;
    const destination = delivery.presentation?.revisions.find(
      (item) => item.revision === published?.revision,
    )?.destination;
    if (
      published &&
      (!destination ||
        !("host" in destination) ||
        !sameRequestLink(
          page,
          changePageUrl(review.kind, destination.host, destination.fullName, number),
        ))
    )
      delivery.presentation = undefined;
  }
  const change = projected(record, repo, delivery, review?.branch ?? branch, recorded, {
    own: false,
    current: record.delivery.checkTarget?.number === number,
  });
  const handle = change.handle;
  // `repo` is the project it is in: another managed one when the task opened it there.
  return {
    ...change,
    repoId: otherChangeRepoId(record, number) ?? change.repoId,
    base: change.base ?? review?.base ?? null,
    handle: handle && !handle.url && page ? { ...handle, url: page } : handle,
  };
}

/**
 * The managed project another pull request the task names is in, as its
 * newest review says (INF-2510): another project open_change opened it in,
 * else undefined for the task's own.
 */
export function otherChangeRepoId(record: TaskRecord, number: number): string | undefined {
  if (!record.delivery) return undefined;
  const review =
    (record.delivery.checkTarget?.number === number ? record.delivery.checkTarget : undefined) ??
    reviewsOf(record.delivery)
      .filter((entry) => entry.number === number)
      .sort((a, b) => b.at - a.at)[0];
  return review?.repoId && review.repoId !== record.repoId ? review.repoId : undefined;
}

/** The branch another pull request the task names is on, as its newest review or its approval says. */
function otherBranchOf(delivery: TaskDelivery, number: number): string {
  const review = reviewsOf(delivery)
    .filter((entry) => entry.number === number)
    .sort((a, b) => b.at - a.at)[0];
  return (
    review?.branch ??
    (delivery.mergeAuthorization?.target.prNumber === number
      ? delivery.mergeAuthorization.target.branch
      : "")
  );
}

/**
 * Every pull request on the task, as its record's Info tab lists them
 * (INF-2490 round two, `docs/task-record.md`): one line for each change the
 * record keeps with a pull request, in number order, with the checks last
 * read last, whichever version they were read at, and whether it merged. Merging
 * closes the task only for the change the open finishing card was shown for
 * (`finishing`), while it is unmerged: a continuing merge or a reading of a
 * pull request declares nothing.
 */
export function taskPullRequestsOf(
  changes: readonly ChangeRecord[],
  finishing: number | undefined,
): TaskPullRequest[] {
  const lines = new Map<number, TaskPullRequest>();
  for (const change of changes) {
    const number = change.handle?.number;
    if (number === undefined) continue;
    // Versions keep the order the host first saw them, so the newest
    // reading is the one read last, never the last version's (INF-2490).
    const ci = change.versions.reduce<ChangeVersion | undefined>(
      (latest, version) =>
        version.checks?.state && (version.checks.at ?? 0) >= (latest?.checks?.at ?? 0)
          ? version
          : latest,
      undefined,
    )?.checks?.state;
    const merged = change.receipt?.outcome === "merged";
    lines.set(number, {
      number,
      ...(change.handle?.url ? { url: change.handle.url } : {}),
      ...(ci ? { ci } : {}),
      ...(merged ? { merged: true as const } : {}),
      ...(!merged && number === finishing ? { closes: true as const } : {}),
    });
  }
  return [...lines.values()].sort((a, b) => a.number - b.number);
}
