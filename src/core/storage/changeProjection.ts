import type {
  ChangeChecks,
  ChangeConsent,
  ChangeHandle,
  ChangeOverride,
  ChangeReceipt,
  ChangeRecord,
  ChangeReview,
  ChangeStory,
} from "@shared/change";
import { type ForgeKind, hasChangeRequests } from "@shared/forge";
import type { RepoKind } from "@shared/repos";
import type { TaskDelivery, TaskRecord } from "./taskStore";

/**
 * What a task's delivery slot says about its change, read as the change
 * record (INF-1868 piece 1, `docs/task-record.md` "A task's change"). Pure:
 * every value comes from the record and the project's row, and a fact the
 * slot does not name is left out, never made up.
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

/**
 * The pull requests the slot records that are not this task's own, by
 * number: the ones its referenced reviews, selection and approval name.
 */
function referencedNumbers(delivery: TaskDelivery): Set<number> {
  const numbers = new Set<number>();
  const approval = delivery.mergeAuthorization;
  const reviews = [
    ...(delivery.mergeReviews ?? []),
    ...(delivery.checkTarget ? [delivery.checkTarget] : []),
    ...(approval?.review ? [approval.review] : []),
  ];
  for (const review of reviews)
    if (review.relationship === "referenced") numbers.add(review.number);
  return numbers;
}

/** The slot's override as its writers save it: the record keeps it without the pull request it binds it by. */
type SlotOverride = ChangeOverride & { prNumber?: number };

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
function ownFacts(delivery: TaskDelivery): TaskDelivery {
  const referenced = referencedNumbers(delivery);
  const own: TaskDelivery = { ...delivery };
  const numberReferenced = delivery.prNumber !== undefined && referenced.has(delivery.prNumber);
  if (numberReferenced) {
    delete own.prNumber;
    delete own.prUrl;
    delete own.changeLabel;
    delete own.prBase;
    const number =
      (delivery.mergeReviews ?? []).find((review) => review.relationship === "owned")?.number ??
      delivery.completionOffers?.[0]?.prNumber;
    if (number !== undefined) own.prNumber = number;
  }
  if (delivery.mergeAuthorization?.review?.relationship === "referenced")
    delete own.mergeAuthorization;
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
    kind: repo.forge === "gitlab" ? "mr" : "pr",
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
function baseOf(delivery: TaskDelivery | null): string | null {
  const number = delivery?.prNumber;
  if (!delivery || number === undefined) return null;
  if (delivery.prBase) return delivery.prBase;
  const owned = (delivery.mergeReviews ?? [])
    .filter((review) => review.relationship === "owned" && review.number === number)
    .sort((a, b) => b.at - a.at)[0];
  if (owned) return owned.base;
  const approved = delivery.mergeAuthorization?.review;
  if (approved?.number === number) return approved.base;
  const target = delivery.checkTarget;
  if (target?.relationship === "owned" && target.number === number) return target.base;
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
  const { prNumber: _bound, ...override } = slot;
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
    if (review.relationship === "owned" && review.number === delivery.prNumber)
      note(review.headSha, review.at);
  note(delivery.checks?.headSha, delivery.ciAt);
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

function receiptOf(record: TaskRecord, delivery: TaskDelivery | null): ChangeReceipt | null {
  const authorization = delivery?.mergeAuthorization;
  const merged =
    Boolean(delivery?.mergedSha) ||
    Boolean(delivery?.landedMode) ||
    delivery?.ci === "merged" ||
    Boolean(authorization?.receipt) ||
    MERGED_CLOSES.has(record.closedReason ?? "");
  if (merged) {
    const head = authorization?.receipt?.head ?? delivery?.headSha;
    const sha = delivery?.mergedSha ?? authorization?.receipt?.sha;
    return {
      outcome: "merged",
      ...(record.closedReason ? { reason: record.closedReason } : {}),
      ...(head ? { head } : {}),
      ...(sha ? { sha } : {}),
      ...(authorization?.receipt ? { by: "captain" as const } : {}),
      at: authorization?.receipt?.at ?? record.closedAt ?? null,
    };
  }
  if (record.status !== "done" && record.status !== "dropped") return null;
  return {
    outcome: record.closedReason === "discarded" ? "discarded" : "closed",
    ...(record.closedReason ? { reason: record.closedReason } : {}),
    at: record.closedAt ?? null,
  };
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
  const delivery = record.delivery ? ownFacts(record.delivery) : null;
  const override = overrideOf(delivery);
  return {
    repoId: record.repoId ?? "",
    base: baseOf(delivery),
    head: { branch: record.branch },
    handle: handleOf(delivery, repo),
    raisedBy: { kind: "task", task: record.id },
    taskId: record.id,
    override: override.task,
    receipt: receiptOf(record, delivery),
    versions: delivery
      ? headsOf(delivery, recorded, override.pushed).map(({ head, at }) => ({
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
