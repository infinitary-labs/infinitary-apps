import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { type AttachmentRef, attachmentWords, fileSizeWords } from "@shared/attachments";
import { type CutOff, isAuthFailureMessage } from "@shared/authFailure";
import {
  anythingElseOf,
  CARD_ANSWERS_BOUND_REFUSAL,
  CARD_ANSWERS_MAX_BYTES,
  CARD_ANSWERS_TOO_LONG,
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardAnswer,
  type CardMutation,
  type CardThread,
  cardAnswersBytes,
  cardAnswersSchema,
  cardChromeValueSchema,
  cardSubmissionSchema,
  cardTakesReplies,
  type DropTaskReview,
  type HostEffect,
  isRoutineMergeCard,
  isStoryNote,
  onStage,
  replyWithSettings,
  requestMergeEffectOf,
  type ShellEffect,
  scriptChooser,
  settleEffectOf,
  type TaskLifecycleOp,
  type TaskMoveFrom,
  type TurnImage,
} from "@shared/cards";
import { readyPresentation } from "@shared/changePresentation";
import { type CheckChangeInput, isRepairAssessment } from "@shared/checkRepair";
import { currentCheckStatus } from "@shared/checkSnapshot";
import { isClientIssueReason } from "@shared/claudeClient";
import type { ResponsePolicy } from "@shared/crewResponses";
import { type CrewSpeed, type SpeedSelection, speedNote } from "@shared/crewSpeed";
import type { CrewSendResult } from "@shared/crewTranscript";
import { isCustomApiProvider } from "@shared/customApi";
import { COMPUTER, HERE, HOME } from "@shared/deviceNames";
import { noSignInsStartRefusal, updateStartRefusal } from "@shared/deviceSetup";
import { noNewWorkStartRefusal } from "@shared/deviceUpdateNudge";
import type { CrewCounts, FmEvent } from "@shared/events";
import { reportSummary } from "@shared/feed";
import { forgePlace } from "@shared/forge";
import { forgeSignInCardId } from "@shared/forges";
import {
  choiceWords,
  type HoldOverride,
  holdNames,
  overridePasses,
  overrideSpan,
  overrideWords,
  softHoldWords,
  standingOverride,
} from "@shared/holds";
import type { IntegrationApprovalChoice } from "@shared/integrations";
import {
  VALIDATION_GAPS_FIELD,
  validationAssignment,
  validationRevision,
  validationStateRevision,
} from "@shared/liveValidation";
import { offeringKey, parseOfferingKey } from "@shared/modelSlots";
import { UNCOMPARED_WAIT } from "@shared/placement";
import type { TypedFailure } from "@shared/plainProblem";
import { CREWMATE_TAB_VIA, type InterruptEventData, TASK_CARD_VIA } from "@shared/provenance";
import { catalogEntry, isRetiredProvider, PROVIDER_CATALOG } from "@shared/providers";
import { formatDurationShort } from "@shared/quotaSignals";
import {
  DROP_REVIEW_STALE,
  dropMissingRefusal,
  dropStartedRefusal,
  NO_LONGER_WANTED,
} from "@shared/recordDrop";
import { waitStall } from "@shared/recovery";
import {
  autonomyForRecord,
  deliveryForRecord,
  opensPullRequest,
  type RepoDelivery,
} from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import {
  isFolderRepair,
  isFolderWork,
  isPullRepair,
  levelDefaultReasoning,
  type WorkShape,
} from "@shared/routingPolicy";
import type { ServedWakeOrigin } from "@shared/servedFrame";
import {
  attachmentStanding,
  type TaskBrowserCommandResult,
  type TaskBrowserHandle,
} from "@shared/taskBrowser";
import {
  type EffectiveTaskPolicies,
  policyEditConsequences,
  type TaskPolicyEdits,
  taskPolicyEditsSchema,
} from "@shared/taskPolicies";
import {
  queueMissingRefusal,
  queueStartedBacklogRefusal,
  queueStartedRefusal,
} from "@shared/taskQueue";
import {
  CARE_WORDS,
  MERGE_AFTER_FIXING_WORDS,
  MERGE_WHEN_CHECKS_PASS_WORDS,
  MERGE_WORDS,
  REVIEW_CAREFULLY_WORDS,
} from "@shared/vocabulary";
import type { HandoverFile } from "@shared/work";
import { ACTION_VALUE_MAX_BYTES } from "../../shared/plugins/bridge";
import { CUT_OFF_REFUSED, CUT_OFF_SIGNED_OUT } from "../accounts/credentialHealth";
import { AttachmentUnavailableError, keepImages, loadImages } from "../attachments";
import type { BrowserReturned } from "../browser/taskBrowsers";
import type {
  DownloadArtifactInput,
  GithubReadInput,
  GithubWriteInput,
  ReadWorkflowInput,
} from "../forge";
import type { IntegrationAskTaken } from "../integrations";
import { jobExitWake } from "../jobs/jobManager";
import { renderDirections } from "../knowledge/directions";
import { knowledgeBinding } from "../knowledge/knowledgeTools";
import { capWithOverflow, type MessageFile, withPastedFiles } from "../overflow";
import {
  crewmateCardBodiesDir,
  crewmateCardPicturesDir,
  crewmateEvidenceDir,
  crewmateHandoverDir,
  crewmateSessionsDir,
  crewmateTempDir,
} from "../paths";
import { errorText } from "../personal/errorText";
import type { PanelPlaceResult } from "../personal/personalExtensions";
import { resolveFirstmateCardId } from "../pi/cardTool";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import type { CrewStatusEntry } from "../pi/crewTools";
import { renderPlaceText } from "../pi/panelTools";
import type { PlacedCopy } from "../placed/placedCopies";
import { PreparationUnknown } from "../placed/placedCopies";
import { CrewPrograms, ProgramRunner } from "../program/programRunner";
import { KIND_SOURCE, kindEstablished } from "../routing/kindClassifier";
import { legacyShapeFromDifficulty, tierFor } from "../routing/policy";
import { type RouteResult, requiresReasoningWait } from "../routing/router";
import { isDowngrade } from "../routing/routingEngine";
import { crewRunbookText } from "../runbooks/runbooks";
import { followCompletions } from "../session/followCompletions";
import { type AnsweredRead, OpenReads } from "../session/openReads";
import {
  type ClientBackgroundTask,
  type ControlProfile,
  LOCAL_MACHINE_ID,
  type ModelSession,
  type SessionEvent,
  type SessionSpec,
  StoppedBeforeStartError,
} from "../session/session";
import { bindTools, type EmittedCardInput } from "../session/tools";
import type { DuplicateResult } from "../storage/cardStore";
import { currentChange } from "../storage/changeProjection";
import {
  FIRSTMATE_RECIPIENT,
  INBOX_ATTEMPT_MAX,
  type InboxRow,
  SUPERVISION_RECIPIENT,
} from "../storage/inboxStore";
import type { CompletionOffer, TaskGate, TaskRecord } from "../storage/taskStore";
import {
  deliverHandoverFile,
  HANDOVER_IN_DIR_NAME,
  handoverFileName,
  keptHandoverFiles,
  verifyHandoverFiles,
} from "../tasks/handoverFiles";
import { StaleValidationDecisionError } from "../tasks/liveValidation";
import { hasStartQueueWait, queueWaitOf } from "../tasks/queueWait";
import { carryOnWords, modelMoveWords } from "../tasks/recordActivity";
import { TaskGraphRefusal } from "../tasks/taskGraph";
import {
  builtOnRows,
  queryTasks,
  type TaskQueryInput,
  type TaskQueryReach,
  type TaskQueryRow,
} from "../tasks/taskQuery";
import { TaskService } from "../tasks/taskService";
import { provisionTaskTemp } from "../tasks/taskTemp";
import type { ReportDeclaration } from "../tasks/taskTurns";
import { crewTally } from "../tasks/workPresentation";
import { compareSemver } from "../update/semver";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { gitFailure } from "../workspace/git";
import type {
  DependencyInstall,
  DispatchBase,
  WorktreeAcquisition,
} from "../workspace/workspaceService";
import { type AskEnding, askEndingOf } from "./askEnding";
import { CaptainOverrides } from "./captainOverrides";
import type { WakeChoice } from "./captainWakes";
import { cardEmitter, FIRSTMATE_CARD_PREFIX } from "./cardEmit";
import type { CardInteractionEvidence } from "./cardEvidence";
import { cardMutationText } from "./cardMutationText";
import { CardService } from "./cardService";
import { declareRunCheck } from "./checkRepair";
import { CheckWatcher } from "./checkWatch";
import { ciFactOf } from "./ciFact";
import { CrewBrief } from "./crewBrief";
import { CrewmateCards } from "./crewmateCards";
import {
  type InterruptSource,
  type MoveTarget,
  type PlacementRecord,
  QUIT_SETTLE_MS,
  type SteerDelivery,
  type SteerSource,
  SUPERVISOR_STEER,
  type TaskRuntime,
  type UnreadSteer,
} from "./crewRuntime";
import {
  type CrewmateRestart,
  type CrewmateSpec,
  crewmateProcedureFor,
  crewmateRenewedNote,
  crewmateResumeToken,
  crewmateSessionSpec,
} from "./crewSession";
import type {
  CrewSupervisorOptions,
  FirstmateHooks,
  PersonalLiveDelegate,
  PluginConsentHandler,
  ProjectSetupHandler,
} from "./crewSupervisorOptions";
import { CrewUpdates } from "./crewUpdates";
import { premiumRetryPossible } from "./holds";
import {
  type AccountServeability,
  IdleLadder,
  JOB_BOUND_MS,
  type RunningJob,
  stallCardId,
} from "./idleLadder";
import { InPlaceWork } from "./inPlaceWork";
import { blockedText, gateText, reasoningWaitGate, TaskIntake } from "./intake";
import { IntegrationAsks, writeSentLine } from "./integrationAsks";
import {
  type BriefPart,
  briefText,
  type PersonalBriefFacts,
  renderIntentBrief,
  renderPullRepairBrief,
  renderReviewBrief,
  withDeliveryLine,
} from "./intentBrief";
import { checkBackAsk, checkBackAskOnce, unnamedBackgroundWork } from "./jobWakes";
import { MainCheckWatcher } from "./mainCheckWake";
import { approvableOffer, isCaptainGuidance, mergeHold } from "./mergeAuthorization";
import { namedModelOf, namedModelWords } from "./namedModel";
import { outageFailedWake } from "./outageWakes";
import { ReportIntake } from "./reportIntake";
import { implausibleReport } from "./reportPlausibility";
import { type IdleRule, type ReportSortRule, sortReport } from "./reportSort";
import {
  PENDING_RESPONSES_END,
  PENDING_RESPONSES_OPENING,
  type WakeOpenReview,
  wakeBuiltOn,
} from "./reportWakes";
import { RestartWatch } from "./restartWatch";
import { Reviews } from "./reviews";
import { RunWatcher } from "./runWatch";
import { SettleFacts } from "./settleCardFacts";
import { createSettleOwners, type SettleOwners } from "./settleOwners";
import { describeStatus } from "./settleService";
import { computerLeftOutWake, systemWaitWake } from "./startWakes";
import { installText, TaskMoves } from "./taskMoves";
import { placedCutOffStartRefusal, TaskPlacement } from "./taskPlacement";
import { askedUnderCardLine, toldInCrewmateTabLine } from "./threadWords";
import type { Ticker } from "./ticker";
import { conversationRestartWake, type OpenCallFact } from "./turnWakes";
import {
  laneText,
  laneTurnText,
  renderWake,
  replyWordsSpan,
  rowAttachments,
  type TypedWake,
  type WakeBody,
  withAttachmentsDropped,
  withAttachmentsKept,
  withGuidanceMark,
} from "./wakes";
import { WorkPostures } from "./workPosture";
import {
  branchFromSource,
  classifyShape,
  deliverableOf,
  withBasisVerdict,
  withDeliverable,
  workShape,
} from "./workShape";

/**
 * The crew supervisor: task lifecycle, event fan-out, and card production.
 * Work starts only through intake.commission() - a deliberate Firstmate agent
 * decision via the spawn_crewmate tool - never directly from user input
 * (the loop inversion; docs/architecture.md section 2).
 *
 * Crewmate sessions are multi-turn: a completed turn leaves the task idle
 * and steerable rather than finished, so follow-ups continue the same
 * crewmate. The supervisor is the authoritative crew registry (the host
 * owns the fleet, not any agent's transcript); lifecycle events reach the
 * Firstmate agent through the hooks as [fm-op] inbox messages.
 */

/**
 * The quiet-crewmate watchdog (P4): conservative thresholds, no settings
 * surface. Ten silent minutes on a streaming turn earns one feed line,
 * twenty a check with the live session that runs it and a wake to the
 * Firstmate unless that check ended the turn; the generous wall-clock bound
 * escalates a turn that never ends. The watchdog never stops a turn that
 * still runs (firstmate's rule: the bound demands inspection, never an
 * automatic kill); it ends only one its live session says is already over
 * (INF-2332). Exported for the Firstmate agent's own-turn watchdog, which
 * mirrors them.
 */
export const QUIET_FEED_MS = 10 * 60 * 1000;
export const QUIET_CARD_MS = 20 * 60 * 1000;
/** A turn's wall-clock bound; a background job counts as moving for the same (idleLadder.ts). */
const TURN_WALL_CLOCK_MS = JOB_BOUND_MS;
const WATCHDOG_TICK_MS = 60 * 1000;
/**
 * The task timeline's line for a turn whose end never arrived, ended once
 * the live session that ran it said it no longer works (INF-2332).
 */
export const UNHEARD_END_NOTE =
  "its turn had already ended where it ran, but that end never arrived; ended here as interrupted";
/**
 * Why a start on request refuses a row that waits on blockers. Only a done
 * blocker clears its wait (`TaskService.blockerCleared`) and a dropped edge
 * keeps blocking until it is removed, so the tool's way out is removing the
 * edge - never dropping the blocker. The captain's refusal leaves it out.
 */
function readStartNotice(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.length > 0
      ? parsed.reason
      : undefined;
  } catch {
    return undefined;
  }
}

function startWaitRefusal(
  record: TaskRecord,
  handle: string,
  blockers: TaskRecord[],
  audience: "tool" | "captain",
): string {
  const named = blockers.map(
    (blocker) =>
      `${blocker.key || blocker.id} "${blocker.title}"${blocker.status === "dropped" ? " (dropped)" : ""}`,
  );
  const waits = `Cannot start ${handle} now: it waits on ${named.join(", ")}.`;
  if (audience !== "tool") return waits;
  const plural = (list: TaskRecord[]) => (list.length === 1 ? "" : "s");
  const dead = blockers.filter((blocker) => blocker.status === "dropped");
  if (dead.length === 0) {
    return `${waits} It can start once that work is done; to start it sooner, remove the blocks edge${plural(blockers)} with link_tasks remove. Dropping a blocker never clears its wait. ${softHoldWords("start-waits", "firstmate")}`;
  }
  const key = record.key || record.id;
  const edges = dead.map((blocker) => `blocks ${blocker.key || blocker.id} -> ${key}`).join(", ");
  const rest = dead.length < blockers.length ? "; it can start once the rest is done" : "";
  return `${waits} Dropped work never clears a wait: remove the dead edge${plural(dead)} ${edges} with link_tasks remove${rest}.`;
}

/** The same waiting phrased at dispatch, once it cleared. */
function gateClearedText(gate: TaskGate): string {
  switch (gate.kind) {
    case "quota-reset":
      return gate.ref?.startsWith("bucket:")
        ? `a ${gate.ref.slice(7)} model has allowance again`
        : `${gate.ref}'s allowance is back`;
    case "at-time":
      return "its time arrived";
    case "captain":
      return "you said to";
  }
}

/** A few names for one feed line, the rest counted. */
function listSome(items: string[], limit = 5): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown}, and ${items.length - limit} more` : shown;
}

/**
 * The timeline line a dispatch leaves about its working copy: reused warm
 * from the pool or made new, and the commit it starts from. A failed
 * refresh of the default branch is said, never hidden - the task still
 * starts, from what this machine last saw.
 */
function worktreeText(acquired: WorktreeAcquisition, where?: string): string {
  const on = where ? ` on ${where}` : "";
  const copy =
    acquired.source === "pool"
      ? `a warm working copy was reused${on}`
      : `a new working copy was made${on}`;
  const { base } = acquired;
  switch (base.fetch) {
    case "fetched":
      return `${copy}, starting from the latest ${base.ref}`;
    case "failed":
      return `${copy}; ${base.ref} could not be refreshed (${base.fetchError ?? "unknown error"}), so it starts from the last one this machine saw`;
    case "none":
      return `${copy}, starting from ${base.ref === "HEAD" ? "the project's current commit" : base.ref}`;
  }
}

/** Lane rows that are the crewmate's own work, sent by nobody: they draw no spark (INF-759). */
const OWN_LANE_KINDS: ReadonlySet<string> = new Set([
  "job-exit",
  "conversation-restart",
  "turn-resumed",
]);

/**
 * The feed line for guidance that waited for a turn to end and goes out as
 * the next one (WI-5), and the fold that keeps one such line per task in
 * the feed (`feedOnce`, `recentFeed`; INF-1137).
 */
export const QUEUED_GUIDANCE_LINE = "Delivered guidance that waited for its turn to end";

/**
 * What a started task in the backlog hears with words sent to it (INF-2062):
 * it answers them and stays there, since only a Start picks it up again.
 */
export const BACKLOG_STEER_LINE =
  "This task waits in the backlog: answer what follows, then stop and wait. Do not carry on with the work until it is started again.";

/** The one line a Start puts before what waited on a started task's lane in the backlog. */
export function backlogLeftLine(actor: "captain" | "firstmate"): string {
  return `This task left the backlog: ${actor === "captain" ? "the captain" : "the first mate"} started it again. Carry on from where you stopped, with anything that waited on this task while it was there.`;
}
const QUEUED_GUIDANCE_FOLD = "queued-guidance";

/** The idle ladder's rule ids: its wakes are the host's own, never a report's. */
const IDLE_RULES: ReadonlySet<string> = new Set<IdleRule>([
  "idle-nudge",
  "idle-wake",
  "idle-repeat",
  "idle-card",
  "job-bound",
  "provider-cut-off",
  "provider-back",
]);

/** Typed refusal lets non-UI consumers retain the open card rather than accept it. */
export class CardChoiceUnavailableError extends Error {
  constructor(reason: "not-ready" | "task-closed" | "undeclared" | "action-changed" = "not-ready") {
    super(
      reason === "action-changed"
        ? "This action changed or still waits for other work. Read its current card before confirming."
        : reason === "undeclared"
          ? "This choice is not offered on this card. Choose one of its available options."
          : reason === "task-closed"
            ? "This choice is not available. Its task is no longer open."
            : "This choice is not ready. Wait for the card to return.",
    );
  }
}

/**
 * Every fm-op excerpt below rides through capWithOverflow instead of a bare
 * slice (2026-09-04 captain decision): a crewmate's real report - or the
 * error, guidance, or job output standing in for one - is never just cut at
 * a fixed length. capWithOverflow's own MESSAGE_EXCERPT_LIMIT is the cap;
 * anything longer spills to a file and the excerpt carries a pointer.
 */

/**
 * The feed's line when a task is served from a weaker slot than it asked for
 * (P7: never a silent downgrade). When a withheld account would have served
 * the slot asked for, the line says what withholds it; otherwise that slot's
 * models had no allowance left.
 */
export function downgradeLine(
  title: string,
  served: RouteResult["bucket"],
  routed: Pick<RouteResult, "bucket" | "withheld">,
): string {
  const lead = `Using a ${served} model for "${title}"`;
  const withheld = routed.withheld;
  if (!withheld) return `${lead} - ${routed.bucket} models have used up their allowance right now.`;
  const name = catalogEntry(withheld.provider)?.name ?? "Its provider";
  const held = `${lead} - ${name}'s ${routed.bucket} models are paused`;
  if (withheld.reason === CUT_OFF_SIGNED_OUT) return `${held} until you sign in again.`;
  if (withheld.reason === CUT_OFF_REFUSED) return `${held} while ${name} refuses your sign-in.`;
  if (isClientIssueReason(withheld.reason)) return `${held}: ${name} cannot run on ${HERE.this}.`;
  return `${held} right now.`;
}

/**
 * A report's handed files in the words the first mate reads (INF-992):
 * kept names and sizes, never content, and the task its steer names.
 */
function handedFilesLine(
  task: { id: string; key: string },
  files: readonly HandoverFile[],
): string {
  const named = files.map((file) => `${file.file} (${fileSizeWords(file.size)})`).join(", ");
  return `Files handed on, kept for steer_crewmate files_from ${task.key || task.id}: ${named}.`;
}

/**
 * The sign-in card a crewmate's turn raises when its provider no longer
 * accepts the sign-in: one per task, taken down once the account it was held
 * on serves again (`IdleLadder.checkCutOffs`).
 */
export function crewSignInCardId(taskId: string): string {
  return `card-auth-${taskId}`;
}

export class CrewSupervisor {
  private readonly tasks = new Map<string, TaskRuntime>();
  /**
   * Starts the captain pressed that wait for the Firstmate to apply his
   * standing directions: the wake's inbox row, and where the press came from
   * so the history still records it as his. The row is the saved copy, so a
   * quit loses nothing (`resumePendingStarts`).
   */
  private readonly pendingStarts = new Map<
    string,
    { rowId: number; from?: typeof TASK_CARD_VIA; panel?: string }
  >();
  private pendingStartsResumed = false;

  /** Charted starts requested and not yet claimed. A drop in that window refuses. */
  private readonly starting = new Set<string>();
  /** Each task's conversation opening here now (`resumeTask`), which a plain resume joins. */
  private readonly resuming = new Map<string, Promise<TaskRuntime>>();
  /** The facts a settle card's task writes on the card: its fact strip and its follow-ups. */
  private readonly settleFacts: SettleFacts;
  /** The card stack: the open cards and every write to them. */
  readonly cards: CardService;
  /** How each captain's message ends (INF-1610, docs/task-capture.md "How a message ends"). */
  readonly askEnding: AskEnding;
  /** Settling and closing: land, merge-pr, discard, and every close's teardown. */
  readonly settling: SettleOwners;
  /** A crewmate's brief at dispatch, and the runbook facts its instructions are selected by. */
  private readonly briefs: CrewBrief;
  /** Independent reviews and repair assessments: their reads, verdicts and tasks. */
  private readonly reviews: Reviews;
  /** Where each task runs: its computer, the waits for it, and the words said of it. */
  readonly placement: TaskPlacement;
  /** A started task's moves: to another provider between turns, and to another computer at a safe pause. */
  readonly moves: TaskMoves;
  /** The captain's overrides of a soft hold: declared, withdrawn, and the words they cite. */
  readonly overrides: CaptainOverrides;
  /** The crew's pause and save while a computer is updated. */
  readonly updates: CrewUpdates;
  /** The crew a restart or an update cut, watched until each carries on or stops. */
  private readonly restarts: RestartWatch;
  /** A crewmate's own cards: its emit_card, the completion card the host finishes, and its refusals. */
  readonly crewmateCards: CrewmateCards;
  /** Integration calls held for the captain: their approval cards and what came of them. */
  readonly integrationAsks: IntegrationAsks;
  /** What a crewmate reports: its follow-ups, progress, report, responses and validation records. */
  readonly reportIntake: ReportIntake;
  /** The host's own work in a project's folder: its repairs, the start check and their close. */
  readonly inPlaceWork: InPlaceWork;
  /** How the crew takes in new work: commissions, plans, reviews and the task graph's links and drops. */
  readonly intake: TaskIntake;
  private crewmateSeq = 0;
  /** The watchdog's registrations on the shared ticker, undone at dispose. */
  private watchdog: (() => void)[] | undefined;
  /** Sessions let go of mid-turn, each until it is gone (`releaseSession`). */
  private readonly releasing = new Set<Promise<void>>();
  /** Ready sweeps running now, each until it ends (`sweepGates`). */
  private readonly sweeping = new Set<Promise<void>>();
  /** The app is quitting: a turn that settles now is not the crew's to act on. */
  private disposed = false;
  /** Who waits for a task's running turn to end here, by task (`untilTurnOver`). */
  private readonly turnWaiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  /** Serializes inbox sweeps: a resume-heavy pass must not overlap itself. */
  private sweepingInbox = false;
  private hooks: FirstmateHooks = { notifyOp: () => {}, retryConverse: () => {} };
  /** The idle ladder and the holds: the witnesses, the gate, the caps and the ready sweep. */
  private readonly ladder: IdleLadder;
  /** Each task's posture, and the wait facts read from the same snapshot. */
  readonly postures: WorkPostures;
  private readonly ciFact = Symbol("crew check summary");
  /** The host's watch on crewmates' checks; absent when no read is wired. */
  private readonly checkWatch: CheckWatcher | undefined;
  /** Wakes baseline waits when the default branch's own run of that check passes. */
  private readonly mainCheckWake: MainCheckWatcher | undefined;
  private readonly runWatch: RunWatcher | undefined;
  private recoveredPendingSettles = false;
  /** Every running program (INF-799 piece 2, docs/programs.md). */
  private readonly programs: ProgramRunner;
  /** The crew's side of a running program: its parts, its asks, its bound and its end. */
  private readonly crewPrograms: CrewPrograms;

  constructor(private readonly options: CrewSupervisorOptions) {
    const now = options.now;
    this.now = now ? () => now() : () => Date.now();
    this.restarts = new RestartWatch(options, { now: this.now });
    this.updates = new CrewUpdates(options, {
      now: this.now,
      restarts: this.restarts,
      disposed: () => this.disposed,
      runtimes: () => this.tasks.values(),
      machineOf: (taskId) => this.machineOf(taskId),
      untilTurnOver: (task) => this.untilTurnOver(task),
      sweepTaskLane: (taskId, at) => this.sweepTaskLane(taskId, at),
      sweepGates: (at) => this.sweepGates(at),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
    });
    // A project moved: its tasks that have not started follow it (docs/helper.md, "Runs on").
    options.repos.onRunsOn?.((repo) => this.placement.projectMoved(repo));
    this.settleFacts = new SettleFacts(options, {
      now: this.now,
      taskDelivery: (taskId) => this.taskDelivery(taskId),
      reviewOpen: (taskId) => this.openReviewOf(taskId) !== undefined,
    });
    this.cards = new CardService({
      now: this.now,
      tasks: options.tasks,
      cardStore: options.cardStore,
      syncCaptainGate: (taskId, at) => this.ladder.syncCaptainGate(taskId, at),
      closeAnsweredTask: (card, action, by) =>
        this.settling.declared.closeAnsweredTask(card, action, by),
      settleFacts: (taskId) => this.settleFacts.strip(taskId),
      mergeLabel: (card) => this.mergeLabel(card),
      mergeAnyway: (card) => this.mergeAnyway(card),
      holdsUntilMerge: (card, merging) => this.holdsUntilMerge(card, merging === true),
      otherChangeOpen: (taskId) => this.otherChangeOpen(taskId),
      followupNotice: (taskId) => this.settleFacts.followupNotice(taskId),
      choiceUnheard: (card) => {
        const lane = card.id.startsWith(FIRSTMATE_CARD_PREFIX) ? FIRSTMATE_RECIPIENT : card.taskId;
        return lane !== undefined && options.inbox.holdsUndeliveredChoice(lane, card.id);
      },
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
      broadcastEvent: options.broadcastEvent,
      broadcastCards: options.broadcastCards,
      presentationChanged: options.presentationChanged,
      ...(options.broadcastThread ? { broadcastThread: options.broadcastThread } : {}),
      ...(options.build ? { build: options.build } : {}),
      captainResponded: (card, response, action) => {
        this.askEnding.captainResponded(card, response, action);
        this.hooks.asksMoved?.();
      },
      cardPlaced: () => this.hooks.cardPlaced?.(),
      checkCardResponse: (_taskId, response, card) =>
        this.reportIntake.checkCardResponse(response, card),
      submitCardResponse: (taskId, response, text, line) => {
        options.inbox.submitResponse(
          response,
          { task: taskId, session: this.tasks.get(taskId)?.session?.recordPath() ?? null },
          text,
          line,
        );
        queueMicrotask(() => this.hooks.pokeInbox?.());
      },
    });
    this.askEnding = askEndingOf(options.tasks, this.cards);
    this.placement = new TaskPlacement(options, {
      now: this.now,
      cards: this.cards,
      runtime: (taskId) => this.tasks.get(taskId),
      outOfReach: (taskId) => this.outOfReach(taskId),
      reviewBuilderOf: (record) => this.reviewBuilderOf(record),
      dispatchQueuedTask: (taskId) => this.dispatchQueuedTask(taskId),
    });
    this.moves = new TaskMoves(options, {
      now: this.now,
      placement: this.placement,
      runtime: (taskId) => this.tasks.get(taskId),
      releaseSession: (runtime) => this.releaseSession(runtime),
      forgetRuntime: (taskId) => this.tasks.delete(taskId),
      resumeTask: (taskId, move) => this.resumeTask(taskId, move),
      deliverPendingToTask: (task) => this.deliverPendingToTask(task),
      deliverLane: (taskId) => this.deliverLane(taskId),
      machineOf: (taskId) => this.machineOf(taskId),
      isPersonalTask: (taskId) => this.isPersonalTask(taskId),
      queuedShape: (record) => this.queuedShape(record),
      clientJobStart: (taskId) => this.clientJobStart(taskId),
      modelName: (model) => this.modelName(model),
      beingUpdated: (deviceId) => this.updates.isUpdating(deviceId),
      clearSignInCard: (taskId) => this.cards.clearAuthDecisionCard(crewSignInCardId(taskId)),
      disposed: () => this.disposed,
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
    });
    this.settling = createSettleOwners({
      now: this.now,
      tasks: options.tasks,
      inbox: options.inbox,
      workspace: options.workspace,
      repos: options.repos,
      cards: this.cards,
      askEnding: this.askEnding,
      asksMoved: () => this.hooks.asksMoved?.(),
      runtimeState: (taskId) => this.tasks.get(taskId)?.state,
      stopRuntime: (taskId) => this.stopRuntime(taskId),
      hasRunningJobs: (taskId) =>
        options.hasRunningJobs?.(taskId) === true || this.clientJobStart(taskId) !== undefined,
      announceReach: (taskId) => this.announceReach(taskId),
      ...(options.killJobs ? { killJobs: options.killJobs } : {}),
      ...(options.machines ? { placed: options.machines } : {}),
      endLiveTask: (taskId) => options.personal?.endLiveTask(taskId),
      ...(options.mergePullRequest ? { mergePullRequest: options.mergePullRequest } : {}),
      ...(options.validateLocalStory ? { validateLocalStory: options.validateLocalStory } : {}),
      ...(options.mergeReview ? { mergeReview: options.mergeReview } : {}),
      mergeContinued: (taskId, review, outcome) => {
        if (outcome.ok) void this.sweepGates(this.now());
        const still = this.options.tasks.get(taskId);
        if (!still || TaskService.isClosed(still)) return;
        // A host result is not new captain guidance about the kept approval.
        void this.steerInternal(
          taskId,
          {
            facts: {
              kind: "merge-continued",
              ok: outcome.ok,
              ...(outcome.stop === "outcome" ? { unknown: true } : {}),
              change: review
                ? `#${review.number}`
                : still?.delivery?.prNumber !== undefined && outcome.stillOpen
                  ? `#${still.delivery.prNumber}`
                  : "the reviewed pull request",
              ...(outcome.receipt?.head || review?.headSha
                ? { head: outcome.receipt?.head ?? review?.headSha }
                : {}),
              ...(outcome.stillOpen ? { open: outcome.stillOpen } : {}),
              text: outcome.text,
            },
            ...(outcome.ok && review ? { once: `merge-continued:${review.id}` } : {}),
          },
          SUPERVISOR_STEER,
        ).catch((caught: unknown) => {
          console.warn("[crew] merge continuation not delivered:", caught);
        });
      },
      ...(options.closePullRequest ? { closePullRequest: options.closePullRequest } : {}),
      ...(options.readPull ? { readPull: options.readPull } : {}),
      assessRepair: (taskId) => this.reviews.assessRepair(taskId),
      fileFolderRepair: (merged, refusal) => this.inPlaceWork.fileFolderRepair(merged, refusal),
      folderMissing: (repoId, noticed, by) => this.inPlaceWork.folderMissing(repoId, noticed, by),
      filePullRepair: (abandoned, problem) => this.inPlaceWork.filePullRepair(abandoned, problem),
      isPersonalTask: (taskId) => this.isPersonalTask(taskId),
      deliverableOf,
      taskDelivery: (taskId) => this.taskDelivery(taskId),
      taskAutonomy: (taskId) => this.taskAutonomy(taskId),
      resolveTaskRef: (ref, param) => this.intake.resolveTaskRef(ref, param),
      notifyOp: (wake, origin, ref) => this.hooks.notifyOp(wake, origin, ref),
      pokeInbox: () => this.hooks.pokeInbox?.(),
      sweepGates: (at) => this.sweepGates(at),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
      broadcastEvent: options.broadcastEvent,
    });
    this.overrides = new CaptainOverrides(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      syncCaptainGate: (taskId, at) => this.ladder.syncCaptainGate(taskId, at),
      runtime: (taskId) => this.tasks.get(taskId),
      sweepTaskLane: (taskId, at) => this.sweepTaskLane(taskId, at),
    });
    this.briefs = new CrewBrief(options, {
      cards: this.cards,
      machineOf: (taskId) => this.machineOf(taskId),
      deliverHandover: (taskId, path, name, sha256) =>
        this.deliverHandover(taskId, path, name, sha256),
      knowledgeFor: (taskId) => this.knowledgeFor(taskId),
      backendOf: (taskId) => this.tasks.get(taskId)?.backend,
    });
    this.reviews = new Reviews(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      notifyOp: (wake, origin, ref) => this.hooks.notifyOp(wake, origin, ref),
      steer: (taskId, wake) => this.steerInternal(taskId, wake, SUPERVISOR_STEER),
      startTask: (spec) => this.startTask(spec),
      reviewBuilderOf: (record) => this.reviewBuilderOf(record),
    });
    this.crewmateCards = new CrewmateCards(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      cardPlace: (taskId) => this.placement.cardPlace(taskId),
      taskDelivery: (taskId) => this.taskDelivery(taskId),
      taskAutonomy: (taskId) => this.taskAutonomy(taskId),
      isPersonalTask: (taskId) => this.isPersonalTask(taskId),
      worksInPlace: (taskId) => this.worksInPlace(taskId),
      mergeModeFor: (taskId) => this.mergeModeFor(taskId),
      machineOf: (taskId) => this.machineOf(taskId),
      validationHead: (record) => this.reportIntake.validationHead(record),
      keepOffer: (taskId, offers, offer) => this.keepOffer(taskId, offers, offer),
    });
    this.integrationAsks = new IntegrationAsks(options, {
      cards: this.cards,
      notifyOp: (wake, origin, ref) => this.hooks.notifyOp(wake, origin, ref),
    });
    this.reportIntake = new ReportIntake(options, {
      cards: this.cards,
      askEnding: this.askEnding,
      isPersonalTask: (taskId) => this.isPersonalTask(taskId),
      personalFacts: () => this.personalFacts(),
      taskDelivery: (taskId) => this.taskDelivery(taskId),
      reviewBuilderOf: (record) => this.reviewBuilderOf(record),
      noteTaskActivity: (task) => this.noteTaskActivity(task),
      pokeInbox: () => this.hooks.pokeInbox?.(),
      clientJobStart: (taskId) => this.clientJobStart(taskId),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
    });
    this.inPlaceWork = new InPlaceWork(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      runtime: (taskId) => this.tasks.get(taskId),
      steer: (taskId, message) => this.steerInternal(taskId, message, SUPERVISOR_STEER),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
      sweepGates: (at) => this.sweepGates(at),
    });
    this.intake = new TaskIntake(options, {
      now: this.now,
      cards: this.cards,
      settling: this.settling,
      placement: this.placement,
      reviews: this.reviews,
      runtime: (taskId) => this.tasks.get(taskId),
      releaseSession: (runtime) => this.releaseSession(runtime),
      forgetRuntime: (taskId) => {
        this.tasks.delete(taskId);
      },
      recordInterrupt: (taskId, mode, source, effect) =>
        this.recordInterrupt(taskId, mode, source, effect),
      personalFacts: () => this.personalFacts(),
      taskDelivery: (taskId) => this.taskDelivery(taskId),
      openReviewOf: (builderId) => this.openReviewOf(builderId),
      startTask: (spec) => this.startTask(spec),
      dispatchQueuedTask: (taskId, dispatch) => this.dispatchQueuedTask(taskId, dispatch),
      wakeReasoningWait: (taskId, title, routed) => this.wakeReasoningWait(taskId, title, routed),
      announceReach: (taskId) => this.announceReach(taskId),
      haltProgram: (programId) => this.programs.halt(programId),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
      sweepGates: (at) => this.sweepGates(at),
    });
    this.crewPrograms = new CrewPrograms(options, {
      now: this.now,
      settling: this.settling,
      resolveGraphPlacement: (input) => this.intake.resolveGraphPlacement(input),
      notifyOp: (wake, origin, taskId) => this.hooks.notifyOp(wake, origin, taskId),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
      sweepGates: (at) => this.sweepGates(at),
    });
    this.programs = new ProgramRunner({
      tasks: options.tasks,
      spawner: options.programProcess,
      filePart: (program, part) => this.crewPrograms.fileProgramPart(program, part),
      closePart: (partId) => this.crewPrograms.closeProgramPart(partId),
      ask: (program, prompt, schema) => this.crewPrograms.programAsk(program, prompt, schema),
      finish: (program, end) => this.crewPrograms.finishProgram(program, end),
      bounded: (program, calls) => this.crewPrograms.programBounded(program, calls),
    });
    const serveability = this.serveability();
    this.ladder = new IdleLadder({
      now: this.now,
      tasks: options.tasks,
      inbox: options.inbox,
      runtime: (taskId) => this.tasks.get(taskId),
      hasRunningJobs: (taskId) =>
        options.hasRunningJobs?.(taskId) === true || this.clientJobStart(taskId) !== undefined,
      oldestRunningJob: (taskId) => this.oldestJob(taskId),
      openCards: () => this.cards.values(),
      answerNoteForTask: (taskId) => this.cards.answerNoteForTask(taskId),
      threadsAwaitingAuthor: (taskId) => this.cards.threadsAwaitingAuthor(taskId),
      bypassesSupervision: (taskId) => this.bypassesSupervision(taskId),
      notifyOp: (wake, origin, taskId) => this.hooks.notifyOp(wake, origin, taskId),
      premiumCanServe: () => this.premiumCanServe(),
      recordSort: (taskId, title, wake, verdict, reason, rule, effect) =>
        this.recordSort(taskId, title, wake, verdict, reason, rule, effect),
      steer: (taskId, message) => this.steerInternal(taskId, message, SUPERVISOR_STEER),
      raiseCard: (card) => this.cards.put(card),
      withdrawCard: (id, resolution) => this.cards.takeDown(id, resolution),
      answerOwed: (id) => this.cards.answerOwed(id),
      dispatchQueuedTask: (taskId) => this.dispatchQueuedTask(taskId),
      ...(serveability ? { serveability } : {}),
      placedAccount: (deviceId, taskId) => options.machines?.accountOf(deviceId, taskId),
      outOfReach: (taskId) => this.outOfReach(taskId),
      deliverLane: (taskId) => this.deliverLane(taskId),
      accountBack: (taskId) => this.cards.clearAuthDecisionCard(crewSignInCardId(taskId)),
      ...(options.quotaGateCleared ? { quotaGateCleared: options.quotaGateCleared } : {}),
      heldOnItsLevel: (record) => this.heldOnItsLevel(record),
      wakeDeadGate: (record, dead) => this.wakeDeadGate(record, dead),
      completeContainers: () => this.intake.completeContainers(),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
      ...(options.readCheckWatch || options.readRunWatch
        ? {
            checksWatched: (record: TaskRecord) =>
              record.delivery?.ciWatch !== undefined ||
              (record.delivery?.runWatches?.length ?? 0) > 0,
          }
        : {}),
      ...(options.browsers
        ? { browserWithCaptain: (taskId: string) => options.browsers?.withCaptain(taskId) === true }
        : {}),
    });
    this.postures = new WorkPostures(options, {
      now: this.now,
      witnesses: (taskId, at) => this.ladder.witnesses(taskId, at),
      heldBy: (record) => this.ladder.heldBy(record),
      runtime: (taskId) => this.tasks.get(taskId),
    });
    const readRunWatch = options.readRunWatch;
    this.runWatch = readRunWatch
      ? new RunWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readRunWatch,
          steer: (taskId, wake) => this.steerInternal(taskId, wake, SUPERVISOR_STEER),
        })
      : undefined;
    const readCheckWatch = options.readCheckWatch;
    this.checkWatch = readCheckWatch
      ? new CheckWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readCheckWatch,
          ...(options.readPull
            ? {
                reconcileMerged: (taskId: string) =>
                  this.settling.settle.reconcileExternalMerge(taskId),
              }
            : {}),
          // The posture the Tasks dot shows as "Blocked by another task".
          idleBehindOtherWork: (record) => {
            const posture = this.postures.workPosture(record);
            return posture.state === "idle" && posture.reason === "dependency";
          },
          steer: (taskId, wake) => this.steerInternal(taskId, wake, SUPERVISOR_STEER),
        })
      : undefined;
    const readMainChecks = options.readMainChecks;
    this.mainCheckWake = readMainChecks
      ? new MainCheckWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readMainChecks,
          steer: async (taskId, wake) => {
            this.options.tasks.turns.endIdle(taskId);
            await this.steerInternal(taskId, wake, SUPERVISOR_STEER);
          },
        })
      : undefined;
  }

  private pluginConsent: PluginConsentHandler | null = null;

  /** The installer answers the consent card's host ops (A2a). */
  setPluginConsent(handler: PluginConsentHandler): void {
    this.pluginConsent = handler;
  }

  private projectChange: {
    apply: (arg: string | undefined) => void;
    decline: (arg: string | undefined) => void;
    inspect: (repoId: string) => Promise<void>;
  } | null = null;
  setProjectChange(handler: NonNullable<CrewSupervisor["projectChange"]>): void {
    this.projectChange = handler;
  }

  private projectSetup: ProjectSetupHandler | null = null;

  /** The setup card's host ops reach the project setups (docs/fleet.md). */
  setProjectSetup(handler: ProjectSetupHandler): void {
    this.projectSetup = handler;
  }

  setFirstmateHooks(hooks: FirstmateHooks): void {
    this.hooks = hooks;
    if (this.recoveredPendingSettles) return;
    this.recoveredPendingSettles = true;
    // TaskService has already marked a turn left running by a dead process
    // interrupted. Resume the captain's durable intent only after the
    // Firstmate wake path is attached, so its eventual outcome is not lost.
    queueMicrotask(() => {
      // Recover a committed edit whose notice a quit prevented us from queuing.
      for (const record of this.options.tasks.listLive()) {
        const revision = record.shape?.policies?.revision;
        if (!revision) continue;
        const event = this.options.tasks.timeline(record.id).findLast((entry) => {
          const changes = entry.data?.changes;
          return changes && typeof changes === "object" && "policies" in changes;
        });
        const changes = event?.data?.changes as { policies?: unknown } | undefined;
        const edits = taskPolicyEditsSchema.safeParse(changes?.policies);
        if (edits.success) this.policiesChanged(record.id, edits.data);
      }
      this.settling.settle.resumePendingSettles();
      this.settling.kept.resumeMergeAuthorizations();
    });
  }

  /** A task lane's due rows. */
  private deliverableRows(taskId: string, now: number): InboxRow[] {
    const rows = this.options.inbox.pending(taskId, now, { maxAttempts: INBOX_ATTEMPT_MAX });
    const task = this.tasks.get(taskId);
    const running = task !== undefined && task.state !== "idle";
    // A renewed conversation's reason rides the next full turn (`runTurn`),
    // never a turn of its own and never a mid-turn steer; why the app
    // stopped a turn part way is a turn of its own, never a mid-turn steer.
    const rest = rows.filter(
      (row) =>
        row.facts?.kind !== "conversation-restart" &&
        !(running && row.facts?.kind === "turn-resumed"),
    );
    // A policy or override notice alone is guidance, not permission to resume or start.
    if (
      this.tasks.get(taskId)?.state !== "streaming" &&
      rest.every(
        (row) =>
          row.facts?.kind === "task-policies-changed" ||
          row.facts?.kind === "task-override-changed",
      )
    )
      return [];
    return rest;
  }

  /** The lane rows whose pictures were already said to be unavailable. */
  private blockedPictureRows = new Set<number>();

  /**
   * The pictures the rows' messages keep copies of, read back for the turn
   * or steer that serves them. A copy that is missing or changed blocks the
   * rows: they stay on the lane, and the feed says so once - never a
   * delivery without the picture the captain attached.
   */
  private rowPictures(
    taskId: string,
    rows: readonly InboxRow[],
  ): { images?: TurnImage[]; blocked?: true } {
    const refs = rowAttachments(rows);
    if (refs.length === 0) return {};
    try {
      return { images: loadImages(refs) };
    } catch (caught) {
      const first = rows[0]?.id;
      if (first !== undefined && !this.blockedPictureRows.has(first)) {
        this.blockedPictureRows.add(first);
        const why =
          caught instanceof AttachmentUnavailableError
            ? caught.message
            : "its picture could not be read";
        this.options.broadcastEvent({
          type: "firstmate_note",
          text: `A message to ${this.tasks.get(taskId)?.crewmate ?? "the crewmate"} is waiting: ${why} Send it again with the picture.`,
          taskId,
        });
      }
      return { blocked: true };
    }
  }

  /**
   * A task lane is held while a typed cut-off stands on its account (the
   * cut-off contract, docs/inbox.md; `IdleLadder.cutOffHolds`, the one
   * predicate the wakes read too): its rows are not attempted at all - no
   * attempt spent, no backoff advanced, no session resumed - until the
   * cut-off ends. A resumed task keeps its account even so
   * (`reselectForResume`), so the record's account is read too. The idle
   * ladder reads the hold as the task moving. A lane whose computer that
   * runs work is out of reach, or back and not yet caught up, is held the
   * same way (`outOfReach`).
   */
  /**
   * A started task went back to the backlog (INF-2062; `TaskRecord.backlogSince`):
   * the host's own rows wait on its lane until a Start, and nothing the
   * idle ladder or a report's sort reads wakes it. Words the captain or the
   * first mate send still reach it (`deliverPendingToTask`'s `sent`).
   */
  private inBacklog(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    return record?.status === "active" && record.backlogSince != null;
  }

  private laneHeld(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    // A move to another computer starts no new turn until it has moved, its
    // new conversation opened there and its dependencies installed
    // (`restartFrom`, `preparing`, `reopenMovedTask`).
    const move = record?.shape?.computer_move;
    if (
      move?.phase === "waiting" ||
      move?.phase === "moving" ||
      move?.restartFrom !== undefined ||
      move?.preparing === true ||
      this.moves.isCrossing(taskId)
    )
      return true;
    const accountId = this.tasks.get(taskId)?.accountId ?? record?.accountId;
    return (
      this.ladder.cutOffHolds({
        id: taskId,
        accountId: accountId ?? null,
        deviceId: record?.deviceId ?? null,
      }) ||
      this.outOfReach(taskId) ||
      this.updates.heldForUpdate(taskId)
    );
  }

  /**
   * Whether each account serves, as the cut-off contract reads it: this
   * Mac's own (`serveability`), and a computer's own for a task that runs
   * there (`CrewMachines.cutOffOf`), keyed apart (docs/helper.md, "Its own
   * sign-ins"). A wake names a computer's account with where it is, "Claude
   * on Mac mini". Absent when neither is given.
   */
  private serveability(): AccountServeability | undefined {
    const here = this.options.serveability;
    const machines = this.options.machines;
    if (!here && !machines) return undefined;
    return {
      cutOff: (account) => machines?.cutOffOf(account) ?? here?.cutOff(account),
      providerName: (account) => {
        const place = machines?.accountPlace(account);
        return place
          ? `${place.provider} ${place.where}`
          : (here?.providerName(account) ?? "the provider");
      },
      known: (account) => machines?.knows(account) ?? true,
    };
  }

  /** Where a task's crewmate runs: the computer that runs work its record names, or this Mac. */
  private machineOf(taskId: string): string {
    return this.options.tasks.get(taskId)?.deviceId ?? LOCAL_MACHINE_ID;
  }

  /**
   * The task runs on a computer that runs work, which is out of reach or
   * back and not yet caught up (docs/helper.md, "Holding a conversation"):
   * its turn goes on there, so nothing here calls it stuck, nudges it or
   * hands it work, and it never runs here instead.
   */
  private outOfReach(taskId: string): boolean {
    const machine = this.machineOf(taskId);
    if (machine === LOCAL_MACHINE_ID) return false;
    // Being updated, it stops for a moment: nothing is handed to it meanwhile.
    if (this.updates.isUpdating(machine)) return true;
    return this.options.machines?.ready(machine, taskId) !== true;
  }

  /** A lane's account serves again: its due rows go now, resuming the task if need be. */
  private deliverLane(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      this.deliverPendingToTask(task);
      return;
    }
    void this.sweepTaskLane(taskId, this.now());
  }

  /**
   * Run the cut-off watch now (`IdleLadder.checkCutOffs`): the vault just
   * recorded or cleared a cut-off, or a computer that runs work said
   * something new of its own sign-ins, so the Firstmate hears it and a held
   * lane goes on without waiting for the tick.
   */
  reconcileCutOffs(): void {
    this.resumePendingStarts();
    this.placement.reconcileStartChecks();
    this.ladder.checkCutOffs();
  }

  // ---- the card stack (CardService) -----------------------------------------

  /**
   * Whether the first mate's emit_card names a card that is not its own -
   * someone else's open or closed card, or a card id the record lacks -
   * so the write is a contribution (docs/card-threads.md, "Shared cards").
   */
  writesOnOthersCard(id: string | undefined): boolean {
    const target = this.cards.targetOf({ actor: "firstmate" }, id);
    return target.kind !== "new" && target.kind !== "own";
  }

  /**
   * The first mate's write on someone else's card, typed; undefined when the
   * card is its own or new, which `addFirstmateCard` shows.
   */
  contributeAsFirstmate(input: EmittedCardInput): CardMutation | undefined {
    if (!this.writesOnOthersCard(input.id)) return undefined;
    return this.cards.contribute({ actor: "firstmate" }, input, {
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      ...(input.contributionReason ? { reason: input.contributionReason } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.answersMessage !== undefined ? { answersMessage: input.answersMessage } : {}),
    });
  }

  addFirstmateCard(input: EmittedCardInput): string {
    if (input.requiredActions !== undefined) {
      const priorSource = input.id
        ? this.options.tasks.capture.taskForCard(resolveFirstmateCardId(input.id))
        : undefined;
      this.options.tasks.delivery.validateRequiredActions(
        input.taskId ?? priorSource?.id ?? "",
        input.requiredActions,
      );
    }
    const id = this.cards.addFirstmateCard(input);
    const offer = this.cards.get(id);
    if (input.taskId && input.actions.some((action) => settleEffectOf(action)?.mode === "merge"))
      this.bindFirstmateOffer(input.taskId, id);
    if (input.requiredActions !== undefined && input.taskId && offer?.offerId) {
      const merges = input.actions.some(
        (action) => settleEffectOf(action)?.mode === "merge" || requestMergeEffectOf(action),
      );
      this.options.tasks.delivery.declareRequiredActions(
        input.taskId,
        {
          cardId: id,
          offerId: offer.offerId,
          head: this.options.tasks.get(input.taskId)?.delivery?.headSha,
          actions: input.requiredActions,
        },
        !merges,
      );
      void this.sweepGates(this.now());
    }
    return id;
  }

  /**
   * A first mate merge card on a task with a saved story carries that story
   * (INF-2490, lifting INF-1364): the host binds the card's offer to the
   * published story, so its click passes the same gate a crewmate's
   * completion card does and the merge reads the same story. The offer names
   * no pull request, so the click approves no head and is one attempt.
   */
  private bindFirstmateOffer(taskId: string, cardId: string): void {
    const record = this.options.tasks.get(taskId);
    const ready = readyPresentation(record?.delivery?.presentation);
    const offerId = this.cards.get(cardId)?.offerId;
    const shownFor = record ? currentChange(record.delivery, record.branch).number : undefined;
    const head = ready?.head ?? record?.delivery?.headSha;
    if (!record || !offerId || !head || (!ready && shownFor === undefined)) return;
    this.keepOffer(taskId, record.delivery?.completionOffers ?? [], {
      cardId,
      offerId,
      headSha: head,
      // The change it was shown for (INF-2490): its click refuses once another is current.
      ...(shownFor === undefined ? {} : { shownFor }),
      ...(ready
        ? { presentationRevision: ready.revision, presentationContentHash: ready.contentHash }
        : {}),
      at: this.now(),
    });
  }

  /**
   * One card's completion offer (INF-2490), replacing that card's earlier
   * entry. The list keeps its four newest entries and the current offer of
   * every card still open, so an open card never loses the change it was
   * shown for, which its click is checked against.
   */
  private keepOffer(
    taskId: string,
    offers: readonly CompletionOffer[],
    offer: CompletionOffer,
  ): void {
    const all = [
      ...offers.filter((entry) => entry.cardId !== offer.cardId || entry.offerId !== offer.offerId),
      offer,
    ];
    this.options.tasks.delivery.recordPermissionRecords(taskId, {
      completionOffers: all.filter(
        (entry, index) =>
          index >= all.length - 4 || this.cards.get(entry.cardId)?.offerId === entry.offerId,
      ),
    });
  }

  declareStandaloneRequiredActions(input: EmittedCardInput, cardId: string): void {
    if (input.taskId || input.requiredActions === undefined) return;
    const source = this.options.tasks.capture.taskForCard(cardId);
    const card = this.cards.get(cardId);
    if (!source || !card?.offerId) throw new Error("Required actions have no source record.");
    this.options.tasks.delivery.declareRequiredActions(
      source.id,
      { cardId, offerId: card.offerId, actions: input.requiredActions },
      true,
    );
    void this.sweepGates(this.now());
  }

  /** An emitter withdraws its own card (close_card). */
  closeCard(
    cardId: string,
    actor: { kind: "firstmate" } | { kind: "crewmate"; taskId: string },
    reason?: string,
  ): string {
    const result = this.cards.close(cardId, actor, reason);
    // Withdrawal can leave a message without its answering offer. Re-read
    // coverage through the existing sweep, never a captain acknowledgement.
    this.hooks.asksMoved?.();
    return result;
  }

  /** Called only from the authenticated connection's fresh hello, not cached device reads. */
  observeRequiredActionDevice(
    deviceId: string,
    version: { app?: string; takesWork: boolean },
  ): void {
    if (!version.app || !version.takesWork) return;
    for (const record of this.options.tasks.listOpen()) {
      const action = record.delivery?.captainAction;
      if (!action || !this.options.tasks.delivery.captainActionReady(record.id)) continue;
      const matches = action.requirements.every(({ action: requirement }) => {
        const criterion = requirement.completion;
        if (criterion.kind !== "device-version" || criterion.deviceId !== deviceId) return false;
        const order = compareSemver(version.app as string, criterion.minVersion);
        return order !== null && order >= 0;
      });
      if (
        matches &&
        this.options.tasks.delivery.completeCaptainAction(record.id, action.generation, "checked")
      )
        this.cards.retireTaskCards(record.id, "answered");
    }
    void this.sweepGates(this.now());
  }

  flagDuplicate(input: { cardId: string; duplicateOf: string; note: string }): DuplicateResult {
    const card = this.cards.shown(input.cardId);
    const result = this.cards.flagDuplicate(input);
    // A duplicate closure notifies the live author, as an ordinary read
    // does, but without the ordinary-read acknowledgement (INF-759).
    if (result.status === "flagged" && card)
      this.tellCardClosed(card, { id: result.original.id, title: result.original.title });
    return result;
  }

  /**
   * The one router for crew lifecycle events: the event type is a property
   * of the call site, so sorting has always been code here. Since S7c
   * (captain call C7 A) there is no second reader behind it - a failed
   * turn, a quiet turn, the wall-clock bound, a start or start failure all
   * reach the Firstmate directly, which is exactly what this did whenever
   * the retired supervision session could not take them. A crewmate's
   * REPORT does not come through here: `sortReport` answers whose turn it
   * is first (`reportSort.ts`).
   */
  private routeCrewEvent(
    taskId: string,
    wake: TypedWake,
    origin: ServedWakeOrigin,
  ): number | null | void {
    return this.hooks.notifyOp(wake, origin, taskId);
  }

  /**
   * The live review task of a builder, if one is open (delivery rigor phase
   * 2). A repair assessment (FI3-663) is not its review.
   */
  private openReviewOf(builderId: string): TaskRecord | undefined {
    return this.options.tasks.graph
      .openChildren(builderId)
      .find(
        (record) =>
          !TaskService.isClosed(record) &&
          record.shape?.kind === "review" &&
          !isRepairAssessment(record.shape),
      );
  }

  /**
   * A builder's open review whose last verdict - recorded from that very
   * review - was findings or blocked, while no cap holds its re-reviews:
   * the builder's next report may bring the head it re-reviews.
   */
  private reviewToReread(builder: TaskRecord): WakeOpenReview | undefined {
    const verdict = builder.delivery?.reviewVerdict;
    if (verdict !== "findings" && verdict !== "blocked") return undefined;
    const open = this.openReviewOf(builder.id);
    if (!open || this.options.tasks.graph.verdictReviewOf(builder)?.id !== open.id)
      return undefined;
    const head = builder.delivery?.reviewSha;
    return {
      key: open.key || open.id,
      verdict,
      ...(head ? { head } : {}),
      ...(builder.delivery?.liveValidation
        ? {
            evidenceRevision: open.delivery?.validationAssignment?.revision ?? 0,
            currentEvidenceRevision: validationRevision(builder.delivery.liveValidation),
            stateRevision: open.delivery?.validationAssignment?.stateRevision ?? 0,
            currentStateRevision: validationStateRevision(builder.delivery.liveValidation),
          }
        : {}),
    };
  }

  /** The builder a review task reads: its parent, the one stored join. */
  private reviewBuilderOf(record: PlacementRecord | undefined): TaskRecord | undefined {
    if (record?.shape?.kind !== "review" || isRepairAssessment(record.shape) || !record.parentId)
      return undefined;
    return this.options.tasks.get(record.parentId);
  }

  /** Refresh only between review turns; never move a checkout under a running reviewer. */
  private async refreshReview(task: TaskRuntime): Promise<string | undefined> {
    const review = this.options.tasks.get(task.id);
    const builder = this.reviewBuilderOf(review);
    if (!review || !builder) return undefined;
    if ((review.deviceId ?? null) !== (builder.deviceId ?? null))
      throw new Error(
        "This review started on another computer. Close it and commission a new review on the builder's computer.",
      );
    // The first assignment is already prepared and briefed at commission.
    // Keep it through retries; only a later review turn takes a new head.
    if (review.delivery?.headSha && !review.outcome) return undefined;
    const facts = await this.reviews.reviewFacts(builder);
    this.options.tasks.delivery.recordChangeEvidence(review.id, {
      validationAssignment: validationAssignment(builder.delivery?.liveValidation, facts.headSha),
    });
    const previousHead = review.delivery?.headSha;
    if (!review.intent) throw new Error("The review has no recorded brief to refresh.");
    if (facts.headSha !== previousHead) {
      const base = {
        task: builder.id,
        headSha: facts.headSha,
        ...(previousHead ? { previousHead } : {}),
      };
      if (review.deviceId) {
        await this.options.machines?.prepare(review.deviceId, review.id, review.repoId, base);
      } else {
        task.workspace = await this.options.workspace.createTaskWorktree(
          review.id,
          review.repoDir,
          base,
        );
      }
      this.options.tasks.delivery.recordChangeEvidence(
        review.id,
        {
          headSha: facts.headSha,
          ...(facts.changeReading
            ? { reviewChange: facts.changeReading }
            : { reviewChange: undefined }),
        },
        {
          kind: "review",
          text: `review assigned at ${facts.headSha.slice(0, 7)}`,
          feed: false,
        },
      );
    }
    // The scope set at commission holds for every turn (INF-401).
    const passedHead = review.delivery?.passedHead;
    const brief = renderReviewBrief(
      review.intent,
      this.taskDelivery(builder.id) ?? "local-only",
      passedHead ? { ...facts, passedHead } : facts,
    );
    // Re-send the assignment even when the head stayed put: a previous
    // prompt may have failed after preparation but before the model read it.
    return brief;
  }

  /** Whether a task's events skip supervision: a review task itself. */
  private bypassesSupervision(taskId: string): boolean {
    return this.options.tasks.get(taskId)?.shape?.kind === "review";
  }

  /**
   * Where a task stands with its independent review, for crew_status and
   * the context block: the reviewer's own row names the builder; a builder
   * has a review open, a verdict short of a pass, or a pass. A care name
   * says nothing here: what each care asks is the care runbook's.
   */
  private reviewState(record: TaskRecord): string | undefined {
    const shape = record.shape;
    if (shape?.kind === "review" && record.parentId) {
      const builder = this.options.tasks.get(record.parentId);
      return isRepairAssessment(shape)
        ? `assesses ${builder?.key || record.parentId}'s repair`
        : `reviews ${builder?.key || record.parentId}`;
    }
    // A review happens at any care (INF-1875).
    const verdict = record.delivery?.reviewVerdict;
    if (verdict === "pass") return "review passed";
    const open = this.openReviewOf(record.id);
    if (open) return `review open (${open.key || open.id})`;
    return verdict ? `review: ${verdict}` : undefined;
  }

  /** The personal brief's workspace facts (Step 4): the directory and the surfaces that exist. */
  private personalFacts(ongoing?: boolean): PersonalBriefFacts | undefined {
    const personal = this.options.personal;
    if (!personal) return undefined;
    return { workspaceDir: personal.workspaceDir, surfaces: personal.surfaces(), ongoing };
  }

  /**
   * A task on the personal workspace: no worktree, the host commits, a
   * report closes it. The workspace's KIND says so since Task A of the
   * posture rationalization - it was a third delivery posture before, which
   * made `delivery` answer two questions at once.
   */
  private isPersonalTask(taskId: string): boolean {
    const repoId = this.options.tasks.get(taskId)?.repoId;
    if (!repoId) return false;
    return this.options.repos.get(repoId)?.kind === "personal";
  }

  /**
   * A task the host filed to work in place in its project's folder (INF-549,
   * `WorkShape.in_place`): no working copy, no delivery, no merge, and no
   * completion decision; the host closes it when the folder is up to date.
   */
  private worksInPlace(taskId: string): boolean {
    return this.options.tasks.get(taskId)?.shape?.in_place !== undefined;
  }

  /** The commit a branching task's working copy starts at, or undefined when it names none. */
  private async branchFromBase(
    record: TaskRecord | undefined,
    repoDir: string,
  ): Promise<DispatchBase | undefined> {
    const ref = record?.shape?.branch_from;
    if (!record || !ref) return undefined;
    const source = branchFromSource(this.options.tasks, ref, record.repoId, record.id);
    if ("refused" in source) throw new Error(source.refused);
    return this.options.workspace.baseAt(repoDir, source.ref);
  }

  /**
   * A queued row's tier, moved to the one its verdict now gives: a basis
   * that answered after the row was planned grounds it (R4/R6), and the
   * row's tier says so. A quiet write, like the kind stamp: it explains a
   * routing decision, it is not one.
   */
  private restampGroundedTier(taskId: string, shape: WorkShape): void {
    if (!shape.basis_verified) return;
    const record = this.options.tasks.get(taskId);
    const bucket = tierFor(shape).bucket ?? null;
    if (!record || record.difficulty === bucket) return;
    this.options.tasks.placement.recordShape(taskId, {}, bucket);
  }

  /**
   * Start (or dispatch) one task: worktree, routing, account, session,
   * first turn. Shared by immediate commissions and the ready sweep.
   */
  private async startTask(spec: {
    taskId: string;
    title: string;
    brief: string;
    repoId: string | null;
    routed: RouteResult | undefined;
    placementAccount?: string;
    /** A record born this instant (immediate commission) vs a dispatched queued row. */
    fresh: boolean;
    /** Pictures the brief carries beyond those the task's messages keep (`TaskIntake.commission`). */
    messageFiles?: readonly MessageFile[];
    attachments?: readonly AttachmentRef[];
  }): Promise<{ taskId: string; crewmate: string }> {
    const { taskId, title, brief } = spec;
    if (spec.repoId) await this.projectChange?.inspect(spec.repoId);
    const repoDir = spec.repoId ? this.options.repos.get(spec.repoId)?.path : undefined;
    if (spec.repoId && !repoDir) {
      throw new Error(`The repository for task ${taskId} is no longer registered.`);
    }
    if (this.tasks.has(taskId)) {
      throw new Error(`Task ${taskId} already has a running crewmate.`);
    }
    this.crewmateSeq += 1;
    const crewmate = `crewmate ${this.crewmateSeq}`;
    const record = this.options.tasks.get(taskId);
    if (record && TaskService.isClosed(record))
      throw new Error("The task closed before it could start.");
    const task: TaskRuntime = {
      id: taskId,
      title,
      key: record?.key || taskId,
      crewmate,
      currentTurnText: "",
      lastCompleteText: "",
      state: "starting",
      cancelled: false,
      interruptRequested: false,
      filedThisTurn: [],
      lastEventAt: this.now(),
      turnStartedAt: this.now(),
      quietLevel: 0,
      wallClockEscalated: false,
      inFlightInboxIds: [],
      steeredInboxIds: [],
      clientTasks: new Map(),
      openCalls: new Map(),
      unreadSteers: [],
      openReads: new OpenReads(this.now),
    };
    this.tasks.set(taskId, task);
    this.broadcastCrewCounts();

    // Create workspace and session before resolving, so a spawn failure
    // returns as a loud tool error instead of a phantom task.
    const live = this.isPersonalTask(taskId);
    const personal = live ? this.options.personal : undefined;
    const machine = this.machineOf(taskId);
    const placed = machine !== LOCAL_MACHINE_ID;
    // A folder repair (INF-549) works in its project's own folder, as the
    // personal workspace does, with none of that workspace's own rules.
    const inPlace = !live && !placed && this.worksInPlace(taskId);
    // On a computer that runs work, its working copy is there, made by that
    // computer from where the project lives (docs/helper.md, "Its working
    // copies"). This Mac makes none, so the runtime holds no workspace a
    // failed start could remove here.
    let cwd: string | undefined;
    let elsewhere: PlacedCopy | undefined;
    let minted: BriefPart[];
    let pictures: Awaited<ReturnType<CrewBrief["briefPictures"]>>;
    try {
      // Routing chose no model for a start on this Mac. With Dynamic routing
      // off, or with an account-less runtime that serves no model of its
      // own, a session opened anyway would fail as if a sign-in had lapsed.
      if (
        spec.routed &&
        !spec.routed.choice &&
        !placed &&
        (this.options.router?.dynamicEnabled?.() === false ||
          this.options.accountlessServes?.() === false)
      ) {
        throw new Error(
          "No signed-in model can take this task now. Check your accounts and their allowance in Settings → Intelligence.",
        );
      }
      // A task on a computer that runs work takes a model only that
      // computer's own subscriptions serve; with none, it does not start,
      // and nothing is made there for it.
      if (placed && spec.routed && !spec.routed.choice) {
        const who = this.options.machines?.placeOf(machine).who ?? "That computer";
        throw new Error(
          `${who} has no subscription of its own that can take this task now. Sign it in to one in Settings → Intelligence.`,
        );
      }
      if (placed) {
        const machines = this.options.machines;
        if (!machines?.folders(machine, taskId))
          throw new Error("The computer this task runs on is out of reach.");
        if (
          record &&
          opensPullRequest(this.taskDelivery(taskId)) &&
          deliverableOf(record) === "change" &&
          !machines.takesCheckDeclarations?.(machine)
        )
          throw new Error(
            `${machines.placeOf(machine).who ?? "That computer"} must be updated before it runs a change whose check and repair declarations it does not understand.`,
          );
        if (record?.shape?.result_schema && !machines.takesResults?.(machine))
          throw new Error(
            `${this.options.machines?.placeOf(machine).who ?? "That computer"} must be updated before it runs a task whose report carries a typed result.`,
          );
        if (record?.shape?.branch_from)
          throw new Error(
            `This task branches from ${record.shape.branch_from}, whose work is on this Mac, so it starts only on this Mac: set its Runs on to this Mac.`,
          );
        const builder = this.reviewBuilderOf(record);
        const headSha = builder ? record?.delivery?.headSha : undefined;
        this.options.tasks.placement.beginPlacementPreparation(taskId);
        elsewhere = await machines.prepare(
          machine,
          taskId,
          spec.repoId,
          builder && headSha ? { task: builder.id, headSha } : undefined,
        );
        cwd = elsewhere.cwd;
      } else if ((live || inPlace) && repoDir) {
        // The personal workspace (Step 4), or a folder repair: the crewmate
        // works in the repository itself. No worktree, no branch; the record's
        // workspace columns stay empty so no close ever tries to remove one.
        // Other work in the folder is refused while it is missing, as a task
        // needing it is below; only the repair bringing it back starts (INF-584).
        if (
          inPlace &&
          spec.repoId &&
          !isFolderRepair(record?.shape?.in_place) &&
          !existsSync(repoDir)
        ) {
          throw new Error(
            this.inPlaceWork.folderMissing(spec.repoId, "start", this.options.tasks.get(taskId)),
          );
        }
        const cwd = inPlace ? this.inPlaceWork.inPlaceDir(taskId, repoDir) : repoDir;
        task.workspace = { taskId, cwd, branch: "", repoDir };
      } else {
        // A task that needs the project's folder here is refused while it
        // is missing, naming it and the repair that brings it back (INF-572).
        if (spec.repoId && repoDir && !existsSync(repoDir)) {
          throw new Error(
            this.inPlaceWork.folderMissing(spec.repoId, "start", this.options.tasks.get(taskId)),
          );
        }
        const headSha = this.reviewBuilderOf(record) ? record?.delivery?.headSha : undefined;
        // A task that branches from another starts at that task's last commit (INF-799).
        const branchFrom =
          !headSha && repoDir ? await this.branchFromBase(record, repoDir) : undefined;
        this.options.tasks.placement.beginPlacementPreparation(taskId);
        task.workspace = await this.options.workspace.createTaskWorktree(
          taskId,
          repoDir,
          headSha ? { headSha } : branchFrom,
        );
      }
      cwd ??= task.workspace?.cwd ?? "";
      const routed = spec.routed;
      const routedModel = routed?.choice;
      // Never silently downgrade intelligence (P7): a task served from a
      // lesser bucket than it called for says so in the feed.
      if (routed?.servedBucket && isDowngrade(routed.bucket, routed.servedBucket)) {
        this.options.broadcastEvent({
          type: "firstmate_note",
          text: downgradeLine(title, routed.servedBucket, routed),
        });
      }
      // The account-selection step (broker phase 4): routing picked the
      // model; the selector picks which account of its provider serves it.
      // A task on a computer that runs work is served by that computer's
      // own account, which its binding names, never one of this Mac's.
      const accountId =
        routedModel && !placed
          ? this.options.accounts?.selectForSpawn(taskId, routedModel.provider, {
              model: routedModel.id,
            })
          : placed
            ? spec.placementAccount
            : undefined;
      if (
        routedModel &&
        !placed &&
        this.options.accounts &&
        !accountId &&
        this.options.router?.dynamicEnabled?.() === false
      ) {
        throw new Error(
          "No eligible account can serve the selected model now. Check your accounts and their allowance in Settings → Intelligence.",
        );
      }
      if (accountId) task.accountId = accountId;
      // Care must be stamped before opening the session: its first request
      // already carries the model's chosen effort.
      const rigor = this.briefs.deriveRigor(taskId);
      const servedLevel = routed?.servedBucket ?? routed?.bucket ?? "medium";
      // The captain's word on this task's effort outranks the model's
      // Settings choice, which outranks the level's default. Read as the
      // record stands now, as the requested speed is, never from the copy
      // taken before the working copy was prepared.
      const chosenReasoning = routedModel
        ? (this.options.tasks.get(taskId)?.shape?.override_reasoning ??
          this.options.router?.reasoningChoice?.(routedModel, servedLevel))
        : undefined;
      const session = await this.openCrewmate(
        task,
        {
          taskId,
          machineId: machine,
          ...(rigor === "quick" && !chosenReasoning ? { quick: true } : {}),
          cwd,
          ...(routedModel ? { model: routedModel } : {}),
          ...(routedModel
            ? {
                thinkingLevel: chosenReasoning ?? levelDefaultReasoning(servedLevel),
              }
            : {}),
          ...this.crewmateHooks(task, personal),
        },
        accountId,
      );
      task.session = session;
      // The record's dispatch facts, once the crewmate really exists: the
      // model the session runs on outranks the routing choice it came from.
      this.options.tasks.starts.dispatch(taskId, {
        workspace: {
          // A task with no project elsewhere merges into this Mac's default workspace.
          repoDir:
            task.workspace?.repoDir ??
            repoDir ??
            (elsewhere ? await this.options.workspace.ensureDefaultRepo() : ""),
          worktreeDir: live || inPlace || !task.workspace ? "" : task.workspace.cwd,
          branch: task.workspace?.branch ?? elsewhere?.branch ?? "",
          ...(elsewhere ? { elsewhere: true } : {}),
        },
        accountId: accountId ?? null,
        assignee: crewmate,
        model: session.modelRef() ?? routedModel,
        reasoning: session.reasoning(),
      });
      this.recordCrewSession(task, session, task.conversationBegan ?? "start");
      // Right after `dispatched`, so the timeline reads in a fixed order:
      // where the working copy came from and the commit it starts at.
      const acquired = task.workspace?.acquired ?? elsewhere?.acquired;
      if (acquired) {
        const where = elsewhere ? this.options.machines?.nameOf(machine) : undefined;
        this.options.tasks.note(taskId, worktreeText(acquired, where), {
          news: false,
          data: {
            worktree: acquired.source,
            ms: acquired.ms,
            base: {
              ref: acquired.base.ref,
              sha: acquired.base.sha,
              fetch: acquired.base.fetch,
              ...(acquired.base.fetchError ? { fetchError: acquired.base.fetchError } : {}),
            },
          },
        });
      }
      task.unsubscribe = await this.follow(task, session);
      // From here every save in the workspace carries the task (the
      // running dot), until the task closes.
      pictures = await this.briefs.briefPictures(
        taskId,
        spec.attachments ?? [],
        spec.messageFiles ?? [],
      );
      minted = await this.briefs.mintBrief(taskId, brief, spec.repoId, pictures.section);
      if (this.tasks.get(taskId) !== task)
        throw new Error("The task closed while its source work was being copied.");
      personal?.beginLiveTask(taskId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (
        record?.placement &&
        caught instanceof PreparationUnknown &&
        this.tasks.get(taskId) === task
      ) {
        // A missing reply proves neither success nor failure. Keep the choice,
        // order and demand; the next attempt reconciles this same preparation.
        this.tasks.delete(taskId);
        this.options.tasks.starts.releaseUnconfirmedStart(taskId);
        this.options.tasks.starts.markStartChecking(taskId);
        this.placement.sayAutomaticWait(this.options.tasks.get(taskId) ?? record);
        return { taskId, crewmate: "queued" };
      }
      if (
        record?.placement &&
        (!placed || elsewhere || !this.options.tasks.get(taskId)?.placement?.preparationStarted)
      )
        this.options.tasks.placement.releasePlacement(
          taskId,
          record.placement.snapshot.orderId,
          "ended",
        );
      if (caught instanceof ForgeAuthRequiredError && this.tasks.get(taskId) === task) {
        await task.unsubscribe?.();
        task.session?.dispose();
        this.tasks.delete(taskId);
        this.cards.deleteRowsForTask(taskId);
        if (task.workspace) {
          await this.options.workspace.removeTaskWorktree(task.workspace).catch(() => {});
        }
        if (!spec.fresh) throw caught;
        if (placed) {
          // The computer's own clone was refused for want of its own sign-in
          // there: the task waits for that sign-in, never this Mac's.
          this.placement.holdForDeviceForge(taskId, machine, caught.host);
          const waiting = this.options.tasks.get(taskId);
          if (waiting)
            this.placement.sayPlacedWait(this.placement.waitSubject(waiting), machine, {
              kind: "forge",
              host: caught.host,
            });
          this.cards.scheduleBroadcast();
          this.broadcastCrewCounts();
          return { taskId, crewmate: "queued" };
        }
        this.options.tasks.starts.requeue(
          taskId,
          {
            kind: "captain",
            ref: `forge-sign-in:${caught.host}`,
            reason: `waiting for ${caught.place} sign-in`,
          },
          `waiting for ${caught.place} sign-in before starting`,
        );
        this.cards.addForgeSignInCard(
          forgeSignInCardId(caught.host),
          caught.host,
          caught.place,
          0,
          { reauth: false },
        );
        this.cards.scheduleBroadcast();
        this.broadcastCrewCounts();
        return { taskId, crewmate: "queued" };
      }
      if (this.tasks.get(taskId) !== task) {
        throw new Error(`Could not commission a crewmate: ${message}`);
      }
      if (!spec.fresh) {
        // A failed dispatch returns the row to the queue behind a captain
        // gate - never deleted, never hot-retried by the sweep. Do not
        // requeue or delete when this attempt does not own the runtime.
        await task.unsubscribe?.();
        task.session?.dispose();
        this.tasks.delete(taskId);
        this.cards.deleteRowsForTask(taskId);
        if (task.workspace) {
          await this.options.workspace.removeTaskWorktree(task.workspace).catch(() => {});
        }
        this.options.tasks.starts.requeue(
          taskId,
          { kind: "captain", ref: "dispatch-failed", reason: message },
          `could not start: ${message}`,
        );
        this.cards.scheduleBroadcast();
        this.broadcastCrewCounts();
      } else {
        await this.cleanupFailedSpawn(task);
      }
      throw new Error(`Could not commission a crewmate: ${message}`);
    }
    this.options.broadcastEvent({
      type: "task_started",
      taskId,
      title,
      machineId: machine,
      crewmate,
    });
    this.broadcastCrewCounts();
    // The brief rides the durable inbox as the task's first row (captain
    // refinement on review): the first turn gets the same retry ladder and
    // boot re-presentation as every later steer. Queued rows keep their
    // brief in tasks.prompt while gated; this row is minted only here, at
    // dispatch, so nothing is bookkept twice. Active repo notes append
    // here, origin-labeled (stage 0 / Q5).
    // The captain's pictures ride the row by reference, so a retried or
    // re-presented first turn still carries them (docs/inbox.md).
    const briefRowId = this.options.inbox.enqueue(
      taskId,
      pictures.riding.length > 0
        ? withAttachmentsKept(briefText(minted), pictures.riding)
        : briefText(minted),
    );
    this.options.inbox.markDelivered([briefRowId]);
    void this.prepareFirstTurn(task, minted, [briefRowId], pictures.images);
    return { taskId, crewmate };
  }

  /**
   * Open a crewmate's session: its account's binding, the crewmate preset on
   * it, and the factory of that binding's backend. A recorded conversation
   * its backend cannot reopen (a token of another backend's shape) starts
   * fresh, and the task's timeline says so. `servedModel` is the model a
   * resumed conversation's record names ("provider/id"), so a task on
   * another computer binds the account there that served it at its start.
   * `movedTo` names the provider a moved task now runs on (INF-849): a
   * conversation that provider's client cannot reopen restarts as moved.
   */
  private async openCrewmate(
    task: TaskRuntime,
    crewmate: CrewmateSpec,
    accountId: string | undefined,
    servedModel?: string,
    movedTo?: string,
  ): Promise<ModelSession> {
    const binding =
      crewmate.machineId === LOCAL_MACHINE_ID
        ? await this.options.bind(accountId, crewmate.model?.provider)
        : await this.placement.placedBinding(
            crewmate.machineId,
            crewmate.model?.provider ?? this.options.router?.servedProvider(task.id),
            accountId,
            crewmate.model ?? (servedModel ? parseOfferingKey(servedModel) : undefined),
          );
    const factories =
      crewmate.machineId === LOCAL_MACHINE_ID
        ? this.options.sessions
        : this.options.machines?.factories(crewmate.machineId);
    if (!factories) throw new Error("This task runs on another computer this app cannot reach.");
    const factory = factories[binding.backend];
    if (!factory) {
      throw new Error(`No backend is registered to serve account "${accountId ?? ""}".`);
    }
    // Provision before the prompt is served, so a new folder is the app's.
    // A temp directory that already holds files is left on the old policy.
    if (crewmate.machineId === LOCAL_MACHINE_ID) {
      provisionTaskTemp(join(this.options.paths.crewmatesDir, task.id));
    }
    const briefed = {
      ...crewmate,
      ...(this.options.source ? { source: await this.options.source() } : {}),
      procedure: crewmateProcedureFor(
        this.options.tasks.policiesOf(this.options.tasks.get(task.id)),
      ),
      // Every crewmate is told the captain's computers and which one it runs on (INF-992).
      ...this.placement.computersFor(crewmate.machineId),
      // Its app reads here are answerable by the quiet check; there, that computer keeps its own.
      ...(crewmate.machineId === LOCAL_MACHINE_ID ? { openReads: task.openReads } : {}),
    };
    task.backend = binding.backend;
    let runbookSkills: SessionSpec["runbookSkills"];
    if (this.options.runbooks) {
      const served = this.options.runbooks.crew(
        this.briefs.runbookFacts(task.id, briefed.procedure, binding.backend),
      );
      Object.assign(briefed, {
        runbookText: crewRunbookText(served),
      });
      runbookSkills = served.skills;
    }
    const spec = this.options.sessionSpec
      ? this.options.sessionSpec(briefed, binding)
      : crewmateSessionSpec(this.options.paths, briefed, binding);
    if (
      spec.speed &&
      (binding.backend === "claude" || (spec.model && spec.model.provider !== "openai-codex"))
    ) {
      const model = spec.model ?? { provider: "anthropic-claude", id: "This model" };
      const requested = await spec.speed.requested(model);
      if (requested !== "standard")
        spec.speed.record(model, {
          requested,
          sent: "standard",
          reason: "this model and account do not offer Codex crew speeds",
        });
      delete spec.speed;
    }
    spec.personalResources = this.options.personalResourcesEnabled?.() === true;
    if (runbookSkills) spec.runbookSkills = runbookSkills;
    if (this.disposed) throw new Error("This computer is stopping.");
    const session = await factory.open(spec);
    const unopenable =
      Boolean(crewmate.resumeToken) && spec.shape.turns === "rolling" && !spec.shape.record.resume;
    if (unopenable) {
      this.options.tasks.note(
        task.id,
        movedTo
          ? `it moved to a new conversation on ${movedTo}, which cannot reopen its earlier one; the earlier one is kept`
          : "its earlier conversation could not be reopened, so it starts a fresh one",
        { news: true },
      );
    }
    this.carryRestart(
      task,
      crewmate.machineId,
      session,
      unopenable ? crewmate.resumeToken : undefined,
      movedTo,
    );
    return session;
  }

  /** One association writer for starts, replacements, moves and completed turns. */
  private recordCrewSession(
    task: TaskRuntime,
    session: ModelSession,
    began: string,
    machine = this.machineOf(task.id),
  ): void {
    task.conversationBegan = began;
    const token = crewmateResumeToken(session.resume());
    if (!token) return;
    const folders =
      machine === LOCAL_MACHINE_ID
        ? { sessions: crewmateSessionsDir(this.options.paths, task.id) }
        : this.options.machines?.folders(machine, task.id);
    // A Claude token is not a path. Its durable copy belongs to the computer
    // running the session, not to this computer's copy of the transcript.
    const file = isAbsolute(token)
      ? token
      : folders
        ? join(folders.sessions, `${token}.jsonl`)
        : undefined;
    if (!file) return;
    const model = session.modelRef();
    this.options.tasks.turns.setSessionFile(task.id, token, {
      file,
      computer:
        machine === LOCAL_MACHINE_ID
          ? HOME.the
          : (this.options.machines?.nameOf(machine) ?? `another ${COMPUTER.one}`),
      device_id: machine,
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      account_id: task.accountId ?? null,
      began,
    });
  }

  /**
   * A conversation that replaced the task's earlier one: a Claude
   * conversation resumed under changed instructions renews as it opens -
   * here, or on its computer again after that computer restarted
   * (`placedReopened`) - or the earlier one, `unopenable`, could not be
   * reopened. A renewal is noted, and the record names the one it moved to
   * now, so a quit before its first turn ends does not reopen the earlier
   * one again; either way the lane keeps why, and the next turn serves it.
   */
  private carryRestart(
    task: TaskRuntime,
    machine: string,
    session: ModelSession,
    unopenable?: string,
    movedTo?: string,
  ): void {
    const renewal = session.takeRenewal();
    if (renewal) {
      this.options.tasks.note(task.id, crewmateRenewedNote(renewal), {
        news: false,
        data: { conversation: { from: renewal.from, changed: [...renewal.changed] } },
      });
    }
    const restart: CrewmateRestart | undefined =
      renewal ??
      (unopenable
        ? movedTo
          ? { from: unopenable, changed: "moved", to: movedTo }
          : { from: unopenable, changed: "unopenable" }
        : undefined);
    if (restart) {
      this.recordCrewSession(
        task,
        session,
        renewal ? "renewal" : movedTo ? "move" : "unopenable",
        machine,
      );
      this.recordRestart(task, machine, restart);
    }
  }

  /**
   * What a crewmate whose conversation replaced its task's earlier one is
   * told first, queued once on its lane: the brief its first turn served,
   * read back off the record, and where its earlier conversation's
   * transcript is saved on the computer it runs on. The turn that brings it
   * back serves the wake first, and a quit before that turn ends clean
   * still has the row.
   */
  private recordRestart(task: TaskRuntime, machine: string, restart: CrewmateRestart): void {
    const briefed = this.options.tasks
      .timeline(task.id)
      .filter((event) => event.kind === "briefed")
      .at(-1);
    const brief = briefed ? this.options.tasks.servedBrief(briefed) : undefined;
    // A Pi conversation's token is its file; a Claude one's names the
    // app's copy in the task's sessions folder.
    const named = (dir: string) =>
      isAbsolute(restart.from) ? restart.from : join(dir, `${restart.from}.jsonl`);
    let earlier: string | undefined;
    if (machine === LOCAL_MACHINE_ID) {
      const path = named(crewmateSessionsDir(this.options.paths, task.id));
      if (existsSync(path)) earlier = path;
    } else {
      const folders = this.options.machines?.folders(machine, task.id);
      if (folders) earlier = named(folders.sessions);
    }
    this.options.inbox.enqueueWake(
      task.id,
      conversationRestartWake({
        restart,
        taskKey: task.key,
        ...(brief ? { brief } : {}),
        ...(earlier ? { earlier } : {}),
      }),
      "agent",
      task.id,
    );
  }

  /**
   * A renewed conversation's reason still waiting on the lane, claimed for
   * the turn about to start so it rides that turn and a clean end acks it.
   */
  private claimConversationRestart(taskId: string, already: readonly number[]): InboxRow[] {
    const claimed = new Set(already);
    const leading = this.options.inbox
      .pending(taskId, this.now(), { maxAttempts: INBOX_ATTEMPT_MAX })
      .filter((row) => row.facts?.kind === "conversation-restart" && !claimed.has(row.id));
    if (leading.length === 0) return [];
    this.options.inbox.markDelivered(leading.map((row) => row.id));
    return leading;
  }

  /** What a crewmate's tools run on: this task's callbacks into the host. */
  private crewmateHooks(
    task: TaskRuntime,
    personal: PersonalLiveDelegate | undefined,
  ): Omit<CrewmateSpec, "taskId" | "machineId" | "cwd"> {
    // On a computer that runs work, its tools write where they run: the
    // crewmate is told that computer's folders.
    const machine = this.machineOf(task.id);
    const there =
      machine === LOCAL_MACHINE_ID ? undefined : this.options.machines?.folders(machine, task.id);
    return {
      onSpeed: (model, selection) => this.noteSpeed(task.id, model, selection),
      requestedSpeed: (model) =>
        this.options.tasks.get(task.id)?.shape?.override_speed ??
        this.options.crewSpeed?.(model) ??
        "standard",
      picturesDir: there?.cards ?? crewmateCardPicturesDir(this.options.paths, task.id),
      cardBodiesDir: there?.cardBodies ?? crewmateCardBodiesDir(this.options.paths, task.id),
      evidenceDir: there?.evidence ?? crewmateEvidenceDir(this.options.paths, task.id),
      tempDir: there?.temp ?? crewmateTempDir(this.options.paths, task.id),
      // A task on another computer keeps its reported files there and sends them home.
      ...(machine === LOCAL_MACHINE_ID
        ? { handoverDir: crewmateHandoverDir(this.options.paths, task.id) }
        : {}),
      // A task held on another computer checks its recordings and fonts where it runs.
      ...(machine === LOCAL_MACHINE_ID && this.options.probeMedia
        ? { probeMedia: this.options.probeMedia }
        : {}),
      ...(machine === LOCAL_MACHINE_ID && this.options.probeTypeface
        ? { probeTypeface: this.options.probeTypeface }
        : {}),
      onCard: (card) => this.crewmateCards.crewmateCardWrite(task, card),
      onCardRefused: (refusal) => this.crewmateCards.recordCardRefusal(task, refusal),
      onCloseCard: (input) =>
        this.closeCard(input.cardId, { kind: "crewmate", taskId: task.id }, input.reason),
      onFollowup: (input) => this.reportIntake.fileFollowup(task, input),
      onProgress: (text, plan) => this.reportIntake.noteProgress(task, text, plan),
      onReport: (text, summary, declared) =>
        this.recordReportFromSession(task, text, summary, declared),
      onReply: (input) => this.cards.replyFromCrewmate(task.id, input),
      onReviseRequiredAction: (input) =>
        cardMutationText(
          this.cards.reviseRequiredAction({ actor: "crewmate", taskId: task.id }, input),
        ),
      onReadCard: (cardId) => this.crewmateCards.readCard(cardId),
      onQueryTasks: (input) => this.queryTasks(input),
      ...this.knowledgeHooks(task, machine),
      ...this.panelToolHooks(task, personal),
      ...this.forgeToolHooks(task),
      ...this.taskCommandHooks(task, machine),
    };
  }

  /**
   * The task's commands in its crewmate's shell: its integrations, through
   * `infinitary-integrations-axi` (docs/integrations.md), and the task's own
   * browser, through `infinitary-browser-axi` (docs/axi-commands.md). They
   * run on the computer the task runs on, beside that shell: on this Mac
   * through this Mac's task channel, and on a computer that runs work
   * through that computer's own, where its roster says it keeps browsers
   * (docs/task-browser.md, "On another computer"). The browser there is that
   * computer's own; the integrations stay this Mac's, and that computer asks
   * this Mac each call where it lists the change for it ("On a computer that
   * runs work"). With no channel, or a computer that keeps none, there is no
   * way to reach either.
   */
  private taskCommandHooks(
    task: TaskRuntime,
    machine: string,
  ): Pick<CrewmateSpec, "browser" | "shell" | "integrations" | "load"> {
    const { browsers, taskCommands, integrations, machines, load } = this.options;
    const hasLoad = load?.available(machine) === true;
    if (machine !== LOCAL_MACHINE_ID) {
      // Its shell there is granted the commands; this Mac reads its browser
      // for the captain and answers its integrations' calls.
      return {
        ...(hasLoad ? { load: true } : {}),
        ...(browsers && machines?.keepsBrowsers?.(machine)
          ? { browser: browsers.forTask(task.id) }
          : {}),
        ...(integrations && machines?.takesIntegrations?.(machine)
          ? { integrations: integrations.forTask(task.id) }
          : {}),
      };
    }
    if (!taskCommands) return {};
    const browser = browsers?.forTask(task.id);
    // Every crewmate here reaches the integrations (docs/integrations.md).
    const reach = integrations?.forTask(task.id);
    if (!browser && !reach && !hasLoad) return {};
    return {
      ...(hasLoad ? { load: true } : {}),
      ...(browser ? { browser } : {}),
      ...(reach ? { integrations: reach } : {}),
      shell: taskCommands.grant(task.id, {
        ...(hasLoad && load ? { load: load.forTask(task.id) } : {}),
        ...(browser ? { browser } : {}),
        ...(reach ? { integrations: reach } : {}),
      }),
    };
  }

  /**
   * The knowledge pair for every crewmate (docs/knowledge.md, "Who has it"), read and written
   * here, in this Mac's knowledge, whatever computer the task runs on. A
   * computer that runs work forwards each call here once it speaks
   * `KNOWLEDGE_THERE_SINCE`. Its working copy there is no folder of this
   * Mac's, so a kept source is checked where a reader with none checks it.
   */
  private knowledgeHooks(task: TaskRuntime, machine: string): Pick<CrewmateSpec, "knowledge"> {
    const knowledge = this.knowledgeFor(task.id, machine);
    const record = this.options.tasks.get(task.id);
    const repoId = record?.repoId;
    if (!knowledge) return {};
    const cwd = machine === LOCAL_MACHINE_ID ? task.workspace?.cwd : undefined;
    return {
      knowledge: knowledgeBinding(knowledge, () => ({
        kind: "crewmate",
        taskId: task.id,
        repoId: repoId ?? "",
        ...(cwd ? { cwd } : {}),
      })),
    };
  }

  /**
   * This Mac's knowledge, for a crewmate whose task runs on `machine`: on
   * this Mac, or a computer that forwards the knowledge pair here. Absent
   * when no service was provided, or for a computer on an older contract.
   */
  private knowledgeFor(taskId: string, machine = this.machineOf(taskId)) {
    if (machine === LOCAL_MACHINE_ID || this.options.machines?.takesKnowledge?.(machine))
      return this.options.knowledge;
    return undefined;
  }

  /**
   * A crewmate's session events: a continuation the backend began on its
   * own gets the same host-owned turn boundary a prompt has, the owner-only
   * events stop here, and every other event is the task's activity and
   * reaches the feed.
   */
  private async follow(task: TaskRuntime, session: ModelSession): Promise<() => Promise<void>> {
    task.clientJobs = undefined;
    task.clientJobsSince = undefined;
    task.clientJob = undefined;
    task.clientTasks.clear();
    const unsubscribe = await followCompletions(
      session,
      (event) => {
        if (event.type === "tool_observation") {
          this.options.tasks.observeTool(task.id, event, (notice) => {
            const queued = this.routeCrewEvent(
              task.id,
              {
                once: notice.identity,
                facts: {
                  kind: "possible-repetition",
                  task: { id: task.id, title: task.title },
                  notice,
                  usage: this.options.latestUsage?.(task.id) ?? null,
                },
              },
              "agent",
            );
            if (queued === undefined) throw new Error("The first mate inbox is not attached yet");
          });
          return;
        }
        if (
          !task.paused &&
          (event.type === "input_read" ||
            event.type === "request_started" ||
            event.type === "continuation_started")
        )
          this.restarts.recordRestartOutcome(task.id, "resumed");
        if (event.type === "turn_failed" && !task.paused)
          this.restarts.recordRestartOutcome(task.id, "stopped", event.error);
        // A steer is read once its session says so, or once a model request
        // begins after it was handed over (INF-2603).
        if (event.type === "input_read") {
          const at = task.unreadSteers.findIndex((steer) => steer.sha === event.textSha256);
          if (at >= 0) task.unreadSteers.splice(at, 1);
        } else if (event.type === "request_started") task.unreadSteers = [];
        if (event.type === "background_work_changed") {
          task.clientJobs = event.count;
          task.clientJobsSince =
            (event.count ?? 0) > 0 ? (task.clientJobsSince ?? this.now()) : undefined;
          task.clientJob = (event.count ?? 0) > 0 ? event.job : undefined;
          if (event.count === undefined) this.clientEnded(task);
          else if (event.tasks) this.keepClientTasks(task, event.tasks);
          this.broadcastCrewCounts();
          return;
        }
        if (event.type === "continuation_started") {
          this.startAutonomousTurn(task, laneRowsOf(event.order));
          return;
        }
        if (event.type === "continuation_ended") {
          this.endAutonomousTurn(task, event.error, event.cutOff, event.unheard);
          return;
        }
        if (event.type === "model_served") {
          this.recordServedModel(task, event);
          return;
        }
        if (event.type === "turn_closed") {
          // A turn's closing words, as its session read them, are its report
          // candidate (WI-1), and a turn that closed on none leaves none. Pi
          // ends a turn per model message, so they match what it streamed;
          // Claude ends one per prompt and closes on the client's final
          // assistant text, so the text its earlier messages streamed ahead
          // of their tool calls - a self-brief, a note to itself - never
          // stands in for a report.
          task.turnReport = event.text?.trim() ? event.text : undefined;
          return;
        }
        // A turn its computer's update cut is paused, never failed: its end
        // carries it on (`turnComplete`), and the feed says no failure.
        if (event.type === "turn_failed" && task.paused) {
          task.lastTurnError ??= event.error;
          return;
        }
        if (!isBroadcastEvent(event)) return;
        this.noteTaskActivity(task);
        this.applyEvent(task, event);
        this.options.broadcastEvent(enrichEvent(task, event));
      },
      this.now,
      this.machineOf(task.id) === LOCAL_MACHINE_ID,
      join(this.options.paths.crewmatesDir, task.id, "completions.sqlite"),
    );
    if (this.tasks.get(task.id) !== task || task.cancelled) {
      await unsubscribe();
      throw new Error("The task closed while its transcript was being located.");
    }
    return unsubscribe;
  }

  /**
   * The background tasks this Mac's Claude client names for the crewmate
   * now, each keeping when it was first seen. A conversation on another
   * computer names none here: that computer keeps and tells its own
   * (`SessionHost`).
   */
  private keepClientTasks(task: TaskRuntime, named: readonly ClientBackgroundTask[]): void {
    const kept: TaskRuntime["clientTasks"] = new Map();
    for (const { id, description } of named)
      kept.set(id, { description, since: task.clientTasks.get(id)?.since ?? this.now() });
    task.clientTasks = kept;
  }

  /**
   * The crewmate's Claude client ended while this Mac ran on, and the
   * background tasks it still ran ended with it: each becomes the
   * crewmate's `[job]` turn, once, so it never waits on them. A task being
   * stopped has nobody waiting.
   */
  private clientEnded(task: TaskRuntime): void {
    if (!task.cancelled)
      for (const [id, run] of task.clientTasks)
        this.deliverJobResult(task.id, this.clientTaskEnd(task, id, run, "client"));
    task.clientTasks.clear();
  }

  /** A Claude client's background task that ended with it, as the crewmate's `job-exit` wake. */
  private clientTaskEnd(
    task: TaskRuntime,
    id: string,
    run: { description: string; since: number },
    interrupted: "client" | "quit",
  ): WakeBody {
    return jobExitWake(
      {
        jobId: id,
        ownerId: task.id,
        command: run.description,
        exitCode: null,
        durationMs: Math.max(0, this.now() - run.since),
        tail: "",
        interrupted,
      },
      "crewmate",
    );
  }

  /**
   * The crewmate's pair where the project lives (git integration PR 1.2):
   * every crewmate whose task ships a change, whatever the posture today -
   * a posture can change mid-task, and the tools answer for the posture at
   * the call. Read-only workflow evidence and the API pair also belong on
   * answer tasks, whose every write asks the captain; the delivery pair
   * does not. None belong on the personal workspace.
   */
  private forgeToolHooks(
    task: TaskRuntime,
  ): Pick<
    CrewmateSpec,
    | "onPrepareChange"
    | "onOpenChange"
    | "onCheckChange"
    | "onReadWorkflow"
    | "onDownloadArtifact"
    | "onGithubRead"
    | "onGithubWrite"
  > {
    if (this.isPersonalTask(task.id)) return {};
    // A task that works in place ships nothing; the one that closes a pull
    // request an abandoned task left open reads and writes where the project
    // lives, and nothing else (INF-549's sibling).
    if (
      this.worksInPlace(task.id) &&
      deliverableOf(this.options.tasks.get(task.id)) !== "operation"
    ) {
      if (!isPullRepair(this.options.tasks.get(task.id)?.shape?.in_place)) return {};
      const { githubRead, githubWrite } = this.options;
      return {
        ...(githubRead
          ? { onGithubRead: (input: GithubReadInput) => githubRead(task.id, input) }
          : {}),
        ...(githubWrite
          ? { onGithubWrite: (input: GithubWriteInput) => githubWrite(task.id, input) }
          : {}),
      };
    }
    const {
      prepareChange,
      openChange,
      checkChange,
      readWorkflow,
      downloadArtifact,
      githubRead,
      githubWrite,
    } = this.options;
    const machine = this.machineOf(task.id);
    const canPrepare =
      machine === LOCAL_MACHINE_ID || this.options.machines?.takesChangePresentations?.(machine);
    return {
      ...(openChange && checkChange && deliverableOf(this.options.tasks.get(task.id)) === "change"
        ? {
            ...(prepareChange && canPrepare
              ? {
                  onPrepareChange: (
                    input: import("@shared/changePresentation").StagedChangePresentation,
                  ) => prepareChange(task.id, input),
                }
              : {}),
            onOpenChange: (input: import("@shared/changePresentation").OpenChangeInput) =>
              openChange(task.id, input),
            onCheckChange: (input?: CheckChangeInput) => checkChange(task.id, input),
          }
        : {}),
      // An operation reads and reruns workflow runs with no pull request: its
      // check_change records the diagnosis and reserves the rerun (INF-2146).
      ...(deliverableOf(this.options.tasks.get(task.id)) === "operation"
        ? {
            onCheckChange: async (input?: CheckChangeInput) =>
              declareRunCheck(this.options.tasks, task.id, input ?? {}, this.now()),
          }
        : {}),
      ...(readWorkflow
        ? { onReadWorkflow: (input: ReadWorkflowInput) => readWorkflow(task.id, input) }
        : {}),
      ...(downloadArtifact
        ? { onDownloadArtifact: (input: DownloadArtifactInput) => downloadArtifact(task.id, input) }
        : {}),
      ...(githubRead
        ? { onGithubRead: (input: GithubReadInput) => githubRead(task.id, input) }
        : {}),
      // A task that only answers writes too: all but a run start or rerun on its own project asks the captain (FI3-1571, INF-729).
      ...(githubWrite
        ? { onGithubWrite: (input: GithubWriteInput) => githubWrite(task.id, input) }
        : {}),
    };
  }

  /**
   * The live-build checks a crewmate on the personal workspace gets (Step 4):
   * absent on every other posture, so the tools never appear where there is
   * no panel to check.
   */
  private panelToolHooks(
    task: TaskRuntime,
    personal: PersonalLiveDelegate | undefined,
  ): Pick<CrewmateSpec, "onLintPanel" | "onPlacePanel" | "onCapturePanel"> {
    if (!personal) return {};
    return {
      onLintPanel: (input) => personal.lint(input),
      onPlacePanel: (input) => this.placePanel(task, personal, input.id),
      onCapturePanel: (input) => personal.capture({ id: input.id, taskId: task.id }),
    };
  }

  /**
   * `place_panel` for a crewmate on the personal workspace: its version goes
   * on the captain's rail, and the window's answer lands on the task's
   * timeline (never the feed) beside going back to the crewmate, so the
   * record shows what the captain's rail held before the report.
   */
  private async placePanel(
    task: TaskRuntime,
    personal: PersonalLiveDelegate,
    id: string | undefined,
  ): Promise<PanelPlaceResult> {
    const result = await personal.place({ taskId: task.id, ...(id ? { id } : {}) });
    if (result.ok && this.options.tasks.get(task.id)) {
      this.options.tasks.note(task.id, `placed on the rail: ${renderPlaceText(result)}`, {
        news: false,
        data: { placed: result.panels },
      });
    }
    return result;
  }

  /**
   * A commissioned worktree can build before the crewmate's first turn
   * (interaction P0, WI-7): dependencies install from the shared pnpm store,
   * recorded on the task's timeline. It runs behind commission's return so
   * spawn_crewmate still answers at once; a steer that arrives meanwhile is
   * recorded on the lane like any mid-start steer. A failed install is a
   * timeline fact, never a failed task - the crewmate can still run it.
   */
  private async prepareFirstTurn(
    task: TaskRuntime,
    brief: readonly BriefPart[],
    inboxIds: number[],
    images?: TurnImage[],
  ): Promise<void> {
    const cwd = task.workspace?.cwd;
    const machine = this.machineOf(task.id);
    // On a computer that runs work, that computer installs its own copy's.
    const installing =
      machine !== LOCAL_MACHINE_ID
        ? this.options.machines?.install(machine, task.id)
        : cwd
          ? this.options.workspace.installDependencies(cwd)
          : undefined;
    if (installing) {
      const install = await installing.catch(
        (caught): DependencyInstall => ({
          outcome: "failed",
          ms: 0,
          error: caught instanceof Error ? caught.message : String(caught),
        }),
      );
      if (install.outcome !== "skipped" && this.options.tasks.get(task.id)) {
        // A failed install is news: the crewmate's first turn runs without it.
        this.options.tasks.note(task.id, installText(install), {
          news: install.outcome === "failed",
          data: {
            install: install.outcome,
            ms: install.ms,
            ...(install.outcome === "failed" ? { error: install.error } : {}),
          },
        });
      }
    }
    // Settled while installing: the close already retired the runtime and
    // the brief row. Cancelled while installing: no turn is running to end,
    // so the cancel finishes here.
    if (this.tasks.get(task.id) !== task) return;
    if (task.cancelled) {
      this.finish(task, "cancelled");
      return;
    }
    this.options.tasks.recordBrief(task.id, brief);
    await this.runTurn(task, briefText(brief), inboxIds, images);
  }

  /**
   * Whether this task's green work may be merged without the captain: its
   * own ask, else the repository's standing flag (`autonomyFor`). The one
   * reader for the settle refusal, `crew_status` and the fact strip, so
   * none of the three can disagree with another.
   */
  /**
   * Whether a story note stays off the stack until its task's merge has a
   * result (INF-2533): a task that merges on its own, open, with a saved
   * story, whose change has not merged (`merging`: is merging now).
   */
  private holdsUntilMerge(card: Card, merging: boolean): boolean {
    if (!card.taskId || !isStoryNote(card)) return false;
    const record = this.options.tasks.get(card.taskId);
    if (!record || TaskService.isClosed(record) || !record.delivery?.presentation) return false;
    if (!this.taskAutonomy(record.id)) return false;
    if (merging) return true;
    return (
      record.delivery.ci !== "merged" &&
      this.options.tasks.changeFor(record.id)?.receipt?.outcome !== "merged"
    );
  }

  /**
   * Another pull request the task's record keeps that has not ended,
   * besides its current one (INF-2525): its merge card's line reads it.
   */
  private otherChangeOpen(taskId: string): boolean {
    const current = this.options.tasks.get(taskId)?.delivery?.prNumber;
    return this.options.tasks
      .changesFor(taskId)
      .some(
        (change) =>
          change.handle?.number !== undefined &&
          change.handle.number !== current &&
          !change.receipt,
      );
  }

  taskAutonomy(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    if (!record) return false;
    return this.options.tasks.policiesOf(record)?.autonomy.value ?? false;
  }

  /** Called after the atomic record edit; never dispatches or restarts work. */
  policiesChanged(
    taskId: string,
    edits: TaskPolicyEdits,
    before?: EffectiveTaskPolicies | null,
  ): string {
    const record = this.options.tasks.get(taskId);
    const policies = this.options.tasks.policiesOf(record);
    if (!record || !policies) return "";
    const guidance = this.briefs.addedGuidance(taskId, before, policies);
    const wake: TypedWake = {
      facts: {
        kind: "task-policies-changed",
        task: { id: taskId, key: record.key, title: record.title },
        policies,
        ...(guidance.length > 0 ? { guidance } : {}),
      },
    };
    this.options.inbox.enqueueSteerOnce(taskId, {
      ...wake,
      once: `task-policies:${policies.revision}`,
    });
    // A native running turn hears the change now. Other sessions keep it on
    // their durable lane until work next continues, including after a quit.
    const runtime = this.tasks.get(taskId);
    if (runtime?.state === "streaming") void this.sweepTaskLane(taskId, this.now());
    if (edits.autonomy !== undefined && policies.autonomy.value && !mergeHold(record.delivery)) {
      const released: string[] = [];
      for (const card of this.cards.values()) {
        if (card.taskId !== taskId || !isRoutineMergeCard(card)) continue;
        released.push(card.id);
        this.cards.takeDown(card.id, "The captain asked this task to merge on its own.");
      }
      if (
        record.delivery?.captainWait?.cardId &&
        released.includes(record.delivery.captainWait.cardId)
      ) {
        this.options.tasks.delivery.clearCaptainWait(taskId);
      }
      this.ladder.syncCaptainGate(taskId, this.now());
      // The existing Firstmate/settle path rechecks ready work; no new runner.
      if (record.status === "active")
        this.hooks.notifyOp(
          { ...wake, once: `task-policies-ready:${policies.revision}` },
          "agent",
          taskId,
        );
    }
    // Care that rises asks for more before a merge, so the merge card
    // offered at the old care comes down rather than leave a Merge that
    // now fails (INF-562); the crewmate brings a new one after the work
    // the new care needs. However the captain asked: words or the card.
    const rank = { quick: 0, standard: 1, reviewed: 2 } as const;
    if (before && rank[policies.rigor.value] > rank[before.rigor.value]) {
      for (const card of this.cards.values()) {
        if (card.taskId !== taskId || !isRoutineMergeCard(card)) continue;
        this.cards.takeDown(
          card.id,
          `The captain made this task ${CARE_WORDS[policies.rigor.value]}.`,
        );
        if (record.delivery?.captainWait?.cardId === card.id)
          this.options.tasks.delivery.clearCaptainWait(taskId);
      }
      this.ladder.syncCaptainGate(taskId, this.now());
    }
    this.broadcastCrewCounts();
    return policyEditConsequences({
      edits,
      now: policies,
      before,
      mergeSent: this.settling.locks.mergeWasSent(taskId),
    });
  }

  /** What another writer already answered of the thread replies these rows carry. */
  private answeredWhileQueued(inboxIds: readonly number[]): string[] {
    return inboxIds.flatMap((id) => {
      const facts = this.options.inbox.get(id)?.facts;
      if (facts?.kind !== "thread-reply" || facts.card.messageId === undefined) return [];
      const line = this.cards.answeredByContributor(facts.card.id, facts.card.messageId);
      if (!line?.contributor) return [];
      return [
        `On card "${facts.card.title}" (${facts.card.id}), ${line.contributor.label} already answered the captain's message ${facts.card.messageId} (message ${line.id}): "${line.text}" Do not answer it again; write on its thread only with something new, as a comment.`,
      ];
    });
  }

  /** A spawn that failed before the crewmate ran leaves nothing behind. */
  private async cleanupFailedSpawn(task: TaskRuntime): Promise<void> {
    await task.unsubscribe?.();
    task.session?.dispose();
    this.tasks.delete(task.id);
    this.cards.deleteRowsForTask(task.id);
    if (this.options.tasks.get(task.id)) {
      this.options.tasks.archive.discardFailedSpawn(task.id);
    }
    if (task.workspace) {
      await this.options.workspace.removeTaskWorktree(task.workspace).catch(() => {});
    }
    this.cards.scheduleBroadcast();
    this.broadcastCrewCounts();
  }

  /** One crewmate turn: prompt to completion, then idle (multi-turn). */
  private async runTurn(
    task: TaskRuntime,
    text: string,
    inboxIds: number[] = [],
    images?: TurnImage[],
  ): Promise<void> {
    // A new conversation hears why first, on this turn, even when the row
    // was queued after the message it rides.
    const leading = this.claimConversationRestart(task.id, inboxIds);
    const ids = [...leading.map((row) => row.id), ...inboxIds];
    this.beginTurn(task, ids);
    // The rows it delivers name the turn, so a conversation on another
    // computer starts it once however often it is asked.
    const order = laneOrder(ids);
    let served = leading.length > 0 ? `${laneTurnText(leading)}\n\n${text}` : text;
    // A captain question someone else answered while this steer waited is
    // told now, so its answerer does not answer it twice ("Shared cards").
    for (const answered of this.answeredWhileQueued(inboxIds)) served += `\n\n${answered}`;
    try {
      // The one place a crewmate is told its project's directions: the
      // brief holds none, so a first turn carries them once, and a brief
      // served again to a new conversation carries no stale copy.
      const repoId = this.options.tasks.get(task.id)?.repoId;
      if (this.options.knowledge && repoId) {
        const directions = renderDirections(
          this.options.knowledge.directions.standing({
            kind: "crewmate",
            taskId: task.id,
            repoId,
          }),
        );
        served += `\n\n${directions}`;
      }
      // A request already in this prompt's guidance is served there once.
      // Only other pending requests need the recovery-context snapshot.
      const servedInboxIds = new Set(ids);
      const pendingResponses = this.options.inbox
        .pendingResponses(task.id)
        .filter((request) => !servedInboxIds.has(request.inboxId));
      if (pendingResponses.length)
        served += `${PENDING_RESPONSES_OPENING}${task.key || task.id} after context loss):\n${capWithOverflow(pendingResponses.map((request) => `${request.id}: ${request.body}`).join("\n\n"), "pending-responses")}${PENDING_RESPONSES_END}`;
      const assignment = await this.refreshReview(task);
      if (assignment)
        served += `\n\nCurrent review assignment (supersedes earlier heads):\n${assignment}`;
      // This computer is being updated: the turn never reaches its model,
      // and its rows go again once the update is over (`saveForUpdate`).
      if (this.updates.heldForUpdate(task.id)) {
        task.paused ??= {};
        throw new StoppedBeforeStartError();
      }
      if (images?.length) await task.session?.prompt(served, images, order);
      else if (order) await task.session?.prompt(served, undefined, order);
      else await task.session?.prompt(served);
      if (this.disposed) return;
      if (task.cancelled) {
        this.finish(task, "cancelled");
      } else {
        // A session settles the turn an interrupt cut short (Pi and Claude
        // alike); the interrupt the host asked for is what makes it one.
        const interrupted = task.interruptRequested;
        task.interruptRequested = false;
        this.turnComplete(task, { interrupted });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (this.disposed) return;
      if (!task.paused) this.restarts.recordRestartOutcome(task.id, "stopped", message);
      if (task.cancelled) {
        this.finish(task, "cancelled");
      } else if (task.interruptRequested) {
        task.interruptRequested = false;
        this.turnComplete(task, { interrupted: true });
      } else if (task.paused) {
        // The update the app stopped it for ended it there: a pause. One
        // its model never took sends its words again.
        if (caught instanceof StoppedBeforeStartError) task.paused.unstarted = true;
        task.lastTurnError ??= message;
        this.turnComplete(task);
      } else if (isSignInFailure(task.session?.controlProfile, message)) {
        // A sign-in the provider refused as the turn started (Pi's "No API
        // key found") is the captain's to fix, like one a turn reports: the
        // task stays open and idle with its working copy and the card up,
        // never closed failed (INF-849).
        task.lastTurnError ??= message;
        this.turnComplete(task);
      } else {
        this.finish(task, "failed", message);
      }
    }
  }

  /** Reset every per-turn buffer before either host- or provider-initiated work. */
  private beginTurn(task: TaskRuntime, inboxIds: number[] = []): void {
    task.inFlightInboxIds = inboxIds;
    task.steeredInboxIds = [];
    task.state = "streaming";
    task.currentTurnText = "";
    task.turnReport = undefined;
    task.explicitReport = undefined;
    task.explicitSummary = undefined;
    task.explicitDeclared = undefined;
    task.lastTurnError = undefined;
    task.lastTurnCutOff = undefined;
    task.lastEventAt = this.now();
    task.turnStartedAt = this.now();
    task.quietLevel = 0;
    task.wallClockEscalated = false;
    this.clearWait(task);
    // The task moving on its own ends its idle episode (docs/report-sort.md):
    // the clock, the rungs and the host's stall card all go. The one turn
    // that does not is the ladder's own nudge - that turn is the ladder
    // acting, and its episode goes on until something else moves the task.
    if (!this.isLadderTurn(task.id, inboxIds)) {
      this.options.tasks.turns.endIdle(task.id);
      this.ladder.withdrawStallCard(task.id);
    }
    // Whatever the last report declared about whose turn followed it no
    // longer stands once a turn runs: a delivered input started this one,
    // and its own report says it again if it still holds.
    if (this.options.tasks.turns.clearDeclaration(task.id)) {
      this.ladder.syncCaptainGate(task.id, this.now());
    }
    this.broadcastCrewCounts();
    this.options.tasks.turns.setActivity(task.id, "running");
  }

  /**
   * The sign-in card's body, in product words from what the host knows - the
   * crewmate's provider and connection - and never the failure's own text: a
   * client's words name a terminal command, and Pi's add its sign-in
   * instructions and paths into the app's files. The raw text stays on the
   * task's timeline and behind its feed line. A custom connection is named,
   * with the way to check it again, since a sign-in is not what it needs.
   */
  private signInCardBody(task: TaskRuntime): string {
    // A task on another computer runs on that computer's own sign-in, so
    // that is where the captain signs in again (docs/helper.md, "Its own
    // sign-ins"); this Mac's own account is not the one that lapsed.
    const record = this.options.tasks.get(task.id);
    const device = record?.deviceId;
    const where = device ? this.options.machines?.placeOf(device).where : undefined;
    const crewmate = where ? `The crewmate ${where}` : "The crewmate";
    const provider = signInProvider(task.session?.modelRef()?.provider, record?.model);
    if (provider && isCustomApiProvider(provider)) {
      const label = task.accountId ? this.options.accounts?.labelOf(task.accountId) : undefined;
      const connection = label ? `${label}, your custom connection` : "its custom connection";
      return `${crewmate} could not reach ${connection}. In Settings → Intelligence, press Edit on ${label ? "it" : "that connection"}${where ? ` ${where}` : ""}, then Save to check it again.`;
    }
    const name = PROVIDER_CATALOG.find((entry) => entry.id === provider)?.name;
    return `${crewmate} could not reach ${name ?? "its subscription"}, which needs you to sign in again${where ? ` ${where}` : ""}.`;
  }

  /**
   * The rows of the steers the session accepted that no turn took in: the
   * window is the turn's own tail (the run made its last check of the
   * queue, or ended, before the steer landed). A session delivers its
   * steers oldest first, so what is left over is the newest. Taken at every
   * turn end, whatever becomes of the rows, so a steer left over from one
   * turn is never counted against the next one's.
   */
  private undeliveredSteerRows(task: TaskRuntime): number[] {
    const steered = task.steeredInboxIds;
    task.steeredInboxIds = [];
    const left = task.session?.takeUndeliveredSteers().length ?? 0;
    return left === 0 ? [] : steered.slice(-left).flat();
  }

  /** Whether a turn delivers nothing but the idle ladder's own nudge. */
  private isLadderTurn(taskId: string, inboxIds: number[]): boolean {
    const record = this.options.tasks.get(taskId);
    if (!record || record.recoveryAt == null) return false;
    return this.options.tasks.turns.onlyLadderSteers(taskId, inboxIds);
  }

  /**
   * An MCP report can reach the host before the SDK exposes the assistant
   * message that reveals an autonomous continuation. Open the boundary at
   * the earliest observable session signal so the prior turn's buffers
   * cannot consume or later erase this report.
   */
  private recordReportFromSession(
    task: TaskRuntime,
    text: string,
    summary?: string,
    declared?: ReportDeclaration,
  ): string | Promise<string> {
    if (task.state === "idle") this.startAutonomousTurn(task);
    // Handed files are checked whole here before the report counts, and
    // named in it by kept name and size only, never content (INF-992).
    if (declared?.files && declared.files.length > 0) {
      const { files, ...rest } = declared;
      return verifyHandoverFiles(crewmateHandoverDir(this.options.paths, task.id), files).then(() =>
        this.recordReportBody(
          task,
          `${text}\n\n${handedFilesLine(task, files)}`,
          summary,
          rest,
          text,
        ),
      );
    }
    return this.recordReportBody(task, text, summary, declared);
  }

  /** A report whose handed files, if any, are already checked. */
  private recordReportBody(
    task: TaskRuntime,
    text: string,
    summary?: string,
    declared?: ReportDeclaration,
    responseText = text,
  ): string | Promise<string> {
    if (declared?.validation)
      return this.reportIntake
        .recordValidationReport(task, text, summary, declared, responseText)
        .then((receipt) => {
          this.cards.closeOut({ kind: "crewmate", taskId: task.id }, "report");
          return receipt;
        });
    const receipt = this.reportIntake.recordExplicitReport(
      task,
      text,
      summary,
      declared,
      responseText,
    );
    // The report is the crewmate's close-out for its new cards: they reach
    // the stage now. A card the captain already had waits for the turn's
    // end, so it comes back once, with the crewmate's last word (INF-926).
    this.cards.closeOut({ kind: "crewmate", taskId: task.id }, "report");
    return receipt;
  }

  /**
   * Claude can continue after prompt() settled when background work
   * completes; a conversation on another computer runs a turn this Mac did
   * not start here - one a restart here left running there - with the lane
   * rows it delivers, which its end acknowledges.
   */
  private startAutonomousTurn(task: TaskRuntime, inboxIds: number[] = []): void {
    if (this.tasks.get(task.id) !== task || task.cancelled || task.state !== "idle") return;
    task.autonomousTurn = true;
    this.beginTurn(task, inboxIds);
    // Its computer is being updated: the turn it began there stops too.
    this.updates.turnBegan(task);
  }

  /**
   * Complete an autonomous boundary exactly once, using the normal report
   * path; an interrupt the host asked for ends it the way it ends a prompt.
   * One whose end never arrived (`unheard`), because the live session that
   * ran it says it no longer works, ends as interrupted too, so the idle
   * ladder takes the task from there (INF-2332).
   */
  private endAutonomousTurn(
    task: TaskRuntime,
    error?: string,
    cutOff?: CutOff,
    unheard?: boolean,
  ): void {
    if (!task.autonomousTurn || this.tasks.get(task.id) !== task) return;
    task.autonomousTurn = false;
    if (error && !task.lastTurnError) {
      task.lastTurnError = error;
      task.lastTurnCutOff = cutOff;
    }
    if (unheard) this.options.tasks.note(task.id, UNHEARD_END_NOTE, { news: true });
    const interrupted = task.interruptRequested || unheard === true;
    task.interruptRequested = false;
    this.turnComplete(task, { interrupted });
  }

  /**
   * Asks the live session whether a turn the supervisor holds as working
   * still works (INF-2332). A crewmate here is read from its own session:
   * a turn it carried on by itself, which that session no longer runs, ends
   * as interrupted, while a prompt's turn ends with its own prompt. One on
   * another computer is asked of that computer, which ends such a turn once
   * every event it counted is in. Nothing that still runs is stopped.
   */
  private confirmTurn(task: TaskRuntime, answered?: (ended: boolean) => void): void {
    if (task.state !== "streaming" && task.state !== "starting") return;
    if (this.machineOf(task.id) === LOCAL_MACHINE_ID) {
      if (task.autonomousTurn && task.session && !task.session.isStreaming())
        this.endAutonomousTurn(task, undefined, undefined, true);
      return;
    }
    const asked = this.options.machines?.confirm?.(task.id) ?? Promise.resolve(false);
    void asked
      .catch((caught: unknown) => {
        const error = caught instanceof Error ? caught.message : String(caught);
        console.warn(`[crew] could not ask whether ${task.id}'s turn still works: ${error}`);
        return false;
      })
      .then((ended) => answered?.(ended));
  }

  /**
   * A turn ended: the task stays steerable, and the Firstmate hears about it
   * only when the crewmate actually reported (interaction P0, WI-1). The
   * report is the explicit report call, else the turn's final message when
   * that message has text - never an earlier turn's text re-sent. A turn
   * that ends silently (a job result it only noted, a card click, a provider
   * hiccup) wakes nobody - even when it filed follow-ups: the rows stand on
   * the record and the task index shows them (P0, WI-4); the quiet watchdog
   * still covers a stuck turn. A report that is not plausible prose is a
   * failed turn, never an outcome.
   */
  private turnComplete(task: TaskRuntime, options: { interrupted?: boolean } = {}): void {
    this.clearWait(task);
    const placement = this.options.tasks.get(task.id)?.placement;
    if (placement)
      this.options.tasks.placement.releasePlacement(task.id, placement.snapshot.orderId, "ended");
    // A turn the app stopped for its computer's update ends as a pause
    // (`pauseForUpdate`): whatever cut it there is the update, never the
    // provider, so it fails nothing and wakes nobody.
    const paused = task.paused;
    task.paused = undefined;
    // Another computer's update cut the turn there, or this one's own
    // stopped it before its model took it: its words go again. A turn this
    // computer's own update stopped safely kept what it read.
    const cutByUpdate =
      paused !== undefined &&
      (paused.computer !== undefined
        ? task.lastTurnError !== undefined
        : paused.unstarted === true);
    const providerError = paused ? undefined : task.lastTurnError;
    let cutOff = paused ? undefined : task.lastTurnCutOff;
    task.lastTurnError = undefined;
    task.lastTurnCutOff = undefined;
    // A cut-off is a fact about the account, not only this turn: it stands
    // there until a fact changes (docs/quota.md "Typed cut-offs"). A turn on
    // another computer met it on that computer's own sign-in, which records
    // it there (docs/helper.md, "Its own sign-ins"): never on this Mac's
    // account, whose Firstmate and crew keep serving.
    if (cutOff && task.accountId && this.machineOf(task.id) === LOCAL_MACHINE_ID)
      this.options.noteCutOff?.(task.accountId, cutOff);
    // A spent allowance that named no reset (xAI's 402) was held against the
    // sign-in's own reading when it was recorded: the retry waits for that.
    if (cutOff?.class === "no_headroom" && cutOff.resetsAt === undefined && task.accountId) {
      const standing = this.serveability()?.cutOff(task.accountId);
      if (standing?.class === "no_headroom" && standing.resetsAt !== undefined) {
        cutOff = { ...cutOff, resetsAt: standing.resetsAt };
      }
    }
    const finalText =
      task.turnReport ?? (task.currentTurnText.trim() ? task.currentTurnText : undefined);
    // A paused turn's last words are where it stopped, never its report.
    const candidate = providerError
      ? undefined
      : paused
        ? task.explicitReport
        : (task.explicitReport ?? finalText);
    // The tool's own headline belongs to the tool's report, never to a
    // final text that stood in for it.
    const candidateSummary = task.explicitReport !== undefined ? task.explicitSummary : undefined;
    const declared = task.explicitReport !== undefined ? task.explicitDeclared : undefined;
    const turnReview = task.turnReview;
    task.turnReport = undefined;
    task.explicitReport = undefined;
    task.explicitSummary = undefined;
    task.explicitDeclared = undefined;
    task.turnReview = undefined;
    task.currentTurnText = "";
    const filed = task.filedThisTurn;
    task.filedThisTurn = [];
    const implausible =
      candidate && !options.interrupted ? implausibleReport(candidate) : undefined;
    const turnError =
      providerError ??
      (implausible ? `its report was set aside because ${implausible}` : undefined);
    const report = turnError ? undefined : candidate;
    // Ack after handling: the rows this turn consumed are deleted when it
    // ended clean - an interrupt counts, it is a deliberate captain act and
    // the content already reached the transcript, and so does a turn whose
    // report was implausible - and released for a retry only when the
    // provider failed the turn. That release is the honest retry (the
    // captain's Q1, docs/inbox.md): a provider failure spends no attempt
    // and backs off, forever, so the guidance is delivered on the first
    // attempt after the provider answers. A sign-in failure is the
    // captain's to fix, so it spends the ladder as any refusal does. Every
    // other cut-off class keeps the provider-failure path for now.
    const signInFailure =
      providerError !== undefined &&
      isSignInFailure(task.session?.controlProfile, providerError, cutOff);
    const outage = this.options.inbox.outage(task.id);
    const unread = new Set(this.undeliveredSteerRows(task));
    const inFlight = task.inFlightInboxIds;
    const consumed = inFlight.filter((id) => !unread.has(id));
    task.inFlightInboxIds = [];
    if (inFlight.length > 0) {
      if (providerError && !signInFailure) {
        // A spent allowance is not asked again before its reset.
        this.options.inbox.releaseAfterProviderFailure(
          inFlight,
          cutOff?.class === "no_headroom" && cutOff.resetsAt !== undefined
            ? { notBefore: cutOff.resetsAt }
            : {},
        );
      } else if (providerError) {
        this.options.inbox.release(inFlight);
      } else if (cutByUpdate) {
        // Cut before it ended there: its words go again, due once its
        // computer is back, with no attempt spent.
        this.options.inbox.reparkUndelivered(inFlight);
      } else {
        // A steer no turn took in never reached the transcript: its rows
        // go back on the lane, due now, and the delivery below serves them
        // as the next turn - the Firstmate's own rule for its steers
        // (`redeliverUndeliveredSteers`).
        // Acknowledge below, together with any missing-response obligation,
        // after the turn's report has its durable reference.
        this.options.inbox.reparkUndelivered(inFlight.filter((id) => unread.has(id)));
      }
    }
    // The first provider failure of an outage wakes the Firstmate; the rest
    // are the retry's, and each is still its own line on the task's
    // timeline. A failed turn that carried no guidance has no retry, so it
    // is reported as it always was.
    const retrying = providerError !== undefined && !signInFailure && inFlight.length > 0;
    const firstFailure = !retrying || outage.failures === 0;
    if (!providerError && !paused && outage.failures > 0)
      this.ladder.endOutage(task, outage.failures);
    // A paused turn that reported needs no carrying on: its report stands.
    // Nor does one its model never took: its own rows carry it.
    if (paused?.row !== undefined && (report || paused.unstarted))
      this.options.inbox.withdraw([paused.row]);
    task.state = "idle";
    this.turnOver(task.id);
    if (report) task.lastCompleteText = report;
    // The record carries the report (task-system P0): crew_status reads the
    // outcome column after a restart, when no runtime remembers it.
    let reportEventId: number | undefined;
    if (turnError) {
      // A typed backend's provider failure keeps its class for the record,
      // so the feed line reads the class, never the words.
      let typed: TypedFailure | undefined;
      if (providerError !== undefined && task.session?.controlProfile.failureSignals === "typed") {
        typed = cutOff ? { cutOff } : {};
      } else if (providerError !== undefined && cutOff) {
        // A prose backend's failure with a typed class (xAI's 402) keeps the
        // class too, so the feed line reads the class and not the words.
        typed = { cutOff };
      }
      this.options.tasks.turns.recordTurnFailure(task.id, turnError, typed);
    } else if (report) {
      reportEventId = this.options.tasks.turns.recordReport(task.id, {
        text: report,
        ...(candidateSummary ? { summary: candidateSummary } : {}),
        ...(declared ? { declared } : {}),
      });
      // A declared wait places the captain gate before the sort reads it.
      if (declared?.wait) this.ladder.syncCaptainGate(task.id, this.now());
    }
    if (!providerError && !cutByUpdate && consumed.length) {
      const missing = this.options.inbox.transaction(() => {
        // The ordered remote event lane supplies the same completed-turn
        // boundary. An interrupted, paused or failed turn proves no miss.
        const ids =
          !turnError && !options.interrupted && !paused
            ? this.options.inbox.noteMissingResponses(task.id, consumed, {
                id: `${task.id}:${task.turnStartedAt}:${consumed.join(",")}`,
                since: task.turnStartedAt,
                session: task.session?.recordPath(),
                reportEventId,
                ...(report ? { report } : {}),
              })
            : [];
        this.options.inbox.ack(consumed);
        return ids;
      });
      if (missing.length) this.hooks.pokeInbox?.();
    }
    this.options.tasks.turns.setActivity(task.id, "idle");
    this.options.tasks.turns.markIdle(task.id, { providerFailed: providerError !== undefined });
    // Going idle is the crewmate's close-out: a card the captain already had
    // comes back or redraws with its last write, and a new card no report
    // released reaches the stage.
    this.cards.closeOut({ kind: "crewmate", taskId: task.id }, "idle");
    if (report) {
      const summary = candidateSummary || reportSummary(report);
      this.options.broadcastEvent({
        type: "task_report",
        taskId: task.id,
        title: task.title,
        crewmate: task.crewmate,
        ...(summary ? { summary } : {}),
      });
    }
    this.broadcastCrewCounts();
    // A backend that mints its conversation id when the first turn starts
    // only becomes resumable here. Re-reading the token every turn
    // is a no-op for backends whose token was known at creation - and a
    // missing token never erases a good one.
    if (task.session)
      this.recordCrewSession(task, task.session, task.conversationBegan ?? "resume");
    // The personal workspace (Step 4): a report is the turn's commit. The
    // host commits the workspace with the report as the message and, once
    // the commit lands, routes the report like any other (INF-1677): its
    // completion is the ordinary one, which the first mate closes as
    // finished. A commit that fails keeps the task open and tells the
    // Firstmate instead (`commitFailed`), so it never reads as finished.
    const personal = this.options.personal;
    // Ongoing work commits every personal turn without waking the first mate
    // for routine progress. Coordination and completion route normally.
    if (
      !turnError &&
      !options.interrupted &&
      personal &&
      this.isPersonalTask(task.id) &&
      this.options.tasks.get(task.id)?.shape?.ongoing === true &&
      !declared?.needsFirstmate &&
      declared?.finished !== true
    ) {
      void this.commitLiveTurn(task, report || "ongoing work turn", personal);
      return;
    }
    const saved =
      report && !turnError && !options.interrupted && personal && this.isPersonalTask(task.id)
        ? this.commitLiveTurn(task, report, personal)
        : undefined;
    if (turnError) {
      // A provider-failed turn: the session lives and stays steerable, but
      // the failure is never reported as an empty report. The feed line
      // already rode the turn_failed broadcast. Auth is captain territory
      // by definition (deterministic classification, sign-in card) and
      // stays on the firstmate lane; other failures are triageable.
      const error = capWithOverflow(turnError, "turn-error");
      // A cut-off standing on the account is the account's to tell: the
      // Firstmate hears it once for all the crewmates it pauses, never once
      // per failed turn (the cut-off contract).
      if (cutOff) this.ladder.checkCutOffs();
      const accountTells =
        cutOff !== undefined &&
        this.ladder.cutOffHolds({
          id: task.id,
          accountId: task.accountId ?? null,
          deviceId: this.options.tasks.get(task.id)?.deviceId ?? null,
        });
      const failedOp: TypedWake = retrying
        ? outageFailedWake(task, error)
        : {
            facts: {
              kind: "turn-failed",
              task: { id: task.id, title: task.title },
              crewmate: task.crewmate,
              error,
            },
          };
      if (signInFailure) {
        if (!accountTells) this.hooks.notifyOp(failedOp, "agent", task.id);
        // Auth-required is never silent (docs/architecture.md section 6): a
        // decision card offers the way back to a signed-in provider. Its
        // head reads the task's key and title, never the crewmate counter a
        // restart renumbers.
        // Its default moves the task to the app's pick when another
        // provider serves (INF-849); Open settings stays beside it.
        const plan = this.moves.planMove(task.id);
        const move =
          "refused" in plan || !plan.from
            ? undefined
            : {
                arg: `${task.id}:${plan.from}:${offeringKey(plan.choice)}`,
                modelName: this.modelName(plan.choice),
              };
        this.cards.addAuthDecisionCard(
          crewSignInCardId(task.id),
          task.title,
          this.signInCardBody(task),
          { taskId: task.id, ...(move ? { move } : {}) },
        );
      } else if (firstFailure && !accountTells) {
        this.routeCrewEvent(task.id, failedOp, "agent");
      }
    } else if (options.interrupted) {
      // The Firstmate asked for this interrupt (interrupt_crewmate is its
      // tool) and the tool already said it happened: the receipt is a feed
      // line, never a wake (Q4a).
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Task ${task.title} interrupted: it can still be told what to do`,
      });
    } else if (paused && !report) {
      // Nobody has anything to act on: the lane carries it on once the
      // computer is back, and the feed says so once.
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `${task.title} paused while Infinitary on ${paused.computer} is updated. It carries on once ${paused.computer} is back.`,
      });
    } else if (report && isRepairAssessment(this.options.tasks.get(task.id)?.shape)) {
      // An independent repair assessment's one report decides the kept
      // merge's undecided repair (FI3-663).
      void this.reviews.settleRepairAssessment(task, report);
    } else if (report && this.options.tasks.get(task.id)?.shape?.kind === "review") {
      // A reviewer's report settles its review (INF-1875): the typed review
      // record the turn reported is the verdict, recorded on the builder,
      // and a pass closes the review.
      void this.reviews.settleReview(task, report, turnReview);
    } else if (report && saved) {
      void saved.then((committed) => {
        const record = this.options.tasks.get(task.id);
        if (committed && record && !TaskService.isClosed(record))
          this.sortReport(task, report, filed, declared);
      });
    } else if (report) {
      this.sortReport(task, report, filed, declared);
    }
    if (!turnError && !options.interrupted && !paused) this.askForCheckBack(task, declared);
    // A captured settle owns this idle boundary. Do not start another queued
    // guidance turn before its normal close/CI gates run.
    const move = task.pendingMove;
    task.pendingMove = undefined;
    if (this.options.tasks.get(task.id)?.pendingSettle) {
      this.settling.locks.releaseSettleBoundary(task.id);
    } else if (move) {
      // A move asked for mid-turn runs at this boundary, and delivers what
      // waits once the task reopens on its new provider (INF-849).
      void this.moves.runMove(task.id, move);
    } else if (this.options.tasks.get(task.id)?.shape?.computer_move?.phase === "waiting") {
      // The safe pause a move to another computer waited for.
      void this.moves.runComputerMove(task.id);
    } else {
      this.deliverPendingToTask(task, { announce: true });
    }
    // Every idle boundary runs the one reconciler the tick runs.
    this.ladder.reconcileIdleTask(task.id, this.now());
    // The captain's kept merge approval runs once the crewmate's turn is
    // over; a no-op when none stands (FI3-304).
    void this.settling.kept.runMergeAuthorization(task.id).catch((caught: unknown) => {
      console.warn("[crew] kept merge could not run:", caught);
    });
  }

  /**
   * A turn ended with a background job still running and no check-back
   * named (INF-1244): the crewmate is asked once, per job, when it will
   * look at the job again, so a job that stalls silently is read within
   * the time it names rather than at the job's bound. A turn that hands
   * the task to the captain or ends it asks nothing.
   */
  private askForCheckBack(task: TaskRuntime, declared: ReportDeclaration | undefined): void {
    if (declared?.checkBack || declared?.wait || declared?.finished) return;
    if (this.bypassesSupervision(task.id)) return;
    const running =
      this.options.hasRunningJobs?.(task.id) === true || this.clientJobStart(task.id) !== undefined;
    const job = running ? this.oldestJob(task.id) : undefined;
    if (!job || this.options.inbox.woken(task.id, checkBackAskOnce(job))) return;
    const ask = checkBackAsk(
      { ...job, command: capWithOverflow(job.command, "check-back-command") },
      this.now(),
      JOB_BOUND_MS,
    );
    void this.steerInternal(task.id, ask, SUPERVISOR_STEER).catch((caught: unknown) => {
      console.warn("[crew] the check-back ask was not delivered:", caught);
    });
  }

  /**
   * Whose turn is it now (S7c, captain call C7 A; the restated rule at the
   * end of the scout report's R4.8)? The decision itself is `sortReport`
   * (`reportSort.ts`), pure and table-tested; this reads the witnesses the
   * idle ladder gathers for both readers (`IdleLadder.witnesses`), records
   * the sort, and wakes the
   * Firstmate only when the answer is "nobody's". No word of the report is
   * read - the retired supervision session was the only thing that ever
   * did that, and 103 of its last 120 wakes went to a task whose card was
   * already on the captain's screen.
   *
   * The reviewed lane is untouched: a reviewed-tier task's events and a
   * review task's go straight to the Firstmate, which owns the routing of
   * findings by instruction (delivery rigor phase 2). Those were never
   * sorted, so they record nothing here either.
   */
  private sortReport(
    task: TaskRuntime,
    report: string,
    filed: TaskRuntime["filedThisTurn"],
    declared: ReportDeclaration | undefined,
  ): void {
    this.options.tasks.readProjection(() =>
      this.sortReportInProjection(task, report, filed, declared),
    );
  }

  private sortReportInProjection(
    task: TaskRuntime,
    report: string,
    filed: TaskRuntime["filedThisTurn"],
    declared: ReportDeclaration | undefined,
  ): void {
    const finished = declared?.finished === true;
    const needsFirstmate = declared?.needsFirstmate;
    // Read what the report owner normalized and kept, never the uncapped declaration.
    const reports = this.options.tasks.lastReportEntries(task.id);
    const kept = report ? reports.at(-1) : undefined;
    const workWait = kept?.declared.workWait;
    const record = this.options.tasks.get(task.id);
    // F3 of INF-1554 (R1 of INF-1644): the ladder's one rule, a check-back
    // with no claimed job owns no wait; its witnesses already leave it out.
    const unownedTimer =
      declared?.checkBack !== undefined && record !== undefined && this.ladder.unownedTimer(record);
    const stall = workWait
      ? waitStall(workWait, reports.at(-2)?.declared.workWait)
      : unownedTimer && declared?.checkBack
        ? { kind: "wait-without-owner" as const, observation: declared.checkBack.waitingFor }
        : undefined;
    const recoveryWays = kept?.declared.recoveryWays;
    const refused = record?.delivery?.cardRefusal;
    const ci = ciFactOf(record?.delivery, this.now());
    const waits = (record ? this.ladder.unstartedWaits(record) : []).map((wait) => ({
      key: wait.key || wait.id,
      title: wait.title,
      state: wait.status === "dropped" ? ("dropped" as const) : ("not-started" as const),
    }));
    // A hold on this task's finding ends when it reports, not when it
    // closes (INF-735): the work held on it is named on every wake.
    const waiting = (record ? this.ladder.heldOn(record) : []).map((held) => ({
      id: held.id,
      key: held.key || held.id,
      title: held.title,
    }));
    const review = record ? this.reviewToReread(record) : undefined;
    const builtOn = wakeBuiltOn(builtOnRows(this.options.tasks, task.id));
    const witnesses = this.ladder.witnesses(task.id, this.now());
    // A wait it declared with nothing on the captain's screen to answer is
    // the card the Firstmate owes (INF-11): the wake says what he must decide.
    const unseenWait = witnesses.decisionCardOpen ? undefined : record?.delivery?.captainWait;
    const wake: TypedWake = {
      facts: {
        kind: "report",
        task: { id: task.id, title: task.title },
        crewmate: task.crewmate,
        excerpt: capWithOverflow(kept?.text ?? report, "task-report"),
        filed: filed.map(({ key, title, blocks }) => ({ key, title, blocks })),
        ...(waits.length > 0 ? { waits } : {}),
        ...(waiting.length > 0 ? { waiting } : {}),
        cards: this.cards.shownCards(task.id),
        ...(refused ? { refused } : {}),
        ...(unseenWait ? { captainWait: unseenWait.reason } : {}),
        ...(finished ? { finished: true } : {}),
        ...(needsFirstmate ? { needsFirstmate } : {}),
        ...(stall ? { stall } : {}),
        ...(recoveryWays ? { recoveryWays } : {}),
        ...(workWait ? { workWait } : {}),
        ...(builtOn ? { builtOn } : {}),
        ...(declared?.result ? { result: declared.result } : {}),
        ...(ci ? { ci } : {}),
        ...(review ? { review } : {}),
      },
    };
    // A program's part answering its call is the program's to read (INF-799);
    // one that names a check-back says its work still runs (INF-2037).
    const programPart =
      this.programs.awaits(task.id) &&
      !declared?.checkBack &&
      (declared?.result !== undefined ||
        (!record?.shape?.result_schema && !declared?.wait && !declared?.needsFirstmate));
    if (this.bypassesSupervision(task.id) && !programPart) {
      this.hooks.notifyOp(wake, "crewmate-report", task.id);
      return;
    }
    const sort = sortReport({
      ...witnesses,
      filedFollowups: filed.length > 0,
      internalStep: record?.shape?.internal_step === true,
      finished,
      needsFirstmate: needsFirstmate !== undefined,
      recovery: stall !== undefined || recoveryWays !== undefined,
      waitedOn: waiting.length > 0,
      reviewReread: review !== undefined,
      programPart,
      // A session that is gone cannot prove anything either; the record
      // keeps that the host could not tell, and the report still wakes.
      workObservable: task.session?.controlProfile.backgroundWork === "host",
    });
    this.recordSort(task.id, task.title, wake, sort.verdict, sort.reason, sort.rule, () => {
      if (sort.wake) this.hooks.notifyOp(wake, "crewmate-report", task.id);
    });
    // Follow-ups it filed wake the first mate; the program still reads its answer.
    if (programPart && (sort.rule === "program-part" || sort.rule === "filed-followups"))
      void this.crewPrograms.closeProgramPart(task.id);
  }

  /**
   * One row per sort, with the rule that sorted it (R4.4) and the wake's
   * typed facts beside its served text (P6), so `flag_missed_escalation`,
   * the miss deriver, the supervision extractor and the replay scorer keep
   * reading one ledger. The wake rides the store's own transaction: the
   * record of a decision and its effect still commit together.
   */
  private recordSort(
    taskId: string,
    title: string,
    wake: string | TypedWake,
    verdict: "routine" | "captain",
    reason: string,
    rule: ReportSortRule | IdleRule,
    effect: () => void,
  ): void {
    const record = this.options.recordSort;
    if (!record) {
      effect();
      return;
    }
    record({
      taskId,
      ...(typeof wake === "string" ? { wake } : { wake: renderWake(wake), facts: wake.facts }),
      verdict,
      summary: `"${title}": ${reason}`,
      rule,
      wakeKind: IDLE_RULES.has(rule) ? "agent" : "crewmate-report",
      effect,
    });
  }

  /**
   * The end of a live crewmate turn (Step 4): stamp, lint and commit. The
   * commit and the lint land on the task's timeline (never the feed). It
   * answers whether the turn's work is saved, so only a saved report routes;
   * a commit that fails tells the Firstmate instead (`commitFailed`).
   */
  private async commitLiveTurn(
    task: TaskRuntime,
    report: string,
    personal: PersonalLiveDelegate,
  ): Promise<boolean> {
    try {
      const commit = await personal.commitTurn(task.id, report);
      if (!this.options.tasks.get(task.id)) return false;
      if (commit.committed && commit.sha) {
        this.options.tasks.note(
          task.id,
          `committed ${commit.sha.slice(0, 7)} in the personal workspace${
            commit.touched.length > 0 ? ` (${commit.touched.join(", ")})` : ""
          }`,
          { news: true, data: { commit: commit.sha, touched: commit.touched } },
        );
      }
      if (commit.findings.length > 0) {
        const summary = commit.findings
          .slice(0, 8)
          .map((finding) => `${finding.severity} ${finding.file}:${finding.line} ${finding.rule}`)
          .join("; ");
        this.options.tasks.note(
          task.id,
          `lint at commit: ${commit.findings.length} finding${commit.findings.length === 1 ? "" : "s"} - ${summary}`,
          { news: false, data: { findings: commit.findings } },
        );
      }
    } catch (caught) {
      this.commitFailed(task, caught);
      return false;
    }
    return true;
  }

  /**
   * A turn's commit failed (FI3-1218): what the crewmate changed is saved in
   * the workspace but not committed, so the task stays open - never done
   * and "built in place". Git's words go on the timeline (its whole error in
   * the note's data) and to the Firstmate, whose steer starts the crewmate's
   * next turn; that turn's report commits again. The idle ladder watches
   * the open task as any other.
   */
  private commitFailed(task: TaskRuntime, caught: unknown): void {
    const record = this.options.tasks.get(task.id);
    if (!record) return;
    const reason = gitFailure(caught);
    this.options.tasks.note(
      task.id,
      `could not commit the personal workspace, so its changes are saved there uncommitted: ${reason}`,
      {
        news: true,
        data: { commitFailed: caught instanceof Error ? caught.message : String(caught) },
      },
    );
    if (TaskService.isClosed(record)) return;
    this.routeCrewEvent(
      task.id,
      {
        facts: {
          kind: "commit-failed",
          task: { id: task.id, title: task.title },
          crewmate: task.crewmate,
          error: reason,
        },
      },
      "agent",
    );
  }

  /**
   * Deliver the task lane's due rows as the crewmate's next turn: the
   * followup-queue fallback (guidance a backend could not take mid-turn),
   * failed steers past their grace, and job results alike. With announce,
   * when the rows carry guidance someone sent, the feed says so rather than
   * letting the guidance arrive as if the crewmate had thought of it - one
   * quiet feed line, never a Firstmate wake (interaction P0, WI-5): the
   * Firstmate queued that guidance itself and has nothing to act on. The
   * line is a row on the task that the feed shows once per task, the
   * newest (`QUEUED_GUIDANCE_FOLD`, INF-1137). Rows are marked in-flight
   * here and acknowledged at the turn's end (runTurn -> turnComplete).
   */
  private deliverPendingToTask(
    task: TaskRuntime,
    options: { announce?: boolean; sent?: boolean } = {},
  ): void {
    if (task.cancelled || !task.session || task.state !== "idle") return;
    if (this.laneHeld(task.id)) return;
    // A started task in the backlog (INF-2062) takes a turn only for words
    // the captain or the first mate sent, told it stays there.
    const backlog = this.inBacklog(task.id);
    if (backlog && !options.sent) return;
    const rows = this.deliverableRows(task.id, this.now());
    if (rows.length === 0) return;
    const pictures = this.rowPictures(task.id, rows);
    if (pictures.blocked) return;
    if (options.announce && rows.some((row) => !OWN_LANE_KINDS.has(row.facts?.kind ?? ""))) {
      this.options.tasks.note(task.id, QUEUED_GUIDANCE_LINE, {
        news: false,
        feed: true,
        data: { feedLine: true, feedOnce: QUEUED_GUIDANCE_FOLD },
      });
    }
    const ids = this.deliverRows(task.id, rows);
    const text = laneTurnText(rows);
    void this.runTurn(
      task,
      backlog ? `${BACKLOG_STEER_LINE}\n\n${text}` : text,
      ids,
      pictures.images,
    );
  }

  /**
   * Lane rows go out: marked in flight, and when one is a sent row going
   * out for the first time the crewmate's center spark flies now, as it
   * reaches it (INF-759). The crewmate's own rows - a job's result, a
   * renewed conversation's reason - were sent by nobody and draw nothing;
   * a row delivered again already drew its spark.
   */
  private deliverRows(taskId: string, rows: readonly InboxRow[]): number[] {
    const ids = rows.map((row) => row.id);
    const sent = rows.some(
      (row) => row.lastAttemptAt === null && !OWN_LANE_KINDS.has(row.facts?.kind ?? ""),
    );
    this.options.inbox.markDelivered(ids);
    if (sent) this.announceReach(taskId);
    return ids;
  }

  /**
   * Something sent reached a crewmate (INF-759): words entered its turn,
   * its turn was stopped, its task closed under it or was edited. One push
   * says so, and the center draws its spark out to the crewmate then. Only
   * a crewmate on the ring has a place for it.
   */
  announceReach(taskId: string): void {
    const record = this.options.tasks.get(taskId);
    if (record?.kind !== "work" || record.status !== "active") return;
    this.options.broadcastEvent({
      type: "task_event",
      taskId,
      key: record.key,
      kind: "reached",
      text: "",
      at: this.now(),
      feed: false,
      reached: true,
    });
  }

  /**
   * The steer data plane, on the durable inbox: the message is recorded on
   * the task's lane FIRST, then delivered - into the running turn on a
   * native-steer backend, as the next turn otherwise. A streaming task on a
   * `followup-queue` backend keeps the row pending until its turn ends, and
   * the return value says so - the guidance is neither dropped nor reported
   * as if the work in flight had heard it. A delivery that fails right now
   * returns `recorded-retrying`: the row is durable, the tick sweep retries
   * it, and the ladder escalates loudly if it keeps failing. (`recorded-queued`
   * was the supervision claim's outcome; nothing produces it since S7c
   * retired the claim, and it stays in the vocabulary for the record.)
   */
  /**
   * Delivers one file into a task's hand-over folder on the computer it
   * runs on, verified and 0600, named by its sha256 and its own name
   * (`handoverFileName`): a copy here, or the source-file order there.
   * Answers its kept name and its path there.
   */
  private async deliverHandover(
    taskId: string,
    path: string,
    name: string,
    sha256: string,
  ): Promise<{ file: string; path: string }> {
    const file = handoverFileName(name, sha256);
    const machine = this.machineOf(taskId);
    if (machine === LOCAL_MACHINE_ID)
      return {
        file,
        path: await deliverHandoverFile(
          path,
          join(crewmateTempDir(this.options.paths, taskId), HANDOVER_IN_DIR_NAME),
          file,
        ),
      };
    const machines = this.options.machines;
    if (!machines?.sourceFile)
      throw new Error("The work computer cannot receive this message’s attachments.");
    return { file, path: await machines.sourceFile(machine, taskId, file, path, "handover") };
  }

  /**
   * Why a task cannot take a file from outside into its hand-over folder
   * now (docs/integrations.md, "Google"): it is not running, or its
   * computer could not remove the file when it is due.
   */
  outsideFileRefusal(taskId: string): string | undefined {
    const record = this.options.tasks.get(taskId);
    if (!record || record.status !== "active")
      return "this task is not running, so it has no hand-over folder to save into.";
    const machine = this.machineOf(taskId);
    if (machine === LOCAL_MACHINE_ID) return undefined;
    const machines = this.options.machines;
    if (machines?.sourceFile && machines.takesOutsideFiles?.(machine)) return undefined;
    return `update Infinitary on ${machines?.nameOf(machine) ?? `the other ${COMPUTER.one}`} before a file from outside can be saved into this task's folder there.`;
  }

  /**
   * Saves a file from outside, such as a Gmail attachment, into a task's
   * hand-over folder (`IntegrationsServiceOptions.files`): written 0600 in a
   * private folder of its own, delivered verified, and removed here.
   */
  async saveOutsideFile(
    taskId: string,
    name: string,
    bytes: Buffer,
  ): Promise<{ file: string; path: string }> {
    const refusal = this.outsideFileRefusal(taskId);
    if (refusal) throw new Error(refusal);
    const staging = await mkdtemp(join(tmpdir(), "infinitary-outside-"));
    try {
      const path = join(staging, "file");
      await writeFile(path, bytes, { mode: 0o600 });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return await this.deliverHandover(taskId, path, name, sha256);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Delivers the files a task's reports handed on into another task's
   * hand-over folder on the computer it runs on (INF-992, direction B): a
   * verified local copy here, or the source-file order there, each 0600 in
   * its temporary folder, so it goes when that task closes. Answers the
   * words the steer carries: paths and sizes, never content.
   */
  async handFiles(fromTask: string, toTask: string): Promise<string> {
    const from = this.options.tasks.resolve(fromTask);
    const to = this.options.tasks.resolve(toTask);
    if (!from) throw new Error(`There is no task ${fromTask} to hand files from.`);
    if (!to) throw new Error(`There is no task ${toTask} to hand files to.`);
    const handle = (record: TaskRecord) => record.key || record.id;
    const kept = await keptHandoverFiles(crewmateHandoverDir(this.options.paths, from.id));
    if (kept.length === 0)
      throw new Error(
        `${handle(from)} has no reported files to hand on: its crewmate passes them in report files.`,
      );
    if (to.status !== "active")
      throw new Error(
        `${handle(to)} has not started, so there is no folder to hand files into yet.`,
      );
    const machine = to.deviceId;
    const machines = this.options.machines;
    if (machine && !machines?.takesHandover?.(machine))
      throw new Error(
        `${handle(to)} runs on ${machines?.nameOf(machine) ?? `another ${COMPUTER.one}`}, which needs an update to Infinitary before it can take handed files.`,
      );
    const lines: string[] = [];
    for (const file of kept) {
      const path =
        machine && machines?.sourceFile
          ? await machines.sourceFile(machine, to.id, file.file, file.path, "handover")
          : await deliverHandoverFile(
              file.path,
              join(crewmateTempDir(this.options.paths, to.id), HANDOVER_IN_DIR_NAME),
              file.file,
            );
      lines.push(`${path} (${fileSizeWords(file.size)})`);
    }
    // Only a complete, verified delivery is a receipt; failed copies leave none.
    this.options.tasks.capture.recordResultHandoff(from.id, { taskId: to.id });
    // Paths and sizes only: a handed file may hold secrets (the captain's words on INF-992).
    return `Files handed to you from ${handle(from)}, verified byte for byte, in your hand-over folder: ${lines.join(", ")}. They may hold secrets: never print, quote or paste their content anywhere, and read only what your work needs. They are removed when this task closes.`;
  }

  async steerCrewmate(
    taskId: string,
    message: WakeBody,
    actor: "firstmate" | "captain" = "firstmate",
    source: {
      via?: "tool" | "card" | "thread" | typeof TASK_CARD_VIA | typeof CREWMATE_TAB_VIA;
      decision?: string | null;
      cardId?: string | null;
      /** The panel the captain moved it from, by its title. */
      panel?: string;
      /** The Firstmate steers in a turn that carries the captain's own words. */
      captainWords?: boolean;
      images?: TurnImage[];
      /** The message's own copies of `images`, kept when it was accepted. */
      attachments?: AttachmentRef[];
      /** First mate tool messages expect answers; host/captain steers do not. */
      response?: ResponsePolicy;
    } = {},
  ): Promise<SteerDelivery> {
    const record = this.options.tasks.get(taskId);
    if (source.response && actor !== "firstmate")
      throw new Error("Only a first mate message creates or cancels its response expectations.");
    if (
      source.response?.mode === "expected" &&
      record?.deviceId &&
      !this.options.machines?.takesResponses?.(record.deviceId)
    )
      throw new Error(
        "Update Infinitary on the work computer before requesting a tracked response. Nothing was sent.",
      );
    for (const id of source.response?.cancel ?? []) {
      const request = this.options.inbox.responseRequest(id);
      if (request?.state === "answered")
        throw new Error("An answered request cannot be cancelled. Nothing was sent.");
      if (request?.targetTask !== taskId)
        throw new Error(`Response request ${id} does not belong to this task. Nothing was sent.`);
    }
    if (source.response?.card) this.reportIntake.checkResponseCard(source.response.card);
    const steer: SteerSource = {
      actor,
      via: source.via ?? "tool",
      decision: source.decision ?? null,
      cardId: source.cardId ?? null,
      ...(source.panel ? { panel: source.panel } : {}),
      ...(source.captainWords ? { captainWords: true } : {}),
    };
    return this.steerInternal(
      taskId,
      message,
      steer,
      source.images,
      source.attachments,
      source.response,
    );
  }

  /**
   * `body` is the guidance as its lane stores it: the words given, or a
   * typed wake (the ladder's nudge) that renders to the words the crewmate
   * is steered with and the timeline records.
   */
  private async steerInternal(
    taskId: string,
    body: WakeBody,
    given: SteerSource,
    images?: TurnImage[],
    attachments?: readonly AttachmentRef[],
    response?: ResponsePolicy,
  ): Promise<SteerDelivery> {
    let message = renderWake(body);
    // A reply the captain typed under a card: the record reads the captain's words in the message.
    const words = replyWordsSpan(body);
    const source = words ? { ...given, words } : given;
    const reviewBuilder = this.reviewBuilderOf(this.options.tasks.get(taskId));
    const hasImages = Boolean(images?.length);
    const withPictures = (guidance: WakeBody): WakeBody =>
      attachments?.length
        ? withAttachmentsKept(guidance, attachments)
        : hasImages
          ? withAttachmentsDropped(guidance)
          : guidance;
    let durable = withPictures(body);
    const liveImages = hasImages ? images : undefined;
    // The captain's guidance while his kept merge approval stands takes its
    // mark as its row is recorded, and the mark rides the message, so the
    // crewmate can declare only guidance it read (FI3-662).
    const guidance = isCaptainGuidance(given, body);
    // The host's own steer - a timed wait's end, a closed dependency, a
    // check's result - waits on a started task's lane in the backlog.
    const sentByHost = given.actor === "supervisor";
    const enqueue = (): number => {
      if (this.restarts.observing(taskId)) {
        this.restarts.recordRestartOutcome(
          taskId,
          "stopped",
          "new guidance arrived before automatic recovery was confirmed",
        );
        this.restarts.forget(taskId);
      }
      const mark = guidance ? this.settling.approvals.holdForGuidance(taskId) : undefined;
      if (mark !== undefined) {
        const marked = withGuidanceMark(body, mark);
        message = renderWake(marked);
        durable = withPictures(marked);
      }
      return this.options.inbox.transaction(() => {
        for (const id of response?.cancel ?? []) this.options.inbox.cancelResponse(id);
        if (response?.cancel?.length) {
          durable = {
            facts: {
              kind: "responses-cancelled",
              requests: response.cancel,
              guidance: typeof durable === "string" ? durable : durable.facts,
            },
            ...(typeof durable !== "string" && durable.ways ? { ways: durable.ways } : {}),
          };
          message = renderWake(durable);
        }
        if (response?.mode !== "expected") return this.enqueueSteer(taskId, durable);
        const requested = this.options.inbox.requestResponse(
          taskId,
          renderWake(body),
          {
            session: response.sourceSession,
            message: given.decision,
            card: response.card,
            targetSession:
              this.tasks.get(taskId)?.session?.recordPath() ??
              this.options.tasks.get(taskId)?.sessionFile,
          },
          durable,
        );
        durable = requested.body;
        message = renderWake(durable);
        return requested.inboxId;
      });
    };
    const task = this.tasks.get(taskId);
    if (task?.session && !task.cancelled) {
      if (task.state === "streaming" || task.state === "starting") {
        // Its computer is out of reach, or this one is being updated: kept
        // on the lane, and steered into the turn once it is back and caught
        // up, or served by the turn that carries it on.
        if (this.outOfReach(taskId) || this.updates.heldForUpdate(taskId)) {
          const held = enqueue();
          this.recordSteer(taskId, message, source, "recorded-held", held);
          return "recorded-held";
        }
        if (reviewBuilder || task.session.controlProfile.steer === "followup-queue") {
          const queued = enqueue();
          this.recordSteer(taskId, message, source, "queued-next-turn", queued);
          return "queued-next-turn";
        }
        const id = enqueue();
        this.options.inbox.markDelivered([id]);
        this.announceReach(taskId);
        try {
          // Handled when the turn it landed in ends: ack rides turnComplete.
          await this.steerIntoTurn(task, task.session, message, [id], liveImages);
          this.recordSteer(taskId, message, source, "mid-turn", id);
          return "mid-turn";
        } catch {
          this.options.inbox.release([id]);
          this.recordSteer(taskId, message, source, "recorded-retrying", id);
          return "recorded-retrying";
        }
      }
      const pending = enqueue();
      if (this.laneHeld(taskId) || (sentByHost && this.inBacklog(taskId))) {
        // Kept on the lane until the account serves again, or the task leaves the backlog.
        this.recordSteer(taskId, message, source, "recorded-held", pending);
        return "recorded-held";
      }
      this.recordSteer(taskId, message, source, "mid-turn", pending);
      this.deliverPendingToTask(task, { sent: true });
      return "mid-turn";
    }
    const record = this.options.tasks.get(taskId);
    if (!record) {
      throw new Error(`Unknown task "${taskId}". Check crew_status for live task ids.`);
    }
    if (!TaskService.isResumable(record)) {
      throw new Error(
        `Task ${taskId} is ${describeStatus(record)} and no longer steerable. ${record.status === "dropped" ? "On the captain’s request, use update_task start_again to create a replacement." : "Spawn a follow-up crewmate instead."}`,
      );
    }
    if (!record.sessionFile) {
      throw new Error(`Task ${taskId} has no session to resume. Spawn a follow-up instead.`);
    }
    if (this.retiredProviderOf(taskId)) throw new Error(retiredResumeText(taskId));
    const resumeId = enqueue();
    if (this.laneHeld(taskId) || (sentByHost && this.inBacklog(taskId))) {
      this.recordSteer(taskId, message, source, "recorded-held", resumeId);
      return "recorded-held";
    }
    try {
      const resumed = await this.resumeTask(record.id);
      this.recordSteer(taskId, message, source, "mid-turn", resumeId);
      this.deliverPendingToTask(resumed, { sent: true });
      return "mid-turn";
    } catch {
      // The row is durable; the tick sweep retries the resume.
      this.recordSteer(taskId, message, source, "recorded-retrying", resumeId);
      return "recorded-retrying";
    }
  }

  /**
   * A steer's durable row. A host steer that goes out once per fact (the
   * check watch's) records its name with the row (`enqueueSteerOnce`).
   */
  private enqueueSteer(taskId: string, body: WakeBody): number {
    return typeof body !== "string" && body.once !== undefined
      ? this.options.inbox.enqueueSteerOnce(taskId, { ...body, once: body.once })
      : this.options.inbox.enqueue(taskId, body);
  }

  /**
   * Steer the running turn with lane rows already marked in flight. The
   * rows are the turn's before the session is asked, so a steer that lands
   * in the turn's own tail is known to the turn's end, which takes it back
   * (`undeliveredSteerRows`); a steer the session refuses takes its rows
   * back out and throws.
   */
  private async steerIntoTurn(
    task: TaskRuntime,
    session: ModelSession,
    text: string,
    ids: number[],
    images?: TurnImage[],
  ): Promise<void> {
    task.inFlightInboxIds.push(...ids);
    task.steeredInboxIds.push(ids);
    const handed: UnreadSteer = {
      sha: createHash("sha256").update(text).digest("hex"),
      since: this.now(),
    };
    task.unreadSteers.push(handed);
    const order = laneOrder(ids);
    try {
      if (images) await session.steer(text, images, order);
      else if (order) await session.steer(text, undefined, order);
      else await session.steer(text);
    } catch (caught) {
      task.inFlightInboxIds = task.inFlightInboxIds.filter((id) => !ids.includes(id));
      task.steeredInboxIds = task.steeredInboxIds.filter((steered) => steered !== ids);
      task.unreadSteers = task.unreadSteers.filter((steer) => steer !== handed);
      throw caught;
    }
  }

  /**
   * The steer's timeline event (R2 forward capture), written once the
   * control plane has decided what happened to it. Bookkeeping never takes
   * a steer down with it.
   */
  private recordSteer(
    taskId: string,
    message: string,
    source: SteerSource,
    outcome: SteerDelivery,
    inboxId: number,
  ): void {
    try {
      this.options.tasks.turns.recordSteer(taskId, {
        text: message,
        actor: source.actor,
        outcome,
        via: source.via,
        decision: source.decision,
        cardId: source.cardId,
        inboxId,
        ...(source.panel ? { panel: source.panel } : {}),
        ...(source.words ? { words: source.words } : {}),
      });
    } catch (caught) {
      console.warn("[crew] steer capture failed:", caught);
    }
  }

  /**
   * The provider a task was last routed to, when this build no longer
   * offers it (Cursor). Its resume token belongs to that
   * provider's own client, so no backend here can reopen the session.
   */
  private retiredProviderOf(taskId: string): string | undefined {
    const provider = this.options.router?.servedProvider(taskId);
    return provider && isRetiredProvider(provider) ? provider : undefined;
  }

  /**
   * Reopen the session of an idle task left by a previous process, or of
   * one moving to another provider (`move`, INF-849): it opens on the
   * move's model and account in the same working copy, resuming the same
   * conversation when the new backend can reopen it. With `restart`, a new
   * conversation opens instead, told why and where the earlier one is: a
   * task that moved to another computer (docs/helper.md, "Moving a started
   * task"). A plain resume while the task's conversation is opening joins
   * that open rather than opening a second conversation over it: a computer
   * that runs work can ask for the conversation (`adoptPlaced`) before it
   * has answered the open a move or a wake asked of it.
   */
  private resumeTask(
    taskId: string,
    move?: MoveTarget,
    restart?: CrewmateRestart,
  ): Promise<TaskRuntime> {
    const opening = this.resuming.get(taskId);
    if (opening && !move && !restart) return opening;
    const resuming = this.openResumed(taskId, move, restart);
    this.resuming.set(taskId, resuming);
    const opened = () => {
      if (this.resuming.get(taskId) === resuming) this.resuming.delete(taskId);
    };
    resuming.then(opened, opened);
    return resuming;
  }

  private async openResumed(
    taskId: string,
    move?: MoveTarget,
    restart?: CrewmateRestart,
  ): Promise<TaskRuntime> {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    // A committed move to another computer opens a new conversation there,
    // whichever path resumes it first (docs/helper.md, "Moving a started task").
    const movedFrom = record.shape?.computer_move?.restartFrom;
    const fresh: CrewmateRestart | undefined =
      restart ??
      (!move && movedFrom !== undefined
        ? {
            from: movedFrom,
            changed: "computer",
            to: this.moves.computerName(this.moves.computerOf(record)),
          }
        : undefined);
    if (!record.sessionFile) {
      throw new Error(`Task ${taskId} has no session to resume. Spawn a follow-up instead.`);
    }
    if (this.retiredProviderOf(taskId)) throw new Error(retiredResumeText(taskId));
    // A resume is an attachment point: re-check the recorded account and
    // move to a sibling (transcript intact) if it died or was removed.
    const previousProvider = this.options.router?.servedProvider(taskId);
    const custom = previousProvider && isCustomApiProvider(previousProvider);
    const machine = this.machineOf(record.id);
    if (
      machine === LOCAL_MACHINE_ID &&
      custom &&
      (!record.accountId || !this.options.accounts?.labelOf(record.accountId))
    )
      throw new Error(
        "This task’s custom connection was disconnected. It cannot resume on another server automatically.",
      );
    // A task on a computer that runs work binds that computer's own
    // account again there; no account of this Mac's is chosen for it.
    const attachment: { accountId?: string; changed: boolean } = move
      ? { ...(move.accountId ? { accountId: move.accountId } : {}), changed: false }
      : machine !== LOCAL_MACHINE_ID
        ? { changed: false }
        : custom
          ? { accountId: record.accountId ?? undefined, changed: false }
          : (this.options.accounts?.reselectForResume(record.id, record.accountId) ?? {
              ...(record.accountId ? { accountId: record.accountId } : {}),
              changed: false,
            });
    if (attachment.changed) {
      this.options.tasks.placement.setAccountId(record.id, attachment.accountId ?? null);
      const moved = attachment.accountId
        ? `moved to ${this.options.accounts?.labelOf(attachment.accountId) ?? "another account"}`
        : "continuing without a bound account";
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Task "${record.title}" ${moved} - its previous account is no longer available.`,
        taskId: record.id,
      });
    }
    // On a computer that runs work, its working copy is there; this Mac holds none.
    // A folder repair that started above its missing folder resumes there (INF-572).
    const startedIn = isFolderRepair(record.shape?.in_place)
      ? record.shape.in_place.started_in
      : undefined;
    const cwd =
      machine === LOCAL_MACHINE_ID
        ? startedIn || record.worktreeDir || record.repoDir
        : this.options.machines?.folders(machine, record.id)?.work;
    if (cwd === undefined) throw new Error("The computer this task runs on is out of reach.");
    this.crewmateSeq += 1;
    const task: TaskRuntime = {
      id: record.id,
      title: record.title,
      key: record.key || record.id,
      crewmate: `crewmate ${this.crewmateSeq}`,
      ...(machine === LOCAL_MACHINE_ID
        ? {
            workspace: {
              taskId: record.id,
              // A live task has no worktree: its cwd is the workspace itself.
              cwd,
              branch: record.branch,
              repoDir: record.repoDir,
            },
          }
        : {}),
      currentTurnText: "",
      // The durable record remembers the last report across the restart.
      lastCompleteText: record.outcome ?? "",
      state: "idle",
      ...(attachment.accountId ? { accountId: attachment.accountId } : {}),
      cancelled: false,
      interruptRequested: false,
      filedThisTurn: [],
      lastEventAt: this.now(),
      turnStartedAt: this.now(),
      quietLevel: 0,
      wallClockEscalated: false,
      inFlightInboxIds: [],
      steeredInboxIds: [],
      clientTasks: new Map(),
      openCalls: new Map(),
      unreadSteers: [],
      openReads: new OpenReads(this.now),
    };
    const livePersonal = this.isPersonalTask(record.id) ? this.options.personal : undefined;
    // Register before opening the session: a resumed provider can carry on
    // with work of its own the moment it is back.
    this.tasks.set(record.id, task);
    let session: ModelSession;
    try {
      session = await this.openCrewmate(
        task,
        {
          taskId: record.id,
          machineId: machine,
          cwd,
          ...(fresh ? {} : { resumeToken: record.sessionFile }),
          ...(move
            ? { model: move.model, thinkingLevel: move.thinkingLevel }
            : this.reopenedOn(record)),
          ...this.crewmateHooks(task, livePersonal),
        },
        attachment.accountId,
        record.model ?? undefined,
        move?.providerName,
      );
    } catch (caught) {
      if (this.tasks.get(record.id) === task) this.tasks.delete(record.id);
      throw caught;
    }
    task.session = session;
    task.unsubscribe = await this.follow(task, session);
    // A moved task's record names the conversation it opened now, so a quit
    // before its first turn ends reopens this one.
    this.recordCrewSession(
      task,
      session,
      task.conversationBegan ?? (move || fresh ? "move" : "resume"),
    );
    if (fresh) this.recordRestart(task, machine, fresh);
    const opened = this.options.tasks.get(record.id)?.shape?.computer_move;
    if (opened?.restartFrom !== undefined) {
      const { restartFrom: _told, ...rest } = opened;
      this.options.tasks.placement.setComputerMove(record.id, rest);
    }
    livePersonal?.beginLiveTask(record.id);
    // A conversation on another computer may be in a turn this Mac follows
    // from here (`continuation_started`), which is no idle boundary.
    if (task.state === "idle") {
      this.options.tasks.turns.setActivity(record.id, "idle");
      // A resume that went idle is an idle boundary: the record's own clock
      // carries across the restart, and a record a quit interrupted mid-turn
      // starts one now.
      this.options.tasks.turns.markIdle(record.id);
    }
    this.broadcastCrewCounts();
    return task;
  }

  /**
   * What a reopen asks for (INF-1272): the model of the task's newest
   * routing choice, its start's or its newest move's, at the effort a move
   * works out - here or on a computer that runs work. A Claude conversation
   * that starts over after an update has no transcript to restore a model
   * from, so without this it opens on the client's default. A client's
   * fallback is not a routing choice, so the reopen asks for the original
   * again. A task that never routed opens as its session restores it.
   */
  private reopenedOn(record: TaskRecord): Pick<CrewmateSpec, "model" | "thinkingLevel" | "quick"> {
    const routed = this.options.router?.servedChoice(record.id);
    if (!routed) return {};
    const chosen =
      record.shape?.override_reasoning ??
      this.options.router?.reasoningChoice(routed.model, routed.slot);
    return {
      model: routed.model,
      thinkingLevel: chosen ?? levelDefaultReasoning(routed.slot),
      // As its start did: Quick care opens a rung lower unless an effort was chosen.
      ...(record.shape?.rigor === "quick" && !chosen ? { quick: true } : {}),
    };
  }

  /** A model by its Settings name, as the sign-in card's Move names it. */
  private modelName(model: { provider: string; id: string }): string {
    return this.options.modelName?.(model) ?? model.id;
  }

  /**
   * The lifecycle control plane (interrupt_crewmate, the Firstmate's tool;
   * the shell's abort is a cancel). An interrupt's receipt is a feed line:
   * the tool that asked for it already said it happened.
   */
  async interruptCrewmate(
    taskId: string,
    mode: "interrupt" | "cancel",
    source: InterruptSource = { actor: "firstmate", via: "tool", decision: null },
    closingSentence?: string,
  ): Promise<void> {
    if (mode !== "cancel" || !closingSentence) return this.interruptOnce(taskId, mode, source);
    // The first mate's cancel carries its sentence to the close it brings
    // about, now or when the stopped turn ends (INF-547), keyed by the
    // record the close names.
    const id = this.options.tasks.resolve(taskId)?.id ?? taskId;
    this.settling.closing.expectClosingSentence(id, closingSentence);
    try {
      await this.interruptOnce(taskId, mode, source);
    } catch (caught) {
      this.settling.closing.forgetClosingSentence(id);
      throw caught;
    }
    // With no turn left to end, no later close will take it.
    if (!this.tasks.has(id)) this.settling.closing.forgetClosingSentence(id);
  }

  private async interruptOnce(
    taskId: string,
    mode: "interrupt" | "cancel",
    source: InterruptSource,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    // A stop or a cancel reaches the crewmate: its spark flies first.
    this.announceReach(taskId);
    if (!task) {
      const record = this.options.tasks.get(taskId);
      if (!record) throw new Error(`Unknown task "${taskId}".`);
      // Already-closed work must not be relabelled cancelled (a second
      // cancel on a done row, including after a merge).
      if (record.status === "done") {
        this.recordInterrupt(taskId, mode, source, "already-done");
        return;
      }
      if (TaskService.isResumable(record)) {
        if (mode === "cancel") {
          this.recordInterrupt(taskId, mode, source, "cancelled-record");
          this.settling.closing.closeRecord(record.id, "cancelled", undefined, source.actor);
          this.options.broadcastEvent({
            type: "task_finished",
            taskId,
            status: "cancelled",
            title: record.title,
          });
          this.broadcastCrewCounts();
          // As `finish` does: the record may be what a queued row, or an
          // active task's wait (FI3-250), is waiting on.
          void this.sweepGates(this.now());
        } else {
          this.recordInterrupt(taskId, mode, source, "no-turn");
        }
        return;
      }
      throw new Error(`Task ${taskId} is already ${describeStatus(record)}.`);
    }
    if (mode === "cancel") {
      if (task.state === "idle") {
        this.recordInterrupt(taskId, mode, source, "cancelled-idle");
        this.finish(task, "cancelled");
      } else if (!task.session) {
        task.cancelled = true;
        this.recordInterrupt(taskId, mode, source, "no-turn");
      } else {
        this.recordInterrupt(taskId, mode, source, "requested");
        task.cancelled = true;
        try {
          await task.session.abort();
          this.recordInterrupt(taskId, mode, source, "aborted-turn");
        } catch (caught) {
          task.cancelled = false;
          const error = caught instanceof Error ? caught.message : String(caught);
          this.recordInterrupt(taskId, mode, source, "abort-failed", error);
          throw caught;
        }
        // An abort asks the turn to stop; it never promises the turn ends.
        // A Claude client answers the steers it still holds in a turn of its
        // own, and a turn on another computer may never report its end, so
        // waiting for that end left a cancelled task running. The cancel
        // ends the task here, as a settle's stop does; the turn's own end,
        // whenever it comes, finds it gone (`finish`).
        this.finish(task, "cancelled");
      }
      return;
    }
    if (task.state === "streaming" || task.state === "starting") {
      if (!task.session) {
        this.recordInterrupt(taskId, mode, source, "no-turn");
        return;
      }
      this.recordInterrupt(taskId, mode, source, "requested");
      task.interruptRequested = true;
      try {
        await task.session.abort();
        this.recordInterrupt(taskId, mode, source, "aborted-turn");
        // A stop that found nothing running leaves no end to wait for: the
        // live session is asked at once (INF-2332).
        this.confirmTurn(task);
      } catch (caught) {
        task.interruptRequested = false;
        const error = caught instanceof Error ? caught.message : String(caught);
        this.recordInterrupt(taskId, mode, source, "abort-failed", error);
        throw caught;
      }
      return;
    }
    this.recordInterrupt(taskId, mode, source, "no-turn");
  }

  /**
   * update_task withdraw_merge (FI3-304 section 6): the captain takes back
   * a merge he clicked. The work stays where it is; the task's merge is
   * his again, past project autonomy, until he clicks a new completion card.
   */
  withdrawMergeApproval(taskId: string): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = `${record.key || record.id} "${record.title}"`;
    const ended = this.settling.approvals.endAuthorization(
      taskId,
      "revoked",
      "the captain withdrew it",
      {
        holds: true,
        feed: true,
      },
    );
    if (ended) this.announceReach(taskId);
    return ended
      ? {
          ok: true,
          text: `Withdrew the captain's kept merge approval on ${handle}. Its work stays; only their new merge click merges it.`,
        }
      : { ok: false, text: `${handle} has no kept merge approval to withdraw.` };
  }

  /** The interrupt request or outcome's timeline event (R2 forward capture). */
  private recordInterrupt(
    taskId: string,
    mode: "interrupt" | "cancel",
    source: InterruptSource,
    effect: InterruptEventData["effect"],
    error?: string,
  ): void {
    // An interruption withdraws the captain's kept merge approval (FI3-304:
    // interrupt = revoke); resuming work needs a new click.
    this.settling.approvals.revokeMergeAuthorization(
      taskId,
      source.actor === "captain"
        ? "the captain interrupted the crewmate"
        : "the first mate interrupted the crewmate",
    );
    try {
      this.options.tasks.turns.recordInterrupt(taskId, {
        actor: source.actor,
        mode,
        effect,
        via: source.via,
        decision: source.decision,
        error,
        ...(source.panel ? { panel: source.panel } : {}),
        ...(source.backlog ? { backlog: true as const } : {}),
      });
    } catch (caught) {
      console.warn("[crew] interrupt capture failed:", caught);
    }
  }

  /**
   * The live crew registry: open rows waiting to start and active rows -
   * a runtime's live state when one exists, else the durable record's own
   * (an idle or interrupted crewmate a previous process left is still
   * steerable, and its last report rides the record across the restart).
   * Closed rows (done, dropped) are history, not crew.
   */
  escalationEligible(taskId: string): boolean {
    const task = this.options.tasks.resolve(taskId);
    return task ? premiumRetryPossible(task) : true;
  }

  premiumCanServe(): boolean {
    return this.hooks.premiumCanServe?.() !== false;
  }

  noteUnsupportedSpeed(taskId: string, requested: CrewSpeed): void {
    const model = this.tasks.get(taskId)?.session?.modelRef();
    if (requested !== "standard" && model && model.provider !== "openai-codex")
      this.noteSpeed(taskId, model, {
        requested,
        sent: "standard",
        reason: "this is not a Codex model",
      });
  }

  private noteSpeed(
    taskId: string,
    model: { provider: string; id: string },
    selection: SpeedSelection,
  ): void {
    const task = this.options.tasks.get(taskId);
    if (!task) return;
    const text = speedNote(model, selection);
    this.options.tasks.note(taskId, text, { news: true, data: { speed: { ...selection, model } } });
    if (selection.reason && !selection.confirmed)
      this.options.broadcastEvent({
        type: "firstmate_note",
        taskId,
        text: `${task.title}: ${text}`,
      });
  }

  crewStatus(taskId?: string, options: { startedOnly?: boolean } = {}): CrewStatusEntry[] {
    return this.options.tasks.readProjection(() =>
      this.readCrewStatus(taskId, options.startedOnly),
    );
  }

  private readCrewStatus(taskId?: string, startedOnly = false): CrewStatusEntry[] {
    const records = taskId
      ? [this.options.tasks.get(taskId)].flatMap((r) => (r ? [r] : []))
      : startedOnly
        ? this.options.tasks.listActive()
        : this.options.tasks.listLive();
    // A decision row or a host card's row is its card, not crew work.
    const crew = records
      .filter((record) => !startedOnly || record.status === "active")
      .filter((record) => record.kind !== "decision" && record.kind !== "operation")
      .filter(
        (record) =>
          this.tasks.has(record.id) || record.status === "open" || record.status === "active",
      );
    const threads = this.cards.threadFacts(crew.map((record) => record.id));
    return crew.map((record) => {
      const runtime = this.tasks.get(record.id);
      const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
      const reportText = runtime?.lastCompleteText || record.outcome || "";
      const lastReport = reportText ? capWithOverflow(reportText, "crew-status-report") : undefined;
      const starting = this.options.tasks.starts.startAttemptOf(record.id);
      const queueWait =
        starting || !hasStartQueueWait(record)
          ? undefined
          : queueWaitOf(
              record,
              this.options.tasks.graph.blockers(record.id),
              this.options.tasks.graph.linksTo(record.id),
              this.options.tasks.graph.children(record.id),
            );
      // A started task in the backlog (INF-2062) waits for start_now, with how long it has.
      const backlog =
        record.status === "active" && record.backlogSince != null
          ? `started, in the backlog ${formatDurationShort(Math.max(0, this.now() - record.backlogSince))}; start_now picks it up`
          : undefined;
      const gate = starting
        ? undefined
        : (backlog ??
          queueWait?.line ??
          (record.status === "open"
            ? record.gate
              ? gateText(record.gate)
              : (this.waitingOnBlockers(record) ??
                (record.startPolicy === "on-request" ? "starts on request" : undefined))
            : undefined));
      const computer = this.taskComputer(record);
      const rigor = this.options.tasks.policiesOf(record)?.rigor.value;
      const review = this.reviewState(record);
      const thread = threads.get(record.id);
      const restart = this.restarts.restartFact(record.id);
      const now = this.now();
      const stalledSince = this.ladder.stalledSince(record, now);
      const stalled = stalledSince ? this.ladder.stalledFact(record, now, stalledSince) : undefined;
      const timing = this.timingFacts(record);
      const refused = record.delivery?.cardRefusal;
      const ci = this.options.tasks.projectedFact(record, this.ciFact, () =>
        ciFactOf(record.delivery, this.now()),
      );
      const override = standingOverride(record.delivery, record.delivery?.headSha);
      // A personal task carries no delivery: it builds in place, and
      // saying "local-only" here would be a posture the Firstmate could
      // act on. The brief omits the line for the same reason.
      const delivery =
        repo?.kind === "personal" ? undefined : deliveryForRecord(record, repo?.delivery);
      // Where its proposed change goes, in the person's word for the host
      // (git integration PR 1.3) - only where one goes somewhere.
      const goesIn =
        opensPullRequest(delivery) && repo?.host
          ? forgePlace({ kind: repo.host.kind, host: repo.host.name })
          : null;
      return {
        taskId: record.id,
        key: record.key,
        title: record.title,
        status: backlog
          ? "backlog"
          : runtime
            ? runtime.state === "idle"
              ? "idle"
              : "running"
            : record.status === "open"
              ? "queued"
              : (record.activity ?? "idle"),
        ...(runtime ? { crewmate: runtime.crewmate } : {}),
        repoName: repo?.name ?? "default workspace",
        branch: record.branch,
        ...(gate ? { gate } : {}),
        ...(computer ? { computer } : {}),
        ...(lastReport ? { lastReport } : {}),
        ...(restart ? { restart } : {}),
        premiumRetryEligible: premiumRetryPossible(record),
        ...(rigor ? { rigor } : {}),
        ...(review ? { review } : {}),
        ...(thread ? { thread } : {}),
        ...(stalled ? { stalled } : {}),
        ...timing.words,
        ...(Object.keys(timing.times).length > 0 || stalledSince
          ? {
              times: {
                ...timing.times,
                ...(stalledSince
                  ? { stalledSince: stalledSince.since, stalledWakes: stalledSince.wakes }
                  : {}),
              },
            }
          : {}),
        ...(override
          ? {
              override: {
                passes: `${holdNames(override.holds)} ${overrideSpan(override)}`,
                words: override.words,
              },
            }
          : {}),
        ...(refused
          ? {
              cardRefused: {
                title: refused.title,
                at: new Date(refused.at).toISOString(),
                reason: refused.reason,
                why: refused.why,
              },
            }
          : {}),
        ...(delivery ? { delivery } : {}),
        ...(goesIn ? { goesIn } : {}),
        ...(ci ? { ci } : {}),
        // Autonomy answers "who merges this", so it is absent wherever
        // there is no merge: the personal workspace, and an answer task,
        // which the deliverable hold refuses to merge whoever asks. The
        // rigor above is absent on the same rows for the same reason.
        ...(repo?.kind === "personal" || deliverableOf(record) !== "change"
          ? {}
          : { autonomy: autonomyForRecord(record, repo?.autonomy) }),
      };
    });
  }

  /**
   * The durations a crew line reads rather than guesses (INF-1244): the
   * oldest job still running and its age, how long ago the crewmate last
   * reported, and the check-back its report named.
   */
  private timingFacts(record: TaskRecord): {
    words: Pick<CrewStatusEntry, "job" | "waiting" | "reported" | "checkBack">;
    times: NonNullable<CrewStatusEntry["times"]>;
  } {
    const now = this.now();
    const running =
      record.status === "active" &&
      (this.options.hasRunningJobs?.(record.id) === true ||
        this.clientJobStart(record.id) !== undefined);
    const job = running ? this.oldestJob(record.id) : undefined;
    const reportedAt =
      record.status === "active" ? this.options.tasks.lastReportAt(record.id) : undefined;
    const back = record.delivery?.checkBack;
    const waiting = record.status === "active" ? this.namedWait(record.id) : undefined;
    const times: NonNullable<CrewStatusEntry["times"]> = {
      ...(job
        ? { jobSince: job.startedAt, job: job.command.replace(/\s+/g, " ").slice(0, 80) }
        : {}),
      ...(waiting?.calls.length ? { calls: waiting.calls } : {}),
      ...(waiting?.steers
        ? { steersUnread: waiting.steers, steersSince: waiting.steersSince }
        : {}),
      ...(reportedAt !== undefined ? { reportedAt } : {}),
      ...(back ? { checkBackUntil: back.until, checkBackFor: back.waitingFor } : {}),
    };
    const words = {
      ...(job
        ? {
            job: `running ${formatDurationShort(now - job.startedAt)}: ${job.command.replace(/\s+/g, " ").slice(0, 80)}`,
          }
        : {}),
      ...(waiting?.words ? { waiting: waiting.words } : {}),
      ...(reportedAt !== undefined
        ? { reported: `${formatDurationShort(now - reportedAt)} ago` }
        : {}),
      ...(back
        ? {
            checkBack:
              back.until > now
                ? `in ${formatDurationShort(back.until - now)}: ${back.waitingFor}`
                : `due ${formatDurationShort(now - back.until)} ago: ${back.waitingFor}`,
          }
        : {}),
    };
    return { words, times };
  }

  /**
   * The computer a task runs on, for the first mate (INF-992): the one its
   * place names, else this computer once it started here. Absent while no
   * computer that runs work is listed, and for an unstarted task whose
   * computer is not chosen yet.
   */
  private taskComputer(record: TaskRecord): string | undefined {
    if (!this.options.machines || this.options.machines.computers().length === 0) return undefined;
    const place = this.placement.taskPlace(record);
    if (place) return place.name;
    return record.status === "open" ? undefined : HERE.this;
  }

  /** An open row's wait on its blockers, phrased; empty when none remain. */
  private waitingOnBlockers(record: TaskRecord): string | undefined {
    const waiting = this.options.tasks.graph
      .blockers(record.id)
      .filter((blocker) => !TaskService.blockerCleared(blocker));
    return waiting.length > 0 ? blockedText(waiting) : undefined;
  }

  /**
   * Non-terminal tasks bound to a repo: the project-removal guard.
   * Queued rows count - their dispatch would land on a missing registration.
   */
  activeTasksOnRepo(
    repoId: string,
  ): { key: string; title: string; status: "planned" | "working" }[] {
    return this.options.tasks
      .list()
      .filter(
        (record) =>
          record.repoId === repoId &&
          // Interrupted tasks are resumable (boot recovery), so their repo
          // is still in use - unregistering under them would strand them.
          (record.status === "open" || record.status === "active"),
      )
      .map((record) => ({
        key: record.key,
        title: record.title,
        status: record.status === "open" ? ("planned" as const) : ("working" as const),
      }));
  }

  /** A task's delivery posture: the merge mode a settle resolves to, and the settle-facts strip. */
  taskDelivery(taskId: string): RepoDelivery | undefined {
    const record = this.options.tasks.get(taskId);
    if (!record) return undefined;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    return deliveryForRecord(record, repo?.delivery);
  }

  private applyEvent(task: TaskRuntime, event: FmEvent): void {
    switch (event.type) {
      case "assistant_delta": {
        task.currentTurnText += event.text;
        break;
      }
      case "turn_failed": {
        // Held on the runtime until the prompt resolves; turnComplete turns
        // it into the failure report instead of "(no report)".
        task.lastTurnError = event.error;
        task.lastTurnCutOff = event.cutOff;
        break;
      }
      case "tool_start": {
        task.openCalls.set(event.callId, { tool: event.toolName, since: this.now() });
        break;
      }
      case "tool_end": {
        task.openCalls.delete(event.callId);
        if (event.usage) this.recordUsage(task, event.usage);
        break;
      }
      case "turn_end": {
        // Only a turn's FINAL message can be its report (WI-1): each turn
        // end overwrites the candidate with the text it streamed, and the
        // session's own closing words for it (turn_closed, `follow`) then
        // stand in its place.
        task.turnReport = task.currentTurnText.trim() ? task.currentTurnText : undefined;
        task.currentTurnText = "";
        if (event.usage) this.recordUsage(task, event.usage);
        break;
      }
      default:
        break;
    }
  }

  /**
   * The captain's reply, typed under a card. A crewmate card's reply is a
   * captain steer to that crewmate - the same control-plane path a card
   * click takes, stamped `via: "thread"`. A Firstmate card's reply is a
   * captain turn about that card. It resolves nothing: the card's buttons
   * stay pinned and the decision is still his to make.
   *
   * Delivery is not awaited, exactly as a card click's round-trip is not:
   * the message is on the record the moment it is typed, and a delivery
   * failure is a feed line rather than a lost reply. Images ride where the
   * session can carry them.
   */
  replyToCard(
    cardId: string,
    rawText: string,
    images?: TurnImage[],
    submission?: unknown,
    answers?: CardAnswer[],
    files?: { text: string; name?: string }[],
  ): CardThread {
    const id = cardId.trim();
    const card = this.cards.get(id);
    if (!card) {
      throw new Error(
        this.cards.stored(id)
          ? `Card "${id}" is closed; its thread takes no more replies.`
          : `Unknown card "${id}".`,
      );
    }
    if (!cardTakesReplies(card)) {
      throw new Error(
        card.replies === false
          ? `Card "${id}" takes no reply.`
          : `Card "${id}" has no author to reply to.`,
      );
    }
    const typed = rawText.trim();
    const hasImages = Boolean(images?.length);
    if (!typed && !hasImages && !files?.length) throw new Error("A reply needs some words.");
    if (typed.length > CARD_REPLY_MAX_CHARS) {
      throw new Error(`A reply is at most ${CARD_REPLY_MAX_CHARS} characters.`);
    }
    if (answers) {
      cardAnswersSchema.parse(answers);
      if (cardAnswersBytes(answers) > CARD_ANSWERS_MAX_BYTES) {
        throw new Error(CARD_ANSWERS_TOO_LONG);
      }
    }
    const messageFiles: MessageFile[] = [];
    const text = withPastedFiles(typed, files, messageFiles);
    const context = replyWithSettings(text, answers);
    // The thread names what rode along: a picture is a line, never markup.
    // The row keeps the text as the author read it; the thread reads the
    // settings back apart from his words (`CardStore.messages`, FI3-617).
    const shown = hasImages
      ? `${context}${context ? "\n" : ""}[attached ${attachmentWords(
          (images ?? []).map((image) => ({ name: image.name || image.mimeType.slice(6) })),
        )}]`
      : context;
    // A note its closed task kept has no crewmate left to answer: the
    // Firstmate takes the reply, as it does on its own card.
    const closedTask = card.taskId ? this.options.tasks.get(card.taskId) : undefined;
    // The host's stuck alert names the first mate as its answerer (INF-1670).
    const toFirstmate =
      card.author === "firstmate" ||
      card.answeredBy === "firstmate" ||
      (closedTask !== undefined && TaskService.isClosed(closedTask));
    // An accepted reply to a crewmate owns copies of its pictures before the
    // thread or the lane records it (the Firstmate's own turn keeps its own).
    const kept =
      hasImages && !toFirstmate && card.taskId ? keepImages(randomUUID(), images ?? []) : undefined;
    const asked = this.cards.addMessage(
      id,
      "captain",
      shown || "sent a picture",
      submission,
      answers,
    );
    if (toFirstmate) {
      this.hooks.converseAboutCard?.(
        id,
        context,
        hasImages ? images : undefined,
        ...(messageFiles.length ? [messageFiles] : []),
      );
      return this.cards.thread(id);
    }
    const taskId = card.taskId;
    if (taskId) {
      // The card stays shown with its thread while its author answers;
      // this one line is the send's record in the feed (the captain's Q2 A).
      const crewmate = this.tasks.get(taskId)?.crewmate ?? "the crewmate";
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: askedUnderCardLine(crewmate, card.title),
      });
      const reply: TypedWake = {
        facts: {
          kind: "thread-reply",
          card: {
            id: card.id,
            title: card.title,
            messageId: asked.id,
            ...(card.lifecycleId ? { lifecycle: card.lifecycleId } : {}),
          },
          words: text,
          answers,
        },
      };
      void this.steerCrewmate(taskId, reply, "captain", {
        via: "thread",
        cardId: id,
        images: hasImages ? images : undefined,
        attachments: kept,
      }).catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        this.options.broadcastEvent({
          type: "firstmate_note",
          text: `Could not deliver the reply on "${card.title}": ${message}`,
          taskId,
        });
      });
    }
    return this.cards.thread(id);
  }

  private finish(task: TaskRuntime, status: "cancelled" | "failed", error?: string): void {
    // The turn a settle stopped ends before or after that settle's close,
    // as its backend goes. Either way the close keeps its own reason and
    // hands on what it carries - the captain's choice on an answer reaches
    // the first mate - so this end neither closes the record cancelled nor
    // purges what is queued about it (INF-721: a choice outranks a cancel).
    // The settle releases the runtime once the abort returns.
    if (task.settling) return;
    // A runtime no longer in the crew has ended already: a cancel ended it
    // when its abort returned, before the turn it stopped came to an end.
    // Ending it again would announce a second finish, and could close or
    // purge what a runtime now holding its place carries.
    if (this.tasks.get(task.id) !== task) return;
    // A finished task's background jobs die with it, quietly (R2).
    this.options.killJobs?.(task.id);
    // This is a terminal close, not an idle boundary: closeRecord retires
    // its cards without presenting work the captain can no longer answer.
    // Rows the final turn consumed reached the transcript; they are not
    // "never delivered" even when that turn failed - the failure op above
    // already reports it. What was still waiting on the lane is, and so is
    // a steer the session accepted that no turn took in.
    const unread = this.undeliveredSteerRows(task);
    if (task.inFlightInboxIds.length > 0) {
      this.options.inbox.ack(task.inFlightInboxIds.filter((id) => !unread.includes(id)));
      this.options.inbox.reparkUndelivered(unread);
      task.inFlightInboxIds = [];
    }
    const undeliveredRows = this.options.inbox.allFor(task.id);
    if (undeliveredRows.length > 0) {
      // The task ended before its recorded guidance could become a turn.
      // Saying so is the whole point of recording it visibly - on the task's
      // own timeline, which keeps the guidance, and as one feed line; never
      // a Firstmate wake about a task that is closing (WI-5).
      this.recordUndeliveredGuidance(
        task.id,
        task.title,
        `the task ${status} first`,
        undeliveredRows,
      );
    }
    this.releaseSession(task);
    this.tasks.delete(task.id);
    this.settling.locks.releaseSettleBoundary(task.id);
    this.options.personal?.endLiveTask(task.id);
    // A record another close already ended keeps its own reason; the turn's
    // end must not relabel it. Either way nothing queued about the task
    // survives.
    const record = this.options.tasks.get(task.id);
    if (record && (record.status === "open" || record.status === "active")) {
      // A typed backend's session failure has no class: it is never read as
      // a sign-in or an allowance from its words (a client exit is a session
      // failure, docs/quota.md "Typed cut-offs").
      const typed = task.session?.controlProfile.failureSignals === "typed" ? {} : undefined;
      this.settling.closing.closeRecord(task.id, status, error, "host", typed);
    } else {
      this.options.inbox.purgeTask(task.id);
    }
    if (status === "failed") {
      // After the purge and straight to the Firstmate: the task is closed,
      // so a triage wake would be set aside unread (WI-2), and a terminal
      // failure is the captain's to hear.
      this.hooks.notifyOp(
        {
          facts: {
            kind: "task-failed",
            task: { id: task.id, title: task.title },
            error: capWithOverflow(error ?? "unknown error", "task-failed"),
          },
        },
        "agent",
        task.id,
      );
    }
    this.options.broadcastEvent({
      type: "task_finished",
      taskId: task.id,
      status,
      title: task.title,
      ...(error ? { error } : {}),
    });
    this.broadcastCrewCounts();
    // A finished task may be the gate a queued row waits on (R1).
    void this.sweepGates(this.now());
  }

  /** Stop a task's live crewmate: its turn aborted, its runtime gone. */
  private stopRuntime(taskId: string): Promise<void> | undefined {
    const runtime = this.tasks.get(taskId);
    if (!runtime) return undefined;
    runtime.cancelled = true;
    runtime.settling = true;
    return (async () => {
      await runtime.session?.abort().catch(() => {});
      this.releaseSession(runtime);
      this.tasks.delete(taskId);
    })();
  }

  /**
   * Let go of a crewmate's session: the task stops hearing it and the
   * session is disposed. A turn it is still settling is owed to the usage
   * ledger - an interrupted Claude turn reports its tokens and cost only in
   * the result that arrives after the interrupt's round trip - so a
   * usage-only listener takes the task's place until the session is gone.
   * Only usage: the task is closing, and its state, feed and cards are not
   * the settling turn's to change. A turn that already settled was recorded
   * by the task's own subscriber and emits nothing more, so nothing is
   * counted twice.
   */
  private releaseSession(runtime: TaskRuntime): void {
    const session = runtime.session;
    this.turnOver(runtime.id);
    // A copy replaced by an update waits for every client to be gone, so
    // each conversation is written down before the new copy reads it.
    if (session?.isStreaming() || (session && this.updates.savedHere())) {
      const unsubscribe = session.subscribe((event) => {
        if ((event.type === "turn_end" || event.type === "tool_end") && event.usage) {
          this.recordUsage(runtime, event.usage);
        }
      });
      const released: Promise<void> = session
        .closed()
        .catch(() => {})
        .then(() => {
          unsubscribe();
          this.releasing.delete(released);
        });
      this.releasing.add(released);
    }
    const following = runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    if (following) {
      const released = following.finally(() => this.releasing.delete(released));
      this.releasing.add(released);
    }
    session?.dispose();
  }

  /**
   * The model answering for a crewmate, kept on its task's record whenever
   * the record names another (FI3-967): the record, and so the fact strip
   * and the crew's labels, name the model doing the work, and the timeline
   * and the feed say what moved it - the backend's own fallback, or a
   * reattach that asked for the routed model again. The routing ledger keeps
   * the router's decision as it was made. A record that named no model
   * learns it without a line: nothing moved.
   */
  private recordServedModel(
    task: TaskRuntime,
    event: Extract<SessionEvent, { type: "model_served" }>,
  ): void {
    const record = this.options.tasks.get(task.id);
    if (!record || TaskService.isClosed(record)) return;
    const served = `${event.model.provider}/${event.model.id}`;
    if (record.model === served) return;
    this.noticeUnaskedModel(task, record, event);
    if (!record.model) {
      this.options.tasks.starts.recordServedModel(task.id, event.model);
      return;
    }
    const name = (ref: { provider: string; id: string }) =>
      this.options.router?.modelLabel(ref) ?? ref.id;
    const slash = record.model.indexOf("/");
    const was =
      slash > 0
        ? { provider: record.model.slice(0, slash), id: record.model.slice(slash + 1) }
        : undefined;
    const fallback = event.fallback;
    const from = fallback?.from ?? was;
    this.options.tasks.starts.recordServedModel(task.id, event.model, {
      text: modelMoveWords({
        from: from ? name(from) : record.model,
        to: name(event.model),
        fallback: fallback !== undefined,
      }),
      data: {
        servedModel: served,
        from: record.model,
        ...(fallback
          ? {
              fallback: {
                from: `${fallback.from.provider}/${fallback.from.id}`,
                ...(fallback.category ? { category: fallback.category } : {}),
              },
            }
          : {}),
      },
    });
  }

  /**
   * The first mate is told once when a task answers on a model its routing
   * did not choose (INF-1272): both models, why, and whether the captain
   * named the one asked for, so it can tell them. An answer back on the
   * asked model, or on a task that never routed, says nothing.
   */
  private noticeUnaskedModel(
    task: TaskRuntime,
    record: TaskRecord,
    event: Extract<SessionEvent, { type: "model_served" }>,
  ): void {
    const asked = this.options.router?.servedChoice(task.id)?.model;
    if (!asked || offeringKey(asked) === offeringKey(event.model)) return;
    const named = record.shape?.override_model_id;
    const category = event.fallback?.category;
    this.hooks.notifyOp(
      {
        facts: {
          kind: "model-unasked",
          task: { id: record.id, key: record.key || record.id, title: record.title },
          asked: this.modelName(asked),
          served: this.modelName(event.model),
          cause: event.fallback ? "fallback" : "client",
          ...(category ? { category } : {}),
          named:
            named !== undefined &&
            (named.includes("/") ? named === offeringKey(asked) : named === asked.id),
        },
        once: `model-unasked:${offeringKey(asked)}:${offeringKey(event.model)}`,
      },
      "agent",
      record.id,
    );
  }

  /** One settled turn's tokens and cost, on the account and model that served it. */
  private recordUsage(
    task: TaskRuntime,
    usage: NonNullable<Extract<FmEvent, { type: "turn_end" }>["usage"]>,
  ): void {
    const model = task.session?.modelRef();
    const accountId = this.servingAccount(task);
    this.options.recordUsage?.({
      taskId: task.id,
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      usage,
    });
  }

  /**
   * The account a task's turns are served by: the account picked here for a
   * task on this Mac, and for a task on another computer that computer's
   * own, as it said - never the account this Mac picked for it
   * (docs/helper.md, "Its own sign-ins").
   */
  private servingAccount(task: TaskRuntime): string | undefined {
    if (this.machineOf(task.id) === LOCAL_MACHINE_ID) return task.accountId;
    return task.session ? this.options.machines?.servingAccount(task.session) : undefined;
  }

  /** A task's title for a feed line, or what the caller had when there is no record. */
  private taskTitle(taskId: string | null | undefined): string {
    if (!taskId) return "a task";
    return this.options.tasks.get(taskId)?.title ?? taskId;
  }

  /**
   * Boot-time fleet reconciliation (WI-7). Closed rows still holding a
   * worktree retire it, and so does every directory under the worktrees
   * area that no record explains - the same rule as a close: the work is
   * saved on a hidden kept ref first, and only a failed save keeps a tree.
   * Every `fm/task-*` branch that no live row explains - no record at all,
   * or a row that is closed without a worktree, or open and not yet
   * started - is REPORTED as one feed line and never deleted: a branch can
   * carry work only a person should throw away.
   */
  async reconcileFleetHygiene(): Promise<void> {
    const kept: TaskRecord[] = [];
    for (const record of this.options.tasks.list()) {
      if (record.kind !== "work" || !record.worktreeDir || record.workspaceState !== "present") {
        continue;
      }
      if (record.status !== "done" && record.status !== "dropped") continue;
      if ((await this.settling.closing.retireWorkspace(record.id, { noteKept: false })) === "kept")
        kept.push(record);
    }
    const orphansKept = await this.retireOrphanWorktrees();
    const repoDirs = new Map<string, string>();
    if (existsSync(join(this.options.paths.defaultWorkspaceDir, ".git"))) {
      repoDirs.set(this.options.paths.defaultWorkspaceDir, "default workspace");
    }
    for (const repo of this.options.repos.list()) repoDirs.set(repo.path, repo.name);
    const leftovers: string[] = [];
    for (const [repoDir, repoName] of repoDirs) {
      for (const { branch, taskId } of await this.options.workspace.listTaskBranches(repoDir)) {
        const record = this.options.tasks.get(taskId);
        const explained =
          record && (record.status === "active" || record.workspaceState === "present");
        if (explained) continue;
        leftovers.push(
          `${branch} in ${repoName} (${record ? `"${record.title}", ${describeStatus(record)}` : "no task record"})`,
        );
      }
    }
    const parts: string[] = [];
    if (leftovers.length > 0) {
      parts.push(
        `${leftovers.length} leftover working ${leftovers.length === 1 ? "copy" : "copies"} kept, not deleted: ${listSome(leftovers)}`,
      );
    }
    if (kept.length > 0) {
      parts.push(
        `${kept.length} closed ${kept.length === 1 ? "task keeps its working copy because its work could not be saved first" : "tasks keep their working copies because their work could not be saved first"}: ${listSome(kept.map((record) => `"${record.title}"`))}`,
      );
    }
    if (orphansKept.length > 0) {
      parts.push(
        `${orphansKept.length} ${orphansKept.length === 1 ? "working copy with no task is kept because its work" : "working copies with no task are kept because their work"} could not be saved first: ${listSome(orphansKept)}`,
      );
    }
    if (parts.length > 0) {
      this.options.broadcastEvent({ type: "firstmate_note", text: `${parts.join("; ")}.` });
    }
  }

  /**
   * Boot: a directory under the worktrees area that no record explains -
   * its record purged, a close whose removal never finished, a crash
   * between creating a tree and recording it - retires like a closed
   * task's: work saved on the kept ref named for the directory, then
   * removed. A tree a live or dispatching row might own is never touched,
   * and neither is one whose work cannot be saved. Answers the names kept.
   */
  private async retireOrphanWorktrees(): Promise<string[]> {
    const explained = (name: string): boolean => {
      if (this.tasks.has(name)) return true;
      const own = this.options.tasks.get(name);
      if (own && (!TaskService.isClosed(own) || own.workspaceState === "present")) return true;
      const dir = resolvePath(this.options.paths.worktreesDir, name);
      return this.options.tasks
        .list()
        .some(
          (record) =>
            record.workspaceState === "present" &&
            Boolean(record.worktreeDir) &&
            resolvePath(record.worktreeDir) === dir,
        );
    };
    const kept: string[] = [];
    for (const name of this.options.workspace.listWorktreeDirs()) {
      if (explained(name)) continue;
      const workspace = await this.options.workspace.workspaceAt(name);
      // A dispatch may have claimed the name while git was awaited.
      if (explained(name)) continue;
      if (!workspace) {
        if (!(await this.options.workspace.removeEmptyWorktreeDir(name))) {
          console.warn(`[workspace] kept ${name}: not a working copy of its own`);
          kept.push(name);
        }
        continue;
      }
      const retired = await this.options.workspace
        .retireTaskWorktree(workspace)
        .catch((caught): { outcome: "kept"; reason: string } => ({
          outcome: "kept",
          reason: caught instanceof Error ? caught.message : String(caught),
        }));
      if (retired.outcome === "kept") kept.push(name);
      else if (retired.kept) {
        console.info(`[workspace] removed ${name}; its work is saved at ${retired.kept.ref}`);
      }
    }
    return kept;
  }

  /**
   * A session event or a running background job means the crewmate is alive:
   * reset the quiet escalation.
   */
  private noteTaskActivity(task: TaskRuntime): void {
    task.lastEventAt = this.now();
    task.quietLevel = 0;
    task.waitNamed = undefined;
  }

  /** A turn began or ended: nothing it had open, or was handed, waits any more. */
  private clearWait(task: TaskRuntime): void {
    task.openCalls.clear();
    task.unreadSteers = [];
    task.steersAtCheck = undefined;
    task.waitNamed = undefined;
    task.readsAnsweredAt = undefined;
  }

  /**
   * A background job's exit becomes the crewmate's next turn (R2), through
   * the durable inbox: recorded on the task's lane, delivered now on an
   * idle session, at turn end behind a streaming one, after a resume for a
   * task a previous process left idle - and never silently dropped, because
   * the row outlives any failed delivery and the quit itself. `result` is
   * the typed `job-exit` wake; the replay hands over the recorded text.
   */
  deliverJobResult(taskId: string, result: WakeBody): void {
    const task = this.tasks.get(taskId);
    if (task?.session && !task.cancelled) {
      this.noteTaskActivity(task);
      this.options.inbox.enqueue(taskId, result);
      if (task.state === "idle") this.deliverPendingToTask(task);
      return;
    }
    const record = this.options.tasks.get(taskId);
    if (record && TaskService.isResumable(record) && record.sessionFile) {
      this.options.inbox.enqueue(taskId, result);
      // A held lane keeps it until its account serves again, or until a
      // started task in the backlog is started again.
      if (this.laneHeld(taskId) || this.inBacklog(taskId)) return;
      void this.resumeTask(taskId)
        .then((resumed) => this.deliverPendingToTask(resumed))
        .catch(() => {
          // The row is durable; the tick sweep retries the resume.
        });
      return;
    }
    // The task ended first (WI-2): nothing from a dead task wakes anyone.
    // One self-contained feed line says the job finished; its output is moot.
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `A background job finished after ${record ? `"${record.title}"` : `task ${taskId}`} ended; its output was set aside.`,
      taskId,
    });
  }

  /**
   * The shared tick (P4 + R1 + the inbox ladder) on the host's one ticker;
   * start once from main. The order is the contract: the idle ladder's
   * reconcile (with the job bound it reads) runs before the gate sweep.
   */
  startWatchdog(ticker: Ticker): void {
    if (this.watchdog) return;
    this.watchdog = [
      ticker.register("quiet-turns", WATCHDOG_TICK_MS, (now) => this.checkQuietTasks(now)),
      ticker.register("idle-ladder", WATCHDOG_TICK_MS, (now) => this.reconcileIdle(now)),
      ticker.register("firstmate-quiet", WATCHDOG_TICK_MS, (now) => this.hooks.checkQuiet?.(now)),
      ticker.register("gate-sweep", WATCHDOG_TICK_MS, (now) => void this.sweepGates(now)),
      ticker.register(
        "in-place-folders",
        WATCHDOG_TICK_MS,
        () => void this.inPlaceWork.closeCurrentFolders(),
      ),
      ticker.register("check-watch", WATCHDOG_TICK_MS, (now) => void this.pollCheckWatches(now)),
      ticker.register("kept-merges", WATCHDOG_TICK_MS, (now) =>
        this.settling.kept.reconcileMergeAuthorizations(now),
      ),
      ticker.register("inbox-sweep", WATCHDOG_TICK_MS, (now) => void this.sweepInbox(now)),
      ticker.register("firstmate-inbox", WATCHDOG_TICK_MS, () => this.hooks.pokeInbox?.()),
      ticker.register("watchdog-riders", WATCHDOG_TICK_MS, (now) =>
        this.options.onWatchdogTick?.(now),
      ),
    ];
  }

  /**
   * The durable-inbox re-ring ladder (design A): one pass over every task
   * lane holding undelivered rows. Rows past their grace get one delivery
   * attempt; rows whose attempt budget is spent escalate loudly - once -
   * and stop retrying; rows for a task that no longer exists become one
   * honest firstmate notice. The firstmate lane is the agent's own to
   * drain; the tick only pokes it (startWatchdog).
   */
  /**
   * Name the crew a restart cut, including turns still running elsewhere.
   * The announcement records pending observation, never proof of recovery.
   * Session events and the existing boot sweep supply the outcome; writing
   * or reading the facts never sends guidance or wakes either agent.
   */
  announceCarryOn(): void {
    const carrying: TaskRecord[] = [];
    const recipients = new Set([
      ...this.options.inbox.recipientsWithRows(),
      ...this.options.tasks
        .listActive()
        .filter((record) => record.activity === "running")
        .map((record) => record.id),
    ]);
    for (const recipient of recipients) {
      if (recipient === FIRSTMATE_RECIPIENT || recipient === SUPERVISION_RECIPIENT) continue;
      const record = this.options.tasks.get(recipient);
      if (!record || TaskService.isClosed(record)) continue;
      // A started task in the backlog does not carry on (INF-2062).
      if (record.backlogSince != null) continue;
      const cut = this.options.inbox
        .allFor(recipient)
        .some((row) => row.cuts > 0 || row.facts?.kind === "turn-resumed");
      if (cut || record.activity === "running") {
        carrying.push(record);
        if (!this.restarts.observing(record.id)) {
          this.restarts.observe(record.id);
          this.restarts.recordRestartOutcome(
            record.id,
            "pending",
            "automatic recovery has not started a request yet",
          );
        }
      }
    }
    if (carrying.length === 0) return;
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: carryOnWords(
        carrying.map((record) => ({ key: record.key || record.id, title: record.title })),
      ),
    });
  }

  async sweepInbox(now: number): Promise<void> {
    if (this.sweepingInbox) return;
    this.sweepingInbox = true;
    try {
      for (const recipient of new Set([
        ...this.options.inbox.recipientsWithRows(),
        ...this.restarts.observed(),
      ])) {
        // The firstmate lane is the agent's own to drain; the tick pokes it
        // separately (startWatchdog). The retired supervision lane is
        // skipped so leftover rows are never swept as a task's - boot
        // reassigns them to the Firstmate instead (S7c, `bootRecovery.ts`).
        if (recipient === FIRSTMATE_RECIPIENT || recipient === SUPERVISION_RECIPIENT) continue;
        await this.sweepTaskLane(recipient, now);
      }
    } finally {
      this.sweepingInbox = false;
    }
  }

  private async sweepTaskLane(taskId: string, now: number): Promise<void> {
    const spent = this.options.inbox.spent(taskId, INBOX_ATTEMPT_MAX);
    if (spent.length > 0) this.escalateTaskGuidance(taskId, spent);
    // A started task in the backlog keeps its lane until a Start (INF-2062).
    if (this.inBacklog(taskId)) return;
    if (this.restarts.observing(taskId) && this.laneHeld(taskId))
      this.restarts.recordRestartOutcome(
        taskId,
        "waiting",
        this.outOfReach(taskId)
          ? "its computer is out of reach or still catching up"
          : "its subscription is waiting for its sign-in or allowance",
      );
    const due = this.deliverableRows(taskId, now);
    if (due.length === 0) return;
    const task = this.tasks.get(taskId);
    if (task) {
      if (task.cancelled || !task.session) return;
      if (this.laneHeld(taskId)) return;
      if (task.state === "idle") {
        this.deliverPendingToTask(task);
        return;
      }
      // Streaming: a due row here is a failed native steer past its grace.
      // A followup-queue backend's rows simply wait for the turn to end.
      if (task.session.controlProfile.steer !== "native") return;
      const pictures = this.rowPictures(taskId, due);
      if (pictures.blocked) return;
      const ids = this.deliverRows(taskId, due);
      try {
        await this.steerIntoTurn(task, task.session, laneTurnText(due), ids, pictures.images);
      } catch {
        this.options.inbox.release(ids);
      }
      return;
    }
    const record = this.options.tasks.get(taskId);
    if (record?.status === "open") return; // waits for dispatch
    if (!record || TaskService.isClosed(record)) {
      this.orphanTaskGuidance(taskId, record);
      return;
    }
    // A missing local conversation is not a closed task. A new wake can make
    // this lane due beside older, escalated guidance; keep both until the
    // unfinished task can resume, rather than orphaning its entire lane.
    if (record.kind !== "work" || !TaskService.isResumable(record) || !record.sessionFile) {
      this.restarts.recordRestartOutcome(
        taskId,
        "stopped",
        !record.sessionFile ? "its saved conversation is unavailable" : "its task is not resumable",
      );
      return;
    }
    if (this.retiredProviderOf(taskId)) {
      // Its session belongs to a subscription this build no longer offers:
      // no backend can reopen it, so the guidance is kept, not retried.
      this.restarts.recordRestartOutcome(
        taskId,
        "stopped",
        "it ran on a subscription no longer offered",
      );
      this.orphanTaskGuidance(taskId, record, "it ran on a subscription no longer offered");
      return;
    }
    // A task a previous process left idle or interrupted: resume and
    // deliver - this is what makes a quit-with-recorded-guidance heal at
    // the next boot instead of losing the message. A held lane waits for
    // its account first.
    if (this.laneHeld(taskId)) return;
    const pictures = this.rowPictures(taskId, due);
    if (pictures.blocked) return;
    const ids = this.deliverRows(taskId, due);
    try {
      const resumed = await this.resumeTask(taskId);
      void this.runTurn(resumed, laneTurnText(due), ids, pictures.images);
    } catch (caught) {
      this.restarts.recordRestartOutcome(
        taskId,
        "stopped",
        caught instanceof Error ? caught.message : String(caught),
      );
      this.options.inbox.release(ids);
    }
  }

  /** The lane's task is gone: one honest notice instead of silent rot. */
  private orphanTaskGuidance(
    taskId: string,
    record: TaskRecord | undefined,
    why = "the task is gone",
  ): void {
    const rows = this.options.inbox.allFor(taskId);
    this.options.inbox.deleteFor(taskId);
    if (rows.length === 0) return;
    this.recordUndeliveredGuidance(taskId, record?.title, why, rows);
  }

  /**
   * Guidance that never became a turn (WI-5): the task's timeline keeps the
   * guidance itself and its feed line says what happened in plain language.
   * A lane with no record left has no timeline, so the feed line alone
   * carries it. Operational chatter either way - the Firstmate is not woken.
   */
  private recordUndeliveredGuidance(
    taskId: string,
    title: string | undefined,
    why: string,
    rows: InboxRow[],
  ): void {
    const guidance = capWithOverflow(laneText(rows), "undelivered-guidance");
    if (this.options.tasks.get(taskId)) {
      this.options.tasks.note(taskId, `guidance never delivered - ${why}: ${guidance}`, {
        news: true,
        feed: true,
        data: { undelivered: rows.length, why },
      });
      return;
    }
    const summary = reportSummary(guidance);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Guidance for ${title ? `"${title}"` : "a task that no longer exists"} was never delivered - ${why}${summary ? `: ${summary}` : "."}`,
    });
  }

  /**
   * The ladder's loud end for a task lane: budget spent, retries stop, and
   * the stall surfaces - a feed line and an [fm-op] carrying the guidance
   * so the agent can act (the Firstmate decides whether the captain needs
   * a card; the host raises none, cards/tasks/agents P0 WI-3).
   */
  private escalateTaskGuidance(taskId: string, rows: InboxRow[]): void {
    for (const row of rows) this.options.inbox.markEscalated(row.id);
    const title = this.tasks.get(taskId)?.title ?? this.options.tasks.get(taskId)?.title ?? taskId;
    const excerpt = capWithOverflow(laneText(rows), "escalate-guidance");
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Guidance for "${title}" could not be delivered after ${INBOX_ATTEMPT_MAX} attempts.`,
      taskId,
    });
    this.hooks.notifyOp(
      {
        facts: {
          kind: "guidance-set-aside",
          task: { id: taskId, title },
          attempts: INBOX_ATTEMPT_MAX,
          excerpt,
        },
      },
      "agent",
      taskId,
    );
  }

  /**
   * One watchdog pass, which never stops a turn that still runs: a quiet
   * streaming task earns a feed line at ten minutes, and at twenty its live
   * session is asked whether the turn still works - one already over ends
   * as interrupted. A turn that goes on has its wait named (`nameWait`):
   * each of the app's own reads still open is answered "ask again" so the
   * turn goes on, and otherwise a wake names what it waits on; a turn past
   * the wall-clock bound escalates once more, naming its job and open call.
   * The Firstmate holds interrupt_crewmate, so the wake is the whole
   * escalation - no host card (cards/tasks/agents P0, WI-3).
   */
  checkQuietTasks(now: number): void {
    for (const task of this.tasks.values()) {
      if (task.state !== "streaming" && task.state !== "starting") continue;
      // A turn on a computer out of reach goes on there, unseen here: not stuck.
      if (this.outOfReach(task.id)) continue;
      // Quiet this long, the live session is asked whether the turn still
      // works, again after each such quiet stretch, whatever jobs run: a job
      // can outlive the turn that started it (INF-2332). A task on another
      // computer asks first and alerts after: its quiet alert goes once that
      // computer answers, unless the answer ended the turn here.
      if (now - Math.max(task.lastEventAt, task.confirmedAt ?? 0) >= QUIET_CARD_MS) {
        task.confirmedAt = now;
        if (this.machineOf(task.id) !== LOCAL_MACHINE_ID) {
          task.quietAsk = true;
          this.confirmTurn(task, (ended) => {
            if (!task.quietAsk || task.confirmedAt !== now) return;
            if (ended) {
              task.quietAsk = undefined;
              return;
            }
            void this.answerReadsThere(task.id).then((answered) => {
              if (!task.quietAsk || task.confirmedAt !== now) return;
              task.quietAsk = undefined;
              this.nameWait(task, now, answered);
              this.quietAlerts(task, now);
            });
          });
        } else {
          this.confirmTurn(task);
          if (task.state === "streaming" || task.state === "starting")
            this.nameWait(task, now, task.openReads.answer(now - QUIET_CARD_MS));
        }
        if (task.state !== "streaming" && task.state !== "starting") continue;
      }
      this.quietAlerts(task, now);
    }
  }

  /**
   * The reads a task's computer answered "ask again" at the quiet check,
   * as this Mac's clock reads when each began; none when it could not be asked.
   */
  private async answerReadsThere(taskId: string): Promise<AnsweredRead[]> {
    const ask = this.options.machines?.answerReads;
    if (!ask) return [];
    try {
      const answered = await ask.call(this.options.machines, taskId);
      const at = this.now();
      return answered.map((read) => ({ tool: read.tool, since: at - read.waitedMs }));
    } catch (caught) {
      console.warn(
        `[crew] could not ask ${taskId}'s computer to answer its open reads: ${errorText(caught)}`,
      );
      return [];
    }
  }

  /**
   * The twenty-minute check's account of what a quiet turn that goes on
   * waits on (INF-2603). Reads the app answered "ask again" go on the
   * timeline, and the quiet alert waits for the next check, which finds the
   * turn moving or names it. A steer this check and the previous one both
   * found unread wakes the first mate once, naming what it waits behind,
   * unless the answered reads were all it waited on.
   */
  private nameWait(task: TaskRuntime, now: number, answered: readonly AnsweredRead[]): void {
    if (task.state !== "streaming" && task.state !== "starting") return;
    task.waitNamed = true;
    task.readsAnsweredAt = answered.length > 0 ? now : undefined;
    for (const read of answered)
      this.options.tasks.note(
        task.id,
        `answered ${read.tool} "ask again" for the crewmate: it had no answer for ${formatDurationShort(Math.max(0, now - read.since))}`,
        { news: true },
      );
    const unread = [...task.unreadSteers];
    const before = new Set(task.steersAtCheck ?? []);
    task.steersAtCheck = unread;
    // The calls it still waits behind: the reads just answered end on their own.
    const calls = this.openCallFacts(task);
    for (const read of answered) {
      const at = calls.findIndex((call) => call.tool === read.tool);
      if (at >= 0) calls.splice(at, 1);
    }
    if (answered.length > 0 && calls.length === 0) return;
    for (const steer of unread) {
      if (!before.has(steer) || steer.woken) continue;
      steer.woken = true;
      this.routeCrewEvent(
        task.id,
        {
          once: `steer-unread:${task.id}:${steer.since}`,
          facts: {
            kind: "steer-unread",
            task: { id: task.id, title: task.title },
            crewmate: task.crewmate,
            since: steer.since,
            calls,
          },
        },
        "agent",
      );
    }
  }

  /** What a turn has open now, oldest first, for a wake (INF-2603). */
  private openCallFacts(task: TaskRuntime): OpenCallFact[] {
    return [...task.openCalls.values()]
      .sort((a, b) => a.since - b.since)
      .map((call) => ({ tool: call.tool, since: call.since }));
  }

  /**
   * The wait a quiet turn's twenty-minute check named, as crew status
   * shows it until the turn moves: its open calls and unread steers.
   */
  private namedWait(
    taskId: string,
  ): { words?: string; calls: OpenCallFact[]; steers: number; steersSince?: number } | undefined {
    const task = this.tasks.get(taskId);
    if (!task?.waitNamed || (task.state !== "streaming" && task.state !== "starting"))
      return undefined;
    const calls = this.openCallFacts(task);
    const steers = task.unreadSteers.length;
    if (calls.length === 0 && steers === 0) return undefined;
    const now = this.now();
    const parts = [
      ...calls.map(
        (call) => `inside ${call.tool} ${formatDurationShort(Math.max(0, now - call.since))}`,
      ),
      ...(steers > 0
        ? [
            `${steers} steer${steers === 1 ? "" : "s"} unread ${formatDurationShort(Math.max(0, now - (task.unreadSteers[0]?.since ?? now)))}`,
          ]
        : []),
    ];
    return {
      words: parts.join("; "),
      calls,
      steers,
      ...(steers > 0 ? { steersSince: task.unreadSteers[0]?.since } : {}),
    };
  }

  /** The quiet watchdog's alerts for one turn, as quiet as it is at `now`. */
  private quietAlerts(task: TaskRuntime, now: number): void {
    if (task.state !== "streaming" && task.state !== "starting") return;
    // Two hours on one turn escalates whatever runs (INF-2603): a job
    // proves the job works, not that the turn does. The wake names the job
    // and what the turn has open.
    if (now - task.turnStartedAt >= TURN_WALL_CLOCK_MS && !task.wallClockEscalated) {
      task.wallClockEscalated = true;
      const hours = Math.round(((now - task.turnStartedAt) / 3_600_000) * 10) / 10;
      const running =
        this.options.hasRunningJobs?.(task.id) === true ||
        this.clientJobStart(task.id) !== undefined;
      const job = running ? this.oldestJob(task.id) : undefined;
      const calls = this.openCallFacts(task);
      this.routeCrewEvent(
        task.id,
        {
          facts: {
            kind: "long-turn",
            task: { id: task.id, title: task.title },
            crewmate: task.crewmate,
            hours,
            ...(job
              ? {
                  job: {
                    command: job.command.replace(/\s+/g, " ").slice(0, 80),
                    since: job.startedAt,
                  },
                }
              : {}),
            ...(calls.length > 0 ? { calls } : {}),
          },
        },
        "agent",
      );
    }
    // A running background job is proof of life (R2): a quiet turn that
    // is waiting on its own build is not stuck.
    if (this.options.hasRunningJobs?.(task.id)) return;
    const quietFor = now - task.lastEventAt;
    const minutes = Math.round(quietFor / 60_000);
    // A read the check just answered moves the turn on; the next check names it if not.
    const answered = task.readsAnsweredAt !== undefined && task.readsAnsweredAt >= task.lastEventAt;
    if (quietFor >= QUIET_CARD_MS && task.quietLevel < 2 && !task.quietAsk && !answered) {
      task.quietLevel = 2;
      const calls = this.openCallFacts(task);
      const unread = task.unreadSteers;
      const waits = [
        ...calls.map(
          (call) => `inside ${call.tool} for ${formatDurationShort(Math.max(0, now - call.since))}`,
        ),
        ...(unread.length > 0
          ? [`${unread.length} steer${unread.length === 1 ? "" : "s"} unread`]
          : []),
      ];
      this.options.tasks.note(
        task.id,
        `quiet for ${minutes} minutes; may be stuck${waits.length > 0 ? `; ${waits.join("; ")}` : ""}`,
        { news: true },
      );
      this.routeCrewEvent(
        task.id,
        {
          facts: {
            kind: "quiet",
            task: { id: task.id, title: task.title },
            crewmate: task.crewmate,
            minutes,
            ...(calls.length > 0 ? { calls } : {}),
            ...(unread.length > 0
              ? { steers: { count: unread.length, since: unread[0]?.since ?? now } }
              : {}),
          },
        },
        "agent",
      );
    } else if (quietFor >= QUIET_FEED_MS && task.quietLevel < 1) {
      task.quietLevel = 1;
      this.options.tasks.note(task.id, `quiet for ${minutes} minutes`, { news: true });
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Task ${task.title} quiet: ${minutes} minutes without an update`,
      });
    }
  }

  /**
   * A task that runs on a computer that runs work, whose conversation no
   * crewmate here holds - this Mac restarted, and that computer runs its
   * turn or asks about it first - opens here now (src/core/placed/).
   */
  async adoptPlaced(taskId: string): Promise<void> {
    if (this.tasks.get(taskId)?.session) return;
    const record = this.options.tasks.get(taskId);
    if (!record?.deviceId || !TaskService.isResumable(record))
      throw new Error(`Task ${taskId} does not run on another computer.`);
    await this.resumeTask(taskId);
  }

  /**
   * A task's conversation opened again on the computer that runs it, after
   * that computer restarted (src/core/placed/), in the session this crewmate
   * holds: one that started over there is carried into its new
   * conversation as an open carries it, before its lane goes on.
   */
  placedReopened(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task?.session) {
      if (task.state !== "idle" && !this.restarts.observing(taskId)) {
        this.restarts.observe(taskId);
        this.restarts.recordRestartOutcome(
          taskId,
          "waiting",
          "its computer reopened and has not confirmed a new request yet",
        );
        this.options.broadcastEvent({
          type: "firstmate_note",
          text: carryOnWords([{ key: task.key, title: task.title }]),
        });
      }
      this.carryRestart(task, this.machineOf(taskId), task.session);
    }
  }

  /**
   * The tool names this task's crewmate binds now. Read at a reopen, so a
   * computer that restarted on a newer contract is given a version-gated
   * tool the conversation opened without.
   */
  toolsNow(taskId: string): readonly string[] | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const personal = this.isPersonalTask(taskId) ? this.options.personal : undefined;
    return bindTools(CREWMATE_TOOLS, this.crewmateHooks(task, personal)).map((tool) => tool.name);
  }

  /**
   * These tasks' computer is in reach again and caught up: what waited on
   * their lanes goes now, and a start that waited for it may start.
   */
  placedCaughtUp(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      if (this.options.tasks.get(taskId)?.status !== "active") continue;
      // Rows a restart here left in flight that no turn there took: the
      // computer never started them, so they go again.
      const holding = new Set(this.tasks.get(taskId)?.inFlightInboxIds ?? []);
      const stranded = this.options.inbox
        .inFlight(taskId)
        .filter((row) => !holding.has(row.id))
        .map((row) => row.id);
      this.options.inbox.reparkUndelivered(stranded);
      void this.sweepTaskLane(taskId, this.now());
    }
    void this.sweepGates(this.now());
    this.broadcastCrewCounts();
  }

  /** Resolves once the task's running turn here has ended, at once when none runs. */
  private untilTurnOver(task: TaskRuntime): Promise<void> {
    if (this.tasks.get(task.id) !== task || task.state === "idle") return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.turnWaiters.get(task.id) ?? new Set<() => void>();
      waiters.add(resolve);
      this.turnWaiters.set(task.id, waiters);
    });
  }

  /** The task's running turn ended here, or its session was let go. */
  private turnOver(taskId: string): void {
    const waiters = this.turnWaiters.get(taskId);
    if (!waiters) return;
    this.turnWaiters.delete(taskId);
    for (const resolve of waiters) resolve();
  }

  /** The idle reconciler over every live idle record (docs/report-sort.md; idleLadder.ts). */
  reconcileIdle(now: number): void {
    this.ladder.reconcileIdle(now);
  }

  /** Resume work paused by a typed GitHub askpass/auth refusal after sign-in. */
  async resumeForgeSignInTasks(host: string): Promise<void> {
    const ref = `forge-sign-in:${host}`;
    for (const record of this.options.tasks.listOpen()) {
      if (record.kind !== "work" || record.gate?.ref !== ref) continue;
      this.options.tasks.placement.setGate(record.id, null, "the GitHub sign-in is ready");
      await this.dispatchQueuedTask(record.id);
    }
  }

  /**
   * The ready sweep over open and active rows (docs/task-graph.md; the
   * ladder's `sweepGates`). Runs on the shared tick, after any close, after
   * a graph change, on quota refresh, and once at boot. The quit runs no
   * new sweep and waits for one already running (`disposeAll`).
   */
  sweepGates(now: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const sweep: Promise<void> = this.sweepReady(now).finally(() => this.sweeping.delete(sweep));
    this.sweeping.add(sweep);
    return sweep;
  }

  private async sweepReady(now: number): Promise<void> {
    this.cards.fileMissingHostCardTasks();
    // Only a sweep with a move to drive yields here, so one with none keeps its order.
    if (this.options.tasks.listWithComputerMove().length > 0) await this.moves.driveComputerMoves();
    for (const record of this.options.tasks.listOpen()) {
      const action = record.delivery?.captainAction;
      if (
        action &&
        this.options.tasks.delivery.captainActionReady(record.id) &&
        (action.presentedGeneration < action.generation || action.state === "blocked")
      )
        this.cards.presentRequiredAction(record.id);
    }
    await this.ladder.sweepGates(now);
  }

  /**
   * The check watch's pass (docs/forge.md, "The check watch"): every due
   * watch reads its change's checks once, and a watch whose checks
   * finished wakes its crewmate once. The same tick reads the default
   * branch for standing baseline waits (docs/forge.md, "A main failure's
   * wake"). Runs on the shared tick.
   */
  async pollCheckWatches(now: number): Promise<void> {
    await Promise.all([
      this.checkWatch?.poll(now),
      this.runWatch?.poll(now),
      this.mainCheckWake?.poll(now),
    ]);
    this.cards.refreshSettleFacts();
  }

  /**
   * The crewmate's read-only `tasks` query (cards/tasks/agents P0, WI-4):
   * the same query the Firstmate and supervision read, so a crewmate can
   * search the backlog before filing a follow-up.
   */
  private queryTasks(input: TaskQueryInput): { rows: TaskQueryRow[]; total: number } {
    return queryTasks(
      this.options.tasks,
      input,
      (repoId) => this.options.repos.get(repoId)?.name,
      (taskId) => this.cards.newestForTask(taskId)?.body,
      (taskId) => this.cards.newestResolutionForTask(taskId),
      (record) => this.postures.workPosture(record),
      this.taskQueryReach(),
    );
  }

  /**
   * What the `tasks` query names beyond the record (INF-1217): a project's
   * folder, which is always on the computer where the first mate lives, and
   * the computer a task's crewmate ran on with its evidence folder there,
   * so a crewmate names a folder instead of searching the disk for it.
   */
  taskQueryReach(): TaskQueryReach {
    return {
      timeline: this.options.taskTimeline,
      pendingResponses: (taskId) => this.options.inbox.pendingResponses(taskId),
      projectFolder: (repoId) => this.options.repos.get(repoId)?.path,
      sessionFolderOf: (record) => ({
        dir: crewmateSessionsDir(this.options.paths, record.id),
        computer: HOME.the,
      }),
      placeOf: (record) => {
        if (record.status === "open") return undefined;
        const machine = record.deviceId ?? LOCAL_MACHINE_ID;
        if (machine === LOCAL_MACHINE_ID) {
          return {
            computer: HOME.the,
            evidence_folder: crewmateEvidenceDir(this.options.paths, record.id),
          };
        }
        const machines = this.options.machines;
        const evidence = machines?.folders(machine, record.id)?.evidence;
        const place = machines?.placeOf(machine);
        const computer = place?.where.startsWith("as ")
          ? `${place.who}, another user on ${HOME.the}`
          : (machines?.nameOf(machine) ?? `another ${COMPUTER.one}`);
        return { computer, ...(evidence ? { evidence_folder: evidence } : {}) };
      },
    };
  }

  /**
   * A queued row's kind, established at gate-open (S3): the classifier runs
   * once and the verdict is stamped on the row, so a row that waited days
   * is sorted against what it was commissioned with and a row already
   * sorted keeps its kind. The stamp is a quiet write - no timeline event,
   * no feed line: it explains a routing decision, it is not one.
   *
   * The verdict is written as the host's stamp onto the row as it stands
   * when the call returns (INF-83, INF-416 piece F): a model, a basis or
   * any other field a person owns, named or cleared while the classifier
   * ran, stays, and the tier is computed from that row. The shape the
   * classifier was asked about is never written back. A skip asks nothing,
   * so one whose named model was cleared meanwhile classifies the row as
   * it now stands.
   */
  private async classifyQueued(record: TaskRecord): Promise<void> {
    const shape = this.queuedShape(record);
    if (kindEstablished(shape.kind_source)) return;
    const intent = record.intent ?? { goal: record.title, userWords: record.prompt };
    const classified = withDeliverable(
      await classifyShape(
        this.options,
        record.id,
        record.title,
        intent,
        record.repoId,
        shape,
        record.intent != null,
      ),
      record.intent ?? undefined,
    );
    const current = this.options.tasks.get(record.id);
    if (current?.status !== "open" || current.kind !== "work") return;
    const now = this.queuedShape(current);
    if (classified.kind_source === `${KIND_SOURCE.skipped}override` && !now.override_model_id)
      return this.classifyQueued(current);
    const stamp = {
      kind: classified.kind,
      kind_source: classified.kind_source,
      ...(classified.kind_detail ? { kind_detail: classified.kind_detail } : {}),
      deliverable: classified.deliverable,
    };
    const stamped: WorkShape = { ...now, ...stamp };
    if (stamped.kind_source === now.kind_source && stamped.deliverable === now.deliverable) return;
    this.options.tasks.placement.recordShape(record.id, stamp, tierFor(stamped).bucket ?? null);
  }

  /**
   * A queued row's shape as its record holds it now, with its basis
   * verdict derived now: what it was commissioned with - its basis, its
   * premium ask and the model the captain named. A commissioned row written
   * before the shape existed is read as the judgment it carried. A
   * crewmate's follow-up is filed with no shape and no intent: it never
   * carried a judgment, so its shape is built here the way a planned row's
   * is, and `rigorFor` derives its rigor like any other row's - never the
   * legacy quick.
   */
  private queuedShape(record: TaskRecord): WorkShape {
    return withBasisVerdict(
      this.options.tasks,
      record.shape ??
        (record.intent
          ? legacyShapeFromDifficulty(record.difficulty)
          : workShape(this.options.tasks, undefined)),
    );
  }

  /**
   * The brief a queued row dispatches from. Its stored prompt was rendered
   * at commission, before the classifier ran, so a row the classifier has
   * just called an ANSWER may still carry the `Delivery:` line a change
   * gets - which the mint's answer-shape section would then contradict. The
   * host re-renders it from the same template and the same intent when that
   * happens, and always renders ordinary tasks from saved intent to avoid
   * template drift after goal edits. An escalation (whose brief carries a
   * host-written section the intent alone cannot rebuild) keeps it. A row
   * with no intent - a crewmate's follow-up - keeps the brief it was filed
   * with, its Delivery line written again: the posture its own merge takes
   * now (FI3-733), or none when it is an answer (FI3-598), which gets no
   * delivery tools and so must not be told to ship.
   */
  private queuedBrief(record: TaskRecord, shape: WorkShape): string {
    if (shape.escalation) return record.prompt;
    // A folder repair is rendered again from its facts as they stand now: a
    // later refusal may have moved the version the folder must reach.
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    if (shape.in_place && repo) {
      const where = { project: repo.name, folder: repo.path };
      // Folder work (INF-567) is the first mate's intent, told the folder.
      if (isFolderWork(shape.in_place)) {
        return record.intent
          ? renderIntentBrief(record.intent, undefined, undefined, where)
          : record.prompt;
      }
      return isPullRepair(shape.in_place)
        ? renderPullRepairBrief({ ...shape.in_place, ...where })
        : this.inPlaceWork.folderRepairBrief(repo, shape.in_place);
    }
    const personal = this.isPersonalTask(record.id);
    const delivery =
      shape.deliverable !== "change" || personal
        ? undefined
        : (this.taskDelivery(record.id) ?? "local-only");
    if (!record.intent) return withDeliveryLine(record.prompt, delivery);
    return renderIntentBrief(
      record.intent,
      delivery,
      personal ? this.personalFacts(shape.ongoing) : undefined,
    );
  }

  /**
   * Dispatch one queued row through the shared start path. `requested` is a
   * start someone asked for (`startQueuedNow`): its asker already knows, so
   * no queued-started wake follows, and a failure says who asked. `from`
   * writes the start on the history as the captain's task card click.
   * `message` is the spawning message's pictures and files, for a start
   * made before that message attaches to the task; a later start reads
   * them from the record.
   */
  async dispatchQueuedTask(
    taskId: string,
    options: {
      ignoreAsk?: boolean;
      requested?: { by: "firstmate" | "captain"; from?: typeof TASK_CARD_VIA; panel?: string };
      message?: { attachments: readonly AttachmentRef[]; files: readonly MessageFile[] };
    } = {},
  ): Promise<void> {
    // The quit starts nothing; the next launch's sweep starts it.
    if (this.disposed) return;
    // A Start waiting for the Firstmate's directions begins only through it.
    if (this.pendingStarts.has(taskId)) return;
    let record = this.options.tasks.get(taskId);
    if (record?.status !== "open" || record.kind !== "work") return;
    // A program runs in the host's runner, never on a model; a running one is left alone.
    if (record.shape?.program) {
      this.programs.run(taskId);
      return;
    }
    const originalTitle = record.title;
    const gate = record.gate;
    const blockers = this.options.tasks.graph.blockers(taskId);
    try {
      await this.classifyQueued(record);
      // Classification awaits a provider. An edit during that await must
      // reach the first turn, not the earlier snapshot used to classify:
      // the row routes from its own shape as the record now holds it.
      record = this.options.tasks.get(taskId);
      if (record?.status !== "open" || record.kind !== "work") return;
      const shape = this.queuedShape(record);
      this.restampGroundedTier(record.id, shape);
      // Placement and routing can wait on a computer, and a model or basis
      // named or cleared meanwhile (INF-83), or a move of where it runs
      // (INF-409), decides this start: it starts over from the record as it
      // now stands.
      const routedFrom = record.shape;
      const startsAt = this.placement.startPlace(record);
      const moved = () => {
        const now = this.options.tasks.get(taskId);
        return (
          !now ||
          routingAskMoved(routedFrom, now.shape) ||
          this.placement.startPlace(now) !== startsAt
        );
      };
      // A task that waits for its computer chooses its model once that
      // computer is back, among its own subscriptions.
      const automatic = this.placement.automaticFor(record);
      if (!automatic) this.options.tasks.placement.setPlacementWait(taskId, null);
      const ignoreAsk = options.ignoreAsk || record.shape?.placement_fallback_accepted === true;
      const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
      const choice =
        automatic && repo
          ? await this.options.automaticPlacement?.choose(
              record,
              repo,
              this.queuedBrief(record, shape),
              shape,
              { ignoreAsk },
            )
          : undefined;
      const selected = choice && "computerId" in choice ? choice : undefined;
      // An added computer left out for a reason only a change ends: the
      // first mate hears it once per project, computer and reason, whichever
      // computer took the task (INF-1456).
      if (repo)
        for (const left of choice?.leftOut ?? [])
          this.hooks.notifyOp(
            computerLeftOutWake(
              { id: record.id, key: record.key || record.id, title: record.title },
              { id: repo.id, name: repo.name },
              left,
            ),
            "agent",
          );
      if (automatic && !selected) {
        // Automatic declines a task that changed while computers were
        // compared, which is no wait for room.
        if (moved()) return this.dispatchQueuedTask(taskId, options);
        // A wait whose computers were compared says why; another keeps what was said.
        const waiting = choice && "wait" in choice ? choice : undefined;
        const wait =
          waiting?.wait ?? this.options.tasks.get(taskId)?.shape?.placement_wait ?? UNCOMPARED_WAIT;
        this.options.tasks.placement.waitForPlacement(taskId, ignoreAsk, wait.words);
        this.placement.sayAutomaticWait(record, wait);
        // No computer runs a system it requires, which no room or reading
        // changes: the first mate hears it at once, once (INF-720).
        if (waiting?.unserved)
          this.hooks.notifyOp(
            systemWaitWake(
              { id: record.id, key: record.key || record.id, title: record.title },
              waiting.unserved,
            ),
            "agent",
            taskId,
          );
        // No computer serves the level it asked for: held on that level's
        // reset with one wake, as a This computer start is (P7 + R1).
        if (waiting?.held) {
          this.holdForReasoning(taskId, record.title, gate, waiting.held);
          this.broadcastCrewCounts();
        }
        return;
      }
      if (selected) this.options.tasks.placement.setPlacementWait(taskId, null);
      const target = selected ? selected.computerId : this.placement.placementOf(record);
      const ready = !target || this.options.machines?.ready(target, taskId) === true;
      // One that waits for its own sign-in there tries nothing until it
      // serves: known before routing once that computer said so, and after
      // routing found nothing there to take it.
      const signInWait = () =>
        !selected &&
        target !== null &&
        ready &&
        !this.tasks.has(taskId) &&
        this.placement.waitsForSignIn(taskId, target);
      if (signInWait()) return;
      // One with no sign-in at all, or none for where its project lives,
      // tries nothing until that computer reports one.
      if (!selected && target !== null && ready && !this.tasks.has(taskId)) {
        const waitFor = await this.placement.placedWaitFor(target, record.repoId);
        if (moved()) return this.dispatchQueuedTask(taskId, options);
        if (waitFor) {
          this.placement.waitForSetup(taskId, target, waitFor);
          this.broadcastCrewCounts();
          return;
        }
      }
      const routed =
        selected?.routed ??
        (ready ? await this.placement.routeTask(taskId, record.prompt, shape, target) : undefined);
      // From here to the claim nothing waits; a quit that came meanwhile starts nothing.
      if (this.disposed) return;
      if (moved()) return this.dispatchQueuedTask(taskId, options);
      if (!routed?.choice && signInWait()) return;
      if (!ignoreAsk && routed && requiresReasoningWait(shape, routed)) {
        // The user's premium ask - or an escalation's rung (S4) - still
        // cannot be served when the gate clears: re-gate on the quota reset
        // instead of quietly starting lower (P7) - the commission-time
        // protection, applied at dispatch too. update_task start_now passes
        // ignoreAsk.
        this.holdForReasoning(taskId, record.title, gate, routed);
        this.broadcastCrewCounts();
        return;
      }
      if (this.tasks.has(taskId)) return;
      // This computer is being updated: it starts once the update is over
      // or let go (`releaseUpdate`).
      if (this.updates.updatingHere()) return;
      // It runs on a computer that is out of reach: it waits, and never starts here instead.
      if (this.placement.placeForStart(taskId)) return;
      if (
        !this.options.tasks.starts.claimForDispatch(
          taskId,
          options.requested?.from,
          options.requested?.panel,
        )
      )
        return;
      const start = await this.startTask({
        taskId,
        title: record.title,
        brief: this.queuedBrief(record, shape),
        repoId: record.repoId,
        routed,
        placementAccount: selected?.accountId,
        fresh: false,
        ...(options.message?.attachments.length
          ? { attachments: options.message.attachments }
          : {}),
        ...(options.message?.files.length ? { messageFiles: options.message.files } : {}),
      });
      if (start.crewmate === "queued") return;
      this.placement.sayPlacedStarted(taskId);
      const because = gate
        ? gateClearedText(gate)
        : blockers.length > 0
          ? `${blockers.map((blocker) => `task ${blocker.id}`).join(" and ")} finished`
          : undefined;
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Starting "${record.title}"${because ? ` - ${because}` : ""}.`,
      });
      // Only a start whose wait ended wakes the Firstmate. Its own start_now
      // already answered "Started", and the captain's Start reaches its next
      // context block the way the captain's card choices do (FI3-695). A program's
      // part was started by its program, which is what waits on it (INF-799).
      if (!options.requested && !record.shape?.program_part) {
        const started = this.options.tasks.get(taskId);
        const model = started && namedModelOf(started);
        this.routeCrewEvent(
          taskId,
          {
            facts: {
              kind: "queued-started",
              task: { id: taskId, title: record.title },
              ...(model ? { model } : {}),
            },
          },
          "agent",
        );
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.routeCrewEvent(
        taskId,
        {
          facts: {
            kind: "queued-start-failed",
            task: { id: taskId, title: record?.title ?? originalTitle },
            error: capWithOverflow(message, "queue-start-failure"),
            ...(options.requested?.by === "captain" ? { by: "captain" as const } : {}),
          },
        },
        "agent",
      );
      const current = this.options.tasks.get(taskId);
      if (
        caught instanceof ForgeAuthRequiredError &&
        current?.status === "active" &&
        current.deviceId &&
        current.deviceId !== LOCAL_MACHINE_ID
      ) {
        // Refused on that computer for want of its own sign-in: held for it.
        this.placement.holdForDeviceForge(taskId, current.deviceId, caught.host);
        this.placement.sayPlacedWait(this.placement.waitSubject(current), current.deviceId, {
          kind: "forge",
          host: caught.host,
        });
        this.cards.scheduleBroadcast();
      } else if (caught instanceof ForgeAuthRequiredError && current?.status === "active") {
        this.options.tasks.starts.requeue(
          taskId,
          {
            kind: "captain",
            ref: `forge-sign-in:${caught.host}`,
            reason: `waiting for ${caught.place} sign-in`,
          },
          `waiting for ${caught.place} sign-in before starting`,
        );
        this.cards.addForgeSignInCard(
          forgeSignInCardId(caught.host),
          caught.host,
          caught.place,
          0,
          { reauth: false },
        );
        this.cards.scheduleBroadcast();
      } else if (current?.status === "active" && !current.worktreeDir && !this.tasks.has(taskId)) {
        if (options.requested?.by === "captain" && current.startPolicy === "on-request") {
          this.options.tasks.starts.failManualStart(taskId, message);
        } else {
          this.options.tasks.starts.requeue(
            taskId,
            { kind: "captain", ref: "dispatch-failed", reason: message },
            `could not start: ${message}`,
          );
        }
      }
    }
    this.broadcastCrewCounts();
  }

  /**
   * The preview published before the slow start either becomes the claimed
   * row, a known hold, a lost-contact check, or a confirmed failure.
   * Holds keep their existing route. An unknown outcome is not a failure.
   */
  private async settleStartAttempt(
    record: TaskRecord,
    audience: "tool" | "captain",
  ): Promise<void> {
    if (!this.options.tasks.starts.startAttemptOf(record.id)) return;
    const now = this.options.tasks.get(record.id);
    if (!now) {
      this.options.tasks.starts.clearStartAttempt(record.id);
      return;
    }
    if (now.status === "active") {
      if (
        now.activity === "starting" &&
        !this.tasks.has(now.id) &&
        now.deviceId &&
        this.outOfReach(now.id)
      ) {
        this.options.tasks.starts.markStartChecking(now.id);
        return;
      }
      this.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    if (now.shape?.placement_wait) {
      this.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    const signIn = now.deviceId ? this.options.machines?.signInWait(now.deviceId) : undefined;
    const setup = now.deviceId
      ? await this.placement.placedWaitFor(now.deviceId, now.repoId)
      : undefined;
    if (now.gate || signIn || setup || (now.deviceId && this.outOfReach(now.id))) {
      this.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    if (audience === "captain" && record.startPolicy === "on-request" && !now.startNotice) {
      this.options.tasks.starts.failManualStart(now.id, "it did not start");
      return;
    }
    this.options.tasks.starts.clearStartAttempt(now.id);
  }

  /**
   * update_task start_now: a queued row starts on the Firstmate's word,
   * past the reasoning re-ask (the one operation the retired wait card's
   * button carried; cards/tasks/agents P0, WI-3), or on the captain's Start
   * in the task record (`start-task`). A refusal is text; the captain's
   * leaves out the tool's way around it. `from` marks the captain's click on
   * the task card, which the history records as his.
   */
  async startQueuedNow(
    taskRef: string,
    audience: "tool" | "captain" = "tool",
    from?: typeof TASK_CARD_VIA,
    panel?: string,
    direct = false,
  ): Promise<string> {
    const record = this.intake.resolveTaskRef(taskRef, "task");
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.status === "active" && record.backlogSince != null)
      return this.startFromBacklog(
        record,
        audience === "captain" ? "captain" : "firstmate",
        from,
        panel,
      );
    const refused = this.startRefusal(record, audience);
    if (refused) return refused;
    // The captain's Start goes to the Firstmate first, so his standing
    // directions apply before a crewmate begins. The Firstmate's own
    // start_now on that pending Start is the same press, finished.
    const pending = this.pendingStarts.get(record.id);
    if (pending) {
      this.pendingStarts.delete(record.id);
      from = pending.from;
      panel = pending.panel;
    } else if (audience === "captain" && !direct && this.askFirstmateFirst(record, from, panel)) {
      return `${handle} is starting. Your first mate applies your standing directions first.`;
    }
    const asCaptain = audience === "captain" || pending !== undefined;
    // Publish before classification and routing, so both surfaces leave
    // Backlog while that work is still going. A known refusal above never
    // publishes. startOnRequest may already hold `starting`; this is the
    // shared board's copy of that attempt.
    if (!this.options.tasks.starts.startAttemptOf(record.id))
      this.options.tasks.starts.beginStartAttempt(record.id);
    if (record.gate) this.options.tasks.placement.setGate(record.id, null, "started on request");
    await this.dispatchQueuedTask(record.id, {
      ignoreAsk: true,
      requested: {
        by: asCaptain ? "captain" : "firstmate",
        ...(from ? { from } : {}),
        ...(panel ? { panel } : {}),
      },
    });
    // A program stays open while the runner holds it; its first run is recorded on its timeline.
    const program = this.options.tasks.get(record.id);
    if (program?.shape?.program) {
      if (this.options.tasks.starts.startAttemptOf(record.id))
        this.options.tasks.starts.clearStartAttempt(record.id);
      return this.options.tasks.starts.programStarted(record.id)
        ? `Started ${handle}.`
        : `${handle} could not start.`;
    }
    await this.settleStartAttempt(record, asCaptain ? "captain" : "tool");
    const now = this.options.tasks.get(record.id);
    if (this.options.tasks.starts.startAttemptOf(record.id)?.phase === "checking") {
      return `${handle} is still starting. Checking whether it started.`;
    }
    if (now?.status !== "active" && now?.deviceId && this.outOfReach(record.id)) {
      const place = this.options.machines?.placeOf(now.deviceId);
      const who = place?.who ?? "the computer it runs on";
      if (this.options.takesNoWorkUntilUpdated?.(now.deviceId))
        return noNewWorkStartRefusal(handle, who, HERE.this);
      return `${handle} waits for ${who}, which is out of reach. It never runs on ${HERE.this} instead.`;
    }
    const signIn =
      now?.status !== "active" && now?.deviceId
        ? this.options.machines?.signInWait(now.deviceId)
        : undefined;
    if (now?.deviceId && signIn) {
      const place = this.options.machines?.placeOf(now.deviceId);
      return placedCutOffStartRefusal(
        handle,
        place?.who ?? "the computer it runs on",
        signIn,
        this.now(),
      );
    }
    if (now?.status !== "active" && now?.deviceId && !now.gate) {
      const waitFor = await this.placement.placedWaitFor(now.deviceId, now.repoId);
      if (waitFor?.kind === "no-sign-ins") {
        const place = this.options.machines?.placeOf(now.deviceId);
        return noSignInsStartRefusal(handle, place?.who ?? "the computer it runs on");
      }
      if (waitFor?.kind === "update") {
        const place = this.options.machines?.placeOf(now.deviceId);
        return updateStartRefusal(handle, place?.who ?? "the computer it runs on");
      }
    }
    const automaticWait = now?.shape?.placement_wait?.words;
    if (now?.status !== "active" && automaticWait) return `${handle}: ${automaticWait}`;
    if (now?.status !== "active") {
      const notice = readStartNotice(now?.startNotice);
      const why = notice ?? now?.gate?.reason;
      return `${handle} could not start${why ? `: ${why}` : ""}${audience === "tool" ? "; see the feed" : ""}.`;
    }
    // A model the captain named routes only when it can serve; the tool's
    // answer says which model took the task, so the Firstmate never reports
    // the named one when routing fell back.
    const named = namedModelOf(now);
    return audience === "tool" && named
      ? `Started ${handle} ${namedModelWords(named)}.`
      : `Started ${handle}.`;
  }

  /** Captain-requested dropped work starts as a fresh record, never an escalation. */
  startAgain(
    taskRef: string,
    audience: "tool" | "captain" = "tool",
    panel?: string,
  ): { ok: false; text: string } | { ok: true; task: TaskRecord; started: Promise<string> } {
    const old = this.intake.resolveTaskRef(taskRef, "task");
    const refusal = this.options.tasks.starts.startAgainRefusal(old.id);
    if (refusal) return { ok: false, text: refusal };
    // Only declarations carry over: dispatch stamps, chosen accounts/models,
    // escalation floors and delivery outcomes all belong to the old attempt.
    const { kind: _oldKind, ...oldAsk } = old.shape ?? { kind: "unclear" };
    const shape = workShape(this.options.tasks, {
      ...oldAsk,
      ...(old.shape?.kind_source === "firstmate:declared" && old.shape.kind !== "review"
        ? { kind: old.shape.kind }
        : {}),
    });
    if (old.shape?.policies) shape.policies = { ...old.shape.policies, revision: 0 };
    const fresh = this.options.tasks.starts.startAgain(old.id, {
      id: randomUUID().slice(0, 8),
      shape: old.intent ? withDeliverable(shape, old.intent) : shape,
      actor: audience === "tool" ? "firstmate" : "captain",
      ...(audience === "captain" ? { via: TASK_CARD_VIA } : {}),
      ...(panel ? { panel } : {}),
    });
    this.starting.add(fresh.id);
    const started = this.settling.closing
      .finishWorkspaceRetirement(old.id)
      .then(() => this.startQueuedNow(fresh.id, audience))
      .finally(() => this.starting.delete(fresh.id));
    return { ok: true, task: fresh, started };
  }

  /**
   * A queued task whose wait can never end (its blocker was dropped) is one
   * wake to the Firstmate, not a card and not a hold: its tools already
   * express every way out. The wake is deduped by content on the task's
   * ref while it stands, so the tick does not repeat it.
   */
  private wakeDeadGate(record: TaskRecord, dead: TaskRecord): void {
    this.hooks.notifyOp(
      {
        facts: {
          kind: "dead-gate",
          task: { id: record.id, key: record.key || record.id, title: record.title },
          blocker: { id: dead.id, key: dead.key || dead.id, title: dead.title },
          closed: dead.closedReason ?? "dropped",
        },
      },
      "agent",
      record.id,
    );
  }

  /**
   * A queued premium ask or escalation rung that nothing can serve waits on
   * its level's quota reset (P7 + R1), with one wake the first time that gate
   * is set (`gate` is the row's gate before this dispatch).
   */
  private holdForReasoning(
    taskId: string,
    title: string,
    gate: TaskGate | null,
    routed: RouteResult,
  ): void {
    const waitGate = reasoningWaitGate(routed.bucket);
    if (gate?.kind === waitGate.kind && gate.ref === waitGate.ref) return;
    this.options.tasks.placement.setGate(
      taskId,
      waitGate,
      routed.emptyBucket
        ? `held: no model is placed at ${routed.bucket}`
        : `held: no ${routed.bucket} model has allowance`,
    );
    this.wakeReasoningWait(taskId, title, routed);
  }

  /**
   * An Automatic task held on its own level's reset (`holdForReasoning`).
   * Another computer's headroom at that level can end the hold, and only its
   * choice reads that, so the gate sweep asks it again each pass.
   */
  private heldOnItsLevel(record: TaskRecord): boolean {
    const shape = record.shape;
    const bucket =
      shape && (shape.premium_ask || shape.escalation) ? tierFor(shape).bucket : undefined;
    return (
      bucket !== undefined &&
      record.gate?.kind === "quota-reset" &&
      record.gate.ref === reasoningWaitGate(bucket).ref &&
      this.placement.automaticFor(record)
    );
  }

  /**
   * The ask-first wake (P7 + R1; cards/tasks/agents P0, WI-3): the user
   * explicitly asked for a reasoning class no model can serve right now.
   * The row already waits on that class's quota reset - the safe default -
   * and the Firstmate may start it lower with update_task start_now, or
   * drop it. With no model in that class at all there is no reset to wait
   * for, and the wake says the wait ends when one is placed there.
   * Deduped by content on the task's ref.
   */
  private wakeReasoningWait(taskId: string, title: string, routed: RouteResult): void {
    this.hooks.notifyOp(
      {
        facts: {
          kind: "reasoning-wait",
          task: { id: taskId, title },
          requested: routed.bucket,
          ...(routed.servedBucket ? { served: routed.servedBucket } : {}),
          ...(routed.emptyBucket ? { empty: true as const } : {}),
        },
      },
      "agent",
      taskId,
    );
  }

  /**
   * When a client-run backend (Claude, or any conversation a computer that
   * runs work holds) last reported background work, if it has any now: the
   * host cannot see those commands, so the reported count stands in for its
   * job list, bounded the same way.
   */
  private clientJobStart(taskId: string): number | undefined {
    const runtime = this.tasks.get(taskId);
    if (!runtime?.session || (runtime.clientJobs ?? 0) <= 0) return undefined;
    return runtime.clientJobsSince ?? this.now();
  }

  /**
   * The host's longest-running job, or the client's work when it has no job
   * list: by the job its runner named (INF-1536), else by where it runs - a
   * Claude client here, or the computer that runs the task's work.
   */
  private oldestJob(taskId: string): RunningJob | undefined {
    const host = this.options.oldestRunningJob?.(taskId);
    const since = this.clientJobStart(taskId);
    if (since === undefined || (host && host.startedAt <= since)) return host;
    const named = this.tasks.get(taskId)?.clientJob;
    if (named) return { jobId: named.id, command: named.command, startedAt: since };
    const machine = this.machineOf(taskId);
    return {
      jobId: `client-${taskId}`,
      command: unnamedBackgroundWork(
        machine === LOCAL_MACHINE_ID
          ? undefined
          : (this.options.machines?.nameOf(machine) ?? `another ${COMPUTER.one}`),
      ),
      startedAt: since,
    };
  }

  /**
   * The crew counts, read as one projection like the presentation pass: each
   * active row's posture shares the rows, settings and sign-ins the others
   * read, rather than reading them again per row (INF-2342).
   */
  crewCounts(): CrewCounts {
    const tasks = this.options.tasks;
    const active = tasks.listActive();
    return tasks.readProjection(() => {
      const tally = crewTally();
      for (const record of active) tally.see(record, () => this.postures.workPosture(record));
      return tally.counts(tasks);
    }, active);
  }

  private broadcastCrewCounts(): void {
    this.options.broadcastEvent({ type: "crew_counts", ...this.crewCounts() });
  }

  /**
   * A crewmate in a turn, opening, settling or moving, or with work of its
   * client's own still running: its conversation's files are not to be
   * written by anyone else now (`SavedOutsideData`).
   */
  conversationBusy(taskId: string): boolean {
    const runtime = this.tasks.get(taskId);
    if (this.moves.isMoving(taskId)) return true;
    if (!runtime) return false;
    return (
      runtime.state !== "idle" ||
      !runtime.session ||
      runtime.session.isStreaming() ||
      runtime.settling === true ||
      runtime.clientTasks.size > 0
    );
  }

  /** A live crewmate holds its conversation's files. */
  conversationHeld(taskId: string): boolean {
    return this.tasks.has(taskId) || this.moves.isMoving(taskId);
  }

  /**
   * Let go of an idle crewmate's session, as a move does, so a pass can
   * write its files again whole: its next delivery resumes it from them.
   * False while it is busy.
   */
  async releaseConversation(taskId: string): Promise<boolean> {
    if (this.conversationBusy(taskId)) return false;
    const runtime = this.tasks.get(taskId);
    if (!runtime) return true;
    this.releaseSession(runtime);
    this.tasks.delete(taskId);
    await runtime.session?.closed().catch(() => {});
    return true;
  }

  /**
   * The retention purge control (D-13): the one destructive control. Every
   * task, its worktree, its session JSONL, its cards, lane, timeline and
   * links go; projects stay.
   */
  async purgeAllTasks(): Promise<number> {
    const records = this.options.tasks.list();
    for (const record of records) {
      this.options.killJobs?.(record.id);
      const runtime = this.tasks.get(record.id);
      if (runtime) {
        runtime.cancelled = true;
        await runtime.session?.abort().catch(() => {});
        this.releaseSession(runtime);
        this.tasks.delete(record.id);
      }
      await rm(join(this.options.paths.crewmatesDir, record.id), {
        recursive: true,
        force: true,
      });
      if (record.worktreeDir && record.workspaceState !== "removed") {
        await this.options.workspace
          .removeTaskWorktree({
            taskId: record.id,
            cwd: record.worktreeDir,
            branch: record.branch,
            repoDir: record.repoDir,
          })
          .catch(() => {});
      }
      this.cards.purgeTask(record.id);
      this.options.inbox.purgeTask(record.id);
    }
    // A card with no task of its own - a Firstmate decision filed as its
    // own row, a host card's operation row - loses its evidence with the
    // row that stood for it (docs/card-evidence.md).
    this.cards.purgeEvidence(
      records.flatMap((record) =>
        (record.kind === "decision" || record.kind === "operation") && record.gate?.ref
          ? [record.gate.ref]
          : [],
      ),
    );
    this.options.tasks.archive.purge();
    this.cards.scheduleBroadcast();
    this.broadcastCrewCounts();
    return records.length;
  }

  /** Candidate credentials may replace a connection only between matching turns. */
  accountHasActiveTurns(accountId: string): boolean {
    return [...this.tasks.values()].some(
      (task) =>
        task.accountId === accountId &&
        (task.state === "starting" || task.state === "streaming" || task.session?.isStreaming()),
    );
  }

  /** Disconnect preserves task/session history and stops this account's work only. */
  async disconnectAccount(accountId: string): Promise<void> {
    const matching = [...this.tasks.values()].filter((task) => task.accountId === accountId);
    for (const task of matching) {
      this.options.killJobs?.(task.id);
      await this.interruptCrewmate(task.id, "interrupt", {
        actor: "captain",
        via: "shell",
        decision: null,
      });
    }
  }

  /** The shell's abort: the captain cancelling directly, not through the Firstmate. */
  async abort(taskId: string): Promise<void> {
    await this.interruptCrewmate(taskId, "cancel", {
      actor: "captain",
      via: "shell",
      decision: null,
    }).catch(() => {});
  }

  /**
   * A line the captain typed in the task card's Crewmate tab
   * (docs/task-card-tabs.md, "Typing"): his steer on the crewmate's own
   * lane, as a reply under its card is, with his words verbatim, and one
   * feed line. Firstmate is not in the loop; it reads the steer on the
   * task's timeline. A task no crewmate can be told anything about refuses
   * in words and writes nothing.
   */
  async steerFromCrewmateTab(taskId: string, words: string): Promise<CrewSendResult> {
    const text = words.trim();
    if (!text) return { ok: false, text: "There is nothing to send." };
    const record = this.options.tasks.get(taskId);
    if (!record) return { ok: false, text: "This task is not on the record." };
    if (TaskService.isClosed(record)) {
      return { ok: false, text: "This task is closed, so its crewmate cannot be told anything." };
    }
    if (!this.tasks.has(taskId) && !record.sessionFile) {
      return { ok: false, text: "This task's crewmate has not started yet." };
    }
    try {
      await this.steerCrewmate(
        taskId,
        { facts: { kind: "crewmate-tab-line", words: text } },
        "captain",
        {
          via: CREWMATE_TAB_VIA,
        },
      );
    } catch (caught) {
      return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
    }
    const crewmate = this.tasks.get(taskId)?.crewmate ?? record.assignee ?? "the crewmate";
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: toldInCrewmateTabLine(crewmate, record.title),
    });
    return { ok: true };
  }

  /**
   * ⌃C or Stop in the task card's Crewmate tab: the captain's interrupt of
   * the crewmate's running turn, on the path Firstmate's interrupt takes;
   * the task stays steerable. With no turn running it refuses in words.
   */
  async interruptFromCrewmateTab(taskId: string): Promise<CrewSendResult> {
    const task = this.tasks.get(taskId);
    if (!task || (task.state !== "streaming" && task.state !== "starting")) {
      return { ok: false, text: "Its turn is not running." };
    }
    try {
      await this.interruptCrewmate(taskId, "interrupt", {
        actor: "captain",
        via: CREWMATE_TAB_VIA,
        decision: null,
      });
      return { ok: true };
    } catch (caught) {
      return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
    }
  }

  /** When the crewmate's running turn began; null while none runs (the Crewmate tab's clock). */
  turnStartedAt(taskId: string): number | null {
    const task = this.tasks.get(taskId);
    return task && task.state !== "idle" ? task.turnStartedAt : null;
  }

  /**
   * A card action (cards/tasks/agents P1): the host dispatches on the
   * action's declared EFFECT and never on its id. A settle effect runs the
   * host settle for the card's task (a merge resolved from the delivery
   * posture); an open effect is handed to the shell; a host effect is one
   * of the agent-down cards' own operations; no effect is a reply - an
   * [fm-op] for a Firstmate card, a steer for a crewmate's. Returns the
   * shell-level effect the renderer applies, if any; card bookkeeping
   * happens here.
   *
   * A footer click carries the answers to the questions the body asked with
   * its own form (inline decisions, contract 4.22): they ride the choice's
   * wake in words, and a closing choice records them on the card row and
   * the task's `card_resolved` event.
   */
  act(
    cardId: string,
    actionId: string,
    source: "chrome" | "frame" = "chrome",
    value?: unknown,
    submission?: unknown,
  ): { effect?: ShellEffect } {
    // The version the captain chose from: the stage's, while a revision
    // waits on its author's close-out.
    const card = this.cards.shown(cardId);
    if (!card) return {};
    const associated = card.taskId
      ? this.options.tasks.get(card.taskId)
      : (this.options.tasks.capture.openCardTaskFor(card.id) ??
        this.options.tasks.capture.taskForCard(card.id));
    const taskUnavailable = Boolean(
      (card.taskId && !associated) || (associated && TaskService.isClosed(associated)),
    );
    if (!onStage(card) || card.status !== "ready" || taskUnavailable) {
      throw new CardChoiceUnavailableError(taskUnavailable ? "task-closed" : "not-ready");
    }
    // Admit only an action declared by the shown offer, before any choice
    // bookkeeping. Resolution can close the card's answer task as well.
    const chosen = card.actions.find((action) => action.id === actionId);
    if (!chosen) throw new CardChoiceUnavailableError("undeclared");
    // A frame value belongs only to a frame reply, never a host effect; a
    // footer click's value is only ever its answers.
    let valueJson: string | undefined;
    if (source === "frame" && value !== undefined) {
      const json = JSON.stringify(value);
      if (json === undefined || Buffer.byteLength(json, "utf8") > ACTION_VALUE_MAX_BYTES) {
        throw new Error("Card settings must be JSON no larger than 4,096 bytes.");
      }
      valueJson = json;
    }
    const answers = source === "chrome" ? chromeAnswers(value) : undefined;
    const decisionTaskId = card.taskId ?? associated?.id;
    if (source === "frame" && (chosen.effect || chosen.care)) {
      throw new Error("This action is available only from the card controls.");
    }
    // The record keeps the task as it stood before this choice moves it
    // (docs/card-evidence.md), beside what the shell said it showed.
    const context = decisionTaskId
      ? this.options.tasks.capture.decisionContext(decisionTaskId)
      : undefined;
    const evidence: CardInteractionEvidence = {
      source,
      ...(submission !== undefined ? { submission } : {}),
      ...(valueJson !== undefined ? { frameValue: valueJson } : {}),
      ...(context ? { context } : { contextGap: decisionTaskId ? "task-missing" : "no-task" }),
    };
    const by = source === "chrome" ? "captain" : scriptChooser(card.author);
    // Resolution records the choice and its true source, not operation
    // success. All actions retire their card before external work starts.
    // An answer task closes on this very resolution (Task B), so its
    // crewmate is gone: the choice has nowhere to round-trip to.
    const effect = chosen.effect;
    // A merge click merges the change its card was shown for, with the story
    // it showed: a card shown for another change than the current one, or
    // for another story than the current change's, is refused (INF-2490).
    if (effect?.kind === "settle" && effect.mode === "merge" && associated) {
      const delivery = associated.delivery;
      const offered = delivery?.completionOffers?.find(
        (offer) => offer.cardId === card.id && offer.offerId === card.offerId,
      );
      const shownFor = offered?.shownFor ?? offered?.prNumber;
      const ready = readyPresentation(delivery?.presentation);
      const story =
        delivery?.presentation !== undefined || offered?.presentationRevision !== undefined;
      if (
        (shownFor !== undefined &&
          shownFor !== currentChange(delivery, associated.branch).number) ||
        (story &&
          (!offered?.presentationRevision ||
            offered.presentationRevision !== ready?.revision ||
            offered.headSha !== ready?.head ||
            offered.presentationContentHash !== ready?.contentHash))
      ) {
        this.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
    }
    // The captain's merge click mints his approval of the offer he was
    // reading, in the resolution's own transaction (FI3-304). A frame or
    // agent never reaches here with a settle effect, so nothing else can.
    const approve =
      source === "chrome" &&
      card.taskId &&
      (effect?.kind === "request_merge" ||
        (effect?.kind === "settle" &&
          effect.mode === "merge" &&
          this.mergeModeFor(card.taskId) === "merge-pr"))
        ? () =>
            this.settling.approvals.authorizeMerge(
              card.taskId as string,
              {
                cardId: card.id,
                ...(card.lifecycleId ? { lifecycleId: card.lifecycleId } : {}),
                ...(card.offerId ? { offerId: card.offerId } : {}),
                actionId,
                ...interactionOf(submission),
              },
              effect.kind === "settle" ? (effect.proceedWithOpen ?? false) : false,
              effect.kind === "request_merge" ? effect.review : undefined,
            )
        : undefined;
    const confirming = effect?.kind === "host" && effect.op === "confirm-required-action";
    const consequentialMerge =
      card.requiredActions !== undefined &&
      ((effect?.kind === "settle" && effect.mode === "merge") || effect?.kind === "request_merge");
    if ((confirming || consequentialMerge) && submission !== undefined) {
      const gesture = cardSubmissionSchema.safeParse(submission);
      if (
        !gesture.success ||
        gesture.data.remounted ||
        gesture.data.offerId !== card.offerId ||
        gesture.data.lifecycleId !== card.lifecycleId
      ) {
        this.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
    }
    if (effect?.kind === "host" && effect.op === "confirm-required-action") {
      if (this.cards.get(card.id)?.awaiting === "answer")
        throw new CardChoiceUnavailableError("not-ready");
      const [id, generation] = (effect.arg ?? "").split(":");
      const action = associated?.delivery?.captainAction;
      if (
        !id ||
        id !== card.taskId ||
        !action ||
        action.generation !== Number(generation) ||
        action.presentedGeneration !== Number(generation) ||
        !this.options.tasks.delivery.captainActionReady(id)
      ) {
        if (id && this.options.tasks.delivery.captainActionReady(id)) {
          this.cards.presentRequiredAction(id);
          this.cards.showOpenCard(action?.cardId ?? card.id);
        }
        throw new CardChoiceUnavailableError("action-changed");
      }
    }
    const carryOffer =
      source === "chrome" &&
      ((effect?.kind === "settle" && effect.mode === "merge") ||
        effect?.kind === "request_merge") &&
      card.taskId
        ? () => {
            if (card.requiredActions !== undefined && card.offerId)
              this.options.tasks.delivery.declareRequiredActions(card.taskId as string, {
                cardId: card.id,
                offerId: card.offerId,
                actions: card.requiredActions,
                head:
                  effect?.kind === "request_merge"
                    ? this.crewmateCards.mergeReviewOf(card.taskId as string, effect.review)
                        ?.headSha
                    : (readyPresentation(associated?.delivery?.presentation)?.head ??
                      associated?.delivery?.headSha),
              });
            else if (associated?.delivery?.requiredActionOffer)
              this.options.tasks.delivery.recordPermissionRecords(card.taskId as string, {
                requiredActionOffer: undefined,
              });
            approve?.();
          }
        : approve;
    const validationDecision = associated?.delivery?.liveValidation?.permissions.some(
      (item) => item.state === "requested" && item.decision?.card === card.id,
    );
    if (validationDecision) {
      if (
        !associated?.delivery?.liveValidation?.permissions.some(
          (item) =>
            item.state === "requested" &&
            item.decision?.card === card.id &&
            item.decision.offer === card.offerId,
        )
      ) {
        this.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
      const gesture =
        submission === undefined ? undefined : cardSubmissionSchema.safeParse(submission);
      if (
        source !== "chrome" ||
        (gesture &&
          (!gesture.success ||
            gesture.data.remounted ||
            gesture.data.offerId !== card.offerId ||
            gesture.data.lifecycleId !== card.lifecycleId))
      ) {
        this.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
    }
    // INF-1108: the first mate's held call waits on its card's own row, which
    // this resolution closes, so the click takes it in the same transaction.
    const firstmateAsk =
      !card.taskId &&
      associated &&
      card.author === "host" &&
      source === "chrome" &&
      effect?.kind === "request_write" &&
      effect.integration
        ? { rowId: associated.id, ask: effect.ask, choice: effect.integration }
        : undefined;
    let takenFirstmateAsk: IntegrationAskTaken | undefined;
    let closedAnswer: ReturnType<CardService["resolve"]>;
    try {
      closedAnswer = this.cards.resolve(card, actionId, actionId, answers, by, evidence, () => {
        if (firstmateAsk)
          takenFirstmateAsk = this.options.tasks.delivery.takeWriteAsk(
            firstmateAsk.rowId,
            firstmateAsk.ask,
          );
        if (validationDecision && card.taskId && card.offerId)
          this.options.tasks.delivery.decideLiveValidation(card.taskId, {
            card: card.id,
            offer: card.offerId,
            action: actionId,
            label: chosen.label,
            head: associated?.delivery?.validationHead ?? "",
            ticked: answers?.find((answer) => answer.name === VALIDATION_GAPS_FIELD)?.values ?? [],
          });
        carryOffer?.();
        if (card.taskId && associated?.delivery?.captainAction) {
          if (effect?.kind === "host" && effect.op === "confirm-required-action") {
            const [id, generation] = (effect.arg ?? "").split(":");
            if (id === card.taskId)
              this.options.tasks.delivery.completeCaptainAction(
                id,
                Number(generation),
                "confirmed",
              );
          } else this.options.tasks.delivery.deferCaptainAction(card.taskId);
        }
      });
    } catch (error) {
      if (!(error instanceof StaleValidationDecisionError) || !card.taskId || !card.offerId)
        throw error;
      this.options.tasks.delivery.expireValidationDecision(
        card.taskId,
        card.id,
        card.offerId,
        error.message,
      );
      this.cards.put({
        ...card,
        actions: [],
        title: "This validation question needs a new answer",
        body: `<p>This question changed, so I accepted no answer.</p><p>The crewmate must ask about the current validation facts.</p>${card.body}`,
      });
      this.cards.showOpenCard(card.id);
      // The app's own notice (INF-765): the captain's click was refused, so
      // it is neither his answer nor the first mate's steer, and it reopens
      // no cap either would.
      void this.steerInternal(
        card.taskId,
        {
          facts: {
            kind: "validation-question-stale",
            card: card.id,
            reason: error.message,
          },
        },
        { ...SUPERVISOR_STEER, cardId: card.id },
      ).catch((caught: unknown) => {
        console.warn("[crew] stale validation notice not delivered:", caught);
      });
      throw new CardChoiceUnavailableError("action-changed");
    }
    const choice: WakeChoice = {
      id: actionId,
      label: chosen.label,
      ...(valueJson !== undefined ? { value: valueJson } : {}),
      ...(answers ? { answers } : {}),
    };
    // Review carefully (INF-562): the captain's care lands on the record
    // first, so its notice waits on the crewmate's lane ahead of the choice
    // that starts it below, the way any choice on its card does.
    if (chosen.care && card.taskId && !closedAnswer && this.careFromCard(card.taskId, chosen.care))
      void this.reviewFromCard(card.taskId);
    // Merge anyway (INF-1137 friction 6): his click passes the checks at
    // the card's version before the merge below runs, so it merges now.
    if (chosen.passes === "checks" && source === "chrome" && card.taskId && !closedAnswer)
      this.passChecksFromCard(card, chosen.label, anythingElseOf(answers));
    switch (effect?.kind) {
      case "settle": {
        // Host-owned teardown: the host runs it instead of steering the
        // crewmate, and reportCardSettle wakes the Firstmate with whatever
        // came back - so the choice still round-trips, just after the work.
        // Every emit boundary refuses a settle without a task; belt and
        // braces here rather than a settle of nothing.
        if (!card.taskId) return {};
        const mode = effect.mode === "merge" ? this.mergeModeFor(card.taskId) : "discard";
        void this.settling.settle.reportCardSettle(
          card.taskId,
          mode,
          effect.confirm,
          effect.proceedWithOpen,
        );
        return {};
      }
      case "request_merge": {
        // The declaration granted nothing. Only this chrome click runs it.
        if (!card.taskId || source !== "chrome") return {};
        void this.settling.kept
          .requestMerge(card.taskId, effect.review)
          .catch((caught: unknown) => {
            console.warn("[crew] requested merge failed:", caught);
          });
        return {};
      }
      case "request_write": {
        // The declaration sent nothing. Only this chrome click sends the
        // kept write, once; the crewmate hears what came of it once.
        if (firstmateAsk && takenFirstmateAsk) {
          this.integrationAsks.answerFirstmateAsk(
            firstmateAsk.rowId,
            firstmateAsk.ask,
            takenFirstmateAsk,
            firstmateAsk.choice,
          );
          return {};
        }
        if (!card.taskId || source !== "chrome" || !this.options.sendWriteAsk) return {};
        const taskId = card.taskId;
        const askId = effect.ask;
        // Integration asks can only be answered on the app's own card.
        if (effect.integration && card.author !== "host") return {};
        this.answerWriteAsk(card, taskId, askId, effect.integration);
        return {};
      }
      case "open":
        if (effect.target === "browser") {
          // Only a crewmate still there can hear that the card's browser was gone.
          const told = closedAnswer ? undefined : choice;
          return effect.savedSignIn
            ? this.grantSavedSignInFromCard(card, told)
            : this.openBrowserFromCard(card, told);
        }
        return {
          effect: {
            kind: "open",
            target: effect.target,
            ...(effect.signIn ? { signIn: effect.signIn } : {}),
            ...(effect.make ? { make: effect.make } : {}),
            ...(effect.remove ? { remove: effect.remove } : {}),
            ...(effect.add ? { add: effect.add } : {}),
            ...(effect.update ? { update: effect.update } : {}),
            ...(effect.signInOn ? { signInOn: effect.signInOn } : {}),
            ...(effect.forgeSignInOn ? { forgeSignInOn: effect.forgeSignInOn } : {}),
          },
        };
      case "host":
        return this.runHostOp(effect, answers);
      default:
        break;
    }
    if (source === "chrome" && card.taskId && associated?.delivery?.captainAction) {
      // An ordinary conversational choice closes its offer, just like any
      // card action. The outstanding operation is then offered again so its
      // author can answer on the same card, without completing the action.
      this.cards.presentRequiredAction(card.taskId);
      const output = anythingElseOf(answers);
      this.replyToCard(card.id, output ? `${chosen.label}\n\n${output}` : chosen.label);
      return {};
    }
    if (cardId.startsWith(FIRSTMATE_CARD_PREFIX)) {
      // The answer to a Firstmate decision card returns to the agent.
      const wake: TypedWake = {
        facts: {
          kind: "card-choice",
          to: "firstmate",
          source,
          card: {
            id: card.id,
            title: card.title,
            ...(decisionTaskId ? { taskId: decisionTaskId } : {}),
          },
          choice,
        },
      };
      if (source === "chrome" && this.hooks.notifyCaptainChoice)
        this.hooks.notifyCaptainChoice(wake, decisionTaskId);
      else this.hooks.notifyOp(wake, "agent", decisionTaskId);
    } else if (card.taskId && !closedAnswer && card.author !== "host") {
      // The action round-trip: a declared choice on a crewmate's card
      // reaches its still-running session as a steering message. A host
      // card's choice with no effect - the stuck alert's Keep waiting - only
      // closes that alert for this episode. The minus instead keeps it pending.
      this.steerChoice(card.taskId, card, source, choice);
    }
    return {};
  }

  /**
   * The captain's care from a card's button (INF-562): the same writer and
   * notice as update_task, with the captain as its author and the merge
   * card as where it came from. A refusal is a feed line, never a silent no-op.
   */
  private careFromCard(taskId: string, care: Rigor): boolean {
    const before = this.options.tasks.policiesOf(this.options.tasks.get(taskId));
    try {
      this.options.tasks.updateFields(
        taskId,
        { policies: { rigor: care }, direction: "the merge card" },
        "captain",
      );
    } catch (caught) {
      if (!(caught instanceof TaskGraphRefusal)) throw caught;
      this.options.broadcastEvent({ type: "firstmate_note", text: caught.message, taskId });
      return false;
    }
    this.policiesChanged(taskId, { rigor: care }, before);
    return true;
  }

  /**
   * The review the captain's Review carefully asks for (INF-1875): the app
   * starts it on the builder's committed version - the one its merge card
   * offered - as soon as the care is on the record. The click is a typed
   * fact starting an operation, never a judgment; the reviewer's brief
   * carries the card the captain read. What the app cannot start it says in
   * the feed, and the first mate starts the review as on any Careful task.
   */
  private async reviewFromCard(taskId: string): Promise<void> {
    const builder = this.options.tasks.get(taskId);
    if (!builder || TaskService.isClosed(builder)) return;
    try {
      if (!builder.intent) throw new Error("the task has no recorded words to review against.");
      const { taskId: reviewId } = await this.intake.commissionReview(
        {
          title: `Review: ${builder.title}`,
          intent: builder.intent,
          ...(builder.repoId ? { repoId: builder.repoId } : {}),
        },
        builder.id,
      );
      const review = this.options.tasks.get(reviewId);
      if (this.options.tasks.get(taskId))
        this.options.tasks.note(
          taskId,
          `the app started review ${review?.key || reviewId} of the version on the merge card`,
          { news: true, data: { reviewTaskId: reviewId } },
        );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `${REVIEW_CAREFULLY_WORDS}: the app could not start the review of ${builder.key || builder.id}: ${message}`,
        taskId,
      });
    }
  }

  /**
   * The captain's Merge anyway click (INF-1137 friction 6): his own word,
   * one click, that the failed checks do not hold the version the card
   * offers. It is the recorded override on the checks for that version
   * (`HoldOverride`), in his name and with the button's words as its
   * reason, so the merge it starts and every other site that reads the
   * checks hold see the same record. A new version brings the hold back.
   */
  private passChecksFromCard(card: Card, label: string, written?: string): void {
    const taskId = card.taskId;
    const record = taskId ? this.options.tasks.get(taskId) : undefined;
    if (!taskId || !record) return;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const offer = approvableOffer(record, repo, this.taskDelivery(taskId), {
      cardId: card.id,
      offerId: card.offerId,
    });
    const head = offer?.baseline.headSha ?? record.delivery?.headSha;
    if (!head) return;
    const prNumber =
      offer?.baseline.prNumber ?? currentChange(record.delivery, record.branch).number;
    const override: HoldOverride = {
      words: choiceWords(label, card.title, written),
      holds: ["checks"],
      until: "version",
      head,
      ...(prNumber !== undefined ? { prNumber } : {}),
      at: this.now(),
    };
    this.options.tasks.delivery.recordPermissionRecords(
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
    this.overrides.overrideNoticed(taskId, override);
  }

  /** A choice on a crewmate's card, steered to its session through the task's durable lane. */
  private steerChoice(
    taskId: string,
    card: Card,
    source: "chrome" | "frame",
    choice: WakeChoice,
    browserGone?: "stopped" | "quit",
  ): void {
    void this.steerCrewmate(
      taskId,
      {
        facts: {
          kind: "card-choice",
          to: "crewmate",
          source,
          card: { title: card.title, id: card.id },
          choice,
          ...(browserGone ? { browserGone } : {}),
        },
      },
      source === "chrome" ? "captain" : "firstmate",
      { via: "card", cardId: card.id },
    ).catch((caught: unknown) => {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Could not deliver the card choice for "${this.taskTitle(taskId)}": ${message}`,
        taskId,
      });
    });
  }

  /**
   * Whether the browser a request card's attachment names is gone
   * (docs/task-browser.md, "Asking for help"), read off the task's browser
   * fact as the view reads it (`attachmentStanding`): ended by the app's
   * quit since, or stopped in this run, with or without a newer one after
   * it. Absent while that browser still runs.
   */
  private cardBrowserGone(
    taskId: string,
    handle: TaskBrowserHandle,
  ): "stopped" | "quit" | undefined {
    const fact = this.options.browsers?.fact(taskId);
    const standing = attachmentStanding(handle, fact);
    if (standing === "restarted") return "quit";
    return standing === "replaced" || fact?.state !== "open" ? "stopped" : undefined;
  }

  /**
   * The captain's open-browser click reached no browser: the one his
   * request card names is gone. The card stays answered, its crewmate hears
   * his choice and that its browser was gone, so it can open the site again
   * and ask anew, and the feed says so.
   */
  private cardBrowserWasGone(
    card: Card,
    taskId: string,
    told: WakeChoice,
    gone: "stopped" | "quit",
  ): void {
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `The card's browser for "${this.taskTitle(taskId)}" had stopped${gone === "quit" ? " when Infinitary quit" : ""}, so its crewmate is told to open the site again and ask you anew.`,
      taskId,
    });
    this.steerChoice(taskId, card, "chrome", told, gone);
  }

  /**
   * The captain's click on a request card's open-browser action
   * (docs/task-browser.md, "Asking for help"): the browser the card's
   * attachment names passes to him - its crewmate's command finishing first
   * - and the shell opens its view. A newer or older browser is never taken:
   * the view opens on whatever the task's browser is now, saying so. Only a
   * click on the card's own controls reaches here (`act` refuses an effect
   * from a frame), and the crewmate is told nothing until he returns it -
   * unless that browser is gone, when it hears his choice (`told`) at once.
   */
  private openBrowserFromCard(card: Card, told?: WakeChoice): { effect?: ShellEffect } {
    const attachment = card.attachment;
    const taskId = card.taskId;
    if (!taskId || attachment?.kind !== "browser" || attachment.taskId !== taskId) return {};
    const handle = { session: attachment.session, generation: attachment.generation };
    const taken: Promise<TaskBrowserCommandResult | undefined> =
      this.options.browsers?.takeControl(taskId, handle) ?? Promise.resolve(undefined);
    void taken
      .catch(() => undefined)
      .then((result) => {
        if (result?.ok || !told) return;
        const gone = this.cardBrowserGone(taskId, handle);
        if (gone) this.cardBrowserWasGone(card, taskId, told, gone);
      });
    return {
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId, ...handle, cardId: card.id },
      },
    };
  }

  /**
   * The captain's click on a request card's saved sign-in
   * (docs/task-browser.md, "Saved sign-ins"): the browser the card's
   * attachment names gets the site's saved sign-in and goes back to its
   * crewmate, and the shell opens its view, where the captain watches it
   * carry on. When the saved sign-in cannot be used the browser stays paused
   * for the captain, and the feed says why; when that browser is gone, its
   * crewmate hears his choice (`told`) at once, as an open-browser click's
   * does.
   */
  private grantSavedSignInFromCard(card: Card, told?: WakeChoice): { effect?: ShellEffect } {
    const attachment = card.attachment;
    const taskId = card.taskId;
    if (!taskId || attachment?.kind !== "browser" || attachment.taskId !== taskId) return {};
    const handle = { session: attachment.session, generation: attachment.generation };
    const refused = (text: string) => {
      const gone = this.cardBrowserGone(taskId, handle);
      if (gone) {
        if (told) this.cardBrowserWasGone(card, taskId, told, gone);
        return;
      }
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Your saved sign-in was not used for "${this.taskTitle(taskId)}": ${text} Its browser is still paused for you.`,
        taskId,
      });
    };
    const browsers = this.options.browsers;
    if (!browsers?.grantSavedSignIn) refused(`${HERE.this} keeps no saved sign-ins.`);
    else {
      void browsers
        .grantSavedSignIn(taskId, handle)
        .then((result) => {
          if (!result.ok) refused(result.text);
        })
        .catch(() => refused(`${HERE.this} could not use it right now.`));
    }
    return {
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId, ...handle, cardId: card.id },
      },
    };
  }

  /**
   * The captain handed a task's browser back (docs/task-browser.md, "Taking
   * control"): its crewmate's one steer, named by the return so the inbox
   * queues it once, through the task's durable lane like any other. A
   * request card still up for that browser goes first.
   */
  browserReturned(taskId: string, returned: BrowserReturned): void {
    this.takeDownAnsweredRequests(taskId);
    if (this.options.inbox.woken(taskId, returned.once)) return;
    this.options.tasks.turns.endIdle(taskId);
    const wake: TypedWake = {
      facts: {
        kind: "browser-returned",
        site: returned.site,
        ...(returned.after ? { after: returned.after } : {}),
        ...(returned.saved ? { saved: true as const } : {}),
      },
      once: returned.once,
    };
    void this.steerInternal(taskId, wake, SUPERVISOR_STEER).catch((caught: unknown) => {
      // No conversation to resume: the ladder reads the task on its own clock.
      console.warn("[crew] browser return's steer not delivered:", caught);
    });
  }

  /**
   * A request card whose browser the captain just handed back asked for
   * what he has done (docs/task-browser.md, "Asking for help"): he took that
   * browser from the record rather than with the card's own action, which
   * would have answered it. The card leaves on his return, so he comes back
   * to no card, and its crewmate hears only the return's one wake. A card
   * naming an older browser stays, since its click tells its crewmate that
   * browser is gone.
   */
  private takeDownAnsweredRequests(taskId: string): void {
    const fact = this.options.browsers?.fact(taskId);
    for (const open of [...this.cards.values()]) {
      const card = this.cards.shown(open.id);
      const attachment = card?.attachment;
      if (!card || card.taskId !== taskId || attachment?.kind !== "browser") continue;
      if (!attachment.handoff || attachmentStanding(attachment, fact) !== "same") continue;
      this.cards.takeDown(card.id, "browser-returned");
    }
  }

  /**
   * A merge effect in the task's own words: the PR on a direct-pr repo, the
   * branch into the local checkout otherwise. The agent that declared the
   * effect never learns the difference (ruling D2).
   */
  private mergeModeFor(taskId: string): "merge-pr" | "land" {
    return opensPullRequest(this.taskDelivery(taskId)) ? "merge-pr" : "land";
  }

  /**
   * What a completion card's merge says it does (captain INF-1555 F12):
   * pending checks keep the captain's approval and read Merge when checks pass;
   * failed checks read Merge after fixing errors (captain INF-1555 F20);
   * otherwise Merge the pull request. Raw check results remain separate. The captain's override on the checks
   * at the card's version passes either, so a click merges now and it reads
   * Merge the pull request (INF-756). Undefined - the label as it stands -
   * on a card whose click approves nothing (`approvableOffer`), where a
   * click on such checks is only refused.
   */
  private mergeLabel(card: Card): string | undefined {
    const record = card.taskId ? this.options.tasks.get(card.taskId) : undefined;
    if (!record) return undefined;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const offer = approvableOffer(record, repo, this.taskDelivery(record.id), {
      cardId: card.id,
      offerId: card.offerId,
    });
    if (!offer) return undefined;
    const head = offer.baseline.headSha;
    if (record.delivery?.headSha === head && overridePasses(record.delivery, "checks", head))
      return MERGE_WORDS["merge-pr"];
    const ci = currentCheckStatus(record.delivery);
    if (ci === "red") return MERGE_AFTER_FIXING_WORDS;
    return ci === "pending" ? MERGE_WHEN_CHECKS_PASS_WORDS : MERGE_WORDS["merge-pr"];
  }

  /**
   * Whether a completion card offers Merge anyway beside its merge
   * (INF-1137 friction 6): on an offer a click would approve, while the
   * pull request is still at the card's version and its checks failed,
   * and the captain's override does not already pass them.
   * It goes when the checks no longer fail or a new version comes.
   */
  private mergeAnyway(card: Card): boolean {
    const record = card.taskId ? this.options.tasks.get(card.taskId) : undefined;
    if (!record?.delivery || currentCheckStatus(record.delivery) !== "red") return false;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const offer = approvableOffer(record, repo, this.taskDelivery(record.id), {
      cardId: card.id,
      offerId: card.offerId,
    });
    const head = offer?.baseline.headSha;
    if (!head || record.delivery.headSha !== head) return false;
    return !overridePasses(record.delivery, "checks", head);
  }

  private answerWriteAsk(
    card: Card,
    taskId: string,
    askId: string,
    choice?: IntegrationApprovalChoice,
  ): void {
    void this.options.sendWriteAsk?.(taskId, askId, choice).then((sent) => {
      const still = this.options.tasks.get(taskId);
      if (!still || TaskService.isClosed(still)) return;
      if (sent.ask) {
        this.options.tasks.note(taskId, writeSentLine(sent), {
          news: false,
          feed: true,
          actor: "host",
        });
      }
      void this.steerCrewmate(
        taskId,
        {
          facts: {
            kind: "write-answered",
            ask: askId,
            call: sent.call,
            place: sent.place,
            outcome: sent.outcome.kind,
            ...(sent.outcome.kind === "answered" ? { status: sent.outcome.status } : {}),
            ...(sent.outcome.kind === "unknown" || sent.outcome.kind === "refused"
              ? { why: sent.outcome.why }
              : {}),
            ...(sent.answer !== undefined ? { answer: sent.answer } : {}),
          },
          once: `write-answered:${askId}`,
        },
        "captain",
        { via: "card", cardId: card.id },
      ).catch((caught: unknown) => {
        console.warn("[crew] write outcome not delivered:", caught);
      });
    });
  }

  /**
   * The host cards' own operations, keyed on the declared op. `answers` are
   * what the captain's click carried from the card's own questions.
   */
  private runHostOp(effect: HostEffect, answers?: readonly CardAnswer[]): { effect?: ShellEffect } {
    switch (effect.op) {
      case "confirm-required-action": {
        const [id] = (effect.arg ?? "").split(":");
        if (id && this.options.tasks.get(id)?.status === "open")
          this.cards.presentRequiredAction(id);
        void this.sweepGates(this.now());
        return {};
      }
      case "defer-required-action":
        if (effect.arg) this.options.tasks.delivery.deferCaptainAction(effect.arg);
        return {};
      case "retry-firstmate":
        this.hooks.retryConverse();
        return {};
      case "move-flagship":
        if (effect.arg) this.hooks.moveFlagship?.(effect.arg);
        return {};
      case "try-again":
        if (effect.arg) this.hooks.tryAgain?.(effect.arg);
        return {};
      case "restore-account":
        // The shell lands on Subscriptions with the account to re-sign.
        return {
          effect: {
            kind: "open",
            target: "subscriptions",
            ...(effect.arg ? { restoreAccountId: effect.arg } : {}),
          },
        };
      case "add-plugin":
        if (effect.arg) this.pluginConsent?.add(effect.arg);
        return {};
      case "decline-plugin":
        if (effect.arg) this.pluginConsent?.decline(effect.arg);
        return {};
      case "apply-project-change":
        this.projectChange?.apply(effect.arg);
        return {};
      case "decline-project-change":
        this.projectChange?.decline(effect.arg);
        return {};
      case "add-project":
        this.projectSetup?.add(effect.arg, answers);
        return {};
      case "decline-project":
        this.projectSetup?.decline(effect.arg);
        return {};
      case "move-task": {
        // The sign-in card's Move (INF-849): `arg` is the task, the
        // provider it moves off and the model the card offered.
        const [taskId, from, ...offered] = effect.arg?.split(":") ?? [];
        if (!taskId || !from) return {};
        const moved = this.moves.requestMove(taskId, {
          by: "captain",
          from,
          ...(offered.length > 0 ? { offered: offered.join(":") } : {}),
        });
        if (!moved.ok)
          this.options.broadcastEvent({ type: "firstmate_note", text: moved.text, taskId });
        return {};
      }
      case "continue-task":
        // The stall card's Continue: the ladder's nudge again, now with the
        // captain's authority - a new turn, which ends the episode.
        if (effect.arg) this.continueStuckTask(effect.arg, "card");
        return {};
      case "stop-task":
        if (effect.arg) this.stopTask(effect.arg, "shell");
        return {};
      case "start-task":
        if (effect.arg) this.startOnRequest(effect.arg);
        return {};
      case "ask-again":
        if (effect.arg) this.hooks.askAgain?.(effect.arg);
        return {};
    }
  }

  /**
   * A lifecycle toggle from the task record's footer or the task board.
   * Start, stop and continue run the stall card's host ops; a Start the
   * host refuses at once comes back as text as well as its feed line. Drop
   * task is the footer's own: never-started work, captain-attributed, and a
   * refusal is text for the popover rather than a feed line. Queue and
   * unqueue are the board's (`setQueued`): a refusal is text and writes
   * nothing, and a queued task that nothing holds starts on the next sweep.
   * Nothing resolves a card as an answer. Each click lands on the task's
   * history as the captain's, from the task card (`via: "task-card"`), and
   * wakes nobody: the Firstmate's next context block lists it beside his
   * card choices (FI3-695).
   */
  runTaskOp(
    taskId: string,
    op: TaskLifecycleOp,
    review?: DropTaskReview,
    from?: TaskMoveFrom,
  ): string | undefined {
    // A move a panel made on the captain's click names that panel beside it.
    const panel = from?.panel;
    switch (op) {
      case "answer-done": {
        if (!this.cards.finishAnswer(taskId)) return "This task has no answer ready to mark Done.";
        return undefined;
      }
      case "dismiss-question":
        return this.cards.dismissQuestion(taskId);
      case "show-card": {
        const action = this.options.tasks.get(taskId)?.delivery?.captainAction;
        if (action && !this.cards.presentRequiredAction(taskId))
          return "This action cannot be shown until its prerequisites finish.";
        const cardId =
          action?.cardId ??
          this.cards
            .snapshot()
            .find(
              (card) =>
                (card.taskId === taskId ||
                  this.options.tasks.capture.openCardTaskFor(card.id)?.id === taskId) &&
                card.status === "ready" &&
                card.actions.length,
            )?.id;
        if (!cardId) return "This task has no card to show.";
        this.cards.showOpenCard(cardId);
        return undefined;
      }
      case "drop-task":
        return this.dropFromRecord(taskId, review, panel);
      case "queue-task":
      case "unqueue-task":
        return this.queueFromBoard(taskId, op, panel);
      case "start-again": {
        if (!this.options.tasks.get(taskId)) return "This task could not be found.";
        const result = this.startAgain(taskId, "captain", panel);
        if (!result.ok) return result.text;
        void result.started
          .then((text) => {
            if (
              this.options.tasks.get(result.task.id)?.status !== "active" &&
              !this.pendingStarts.has(result.task.id)
            )
              this.options.broadcastEvent({ type: "firstmate_note", text, taskId: result.task.id });
          })
          .catch((caught: unknown) => this.reportCardEffectFailure(result.task.id, caught));
        return undefined;
      }
      case "start-task":
        return this.startOnRequest(taskId, TASK_CARD_VIA, panel);
      case "continue-task":
        this.continueStuckTask(taskId, TASK_CARD_VIA, panel);
        return undefined;
      case "stop-task":
        this.stopTask(taskId, TASK_CARD_VIA, panel);
        return undefined;
    }
  }

  /**
   * Drop never-started work the captain no longer wants. Open parts are
   * refused. A start already requested, or a review that no longer matches,
   * refuses and writes nothing. Outstanding cards come down as obsolete.
   */
  private dropFromRecord(
    taskId: string,
    review: DropTaskReview | undefined,
    panel?: string,
  ): string | undefined {
    const record = this.options.tasks.get(taskId);
    const key = record?.key || taskId;
    if (!record) return dropMissingRefusal(key);
    if (!review) return DROP_REVIEW_STALE;
    if (this.starting.has(taskId) || this.pendingStarts.has(taskId) || this.tasks.has(taskId))
      return dropStartedRefusal(key);
    try {
      this.settling.closing.closeAndPurge([taskId], () => {
        const result = this.options.tasks.starts.dropUnstarted(taskId, {
          actor: "captain",
          review,
          reason: NO_LONGER_WANTED,
          via: TASK_CARD_VIA,
          ...(panel ? { panel } : {}),
        });
        if (!result.ok) {
          const refused = new Error(result.text);
          refused.name = "DropRefused";
          throw refused;
        }
      });
    } catch (caught) {
      if (caught instanceof Error && caught.name === "DropRefused") return caught.message;
      throw caught;
    }
    for (const card of [...this.cards.values()]) {
      if (card.taskId === taskId) this.cards.takeDown(card.id, "obsolete");
    }
    this.intake.graphChanged();
    return undefined;
  }

  /**
   * The task board's queue and unqueue on never-started work. A start
   * already requested refuses as started; the task service guards the rest
   * at write time. A queued task the ready query now takes starts on the
   * sweep `TaskIntake.graphChanged` runs.
   */
  private queueFromBoard(
    taskId: string,
    op: "queue-task" | "unqueue-task",
    panel?: string,
  ): string | undefined {
    const record = this.options.tasks.get(taskId);
    const key = record?.key || taskId;
    if (!record) return queueMissingRefusal(key);
    if (this.starting.has(taskId) || this.pendingStarts.has(taskId))
      return queueStartedRefusal(key);
    // Started work goes back to the backlog with its work kept (INF-2062).
    if (record.kind === "work" && record.status === "active") {
      if (op === "queue-task") return queueStartedBacklogRefusal(key);
      const moved = this.moveToBacklog(taskId, {
        actor: "captain",
        via: TASK_CARD_VIA,
        decision: null,
        ...(panel ? { panel } : {}),
      });
      return moved.ok ? undefined : moved.text;
    }
    if (this.tasks.has(taskId)) return queueStartedRefusal(key);
    const result = this.options.tasks.starts.setQueued(taskId, op, {
      actor: "captain",
      via: TASK_CARD_VIA,
      ...(panel ? { panel } : {}),
    });
    if (!result.ok) return result.text;
    if (!result.changed) return undefined;
    if (op === "queue-task") {
      // Queued work that nothing holds would start at once: that is a
      // Start, and goes through the Firstmate like one. Work that waits
      // has his directions applied now, so the sweep starts it carrying them.
      if (this.options.tasks.graph.listReady().some((ready) => ready.id === taskId)) {
        return this.startOnRequest(taskId, TASK_CARD_VIA, panel);
      }
      this.tellFirstmate(taskId, "queue");
    }
    this.intake.graphChanged();
    return undefined;
  }

  /**
   * A started task goes back to the backlog (INF-2062; docs/task-board.md,
   * "Moves"): the task board's Back to backlog, and update_task
   * start_policy on-request on started work. Its running turn stops and a
   * kept merge approval ends, as an interrupt does; its working copy,
   * branch, conversation, change and jobs stay. Nothing the host sends
   * wakes it there, and Start picks it up in the same conversation
   * (`startFromBacklog`).
   */
  moveToBacklog(
    taskId: string,
    source: InterruptSource,
    reason?: string,
  ): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) return { ok: false, text: queueMissingRefusal(taskId) };
    const handle = `${record.key || record.id} "${record.title}"`;
    const result = this.options.tasks.starts.setQueued(taskId, "unqueue-task", {
      actor: source.actor,
      ...(source.via === TASK_CARD_VIA ? { via: TASK_CARD_VIA } : {}),
      ...(source.panel ? { panel: source.panel } : {}),
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
    });
    if (!result.ok) return result;
    if (!result.changed) return { ok: true, text: `${handle} already waits in the backlog.` };
    void this.interruptCrewmate(taskId, "interrupt", { ...source, backlog: true }).catch(
      (caught: unknown) => {
        console.warn("[crew] the backlog move could not stop the turn:", caught);
      },
    );
    this.broadcastCrewCounts();
    this.intake.graphChanged();
    return {
      ok: true,
      text: `Moved ${handle} back to the backlog: its turn stops and its work stays. Nothing wakes it until update_task start_now or the captain's Start.`,
    };
  }

  /**
   * Start on a started task in the backlog (INF-2062): it leaves the
   * backlog, and its crewmate hears everything that waited on its lane,
   * with one line that it left, in the same conversation.
   */
  private startFromBacklog(
    record: TaskRecord,
    actor: "captain" | "firstmate",
    from?: typeof TASK_CARD_VIA,
    panel?: string,
  ): string {
    const handle = `${record.key || record.id} "${record.title}"`;
    const left = this.options.tasks.starts.leaveBacklog(record.id, {
      actor,
      ...(from ? { via: from } : {}),
      ...(panel ? { panel } : {}),
    });
    if (!left) return `${handle} is not in the backlog.`;
    this.announceReach(record.id);
    this.options.inbox.enqueue(record.id, backlogLeftLine(actor));
    const task = this.tasks.get(record.id);
    if (task?.session && !task.cancelled) {
      this.deliverPendingToTask(task);
    } else {
      const now = this.options.tasks.get(record.id);
      if (now && TaskService.isResumable(now) && now.sessionFile && !this.laneHeld(record.id))
        void this.resumeTask(record.id)
          .then((resumed) => this.deliverPendingToTask(resumed))
          .catch(() => {
            // The row is durable; the tick sweep retries the resume.
          });
    }
    this.broadcastCrewCounts();
    this.intake.graphChanged();
    return `Started ${handle} again from the backlog. Its crewmate carries on in the same conversation.`;
  }

  /**
   * Why a start on the captain's click would be refused at once, in his
   * words, or undefined when it may go ahead: the checks `startQueuedNow`
   * makes before its first await.
   */
  private startRefusal(record: TaskRecord, audience: "tool" | "captain"): string | undefined {
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.status !== "open" || record.kind !== "work") {
      return `Cannot start ${handle} now: it is ${describeStatus(record)}, not queued work.${record.status === "dropped" ? (audience === "tool" ? " On the captain’s request, use update_task start_again to create a replacement." : " Use Start again on its record to create a replacement.") : ""}`;
    }
    // The Firstmate finishes a pending Start; nobody else starts it twice.
    const awaitsFirstmate = audience === "tool" && this.pendingStarts.has(record.id);
    if (
      this.tasks.has(record.id) ||
      (this.options.tasks.starts.startAttemptOf(record.id) && !awaitsFirstmate)
    )
      return `${handle} is already starting.`;
    const blockers = this.options.tasks.graph
      .blockers(record.id)
      .filter((blocker) => !TaskService.blockerCleared(blocker));
    if (blockers.length > 0) return startWaitRefusal(record, handle, blockers, audience);
    return undefined;
  }

  /** The wake that tells the Firstmate the captain moved a task toward starting. */
  private tellFirstmate(
    taskId: string,
    move: "start" | "queue",
    from?: typeof TASK_CARD_VIA,
    panel?: string,
  ): number | null {
    const record = this.options.tasks.get(taskId);
    if (!record) return null;
    const id = this.hooks.notifyOp(
      {
        facts: {
          kind: "captain-start",
          task: { id: taskId, key: record.key || taskId, title: record.title },
          move,
          at: this.now(),
          ...(from ? { from } : {}),
          ...(panel ? { panel } : {}),
        },
      },
      "agent",
      taskId,
    );
    return typeof id === "number" ? id : null;
  }

  /**
   * Hold the captain's Start as Starting and tell the Firstmate, unless it
   * cannot answer: a seat that is paused or a lane in a provider outage, both
   * typed facts, start the task as it is and say so. True when the Start now
   * waits for the Firstmate's turn.
   */
  private askFirstmateFirst(
    record: TaskRecord,
    from?: typeof TASK_CARD_VIA,
    panel?: string,
  ): boolean {
    if (!this.hooks.firstmateCannotAnswer) return false;
    const cannot = this.hooks.firstmateCannotAnswer();
    if (cannot) {
      this.sayStartedAsIs(record.id, cannot);
      return false;
    }
    const rowId = this.tellFirstmate(record.id, "start", from, panel);
    if (rowId === null) return false;
    this.pendingStarts.set(record.id, {
      rowId,
      ...(from ? { from } : {}),
      ...(panel ? { panel } : {}),
    });
    this.options.tasks.starts.beginStartAttempt(record.id);
    return true;
  }

  private sayStartedAsIs(taskId: string, why: string): void {
    this.options.tasks.note(taskId, `started without applying your standing directions: ${why}`, {
      news: true,
    });
  }

  /** A pending Start whose waiting is over begins as it is. */
  private startPendingAsIs(taskId: string, why: string): void {
    const pending = this.pendingStarts.get(taskId);
    if (!pending) return;
    this.pendingStarts.delete(taskId);
    this.options.tasks.starts.clearStartAttempt(taskId);
    this.sayStartedAsIs(taskId, why);
    this.starting.add(taskId);
    void this.startQueuedNow(taskId, "captain", pending.from, pending.panel, true)
      .finally(() => this.starting.delete(taskId))
      .then((result) => {
        if (this.options.tasks.get(taskId)?.status === "active") return;
        this.options.broadcastEvent({ type: "firstmate_note", text: result, taskId });
      })
      .catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
  }

  /**
   * The Firstmate's turn ended over these inbox rows (acknowledged or
   * released). A Start it read and did not start begins as it is: the turn
   * failed, broke, or finished without starting it. Answers the rows to
   * acknowledge, so a released wake is not served again for a task that began.
   */
  firstmateTurnEnded(rowIds: readonly number[], outcome: "clean" | "failed" | "broke"): number[] {
    const handled: number[] = [];
    for (const [taskId, pending] of [...this.pendingStarts]) {
      if (!rowIds.includes(pending.rowId)) continue;
      handled.push(pending.rowId);
      this.startPendingAsIs(
        taskId,
        outcome === "clean"
          ? "your first mate finished its turn without starting it"
          : outcome === "failed"
            ? "your first mate's turn failed"
            : "your first mate's turn broke",
      );
    }
    return handled;
  }

  /**
   * After a quit, the wake rows on the Firstmate's lane are the saved copy of
   * each pending Start: the task shows Starting again, and a Start whose row
   * is gone begins as it is. Run on the shared tick.
   */
  private resumePendingStarts(): void {
    const rows = () => [
      ...this.options.inbox.allFor(FIRSTMATE_RECIPIENT),
      ...this.options.inbox.inFlight(FIRSTMATE_RECIPIENT),
    ];
    if (!this.pendingStartsResumed) {
      this.pendingStartsResumed = true;
      for (const row of rows()) {
        const facts = row.facts as
          | { kind?: string; move?: string; task?: { id: string }; from?: string; panel?: string }
          | undefined;
        if (facts?.kind !== "captain-start" || facts.move !== "start" || !facts.task) continue;
        const record = this.options.tasks.get(facts.task.id);
        if (
          record?.status !== "open" ||
          record.kind !== "work" ||
          this.pendingStarts.has(record.id)
        )
          continue;
        this.pendingStarts.set(record.id, {
          rowId: row.id,
          ...(facts.from === TASK_CARD_VIA ? { from: TASK_CARD_VIA } : {}),
          ...(facts.panel ? { panel: facts.panel } : {}),
        });
        this.options.tasks.starts.beginStartAttempt(record.id);
      }
    }
    for (const [taskId, pending] of [...this.pendingStarts]) {
      if (this.options.inbox.get(pending.rowId)) continue;
      this.startPendingAsIs(taskId, "your first mate's request for it was lost");
    }
  }

  /**
   * Start a charted task now on the captain's click: the Firstmate's
   * `update_task start_now` path, which also clears a hold. A task that
   * did not start says why in the feed; one refused at once also returns
   * why, for the surface that asked. The id is marked starting before the
   * first await, so a drop in that window refuses.
   */
  private startOnRequest(
    taskId: string,
    from?: typeof TASK_CARD_VIA,
    panel?: string,
  ): string | undefined {
    const record = this.options.tasks.get(taskId);
    if (record?.status === "active" && record.backlogSince != null) {
      this.startFromBacklog(record, "captain", from, panel);
      return undefined;
    }
    const refused = record ? this.startRefusal(record, "captain") : undefined;
    if (refused) {
      this.options.broadcastEvent({ type: "firstmate_note", text: refused, taskId });
      return refused;
    }
    if (this.starting.has(taskId)) {
      const handle = `${record?.key || taskId} "${record?.title ?? taskId}"`;
      const already = `${handle} is already starting.`;
      this.options.broadcastEvent({ type: "firstmate_note", text: already, taskId });
      return already;
    }
    this.starting.add(taskId);
    void this.startQueuedNow(taskId, "captain", from, panel)
      .finally(() => {
        this.starting.delete(taskId);
      })
      .then((result) => {
        if (this.options.tasks.get(taskId)?.status === "active" || this.pendingStarts.has(taskId))
          return;
        this.options.broadcastEvent({ type: "firstmate_note", text: result, taskId });
      })
      .catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
    return undefined;
  }

  /**
   * The ladder's nudge with the captain's authority. The stall card's names
   * its card; the task card's names where it came from, so the two clicks
   * read apart on the record and neither is listed twice.
   */
  private continueStuckTask(
    taskId: string,
    from: "card" | typeof TASK_CARD_VIA,
    panel?: string,
  ): void {
    void this.steerCrewmate(
      taskId,
      this.ladder.nudgeFor(taskId),
      "captain",
      from === "card"
        ? { via: "card", cardId: stallCardId(taskId) }
        : { via: from, ...(panel ? { panel } : {}) },
    ).catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
  }

  /** Drop task on started work: the captain's cancel, which keeps its unfinished work. */
  private stopTask(taskId: string, via: "shell" | typeof TASK_CARD_VIA, panel?: string): void {
    void this.interruptCrewmate(taskId, "cancel", {
      actor: "captain",
      via,
      decision: null,
      ...(panel ? { panel } : {}),
    }).catch((caught: unknown) => this.reportCardEffectFailure(taskId, caught));
  }

  /**
   * A computer that runs work is being removed (docs/devices.md, "Remove"):
   * each task started there stops, as the captain's Stop stops one, and
   * this resolves once each one's record is closed. One whose computer is
   * out of reach cannot end its turn there, so it stops here at once, and
   * so does one still open after `boundMs`. A task that has not started
   * follows its project instead (`TaskPlacement.projectMoved`), and one the
   * captain said runs there follows its parent's or its project's again.
   */
  async stopTasksOn(deviceId: string, boundMs = 60_000): Promise<void> {
    for (const taskId of this.options.tasks.placement.forgetRunsOn(deviceId))
      this.placement.runsOnChanged(taskId);
    const source: InterruptSource = { actor: "captain", via: "shell", decision: null };
    const started = this.options.tasks
      .listLive()
      .filter(
        (record) =>
          record.deviceId === deviceId &&
          Boolean(
            record.placement || record.branch || record.sessionFile || this.tasks.has(record.id),
          ),
      )
      .map((record) => record.id);
    const stopHere = (taskId: string) => {
      const task = this.tasks.get(taskId);
      if (!task) {
        const record = this.options.tasks.get(taskId);
        if (record?.placement && !TaskService.isClosed(record))
          this.settling.closing.closeRecord(taskId, "cancelled", undefined, "captain");
        return;
      }
      this.recordInterrupt(taskId, "cancel", source, "requested");
      this.finish(task, "cancelled");
    };
    for (const taskId of started) {
      if (this.tasks.has(taskId) && this.outOfReach(taskId)) {
        stopHere(taskId);
        continue;
      }
      await this.interruptCrewmate(taskId, "cancel", source).catch(() => stopHere(taskId));
    }
    const open = () =>
      started.filter((taskId) => {
        const record = this.options.tasks.get(taskId);
        return record !== undefined && !TaskService.isClosed(record);
      });
    if (open().length === 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = this.options.tasks.onChange(() => {
        if (open().length === 0) done();
      });
      const timer = setTimeout(() => {
        for (const taskId of open()) stopHere(taskId);
        done();
      }, boundMs);
      timer.unref?.();
    });
  }

  /** A stall card's effect that could not run: one feed line, as a card choice's does. */
  private reportCardEffectFailure(taskId: string | undefined, caught: unknown): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Could not carry out your choice for "${this.taskTitle(taskId)}": ${message}`,
      ...(taskId ? { taskId } : {}),
    });
  }

  /** The corner never ends work; a read note still gives its author the next turn. */
  close(cardId: string, submission?: unknown): void {
    const card = this.cards.shown(cardId);
    // CardService distinguishes an ordinary read from putting aside a card
    // or reading a marked saved answer. Only that read notifies its author.
    if (card && this.cards.dismiss(card, submission)) this.tellCardClosed(card);
  }

  /**
   * An ordinary read or duplicate closure on a live task reaches its author
   * through the existing turn path. Only an ordinary read acknowledges its note;
   * `duplicateOf` names the earlier card a duplicate closure repeats.
   */
  private tellCardClosed(card: Card, duplicateOf?: { id: string; title: string }): void {
    const cardId = card.id;
    const taskId = card.taskId;
    const record = taskId ? this.options.tasks.get(taskId) : undefined;
    if (!taskId || !record || TaskService.isClosed(record)) return;
    if (cardEmitter(card.id, taskId) !== "crewmate") return;
    // A record no crewmate can hear - no live session and none to resume -
    // has nobody to tell; the close stays on the record alone.
    if (!this.tasks.has(taskId) && !record.sessionFile) return;
    void this.steerCrewmate(
      taskId,
      {
        facts: {
          kind: "card-closed",
          card: { id: card.id, title: card.title },
          ...(duplicateOf ? { duplicateOf } : { read: true as const }),
        },
      },
      "captain",
      { via: "card", cardId },
    ).catch((caught: unknown) => {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Could not deliver your close of "${card.title}" for "${this.taskTitle(taskId)}": ${message}`,
        taskId,
      });
    });
  }

  /**
   * The quit: every crewmate is let go of, a running turn cut, and nothing
   * more starts. The returned promise waits, at most `QUIT_SETTLE_MS`, for
   * the cut turns to settle so their usage is kept, and for a ready sweep
   * already running and moves already in flight to end, so their writes
   * land before the database closes.
   */
  disposeAll(): Promise<void> {
    this.disposed = true;
    this.cards.dispose();
    // Each program runs again from its record at the next start.
    this.programs.dispose();
    for (const unregister of this.watchdog ?? []) unregister();
    this.watchdog = undefined;
    for (const task of this.tasks.values()) {
      // A Claude client's background tasks end with it here: each waits on
      // the crewmate's lane as its `[job]` turn, which the next start's
      // sweep delivers once (`sweepInbox`).
      if (!task.cancelled)
        for (const [id, run] of task.clientTasks)
          this.options.inbox.enqueue(task.id, this.clientTaskEnd(task, id, run, "quit"));
      task.clientTasks.clear();
      // A turn this quit cuts here with no lane row to deliver again - a
      // Claude client's own continuation - is carried on by the next
      // start's sweep; a turn's rows go again on their own (`resetInFlight`).
      if (
        !task.cancelled &&
        task.state === "streaming" &&
        task.inFlightInboxIds.length === 0 &&
        task.paused?.row === undefined &&
        this.machineOf(task.id) === LOCAL_MACHINE_ID
      )
        this.options.inbox.enqueue(task.id, { facts: { kind: "turn-resumed", stopped: "quit" } });
      this.releaseSession(task);
    }
    this.tasks.clear();
    // An update that saved the crew's work replaces this copy only once
    // every conversation is closed: no bound (docs/alpha.md, "Saving work
    // before an update").
    return this.updates.savedHere() ? this.settled() : this.settled(QUIT_SETTLE_MS);
  }

  /**
   * Resolves once every session let go of mid-turn is gone and every ready
   * sweep and computer move has ended, or `boundMs`, when given, has passed. A failed
   * operation is its caller's to hear, never the quit's.
   */
  private settled(boundMs?: number): Promise<void> {
    const pending = [...this.releasing, ...this.sweeping, ...this.moves.operations()];
    if (pending.length === 0) return Promise.resolve();
    if (boundMs === undefined) return Promise.allSettled(pending).then(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, boundMs);
    });
    return Promise.race([Promise.allSettled(pending).then(() => {}), bound]).finally(() =>
      clearTimeout(timer),
    );
  }
}

/**
 * Whether an edit since `before` named or cleared a queued row's model or
 * its basis: the asks of its shape that decide its tier and its model
 * (INF-83).
 */
function routingAskMoved(
  before: WorkShape | null | undefined,
  after: WorkShape | null | undefined,
): boolean {
  return before?.override_model_id !== after?.override_model_id || before?.basis !== after?.basis;
}

/**
 * The order one delivery of lane rows is, for a conversation on another
 * computer (src/shared/work.ts): its rows, and this delivery among their
 * attempts. Asked again after a drop it is the same order, which that
 * computer answers without acting again; a later delivery of the same rows,
 * after a turn there was lost, is a new one.
 */
function laneOrder(ids: readonly number[]): string | undefined {
  return ids.length > 0 ? `rows:${ids.join(",")}:${randomUUID().slice(0, 8)}` : undefined;
}

/** The lane rows an order names; none for one this Mac did not mint from rows. */
function laneRowsOf(order: string | undefined): number[] {
  if (!order?.startsWith("rows:")) return [];
  return (order.slice("rows:".length).split(":")[0] ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/** Why a task on a subscription this build no longer offers cannot be resumed. */
function retiredResumeText(taskId: string): string {
  return `Task ${taskId} ran on a subscription Infinitary no longer offers, so its session cannot be resumed. Spawn a follow-up crewmate instead.`;
}

/**
 * Whether a failed turn needs the captain's sign-in. A backend that reports
 * typed failures is read by its class alone - a failure without one is never
 * a sign-in, whatever its words say (a session that exits is a session
 * failure); a prose backend goes through the one prose classifier.
 */
function isSignInFailure(
  profile: ControlProfile | undefined,
  error: string,
  cutOff?: CutOff,
): boolean {
  if (cutOff) return cutOff.class === "signed_out";
  if (profile?.failureSignals === "typed") return false;
  return isAuthFailureMessage(error);
}

/**
 * The provider a sign-in card names: the session's own while it knows one
 * the app offers, else the one the task's record keeps (`provider/id`). A Pi
 * session whose custom connection has no runtime no longer knows its
 * provider (it reads "unknown").
 */
function signInProvider(
  session: string | undefined,
  recorded: string | null | undefined,
): string | undefined {
  const known = (provider: string | undefined) =>
    provider &&
    (isCustomApiProvider(provider) || PROVIDER_CATALOG.some((entry) => entry.id === provider))
      ? provider
      : undefined;
  return known(session) ?? known(recorded?.split("/")[0]);
}

/** The session events that are also feed events: everything but owner-only session facts. */
function isBroadcastEvent(event: SessionEvent): event is FmEvent {
  return (
    event.type !== "context_compacted" &&
    event.type !== "background_work_changed" &&
    event.type !== "turn_closed" &&
    event.type !== "request_started" &&
    event.type !== "continuation_started" &&
    event.type !== "continuation_ended" &&
    event.type !== "input_read" &&
    event.type !== "model_served" &&
    event.type !== "tool_observation"
  );
}

/** Name the crewmate and task on its turn_failed before it reaches the feed. */
function enrichEvent(task: TaskRuntime, event: FmEvent): FmEvent {
  if (event.type !== "turn_failed") return event;
  return { ...event, crewmate: task.crewmate, title: task.title };
}

/**
 * The answers a footer click carries (inline decisions, contract 4.22), read
 * off its value: undefined for a click that carries none, which is every
 * card without a form and every caller from before the form. A value that
 * names answers and does not parse, or weighs more than the value bound,
 * refuses the click rather than dropping the captain's picks unsaid.
 */
function chromeAnswers(value: unknown): CardAnswer[] | undefined {
  if (typeof value !== "object" || value === null || !("answers" in value)) return undefined;
  const parsed = cardChromeValueSchema.safeParse(value);
  if (!parsed.success) throw new Error("The card's answers could not be read.");
  if (cardAnswersBytes(parsed.data.answers) > CARD_ANSWERS_MAX_BYTES) {
    throw new Error(CARD_ANSWERS_BOUND_REFUSAL);
  }
  return parsed.data.answers.length > 0 ? parsed.data.answers : undefined;
}

/** The gesture's own id the shell minted at a click, when it sent a well-formed one. */
function interactionOf(submission: unknown): { interactionId?: string } {
  const id = (submission as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.length >= 8 && id.length <= 64 ? { interactionId: id } : {};
}
