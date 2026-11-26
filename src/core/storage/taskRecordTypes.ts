import type { AllowanceOffer, CaptainAllowance } from "@shared/captainAllowances";
import type {
  CheckRepairLedger,
  MergeRepairDeclaration,
  MergeRepairImpact,
} from "@shared/checkRepair";
import type { CheckSnapshot, MainCheckEvidence } from "@shared/checkSnapshot";
import type { HoldOverride } from "@shared/holds";
import type { LiveValidation } from "@shared/liveValidation";
import type { MergeReview } from "@shared/mergeReview";
import type { CommittedPlacement } from "@shared/placement";
import type { CaptainAction, RequiredActionOffer } from "@shared/requiredActions";
import type { ReviewRisk, ReviewVerdict } from "@shared/rigor";
import type { RiskAssessment } from "@shared/risk";
import type { WorkShape } from "@shared/routingPolicy";
import type { LevelWaitCause } from "@shared/taskHold";
import type { EffectiveTaskPolicies } from "@shared/taskPolicies";
import type { FirstRelease } from "@shared/taskRelease";
import type { ReviewFrom, RunChecks, TaskDeliveryMode } from "@shared/tasks";
import type { IntegrationAllowance, WriteAsk } from "@shared/writeAsk";
import type { SpawnIntent } from "../orchestrator/intentBrief";

export type TaskStatus = "open" | "active" | "done" | "dropped";

/**
 * A parent's parts: how many, how many closed, and the closed ones' ids in
 * the order they closed, oldest first, for the Tasks panel's parts bar.
 */
export type PartCounts = { total: number; closed: number; closedIds?: string[] };
export type TaskActivity = "starting" | "running" | "idle" | "interrupted";
export type TaskClosedReason =
  | "landed"
  | "merged"
  | "released"
  | "answered"
  | "settled"
  | "finished"
  | "cancelled"
  | "discarded"
  | "failed"
  | "superseded";
export type TaskKind = "work" | "question" | "decision" | "operation";
export type TaskStartPolicy = "when-ready" | "on-request";
export type TaskWorkspaceState = "none" | "present" | "removed";

export type TaskGate = {
  /**
   * What the row waits on: quota coming back for a scope, a moment in
   * time, or the user (a parked decision, or an explicit reasoning ask that
   * cannot be served yet). "After another task" is a `blocks` link now.
   */
  kind: "quota-reset" | "at-time" | "captain";
  /** The gate's subject: a quota scope (`bucket:high`), a card id. */
  ref?: string;
  /** Epoch ms when a time-gated row surfaces on its own. */
  until?: number;
  reason?: string;
  /**
   * Why a level's gate holds an ask or a retry that no allowance reset can
   * start (`LevelWaitCause`), set by the hold that routed it. Absent on a
   * wait for allowance.
   */
  cause?: LevelWaitCause;
  /**
   * An `at-time` hold that ends sooner once the app is updated on a
   * computer (INF-5578 finding 4): the computer (`device`, null for this
   * Mac), the version it ran when held (`from`, when known), and the
   * version the hold waits for (`version`, when the first mate named one).
   * It ends at that version or later, or at any newer one than `from`.
   */
  update?: AppUpdateWait;
};

export type AppUpdateWait = { device: string | null; from?: string; version?: string };

export type PendingSettleIntent = {
  mode: "merge-pr" | "land";
  actor: "captain" | "firstmate" | "app";
  /** The merge card declared the task continues after this merge (INF-2744). */
  continues?: true;
  requestedAt: number;
  proceedWithOpen: boolean;
  /** One branch/local attempt waiting for a turn, not a kept hosted merge approval. */
  story?: { revision: number; head: string; contentHash?: string };
};

/**
 * The unversioned kept click of contract 4.66 (`TaskDelivery.mergeOrder`):
 * it names no approved head, so it is never carried forward - the boot
 * retires it and says so (FI3-304: no upgrade without a provable baseline).
 */
export type MergeOrder = { at: number; proceedWithOpen: boolean };

/**
 * A merge card the host published after its checks passed, and the
 * head those checks read: the baseline a click on that exact offer
 * approves. A card without one (seeded, or a Firstmate card) approves no head.
 * An offer that approves no head is still kept for the change it was shown
 * for (INF-2490), so its click refuses once another change is current.
 */
export type CompletionOffer = {
  cardId: string;
  offerId: string;
  headSha: string;
  /** Absent for a plain branch or local-only work; consent still binds the story and head. */
  prNumber?: number;
  /**
   * The task's current change, by number, when the card went up (INF-2490):
   * a click on it refuses once another change is current. A first mate
   * card's offer, and any offer that approves no head, names it here alone.
   */
  shownFor?: number;
  /** Project address as shown; absence cannot authorize a numbered request. */
  destination?: { repoId: string; origin: string; branch: string };
  /** A move retired this offer; a return to that address cannot revive it. */
  retired?: true;
  /** The merge card declared the task continues after this merge (INF-2744). */
  continues?: true;
  /** The saved story this offer showed, when it uses one. */
  presentationRevision?: number;
  presentationContentHash?: string;
  at: number;
};

/**
 * The merge card offer the captain's own click merged from, for a task's own
 * change (`TaskDelivery.mergeClick`, INF-4574): a merge with no kept approval
 * - a local branch, or a host with no checks - reads which card's steps the
 * captain saw from it. Each click replaces it; it grants nothing by itself.
 */
export type MergeClick = { cardId: string; offerId: string; at: number };

/**
 * The captain's own click on a merge card of the task's own change
 * (`SeenMerge.act`): `approved` for its merge, `chose` for any other button
 * by its label. Absent when the window only had the card in front of them.
 */
export type SeenMergeAct = { kind: "approved" } | { kind: "chose"; button: string };

/** The merge card the captain last saw for a task's own change (`TaskDelivery.seenMerge`). */
export type SeenMerge = {
  cardId: string;
  offerId: string;
  /** When the window first had that version in front of the captain, or when they clicked on it. */
  at: number;
  /** Their click on that version, the last thing they did there. */
  act?: SeenMergeAct;
  headSha: string;
  presentationRevision?: number;
  /** The task's current change, by number, when that card went up (`CompletionOffer.shownFor`). */
  change?: number;
  /** Absent when the lines were not read at that version: never zero. */
  lines?: { added: number; deleted: number };
};

/**
 * The independent assessment of a repair its crewmate declared unknown
 * (FI3-663): the task the host commissioned to read it and, once it
 * answered, its verdict. One per undecided repair.
 */
export type MergeRepairAssessment = {
  taskId: string;
  at: number;
  /**
   * `unstated`: it reported without the impact line; `failed`: it could not
   * start or ended with no report. Rows before INF-493 say `conflict-only` for `none`.
   */
  verdict?: MergeRepairImpact | "unstated" | "failed";
  decidedAt?: number;
};

/** One accepted repair of an approved change: the host checked its lineage and paths. */
export type MergeRepairStep = MergeRepairDeclaration & {
  /** The authorization generation it was accepted under. */
  generation: number;
  at: number;
  /**
   * An unknown repair's paths, read by the host when it was declared: those
   * the approved change touches against its own base and those the repaired
   * one touches against the newer base - what its independent assessment
   * judges.
   */
  paths?: { approved: string[]; repaired: string[] };
  /**
   * The repaired head's change reading, stored when the repair is recorded
   * (INF-416 G). Absent when that commit could not be read.
   */
  changeReading?: string;
  /** The independent assessment that decides an unknown repair. */
  assessment?: MergeRepairAssessment;
};

/** What a standing merge authorization is waiting on, in the host's typed terms. */
export type MergeWait =
  /** GitHub found the change in conflict with newer work, or behind it. */
  | "conflict"
  /** The pull request is at a head no accepted repair names yet. */
  | "repair"
  /** The newest repair was declared with an unknown impact: its independent assessment decides it. */
  | "evidence"
  /** The checks on the candidate head have not all passed. */
  | "checks"
  /** A round cap on the task holds it until the captain answers. */
  | "cap"
  /** GitHub holds the merge: a required review or another rule on the branch. */
  | "protected"
  /** GitHub has not worked out whether the change can merge yet. */
  | "computing"
  /** A draft pull request cannot merge. */
  | "draft"
  /** The sign-in where the project lives is missing or refused. */
  | "sign-in"
  /** A network or host hiccup. */
  | "transient"
  /** The merge request's outcome is unknown and is being read back. */
  | "outcome"
  /** Another refusal the crewmate can fix: a title, a missing version, access. */
  | "refused"
  /** The captain's newer guidance waits for its crewmate to declare its impact. */
  | "guidance"
  /** A batched project's batch has not passed this version yet: its batch check is waiting. The saved name stays. */
  | "queue"
  /** The host's own merge queue took this version and has not merged it yet. */
  | "host-queue"
  /** The host removed this version from its own merge queue without merging it. */
  | "host-removed"
  /** The review's questions about the task wait on the captain's answers. */
  | "questions";

/**
 * The captain's merge approval (FI3-304), version 1: minted by his click on
 * a completion offer the host published at a known head, in the same
 * transaction as the card's resolution. It covers that pull request, that
 * head and the repairs the host accepted after it, and it
 * stands through conflicts, waits and restarts until it is consumed by the
 * merge, revoked (an interruption, his withdrawal), invalidated (the work
 * changed, the pull request or project is no longer the one approved) or
 * superseded (a new merge card or a new click). `generation` advances
 * on every one of those, so a run that started earlier can tell before it
 * sends anything.
 */
export type MergeAuthorization = {
  version: 1;
  id: string;
  generation: number;
  /**
   * Who approved it: the captain's click, or the app from the merge card
   * on a task whose autonomy is on (INF-2744). An app approval passes the
   * merge gate again on every run, so turning autonomy off ends it.
   */
  issuer: "captain" | "autonomy";
  /**
   * Kept in the captain's name from the captain's words recorded as passing
   * asking first, never from a click (`SettleService.mergeOnCaptainWords`):
   * like the first mate's merge it stands for, it still waits on the
   * decisions hold at every last look. An older app reads it as a click.
   */
  fromWords?: true;
  at: number;
  /** The offer the captain clicked: the card, its occurrence and version, the action and the gesture. */
  card: {
    id: string;
    lifecycleId?: string;
    offerId: string;
    actionId: string;
    interactionId?: string;
  };
  target: {
    repoId: string;
    host: string;
    owner: string;
    name: string;
    /**
     * Absent for a pushed branch with no pull request of its own: it merges
     * in this person's batch (docs/forge.md, "Batches of your own").
     */
    prNumber?: number;
    branch: string;
    delivery: "direct-pr";
    method: "squash";
  };
  /** The head the captain approved: the one the merge card's checks read. */
  approvedHead: string;
  /** The reviewed pull request a merge card named; its snapshot survives review-list eviction. */
  review?: MergeReview;
  /**
   * What the merge card declared follows the merge (INF-2744). Absent on an
   * approval from before it: a review's merge continued the task, the
   * current change's closed it.
   */
  after?: "close" | "continue";
  /**
   * The approved head's change reading, stored at the captain's approval
   * (INF-416 G). Absent when that commit could not be read.
   */
  changeReading?: string;
  /** Accepted repairs, each declared to leave the approved work as it was, oldest first. */
  lineage: MergeRepairStep[];
  /** The captain's leave to merge with open children (`proceed_with_open`). */
  proceedWithOpen: boolean;
  status: "standing" | "consumed" | "revoked" | "invalidated" | "superseded";
  /** Why it ended, in the host's words. */
  reason?: string;
  endedAt?: number;
  /**
   * The end holds the task's merge for the captain: he withdrew it, or the
   * work changed under it. Project autonomy does not merge past it; a new
   * click does.
   */
  holds?: boolean;
  /** What the newest run stopped on while it stands. */
  waiting?: { on: MergeWait; head?: string; at: number };
  /**
   * The version the host's own merge queue took under this approval: the
   * host merges or removes it, and no later run sends that version again
   * on its own, whatever it stopped on since. `removed` is when the app
   * first read it out of the queue, still open.
   */
  handed?: { head: string; at: number; removed?: number };
  /**
   * A declared repair whose impact is unknown: not eligible until its
   * independent assessment decides it (FI3-663).
   */
  undecided?: MergeRepairStep;
  /**
   * The captain's guidance since his click (FI3-662): each steer or reply
   * of his takes the next mark, and the merge holds while `latest` is past
   * `declared`, the newest mark its crewmate declared it read and judged.
   */
  guidance?: { latest: number; declared: number; at: number };
  /** When the tick tries a timed wait again, and how many times it has. */
  retryAt?: number;
  retries?: number;
  /**
   * Persisted right before the merge request is sent; its answer clears it.
   * `task` is the host's own reference to a merge it took and has not
   * confirmed, which a later read asks how it ended.
   */
  attempt?: { token: string; head: string; at: number; task?: string };
  /**
   * Merges sent under earlier approvals of the task's other pull requests,
   * or of this one, whose outcome was never read back, kept by pull request
   * through every approval that replaces them; a later approval of that pull
   * request takes its entry as its own attempt (`carryUnsettled`).
   */
  unsettled?: {
    target: MergeAuthorization["target"];
    attempt: NonNullable<MergeAuthorization["attempt"]>;
  }[];
  /** The merge GitHub confirmed. */
  receipt?: { head: string; sha?: string; at: number };
  /**
   * Approvals of the task's other pull requests, kept while this one
   * stands (INF-2746): a task may ask for many merges, and every merge
   * card's approval stands on its own until its pull request merges. When
   * this one ends the oldest stands next; an end that holds the task's
   * merge for the captain, or revokes it, ends them too. Each carries no
   * queue of its own.
   */
  queued?: MergeAuthorization[];
  /** Exact external eligibility removals not yet acknowledged; retained through replacement and close. */
  queueRemovals?: QueueApprovalRemoval[];
};

export type QueueApprovalRemoval = Pick<MergeAuthorization, "target" | "review"> & { head: string };

/** Delivery facts, as they become known (check_pr_ci, land, merge-pr, review). */
export type TaskDelivery = {
  /** A prepared task's publication target, independent of later project route choices. */
  publicationOrigin?: string;
  /** Credential-free push transport captured with the task's publication route. */
  publicationPushOrigin?: string;
  /** The selected contribution route stays with this task after project settings change. */
  contribution?: import("@shared/contributions").ContributionRoute;
  contributionState?: import("@shared/contributions").ContributionState;
  /**
   * Where the comment reading of the task's pull request stands
   * (docs/forge.md, "Comments on a pull request"): what it last read, so a
   * restart never wakes the crewmate about a comment twice.
   */
  commentCursor?: import("@shared/pullComments").CommentCursor;
  /** The comments and reviews this task's crewmate sent where the project lives: never woken about. */
  sentComments?: number[];
  /**
   * The host wakes the guidance served when the crewmate's conversation last
   * opened asks for (`Runbooks.crew`): the host sends only those, so a wake
   * never points at guidance the crewmate does not hold.
   */
  servedWakes?: string[];
  /**
   * The task's latest typed result as a release before INF-1296 piece 1
   * kept it: a copy of the newest report's. Nothing writes it now; the
   * report entries hold the result, and `TaskService.latestResult` still
   * reads a copy saved before, with the precedence it had.
   */
  result?: { at: number; value: Record<string, unknown> };
  /**
   * Versioned public story and native-upload receipts of the task's current
   * change; only TaskService writes them. Each other change keeps its own in
   * `presentations` (INF-2490).
   */
  presentation?: import("@shared/changePresentation").ChangePresentationRecord;
  /**
   * The story ledgers of the task's other changes, each naming its branch
   * (INF-2490). When another change becomes the current one, its ledger
   * moves into `presentation` and the one it replaces moves here.
   */
  presentations?: import("@shared/changePresentation").ChangePresentationRecord[];
  liveValidation?: LiveValidation;
  validationAssignment?: {
    head: string;
    revision: number;
    scenarioRevision: number;
    stateRevision?: number;
    effects: string[];
  };
  validationHead?: string;
  validationReadiness?: {
    head: string;
    number: number;
    state: "unknown" | "not-applied" | "ready";
    problem?: string;
  };
  reviewRoundPairs?: string[];
  requiredActionOffer?: RequiredActionOffer;
  captainAction?: CaptainAction;
  /** Policies frozen with the closed outcome, never a routing/dispatch stamp. */
  closedPolicies?: EffectiveTaskPolicies;
  mode: TaskDeliveryMode;
  prUrl?: string;
  prNumber?: number;
  /**
   * How the proposed change is named where the project lives, from the
   * forge seam (git integration PR 1.1): `#N` on GitHub, the sent-up branch
   * on a plain Git host. Surfaces read it instead of parsing a link.
   */
  changeLabel?: string;
  /**
   * The branch the pull request targets, as the host names it (INF-1873):
   * the default branch, or the branch `open_change` asked for. Written with
   * the number group and refreshed by each reading; the change record's base.
   */
  prBase?: string;
  /** The PR head the last CI read saw, or the assigned commit on an independent review task. */
  headSha?: string;
  /**
   * The lines the whole offered change adds and deletes (INF-820), read by
   * the host from git at `head` against the merge base `base`; the fact
   * strip shows them only while `head` is the offered version. Absent
   * until a reading succeeded: an unread change is never zero.
   */
  changeLines?: { base: string; head: string; added: number; deleted: number; at: number };
  /**
   * The merge card of the task's own change the captain last saw (INF-3715):
   * when, the version and story it offered, and the lines its strip showed.
   * A later merge card at another version or story hands these to its
   * crewmate, who writes what changed since (`sinceSeen.ts`).
   */
  seenMerge?: SeenMerge;
  /** The merge card offer the captain's own click merged from (`MergeClick`). */
  mergeClick?: MergeClick;
  ci?: "green" | "red" | "pending" | "no-pr" | "merged";
  ciAt?: number;
  /** Current raw check facts; the merge offer itself is the crew's judgment. */
  checks?: CheckSnapshot;
  /** A raw reading's durable identity; forwarded by a tool response or the inbox, never a verdict. */
  ciObservation?: { id: string; signature: string; forwarded: boolean; notice?: string };
  /** When the host says the first check on that head started (INF-587). */
  ciStartedAt?: number;
  /** When the checks finished: the last finish when green, the first failure's when red. */
  ciFinishedAt?: number;
  /**
   * The default branch's newest run of each check the reading at `head` found
   * red (INF-1915 fix 1), read with that reading of the task's own pull
   * request and replaced or cleared by the next. Evidence about a failure's
   * cause for the crew's diagnosis and the merge card, never a merge
   * input: the merge boundary does not read it; the merge card's
   * checks hold does, letting the card up at once when that branch fails
   * every failed check too (`CrewmateCards.pendingCiGate`).
   */
  mainChecks?: MainCheckEvidence & { head: string };
  /** The newest watched run's state and host times, kept after its watch ends (INF-594). */
  runChecks?: RunChecks;
  landedMode?: "fast-forward" | "merge" | "pr";
  /**
   * The branch head a local merge landed (INF-2678): the version its
   * receipt names, so after a merge that kept the task open a later story
   * of the same change waits for its own merge.
   */
  landedHead?: string;
  /** The resulting merge, not the proposed branch head. */
  mergedSha?: string;
  /** Earliest published release verified to contain the change; absent is unknown. */
  firstRelease?: FirstRelease;
  /**
   * The independent review's latest verdict on a reviewed task (delivery
   * rigor phase 2), recorded on the BUILDER: the verdict, the head the
   * reviewer read, and the risk it named beside CI (never a hold, Q4). The
   * review that recorded it is read off the parent edge
   * (`TaskService.graph.verdictReviewOf`), never cached here.
   */
  reviewVerdict?: ReviewVerdict;
  reviewSha?: string;
  /**
   * The change reading the review was assigned, sha256 of the
   * position-stripped diff (INF-148). Absent when that commit could not
   * be read, including a computer on an older app.
   */
  reviewChange?: string;
  /**
   * On a REVIEW task: the version an earlier review of its builder passed,
   * when this review was commissioned for a later one (INF-401). Every
   * turn of this review reads only the difference since it. Not a
   * published field.
   */
  passedHead?: string;
  /**
   * A later head a pass covered because its change reading matched.
   * No longer written: the reading stored with that version covers it.
   * An older record's value still covers its head.
   */
  reviewCarrySha?: string;
  /**
   * Change readings stored with a version before it is an approval or a
   * repair, keyed by head (INF-416 G). Not a published field.
   */
  versionReadings?: Record<string, string>;
  reviewRisk?: ReviewRisk;
  reviewRiskNote?: string;
  reviewedAt?: number;
  /**
   * The earlier task whose pass the review facts above are (INF-6536
   * finding 3): a takeover at the very commit that task's review passed
   * carries the pass, and `proof` when the proof accepted there came with
   * it. Absent on a pass this task's own review recorded.
   */
  reviewFrom?: ReviewFrom;
  /**
   * The declaration record and preserved legacy count fields.
   * The host never increments these counts or uses their caps as holds.
   */
  ciRepair?: CheckRepairLedger;
  ciRounds?: number;
  ciRedHead?: string;
  ciCapAt?: number;
  reviewRounds?: number;
  /** The head the last COUNTED findings round read: a round is one per head. */
  reviewRoundSha?: string;
  reviewCapAt?: number;
  /** Absent on older holds: those remain captain-owned. */
  reviewCapOwner?: "firstmate" | "captain";
  capAnsweredAt?: number;
  /**
   * The captain's one recorded override (docs/delivery-rigor.md, "The
   * holds"): his words, the soft holds the first mate declared they pass,
   * and for how long. Only update_task override writes it, in a turn that
   * carries his words; `override` with empty `holds` clears it.
   */
  override?: HoldOverride;
  /**
   * The host's watch on the change's checks (docs/forge.md, "The check
   * watch"): present while a reading found them running and the host reads
   * them for the crewmate, absent otherwise.
   */
  ciWatch?: CiWatch;
  /** The Batch check cell's reading; the name is the one saved records carry. */
  queueStatus?: import("@shared/batches").BatchCheckFact;
  /**
   * The crew's declaration that a pushed branch's version runs no checks,
   * for a change with no pull request of its own (docs/forge.md, "Batches
   * of your own"). A pull request's declaration rides its merge review.
   */
  branchAbsence?: import("@shared/mergeReview").AbsentChecksDeclaration & { branch: string };
  /** Non-PR run watches, saved until their named terminal wake or a crewmate outcome read. */
  runWatches?: RunWatch[];
  /** Contract 4.66's unversioned kept click; retired at boot, never run. */
  mergeOrder?: MergeOrder;
  /**
   * The captain's merge approval and its lifecycle (FI3-304,
   * docs/delivery-rigor.md "A kept merge approval"): the newest one, standing
   * or ended. An ended one stays as the record of how it ended.
   */
  mergeAuthorization?: MergeAuthorization;
  /**
   * Reviewed pull requests a merge card may name (FI3-1543).
   * Selecting a referenced one updates the displayed `prNumber` and checks,
   * but only `checkTarget` selects it; the task's own branch remains its own.
   */
  mergeReviews?: MergeReview[];
  /** Explicitly selected referenced pull request for status and check watches, never branch ownership. */
  checkTarget?: MergeReview;
  /**
   * Writes the crewmate asked to send where a project lives, kept until the
   * captain's click sends one (FI3-1571 piece 4). `TaskService` is their one
   * writer: it keeps, takes and records them, and a close drops the ones
   * never sent.
   */
  writeAsks?: WriteAsk[];
  /**
   * The captain's Allow for the rest of this task choices (INF-2993): an
   * integration call of this task's crewmate that one covers runs without a
   * card. `TaskService` is their one writer, and a close drops them.
   */
  integrationAllowances?: IntegrationAllowance[];
  /**
   * When an unsafe data reader first held something of the captain's, such
   * as an integration's answer or a read of its project past the public
   * areas, and what: from then on a web address it has not opened waits for
   * the captain's click (docs/agents-reach.md, "Web pages"). Only
   * `TaskDeliveries.markReaderHolds` writes it, and the first mark stays.
   */
  readerHolds?: { at: number; what: string };
  /** The crewmate's cards whose marked action records the captain's yes (INF-3170 piece 2). */
  allowanceOffers?: AllowanceOffer[];
  /** The captain's recorded yeses, kept past a close (docs/delivery-rigor.md, "What the captain already allowed"). */
  captainAllowances?: CaptainAllowance[];
  /** The newest completion offers the host published, with the head each one's checks read. */
  completionOffers?: CompletionOffer[];
  /**
   * The risk assessment on the newest merge card the host published
   * (docs/card-authoring.md "The risk chart"): its crewmate's levels and
   * lines alone. A new merge card replaces it.
   */
  risk?: RiskAssessment;
  /**
   * The host's last refusal of this task's merge card, present until
   * a merge card goes up (docs/card-authoring.md, "A refused
   * merge card"): what the report wake and `crew_status` say beside
   * a report that claims the card went up.
   */
  cardRefusal?: CardRefusal;
  /**
   * What the crewmate's latest report declared about whose turn follows it
   * (FI3-435): it waits on the captain (`captainWait`, which places the
   * task's `captain` gate), or its work is finished and the captain has
   * acknowledged its outcome (`finishedAt`). Present from that report until
   * its next turn starts, including an ordinary-read or duplicate notification.
   * Aside and saved-answer reads do not start that turn.
   */
  captainWait?: CaptainWait;
  finishedAt?: number;
  /**
   * Beside either, what that report asked the Firstmate to do (FI3-710,
   * `needs_firstmate`), kept until the crewmate's next turn starts so the
   * idle ladder can raise it again while the Firstmate has not acted on
   * the task since (FI3-714).
   */
  needsFirstmate?: FirstmateAsk;
  /**
   * Beside a running job, when that report said its crewmate looks at it
   * again and what it waits for (INF-1244, `check_back`): kept until its
   * next turn starts, with the task's `at-time` gate it places.
   */
  checkBack?: CheckBack;
};

/** A crewmate's check-back: when its report named it, when it is due, and what it waits for. */
export type CheckBack = { at: number; until: number; waitingFor: string };

/** A wait on the captain a crewmate declared in its report: why, and the card he is to read. */
export type CaptainWait = { at: number; reason: string; cardId?: string };

/** A crewmate's request that the Firstmate act: when its report asked, and what. */
export type FirstmateAsk = { at: number; request: string };

/**
 * Why the host refused a merge card: its checks had not passed, the
 * CI cap holds it, its review has not passed, its shape failed the card
 * lint, or anything else the emit refused (its size, id or pictures) -
 * `why` carries the host's own words for each.
 */
export type CardRefusalReason = "checks" | "ci-cap" | "review" | "shape" | "other";

export type CardRefusal = {
  at: number;
  title: string;
  reason: CardRefusalReason;
  why: string;
};

/** One named run, its current attempt, bound and next read, and whether its early failure is known. */
export type RunWatch = {
  runId: number;
  name: string;
  attempt: number;
  since: number;
  nextAt: number;
  failureSeen?: boolean;
  /** What the app's newest read of the unfinished run saw, for the merge card's strip. */
  reading?: RunWatchReading;
};

/**
 * A watched run as the app last read it while it had not finished: the
 * version it runs at, its page, whether any job runs yet or every job still
 * waits for a machine, since when the app's reads have seen that state, and
 * when it read. The merge card shows it beside the pull request's own checks
 * while the run is for the version on offer.
 */
export type RunWatchReading = {
  head: string;
  url: string;
  state: "queued" | "running";
  since: number;
  at: number;
};

/**
 * One check watch, durable so it outlives a restart: the head it watches,
 * when it began at that head (what bounds it and names its wakes), when it
 * reads next, how many reads it has taken, and whether the early failure
 * wake for this head already went or the crewmate already read a red check.
 */
export type CiWatch = {
  head: string;
  since: number;
  nextAt: number;
  tries: number;
  failureSeen?: boolean;
};

export type TaskRecord = {
  id: string;
  /** `<PROJECT_KEY>-<seq>`, the conversational handle (D6). */
  key: string;
  seq: number;
  projectId: string;
  parentId: string | null;
  kind: TaskKind;
  title: string;
  /** The intent's one sentence of what done looks like. */
  goal: string | null;
  /** The structured spawn intent, when the task was commissioned from one. */
  intent: SpawnIntent | null;
  /** The rendered structured task brief. */
  prompt: string;
  repoId: string | null;
  repoDir: string;
  worktreeDir: string;
  branch: string;
  sessionFile: string | null;
  /** The vault account the crewmate is bound to; null = base runtime. */
  accountId: string | null;
  /**
   * The computer that runs work for this home where the task's crewmate
   * runs (docs/helper.md, "Holding a conversation"); null, or absent on a
   * row read before the column, is this Mac.
   */
  deviceId?: string | null;
  placement?: CommittedPlacement | null;
  /**
   * The tier this task routes at, carried to dispatch (P7/R1). Computed by
   * the work-shape policy since S2 (`src/core/routing/policy.ts`), not
   * judged by the Firstmate; `premium` is only ever reached by the
   * captain's own ask or an escalation.
   */
  difficulty: "low" | "medium" | "high" | "premium" | null;
  /**
   * The work shape that tier was computed from (S2). Null on rows written
   * before the shape existed, and on rows that never routed.
   */
  shape: WorkShape | null;
  gate: TaskGate | null;
  /**
   * open (waiting to start), active (a crewmate has it, including idle with
   * unlanded work waiting to be merged, landed or discarded), done (landed,
   * merged, released, answered or settled), dropped (cancelled, discarded, failed,
   * superseded).
   */
  status: TaskStatus;
  /** While active: what the crewmate is doing right now. */
  activity: TaskActivity | null;
  closedReason: TaskClosedReason | null;
  /** 0 urgent .. 3 low; 2 by default. */
  priority: number;
  startPolicy: TaskStartPolicy;
  /** About the worktree only; the session JSONL is kept regardless (D2). */
  workspaceState: TaskWorkspaceState;
  /** The latest complete report, in full and as its first sentence. */
  outcome: string | null;
  outcomeSummary: string | null;
  delivery: TaskDelivery | null;
  /** A merge/land click captured while the crewmate's current turn finishes. */
  pendingSettle?: PendingSettleIntent | null;
  /**
   * The idle clock (docs/report-sort.md, "The idle ladder"): when the
   * crewmate last went idle, null while a turn runs. Durable, so a restart
   * or a sleep reads the same clock.
   */
  idleSince?: number | null;
  /** The ladder's highest rung this idle episode: 0 none, 1 nudged, 2 woken, 3 card raised. */
  recoveryRung?: number;
  /** The Firstmate wakes this idle episode sent. */
  recoveryCount?: number;
  /** When the ladder last acted this episode. */
  recoveryAt?: number | null;
  /** The crewmate label and routed model id (denormalized; logs stay authoritative). */
  assignee: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  closedAt: number | null;
  /**
   * The failing test a filing names (quiet ledger). The host refuses a
   * second open row for the same path. Null on every other row.
   */
  testPath?: string | null;
  /** When the captain first opened this record. Null until then. */
  captainOpenedAt?: number | null;
  /** The Firstmate's one-line verdict on a filing. Null until recorded. */
  verdict?: string | null;
  /**
   * A confirmed manual start that did not begin, as JSON `{ reason }`.
   * Null once retried or resolved, and on rows written before the column.
   */
  startNotice?: string | null;
  /**
   * When this started task went back to the backlog (INF-2062): it waits
   * for a Start with its work kept, and nothing the host sends wakes it.
   * Null while it is not there; only `task_execution` holds it.
   */
  backlogSince?: number | null;
  /**
   * When the captain pinned this task to the top of Tasks (INF-3127). Null
   * while it is not pinned, and on rows written before the column.
   */
  pinnedAt?: number | null;
};

/**
 * What the passes over closed tasks' files read of each row
 * (`ClosedTaskFiles`, `TaskTempFiles`): which task, whether and when it
 * closed, and the computer that holds its files.
 */
export type TaskRetentionFields = Pick<TaskRecord, "id" | "status" | "closedAt" | "deviceId">;

/** The work facts ask coverage and its summaries need, without composed payloads. */
export type TaskCoverageFields = Pick<
  TaskRecord,
  "id" | "key" | "title" | "status" | "closedReason" | "createdAt" | "startedAt"
>;
