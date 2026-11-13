import type { ChangeRecord } from "@shared/change";
import {
  MERGE_GUIDANCE_IMPACTS,
  type MergeGuidanceDeclaration,
  type MergeRepairDeclaration,
  type MergeRepairImpact,
  repairImpact,
} from "@shared/checkRepair";
import { hasChangeRequests } from "@shared/forge";
import { englishOf, type Said, said, saidPart } from "@shared/i18n/said";
import type { MergeReview } from "@shared/mergeReview";
import { opensPullRequest, ownsBatches, type RepoDelivery, type RepoView } from "@shared/repos";
import { type ForgeRepo, forgeLocationOf, QUEUE_STATUS, QUEUE_WAITING_WORDS } from "../forge";
import { currentChange } from "../storage/changeProjection";
import type {
  CompletionOffer,
  MergeAuthorization,
  MergeRepairAssessment,
  MergeRepairStep,
  MergeWait,
  TaskDelivery,
  TaskRecord,
} from "../storage/taskRecords";
import type { TaskService } from "../tasks/taskService";
import { publicationRepo } from "./publicationRepo";
import type { WakeBody } from "./wakes";

/**
 * The captain's kept merge approval (FI3-304, docs/delivery-rigor.md "A
 * kept merge approval"): the closed facts the host checks about it, kept
 * apart from the settle path that runs it (`./keptApproval.ts`,
 * `./keptMerge.ts`).
 *
 * - The candidate head is the approved head, or the newest repair the host
 *   accepted after it. No other head is ever merged on the approval.
 * - A repair is any new head after the approved one, declared on
 *   check_change: what it started from, what it pushed, the base it sits
 *   on, its impact on the approved work and its evidence. The host checks
 *   lineage, ancestry and the paths the change touches against the
 *   ORIGINAL approved change, so drift across several repairs is caught as
 *   surely as in one, and records the impact the crewmate declared: whether
 *   the repaired change still does what was approved is the crewmate's
 *   judgment (guard = builder; INF-493), never a parser's or a kind of
 *   repair the host names.
 * - A repair the crewmate cannot judge (`unknown`) is decided by one
 *   independent assessment the host commissions at that head (FI3-663,
 *   "uncertainty receives an independent bounded assessment"): its one
 *   typed line accepts the repair or ends the approval, so the merge
 *   neither waits on it forever nor runs on an unknown.
 */

/**
 * One of the task's pull requests, by its number (INF-2746): the current
 * change, the task's own change, or one a stored review names - with its
 * branch and that review. Undefined when the number names none of them.
 * A merge approval is kept to its own pull request through this, never to
 * whichever one is current.
 */
export function taskPull(
  record: TaskRecord,
  changes: readonly ChangeRecord[],
  number: number | undefined,
): { branch: string; review?: MergeReview } | undefined {
  // An approval with no number is of the task's own pushed branch, which
  // merges in this person's batch (docs/forge.md, "Batches of your own").
  if (number === undefined) return record.branch ? { branch: record.branch } : undefined;
  const target = record.delivery?.checkTarget;
  if (target?.number === number) return { branch: target.branch, review: target };
  // The task's own pull request: the current change's number while it is
  // current, else the one its own change record names.
  const own = target
    ? changes.find((change) => change.head.branch === record.branch)?.handle?.number
    : record.delivery?.prNumber;
  if (own === number) return { branch: record.branch };
  const review = record.delivery?.mergeReviews?.find((item) => item.number === number);
  return review ? { branch: review.branch, review } : undefined;
}

/**
 * The offer a captain's merge click on this card approves (FI3-304): the
 * completion offer the host published after reading its known head, on a
 * pull request task (direct-pr or queue-pr) whose project lives on GitHub
 * or GitLab, for the change it was shown for, whoever opened it (INF-2490) -
 * with where that project lives. With the task's `changes`, that change may
 * be any of the task's pull requests (INF-2746: a click approves the pull
 * request its card showed); without them, only the current change.
 * Undefined where the click approves no head and is one attempt: a first
 * mate card, a seeded card, a plain Git host or an ambiguous baseline.
 */
export function approvableOffer(
  record: TaskRecord,
  repo: (ForgeRepo & { queueWorkflows?: RepoView["queueWorkflows"] }) | undefined,
  delivery: RepoDelivery | undefined,
  card: { cardId: string; offerId?: string | undefined },
  changes?: readonly ChangeRecord[],
): { baseline: CompletionOffer; host: string; owner: string; name: string } | undefined {
  if (!card.offerId || !opensPullRequest(delivery)) return undefined;
  if (!repo || !record.repoId || !hasChangeRequests(repo.host?.kind) || !record.branch)
    return undefined;
  const location = forgeLocationOf(publicationRepo(record, repo));
  if (!location.owner || !location.name || !location.host) return undefined;
  const baseline = record.delivery?.completionOffers?.find(
    (offer) => offer.cardId === card.cardId && offer.offerId === card.offerId,
  );
  if (!baseline) return undefined;
  if (baseline.prNumber === undefined) {
    // A pushed branch with no pull request of its own is approved only
    // where it merges in this person's batch (docs/forge.md, "Batches of
    // your own"); a pull request the task names by number is never batched.
    if (
      !delivery ||
      ownsBatches(delivery, repo) !== true ||
      record.delivery?.checkTarget ||
      currentChange(record.delivery, record.branch).number !== undefined
    )
      return undefined;
  } else if (
    changes
      ? !taskPull(record, changes, baseline.prNumber)
      : baseline.prNumber !== currentChange(record.delivery, record.branch).number
  )
    return undefined;
  return {
    baseline,
    host: location.host,
    owner: location.owner,
    name: location.name,
  };
}

/**
 * The task's approvals with the one at `index` among the others put in
 * front (INF-2746): each approved pull request goes ahead on its own, and
 * the one in front is the one a run, a repair declaration or an assessment
 * acts on. The one that was in front goes back to the end of the others
 * (`toBack`, its turn passed) or just behind the new one. The captain's
 * guidance marks stay in front, so his words hold every merge on the task.
 * Undefined when nothing stands in front, its merge request is out, or no
 * other is at `index`.
 */
export function putInFront(
  top: MergeAuthorization,
  index: number,
  toBack = false,
): MergeAuthorization | undefined {
  const others = top.queued ?? [];
  const next = others[index];
  if (top.status !== "standing" || top.attempt || !next) return undefined;
  const rest = others.filter((_, at) => at !== index);
  const { queued: _others, guidance: _marks, queueRemovals: _removals, ...stepped } = top;
  return {
    ...next,
    guidance: top.guidance,
    queueRemovals: top.queueRemovals,
    queued: toBack ? [...rest, stepped] : [stepped, ...rest],
  };
}

/**
 * Put the approval a declaration or an assessment is about in front
 * (INF-2746), when it is one of the others on the task.
 */
export function standInFront(
  tasks: TaskService,
  taskId: string,
  about: (authorization: MergeAuthorization) => boolean,
): void {
  const top = tasks.get(taskId)?.delivery?.mergeAuthorization;
  if (!top || about(top)) return;
  const index = top.queued?.findIndex(about) ?? -1;
  const front = index < 0 ? undefined : putInFront(top, index);
  if (front) tasks.delivery.recordPermissionRecords(taskId, { mergeAuthorization: front });
}

/** The one head an approval can merge now. */
export function candidateHead(authorization: MergeAuthorization): string {
  return authorization.lineage.at(-1)?.toHead ?? authorization.approvedHead;
}

/**
 * Every standing approval on the task (INF-2746): the one in front and the
 * others waiting their turn, each carrying the guidance marks the front
 * keeps, since the captain's words hold every merge on the task.
 */
export function standingApprovals(delivery: TaskDelivery | null | undefined): MergeAuthorization[] {
  const top = delivery?.mergeAuthorization;
  if (!top) return [];
  const others = (top.queued ?? [])
    .filter((other) => other.status === "standing")
    .map((other) => ({ ...other, guidance: top.guidance }));
  return top.status === "standing" ? [top, ...others] : others;
}

/**
 * The standing approval that covers `head` of one of the task's pull
 * requests (INF-4018), in front or waiting its turn: the stored review a
 * merge card names, or the task's own change when `review` is undefined,
 * whose candidate head - the approved head or its newest accepted repair -
 * is that version. A merge card, a check-watch wake and the status line all
 * read this one fact.
 */
export function coveringApproval(
  record: TaskRecord | undefined,
  head: string | undefined,
  review?: string,
): MergeAuthorization | undefined {
  if (!record || !head) return undefined;
  const own =
    review === undefined ? currentChange(record.delivery, record.branch).number : undefined;
  return standingApprovals(record.delivery).find(
    (kept) =>
      kept.review?.id === review &&
      (own === undefined || own === kept.target.prNumber) &&
      candidateHead(kept) === head,
  );
}

/**
 * What failed at a version an approval covers (INF-4018): nothing, the
 * pull request's own checks, the project's queue batch check, which no
 * checks override passes (INF-3208), or the batch of this person's own that
 * carried the version (docs/forge.md, "Batches of your own").
 */
export type CoveredFailure = "none" | "checks" | "batch" | "own-batch";

/**
 * Whose batch failed `head`, where its batch check reads failed: this
 * person's own where the app itself wrote that status
 * (`QueueStatusFact.kind`), the project's queue otherwise.
 */
export function failedBatchOf(
  delivery: TaskDelivery | null | undefined,
  head: string | undefined,
): "batch" | "own-batch" {
  const status = delivery?.queueStatus;
  return status?.kind !== undefined && status.head === head ? "own-batch" : "batch";
}

/**
 * What a crewmate does instead of a merge card at a version an approval
 * covers (INF-4018): declare the captain's newer words; clear failed checks
 * by a declared repair, a rerun or the captain's recorded override; answer
 * a failed batch the queue's way (FAILED_BATCH_NOTE); repair a change its
 * own batch failed or left out, which no answer to a queue puts back in
 * line (FAILED_OWN_BATCH_NOTE); or nothing, since the app runs the merge
 * once nothing holds it.
 */
export function coveredNextStep(kept: MergeAuthorization, failure: CoveredFailure): string {
  if (outstandingGuidance(kept) !== undefined)
    return "Put up no merge card: declare the impact of the captain's newer words with check_change captainGuidance instead.";
  if (failure === "batch")
    return "Put up no merge card: the project's queue failed or sent back this version, and no checks override passes the queue, so there is no Merge anyway. Fix the cause in a new version and declare it with check_change conflictRepair, or answer a send-back of a version that already holds the fix with check_change's answered verdict; the approval then goes ahead without a new card.";
  if (failure === "own-batch")
    return "Put up no merge card: this version's batch failed with it alone or left it out, as the batch check's words say, and no checks override passes a batch, so there is no Merge anyway. Fix the cause in a new version and declare it with check_change conflictRepair; the approval then goes ahead without a new card and the new version joins the project's next batch.";
  if (failure === "checks")
    return "Put up no merge card: the approval waits for these checks. Push a fix and declare it with check_change conflictRepair, record a rerun with check_change rerun, or, when it is a Merge anyway case, report it naming each failed check and your diagnosis so the first mate records the captain's override; the approval then goes ahead without a new card.";
  return "Put up no merge card and end your turn: the app runs the merge on that approval, through the project's queue where it has one, once nothing holds it; a new merge card is only for a new version.";
}

/**
 * The line every message to the crewmate about an approved version carries
 * (INF-4018): its check_change reading, a check-watch wake and the merge
 * card tool's refusal say the same words, from here.
 */
export function keptApprovalLine(kept: MergeAuthorization): string {
  const mark = outstandingGuidance(kept);
  const repairAsk =
    kept.waiting?.on === "conflict"
      ? " Declare a repair that brings the change up to date with conflictRepair from that head."
      : kept.waiting?.on === "repair"
        ? " Declare the repair with conflictRepair from that head."
        : "";
  return `The captain's merge approval is kept and covers ${candidateHead(kept)}${kept.waiting ? ` (the merge waits: ${kept.waiting.on})` : ""}.${repairAsk}${mark === undefined ? "" : ` Their guidance through mark ${mark} holds the merge until you declare its impact with captainGuidance.`}`;
}

/** The approval that stands on a delivery record, if any. */
export function standingAuthorization(
  delivery: TaskDelivery | null | undefined,
): MergeAuthorization | undefined {
  const authorization = delivery?.mergeAuthorization;
  return authorization?.status === "standing" ? authorization : undefined;
}

/**
 * A standing approval as it ends - spent by its merge, or revoked,
 * invalidated or superseded - with no attempt, retry or wait left on it:
 * the one shape every end of an approval records.
 */
export function endedAuthorization(
  standing: MergeAuthorization,
  end: Pick<MergeAuthorization, "status" | "endedAt"> &
    Partial<Pick<MergeAuthorization, "reason" | "generation" | "holds" | "receipt">>,
): MergeAuthorization {
  return { ...standing, ...end, attempt: undefined, retryAt: undefined, waiting: undefined };
}

/**
 * The approval ended in a way that holds the task's merge for the captain
 * (FI3-304 section 2): he withdrew it, or the work changed under it. Project
 * autonomy does not reach past that hold - only a new click does.
 */
export function mergeHold(delivery: TaskDelivery | null | undefined): string | undefined {
  const authorization = delivery?.mergeAuthorization;
  if (!authorization?.holds) return undefined;
  if (authorization.status !== "revoked" && authorization.status !== "invalidated")
    return undefined;
  return authorization.reason ?? "the captain's merge approval ended";
}

/**
 * The newest mark of the captain's guidance its crewmate has not declared
 * yet (FI3-662), or undefined when none holds the merge.
 */
export function outstandingGuidance(authorization: MergeAuthorization): number | undefined {
  const guidance = authorization.guidance;
  return guidance && guidance.latest > guidance.declared ? guidance.latest : undefined;
}

/** Who sent a steer and how, in the typed terms the supervisor records. */
export type GuidanceSource = {
  actor: "firstmate" | "captain" | "supervisor";
  /** The Firstmate steered in a turn that carries the captain's own words. */
  captainWords?: boolean;
};

/**
 * Whether a steer is the captain's guidance (FI3-662), from typed facts
 * alone - never his words: his reply under a crewmate's card, his choice on
 * one, a line he types in the task's Crewmate tab,
 * and the Firstmate's steer in a turn that carries his words. His close of a
 * card is not a choice, and Continue is the host's own nudge, so neither
 * carries guidance.
 */
export function isCaptainGuidance(source: GuidanceSource, body: WakeBody): boolean {
  if (source.actor === "firstmate") return source.captainWords === true;
  if (source.actor !== "captain") return false;
  if (typeof body === "string") return true;
  return body.facts.kind !== "card-closed" && body.facts.kind !== "idle-nudge";
}

/**
 * The crewmate's declaration about the captain's guidance, checked as
 * closed facts and recorded on the task (FI3-662): the mark must be one the
 * host gave a message of his. `none` lifts the hold through that mark;
 * later marks still hold. `changed-work` ends the approval with a hold.
 */
export function declareMergeGuidance(
  tasks: TaskService,
  taskId: string,
  input: MergeGuidanceDeclaration,
  now: number,
): { text: string; read: boolean } {
  const task = tasks.get(taskId);
  if (!task) return { read: false, text: "Guidance declaration refused: task not found." };
  const authorization = task.delivery?.mergeAuthorization;
  if (authorization?.status !== "standing") {
    return {
      read: false,
      text: `Guidance declaration refused: no kept merge approval stands on this task${authorization?.reason ? ` (${authorization.reason})` : ""}.`,
    };
  }
  if (
    !Number.isInteger(input.mark) ||
    !MERGE_GUIDANCE_IMPACTS.includes(input.impact) ||
    !filled(input.evidence)
  ) {
    return {
      read: false,
      text: "Guidance declaration refused: give the mark the captain's message named, impact (none or changed-work) and evidence.",
    };
  }
  const guidance = authorization.guidance;
  if (!guidance || input.mark < 1 || input.mark > guidance.latest) {
    return {
      read: false,
      text: guidance
        ? `Guidance declaration refused: mark ${input.mark} is not one the captain's messages named; the newest is ${guidance.latest}.`
        : "Guidance declaration refused: no guidance from the captain holds this kept merge.",
    };
  }
  const declared = {
    mark: input.mark,
    impact: input.impact,
    evidence: input.evidence.trim(),
  };
  if (input.impact === "changed-work") {
    const reason =
      "its crewmate declared that the captain's newer guidance changes the approved work";
    tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...authorization,
        status: "invalidated",
        reason,
        holds: true,
        endedAt: now,
        generation: authorization.generation + 1,
        guidance: { ...guidance, declared: Math.max(guidance.declared, input.mark) },
        waiting: undefined,
        retryAt: undefined,
        attempt: undefined,
      },
    });
    tasks.note(taskId, `The captain's kept merge approval ended: ${reason}.`, {
      news: true,
      feed: true,
      data: { mergeGuidance: declared },
    });
    return {
      read: true,
      text: "Recorded: the captain's kept merge approval no longer covers this change. Do the work their guidance asks, drive the checks green and put up a new merge card; the captain decides again.",
    };
  }
  if (input.mark > guidance.declared) {
    tasks.delivery.recordPermissionRecords(taskId, {
      mergeAuthorization: {
        ...authorization,
        guidance: { ...guidance, declared: input.mark },
        // The wait it stood on was this guidance: the next run reads every gate again.
        ...(authorization.waiting?.on === "guidance"
          ? { waiting: undefined, retries: undefined }
          : {}),
      },
    });
    tasks.note(
      taskId,
      `Its crewmate declared that the captain's guidance through mark ${input.mark} leaves the approved work as it was.`,
      { news: true, data: { mergeGuidance: declared } },
    );
  }
  const still = guidance.latest > Math.max(guidance.declared, input.mark);
  return {
    read: true,
    text: still
      ? `Recorded through mark ${input.mark}. The captain's newer guidance, mark ${guidance.latest}, still holds the merge: read it and declare it too.`
      : `Recorded: the captain's guidance through mark ${input.mark} leaves the approved work as it was, so it no longer holds the merge. End your turn once the checks pass; the host merges by itself, with no new merge card.`,
  };
}

/** What `declareMergeRepair` needs read from git: closed facts only. */
export type LineageFacts =
  | { known: false; why: string }
  | {
      known: true;
      /** The repaired head is a commit in the project's repository here. */
      toHeadHere: boolean;
      /** The declared base is in the repaired head. */
      baseInTo: boolean;
      /** The paths the approved change touches, against its own base. */
      approvedPaths: string[];
      /** The paths the repaired change touches, against the newer base. */
      repairedPaths: string[];
      /** The approved head's change reading, when this computer could read it. */
      approvedReading?: string | null;
      /** The repaired head's change reading, when this computer could read it. */
      repairedReading?: string | null;
    };

/** The git questions a declaration asks; `CheckChangeTool` answers them. */
export type LineageQuestion = {
  approvedHead: string;
  fromHead: string;
  toHead: string;
  newBase: string;
};

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * The paths that differ between the approved change and the repaired one
 * that the declaration does not name: a path either change touches and the
 * other does not. Empty when the declaration accounts for every one.
 */
export function unaccountedPaths(
  facts: { approvedPaths: string[]; repairedPaths: string[] },
  declared: string[],
): string[] {
  const approved = new Set(facts.approvedPaths);
  const repaired = new Set(facts.repairedPaths);
  const named = new Set(declared.map((path) => path.trim()));
  const differ = [
    ...facts.repairedPaths.filter((path) => !approved.has(path)),
    ...facts.approvedPaths.filter((path) => !repaired.has(path)),
  ];
  return [...new Set(differ)].filter((path) => !named.has(path)).sort();
}

/**
 * A repair declaration, checked as closed facts and recorded on the task
 * (FI3-304 section 3). `read` says whether check_change goes on to read
 * the checks at the new head, as a repair declaration's reading does.
 */
export function declareMergeRepair(
  tasks: TaskService,
  taskId: string,
  input: MergeRepairDeclaration,
  facts: LineageFacts,
  now: number,
): { text: string; read: boolean } {
  const task = tasks.get(taskId);
  if (!task) return { read: false, text: "Repair declaration refused: task not found." };
  const authorization = task.delivery?.mergeAuthorization;
  if (authorization?.status !== "standing") {
    return {
      read: false,
      text: `Repair declaration refused: no kept merge approval stands on this task${authorization?.reason ? ` (${authorization.reason})` : ""}. Drive the checks green and put up the merge card when the work is ready.`,
    };
  }
  const impact = repairImpact(input.impact);
  if (
    !filled(input.fromHead) ||
    !filled(input.toHead) ||
    !filled(input.newBase) ||
    !filled(input.evidence) ||
    !filled(input.validation) ||
    !impact ||
    !Array.isArray(input.changedPaths) ||
    !input.changedPaths.every((path) => typeof path === "string")
  ) {
    return {
      read: false,
      text: "Repair declaration refused: give fromHead, toHead, newBase, impact (none, changed-work or unknown), changedPaths (may be empty), evidence and the validation you ran at toHead.",
    };
  }
  if (input.toHead === input.fromHead) {
    return {
      read: false,
      text: "Repair declaration refused: toHead must be the new head you pushed, not the one you started from.",
    };
  }
  const repairedReading = facts.known ? (facts.repairedReading ?? undefined) : undefined;
  const approvedReading = facts.known ? (facts.approvedReading ?? undefined) : undefined;
  const step: MergeRepairStep = {
    fromHead: input.fromHead.trim(),
    toHead: input.toHead.trim(),
    newBase: input.newBase.trim(),
    impact,
    changedPaths: input.changedPaths.map((path) => path.trim()).filter(Boolean),
    evidence: input.evidence.trim(),
    validation: input.validation.trim(),
    generation: authorization.generation,
    at: now,
    ...(repairedReading ? { changeReading: repairedReading } : {}),
  };
  const patch = (next: Partial<MergeAuthorization>, note: string, feed = false) => {
    const latest = tasks.get(taskId)?.delivery;
    const versionReadings = { ...latest?.versionReadings };
    if (approvedReading) versionReadings[authorization.approvedHead] = approvedReading;
    if (repairedReading) versionReadings[step.toHead] = repairedReading;
    tasks.delivery.recordApprovedChangeReading(taskId, {
      mergeAuthorization: {
        ...authorization,
        ...(approvedReading && !authorization.changeReading
          ? { changeReading: approvedReading }
          : {}),
        ...next,
      },
      ...(approvedReading || repairedReading ? { versionReadings } : {}),
    });
    tasks.note(taskId, note, { news: true, feed, data: { mergeRepair: step } });
  };
  // The work changed: the approval no longer covers it, whatever the lineage.
  if (step.impact === "changed-work") {
    const reason = "its crewmate declared that its repair changed the approved work";
    patch(
      {
        status: "invalidated",
        reason,
        holds: true,
        endedAt: now,
        generation: authorization.generation + 1,
        undecided: undefined,
        waiting: undefined,
        retryAt: undefined,
        attempt: undefined,
      },
      `The captain's kept merge approval ended: ${reason}.`,
      true,
    );
    return {
      read: true,
      text: "Recorded: the captain's kept merge approval no longer covers this change. Drive the checks green and put up a new merge card; the captain decides again.",
    };
  }
  const tip = candidateHead(authorization);
  const undecided = authorization.undecided;
  // An unknown is the crewmate's last word on that repair: an independent
  // assessment decides it, never the crewmate's own later none.
  if (undecided && step.impact === "none") {
    return {
      read: false,
      text: `Repair declaration refused: you declared the repair to ${undecided.toHead} unknown, so an independent assessment decides it. End your turn; declare changed-work only if the work changed.`,
    };
  }
  if (
    undecided &&
    step.impact === "unknown" &&
    undecided.fromHead === step.fromHead &&
    undecided.toHead === step.toHead
  ) {
    return { read: true, text: unknownRecorded(step.toHead) };
  }
  if (step.fromHead !== tip) {
    return {
      read: false,
      text: `Repair declaration refused: a repair starts from ${tip}, the newest head the captain's approval covers. Declare the repair from that head, or changed-work if the work changed.`,
    };
  }
  if (!facts.known) {
    return {
      read: false,
      text: `Repair declaration refused: the host could not read the repair's facts (${facts.why}). Make sure ${step.toHead} is committed in your working copy and try again.`,
    };
  }
  if (!facts.toHeadHere) {
    return {
      read: false,
      text: `Repair declaration refused: ${step.toHead} is not a commit in this project's repository. Commit and push the repair, then declare it.`,
    };
  }
  if (!facts.baseInTo) {
    return {
      read: false,
      text: `Repair declaration refused: ${step.newBase} is not in ${step.toHead}. newBase is the default branch commit the repaired change sits on: name that one, or bring the change up to date with ${step.newBase} first.`,
    };
  }
  // The lineage holds, and the crewmate cannot tell what the repair did:
  // the host keeps the paths of both changes for the assessment to judge.
  if (step.impact === "unknown") {
    patch(
      {
        undecided: {
          ...step,
          paths: { approved: facts.approvedPaths, repaired: facts.repairedPaths },
        },
        waiting: { on: "evidence", head: step.toHead, at: now },
      },
      `The kept merge waits: the repair to ${step.toHead} was declared with an unknown impact, so an independent assessment decides it.`,
    );
    return { read: true, text: unknownRecorded(step.toHead) };
  }
  const unaccounted = unaccountedPaths(facts, step.changedPaths);
  if (unaccounted.length > 0) {
    return {
      read: false,
      text: `Repair declaration refused: these paths differ from the approved change and the declaration does not name them: ${unaccounted.join(", ")}. Name each in changedPaths if the repair needed it, give as newBase the base the repaired change sits on, or declare changed-work.`,
    };
  }
  patch(
    {
      lineage: [...authorization.lineage, step],
      undecided: undefined,
      waiting: undefined,
      retryAt: undefined,
      retries: undefined,
    },
    `The captain's kept merge approval now covers ${step.toHead}: its crewmate declared that the repair leaves the approved work as it was, and the host checked its lineage.`,
  );
  return {
    read: true,
    text: `Repair accepted: the captain's kept merge approval now covers ${step.toHead}. Drive its checks green and end your turn; the host merges by itself, with no new merge card.`,
  };
}

/** What the crewmate hears once its unknown repair is recorded (FI3-663). */
function unknownRecorded(toHead: string): string {
  return `Recorded as unknown, so the kept merge waits. Once your turn ends, the host asks an independent assessment of the repair at ${toHead}, and its verdict decides: none keeps the captain's approval and the host merges with no new card; anything else ends it, and you then put up a new merge card. End your turn now, and do not declare this repair again.`;
}

/**
 * How an independent repair assessment's report opens: its one typed line.
 * `conflict-only` is `none`'s older name, which an assessment asked before
 * INF-493 answers with.
 */
const ASSESSMENT_LINE = /^impact:\s*(none|conflict-only|changed-work|unknown)\b/i;

/**
 * The verdict an independent repair assessment's report states (FI3-663):
 * its first line, `impact: none|changed-work|unknown`. A report without it
 * states nothing, which the host reads as no verdict - and no verdict never
 * merges.
 */
export function parseRepairAssessment(report: string): MergeRepairImpact | "unstated" {
  const first =
    report
      .split(/\r?\n/)
      .map((line) => line.replace(/[*_`]/g, "").trim())
      .find((line) => line.length > 0) ?? "";
  const match = ASSESSMENT_LINE.exec(first);
  return (match && repairImpact(match[1]?.toLowerCase())) || "unstated";
}

/** How long an independent repair assessment may take before the approval stops waiting on it. */
export const ASSESSMENT_BOUND_MS = 60 * 60_000;

/** Why an independent assessment's verdict ends the approval, in the host's words. */
export function assessmentEndReason(
  verdict: Exclude<NonNullable<MergeRepairAssessment["verdict"]>, "none">,
): string {
  switch (verdict) {
    case "changed-work":
      return "an independent assessment found that its repair changed the approved work";
    case "unknown":
    case "unstated":
      return "an independent assessment could not show that its repair left the approved work as it was";
    case "failed":
      return "the independent assessment of its repair did not finish";
  }
}

/**
 * An independent assessment's verdict on the undecided repair, recorded on
 * the builder's approval (FI3-663). `none` accepts the repair into
 * the lineage - the host had checked its lineage when it was declared, and
 * the assessment judged every path either change touches - so the merge goes on
 * under every other gate; any other verdict ends the approval with a hold,
 * so project autonomy cannot merge past it either. A verdict about a repair
 * the approval no longer waits on - a newer repair, a newer approval, an
 * ended one - is stale and records nothing.
 */
export function decideMergeRepair(
  tasks: TaskService,
  builderId: string,
  assessorId: string,
  verdict: NonNullable<MergeRepairAssessment["verdict"]>,
  now: number,
):
  | { decided: "accepted"; head: string }
  | { decided: "ended"; head: string; reason: string }
  | { decided: "stale" } {
  standInFront(tasks, builderId, (item) => item.undecided?.assessment?.taskId === assessorId);
  const authorization = standingAuthorization(tasks.get(builderId)?.delivery);
  const undecided = authorization?.undecided;
  if (!authorization || !undecided || undecided.assessment?.taskId !== assessorId) {
    return { decided: "stale" };
  }
  const assessment = { ...undecided.assessment, verdict, decidedAt: now };
  if (verdict === "none") {
    const step: MergeRepairStep = {
      ...undecided,
      impact: "none",
      changedPaths: [
        ...new Set([
          ...undecided.changedPaths,
          ...(undecided.paths
            ? unaccountedPaths(
                {
                  approvedPaths: undecided.paths.approved,
                  repairedPaths: undecided.paths.repaired,
                },
                [],
              )
            : []),
        ]),
      ],
      assessment,
    };
    tasks.delivery.recordPermissionRecords(builderId, {
      mergeAuthorization: {
        ...authorization,
        lineage: [...authorization.lineage, step],
        undecided: undefined,
        waiting: undefined,
        retryAt: undefined,
        retries: undefined,
      },
    });
    tasks.note(
      builderId,
      `The captain's kept merge approval now covers ${step.toHead}: an independent assessment found that the repair left the approved work as it was.`,
      { news: true, data: { mergeRepair: step } },
    );
    return { decided: "accepted", head: step.toHead };
  }
  const reason = assessmentEndReason(verdict);
  const assessed = { ...undecided, assessment };
  tasks.delivery.recordPermissionRecords(builderId, {
    mergeAuthorization: {
      ...authorization,
      status: "invalidated",
      reason,
      holds: true,
      endedAt: now,
      generation: authorization.generation + 1,
      undecided: assessed,
      waiting: undefined,
      retryAt: undefined,
      attempt: undefined,
    },
  });
  tasks.note(builderId, `The captain's kept merge approval ended: ${reason}.`, {
    news: true,
    feed: true,
    data: { mergeRepair: assessed },
  });
  return { decided: "ended", head: undecided.toHead, reason };
}

export const MERGE_CHECKS_HOLD_REASON = "the checks have not all passed";

/**
 * The feed line for a click whose merge did not happen yet but whose
 * approval stands, in the vocabulary's words (never a raw failure). `place`
 * is where the project lives in the person's words ("GitHub", "GitLab", a
 * host's own address). The current check facts distinguish waiting for a fix
 * from waiting for results (captain F20/F27), never a separate crew verdict.
 * It is a line on the task's record, so the task's key names it (INF-1845).
 */
export function keptFeedLine(
  wait: MergeWait,
  place: string,
  checks?: string,
  /** `own`: the change merges in this person's batch, with no queue where the project lives. */
  queueOwned: boolean | "own" = false,
): string {
  return englishOf(keptFeedSaid(wait, place, checks, queueOwned));
}

/**
 * The kept merge's feed line as a fact (`keptFeedLine`), worded where it is
 * shown; `place` empty names the project's host in the app's words.
 */
export function keptFeedSaid(
  wait: MergeWait,
  place: string,
  checks?: string,
  queueOwned: boolean | "own" = false,
): Said {
  const where = { place: place || saidPart("projectsHost") };
  switch (wait) {
    case "conflict":
      return said("keptConflict");
    case "repair":
      return said("keptRepair");
    case "evidence":
      return said("keptEvidence");
    case "checks":
      return checks === "red" ? said("keptChecksFailed") : said("keptChecks");
    case "cap":
      return said("keptCap");
    case "protected":
      return said("keptProtected", where);
    case "computing":
    case "transient":
    case "outcome":
      return said("keptUnclear", where);
    case "draft":
      return said("keptDraft");
    case "sign-in":
      return said("keptSignIn", where);
    case "refused":
      return said("keptRefused", where);
    case "guidance":
      return said("keptGuidance");
    case "queue":
      if (queueOwned === "own") return said("keptQueueOwn");
      return queueOwned ? said("keptQueueOwned") : said("keptQueue");
  }
}

/**
 * What the Firstmate is told beside a checks wait of a change that was the
 * only one in its batch when the batch's checks failed (docs/forge.md,
 * "Batches of your own"): its own crewmate repairs it.
 */
export const FAILED_OWN_BATCH_NOTE =
  "The change was the only one in its batch, and the batch's checks failed. Merge anyway could do nothing there, so never offer or ask for it: the crewmate reads the failed checks on the batch's pull request and fixes the cause in a new version, which joins the batch again once approved.";

/**
 * What the Firstmate is told beside a checks wait whose failure is the
 * project's batch check (INF-3208): no checks override passes the queue, so
 * Merge anyway could do nothing, and what clears it instead.
 */
export const FAILED_BATCH_NOTE = `The project's queue failed or sent back this version (${QUEUE_STATUS} failed). No checks override passes the queue, so never offer or ask for Merge anyway on it: the crewmate fixes the cause in a new version, or answers a send-back of a version that already holds the fix with check_change's answered verdict, and the host marks it waiting for the queue again.`;

/**
 * What the Firstmate is told beside a wait on a kept approval: who moves
 * next, and that the captain is not asked for a second click. A queue wait
 * carries what the app's reads say of the project's queue (`queueWarning`,
 * INF-2913: no note shows it to the captain), and a checks wait on a failed
 * batch check what clears it (INF-3208).
 */
export function keptNote(
  wait: MergeWait,
  head: string,
  place: string,
  checks?: string,
  queueWarning?: string,
  queueOwned: boolean | "own" = false,
): string {
  const kept =
    "The captain's merge approval is KEPT: the host merges by itself once the gates pass, so do not ask the captain to merge again or to put up a new card.";
  const declare = `When the crewmate pushes a new version - brought up to date, or a fix for what stopped the merge - it declares the repair with check_change conflictRepair from ${head}: impact none keeps the approval; changed-work ends it and it puts up a new merge card.`;
  switch (wait) {
    case "conflict":
      return `${kept} Steer the crewmate to bring the branch up to date with the default branch, rerun its validation, push, declare the repair, read the current check facts. ${declare}`;
    case "repair":
      return `${kept} The pull request is past the version the approval covers (${head}). Steer the crewmate to declare what changed. ${declare}`;
    case "evidence":
      return `${kept} The crewmate declared its repair from ${head} unknown, so the host has an independent crewmate assess it once its turn ends: none keeps the approval and the host merges; any other answer ends it, and the host tells the crewmate to put up a new merge card. Nothing is needed from you.`;
    case "checks":
      return checks === "red"
        ? `${kept} For ${head}, the checks failed and the merge waits for a fix. The crewmate reads failed logs and fixes the cause; a changed version is declared as a repair.${queueWarning ? ` ${queueWarning}` : ""} ${declare}`
        : `${kept} For ${head}, ${MERGE_CHECKS_HOLD_REASON}. The crewmate reads missing results; the merge runs when its checks pass. ${declare}`;
    case "cap":
      return `${kept} A round cap holds the task: the captain's answer to the cap comes first, then the host merges.`;
    case "protected":
      return `${kept} ${place}'s rules on the main branch hold the merge (a required review or another protection); the host never bypasses them and tries again on its own. Nothing is needed from the crewmate.`;
    case "computing":
    case "transient":
    case "outcome":
      return `${kept} ${place} gave no clear answer; the host reads it again on its own. Nothing is needed from you.`;
    case "draft":
      return `${kept} The pull request is a draft. For an approved prerequisite publication, the host marks it ready after current proof and independent review pass; otherwise the captain controls its draft status. Never ask the crewmate to change draft status through github_write.`;
    case "sign-in":
      return `${kept} The captain's ${place} sign-in is needed; the merge runs once they sign in again.`;
    case "refused":
      return `${kept} Steer the crewmate to fix the cause without changing the approved work; the host tries again when its turn ends. ${declare}`;
    case "guidance":
      return `${kept} The captain gave the crewmate new guidance after their click, and the merge holds until it declares that guidance's impact with check_change captainGuidance: none keeps the approval; changed-work ends it and it puts up a new merge card. The message itself told the crewmate, so nothing is needed from you unless it ends its turn without declaring.`;
    case "queue":
      if (queueOwned === "own")
        return `${kept} The project merges the captain's approved changes together: ${head} is in line for one batch pull request, as one commit of its own, and the host merges that pull request once its checks pass. A change the batch leaves out, or the only change of a batch whose checks fail, wakes its crewmate; a failed batch of several is told to you once. Nothing is needed from you now. ${declare}`;
      return `${kept} The project merges through its queue: the host marked ${head} with the ${QUEUE_STATUS} status, waiting. ${queueOwned ? "The project's queue merges after its pass; the app observes its receipt." : "The app merges after the project's queue passes this version."}${queueWarning ? ` ${queueWarning}` : ""} A batch that fails in the queue Infinitary ships keeps the version waiting and pauses, and you hear the pause once; a change the queue fails or sends back wakes the crewmate like any failed check. ${declare}`;
  }
}

/** Waits the tick reads again on its own, and how soon. */
const TIMED_WAITS: Partial<Record<MergeWait, number>> = {
  // An independent assessment that stopped without answering, or ran past
  // its bound, wakes nothing either (FI3-663).
  evidence: 10 * 60_000,
  refused: 10 * 60_000,
  protected: 5 * 60_000,
  computing: 60_000,
  transient: 60_000,
  outcome: 60_000,
  "sign-in": 10 * 60_000,
  draft: 10 * 60_000,
  // The check watch wakes on the queue's answer; this reads it again past the watch's bound.
  queue: 10 * 60_000,
};

/** The longest a timed wait backs off to. */
const MAX_RETRY_MS = 30 * 60_000;

/** When a timed wait is read again, backing off with each try; undefined for an untimed wait. */
export function retryAfter(wait: MergeWait, retries: number, now: number): number | undefined {
  const base = TIMED_WAITS[wait];
  if (base === undefined) return undefined;
  return now + Math.min(base * 2 ** Math.min(retries, 5), MAX_RETRY_MS);
}

/**
 * Waits that need someone to move whom nothing else wakes, so the Firstmate
 * hears of each once per head: not the checks (the check watch wakes the
 * crewmate), not an unknown impact (the host's independent assessment
 * decides it), not a hiccup or a cap (the tick and the cap's own wake
 * handle those).
 */
export function wakesFirstmate(wait: MergeWait): boolean {
  return (
    wait === "conflict" ||
    wait === "repair" ||
    wait === "refused" ||
    wait === "sign-in" ||
    wait === "protected" ||
    wait === "draft"
  );
}
