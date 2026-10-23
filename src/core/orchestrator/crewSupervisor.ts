import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { type AttachmentRef, attachmentWords } from "@shared/attachments";
import { type CutOff, type CutOffClass, isAuthFailureMessage } from "@shared/authFailure";
import { cardPictureFiles } from "@shared/cardPictures";
import {
  CARD_ANSWERS_BOUND_REFUSAL,
  CARD_ANSWERS_MAX_BYTES,
  CARD_ANSWERS_TOO_LONG,
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardAnswer,
  type CardMessage,
  type CardMessageWho,
  type CardThread,
  type CardWidth,
  cardAnswerLines,
  cardAnswersBytes,
  cardAnswersSchema,
  cardChromeValueSchema,
  cardSubmissionSchema,
  cardTakesReplies,
  type DropTaskReview,
  HOST_DECLINE_OPS,
  type HostEffect,
  LIVE_ATTACHMENT_LABEL_MAX,
  type LiveAttachment,
  onStage,
  type PastCard,
  replyWithSettings,
  requestMergeEffectOf,
  requestWriteEffectOf,
  SETTLE_FACT_VALUE_CLASS,
  SETTLE_FACTS_OPEN,
  type SettleFact,
  type ShellEffect,
  scriptChooser,
  settleEffectOf,
  type TaskLifecycleOp,
  type TaskMoveFrom,
  TURN_IMAGES_MAX,
  type TurnImage,
} from "@shared/cards";
import {
  type CheckChangeInput,
  isRepairAssessment,
  REPAIR_ASSESSMENT_SOURCE,
} from "@shared/checkRepair";
import {
  checksFinishedAgo,
  checksRestWords,
  checksSpanOf,
  checksSpanWords,
} from "@shared/checksSpan";
import { isClientIssueReason } from "@shared/claudeClient";
import { type CrewSpeed, type SpeedSelection, speedNote } from "@shared/crewSpeed";
import type { CrewSendResult } from "@shared/crewTranscript";
import { isCustomApiProvider } from "@shared/customApi";
import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  deviceForgeGateReason,
  deviceForgeGateRef,
  deviceForgeSignInCardId,
  deviceForgeWaitLine,
  deviceSetupCardId,
  GITHUB_HOST,
  noSignInsStartRefusal,
  noSignInsWaitLine,
  updateStartRefusal,
  updateWaitLine,
} from "@shared/deviceSetup";
import type { ComputerReach } from "@shared/devices";
import {
  noNewWorkDayLine,
  noNewWorkStartRefusal,
  noNewWorkWaitLine,
} from "@shared/deviceUpdateNudge";
import type { CrewCounts, FmEvent } from "@shared/events";
import { factDotSvg } from "@shared/factDot";
import { reportSummary } from "@shared/feed";
import {
  type FolderNoticed,
  type FolderRefreshRefusal,
  folderRefreshWords,
} from "@shared/folderRefresh";
import { forgeOf, forgePlace } from "@shared/forge";
import { forgeSignInCardId } from "@shared/forges";
import {
  fixedHoldWords,
  type HoldOverride,
  holdNames,
  type OverridableHold,
  overrideCellWords,
  overridePasses,
  overrideSpan,
  overrideWords,
  softHoldWords,
} from "@shared/holds";
import type { ValidationForgeWrite } from "@shared/liveValidation";
import {
  acceptedValidation,
  keptValidationInputSchema,
  LIVE_VALIDATION_WORDS,
  validationAssignment,
  validationPair,
  validationRevision,
  validationStateRevision,
} from "@shared/liveValidation";
import type { MergeRelationship, MergeReview } from "@shared/mergeReview";
import { offeringKey, parseOfferingKey } from "@shared/modelSlots";
import {
  AUTOMATIC_COMPUTER,
  AUTOMATIC_WORD,
  placementCandidateLines,
  placementReason,
  UNCOMPARED_WAIT,
} from "@shared/placement";
import type { TypedFailure } from "@shared/plainProblem";
import { projectPagePathRefusal } from "@shared/projectPage";
import {
  CREWMATE_TAB_VIA,
  type InterruptEventData,
  type SteerEventData,
  TASK_CARD_VIA,
} from "@shared/provenance";
import {
  backendForProvider,
  catalogEntry,
  isRetiredProvider,
  PROVIDER_CATALOG,
} from "@shared/providers";
import { formatResetText } from "@shared/quota";
import {
  DROP_REVIEW_STALE,
  dropMissingRefusal,
  dropStartedRefusal,
  NO_LONGER_WANTED,
} from "@shared/recordDrop";
import {
  autonomyForRecord,
  deliveryFor,
  deliveryForRecord,
  type RepoDelivery,
  type RepoView,
  RUNS_ON_THIS_MAC,
  runsHereOnly,
} from "@shared/repos";
import {
  CI_ROUND_CAP,
  parseReviewReport,
  REVIEW_ROUND_CAP,
  type Rigor,
  reviewCapOwner,
  reviewCapReached,
} from "@shared/rigor";
import { RISK_DIMENSIONS, RISK_WORDS, type RiskAssessment } from "@shared/risk";
import {
  type Deliverable,
  type Escalation,
  type InPlaceFacts,
  type InPlacePull,
  isFolderRepair,
  isFolderWork,
  isPullRepair,
  levelDefaultReasoning,
  planSkippedText,
  type WorkShape,
  type WorkShapeAsk,
} from "@shared/routingPolicy";
import type { ServedWakeOrigin } from "@shared/servedFrame";
import {
  attachmentStanding,
  BROWSER_DOOR_LABEL,
  type SavedSignIn,
  SIGN_IN_MYSELF_LABEL,
  savedSignInLabel,
  TASK_BROWSER_REQUEST_MAX,
  type TaskBrowserCommandResult,
  type TaskBrowserFact,
  type TaskBrowserHandle,
  type TaskBrowserRequest,
  USE_SAVED_SIGN_IN_ACTION,
} from "@shared/taskBrowser";
import { type PlanItem, readPlanItems } from "@shared/taskPlan";
import {
  type EffectiveTaskPolicies,
  effectiveTaskPolicies,
  policyEditConsequences,
  RUNS_ON_SOURCE_WORDS,
  type TaskPolicyEdits,
  type TaskRunsOn,
  taskPolicyEditsSchema,
} from "@shared/taskPolicies";
import { queueMissingRefusal, queueStartedRefusal } from "@shared/taskQueue";
import type { TaskPlace } from "@shared/tasks";
import {
  CARE_WORDS,
  CHECK_WORDS,
  CHECKS_NOT_READ_WORDS,
  DEFAULT_WORKSPACE_WORD,
  MERGE_AFTER_FIXING_WORDS,
  MERGE_WHEN_CHECKS_PASS_WORDS,
  MERGE_WORDS,
  REVIEW_CAREFULLY_WORDS,
  REVIEW_WORDS,
  SKIP_RULES_MERGE_WORDS,
  sendWriteWords,
} from "@shared/vocabulary";
import type { AccountHold } from "@shared/workPosture";
import { NEVER_SENT_AGAIN, type WriteAsk } from "@shared/writeAsk";
import { ACTION_VALUE_MAX_BYTES } from "../../shared/plugins/bridge";
import { CUT_OFF_REFUSED, CUT_OFF_SIGNED_OUT } from "../accounts/credentialHealth";
import { AttachmentUnavailableError, attachmentPath, keepImages, loadImages } from "../attachments";
import { browserCommand } from "../browser/commandWords";
import type { BrowserReturned, CrewmateBrowser } from "../browser/taskBrowsers";
import type {
  DownloadArtifactInput,
  ForgePull,
  GithubReadInput,
  GithubWriteInput,
  ReadWorkflowInput,
} from "../forge";
import type { TaskIntegrations } from "../integrations";
import { jobExitWake } from "../jobs/jobManager";
import {
  knowledgeShortlist,
  renderBriefKnowledge,
  renderReferenceImport,
} from "../knowledge/context";
import { renderDirections } from "../knowledge/directions";
import { type KnowledgeService, PRIVATE_SCOPE } from "../knowledge/knowledgeService";
import { knowledgeBinding } from "../knowledge/knowledgeTools";
import { capWithOverflow, withPastedFiles } from "../overflow";
import {
  type AppPaths,
  crewmateCardBodiesDir,
  crewmateCardPicturesDir,
  crewmateEvidenceDir,
  crewmateSessionsDir,
  crewmateSourceCardsDir,
  crewmateTempDir,
} from "../paths";
import type {
  LiveTurnCommit,
  PanelCaptureResult,
  PanelPlaceResult,
} from "../personal/personalExtensions";
import { planStepAttached, teachStepAttached } from "../personal/sequencesSkill";
import type { MediaProbe, TypefaceProbe } from "../pi/cardImages";
import { lintCrewmateCard } from "../pi/cardLint";
import { resolveFirstmateCardId } from "../pi/cardTool";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import { type CrewStatusEntry, NOTHING_SPAWNED } from "../pi/crewTools";
import { renderPlaceText } from "../pi/panelTools";
import {
  verifyKeptValidationEvidence,
  verifyKeptValidationEvidenceSync,
} from "../pi/validationEvidence";
import type { AutomaticPlacement } from "../placed/automaticPlacement";
import type { PlacedCopy } from "../placed/placedCopies";
import { PreparationUnknown } from "../placed/placedCopies";
import type { CrewMachines } from "../placed/placedSessions";
import { askJson } from "../program/programAsk";
import { type ProgramEnd, type ProgramPartAsk, ProgramRunner } from "../program/programRunner";
import { programRefusal } from "../program/programScript";
import { CAREFUL_LIVE_VALIDATION } from "../prompts/liveValidation";
import { CLASSIFY_TIMEOUT_MS } from "../routing/decisionKindClassifier";
import {
  KIND_SOURCE,
  type KindClassifier,
  type KindInput,
  kindEstablished,
  resolveKind,
} from "../routing/kindClassifier";
import { escalationFloor, legacyShapeFromDifficulty, tierFor } from "../routing/policy";
import {
  type RoutePreview,
  type RouteResult,
  type Router,
  requiresReasoningWait,
} from "../routing/router";
import { isDowngrade } from "../routing/routingEngine";
import {
  type ClientBackgroundTask,
  type ControlProfile,
  LOCAL_MACHINE_ID,
  type ModelSession,
  type SessionBinding,
  type SessionEvent,
  type SessionFactories,
  type SessionSpec,
  type TaskShell,
} from "../session/session";
import {
  bindTools,
  CardRefusedError,
  type DeclaredAction,
  type DeclaredCardInput,
  type EmittedAction,
  type EmittedCardInput,
  type FollowupInput,
  labeledActions,
} from "../session/tools";
import type { CardResolution, CardStore, DuplicateResult } from "../storage/cardStore";
import {
  FIRSTMATE_RECIPIENT,
  INBOX_ATTEMPT_MAX,
  type InboxRow,
  type InboxStore,
  SUPERVISION_RECIPIENT,
} from "../storage/inboxStore";
import type { TaskLinkType } from "../storage/taskLinkStore";
import type {
  CardRefusal,
  MergeRepairAssessment,
  TaskGate,
  TaskRecord,
  TaskStartPolicy,
} from "../storage/taskStore";
import {
  recordValidation as checkValidationTransition,
  StaleValidationDecisionError,
} from "../tasks/liveValidation";
import { modelMoveWords } from "../tasks/recordActivity";
import { queryTasks, type TaskQueryInput, type TaskQueryRow } from "../tasks/taskQuery";
import { resultRefusal, resultSchemaRefusal } from "../tasks/taskResult";
import {
  type ReportDeclaration,
  type SettleRefusal,
  TaskGraphRefusal,
  TaskService,
} from "../tasks/taskService";
import { provisionTaskTemp } from "../tasks/taskTemp";
import { compareSemver } from "../update/semver";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { gitFailure } from "../workspace/git";
import { projectPageFile } from "../workspace/projectPage";
import type { RepoRegistry } from "../workspace/repoRegistry";
import {
  type DependencyInstall,
  type DispatchBase,
  keptRefFor,
  nearestFolderAbove,
  type TaskWorkspace,
  type WorkspaceService,
  type WorktreeAcquisition,
} from "../workspace/workspaceService";
import { revisionNotice } from "./cardChanges";
import {
  type CardInteractionEvidence,
  CardService,
  cardEmitter,
  FIRSTMATE_CARD_PREFIX,
  type FirstmatePauseCard,
  type ThreadActivity,
} from "./cardService";
import { escapeCardText } from "./cardText";
import { CheckWatcher, type WatchedReading } from "./checkWatch";
import { ciFactOf } from "./ciFact";
import {
  type CrewmateRestart,
  type CrewmateSpec,
  crewmateProcedureFor,
  crewmateRenewedNote,
  crewmateResumeToken,
  crewmateSessionSpec,
} from "./crewSession";
import type { WriteAskSent } from "./githubGateway";
import { premiumRetryPossible } from "./holds";
import {
  type AccountServeability,
  IdleLadder,
  JOB_BOUND_MS,
  type RunningJob,
  stallCardId,
} from "./idleLadder";
import {
  type BasisBriefFacts,
  type BriefPart,
  type BriefPictures,
  basisSectionParts,
  briefText,
  type CaptainCardFacts,
  deliverableFor,
  type EscalationBriefFacts,
  FOLDER_REPAIR_TITLE,
  type FolderBriefFacts,
  joinParts,
  type PersonalBriefFacts,
  PULL_REPAIR_TITLE,
  parseSpawnIntent,
  type ReviewBriefFacts,
  renderAnswerShapeSection,
  renderBranchFromLine,
  renderEscalationBrief,
  renderFolderRepairBrief,
  renderFollowupBrief,
  renderIntentBrief,
  renderPicturesSection,
  renderProgramPartSection,
  renderPullRepairBrief,
  renderRepairAssessmentBrief,
  renderResultShapeSection,
  renderReviewBrief,
  renderRigorSection,
  type SpawnIntent,
  withDeliveryLine,
  withoutOriginReadLine,
} from "./intentBrief";
import { type MainBranchReading, MainCheckWatcher } from "./mainCheckWake";
import {
  ASSESSMENT_BOUND_MS,
  approvableOffer,
  decideMergeRepair,
  isCaptainGuidance,
  mergeHold,
  parseRepairAssessment,
  standingAuthorization,
} from "./mergeAuthorization";
import { type NamedModel, namedModelOf, namedModelWords } from "./namedModel";
import type { MergeGuard, PrCiOverall, PrOutcome } from "./prCi";
import { implausibleReport } from "./reportPlausibility";
import { type IdleRule, type ReportSortRule, sortReport } from "./reportSort";
import { skipRulesStrip, writeAskStrip } from "./requestStrips";
import { reviewCoversHead } from "./reviewCarry";
import { type RunReading, RunWatcher } from "./runWatch";
import { describeStatus, isRoutineMergeCard, SettleService, type TaskClose } from "./settleService";
import { folderMissingText } from "./settleWords";
import { askedUnderCardLine, toldInCrewmateTabLine } from "./threadWords";
import type { Ticker } from "./ticker";
import {
  conversationRestartWake,
  laneText,
  laneTurnText,
  outageFailedWake,
  type ReviewVerdictFacts,
  renderWake,
  replyWordsSpan,
  rowAttachments,
  systemWaitWake,
  type TypedWake,
  type WakeBody,
  type WakeChoice,
  type WakeFacts,
  type WakeOpenReview,
  withAttachmentsDropped,
  withAttachmentsKept,
  withGuidanceMark,
} from "./wakes";
import { deriveWorkPosture } from "./workPosture";

/**
 * The crew supervisor: task lifecycle, event fan-out, and card production.
 * Work starts only through commission() - a deliberate Firstmate agent
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
 * The consent card's two answers (one plugin vehicle, Phase A, A2a): the
 * captain's click on "Add it" adds the staged plugin, and "Don't add" - or
 * his dismissal of the card - turns it down. The installer is the only
 * implementation; the supervisor only routes the click it already owns.
 */
export type PluginConsentHandler = {
  add: (pluginId: string) => void;
  decline: (pluginId: string) => void;
};

/**
 * The setup card's two answers (docs/fleet.md, "Asking the first mate to add a
 * project"): Add project sets the project up with the settings the
 * captain chose on the card, which its answers carry, and Not now - or his
 * dismissal of the card - adds nothing. `offer` is the card's own effect
 * argument, never words a body or an agent wrote.
 */
export type ProjectSetupHandler = {
  add: (offer: string | undefined, answers?: readonly CardAnswer[]) => void;
  decline: (offer: string | undefined) => void;
};

export type FirstmateHooks = {
  /**
   * Queue an [fm-op] operational message for the Firstmate agent: a typed
   * wake the drain renders (`wakes.ts`), never prose the host composed. The
   * origin is what the wake is (a crewmate report, or any other host
   * operation) - the consuming turn is classified by it, never by the text -
   * and the optional ref names the task the wake is about.
   */
  notifyOp: (wake: TypedWake, origin: ServedWakeOrigin, ref?: string) => number | null | void;
  /**
   * Why the Firstmate cannot answer a Start right now, from typed facts: its
   * seat is paused, or its lane is waiting out a provider outage. Absent, or
   * undefined, means it can. Without the hook a Start goes ahead as it is.
   */
  firstmateCannotAnswer?: () => string | undefined;
  /** An actual footer click, never a script-fired choice. */
  notifyCaptainChoice?: (wake: TypedWake, ref?: string) => void;
  /** Premium serveability at this moment; an absent reading is not exhausted. */
  premiumCanServe?: () => boolean;
  /** Retry the last failed Firstmate turn (the error card's action). */
  retryConverse: () => void;
  /**
   * A captain reply on the Firstmate's own card (cards-as-threads phase 2):
   * a captain turn about that card. Optional so supervisor tests without an
   * agent still record the thread message.
   */
  converseAboutCard?: (cardId: string, text: string, images?: TurnImage[]) => void;
  /** Apply the rung-2 ladder move: rebind Firstmate to another provider. */
  moveFlagship?: (providerId: string) => void;
  /** The refused card's "Try again": clear the account's refusal and drain once. */
  tryAgain?: (accountId: string) => void;
  /** The notice's "Ask again": the captain's message sent once more as a new turn. */
  askAgain?: (askId: string) => void;
  /** Watchdog pass over the Firstmate's own turn, on the shared tick (P4). */
  checkQuiet?: (now: number) => void;
  /** A durable-inbox delivery poke for the firstmate lane, on the shared tick. */
  pokeInbox?: () => void;
};

/**
 * How a steer actually reached the crewmate. A backend whose ControlProfile
 * says `followup-queue` cannot interrupt its own running turn, so guidance
 * sent mid-turn is parked and delivered as the crewmate's NEXT turn. The
 * caller is told which happened (captain's phase-8 decision): a queued steer
 * is surfaced honestly, never dropped and never reported as if it had
 * reached the work in flight. `recorded-retrying` is the durable-inbox
 * outcome for a delivery that failed right now: the message is recorded,
 * the ladder retries it, and it escalates loudly if it keeps failing.
 * `recorded-queued` (interaction P0, WI-4): the task's latest update is being
 * handled right now, so the message waits durably on the task's lane and is
 * delivered, in order, the moment that handling ends. `recorded-held`: a
 * cut-off stands on the task's account, so the message is kept on its lane,
 * not attempted, and goes out when the account serves again - which the
 * Firstmate hears (docs/inbox.md, "A lane on a withheld account").
 */
export type SteerDelivery =
  | "mid-turn"
  | "queued-next-turn"
  | "recorded-retrying"
  | "recorded-queued"
  | "recorded-held";

/** The account-selection surface the supervisor consumes (AccountSelector). */
export type AccountAttachment = {
  selectForSpawn(taskId: string, piProviderId: string): string | undefined;
  reselectForResume(
    taskId: string,
    accountId: string | null,
  ): { accountId?: string; changed: boolean };
  labelOf(accountId: string): string | undefined;
};

export type CrewSupervisorOptions = {
  automaticPlacement?: AutomaticPlacement;
  /**
   * Starts the process a program's script runs in (docs/programs.md).
   * Absent, a program is refused when it is filed.
   */
  programProcess?: import("../host").HostChildSpawner;
  /**
   * One JSON answer through the decision models' one-question session
   * (`DecisionModels.answerJson`), for a program's ask(). Absent, ask()
   * answers null.
   */
  answerJson?: (
    caller: { purpose: string; taskId?: string },
    instruction: string,
    text: string,
    signal: AbortSignal,
  ) => Promise<{ text: string } | { failed: string }>;
  /** The app build every card observation is stamped with (docs/card-evidence.md). */
  build?: string;
  /**
   * Each backend's session factory (the session contract): a crewmate is
   * the crewmate preset, opened by the factory of the backend its account
   * binds to.
   */
  sessions: SessionFactories;
  /**
   * The computers that run work for this home (src/core/placed/): a task
   * whose record names one (`deviceId`) opens its conversation there, with
   * that computer's factories and its folders, and waits while it is out of
   * reach or not yet caught up. Absent, every task runs on this Mac.
   */
  machines?: CrewMachines;
  /**
   * Whether a computer is connected on an older Firstmate and takes no new
   * work until it is updated (`Computers.takesNoWorkUntilUpdated`): a task
   * waiting for it says so, not that it is out of reach.
   */
  takesNoWorkUntilUpdated?: (deviceId: string) => boolean;
  /** The one reach value (`reachFrom`). Absent, out of reach. */
  reachOf?: (deviceId: string) => ComputerReach;
  /** A task began waiting for that computer's update: its Update card returns, even after Not now. */
  recallUpdateCard?: (deviceId: string) => void;
  /**
   * An account's binding, through the one binder: no account binds to the
   * base runtime, and an account that cannot serve throws, so the spawn
   * fails loudly rather than running somewhere else.
   */
  bind: (accountId: string | undefined, providerId?: string) => Promise<SessionBinding>;
  /** The home's opt-in, carried without its files to whichever Mac opens the session. */
  personalResourcesEnabled?: () => boolean;
  /**
   * The crewmate preset. Absent, `crewmateSessionSpec` over the app's paths;
   * the replay and the tests hand in one that also keeps each crewmate's
   * callbacks, so a recorded tool call plays straight into them.
   */
  sessionSpec?: (crewmate: CrewmateSpec, binding: SessionBinding) => SessionSpec;
  workspace: WorkspaceService;
  repos: RepoRegistry;
  /** The one task writer (task-system P0): every record change goes through it. */
  tasks: TaskService;
  cardStore: CardStore;
  /**
   * Knowledge (docs/knowledge.md): present in every build. Applicable
   * directions ride each served turn. A task with a project or references
   * grant gets the knowledge pair locally or on a compatible work computer.
   * Optional only for isolated callers that provide no Knowledge service.
   */
  knowledge?: KnowledgeService;
  /** The durable inbox: one lane per task, plus the firstmate lane. */
  inbox: InboxStore;
  /** Optional routing (D-7/D-18); absent defers to the runtime default. */
  router?: Router;
  /**
   * What establishes a spawn's KIND (intelligence-bucket routing S3).
   * Absent is the honest S2 behaviour: every shape stays `unclear` and R8
   * routes it high - the classifier can make routing cheaper, never
   * possible.
   */
  classifier?: KindClassifier;
  /** Optional account selection (broker phase 4); absent = base runtime. */
  accounts?: AccountAttachment;
  /**
   * A typed cut-off a crewmate's turn observed, recorded on its account
   * (`AccountVault.noteCutOff`): the fact every reader of serveability sees.
   */
  noteCutOff?: (accountId: string, cutOff: CutOff) => void;
  /**
   * Whether each account serves, and the cut-off standing on it (the
   * cut-off contract): a lane is held while a cut-off stands on its
   * account, and the Firstmate hears the cut-off once and its end once.
   * Absent = no account is ever held.
   */
  serveability?: AccountServeability;
  /** Records per-turn usage for burn tracking (D-18), per account. */
  recordUsage?: (input: {
    taskId: string;
    accountId?: string;
    model?: { provider: string; id: string };
    usage: NonNullable<Extract<FmEvent, { type: "turn_end" }>["usage"]>;
  }) => void;
  paths: AppPaths;
  /**
   * Whether a quota-reset gate's scope has headroom again (R1). Refs are a
   * quota provider id or `bucket:<intelligence>`; absent means such gates
   * never clear on their own.
   */
  quotaGateCleared?: (ref: string) => boolean;
  /**
   * Whether a quota-reset ref names a real scope. Absent means refs are
   * accepted unchecked (tests); wired in the composition root beside
   * quotaGateCleared so a typo'd scope fails loudly at spawn instead of
   * queueing a gate that can never clear (R1).
   */
  quotaGateRefValid?: (ref: string) => boolean;
  /** A task's running background jobs count as liveness (R2 + P4). */
  hasRunningJobs?: (taskId: string) => boolean;
  /**
   * A task's longest-running background job (the job registry's), for the
   * bound on jobs as proof of life (docs/report-sort.md). Absent means a
   * running job counts as moving however old it is (tests).
   */
  oldestRunningJob?: (
    taskId: string,
  ) => { jobId: string; command: string; startedAt: number } | undefined;
  /** Kills a task's background jobs when the task ends (R2). */
  killJobs?: (taskId: string) => void;
  /**
   * Put the change in where the project lives (the forge seam), injected
   * beside check_pr_ci; a merge under the captain's kept approval passes
   * its guard (FI3-304).
   */
  mergePullRequest?: (
    taskId: string,
    guard?: MergeGuard,
    boundary?: import("./prCi").MergeBoundary,
  ) => Promise<PrOutcome>;
  /**
   * Merge one stored review after the captain's click (FI3-1543). Owned
   * reviews use the ordinary merge; referenced ones do not close the task.
   */
  mergeReview?: (
    taskId: string,
    reviewId: string,
  ) => Promise<PrOutcome & { relationship?: MergeRelationship }>;
  /** Whether a stored review may be offered now. Absent in tests that publish unchecked. */
  reviewGate?: (taskId: string, reviewId: string) => Promise<string | undefined>;
  /**
   * The captain's click on a `request_write` card (FI3-1571 piece 4): send
   * the kept write once, through the gateway. Absent where nothing can be
   * sent; the click then sends nothing.
   */
  sendWriteAsk?: (taskId: string, askId: string) => Promise<WriteAskSent>;
  /** The pinned pull request by its number, for a kept approval's reconcile. */
  readPull?: (taskId: string, prNumber: number) => Promise<ForgePull | undefined>;
  /** Close the change where the project lives on discard, injected beside mergePullRequest. */
  closePullRequest?: (taskId: string) => Promise<PrOutcome>;
  /**
   * A live check_pr_ci reading, injected beside mergePullRequest: the gate a
   * crewmate's own completion card must clear before a merge decision
   * reaches the captain (contract v2.0's "no captain card" clause,
   * standing CI rule). Absent means the gate is not wired (tests, replay)
   * and a crewmate's completion card publishes unchecked, as before.
   */
  checkCi?: (taskId: string) => Promise<PrCiOverall>;
  /**
   * The crewmate's own pair where the project lives (git integration PR
   * 1.2): `open_change` offers the task's branch as a proposed change and
   * `check_change` reads its checks through the app's sign-in, recorded
   * like check_pr_ci. Absent means neither tool is offered.
   */
  prepareChange?: (
    taskId: string,
    input: import("@shared/changePresentation").StagedChangePresentation,
  ) => Promise<string>;
  openChange?: (
    taskId: string,
    input: import("@shared/changePresentation").OpenChangeInput,
  ) => Promise<string>;
  completionPresentation?: (
    taskId: string,
    revision: number,
  ) => Promise<
    Pick<DeclaredCardInput, "title" | "body" | "pictures" | "riskDeclaration" | "requiredActions">
  >;
  checkChange?: (taskId: string, input?: CheckChangeInput) => Promise<string>;
  readWorkflow?: (taskId: string, input: ReadWorkflowInput) => Promise<string>;
  downloadArtifact?: (taskId: string, input: DownloadArtifactInput) => Promise<string>;
  githubRead?: (taskId: string, input: GithubReadInput) => Promise<string>;
  githubWrite?: (taskId: string, input: GithubWriteInput) => Promise<string>;
  /**
   * The check watch's quiet read (`PrCiService.readWatched`, docs/forge.md
   * "The check watch"): the host reads a watched change's checks on the
   * shared tick, wakes the crewmate on the first failed check, and wakes it
   * again when they finish. Absent means
   * nothing is watched and a standing watch never holds the idle ladder.
   */
  readCheckWatch?: (taskId: string) => Promise<WatchedReading>;
  /**
   * The default branch's checks for projects with a standing baseline wait
   * (INF-833 Fix 4, `PrCiService.readDefaultBranchChecks`). Absent means a
   * main failure still resumes only when the named task closes.
   */
  readMainChecks?: (repoId: string) => Promise<MainBranchReading>;
  readRunWatch?: (taskId: string, runId: number) => Promise<RunReading>;
  /**
   * Extra work on the shared 60s tick. Credential-health is the fourth
   * rider (quiet watchdog, R1 gates, inbox ladder, then this): proactive
   * renew at expiresAt-lead, not a new timer.
   */
  onWatchdogTick?: (now: number) => void;
  /**
   * The host's one clock (the ticker's, `ticker.ts`): every time the
   * supervisor and its ladder stamp or compare. Absent reads `Date.now()`.
   */
  now?: () => number;
  /**
   * The record of every whose-turn sort (S7c, R4.4): one `sort` row in the
   * decision ledger per sorted report or idle rung (P6), with the rule that
   * sorted it and the wake's typed facts, so `flag_missed_escalation`, the
   * miss deriver, the supervision extractor and the replay scorer keep
   * reading one ledger. Absent = no record (tests).
   */
  recordSort?: (input: {
    taskId: string;
    /** The wake as it was served. */
    wake: string;
    /** Its typed facts; absent when the row records a line, not a typed wake. */
    facts?: WakeFacts;
    verdict: "routine" | "captain";
    summary: string;
    /** The rule that sorted it. */
    rule: ReportSortRule | IdleRule;
    wakeKind: ServedWakeOrigin;
    /** The wake itself, run inside the store's own transaction. */
    effect?: () => void;
  }) => void;
  /**
   * The personal workspace's live build loop (talk-to-personalize Step 4):
   * absent means a `personal-ui` spawn is refused as unavailable.
   */
  personal?: PersonalLiveDelegate;
  /** The host's decoder for crewmates' demo recordings (`HostCapabilities.mediaProbe`). */
  probeMedia?: MediaProbe;
  /** The host's loader for crewmates' project fonts (`HostCapabilities.typefaceProbe`). */
  probeTypeface?: TypefaceProbe;
  /**
   * The task channel (docs/axi-commands.md): a task granted its browser gets
   * `infinitary-browser-axi` in its shell. Absent, no crewmate has a browser.
   */
  taskCommands?: {
    grant: (
      taskId: string,
      tools: { browser?: CrewmateBrowser; integrations?: TaskIntegrations },
    ) => TaskShell;
  };
  /**
   * Integrations (docs/integrations.md): a crewmate on this Mac reaches them
   * through `infinitary-integrations-axi` on its task channel. Absent, it has none.
   */
  integrations?: { forTask: (taskId: string) => TaskIntegrations };
  /**
   * Each task's own browser (docs/task-browser.md), on this Mac or on the
   * computer its task runs on ("On another computer"): absent, its crewmate
   * has no browser. Its fact names the browser a card's browser button
   * opens ("From a card").
   */
  browsers?: {
    forTask: (taskId: string) => CrewmateBrowser;
    fact: (taskId: string) => TaskBrowserFact | undefined;
    /** The task's browser is in the captain's hands: the idle ladder reads it as his turn. */
    withCaptain: (taskId: string) => boolean;
    /** A crewmate's card asks the captain to take over (docs/task-browser.md, "Asking for help"). */
    requestHelp: (
      taskId: string,
      request: TaskBrowserRequest & { site: string },
    ) => Promise<{ ok: true; handle: TaskBrowserHandle } | { ok: false; text: string }>;
    /** The captain's click on a request card's open-browser action. */
    takeControl: (taskId: string, handle?: TaskBrowserHandle) => Promise<TaskBrowserCommandResult>;
    /**
     * The saved sign-in a request card on this site may offer
     * (docs/task-browser.md, "Saved sign-ins"); absent where none.
     */
    savedSignInFor?: (taskId: string, site: string) => SavedSignIn | undefined;
    /** The captain's click on a request card's saved sign-in. */
    grantSavedSignIn?: (
      taskId: string,
      handle: TaskBrowserHandle,
    ) => Promise<TaskBrowserCommandResult>;
  };
  broadcastEvent: (event: FmEvent) => void;
  broadcastCards: (cards: Card[]) => void;
  presentationChanged?: () => void;
  crewSpeed?: (model: { provider: string; id: string }) => import("@shared/crewSpeed").CrewSpeed;
  /** A model by the name Settings → Models gives it (`ModelSlots.nameOf`); its id when absent. */
  modelName?: (model: { provider: string; id: string }) => string;
  /** One card's thread, whole, after any message lands on it (phase 1). */
  broadcastThread?: (thread: CardThread) => void;
};

/**
 * What the supervisor needs from the personal extension host to run a task
 * on the personal workspace (Step 4): the workspace as a managed repo
 * (registered on first need), the surfaces that already exist (for the
 * brief), the stamp window (`beginLiveTask`/`endLiveTask`, so the running
 * dot follows the crewmate's saves), the commit at the end of each turn,
 * and the three checks the crewmate's tools call. Implemented by
 * `PersonalExtensions` plus the repo registry, wired in services.ts.
 */
export type PersonalLiveDelegate = {
  workspaceDir: string;
  repo: () => RepoView;
  surfaces: () => PersonalBriefFacts["surfaces"];
  beginLiveTask: (taskId: string) => void;
  endLiveTask: (taskId: string) => void;
  commitTurn: (taskId: string, message: string) => Promise<LiveTurnCommit>;
  lint: (input: { id?: string }) => Promise<string>;
  place: (input: { id?: string; taskId: string }) => Promise<PanelPlaceResult>;
  capture: (input: { id: string; taskId: string }) => Promise<PanelCaptureResult>;
};

/** Who issued a steer, how it arrived, and the decision behind it (R2 capture). */
type SteerSource = {
  actor: "firstmate" | "captain" | "supervisor";
  via: SteerEventData["via"];
  decision: string | null;
  cardId: string | null;
  /** The panel the captain moved it from, by its title (a panel's Continue). */
  panel?: string;
  /** Where the captain's own words sit in the message (`replyWordsSpan`). */
  words?: SteerEventData["words"];
  /** The Firstmate steered in a turn that carries the captain's own words. */
  captainWords?: boolean;
};

/** Who asked for an interrupt or cancel, from where, and under which decision. */
/**
 * A resolved escalation (S4): the attempt the captain rejected, the stamp
 * the tier table reads for R1b, and the facts the fresh crewmate's brief
 * is rendered from. Built once, before anything is created, so every
 * refusal happens before a row exists.
 */
type EscalationPlan = {
  previous: TaskRecord;
  stamp: Escalation;
  facts: EscalationBriefFacts;
};

/** What placement reads of a task, or of one about to exist (docs/helper.md, "Runs on"). */
type PlacementRecord = {
  branch?: string;
  sessionFile?: string | null;
  placement?: TaskRecord["placement"];
  repoId: string | null;
  parentId?: string | null;
  deviceId?: string | null;
  shape?: { kind?: string; runs_on_ask?: string; in_place?: object } | null;
};

export type InterruptSource = {
  actor: "firstmate" | "captain";
  via: InterruptEventData["via"];
  decision: string | null;
  /** The panel the captain moved it from, by its title (a panel's Drop task on started work). */
  panel?: string;
};

/**
 * A move of a started task to another provider (INF-849): who asked, the
 * model they named (update_task's override_model_id), or none for the app's
 * pick with the current provider left out; `from` is the provider the card
 * offered to move off, so a card left up after another move does nothing;
 * `offered` is the model the card named, which the move takes or refuses,
 * never another in its place.
 */
type MoveAsk = { by: "captain" | "firstmate"; model?: string; from?: string; offered?: string };

/** Where a moving task reopens: the routed model, its account and effort, and its provider's name. */
type MoveTarget = {
  model: { provider: string; id: string };
  accountId?: string;
  thinkingLevel: NonNullable<CrewmateSpec["thinkingLevel"]>;
  providerName: string;
};

type TaskRuntime = {
  id: string;
  title: string;
  /** The conversational handle (`<PROJECT_KEY>-<seq>`), for card chrome; falls back to `id`. */
  key: string;
  crewmate: string;
  workspace?: TaskWorkspace;
  session?: ModelSession;
  unsubscribe?: () => void;
  clientJobs?: number;
  /** When the client's background work last went from none to some: the job bound's clock. */
  clientJobsSince?: number;
  /**
   * The background tasks this Mac's Claude client runs for the crewmate, by
   * id, each with what the model said it is and when it was first seen: the
   * ones a client end, or the quit, cuts off (`follow`, `disposeAll`).
   */
  clientTasks: Map<string, { description: string; since: number }>;
  /** Text streamed in the current assistant turn. */
  currentTurnText: string;
  /** The last completed turn's text - the report shown on the task card. */
  lastCompleteText: string;
  /** The turn's FINAL message text so far, its closing words once its session closes it: its report candidate (WI-1). */
  turnReport?: string;
  /** What the turn in flight reported through the report tool (WI-1); wins over its text. */
  explicitReport?: string;
  /** The report tool's own one-line headline for `explicitReport`, when it gave one. */
  explicitSummary?: string;
  /** What `explicitReport` declared about whose turn follows it (FI3-435). */
  explicitDeclared?: ReportDeclaration;
  /** Streaming while a prompt runs; idle between turns, still steerable. */
  state: "starting" | "streaming" | "idle";
  /** This boundary was opened by the provider rather than runTurn(). */
  autonomousTurn?: boolean;
  /** The vault account serving this crewmate; absent = base runtime. */
  accountId?: string;
  cancelled: boolean;
  /**
   * A settle stopped this runtime to close the task with its own reason
   * (`closeTask`): the captain's choice on an answer, a discard. That close
   * owns the record and what is queued about it, so the end of the turn it
   * stopped is not a cancel (INF-721).
   */
  settling?: boolean;
  /** Set by interrupt mode "interrupt": the abort keeps the task steerable. */
  interruptRequested: boolean;
  /**
   * The follow-ups this turn filed (cards/tasks/agents P0, WI-4): a filing
   * is a row, a link and a feed line, never a wake of its own; the report
   * wake that ends the turn names them, and the list clears with it.
   */
  filedThisTurn: { key: string; title: string; blocks: boolean }[];
  /** Watchdog signals (P4): any session event counts as activity. */
  lastEventAt: number;
  turnStartedAt: number;
  /** 0 = active, 1 = quiet feed line sent, 2 = quiet card raised. */
  quietLevel: 0 | 1 | 2;
  /** The 2h wall-clock escalation fired for this turn. */
  wallClockEscalated: boolean;
  /**
   * Durable-inbox rows delivered into the current turn (the brief, steers,
   * job results). Acknowledged when the turn ends clean; released for a
   * grace-spaced retry when it fails. Guidance for a backend that cannot
   * take it mid-turn simply stays pending on the task's lane until the turn
   * ends - the lane IS the followup queue, and it survives a quit.
   */
  inFlightInboxIds: number[];
  /**
   * The rows each live steer carried into the current turn, oldest first
   * (a sweep's steer can carry several). A steer the session accepted but no
   * turn took in comes back from `takeUndeliveredSteers` at the turn's end,
   * newest first to be left over, and its rows go back on the lane.
   */
  steeredInboxIds: number[][];
  /**
   * The provider error the current turn ended with (turn_failed), consumed
   * by turnComplete: Pi resolves such turns instead of rejecting, so
   * without this the failure would report as an empty "(no report)".
   */
  lastTurnError?: string;
  /** The typed cut-off behind `lastTurnError`, when the backend reported one. */
  lastTurnCutOff?: CutOff;
  /** A move asked for mid-turn, run once the turn ends (INF-849). */
  pendingMove?: MoveAsk;
};

/**
 * The quiet-crewmate watchdog (P4): conservative thresholds, no settings
 * surface. Ten silent minutes on a streaming turn earns one feed line,
 * twenty a wake to the Firstmate; the generous wall-clock bound escalates a
 * turn that never ends. Escalation only - the watchdog never interrupts by
 * itself (firstmate's rule: the bound demands inspection, never an
 * automatic kill). Exported for the Firstmate agent's own-turn watchdog,
 * which mirrors them.
 */
export const QUIET_FEED_MS = 10 * 60 * 1000;
export const QUIET_CARD_MS = 20 * 60 * 1000;
/** A turn's wall-clock bound; a background job counts as moving for the same (idleLadder.ts). */
const TURN_WALL_CLOCK_MS = JOB_BOUND_MS;
const WATCHDOG_TICK_MS = 60 * 1000;
/**
 * How long a quit waits for the crewmates it cut mid-turn to settle, so each
 * interrupted turn's usage reaches the ledger. An answered interrupt takes
 * well under a second; a client that does not answer loses its turn's usage
 * rather than holding the quit.
 */
export const QUIT_SETTLE_MS = 2_000;

/**
 * The four tiers. Since the work-shape policy (S2) the Firstmate judges
 * none of them: the host computes the tier from the shape, and `premium`
 * is reached only because the captain asked for it by name - which is what
 * makes it the one whose downgrade is worth a captain card rather than a
 * feed line.
 */
export type Difficulty = "low" | "medium" | "high" | "premium";

/** The waiting phrased for the feed, at queue time. */
function gateText(gate: TaskGate): string {
  switch (gate.kind) {
    case "quota-reset":
      return gate.ref?.startsWith("bucket:")
        ? `starts when a ${gate.ref.slice(7)} model has allowance again`
        : `starts when ${gate.ref}'s allowance resets`;
    case "at-time":
      return gate.until !== undefined
        ? `starts at ${new Date(gate.until).toLocaleString()}`
        : "starts later";
    case "captain":
      return gate.reason ?? "waiting on you";
  }
}

type FollowupState = "hold" | "after" | "working" | "queued" | "backlog";
/**
 * Row order on a settle card, and each state's word and hover sentence. The
 * last three are the Tasks panel's own group words (src/shared/nowPanel.ts).
 */
const FOLLOWUP_STATES: FollowupState[] = ["hold", "after", "working", "queued", "backlog"];
const FOLLOWUP_WORDS: Record<FollowupState, { word: string; sentence: string }> = {
  hold: {
    word: "must merge first",
    sentence:
      "This merge waits on it. Merge is refused until it merges, or until the wait is removed.",
  },
  after: {
    word: "starts once this merges",
    sentence: "It waits for this to merge, then starts. It does not hold this merge up.",
  },
  working: {
    word: "working",
    sentence: "A crewmate is working on it. It does not hold this merge up.",
  },
  queued: {
    word: "queued",
    sentence: "It starts by itself when nothing holds it. It does not hold this merge up.",
  },
  backlog: {
    word: "backlog",
    sentence: "It waits for your word to start. It does not hold this merge up.",
  },
};

/** One 10px state dot, the one drawing every fact strip shares (`@shared/factDot`). */
const statusDot = factDotSvg;

/** A link phrased for tool text: who waits on whom, in keys. */
function linkPhrase(from: TaskRecord, to: TaskRecord, type: TaskLinkType): string {
  const a = from.key || from.id;
  const b = to.key || to.id;
  switch (type) {
    case "blocks":
      return `${a} blocks ${b} (${b} waits until ${a} closes)`;
    case "related":
      return `${a} is related to ${b}`;
    case "discovered-from":
      return `${a} was discovered from ${b}`;
    case "replaced-by":
      return `${a} is replaced by ${b} (${b} does its work)`;
  }
}

/** A blocks edge phrased for the feed (the old after-task wait). */
function blockedText(blockers: TaskRecord[]): string {
  const names = blockers.map((blocker) => blocker.key).join(" and ");
  return `starts when ${names} ${blockers.length === 1 ? "finishes" : "finish"}`;
}

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

/** The timeline line for a commission's dependency install (WI-7). */
function installText(install: Exclude<DependencyInstall, { outcome: "skipped" }>): string {
  const seconds = `${Math.max(1, Math.round(install.ms / 1000))}s`;
  switch (install.outcome) {
    case "offline":
      return `the project's dependencies are installed (${seconds})`;
    case "online":
      return `dependencies installed; the shared pnpm store was missing packages, so they were fetched (${seconds})`;
    case "failed":
      return `could not install the project's dependencies - ${install.error}; the crewmate can do it itself`;
  }
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
const OWN_LANE_KINDS: ReadonlySet<string> = new Set(["job-exit", "conversation-restart"]);

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
/**
 * The tool's answer when a completion card's revision went up while its
 * checks run (INF-834 friction 4): the words are the captain's to read now,
 * and the merge waits for the checks on its own.
 */
export const COMPLETION_REVISED_WHILE_RUNNING =
  "Your revision is up while the checks still run: its merge waits for them to pass, so do not emit it again for that. If they fail, fix them as usual.";

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

/** How long a project's next task waits for its computer before the feed says so again. */
export const PLACED_WAIT_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The feed's one line when a computer's only sign-in is cut off
 * (docs/helper.md, "Runs on"). A spent allowance is named as that
 * allowance, never as a sign-in.
 */
/**
 * What a project's next task waits for on its computer, beyond the computer
 * itself being in reach: its own sign-in a cut-off withholds, any sign-in
 * at all, or its own sign-in for the host its project lives on.
 */
export type PlacedWaitFor =
  | { kind: "cut-off"; provider: string; class: CutOffClass; resetsAt?: number }
  | { kind: "no-sign-ins" }
  | { kind: "update" }
  | { kind: "forge"; host: string };

export function placedCutOffWaitLine(
  subject: string,
  who: string,
  signIn: { provider: string; class: CutOffClass; resetsAt?: number },
  now: number,
): string {
  if (signIn.class !== "no_headroom")
    return `${subject} waits for ${who}'s own ${signIn.provider} sign-in.`;
  const reset = signIn.resetsAt !== undefined ? formatResetText(signIn.resetsAt, now) : undefined;
  return reset
    ? `${subject} waits for ${who}'s ${signIn.provider} plan's allowance, which ${reset}.`
    : `${subject} waits for ${who}'s ${signIn.provider} plan's allowance to reset.`;
}

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

/** Start now's refusal for the same wait. */
function placedCutOffStartRefusal(
  handle: string,
  who: string,
  signIn: { provider: string; class: CutOffClass; resetsAt?: number },
  now: number,
): string {
  if (signIn.class === "no_headroom") {
    const reset = signIn.resetsAt !== undefined ? formatResetText(signIn.resetsAt, now) : undefined;
    const when = reset ? `, which ${reset}` : "";
    return `${handle} waits for ${who}'s ${signIn.provider} plan's allowance${when}. It starts by itself once it resets, and never runs on ${HERE.this} instead.`;
  }
  return `${handle} waits for ${who}'s own ${signIn.provider} sign-in, which no longer serves there. It starts by itself once it serves again, and never runs on ${HERE.this} instead.`;
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
   * A project's next task waiting for the computer it runs on, by project and
   * computer (docs/helper.md, "Runs on"): what it waits for - that computer
   * in reach, or its own sign-in a cut-off withholds - when the wait began
   * and whether the day's line was said, so each line is said once per
   * wait. Kept in memory: after a restart here a wait still standing is
   * said once more.
   */
  private readonly placedWaits = new Map<
    string,
    {
      since: number;
      dayTold: boolean;
      on: "reach" | "no-new-work" | "sign-in" | "allowance" | "no-sign-ins" | "update" | "forge";
    }
  >();
  /**
   * A project's next task waiting for its computer's own GitHub sign-in,
   * said once per project and computer until that computer signs in.
   */
  private readonly deviceForgeSaid = new Set<string>();
  /** Folder repairs whose folder is being read now, so one tick reads each once. */
  private readonly closingFolders = new Set<string>();
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
  /** Tasks moving to another provider now (INF-849). */
  private readonly moving = new Set<string>();
  /** The card stack: the open cards and every write to them. */
  private readonly cards: CardService;
  /** Settling and closing: land, merge-pr, discard, and every close's teardown. */
  private readonly settle: SettleService;
  private crewmateSeq = 0;
  /** The watchdog's registrations on the shared ticker, undone at dispose. */
  private watchdog: (() => void)[] | undefined;
  /** Sessions let go of mid-turn, each until it is gone (`releaseSession`). */
  private readonly releasing = new Set<Promise<void>>();
  /** The app is quitting: a turn that settles now is not the crew's to act on. */
  private disposed = false;
  private readonly now: () => number;
  /** Serializes inbox sweeps: a resume-heavy pass must not overlap itself. */
  private sweepingInbox = false;
  private hooks: FirstmateHooks = { notifyOp: () => {}, retryConverse: () => {} };
  /** The idle ladder and the holds: the witnesses, the gate, the caps and the ready sweep. */
  private readonly ladder: IdleLadder;
  /** The host's watch on crewmates' checks; absent when no read is wired. */
  private readonly checkWatch: CheckWatcher | undefined;
  /** Wakes baseline waits when the default branch's own run of that check passes. */
  private readonly mainCheckWake: MainCheckWatcher | undefined;
  private readonly runWatch: RunWatcher | undefined;
  private recoveredPendingSettles = false;
  /** Every running program (INF-799 piece 2, docs/programs.md). */
  private readonly programs: ProgramRunner;
  /** The bound each program last told the first mate it reached, so it hears it once per bound. */
  private readonly programBoundTold = new Map<string, number>();

  constructor(private readonly options: CrewSupervisorOptions) {
    const now = options.now;
    this.now = now ? () => now() : () => Date.now();
    // A project moved: its tasks that have not started follow it (docs/helper.md, "Runs on").
    options.repos.onRunsOn?.((repo) => this.projectMoved(repo));
    this.cards = new CardService({
      now: this.now,
      tasks: options.tasks,
      cardStore: options.cardStore,
      syncCaptainGate: (taskId, at) => this.ladder.syncCaptainGate(taskId, at),
      noteCapAnswered: (card, action, by, firstmateCard) =>
        this.ladder.noteCapAnswered(card, action, by, firstmateCard),
      closeAnsweredTask: (card, action, by) => this.settle.closeAnsweredTask(card, action, by),
      settleFacts: (taskId) => this.settleFacts(taskId),
      mergeLabel: (card) => this.mergeLabel(card),
      followupNotice: (taskId) => this.followupNotice(taskId),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
      broadcastEvent: options.broadcastEvent,
      broadcastCards: options.broadcastCards,
      presentationChanged: options.presentationChanged,
      ...(options.broadcastThread ? { broadcastThread: options.broadcastThread } : {}),
      ...(options.build ? { build: options.build } : {}),
    });
    this.settle = new SettleService({
      now: this.now,
      tasks: options.tasks,
      inbox: options.inbox,
      workspace: options.workspace,
      repos: options.repos,
      cards: this.cards,
      verifyValidationEvidence: (taskId) => this.verifyValidationEvidence(taskId),
      runtimeState: (taskId) => this.tasks.get(taskId)?.state,
      stopRuntime: (taskId) => this.stopRuntime(taskId),
      announceReach: (taskId) => this.announceReach(taskId),
      ...(options.killJobs ? { killJobs: options.killJobs } : {}),
      ...(options.machines ? { placed: options.machines } : {}),
      endLiveTask: (taskId) => options.personal?.endLiveTask(taskId),
      ...(options.mergePullRequest ? { mergePullRequest: options.mergePullRequest } : {}),
      ...(options.mergeReview ? { mergeReview: options.mergeReview } : {}),
      ...(options.closePullRequest ? { closePullRequest: options.closePullRequest } : {}),
      ...(options.readPull ? { readPull: options.readPull } : {}),
      assessRepair: (taskId) => this.assessRepair(taskId),
      fileFolderRepair: (merged, refusal) => this.fileFolderRepair(merged, refusal),
      folderMissing: (repoId, noticed, by) => this.folderMissing(repoId, noticed, by),
      filePullRepair: (abandoned, problem) => this.filePullRepair(abandoned, problem),
      isPersonalTask: (taskId) => this.isPersonalTask(taskId),
      deliverableOf: (record) => this.deliverableOf(record),
      taskDelivery: (taskId) => this.taskDelivery(taskId),
      taskAutonomy: (taskId) => this.taskAutonomy(taskId),
      resolveTaskRef: (ref, param) => this.resolveTaskRef(ref, param),
      notifyOp: (wake, origin, ref) => this.hooks.notifyOp(wake, origin, ref),
      pokeInbox: () => this.hooks.pokeInbox?.(),
      sweepGates: (at) => this.sweepGates(at),
      broadcastCrewCounts: () => this.broadcastCrewCounts(),
      broadcastEvent: options.broadcastEvent,
    });
    this.programs = new ProgramRunner({
      tasks: options.tasks,
      spawner: options.programProcess,
      filePart: (program, part) => this.fileProgramPart(program, part),
      closePart: (partId) => this.closeProgramPart(partId),
      ask: (program, prompt, schema) => this.programAsk(program, prompt, schema),
      finish: (program, end) => this.finishProgram(program, end),
      bounded: (program, calls) => this.programBounded(program, calls),
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
      threadAwaitingAuthor: (taskId) => this.cards.threadAwaitingAuthor(taskId),
      bypassesSupervision: (taskId) => this.bypassesSupervision(taskId),
      notifyOp: (wake, origin, taskId) => this.hooks.notifyOp(wake, origin, taskId),
      premiumCanServe: () => this.premiumCanServe(),
      recordSort: (taskId, title, wake, verdict, reason, rule, effect) =>
        this.recordSort(taskId, title, wake, verdict, reason, rule, effect),
      steer: (taskId, message) =>
        this.steerInternal(taskId, message, {
          actor: "supervisor",
          via: "supervision",
          decision: null,
          cardId: null,
        }),
      raiseCard: (card) => this.cards.put(card),
      withdrawCard: (id, resolution) => this.cards.takeDown(id, resolution),
      dispatchQueuedTask: (taskId) => this.dispatchQueuedTask(taskId),
      ...(serveability ? { serveability } : {}),
      placedAccount: (deviceId, taskId) => options.machines?.accountOf(deviceId, taskId),
      outOfReach: (taskId) => this.outOfReach(taskId),
      deliverLane: (taskId) => this.deliverLane(taskId),
      accountBack: (taskId) => this.cards.clearAuthDecisionCard(crewSignInCardId(taskId)),
      ...(options.quotaGateCleared ? { quotaGateCleared: options.quotaGateCleared } : {}),
      heldOnItsLevel: (record) => this.heldOnItsLevel(record),
      wakeDeadGate: (record, dead) => this.wakeDeadGate(record, dead),
      completeContainers: () => this.completeContainers(),
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
    const readRunWatch = options.readRunWatch;
    this.runWatch = readRunWatch
      ? new RunWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readRunWatch,
          steer: (taskId, wake) =>
            this.steerInternal(taskId, wake, {
              actor: "supervisor",
              via: "supervision",
              decision: null,
              cardId: null,
            }),
        })
      : undefined;
    const readCheckWatch = options.readCheckWatch;
    this.checkWatch = readCheckWatch
      ? new CheckWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readCheckWatch,
          // The posture the Tasks dot shows as "Blocked by another task".
          idleBehindOtherWork: (record) => {
            const posture = this.workPosture(record);
            return posture.state === "idle" && posture.reason === "dependency";
          },
          steer: (taskId, wake) =>
            this.steerInternal(taskId, wake, {
              actor: "supervisor",
              via: "supervision",
              decision: null,
              cardId: null,
            }),
        })
      : undefined;
    const readMainChecks = options.readMainChecks;
    this.mainCheckWake = readMainChecks
      ? new MainCheckWatcher({
          tasks: options.tasks,
          inbox: options.inbox,
          read: readMainChecks,
          steer: async (taskId, wake) => {
            this.options.tasks.endIdle(taskId);
            await this.steerInternal(taskId, wake, {
              actor: "supervisor",
              via: "supervision",
              decision: null,
              cardId: null,
            });
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
      this.settle.resumePendingSettles();
      this.settle.resumeMergeAuthorizations();
    });
  }

  /** A task lane's due rows. */
  private deliverableRows(taskId: string, now: number): InboxRow[] {
    const rows = this.options.inbox.pending(taskId, now, { maxAttempts: INBOX_ATTEMPT_MAX });
    // A renewed conversation's reason rides the next full turn (`runTurn`),
    // never a turn of its own and never a mid-turn steer.
    const rest = rows.filter((row) => row.facts?.kind !== "conversation-restart");
    // A policy notice alone is guidance, not permission to resume or start.
    if (
      this.tasks.get(taskId)?.state !== "streaming" &&
      rest.every((row) => row.facts?.kind === "task-policies-changed")
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
  private laneHeld(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    const accountId = this.tasks.get(taskId)?.accountId ?? record?.accountId;
    return (
      this.ladder.cutOffHolds({
        id: taskId,
        accountId: accountId ?? null,
        deviceId: record?.deviceId ?? null,
      }) || this.outOfReach(taskId)
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

  /**
   * The review target and evidence are read where the builder actually runs.
   * The target is that computer's committed branch head, even when an older
   * pull request already records a different head (INF-288).
   */
  private async reviewFacts(builder: TaskRecord): Promise<ReviewBriefFacts> {
    const prUrl = builder.delivery?.prUrl;
    const machines = this.options.machines;
    const device = builder.deviceId;
    let headSha: string | null;
    let changedFiles: string[] | null;
    let changeReading: string | undefined;
    let evidenceDir: string;
    if (device) {
      const folders = machines?.folders(device, builder.id);
      if (!machines?.ready(device, builder.id) || !folders)
        throw new Error(
          "The builder's computer is out of reach; the review must wait for it, not run here instead.",
        );
      ({ headSha, changedFiles, changeReading } = await machines.revision(device, builder.id));
      evidenceDir = folders.evidence;
    } else {
      headSha = builder.branch
        ? await this.options.workspace.branchHead(builder.repoDir, builder.branch)
        : null;
      changedFiles = headSha
        ? await this.options.workspace.reviewChangedFiles(builder.repoDir, headSha)
        : null;
      changeReading = headSha
        ? ((await this.options.workspace.reviewChangeReading(builder.repoDir, headSha)) ??
          undefined)
        : undefined;
      evidenceDir = crewmateEvidenceDir(this.options.paths, builder.id);
    }
    if (!headSha)
      throw new Error(
        `${builder.key || builder.id} has no commits on its branch to review yet. Steer the crewmate to commit its work and report first.`,
      );
    const captainCard = this.captainCardFacts(builder);
    const proof = builder.delivery?.liveValidation?.runs.at(-1);
    if (proof)
      await verifyKeptValidationEvidence(
        proof.evidence,
        crewmateCardPicturesDir(this.options.paths, builder.id),
        builder.id,
      );
    const keptFile = async (name: string): Promise<string> => {
      const file = join(crewmateCardPicturesDir(this.options.paths, builder.id), name);
      if (!device) return file;
      if (!machines?.sourceFile)
        throw new Error("The kept proof cannot be copied to the reviewer's computer.");
      return machines.sourceFile(device, builder.id, `proof-${name}`, file);
    };
    const proofFiles = await Promise.all(
      (proof?.evidence ?? []).map(async (item) => ({
        id: item.id,
        file: await keptFile(item.file),
        ...(item.posterFile ? { poster: await keptFile(item.posterFile) } : {}),
      })),
    );
    const validation = builder.delivery?.liveValidation;
    return {
      builderTitle: builder.title,
      branch: builder.branch,
      headSha,
      ...(prUrl ? { prUrl } : {}),
      builderReport: builder.outcome ?? "",
      evidenceDir,
      changedFiles,
      ...(changeReading ? { changeReading } : {}),
      ...(captainCard ? { captainCard } : {}),
      proofFiles,
      validation: validation
        ? {
            ...validation,
            runs: proof
              ? [{ ...proof, evidence: proof.evidence.map(({ text: _text, ...item }) => item) }]
              : [],
          }
        : undefined,
    };
  }

  /**
   * The merge card the captain pressed Review carefully on (INF-562), as
   * the stage showed it: the newest card on the builder whose chosen action
   * set care. Saved whole beside the builder's other source cards when the
   * work runs here; quoted in the brief when it runs on another computer.
   */
  private captainCardFacts(builder: TaskRecord): CaptainCardFacts | undefined {
    const [raised] = this.options.cardStore.resolvedSince(
      0,
      1,
      ({ card, offer, action }) =>
        (offer?.actions ?? card.actions).some((entry) => entry.id === action && entry.care),
      builder.id,
    );
    if (!raised) return undefined;
    const shown = raised.offer ?? raised.card;
    const declared = shown.risk?.declared;
    const risk = declared
      ? RISK_DIMENSIONS.map(
          (dimension) =>
            `- ${RISK_WORDS[dimension].label}: ${declared[dimension].level} - ${declared[dimension].why}`,
        )
      : undefined;
    const files = cardPictureFiles(shown.body, this.options.paths.crewmatesDir);
    const facts: CaptainCardFacts = {
      title: shown.title,
      ...(files.pictures.length && !builder.deviceId ? { pictures: files.pictures } : {}),
      ...(risk ? { risk } : {}),
    };
    if (!builder.deviceId) {
      const dir = crewmateSourceCardsDir(this.options.paths, builder.id);
      const file = join(dir, `merge-card-${raised.card.id.replace(/[^A-Za-z0-9_-]/g, "-")}.html`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, files.body, "utf8");
        return { ...facts, file };
      } catch {
        // A card that cannot be saved rides in the brief whole.
      }
    }
    return { ...facts, body: files.body };
  }

  /**
   * The routing decision for a task where it runs: among this Mac's
   * subscriptions, or for a task on a computer that runs work, among the
   * ones that computer is signed in to, with its own reading of the
   * allowance (docs/helper.md, "Its own sign-ins"). Never this Mac's for a
   * task there.
   */
  private async routeTask(
    taskId: string,
    prompt: string,
    shape: WorkShape,
    machine: string | null,
    avoidProvider?: string,
  ): Promise<RouteResult | undefined> {
    const router = this.options.router;
    if (!router) return undefined;
    const preference = avoidProvider ? { avoidProvider } : {};
    if (!machine)
      return avoidProvider
        ? router.decide(taskId, prompt, shape, preference)
        : router.decide(taskId, prompt, shape);
    const machines = this.options.machines;
    if (!machines) return undefined;
    return router.decide(taskId, prompt, shape, {
      ...preference,
      pool: await machines.served(machine),
    });
  }

  /**
   * A placed task's binding (docs/helper.md, "Its own sign-ins"): its
   * model's own backend, naming that computer's own account that serves the
   * model, else one for the provider, which it binds there. This Mac's
   * accounts never serve it, so the runtime is this Mac's account-less one,
   * which only presents the session's control plane. With no model routed,
   * it binds as a task with none does.
   */
  private async placedBinding(
    machine: string,
    provider: string | undefined,
    selectedAccount?: string,
    model?: { provider: string; id: string },
  ): Promise<SessionBinding> {
    if (!provider) return this.options.bind(undefined, undefined);
    const pool = selectedAccount ? undefined : await this.options.machines?.served(machine);
    const there =
      selectedAccount ??
      (model?.provider === provider ? pool?.modelAccounts?.get(offeringKey(model)) : undefined) ??
      pool?.accounts.get(provider);
    if (isCustomApiProvider(provider) && !there)
      throw new Error(
        "This task’s custom connection is not available on the computer it runs on. It cannot use another server automatically.",
      );
    if (backendForProvider(provider) === "claude")
      return { backend: "claude", accountId: there ?? "claude" };
    // Only the control-plane runtime is needed here. The provider's checked
    // connection belongs to that computer, and is resolved by bindHere there.
    const binding = await this.options.bind(undefined, undefined);
    return binding.backend === "pi" && there ? { ...binding, accountId: there } : binding;
  }

  /** Where a task's crewmate runs: the computer that runs work its record names, or this Mac. */
  private machineOf(taskId: string): string {
    return this.options.tasks.get(taskId)?.deviceId ?? LOCAL_MACHINE_ID;
  }

  /**
   * Where a task runs (docs/helper.md, "Runs on"): the computer its record
   * names - where it started, or where it waits to start, which follows its
   * Runs on while it has not started (`repoint`) - else where it would
   * start now (`runsOnFor`). Null is this Mac.
   */
  private placementOf(record: PlacementRecord): string | null {
    if (record.placement) return record.placement.snapshot.computerId;
    if (record.deviceId) return record.deviceId;
    const target = this.runsOnFor(record);
    return target === AUTOMATIC_COMPUTER ? null : target;
  }

  /**
   * Where a start that has not claimed its task goes (INF-409): Automatic,
   * which compares the computers - a computer it chose, or the home it
   * settled on, is still Automatic's - else the computer `placementOf`
   * names, null for this Mac.
   */
  private startPlace(record: PlacementRecord): string | null {
    return this.automaticFor(record) ? AUTOMATIC_COMPUTER : this.placementOf(record);
  }

  automaticFor(record: PlacementRecord): boolean {
    return Boolean(
      this.options.automaticPlacement &&
        !record.branch &&
        !record.sessionFile &&
        (record.placement ||
          (this.options.router?.dynamicEnabled() &&
            !this.runsOnlyHere(record) &&
            this.runsOnFor(record) === AUTOMATIC_COMPUTER)),
    );
  }

  /**
   * Keeps the latest words for Details and Start now, and says why a task
   * waits once, then again only when the kind of wait changes: each new
   * reading can change the words, and every line is a row in Activity.
   */
  private sayAutomaticWait(record: TaskRecord, wait = UNCOMPARED_WAIT): void {
    // The record, not this process: a restart still knows what was said.
    const said = this.options.tasks.get(record.id)?.shape?.placement_wait;
    this.options.tasks.setPlacementWait(record.id, wait);
    if (said?.kind === wait.kind) return;
    this.options.broadcastEvent({
      type: "firstmate_note",
      taskId: record.id,
      text: record.placement
        ? `"${record.title}" waits for its chosen computer to confirm preparation. It will not start elsewhere.`
        : `"${record.title}": ${wait.words}`,
    });
  }

  /** A current runtime/remote continuation, never a saved activity flag alone. */
  placementRunning(record: TaskRecord): boolean {
    return this.tasks.get(record.id)?.state === "streaming" && !this.outOfReach(record.id);
  }

  /** Where a task would start now: its own Runs on, else its parent's, else its project's. */
  private runsOnFor(record: PlacementRecord): string | null {
    const own = this.ownRunsOn(record);
    return own ? own.deviceId : this.runsOnOf(record);
  }

  /**
   * Whether a task only ever runs on this Mac: a repair assessment, and
   * one whose project can run only here (`runsHereOnly`), or any task where
   * no computer can run work. A task with no project runs where the captain
   * asks, and here without a word.
   */
  private runsOnlyHere(record: PlacementRecord): boolean {
    // A folder repair runs where the folder is (INF-549).
    if (!this.options.machines || isRepairAssessment(record.shape) || record.shape?.in_place)
      return true;
    if (!record.repoId) return false;
    const repo = this.options.repos.get(record.repoId);
    return !repo || runsHereOnly(repo) !== null;
  }

  /** The project's Runs on for a task of its, or null where it runs on this Mac. */
  private runsOnOf(record: PlacementRecord): string | null {
    if (this.runsOnlyHere(record)) return null;
    return this.options.repos.get(record.repoId ?? "")?.runsOn ?? null;
  }

  /**
   * A task's own Runs on (docs/helper.md, "A task's own Runs on"): the
   * captain's word on the task, else on its nearest parent that has one,
   * with where it came from. Undefined where none does, so it follows its
   * project, and for a task that only ever runs on this Mac. Null is this Mac.
   */
  private ownRunsOn(
    record: PlacementRecord,
  ): { deviceId: string | null; from: "task" | "parent" } | undefined {
    const builder = this.reviewBuilderOf(record);
    if (builder) return { deviceId: builder.deviceId ?? null, from: "parent" };
    if (this.runsOnlyHere(record)) return undefined;
    const { tasks } = this.options;
    const parents = record.parentId
      ? [tasks.get(record.parentId), ...tasks.ancestors(record.parentId)]
      : [];
    for (const [index, at] of [record, ...parents].entries()) {
      const ask = at?.shape?.runs_on_ask;
      if (!ask) continue;
      return {
        deviceId: ask === RUNS_ON_THIS_MAC ? null : ask,
        from: index === 0 ? "task" : "parent",
      };
    }
    return undefined;
  }

  /** A task has started: it has a branch, a conversation, or a crewmate now. */
  private started(record: TaskRecord): boolean {
    return Boolean(
      record.placement || record.branch || record.sessionFile || this.tasks.has(record.id),
    );
  }

  /** A task that has not started goes where it would start now; one started stays where it started. */
  private repoint(record: TaskRecord): void {
    if (record.status !== "open" || record.kind !== "work" || this.started(record)) return;
    const requested = this.runsOnFor(record);
    const target = requested === AUTOMATIC_COMPUTER ? null : requested;
    if (target !== (record.deviceId ?? null)) this.options.tasks.setDevice(record.id, target);
  }

  /**
   * A project's Runs on changed: each of its tasks that has not started
   * goes where its next task starts now, unless the captain chose where it
   * runs, and one already started stays where it started (docs/helper.md,
   * "Runs on").
   */
  private projectMoved(repo: RepoView): void {
    for (const record of this.options.tasks.listOpen())
      if (record.repoId === repo.id) this.repoint(record);
  }

  /**
   * The captain's word on where a task runs changed, or the task moved
   * under another parent (docs/helper.md, "A task's own Runs on"): it and
   * each of its parts that has not started go where they would start now.
   */
  runsOnChanged(taskId: string): void {
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    for (const task of [record, ...this.options.tasks.descendants(taskId)]) this.repoint(task);
  }

  /**
   * Why the captain's word on where a task runs cannot be kept, in plain
   * words, or undefined when it can (docs/helper.md, "A task's own Runs
   * on"). `ask` is a device id, `this-mac`, or null to follow its parent's
   * or project's Runs on again.
   */
  runsOnRefusal(taskId: string, ask: string | null): string | undefined {
    const record = this.options.tasks.get(taskId);
    if (!record) return undefined;
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.kind !== "work" || TaskService.isClosed(record))
      return `${handle} is not open work, so where it runs cannot change.`;
    if (record.status !== "open" || this.started(record)) {
      const where = record.deviceId
        ? (this.options.machines?.placeOf(record.deviceId).where ?? `on the other ${COMPUTER.one}`)
        : `on ${HERE.this}`;
      return `${handle} has started, so it finishes where it started, ${where}.`;
    }
    return ask === null ? undefined : this.placeRefusal(handle, record, ask);
  }

  /** Why a task cannot be asked to run at `ask`, or undefined when it can. */
  private placeRefusal(handle: string, record: PlacementRecord, ask: string): string | undefined {
    if (record.shape?.kind === "review")
      return `${handle} is a review and follows its builder's computer; its location cannot be chosen separately.`;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    if (record.repoId && !repo) return `${handle} has no project, so it runs on ${HERE.this}.`;
    if (repo?.kind === "personal")
      return `${handle} builds in your personal workspace, which stays on ${HERE.this}.`;
    const here = repo ? runsHereOnly(repo) : null;
    if (repo && here) return `${handle} is in ${repo.name}. ${here}`;
    if (ask === AUTOMATIC_COMPUTER && !record.repoId)
      return "Automatic needs a project that can run on another computer.";
    if (
      ask !== AUTOMATIC_COMPUTER &&
      ask !== RUNS_ON_THIS_MAC &&
      !this.options.machines?.computers().includes(ask)
    )
      return "No computer that runs work has that deviceId. Look with app_state.";
    return undefined;
  }

  /**
   * Where a task runs, as its record's Details reads it (docs/helper.md,
   * "A task's own Runs on"): where it started, or where it would start
   * now, and where that came from. Absent until a computer that runs work
   * is on the list, for a task that only ever runs on this Mac, and for a
   * task with no project that nobody asked to run elsewhere.
   */
  runsOnFact(record: TaskRecord): TaskRunsOn | undefined {
    const machines = this.options.machines;
    if (!machines || record.kind !== "work") return undefined;
    if (
      !record.deviceId &&
      !record.placement &&
      this.runsOnFor(record) !== AUTOMATIC_COMPUTER &&
      (machines.computers().length === 0 || this.runsOnlyHere(record))
    )
      return undefined;
    // A task with no project has no project setting to follow: it says where
    // it runs only once the captain, or its parent, chose.
    if (!record.deviceId && !record.repoId && !this.ownRunsOn(record)) return undefined;
    const settled = TaskService.isClosed(record) || this.started(record);
    const device = settled ? (record.deviceId ?? null) : this.placementOf(record);
    return {
      label:
        !record.placement && !settled && this.runsOnFor(record) === AUTOMATIC_COMPUTER
          ? AUTOMATIC_WORD
          : device
            ? machines.placeOf(device).label
            : HERE.This,
      source: this.ownRunsOn(record)?.from ?? "project",
      ...(record.placement
        ? {
            reason: placementReason(record.placement.snapshot),
            candidates: placementCandidateLines(record.placement.snapshot),
          }
        : !settled &&
            this.runsOnFor(record) === AUTOMATIC_COMPUTER &&
            this.options.router?.dynamicEnabled()
          ? {
              reason:
                record.startPolicy === "when-ready"
                  ? (record.shape?.placement_wait ?? UNCOMPARED_WAIT).words
                  : "Your first mate chooses a computer when this task starts. It stays there.",
            }
          : {}),
    };
  }

  /**
   * Where a task runs in words, as its Tasks row, its summary and its status
   * read it (docs/helper.md, "Runs on"): the computer it started on, or the
   * one it would start on now, and whether open or underway work's computer
   * is out of reach or not yet caught up. Absent for a task this Mac runs.
   */
  taskPlace(record: TaskRecord): TaskPlace | undefined {
    const machines = this.options.machines;
    if (!machines || record.kind !== "work") return undefined;
    const settled = TaskService.isClosed(record) || this.started(record);
    const device = settled ? record.deviceId : this.placementOf(record);
    if (!device) return undefined;
    const { label, where } = machines.placeOf(device);
    const live = record.status === "open" || record.status === "active";
    const away = live && machines.ready(device, record.id) !== true;
    const older = away && this.options.takesNoWorkUntilUpdated?.(device) === true;
    return {
      name: label,
      where,
      reach: away
        ? this.options.reachOf?.(device) === "connecting" && !older
          ? "connecting"
          : "out-of-reach"
        : "in-reach",
      ...(older ? { noNewWork: true as const } : {}),
    };
  }

  /**
   * Where a project's folder is and where its new tasks start, for the
   * first mate's context (INF-567): the folder is always on this computer,
   * which keeps the record, while its tasks follow the project's Runs on.
   * Absent while no other computer runs work, when the two cannot differ.
   */
  projectPlaces(repo: RepoView): { folder: string; tasks: string } | undefined {
    const machines = this.options.machines;
    if (!machines || machines.computers().length === 0) return undefined;
    const runsOn = runsHereOnly(repo) === null ? repo.runsOn : null;
    return {
      folder: HERE.this,
      tasks:
        runsOn === AUTOMATIC_COMPUTER
          ? AUTOMATIC_WORD
          : runsOn
            ? machines.nameOf(runsOn)
            : HERE.this,
    };
  }

  /** The Details row's words once a task's own Runs on is `ask` ("Mac mini (This task)"). */
  runsOnWords(taskId: string, ask: string | null): string {
    const record = this.options.tasks.get(taskId);
    if (!record) return "";
    const { runs_on_ask: _now, ...shape } = record.shape ?? { kind: "unclear" as const };
    const next = {
      ...record,
      deviceId: null,
      shape: { ...shape, ...(ask ? { runs_on_ask: ask } : {}) },
    };
    const fact = this.runsOnFact(next);
    return fact ? `${fact.label} (${RUNS_ON_SOURCE_WORDS[fact.source]})` : HERE.This;
  }

  /**
   * A task that has not started takes where it would start now, and says
   * whether it must wait for that computer: out of reach, or back and not
   * yet caught up. It never runs on this Mac instead.
   */
  private placeForStart(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    if (!record) return false;
    const target = this.placementOf(record);
    if (target && !record.deviceId) this.options.tasks.setDevice(taskId, target);
    if (!this.outOfReach(taskId)) return false;
    if (target) this.sayPlacedWait(this.waitSubject(record), target);
    return true;
  }

  /**
   * A task for a computer that serves nothing now but a sign-in a cut-off
   * withholds there, as that computer last said, waits for that sign-in, as
   * a lane on a cut-off account here waits (docs/helper.md, "Its own
   * sign-ins"): it takes its place, tries nothing there, and starts once
   * that sign-in serves again. Says whether it waits.
   */
  private waitsForSignIn(taskId: string, target: string): boolean {
    const held = this.options.machines?.signInWait(target);
    const record = this.options.tasks.get(taskId);
    if (!held || !record) return false;
    if (!record.deviceId) this.options.tasks.setDevice(taskId, target);
    this.sayPlacedWait(this.waitSubject(record), target, { ...held, kind: "cut-off" });
    return true;
  }

  /**
   * What a task for a computer waits for before anything is tried there,
   * from what that computer said of its own sign-ins (docs/helper.md, "Its
   * own sign-ins"; the captain's pick on FI3-1350): no sign-in at all, so
   * it waits as queued work and starts by itself once the computer reports
   * one; or, for a project that lives on GitHub, no GitHub sign-in of its
   * own there, so it waits behind a gate that computer's sign-in lifts.
   * Undefined when nothing known keeps it from starting - a computer that
   * has said nothing is tried, and fails the way it always has.
   */
  private async placedWaitFor(
    target: string,
    repoId: string | null,
  ): Promise<Extract<PlacedWaitFor, { kind: "no-sign-ins" | "update" | "forge" }> | undefined> {
    // A task with no project starts from this Mac's default workspace sent
    // first, which a computer on an older Firstmate cannot take.
    if (!repoId && this.options.machines?.takesRepoless?.(target) === false)
      return { kind: "update" };
    const signIns = await this.options.machines?.signInsOf(target);
    if (!signIns) return undefined;
    // A task there is routed among that computer's own sign-ins; a home
    // that routes nothing binds what it was given, whatever the computer has.
    if (signIns.accounts.length === 0 && this.options.router) return { kind: "no-sign-ins" };
    const origin = repoId ? this.options.repos.get(repoId)?.origin : undefined;
    const where = forgeOf(origin);
    if (where.kind !== "github" || where.host !== GITHUB_HOST || !signIns.forges) return undefined;
    // Only a sign-in that computer offers from here is worth waiting for; a
    // computer too old to offer one is tried, and a refusal there is typed.
    const host = where.host;
    if (!signIns.forges.hosts.some((entry) => entry.host === host)) return undefined;
    return signIns.forges.signIns.some((entry) => entry.host === host)
      ? undefined
      : { kind: "forge", host };
  }

  /**
   * A queued task for a computer with no sign-in it needs waits, as that
   * computer said (`placedWaitFor`): as unheld queued work for any sign-in
   * at all, which the ready sweep tries again once the computer reports
   * one; behind the sign-in's gate for its own GitHub sign-in.
   */
  private waitForSetup(
    taskId: string,
    target: string,
    waitFor: Extract<PlacedWaitFor, { kind: "no-sign-ins" | "update" | "forge" }>,
  ): void {
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    if (!record.deviceId) this.options.tasks.setDevice(taskId, target);
    if (waitFor.kind === "forge") this.holdForDeviceForge(taskId, target, waitFor.host);
    this.sayPlacedWait(this.waitSubject(record), target, waitFor);
  }

  /** The gate a task waits behind for its computer's own GitHub sign-in. */
  private holdForDeviceForge(taskId: string, deviceId: string, host: string): void {
    const who = this.options.machines?.placeOf(deviceId).who ?? "the computer it runs on";
    const name = forgePlace({ kind: "github", host }) ?? host;
    const gate = {
      kind: "captain" as const,
      ref: deviceForgeGateRef(host, deviceId),
      reason: deviceForgeGateReason(who, name),
    };
    const record = this.options.tasks.get(taskId);
    if (record?.gate?.ref === gate.ref) return;
    if (record?.status === "open") this.options.tasks.setGate(taskId, gate, gate.reason);
    else this.options.tasks.requeue(taskId, gate, gate.reason);
  }

  /**
   * Where a crewmate card's task runs, for a task on a computer that runs
   * work ("on Mac mini", "as Builder"; docs/helper.md, "A card from
   * there"). It rides beside the meta line, never inside it, so a long
   * task title gives way and the place never does.
   */
  private cardPlace(taskId: string): string | undefined {
    const device = this.options.tasks.get(taskId)?.deviceId;
    return device ? this.options.machines?.placeOf(device).where : undefined;
  }

  /** The project's name, or the task's title for a task with none. */
  private projectWord(repoId: string | null, title: string): string {
    return (repoId ? this.options.repos.get(repoId)?.name : undefined) ?? title;
  }

  /**
   * Who the feed says waits for a computer (design skill
   * `components/devices/RunsOn`): the task, by its title, where the
   * captain chose where it runs; else its project's next task. A wait is
   * said once per subject and computer.
   */
  private waitSubject(record: PlacementRecord & { id: string; title: string }): {
    key: string;
    name: string;
    runHere: string;
    /** The project's name, for the GitHub card a wait for its computer's sign-in raises. */
    project: string;
  } {
    const project = this.projectWord(record.repoId, record.title);
    if (this.ownRunsOn(record)) {
      const name = `"${record.title}"`;
      return {
        key: `task:${record.id}`,
        name,
        runHere: `To run it here instead, ask your first mate to run ${name} on ${HERE.this}.`,
        project,
      };
    }
    return {
      key: record.repoId ?? record.title,
      name: `${project}'s next task`,
      runHere: `To run it here instead, set ${project} to run on ${HERE.this}.`,
      project,
    };
  }

  /** A project's next task as the subject of a wait, where no task record names one yet. */
  private projectSubject(repo: { id: string; name: string }): {
    key: string;
    name: string;
    project: string;
  } {
    return { key: repo.id, name: `${repo.name}'s next task`, project: repo.name };
  }

  /**
   * The feed's words for a task waiting for its computer (design skill
   * `components/devices/RunsOn`): once when the wait begins, and once more
   * after a day. Feed lines, never cards.
   */
  private sayPlacedWait(
    subject: ReturnType<CrewSupervisor["waitSubject"]>,
    device: string,
    waitFor?: PlacedWaitFor,
  ): void {
    const key = `${subject.key}\n${device}`;
    const place = this.options.machines?.placeOf(device);
    if (!place) return;
    const now = this.now();
    const older = !waitFor && this.options.takesNoWorkUntilUpdated?.(device) === true;
    const on = !waitFor
      ? older
        ? "no-new-work"
        : "reach"
      : waitFor.kind === "cut-off"
        ? waitFor.class === "no_headroom"
          ? "allowance"
          : "sign-in"
        : waitFor.kind;
    const wait = this.placedWaits.get(key);
    if (wait?.on !== on) {
      this.placedWaits.set(key, { since: now, dayTold: false, on });
      // A project's task waiting for that computer's own GitHub sign-in
      // raises the GitHub card too, unless its setup card already asks.
      if (waitFor?.kind === "forge") {
        this.deviceForgeSignInNeeded(device, waitFor.host, subject);
        return;
      }
      // The wait begins: the Update card returns, even after Not now.
      if (older) this.options.recallUpdateCard?.(device);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: !waitFor
          ? older
            ? noNewWorkWaitLine(subject.name, place.who)
            : `${subject.name} waits for ${place.who}. It never runs on ${HERE.this} instead.`
          : waitFor.kind === "cut-off"
            ? placedCutOffWaitLine(subject.name, place.who, waitFor, now)
            : waitFor.kind === "update"
              ? updateWaitLine(place.label, subject.name)
              : noSignInsWaitLine(place.label, subject.name),
      });
      return;
    }
    // A sign-in or a spent allowance there comes back on its own: no day's line.
    if (
      (on !== "reach" && on !== "no-new-work") ||
      wait.dayTold ||
      now - wait.since < PLACED_WAIT_DAY_MS
    )
      return;
    wait.dayTold = true;
    this.options.broadcastEvent({
      type: "firstmate_note",
      text:
        on === "no-new-work"
          ? noNewWorkDayLine(place.label, subject.name)
          : `${place.label} has been out of reach for a day. ${subject.name} still waits.`,
    });
    this.options.broadcastEvent({ type: "firstmate_note", text: subject.runHere });
  }

  /** A task started on the computer it waited for: the wait's last line. */
  private sayPlacedStarted(taskId: string): void {
    const record = this.options.tasks.get(taskId);
    const device = record?.deviceId;
    if (!record || !device) return;
    const subject = this.waitSubject(record);
    if (!this.placedWaits.delete(`${subject.key}\n${device}`)) return;
    const place = this.options.machines?.placeOf(device);
    if (!place) return;
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `${subject.name} started ${place.where}.`,
    });
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
    this.reconcileStartChecks();
    this.ladder.checkCutOffs();
  }

  /**
   * A start whose contact was lost: once the computer is back, a recorded
   * session means it started, and none means it did not. Neither is a
   * confirmed failure, and Start stays unavailable until that is known.
   */
  private reconcileStartChecks(): void {
    for (const id of this.options.tasks.startAttemptIds()) {
      const attempt = this.options.tasks.startAttemptOf(id);
      if (attempt?.phase !== "checking") continue;
      const record = this.options.tasks.get(id);
      if (!record) {
        this.options.tasks.clearStartAttempt(id);
        continue;
      }
      if (record.sessionFile || this.tasks.has(id)) {
        this.options.tasks.clearStartAttempt(id);
        continue;
      }
      if (record.placement) continue; // its durable order, not roster absence, owns reconciliation
      if (record.deviceId && this.outOfReach(id)) continue;
      this.options.tasks.releaseUnconfirmedStart(id);
    }
  }

  // ---- the card stack (CardService) -----------------------------------------

  /** A task's open cards, oldest first (WI-6). Read-only. */
  openCardsFor(taskId: string): Pick<Card, "id" | "title" | "actions" | "createdAt">[] {
    return this.cards.openCardsFor(taskId);
  }

  /** A task's open cards with body, actions and emitter (WI-8, WI-12). Read-only. */
  openCardDigests(taskId: string): ReturnType<CardService["openCardDigests"]> {
    return this.cards.openCardDigests(taskId);
  }

  flushCards(): void {
    this.cards.flushBroadcast();
  }

  setCardMinimized(cardId: string, minimized: boolean): void {
    this.cards.setMinimized(cardId, minimized);
  }

  showOpenCard(cardId: string): Card | undefined {
    if (!this.cards.shown(cardId)) return undefined;
    this.cards.showOpenCard(cardId);
    return this.cards.shown(cardId);
  }

  cardsSnapshot(): Card[] {
    return this.cards.snapshot();
  }

  /** The persisted closing offer/action/answers for recovery reads. */
  newestCardResolution(taskId: string): CardResolution | undefined {
    return this.cards.newestResolutionForTask(taskId);
  }

  /** A task's newest card body (Task B): an answer task's card IS its deliverable. */
  newestCardBody(taskId: string): string | undefined {
    return this.cards.newestBody(taskId);
  }

  /** A card the Firstmate agent emits: its only user-facing output channel. */
  addFirstmateCard(input: EmittedCardInput): string {
    if (input.requiredActions !== undefined) {
      const priorSource = input.id
        ? this.options.tasks.taskForCard(resolveFirstmateCardId(input.id))
        : undefined;
      this.options.tasks.validateRequiredActions(
        input.taskId ?? priorSource?.id ?? "",
        input.requiredActions,
      );
    }
    const id = this.cards.addFirstmateCard(input);
    const offer = this.cards.get(id);
    if (input.requiredActions !== undefined && input.taskId && offer?.offerId) {
      const merges = input.actions.some(
        (action) => settleEffectOf(action)?.mode === "merge" || requestMergeEffectOf(action),
      );
      this.options.tasks.declareRequiredActions(
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

  declareStandaloneRequiredActions(input: EmittedCardInput, cardId: string): void {
    if (input.taskId || input.requiredActions === undefined) return;
    const source = this.options.tasks.taskForCard(cardId);
    const card = this.cards.get(cardId);
    if (!source || !card?.offerId) throw new Error("Required actions have no source record.");
    this.options.tasks.declareRequiredActions(
      source.id,
      { cardId, offerId: card.offerId, actions: input.requiredActions },
      true,
    );
    void this.sweepGates(this.now());
  }

  /** Approved host-presented copy, owned by Firstmate and recorded atomically. */
  addRecordedFirstmateNote(
    input: Pick<EmittedCardInput, "title" | "body" | "pictures"> & { answer?: string },
    record: (cardId: string) => void,
    presentation: { onTop?: boolean; replies?: false; width?: CardWidth } = {},
  ): string {
    return this.cards.addRecordedFirstmateNote(input, record, presentation);
  }

  /** An emitter withdraws its own card (close_card). */
  closeCard(
    cardId: string,
    actor: { kind: "firstmate" } | { kind: "crewmate"; taskId: string },
    reason?: string,
  ): string {
    return this.cards.close(cardId, actor, reason);
  }

  cardThread(cardId: string): CardThread {
    return this.cards.thread(cardId);
  }

  showRequiredAction(taskId: string): boolean {
    return this.cards.presentRequiredAction(taskId);
  }

  /** Called only from the authenticated connection's fresh hello, not cached device reads. */
  observeRequiredActionDevice(
    deviceId: string,
    version: { app?: string; takesWork: boolean },
  ): void {
    if (!version.app || !version.takesWork) return;
    for (const record of this.options.tasks.listOpen()) {
      const action = record.delivery?.captainAction;
      if (!action || !this.options.tasks.captainActionReady(record.id)) continue;
      const matches = action.requirements.every(({ action: requirement }) => {
        const criterion = requirement.completion;
        if (criterion.kind !== "device-version" || criterion.deviceId !== deviceId) return false;
        const order = compareSemver(version.app as string, criterion.minVersion);
        return order !== null && order >= 0;
      });
      if (
        matches &&
        this.options.tasks.completeCaptainAction(record.id, action.generation, "checked")
      )
        this.cards.retireTaskCards(record.id, "answered");
    }
    void this.sweepGates(this.now());
  }

  /** A closed card as the captain last saw it (`CardService.past`). */
  cardPast(cardId: string): PastCard | undefined {
    return this.cards.past(cardId);
  }

  /** The window showed the captain this version of the card (`CardService.seen`). */
  cardSeen(cardId: string, offerId: string): void {
    this.cards.seen(cardId, offerId);
  }

  addCardMessage(cardId: string, who: CardMessageWho, text: string): CardMessage {
    return this.cards.addMessage(cardId, who, text);
  }

  recordFirstmateThreadAnswer(cardId: string, text: string): boolean {
    return this.cards.recordFirstmateThreadAnswer(cardId, text);
  }

  /** The Firstmate's turn ended: its close-out, so its answered cards reach the stage. */
  firstmateClosedOut(): void {
    this.cards.closeOut({ kind: "firstmate" }, "turn-end");
  }

  observeThreads(sessionId: string): ReturnType<CardService["observeThreads"]> {
    return this.cards.observeThreads(sessionId);
  }

  flagDuplicate(input: { cardId: string; duplicateOf: string; note: string }): DuplicateResult {
    const card = this.cards.shown(input.cardId);
    const result = this.cards.flagDuplicate(input);
    // A crewmate's card closed as a duplicate is told to it, as the
    // captain's own close is (INF-759).
    if (result.status === "flagged" && card)
      this.tellCardClosed(card, { id: result.original.id, title: result.original.title });
    return result;
  }

  addFirstmatePauseCard(input: FirstmatePauseCard, options: { reviseOnly?: boolean } = {}): void {
    this.cards.addFirstmatePauseCard(input, options);
  }

  addFirstmateMoveBackCard(input: {
    providerId: string;
    providerName: string;
    body: string;
  }): void {
    this.cards.addFirstmateMoveBackCard(input);
  }

  withdrawFirstmatePauseCards(reason: string): void {
    this.cards.withdrawFirstmatePauseCards(reason);
  }

  addAuthDecisionCard(
    id: string,
    meta: string,
    body: string,
    options?: { restoreAccountId?: string; taskId?: string },
  ): void {
    this.cards.addAuthDecisionCard(id, meta, body, options);
  }

  addForgeSignInCard(
    id: string,
    host: string,
    name: string,
    waitingChanges: number,
    options: { reauth?: boolean } = {},
  ): void {
    this.cards.addForgeSignInCard(id, host, name, waitingChanges, options);
  }

  clearAuthDecisionCard(id: string): void {
    this.cards.clearAuthDecisionCard(id);
  }

  /** The action that resolved a host card, while it stays resolved (`CardService.chosenAction`). */
  cardChosenAction(id: string): string | undefined {
    return this.cards.chosenAction(id);
  }

  /** Whether the stack ever held a card under this id, open or resolved. */
  cardStored(id: string): boolean {
    return this.cards.stored(id) !== undefined;
  }

  /**
   * A project that lives on a host runs on a computer with no sign-in of
   * its own there (docs/forge.md, "A computer's own sign-in"): the feed
   * says its next task waits for that sign-in, and the host's GitHub card
   * for that computer goes up - unless that computer's setup card is on the
   * stack, which already asks for the sign-in in its own row.
   */
  deviceForgeSignInNeeded(
    deviceId: string,
    host: string,
    subject: { key: string; name: string; project: string },
  ): void {
    const place = this.options.machines?.placeOf(deviceId);
    if (!place) return;
    const name = forgePlace({ kind: "github", host }) ?? host;
    // Said once per subject and computer, until that computer signs in.
    const said = `${deviceForgeGateRef(host, deviceId)}\n${subject.key}`;
    if (!this.deviceForgeSaid.has(said)) {
      this.deviceForgeSaid.add(said);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: deviceForgeWaitLine(subject.name, place.who, name),
      });
    }
    if (this.cards.has(deviceSetupCardId(deviceId))) return;
    this.cards.addDeviceForgeSignInCard({
      deviceId,
      host,
      name,
      project: subject.project,
      place,
    });
    this.cards.scheduleBroadcast();
  }

  /** The same, for a project set to run on such a computer before any task of its own waits. */
  projectForgeSignInNeeded(
    deviceId: string,
    host: string,
    repo: { id: string; name: string },
  ): void {
    this.deviceForgeSignInNeeded(deviceId, host, this.projectSubject(repo));
  }

  /**
   * A computer said something new of its own sign-ins: a project's next
   * task that waits for it to have any sign-in at all is tried now, not at
   * the next tick. Only such a wait is retried here; everything else keeps
   * to the ready sweep, so nothing here races a start already under way.
   */
  deviceSignInsChanged(deviceId: string): void {
    const waiting = [...this.placedWaits].some(
      ([key, wait]) => wait.on === "no-sign-ins" && key.endsWith(`\n${deviceId}`),
    );
    if (!waiting) return;
    for (const record of this.options.tasks.listReady()) {
      if (record.kind !== "work" || record.deviceId !== deviceId) continue;
      void this.dispatchQueuedTask(record.id).catch((caught: unknown) => {
        console.warn("[crew] a placed task's start after a sign-in failed:", caught);
      });
    }
  }

  /**
   * A computer reported its own sign-in for a host where projects live: its
   * GitHub card comes down, and every task held for that sign-in starts.
   */
  async resumeDeviceForgeSignInTasks(deviceId: string, host: string): Promise<void> {
    this.cards.clearAuthDecisionCard(deviceForgeSignInCardId(host, deviceId));
    const ref = deviceForgeGateRef(host, deviceId);
    for (const said of [...this.deviceForgeSaid])
      if (said.startsWith(`${ref}\n`)) this.deviceForgeSaid.delete(said);
    for (const record of this.options.tasks.listOpen()) {
      if (record.kind !== "work" || record.gate?.ref !== ref) continue;
      this.options.tasks.setGate(record.id, null, "its computer's own GitHub sign-in is ready");
      await this.dispatchQueuedTask(record.id);
    }
  }

  raiseHostCard(card: Omit<Card, "author" | "priority" | "status" | "createdAt">): void {
    this.cards.raiseHostCard(card);
  }

  withdrawHostCard(id: string, reason: string): void {
    this.cards.withdrawHostCard(id, reason);
  }

  hasCard(id: string): boolean {
    return this.cards.has(id);
  }

  addFirstmateQuietCard(body: string): void {
    this.cards.addFirstmateQuietCard(body);
  }

  clearFirstmateQuietCard(): void {
    this.cards.clearFirstmateQuietCard();
  }

  addFirstmateFailureCard(body: string): void {
    this.cards.addFirstmateFailureCard(body);
  }

  addSystemNoteCard(id: string, title: string, body: string): void {
    this.cards.addSystemNoteCard(id, title, body);
  }

  threadActivitySince(since: number, limit = 8): ThreadActivity[] {
    return this.cards.threadActivitySince(since, limit);
  }

  captainResolutionsSince(since: number, limit: number): CardResolution[] {
    return this.cards.captainResolutionsSince(since, limit);
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
  private routeCrewEvent(taskId: string, wake: TypedWake, origin: ServedWakeOrigin): void {
    this.hooks.notifyOp(wake, origin, taskId);
  }

  /**
   * Commission a crewmate (the spawn_crewmate tool). Fail-loud: an unknown
   * repoId rejects rather than silently landing in the default workspace.
   * Returns the admission handle as soon as the crewmate starts; results
   * flow back through the hooks, never through this promise.
   *
   * With start_after (R1) the work is queued instead: a row with a gate,
   * no worktree and no session until the ready sweep dispatches it. An
   * explicit reasoning ask that cannot be served right now also queues,
   * behind one decision card, rather than silently downgrading (P7).
   */
  async commission(input: {
    title: string;
    /** The structured intent (spawn v2); the host renders the fixed brief. */
    intent: SpawnIntent;
    repoId?: string;
    /**
     * The facts the Firstmate supplied (contract v2.8): a basis task, the
     * captain's premium ask, a model he named. The host checks the basis
     * and computes the tier; the Firstmate judges no class.
     */
    shape?: WorkShapeAsk;
    /** R1: queue behind a gate instead of starting now. */
    startAfter?: { afterTask?: string; whenQuotaResets?: string; at?: number };
    /** The graph (P2): a parent, blockers (queues the work), a priority. */
    parent?: string;
    blockedBy?: string[];
    priority?: number;
    /**
     * The copies of the pictures on the captain's message that asked for
     * this work. Its brief carries them before that message attaches to
     * the new task; a queued row reads them from the task once it has.
     */
    attachments?: readonly AttachmentRef[];
  }): Promise<{ taskId: string; crewmate: string; model?: NamedModel }> {
    // An independent review (delivery rigor phase 2) is its own commission:
    // the host briefs it from the record and holds the builder's merge.
    if (input.shape?.review_of?.trim()) {
      if (input.shape.in_folder)
        throw new Error(`${NOTHING_SPAWNED} A review reads its builder's branch; omit in_folder.`);
      // Review placement belongs to the builder, never a second choice.
      if (input.shape.runs_on_ask?.trim())
        throw new Error(
          `${NOTHING_SPAWNED} A review follows its builder's computer; omit runs_on_ask.`,
        );
      return this.withNamedModel(
        await this.commissionReview(input, input.shape.review_of.trim()),
        input.shape,
      );
    }
    // A personal-ui ask is bound by the host (Step 4): the personal
    // workspace, registered on first need, whatever repo_id came with it.
    const personalRepo = input.intent.kind === "personal-ui" ? this.personalRepo() : undefined;
    // An escalation is resolved FIRST (S4): every refusal - an unknown or
    // never-run task, a lineage past its bound, nothing above premium -
    // happens before a row, a worktree or a rejection exists.
    const escalation = this.resolveEscalation(input.shape?.escalate_from, input.shape?.premium_ask);
    const inheritedDeliveryAsk =
      input.shape?.delivery_ask ?? escalation?.previous.shape?.delivery_ask;
    const placement = this.resolveGraphPlacement(
      personalRepo
        ? { ...input, repoId: personalRepo.id }
        : escalation
          ? {
              ...input,
              // The lineage stays where it was: same repository, same
              // parent, so the fresh attempt lands in the same project.
              // The previous task's delivery_ask rides too, so the brief
              // matches the shape workShape will stamp.
              ...((input.repoId ?? escalation.previous.repoId)
                ? { repoId: input.repoId ?? escalation.previous.repoId ?? undefined }
                : {}),
              ...((input.parent ?? escalation.previous.parentId)
                ? { parent: input.parent ?? escalation.previous.parentId ?? undefined }
                : {}),
              ...(inheritedDeliveryAsk
                ? { shape: { ...input.shape, delivery_ask: inheritedDeliveryAsk } }
                : {}),
            }
          : input,
    );
    const boundRepoId = placement.repoId;
    // The fixed template is host-rendered from the intent (contract v1):
    // no model authors the crewmate's first message. An escalation adds
    // one host-written section about the attempt it replaces.
    const personal = placement.personal ? this.personalFacts() : undefined;
    // Two kinds of task are told no delivery posture at all, because
    // neither ships a change through one: a personal task builds in place
    // (Task A), and an ANSWER task commits nothing, pushes nothing and
    // opens no pull request (Task B). So the brief is rendered from the
    // shape, once the deliverable on it is settled.
    // Folder work (INF-567) ships nothing either, and is told the folder.
    const renderBrief = (shaped: WorkShape): string => {
      // A stronger-model retry of folder work inherits it with no ask of its own.
      const inheritedRepo =
        !placement.folder && isFolderWork(shaped.in_place) && boundRepoId
          ? this.options.repos.get(boundRepoId)
          : undefined;
      const folder =
        placement.folder ??
        (inheritedRepo ? { project: inheritedRepo.name, folder: inheritedRepo.path } : undefined);
      const delivery =
        placement.personal || folder || shaped.deliverable === "answer"
          ? undefined
          : placement.delivery;
      return escalation
        ? renderEscalationBrief(
            input.intent,
            delivery,
            escalation.facts,
            personal ? { ...personal, kind: shaped.kind } : undefined,
            folder,
          )
        : renderIntentBrief(
            input.intent,
            delivery,
            personal ? { ...personal, kind: shaped.kind } : undefined,
            folder,
          );
    };
    const taskId = randomUUID().slice(0, 8);
    const title = (input.title.trim() || input.intent.goal || "Task").slice(0, 64);
    // Where the captain said it runs is checked before a row exists
    // (docs/helper.md, "A task's own Runs on").
    const runsOnAsk = input.shape?.runs_on_ask?.trim();
    const runsOnRefused =
      runsOnAsk && this.placeRefusal(`"${title}"`, { repoId: boundRepoId }, runsOnAsk);
    if (runsOnRefused) throw new Error(`${NOTHING_SPAWNED} ${runsOnRefused}`);
    const handOff = this.handOffShape(input.shape, boundRepoId);
    if ("refused" in handOff) throw new Error(`${NOTHING_SPAWNED} ${handOff.refused}`);
    const shape = this.withDeliverable(
      { ...this.workShape(input.shape, escalation), ...handOff },
      input.intent,
    );
    const graph = {
      ...(placement.parentId ? { parentId: placement.parentId } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    };

    if (input.startAfter || placement.blockedBy.length > 0) {
      const wait = this.waitFromStartAfter(input.startAfter ?? {}, placement.blockedBy);
      // The kind is established at gate-open, so this row's deliverable is
      // what its typed constraints alone say; `classifyQueued` re-derives it
      // from the classifier's kind and `dispatchQueuedTask` re-renders the
      // brief if that changes the answer.
      this.insertQueuedWork(taskId, title, renderBrief(shape), input.intent, boundRepoId, shape, {
        ...wait,
        ...graph,
      });
      this.announcePlanSkip(shape);
      const blockers = this.options.tasks.blockers(taskId);
      if (escalation) await this.applyEscalation(escalation, taskId);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Queued "${title}" - ${wait.gate ? gateText(wait.gate) : blockedText(blockers)}.`,
      });
      this.broadcastCrewCounts();
      return { taskId, crewmate: "queued" };
    }

    // The kind is established here, in the spawn path, before routing (S3,
    // design section 3.4): a queued row is classified at its gate-open
    // instead, so the cheap call happens as late as it can still matter.
    // An escalation never reaches the classifier at all - its kind is
    // inherited from the attempt it replaces.
    const classified = this.withDeliverable(
      await this.classifyShape(taskId, title, input.intent, boundRepoId, shape),
      input.intent,
    );
    const brief = renderBrief(classified);
    // Where it runs comes first, so its model is chosen among that
    // computer's own subscriptions (docs/helper.md, "Its own sign-ins"). A
    // computer that is out of reach chooses once it is back.
    const placed = {
      id: taskId,
      title,
      repoId: boundRepoId,
      parentId: placement.parentId,
      shape: classified,
    };
    if (this.automaticFor(placed)) {
      this.insertQueuedWork(taskId, title, brief, input.intent, boundRepoId, classified, graph);
      if (escalation) await this.applyEscalation(escalation, taskId);
      this.announcePlanSkip(classified);
      await this.dispatchQueuedTask(taskId, { requested: { by: "firstmate" } });
      const started = this.options.tasks.get(taskId);
      return this.withNamedModel({ taskId, crewmate: started?.assignee ?? "queued" }, input.shape);
    }
    const target = this.placementOf(placed);
    const waitsThere = target !== null && !this.options.machines?.ready(target, taskId);
    // A computer whose only sign-in a cut-off withholds takes it once that
    // sign-in serves: known before routing once that computer said so, and
    // after routing found nothing there to take it.
    const heldThere = () =>
      target !== null && !waitsThere ? this.options.machines?.signInWait(target) : undefined;
    const cutOffThere = heldThere();
    let signInThere: PlacedWaitFor | undefined = cutOffThere
      ? { ...cutOffThere, kind: "cut-off" }
      : undefined;
    // A computer with no sign-in at all, or none for where the project
    // lives, is not tried: the task waits for the sign-in and starts by
    // itself once that computer reports it.
    if (target !== null && !waitsThere && !signInThere)
      signInThere = await this.placedWaitFor(target, boundRepoId);
    const routed =
      waitsThere || signInThere
        ? undefined
        : await this.routeTask(taskId, brief, classified, target);
    if (!signInThere && !routed?.choice) {
      const held = heldThere();
      if (held) signInThere = { ...held, kind: "cut-off" };
    }
    if (routed && requiresReasoningWait(classified, routed)) {
      // Premium is the one class Firstmate may name only because the user
      // did, so it is the one whose downgrade is never silent (P7 + R1):
      // the work waits on the quota reset - the safe default - and one wake
      // tells the Firstmate, which may start it lower with update_task
      // start_now or drop it. An escalation's rung waits the same way (S4),
      // since serving it from the tier that already failed is the one thing
      // escalation exists to prevent. A computed high or low falls back with
      // a feed line, as it always has.
      this.insertQueuedWork(taskId, title, brief, input.intent, boundRepoId, classified, {
        gate: reasoningWaitGate(routed.bucket),
        ...graph,
      });
      if (escalation) await this.applyEscalation(escalation, taskId);
      this.announcePlanSkip(classified);
      this.wakeReasoningWait(taskId, title, routed);
      this.broadcastCrewCounts();
      return { taskId, crewmate: "queued" };
    }

    // Its project runs on a computer that is out of reach (docs/helper.md,
    // "Runs on"), or whose own sign-in a cut-off withholds: the task waits
    // there as queued work and starts once that computer is back, or that
    // sign-in serves again, never on this Mac instead.
    if (target && (waitsThere || signInThere)) {
      this.insertQueuedWork(taskId, title, brief, input.intent, boundRepoId, classified, graph);
      this.options.tasks.setDevice(taskId, target);
      if (signInThere?.kind === "forge") this.holdForDeviceForge(taskId, target, signInThere.host);
      if (escalation) await this.applyEscalation(escalation, taskId);
      this.announcePlanSkip(classified);
      this.sayPlacedWait(this.waitSubject(placed), target, waitsThere ? undefined : signInThere);
      this.broadcastCrewCounts();
      return { taskId, crewmate: "queued" };
    }

    // The record exists from the moment intent does (design principle 1);
    // it is born active so the ready sweep never races the start below.
    this.options.tasks.create({
      id: taskId,
      kind: "work",
      title,
      prompt: brief,
      intent: input.intent,
      repoId: boundRepoId,
      difficulty: routed?.bucket ?? tierFor(classified).bucket ?? null,
      shape: classified,
      status: "active",
      // Its computer rides the same write, so the stage places the crewmate
      // on its own cluster from its first event (docs/crew-orbits.md).
      deviceId: target,
      ...graph,
    });
    this.announcePlanSkip(classified);
    // The rejected attempt stops, keeps its branch and records the lineage
    // before the fresh crewmate starts, so the two never run at once.
    if (escalation) await this.applyEscalation(escalation, taskId);
    return this.withNamedModel(
      await this.startTask({
        taskId,
        title,
        brief,
        repoId: boundRepoId,
        routed,
        fresh: true,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      }),
      input.shape,
    );
  }

  /**
   * A model the captain named routes only when it can serve, so a started
   * commission's answer carries the model that took the task beside it
   * (FI3-444). Read from the ask, since a review never routes on one.
   */
  private withNamedModel(
    handle: { taskId: string; crewmate: string },
    ask: WorkShapeAsk | undefined,
  ): { taskId: string; crewmate: string; model?: NamedModel } {
    const named = ask?.override_model_id?.trim();
    if (!named || handle.crewmate === "queued") return handle;
    return {
      ...handle,
      model: { named, took: this.options.tasks.get(handle.taskId)?.model ?? null },
    };
  }

  /** Presentation of the agent's declaration, never a host gate or inference. */
  private announcePlanSkip(shape: WorkShape): void {
    if (!shape.skipped_plan_because?.trim()) return;
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: planSkippedText(shape.skipped_plan_because),
    });
  }

  /**
   * Commission the independent reviewer of a reviewed task's change
   * (delivery rigor phase 2; review-before-PR since the captain's
   * 2026-09-19 ruling). Every refusal is a loud tool error before a row
   * exists: the builder must be crewmate work that is still open, must
   * ship at the reviewed tier, must have reported, must have commits on
   * its branch to read, and must not already have a review open. The
   * review runs BEFORE the pull request, the way the no-mistakes pipeline
   * orders it: the reviewer reads the builder's branch at its current
   * head (worktrees share the repository's refs, so the diff against the
   * default branch is the change), fix rounds land as local commits, and
   * the push, PR and CI come after the pass. An existing PR never hides a
   * newer builder version; an unreadable current branch holds the review.
   * The reviewer is a fresh crewmate on the
   * builder's repository, briefed by the host with the fixed review text,
   * its shape `review` established by the host and never the classifier,
   * and linked `blocks` onto the builder so the builder's close waits on
   * its verdict. It is read-only by brief, not by jail - like every
   * crewmate's isolation.
   */
  private async commissionReview(
    input: {
      title: string;
      intent: SpawnIntent;
      repoId?: string;
      priority?: number;
    },
    reviewOf: string,
  ): Promise<{ taskId: string; crewmate: string }> {
    const builder = this.resolveTaskRef(reviewOf, "review_of");
    const handle = builder.key || builder.id;
    if (builder.kind !== "work") {
      throw new Error(
        `${handle} is not crewmate work, so there is no change to review. review_of names the task whose branch an independent reviewer should read.`,
      );
    }
    if (builder.status === "done" || builder.status === "dropped") {
      throw new Error(
        `${handle} is already ${describeStatus(builder)}; there is nothing left to review.`,
      );
    }
    const rigor = this.policiesOf(builder)?.rigor.value;
    if (rigor !== "reviewed") {
      throw new Error(
        `${handle} ships at the ${rigor ?? "quick"} tier, not reviewed, so no independent review holds its merge: its completion card is the decision. Nothing was spawned.`,
      );
    }
    const delivery = this.taskDelivery(builder.id) ?? "local-only";
    if (!builder.outcome) {
      throw new Error(
        `${handle} has not reported yet; a reviewer reads the builder's report beside its change. Wait for the report.`,
      );
    }
    // Review-before-PR: the reviewer reads the builder's branch at its
    // current head and evidence, including unpublished repairs to an existing PR.
    const facts = await this.reviewFacts(builder);
    const { headSha, prUrl } = facts;
    const open = this.openReviewOf(builder.id);
    if (open) {
      throw new Error(
        `${handle} already has a review open: ${open.key || open.id} "${open.title}". Steer it to re-review at the new head instead of spawning another.`,
      );
    }
    if (input.repoId && input.repoId !== builder.repoId) {
      throw new Error(
        `review_of ${handle} is on another repository than repo_id "${input.repoId}"; pass the builder's repo_id or omit it.`,
      );
    }
    const intent: SpawnIntent = {
      ...input.intent,
      goal: `Review the change for "${builder.title}" and report findings.`,
    };
    // A review after an earlier pass reads only what changed since that
    // pass (INF-401): the passed version rides the brief and this review's
    // own record, so its later turns keep the same scope.
    const passed =
      builder.delivery?.reviewVerdict === "pass" ? builder.delivery.reviewSha : undefined;
    const passedHead = passed && passed !== headSha ? passed : undefined;
    const brief = renderReviewBrief(
      intent,
      delivery,
      passedHead ? { ...facts, passedHead } : facts,
    );
    const taskId = randomUUID().slice(0, 8);
    const title = `Review: ${builder.title}`.slice(0, 64);
    // The host establishes the kind: a review is never classified, and its
    // basis is the builder, whose report it reads. The builder join is the
    // parent edge below, never a shape field.
    const shape = this.withBasisVerdict({
      kind: "review",
      kind_source: "host:review",
      basis: builder.id,
    });
    // Prefer another provider on the builder's computer, never move the
    // review to another computer just to get a different provider.
    const avoidProvider = this.options.router?.servedProvider(builder.id);
    const routed = await this.routeTask(
      taskId,
      brief,
      shape,
      builder.deviceId ?? null,
      avoidProvider,
    );
    this.options.tasks.create({
      id: taskId,
      kind: "work",
      title,
      prompt: brief,
      intent,
      repoId: builder.repoId,
      difficulty: routed?.bucket ?? tierFor(shape).bucket ?? null,
      shape,
      status: "active",
      // The review is the builder's own delivery machinery: a CHILD of the
      // builder (the one stored join), host-fenced against re-parenting,
      // excluded from the children-open close gate, and retired by the
      // builder's close whatever its direction (`retireDeliveryChildren`).
      parentId: builder.id,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    });
    this.options.tasks.setDevice(taskId, builder.deviceId ?? null);
    this.options.tasks.recordDelivery(taskId, {
      headSha,
      ...(facts.changeReading ? { reviewChange: facts.changeReading } : {}),
      ...(passedHead ? { passedHead } : {}),
      validationAssignment: validationAssignment(builder.delivery?.liveValidation, headSha),
    });
    // The hold: the review blocks the builder's close until it is done.
    // The parent edge deliberately does not carry it - a child out of the
    // close gate holds nothing, and the blocks rule has no
    // `proceed_with_open` override.
    this.options.tasks.link(taskId, builder.id, "blocks", "host", true);
    this.options.tasks.recordDelivery(
      builder.id,
      {},
      {
        kind: "review",
        text: `review opened - ${title} reads branch ${builder.branch} at ${headSha.slice(0, 7)}${
          passedHead ? `, only what changed since the pass at ${passedHead.slice(0, 7)}` : ""
        }${prUrl ? ` (pull request ${prUrl} is not the assigned head)` : ""}`,
        feed: false,
        data: { reviewTaskId: taskId },
      },
    );
    return this.startTask({
      taskId,
      title,
      brief,
      repoId: builder.repoId,
      routed,
      fresh: true,
    });
  }

  /**
   * The live review task of a builder, if one is open (delivery rigor phase
   * 2). A repair assessment (FI3-663) is not its review.
   */
  private openReviewOf(builderId: string): TaskRecord | undefined {
    return this.options.tasks
      .listLive()
      .find(
        (record) =>
          record.shape?.kind === "review" &&
          !isRepairAssessment(record.shape) &&
          record.parentId === builderId,
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
    if (builder.delivery?.reviewCapAt !== undefined) return undefined;
    const open = this.openReviewOf(builder.id);
    if (!open || this.options.tasks.verdictReviewOf(builder)?.id !== open.id) return undefined;
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
    const facts = await this.reviewFacts(builder);
    this.options.tasks.recordDelivery(review.id, {
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
      this.options.tasks.recordDelivery(
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

  /**
   * A repair its crewmate declared unknown gets one independent assessment
   * (FI3-663; FI3-304's guard = builder: "uncertainty receives an
   * independent bounded assessment"). The kept merge calls this whenever it
   * reads the undecided repair - at the builder's idle boundary, on the
   * tick and at boot - so the assessment starts once the builder's turn is
   * over, and only once per repair. One still working is left to answer
   * within its bound; one that stopped without answering, ran past the
   * bound, or could not start ends the approval, so the merge never waits
   * on it forever and never runs on an unknown.
   */
  private assessRepair(builderId: string): void {
    const builder = this.options.tasks.get(builderId);
    const authorization = standingAuthorization(builder?.delivery);
    const undecided = authorization?.undecided;
    if (!builder || !authorization || !undecided || TaskService.isClosed(builder)) return;
    const open = undecided.assessment;
    if (open) {
      const assessor = this.options.tasks.get(open.taskId);
      const live = assessor !== undefined && !TaskService.isClosed(assessor);
      if (live && this.now() - open.at <= ASSESSMENT_BOUND_MS) return;
      this.repairDecided(builderId, open.taskId, "failed");
      if (live) void this.retireAssessments(builderId, "it ran past its time");
      return;
    }
    // One still reading a repair the crewmate has since replaced answers nothing.
    void this.retireAssessments(builderId, "a newer repair replaced the one it read");
    const assessorId = randomUUID().slice(0, 8);
    // Recorded before it exists, so a second read finds it and starts none,
    // and one that cannot be made ends the approval like one that cannot finish.
    this.options.tasks.recordDelivery(builder.id, {
      mergeAuthorization: {
        ...authorization,
        undecided: { ...undecided, assessment: { taskId: assessorId, at: this.now() } },
      },
    });
    const title = `Assess repair: ${builder.title}`.slice(0, 64);
    let brief: string;
    let routed: RouteResult | undefined;
    try {
      const delivery = builder.delivery;
      brief = renderRepairAssessmentBrief({
        builderTitle: builder.title,
        change: `${delivery?.changeLabel ?? `#${authorization.target.prNumber}`}${
          delivery?.prUrl ? ` ${delivery.prUrl}` : ""
        }`,
        ...(builder.intent?.userWords ? { userWords: builder.intent.userWords } : {}),
        approvedHead: authorization.approvedHead,
        fromHead: undecided.fromHead,
        toHead: undecided.toHead,
        newBase: undecided.newBase,
        paths: undecided.paths ?? { approved: [], repaired: undecided.changedPaths },
        evidence: undecided.evidence,
        validation: undecided.validation,
      });
      // The host establishes the kind, the way it does a review's: never
      // classified, its basis the builder, delivery machinery under it.
      const shape = this.withBasisVerdict({
        kind: "review",
        kind_source: REPAIR_ASSESSMENT_SOURCE,
        basis: builder.id,
      });
      // Independent: the ladder prefers a provider other than the builder's.
      const avoidProvider = this.options.router?.servedProvider(builder.id);
      routed = this.options.router?.decide(
        assessorId,
        brief,
        shape,
        avoidProvider ? { avoidProvider } : {},
      );
      this.options.tasks.create({
        id: assessorId,
        kind: "work",
        title,
        prompt: brief,
        intent: {
          goal: `Assess whether bringing "${builder.title}" up to date kept the approved change.`,
          userWords: builder.intent?.userWords ?? "",
          constraints: [],
        },
        repoId: builder.repoId,
        difficulty: routed?.bucket ?? tierFor(shape).bucket ?? null,
        shape,
        status: "active",
        parentId: builder.id,
        actor: "host",
      });
    } catch (caught) {
      console.warn("[crew] a repair assessment could not be made:", caught);
      this.repairDecided(builderId, assessorId, "failed");
      return;
    }
    this.options.tasks.note(
      builder.id,
      `An independent assessment of the repair to ${undecided.toHead} started: ${title}.`,
      { news: true, data: { repairAssessment: assessorId } },
    );
    void this.startTask({
      taskId: assessorId,
      title,
      brief,
      repoId: builder.repoId,
      routed,
      fresh: true,
    }).catch((caught: unknown) => {
      console.warn("[crew] a repair assessment could not start:", caught);
      this.repairDecided(builderId, assessorId, "failed");
    });
  }

  /**
   * The host's own task for a project folder a merge could not bring up to
   * date (INF-549, the captain's approved plan): filed under the project and
   * started like any queued task whose wait ended, working in place with a
   * brief filled from the facts. One stands per project: a later refusal
   * while it stands updates its facts and files nothing new. Answers the
   * task, and whether it was filed now.
   */
  fileFolderRepair(
    merged: TaskRecord,
    refusal: FolderRefreshRefusal & { reach?: string },
  ): { record: TaskRecord; filed: boolean } | undefined {
    const repo = merged.repoId ? this.options.repos.get(merged.repoId) : undefined;
    if (!repo) return undefined;
    const facts: InPlaceFacts = {
      cause: refusal.cause,
      ...(refusal.branch ? { branch: refusal.branch } : {}),
      ...(refusal.reach ? { reach: refusal.reach } : {}),
      ...(refusal.remote ? { remote: refusal.remote } : {}),
      ...(merged.key ? { after: merged.key } : {}),
    };
    return this.fileRepairFor(
      repo,
      facts,
      `Another merge, ${merged.key || merged.id}, could not bring the folder up to date either: ${folderRefreshWords(facts.cause)}. The folder must now reach ${facts.reach ?? `origin's ${facts.branch ?? "default branch"}`}.`,
    );
  }

  /**
   * Work that needs a project's folder found it missing (INF-572, the
   * captain's approved plan): a task starting on this computer, a branch
   * coming home, or a merge into the folder. The repair that brings it back
   * is filed, or the standing one named, and the words refusing that work
   * return, naming the folder and the repair.
   */
  folderMissing(repoId: string, noticed: FolderNoticed, by?: TaskRecord): string {
    const repo = this.options.repos.get(repoId);
    if (!repo) return "The project's folder is missing.";
    let repair: { record: TaskRecord; filed: boolean } | undefined;
    try {
      repair = this.fileRepairFor(
        repo,
        { cause: "missing", noticed, ...(by?.key ? { after: by.key } : {}) },
        `The folder ${repo.path} is now missing: bring it back instead. Find out why it is missing, and clone it again into the same path only if it was deleted; otherwise ask the captain on a card.`,
      );
    } catch (caught) {
      console.warn("[crew] the folder repair could not be filed:", caught);
    }
    return folderMissingText(
      repo.path,
      noticed,
      repair ? { key: repair.record.key || repair.record.id, filed: repair.filed } : undefined,
    );
  }

  /**
   * The check at each app start, on the computer that keeps the record
   * (INF-572, the captain's answers): every project with an address where it
   * lives is read once, in the background. A missing folder waits until work
   * needs it; a folder on another branch or on none is left alone; one that
   * is behind and clean on its default branch is brought up to date, with
   * one Activity line; one behind with edits or its own commits gets the
   * repair, unless the captain closed one for that same version of where
   * the project lives. A read that fails changes nothing.
   */
  async checkFoldersAtStart(): Promise<void> {
    if (typeof this.options.workspace.refreshAtStart !== "function") return;
    for (const repo of this.options.repos.list()) {
      if (repo.kind !== "project" || !repo.origin) continue;
      try {
        const reading = await this.options.workspace.refreshAtStart(repo.path);
        if (reading.outcome === "refreshed") {
          this.options.broadcastEvent({
            type: "firstmate_note",
            text: `The folder of ${repo.name} was behind where the project lives; Infinitary brought its ${reading.branch} up to date.`,
          });
          continue;
        }
        if (reading.outcome !== "refused") continue;
        const { refusal } = reading;
        if (this.repairClosedAt(repo.id, refusal.remote)) continue;
        this.fileRepairFor(
          repo,
          {
            cause: refusal.cause,
            noticed: "app-start",
            ...(refusal.branch ? { branch: refusal.branch } : {}),
            ...(refusal.remote ? { remote: refusal.remote } : {}),
          },
          `At the app's start the folder was still behind where the project lives: ${folderRefreshWords(refusal.cause)}.`,
        );
      } catch (caught) {
        console.warn(`[crew] reading the folder of ${repo.name} at start:`, caught);
      }
    }
  }

  /**
   * Whether the captain closed this project's latest folder repair while
   * where the project lives stood at `remote` (INF-572, the captain's answer 4): the
   * start check files it again only once that has moved on.
   */
  private repairClosedAt(repoId: string, remote: string | undefined): boolean {
    if (!remote) return false;
    const last = this.options.tasks
      .list()
      .filter((row) => row.repoId === repoId && isFolderRepair(row.shape?.in_place))
      .filter((row) => row.status === "dropped")
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[0]?.shape?.in_place;
    return isFolderRepair(last) && (last.remote === remote || last.reach === remote);
  }

  /**
   * Files a project's folder repair, or updates the one standing with the
   * newer facts and tells its crewmate `update`. A folder found missing
   * again while its repair already knows tells nobody anything new.
   */
  private fileRepairFor(
    repo: RepoView,
    facts: InPlaceFacts,
    update: string,
  ): { record: TaskRecord; filed: boolean } | undefined {
    const standing = [...this.options.tasks.listOpen(), ...this.options.tasks.listActive()].find(
      (row) => row.repoId === repo.id && isFolderRepair(row.shape?.in_place),
    );
    if (standing) {
      const prior = standing.shape?.in_place;
      if (isFolderRepair(prior) && prior.cause === "missing" && facts.cause === "missing") {
        return { record: standing, filed: false };
      }
      const kept =
        isFolderRepair(prior) && prior.started_in ? { started_in: prior.started_in } : {};
      this.options.tasks.recordShape(
        standing.id,
        { in_place: { ...facts, ...kept } },
        standing.difficulty,
      );
      this.options.tasks.note(standing.id, update, { news: true });
      if (this.tasks.has(standing.id)) {
        void this.steerInternal(standing.id, update, {
          actor: "supervisor",
          via: "supervision",
          decision: null,
          cardId: null,
        }).catch(() => {});
      }
      const record = this.options.tasks.get(standing.id);
      return record ? { record, filed: false } : undefined;
    }
    const shape: WorkShape = {
      kind: "chore",
      kind_source: `${KIND_SOURCE.skipped}in-place`,
      deliverable: "change",
      in_place: facts,
    };
    const goal =
      facts.cause === "missing"
        ? `Bring back the folder of ${repo.name}, which is missing.`
        : facts.reach
          ? `Bring the folder of ${repo.name} up to date with the merged version.`
          : `Bring the folder of ${repo.name} up to date with where the project lives.`;
    const record = this.options.tasks.create({
      id: randomUUID().slice(0, 8),
      kind: "work",
      title: FOLDER_REPAIR_TITLE,
      goal,
      prompt: this.folderRepairBrief(repo, facts),
      repoId: repo.id,
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      startPolicy: "when-ready",
      status: "open",
      actor: "host",
    });
    this.broadcastCrewCounts();
    // It starts on this very sweep, the way a when-ready plan does.
    void this.sweepGates(this.now());
    return { record, filed: true };
  }

  /** A folder repair's brief, rendered from its facts and its project as they stand now. */
  private folderRepairBrief(
    repo: Pick<RepoView, "name" | "path" | "origin">,
    facts: InPlaceFacts,
  ): string {
    const workdir =
      facts.started_in ?? (existsSync(repo.path) ? undefined : nearestFolderAbove(repo.path));
    return renderFolderRepairBrief({
      ...facts,
      project: repo.name,
      folder: repo.path,
      origin: repo.origin,
      ...(workdir ? { workdir } : {}),
    });
  }

  /**
   * Where a task that works in place runs: its project's folder, or, for a
   * folder repair that found it missing, the folder above it that exists,
   * kept on the record so a resume opens there again (INF-572).
   */
  private inPlaceDir(taskId: string, folder: string): string {
    const record = this.options.tasks.get(taskId);
    const facts = record?.shape?.in_place;
    if (!record || !isFolderRepair(facts)) return folder;
    if (facts.started_in) return facts.started_in;
    if (existsSync(folder)) return folder;
    const started_in = nearestFolderAbove(folder);
    this.options.tasks.recordShape(
      taskId,
      { in_place: { ...facts, started_in } },
      record.difficulty,
    );
    return started_in;
  }

  /**
   * The host's own task for a pull request an abandoned task could not
   * close (INF-549's sibling, the captain's "close the pull request or
   * report why not"): filed under the project and started like the folder
   * repair, working in place with a brief filled from the facts. One stands
   * per pull request. Answers the task, and whether it was filed now.
   */
  filePullRepair(
    abandoned: TaskRecord,
    problem: string | undefined,
  ): { record: TaskRecord; filed: boolean } | undefined {
    const repo = abandoned.repoId ? this.options.repos.get(abandoned.repoId) : undefined;
    const number = abandoned.delivery?.prNumber;
    if (!repo || number === undefined) return undefined;
    const standing = [...this.options.tasks.listOpen(), ...this.options.tasks.listActive()].find(
      (row) => {
        const facts = row.shape?.in_place;
        return row.repoId === repo.id && isPullRepair(facts) && facts.pull.number === number;
      },
    );
    if (standing) return { record: standing, filed: false };
    const label = abandoned.delivery?.changeLabel ?? `#${number}`;
    const facts: InPlacePull = {
      pull: {
        number,
        label,
        ...(abandoned.delivery?.prUrl ? { url: abandoned.delivery.prUrl } : {}),
        ...(abandoned.branch ? { branch: abandoned.branch } : {}),
        ...(problem ? { problem } : {}),
      },
      ...(abandoned.key ? { after: abandoned.key } : {}),
      after_id: abandoned.id,
    };
    const shape: WorkShape = {
      kind: "chore",
      kind_source: `${KIND_SOURCE.skipped}in-place`,
      deliverable: "change",
      in_place: facts,
    };
    const record = this.options.tasks.create({
      id: randomUUID().slice(0, 8),
      kind: "work",
      title: PULL_REPAIR_TITLE,
      goal: `Close the pull request ${label} of ${repo.name}, which ${abandoned.key || abandoned.id} left open, or report why it cannot be closed.`,
      prompt: renderPullRepairBrief({ ...facts, project: repo.name, folder: repo.path }),
      repoId: repo.id,
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      startPolicy: "when-ready",
      status: "open",
      actor: "host",
    });
    this.broadcastCrewCounts();
    void this.sweepGates(this.now());
    return { record, filed: true };
  }

  /**
   * The closing half of a task that works in place (INF-549): it closes as
   * settled, with a feed line, once the host reads what it was for done - a
   * folder clean, on the default branch and at or past the merged version,
   * or a pull request closed where the project lives. A crewmate mid-turn,
   * or a card of the task's still up, keeps it open.
   */
  async closeCurrentFolders(): Promise<void> {
    const live = [...this.options.tasks.listOpen(), ...this.options.tasks.listActive()];
    for (const record of live) {
      const facts = record.shape?.in_place;
      const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
      if (!facts || isFolderWork(facts) || !repo || this.closingFolders.has(record.id)) continue;
      if (isPullRepair(facts) && !this.options.readPull) continue;
      const state = this.tasks.get(record.id)?.state;
      if (state !== undefined && state !== "idle") continue;
      if (this.cards.snapshot().some((card) => card.taskId === record.id)) continue;
      this.closingFolders.add(record.id);
      try {
        const line = await this.inPlaceDone(facts, repo.path);
        if (!line) continue;
        const now = this.options.tasks.get(record.id);
        if (!now || TaskService.isClosed(now)) continue;
        const after = this.tasks.get(record.id)?.state;
        if (after !== undefined && after !== "idle") continue;
        this.options.tasks.note(record.id, line, {
          news: true,
          feed: true,
          data: { feedLine: true },
        });
        await this.settle.closeTask(record.id, {
          status: "done",
          reason: "finished",
          actor: "host",
          text: isPullRepair(facts) ? "the pull request is closed" : "the folder is up to date",
          feed: false,
        });
      } finally {
        this.closingFolders.delete(record.id);
      }
    }
  }

  /**
   * What an in-place task was for, read without changing anything: the
   * Activity line saying it is done, or undefined while it is not, or when
   * it cannot be read.
   */
  private async inPlaceDone(
    facts: InPlaceFacts | InPlacePull,
    folder: string,
  ): Promise<string | undefined> {
    if (isPullRepair(facts)) {
      const pull = await this.options
        .readPull?.(facts.after_id, facts.pull.number)
        .catch(() => undefined);
      if (pull?.state !== "closed") return undefined;
      return `The pull request ${facts.pull.label} is ${pull.merged ? "merged" : "closed"} where the project lives.`;
    }
    // A repair that never read a default branch - the folder was missing,
    // or named none - reads it from the folder as it stands now (INF-572).
    const branch =
      facts.branch ??
      (typeof this.options.workspace.folderDefaultBranch === "function"
        ? await this.options.workspace.folderDefaultBranch(folder).catch(() => "")
        : "");
    if (!branch) return undefined;
    const current = await this.options.workspace
      .folderCurrent(folder, branch, facts.reach)
      .catch(() => false);
    if (!current) return undefined;
    if (facts.cause === "missing") {
      return `The project's folder is back: clean, on ${branch} and level with origin's ${branch}.`;
    }
    return `The project's folder is up to date: clean, on ${branch} and at or past ${facts.reach ? facts.reach.slice(0, 7) : `origin's ${branch}`}.`;
  }

  /**
   * An independent assessment's verdict on its builder's undecided repair
   * (FI3-663). Accepted, the kept merge runs again under every gate; any
   * other verdict ended the approval with a hold, and the builder is told
   * so once, to put up a new completion card - the captain decides again.
   */
  private repairDecided(
    builderId: string,
    assessorId: string,
    verdict: NonNullable<MergeRepairAssessment["verdict"]>,
    excerpt?: string,
  ): void {
    const decided = decideMergeRepair(
      this.options.tasks,
      builderId,
      assessorId,
      verdict,
      this.now(),
    );
    if (decided.decided === "accepted") {
      void this.settle.runMergeAuthorization(builderId).catch((caught: unknown) => {
        console.warn("[crew] kept merge could not run:", caught);
      });
      return;
    }
    if (decided.decided !== "ended" || verdict === "none") return;
    const wake: TypedWake = {
      facts: {
        kind: "repair-assessed",
        head: decided.head,
        verdict,
        ...(excerpt ? { excerpt } : {}),
      },
      once: `repair-assessed:${assessorId}`,
    };
    void this.steerInternal(builderId, wake, {
      actor: "supervisor",
      via: "supervision",
      decision: null,
      cardId: null,
    }).catch((caught: unknown) => {
      // The record and the feed already say the approval ended.
      console.warn("[crew] the repair assessment's steer was not delivered:", caught);
    });
  }

  /** Stop a builder's live repair assessments, silently: their verdict would answer nothing. */
  private async retireAssessments(builderId: string, why: string): Promise<void> {
    const live = this.options.tasks
      .children(builderId)
      .filter((child) => !TaskService.isClosed(child) && isRepairAssessment(child.shape));
    for (const child of live) {
      await this.settle
        .closeTask(child.id, {
          status: "dropped",
          reason: "superseded",
          actor: "host",
          text: `superseded - ${why}`,
          feed: false,
        })
        .catch(() => {});
    }
  }

  /**
   * An independent repair assessment reported (FI3-663): its first line is
   * its verdict, and its first report is its only one - the host records
   * the verdict on the builder's approval, then closes the assessment.
   */
  private async settleRepairAssessment(task: TaskRuntime, report: string): Promise<void> {
    const builderId = this.options.tasks.get(task.id)?.parentId;
    const verdict = parseRepairAssessment(report);
    if (builderId) {
      this.repairDecided(builderId, task.id, verdict, capWithOverflow(report, "task-report"));
    }
    await this.settle
      .closeTask(task.id, {
        status: "done",
        reason: "finished",
        actor: "host",
        text: `assessed the repair: ${verdict}`,
        feed: false,
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (this.options.tasks.get(task.id)) {
          this.options.tasks.note(task.id, `could not close the assessment: ${message}`, {
            news: true,
            data: { closeFailed: message },
          });
        }
      });
  }

  /**
   * Whether a task's events skip supervision (delivery rigor phase 2): a
   * task shipping at the reviewed tier, or a review task itself.
   */
  private bypassesSupervision(taskId: string): boolean {
    const shape = this.options.tasks.get(taskId)?.shape;
    return (
      this.policiesOf(this.options.tasks.get(taskId))?.rigor.value === "reviewed" ||
      shape?.kind === "review"
    );
  }

  /**
   * Where a task stands with its independent review, for crew_status and
   * the context block: the reviewer's own row names the builder; a reviewed
   * builder is awaiting a review, has one open, has a verdict short of a
   * pass, or has passed.
   */
  private reviewState(record: TaskRecord): string | undefined {
    const shape = record.shape;
    if (shape?.kind === "review" && record.parentId) {
      const builder = this.options.tasks.get(record.parentId);
      return isRepairAssessment(shape)
        ? `assesses ${builder?.key || record.parentId}'s repair`
        : `reviews ${builder?.key || record.parentId}`;
    }
    if (this.policiesOf(record)?.rigor.value !== "reviewed") return undefined;
    const verdict = record.delivery?.reviewVerdict;
    if (verdict === "pass") return "review passed";
    // The review cap (phase 3) outranks the open review: the reviewer may
    // still be idle on the task, but no re-review goes out until the
    // decision the cap asked for is answered.
    if (record.delivery?.reviewCapAt !== undefined)
      return record.delivery.reviewCapOwner === "firstmate"
        ? "review: findings (first mate can reopen)"
        : "review: findings (cap reached)";
    const open = this.openReviewOf(record.id);
    if (open) return `review open (${open.key || open.id})`;
    if (verdict) return `review: ${verdict}`;
    return "awaiting review";
  }

  /** The CI round cap was reached (delivery rigor phase 3): the gate and the one wake (idleLadder.ts). */
  holdForCiCap(taskId: string, facts: { rounds: number; headSha: string }): void {
    this.ladder.holdForCiCap(taskId, facts);
  }

  /** The personal workspace as a repo (Step 4), or a loud refusal when this build has none. */
  private personalRepo(): RepoView {
    const personal = this.options.personal;
    if (!personal) {
      throw new Error("Personal panels are not available in this build; nothing was started.");
    }
    return personal.repo();
  }

  /** The personal brief's workspace facts (Step 4): the directory and the surfaces that exist. */
  private personalFacts(kind?: WorkShape["kind"]): PersonalBriefFacts | undefined {
    const personal = this.options.personal;
    if (!personal) return undefined;
    return { workspaceDir: personal.workspaceDir, surfaces: personal.surfaces(), kind };
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

  /**
   * Record work (create_task, design section 7): an open row that waits
   * on request by default, or dispatches with the ready
   * sweep when its policy is when-ready and nothing blocks or holds it. A
   * pure container (a parent with no crewmate of its own) is exactly this.
   * The row carries a shape the way a queued spawn does, so it dispatches
   * from what it was planned with: a basis named here is usually still
   * running, and its verdict is derived again when the row dispatches.
   */
  plan(input: {
    title: string;
    intent: SpawnIntent;
    repoId?: string;
    parent?: string;
    blockedBy?: string[];
    startPolicy?: TaskStartPolicy;
    priority?: number;
    shape?: WorkShapeAsk;
  }): TaskRecord {
    const placement = this.resolveGraphPlacement(input);
    const brief = renderIntentBrief(
      input.intent,
      placement.folder ? undefined : placement.delivery,
      undefined,
      placement.folder,
    );
    const taskId = randomUUID().slice(0, 8);
    const title = (input.title.trim() || input.intent.goal || "Task").slice(0, 64);
    const handOff = this.handOffShape(input.shape, placement.repoId);
    if ("refused" in handOff) throw new TaskGraphRefusal(`Nothing was filed. ${handOff.refused}`);
    const program = input.shape?.program
      ? this.programShape(input.shape, placement.repoId, placement.personal)
      : undefined;
    if (typeof program === "string") throw new TaskGraphRefusal(`Nothing was filed. ${program}`);
    const shape = this.withDeliverable(
      { ...this.workShape(input.shape), ...handOff, ...(program ? { program } : {}) },
      input.intent,
    );
    const record = this.options.tasks.create({
      id: taskId,
      kind: "work",
      title,
      prompt: brief,
      intent: input.intent,
      repoId: placement.repoId,
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      ...(placement.parentId ? { parentId: placement.parentId } : {}),
      ...(placement.blockedBy.length > 0 ? { blockedBy: placement.blockedBy } : {}),
      startPolicy: input.startPolicy ?? "on-request",
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      status: "open",
    });
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Planned "${title}" (${record.key}) - ${this.waitingText(record)}.`,
    });
    this.broadcastCrewCounts();
    // A when-ready plan with nothing in its way starts on this very sweep.
    void this.sweepGates(this.now());
    return record;
  }

  /** How an open row waits, phrased for the feed and the crew status. */
  private waitingText(record: TaskRecord): string {
    if (record.gate) return gateText(record.gate);
    const waiting = this.options.tasks.waitingOn(record.id);
    if (waiting.length > 0) return blockedText(waiting);
    return record.startPolicy === "on-request" ? "starts on request" : "starts now";
  }

  /**
   * The graph placement a spawn or plan asks for: the repo (fail-loud on an
   * unknown id), the parent (inherits the repo when none was named), and
   * the blockers - ids or keys, each resolved against the record.
   */
  private resolveGraphPlacement(input: {
    repoId?: string;
    parent?: string;
    blockedBy?: string[];
    intent?: SpawnIntent;
    shape?: WorkShapeAsk;
  }): {
    repoId: string | null;
    delivery: RepoDelivery;
    /** The bound repository is the personal workspace: it builds in place. */
    personal: boolean;
    /** The project and folder declared folder work works in (INF-567). */
    folder?: FolderBriefFacts;
    parentId: string | undefined;
    blockedBy: string[];
  } {
    const parent = input.parent?.trim() ? this.resolveTaskRef(input.parent, "parent") : undefined;
    let repoId: string | null = parent?.repoId ?? null;
    if (input.repoId) {
      const repo = this.options.repos.get(input.repoId);
      if (!repo) {
        throw new Error(
          `Unknown repo_id "${input.repoId}". Use a repo_id from the context block, or omit it for the default workspace.`,
        );
      }
      repoId = repo.id;
    }
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    const folder = input.shape?.in_folder ? this.folderWorkOf(repo, input.shape) : undefined;
    const delivery = this.resolveSpawnDelivery(repo, input.intent, input.shape);
    const blockedBy = [
      ...new Set((input.blockedBy ?? []).map((ref) => this.resolveTaskRef(ref, "blocked_by").id)),
    ];
    return {
      repoId,
      delivery,
      personal: repo?.kind === "personal",
      ...(folder ? { folder } : {}),
      parentId: parent?.id,
      blockedBy,
    };
  }

  /**
   * The project and folder a task declared as folder work works in
   * (INF-567): a registered project of the captain's, never the personal
   * workspace, which builds in place already. The folder decides where it
   * runs and that it ships nothing, so a Runs on, a delivery or a review
   * named beside it is refused.
   */
  private folderWorkOf(repo: RepoView | undefined, ask: WorkShapeAsk): FolderBriefFacts {
    if (!repo) {
      throw new Error(
        `${NOTHING_SPAWNED} in_folder needs a project: pass the repo_id of the project whose folder the task works in.`,
      );
    }
    if (repo.kind === "personal") {
      throw new Error(
        `${NOTHING_SPAWNED} The personal workspace already builds in place; omit in_folder.`,
      );
    }
    const clash = ask.runs_on_ask?.trim()
      ? "runs_on_ask"
      : ask.delivery_ask
        ? "delivery_ask"
        : ask.review_of?.trim()
          ? "review_of"
          : undefined;
    if (clash) {
      throw new Error(
        `${NOTHING_SPAWNED} Folder work runs on the computer keeping ${repo.name}'s folder and ships nothing; omit ${clash}.`,
      );
    }
    return { project: repo.name, folder: repo.path };
  }

  /**
   * The posture this spawn ships at: the captain's ask for this task, else
   * the repository's default. The personal workspace takes neither - it
   * builds in place - so its tasks carry the local-only nobody reads.
   */
  private resolveSpawnDelivery(
    repo: RepoView | undefined,
    intent: SpawnIntent | undefined,
    shape: WorkShapeAsk | undefined,
  ): RepoDelivery {
    const personal = repo?.kind === "personal" || intent?.kind === "personal-ui";
    const ask = shape?.delivery_ask;
    if (ask === "direct-pr" && !personal) {
      if (!repo) {
        throw new Error(
          'delivery_ask "direct-pr" needs a managed repository to open a PR on. Omit it for the default workspace, or pass repo_id.',
        );
      }
      if (!repo.origin) {
        throw new Error(
          `delivery_ask "direct-pr" needs a remote to open a PR on; ${repo.name} has none. Configure a remote, or omit delivery_ask to stay local-only.`,
        );
      }
    }
    if (personal) return "local-only";
    return deliveryFor({ repo: repo?.delivery, ask }).delivery;
  }

  /**
   * The escalation an `escalate_from` asks for (S4, report section 4).
   * Every check that can refuse runs here, before a row exists, and every
   * refusal is a loud tool error the Firstmate reads in conversation:
   *
   * - the named task must exist and be crewmate work;
   * - it must really have run (Q1's "never on first dispatch"): a row that
   *   never started produced no result for the captain to reject;
   * - the lineage may spend `maxEscalations` rungs, and nothing sits above
   *   premium - both refusals come from the policy, not from here.
   */
  private resolveEscalation(
    ref: string | undefined,
    premiumAsk = false,
  ): EscalationPlan | undefined {
    const named = ref?.trim();
    if (!named) return undefined;
    const previous = this.resolveTaskRef(named, "escalate_from");
    const handle = previous.key || previous.id;
    if (previous.kind !== "work") {
      throw new Error(
        `${handle} is not crewmate work, so there is no attempt to escalate. Name the task whose result the captain rejected.`,
      );
    }
    if (!previous.startedAt && !previous.outcome) {
      throw new Error(
        `${handle} has never run, so there is no result to reject. Escalation is for an attempt the captain has seen; start it, or spawn the work plainly.`,
      );
    }
    const attempt = (previous.shape?.escalation?.attempt ?? 0) + 1;
    // A row that never routed (dynamic routing off, or a pre-S2 record)
    // is read at the engine's own default so the ladder still has a rung
    // to climb from.
    const floor = escalationFloor(previous.difficulty ?? "medium", attempt);
    if ("refused" in floor) {
      throw new Error(
        `Cannot escalate ${handle}: ${floor.refused}. Ask the captain which model to try instead and pass it as override_model_id. ${softHoldWords("escalation", "firstmate")}`,
      );
    }
    // R1a outranks R1b: the captain's premium click still spends a bounded
    // escalation, but its brief, record and feed name the tier it serves.
    const servedFloor = premiumAsk ? "premium" : floor.floor;
    return {
      previous,
      stamp: { from: handle, attempt: floor.attempt, floor: servedFloor },
      facts: {
        attempt: floor.attempt,
        previousKey: handle,
        tier: servedFloor,
        ...(previous.model ? { previousModel: previous.model } : {}),
        ...(previous.outcome ? { previousOutcome: previous.outcome } : {}),
        // The attempt's worktree and branch go when it is superseded; what
        // it did is saved on its kept ref first (`supersedeAttempt`).
        ...(previous.worktreeDir && previous.workspaceState === "present"
          ? { previousWork: keptRefFor(previous.id) }
          : {}),
      },
    };
  }

  /**
   * The escalation, once the fresh row exists (report section 4 steps 4-6):
   * the lineage edge, the rejected attempt stopped and closed superseded
   * with its branch kept, and the two `escalated` timeline rows - of which
   * the rejected attempt's is the move's one feed line. Nothing here is a
   * card: the now panel simply shows the new row underway and the old one
   * gone, which is the captain's own principle for finished work.
   */
  private async applyEscalation(plan: EscalationPlan, freshId: string): Promise<void> {
    const fresh = this.options.tasks.get(freshId);
    if (!fresh) return;
    // The captain's chosen link: provenance only. A discovered-from edge
    // gates no readiness and holds no close, so the fresh attempt starts
    // although its origin is still being closed below.
    this.options.tasks.link(fresh.id, plan.previous.id, "discovered-from", "captain");
    this.options.tasks.recordEscalation({
      from: { id: plan.previous.id, key: plan.previous.key || plan.previous.id },
      to: { id: fresh.id, key: fresh.key || fresh.id },
      attempt: plan.stamp.attempt,
      tier: plan.stamp.floor,
    });
    await this.supersedeAttempt(plan.previous.id, fresh.key || fresh.id);
  }

  /**
   * Retire the attempt the captain rejected (O1: "Close it
   * dropped/superseded"). A running turn is interrupted the way a close
   * interrupts one; the record closes dropped with `escalated_to`, its
   * lane and cards go with it; and the worktree retires like every closed
   * task's (2026-09-22), its work always saved on the kept ref the fresh
   * attempt's brief names.
   *
   * The close's own feed line is suppressed: the `escalated` line already
   * says this row was replaced and names its successor.
   */
  private async supersedeAttempt(taskId: string, continuesAs: string): Promise<void> {
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    this.options.killJobs?.(taskId);
    this.options.personal?.endLiveTask(taskId);
    const runtime = this.tasks.get(taskId);
    if (runtime) {
      runtime.cancelled = true;
      await runtime.session?.abort().catch(() => {});
      this.releaseSession(runtime);
      this.tasks.delete(taskId);
      this.settle.releaseSettleBoundary(taskId);
    }
    this.recordInterrupt(
      taskId,
      "interrupt",
      { actor: "captain", via: "tool", decision: null },
      runtime ? "aborted-turn" : "no-turn",
    );
    if (record.status !== "done" && record.status !== "dropped") {
      this.settle.closeAndPurge([taskId], () =>
        this.options.tasks.close(taskId, {
          status: "dropped",
          reason: "superseded",
          actor: "captain",
          feed: false,
          data: { escalated_to: continuesAs },
        }),
      );
      await this.settle.closeOpenPullRequest(taskId);
    } else {
      this.options.inbox.purgeTask(taskId);
    }
    this.cards.retireTaskCards(taskId, "superseded");
    this.cards.scheduleBroadcast();
    this.broadcastCrewCounts();
    await this.settle.retireDeliveryChildren(taskId, record.title);
    await this.settle.retireWorkspace(taskId, { keepAlways: true });
    void this.sweepGates(this.now());
  }

  /**
   * The shape the tier is computed from (S2). The Firstmate supplies the
   * facts only it can see; the host adds the two it must not be trusted
   * for:
   *
   * - the KIND, which a classifier establishes (S3). Until then every
   *   shape is `unclear`, which R8 routes high - the captain's own call
   *   (Q5 A) that an unknown piece of work is worth the stronger model.
   * - the BASIS verdict. A named basis buys a cheaper tier only when it
   *   resolves to a real task that is done or has reported something; an
   *   unnamed, unknown or still-running basis reads unverified and is
   *   treated as absent, so a claimed spec can never talk the router down
   *   on its own. The verdict rides the shape to the router and is derived
   *   again at every read; the record never stores it.
   */
  private workShape(ask: WorkShapeAsk | undefined, escalation?: EscalationPlan): WorkShape {
    const basis = ask?.basis?.trim();
    if (escalation) {
      // An escalation is the SAME work at a higher tier (S4): the kind and
      // the basis are inherited rather than re-established, because nothing
      // about the work changed - only the model that will attempt it. So
      // `classifyShape` skips the call and stamps `skipped:escalation` over
      // the placeholder below; the inherited kind's own provenance, and the
      // confidence its classification carried, stay on the row the lineage
      // edge points at rather than being restated here as if this row had
      // measured them. The previous row's `premium_ask` is deliberately NOT
      // inherited either: R1a outranks R1b, so a stale ask would decide this
      // attempt's tier in place of the ladder. A premium ask the captain
      // repeats in the rejection arrives on this spawn as its own fact.
      const inherited = escalation.previous.shape;
      const basisRef = basis ?? inherited?.basis;
      const deliveryAsk = ask?.delivery_ask ?? inherited?.delivery_ask;
      // The captain's word on who merges this work is a property of the
      // work, not of the attempt that failed, so it rides the lineage the
      // way the posture does.
      const autonomyAsk = ask?.autonomy_ask ?? inherited?.autonomy_ask;
      // So is the captain's word on where it runs (docs/helper.md, "A
      // task's own Runs on").
      const runsOnAsk = ask?.runs_on_ask ?? inherited?.runs_on_ask;
      // Whether the work is one of the Firstmate's own steps does not change
      // with the attempt either.
      const internalStep = ask?.internal_step ?? inherited?.internal_step;
      // So does working in the project's folder (INF-567).
      const inFolder = ask?.in_folder || isFolderWork(inherited?.in_place);
      return {
        kind: inherited?.kind ?? "unclear",
        kind_source: "none",
        ...(ask?.premium_ask ? { premium_ask: true as const } : {}),
        ...(ask?.override_model_id ? { override_model_id: ask.override_model_id } : {}),
        ...(ask?.override_speed ? { override_speed: ask.override_speed } : {}),
        ...(ask?.override_reasoning ? { override_reasoning: ask.override_reasoning } : {}),
        ...(basisRef ? { basis: basisRef, basis_verified: this.basisHolds(basisRef) } : {}),
        ...(ask?.rigor_ask ? { rigor_ask: ask.rigor_ask } : {}),
        ...(deliveryAsk ? { delivery_ask: deliveryAsk } : {}),
        ...(autonomyAsk !== undefined ? { autonomy_ask: autonomyAsk } : {}),
        ...(runsOnAsk ? { runs_on_ask: runsOnAsk } : {}),
        ...((ask?.placement_requirements ?? inherited?.placement_requirements)
          ? {
              placement_requirements:
                ask?.placement_requirements ?? inherited?.placement_requirements,
            }
          : {}),
        ...(internalStep ? { internal_step: true } : {}),
        ...(inFolder ? { in_place: { folder: true as const } } : {}),
        ...(ask?.skipped_plan_because ? { skipped_plan_because: ask.skipped_plan_because } : {}),
        escalate_from: escalation.stamp.from,
        escalation: escalation.stamp,
      };
    }
    return {
      kind: "unclear",
      kind_source: "none",
      ...(ask?.premium_ask ? { premium_ask: true as const } : {}),
      ...(ask?.override_model_id ? { override_model_id: ask.override_model_id } : {}),
      ...(ask?.override_speed ? { override_speed: ask.override_speed } : {}),
      ...(ask?.override_reasoning ? { override_reasoning: ask.override_reasoning } : {}),
      ...(basis ? { basis, basis_verified: this.basisHolds(basis) } : {}),
      ...(ask?.rigor_ask ? { rigor_ask: ask.rigor_ask } : {}),
      ...(ask?.delivery_ask ? { delivery_ask: ask.delivery_ask } : {}),
      ...(ask?.autonomy_ask !== undefined ? { autonomy_ask: ask.autonomy_ask } : {}),
      ...(ask?.runs_on_ask?.trim() ? { runs_on_ask: ask.runs_on_ask.trim() } : {}),
      ...(ask?.placement_requirements
        ? { placement_requirements: ask.placement_requirements }
        : {}),
      ...(ask?.internal_step ? { internal_step: true } : {}),
      ...(ask?.in_folder ? { in_place: { folder: true as const } } : {}),
      ...(ask?.skipped_plan_because ? { skipped_plan_because: ask.skipped_plan_because } : {}),
    };
  }

  /**
   * Establish the shape's KIND (S3). Three shapes are never classified,
   * because the table decides them ABOVE the kind and a call could only
   * cost quota without changing the outcome: the captain named a model
   * (R0), the captain asked for premium (R1a), or this is an escalation
   * rung (R1b). Each records WHY it was skipped rather than leaving the
   * stopgap `none`, so the audit row never has to guess.
   *
   * Everything else asks the classifier, which cannot throw: its failures
   * and its abstentions both come back `unclear`, carrying their reason as
   * `kind_source`, and R8 routes them high exactly as S2 did.
   */
  private async classifyShape(
    taskId: string,
    title: string,
    intent: SpawnIntent,
    repoId: string | null,
    shape: WorkShape,
  ): Promise<WorkShape> {
    const skip = shape.override_model_id
      ? "override"
      : shape.premium_ask
        ? "premium-ask"
        : shape.escalation
          ? "escalation"
          : undefined;
    // Attaching the packaged plan step is the host's own line, so the kind
    // is plan even when a named model skips classification (FI3-1371).
    const planned = planStepAttached(intent.constraints);
    const taught = !planned && teachStepAttached(intent.constraints);
    if (skip) {
      return {
        ...shape,
        ...(planned ? { kind: "plan" as const } : taught ? { kind: "teach" as const } : {}),
        kind_source: `${KIND_SOURCE.skipped}${skip}`,
      };
    }
    if (planned) return { ...shape, kind: "plan", kind_source: "host:plan-step" };
    if (taught) return { ...shape, kind: "teach", kind_source: "host:teach-step" };
    // A review's kind is the host's (delivery rigor phase 2), never asked.
    if (shape.kind === "review") return shape;
    const classifier = this.options.classifier;
    if (!classifier) return shape;
    const verdict = await classifier.classify(
      this.classifierInput(taskId, title, intent, repoId, shape),
      AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    );
    return {
      ...shape,
      kind: resolveKind(verdict),
      kind_source: verdict.source,
      ...(verdict.detail ? { kind_detail: verdict.detail } : {}),
    };
  }

  /** The bounded facts the classifier is given: no transcript, no repo map. */
  private classifierInput(
    taskId: string,
    title: string,
    intent: SpawnIntent,
    repoId: string | null,
    shape: WorkShape,
  ): KindInput {
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    const constraints = (intent.constraints ?? [])
      .map((constraint) =>
        constraint.text ? `${constraint.kind}: ${constraint.text}` : constraint.kind,
      )
      .join("; ");
    // Only a VERIFIED basis is shown. An unverified one buys no cheaper
    // tier (R3/R5), so letting it colour the classification would smuggle
    // a claimed spec back in through the other door.
    const basis =
      shape.basis && this.basisHolds(shape.basis)
        ? this.options.tasks.resolve(shape.basis)
        : undefined;
    return {
      taskId,
      title,
      goal: intent.goal,
      userWords: intent.userWords,
      ...(constraints ? { constraints } : {}),
      ...(repo
        ? {
            repoName: repo.name,
            ...(repo.kind === "personal"
              ? {}
              : {
                  delivery: deliveryForRecord({ shape }, repo.delivery),
                }),
          }
        : {}),
      ...(basis
        ? {
            basis: {
              key: basis.key,
              title: basis.title,
              outcomeHead: basis.outcomeSummary ?? basis.outcome ?? "",
            },
          }
        : {}),
    };
  }

  /**
   * Stamp what the work DELIVERS on its shape (Task B). Derived by the host
   * from the two typed facts it already holds - the kind and a `read-only`
   * constraint (`deliverableFor`) - and re-derived wherever the kind moves,
   * so a row queued before the classifier ran is told the deliverable of the
   * moment it starts. A `review` task keeps whatever the derivation says; it
   * is ungated for its kind either way.
   */
  private withDeliverable(shape: WorkShape, intent: SpawnIntent): WorkShape {
    return { ...shape, deliverable: deliverableFor(intent, shape.kind) };
  }

  /** What a record's shape says it delivers; a pre-axis row shipped a change. */
  private deliverableOf(record: TaskRecord | undefined): Deliverable {
    return record?.shape?.deliverable ?? "change";
  }

  /** Whether this task ships nothing: its deliverable is an answer. */
  private isAnswerTask(taskId: string): boolean {
    return this.deliverableOf(this.options.tasks.get(taskId)) === "answer";
  }

  /**
   * The answer a change is built on (Task B, F3 A). A verified basis is a
   * task whose answer the host can hand over verbatim - its report and the
   * card the captain read - so the builder starts from the finding instead
   * of being told to go and repeat it. Nothing here judges: `basisHolds`
   * decides the basis counts, and an unverified one buys neither a cheaper
   * tier nor this section.
   */
  private basisFacts(record: TaskRecord | undefined): BasisBriefFacts | undefined {
    const ref = record?.shape?.basis;
    if (!ref || !this.basisHolds(ref)) return undefined;
    const basis = this.options.tasks.resolve(ref);
    if (!basis || basis.id === record.id) return undefined;
    return this.sourceFacts(basis);
  }

  /** Read a declared source; its existence alone is never approval. */
  private sourceFacts(basis: TaskRecord): BasisBriefFacts {
    const timeline = this.options.tasks.timeline(basis.id);
    const card = this.cards.newestAnswerForTask(basis.id);
    // Only a change's working copy holds its work: an answer task commits
    // nothing and its scratch copy goes with it, so its answer is the report
    // and the card below, never a branch to start from.
    const change = this.deliverableOf(basis) === "change";
    // A branch on another computer is read here only once its work is home,
    // on the kept ref.
    const branch =
      change && basis.workspaceState === "present" && basis.branch && !basis.deviceId
        ? basis.branch
        : undefined;
    const keptRef = change && !branch ? this.keptRefOf(basis.id) : undefined;
    // Each reply reaches the builder with the settings it was sent with, as
    // its author read it then; the thread shows them apart (FI3-617).
    const thread = card
      ? this.cards
          .messages(card.id)
          .filter((message) => message.text.trim())
          .map((message) => ({
            who: message.who,
            text: replyWithSettings(message.text, message.answers),
          }))
      : [];
    // The choice, the answers and the body all come off that one card, so a
    // later card on the task never lends the builder its choice instead.
    const resolution = card ? this.cards.newestResolutionForTask(basis.id, card.id) : undefined;
    const offer = resolution?.offer ?? resolution?.card;
    const choice = offer?.actions.find((entry) => entry.id === resolution?.action)?.label;
    // Current submissions on that card (actions or replies) supersede
    // legacy resolution-only answers, including Firstmate-authored replies.
    const submitted = card
      ? this.options.cardStore
          .observations(card.id)
          .filter(
            (event) =>
              (event.kind === "action" || event.kind === "message_ref") &&
              event.actor === "captain",
          )
          .map((event) =>
            cardAnswersSchema.safeParse((event.payload as { answers?: unknown }).answers),
          )
          .filter((parsed) => parsed.success)
          .at(-1)
      : undefined;
    const latest = submitted?.success ? submitted.data : resolution?.answers;
    const answers = latest ? cardAnswerLines(latest) : undefined;
    const rawBody = offer?.body ?? card?.body;
    const cardBody = rawBody
      ? cardPictureFiles(rawBody, this.options.paths.crewmatesDir)
      : undefined;
    return {
      key: basis.key || basis.id,
      taskId: basis.id,
      title: basis.title,
      ...(basis.intent?.userWords ? { userWords: basis.intent.userWords } : {}),
      ...(basis.outcome ? { outcome: basis.outcome } : {}),
      ...(basis.delivery?.result ? { result: basis.delivery.result.value } : {}),
      reports: timeline
        .filter((event) => event.kind === "report")
        .map((event) => ({ event_id: event.id, text: event.text })),
      ...(cardBody ? { card: cardBody.body } : {}),
      ...(cardBody?.pictures.length ? { pictures: cardBody.pictures } : {}),
      ...(cardBody?.recordings.length ? { recordings: cardBody.recordings } : {}),
      ...(branch ? { branch } : {}),
      ...(keptRef ? { keptRef } : {}),
      ...(thread.length > 0 ? { thread } : {}),
      ...(choice ? { choice } : {}),
      ...(answers ? { answers } : {}),
    };
  }

  /**
   * Hand a source's card over as a file (FI3-700): the body is saved whole
   * - script, style and every picture path included, never cut (97c93aa4) -
   * under the new task's own folder, and the brief names that file instead
   * of pasting the HTML. The choice, answers and thread stay in the brief as
   * words. A card that cannot be saved rides in the brief whole, as before.
   */
  private async withCardFile(taskId: string, facts: BasisBriefFacts): Promise<BasisBriefFacts> {
    const machine = this.machineOf(taskId);
    const machines = this.options.machines;
    const source = facts.taskId ? this.options.tasks.get(facts.taskId) : undefined;
    // A live remote source is authoritative there, never the home's stale copy.
    if (
      source?.deviceId &&
      source.workspaceState === "present" &&
      source.branch &&
      this.deliverableOf(source) === "change"
    ) {
      if (!machines) throw new Error("The source computer cannot be reached.");
      await machines.bringBranchHome(source.id, true);
      facts = { ...facts, branch: source.branch };
    }
    if (machine !== LOCAL_MACHINE_ID) {
      if (!machines?.sourceFile || !machines.sourceRef)
        throw new Error(
          "Update Infinitary on the work computer to carry source files and starting work.",
        );
      const { branch, keptRef, ...rest } = facts;
      facts = rest;
      const startingRef = branch ?? keptRef;
      if (startingRef) {
        if ((source?.repoId ?? null) !== (this.options.tasks.get(taskId)?.repoId ?? null))
          throw new Error("The starting work belongs to a different project.");
        facts.startingRef = await machines.sourceRef(
          machine,
          taskId,
          source?.repoId ?? null,
          source?.id ?? facts.key,
          startingRef,
        );
      }
      const replacements = new Map<string, string>();
      for (const [index, file] of [
        ...(facts.pictures ?? []),
        ...(facts.recordings ?? []),
      ].entries()) {
        const extension = file.split(".").at(-1) ?? "bin";
        replacements.set(
          file,
          await machines.sourceFile(
            machine,
            taskId,
            `${facts.taskId ?? facts.key}-media-${index}.${extension}`,
            file,
          ),
        );
      }
      let body = facts.card;
      for (const [before, after] of replacements) body = body?.replaceAll(before, after);
      facts = {
        ...facts,
        ...(body ? { card: body } : {}),
        pictures: facts.pictures?.map((file) => replacements.get(file) ?? file),
        recordings: facts.recordings?.map((file) => replacements.get(file) ?? file),
      };
    }
    const { card, ...rest } = facts;
    if (!card) return facts;
    const dir = crewmateSourceCardsDir(this.options.paths, taskId);
    const file = join(dir, `${facts.key.replace(/[^A-Za-z0-9_-]/g, "-")}.html`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, card, "utf8");
    } catch {
      return facts;
    }
    if (machine === LOCAL_MACHINE_ID) return { ...rest, cardFile: file };
    if (!machines?.sourceFile)
      throw new Error("The source card cannot be copied to that computer.");
    const remoteFile = await machines.sourceFile(
      machine,
      taskId,
      `${facts.key.replace(/[^A-Za-z0-9_-]/g, "-")}.html`,
      file,
    );
    return { ...rest, cardFile: remoteFile };
  }

  /**
   * Where a task that branches from another starts (INF-799 piece 1,
   * `branch_from`): that task's branch head while its working copy is
   * present on this Mac, else the kept ref its work was saved on. Answers a
   * refusal in words when the named task is unknown, is this task, is in
   * another project, or has neither, so a tool call reads it as text and a
   * start fails with it.
   */
  private branchFromSource(
    ref: string,
    repoId: string | null,
    selfId?: string,
  ): { task: TaskRecord; ref: string } | { refused: string } {
    const source = this.options.tasks.resolve(ref.trim());
    if (!source) return { refused: `Unknown branch_from "${ref}": name a task by its key.` };
    const key = source.key || source.id;
    if (source.id === selfId) return { refused: "A task cannot branch from itself." };
    if (source.repoId !== repoId)
      return {
        refused: `branch_from ${key} is in another project; a task branches only from work in its own project.`,
      };
    if (source.workspaceState === "present" && source.branch && !source.deviceId)
      return { task: source, ref: source.branch };
    const kept = this.keptRefOf(source.id);
    if (kept) return { task: source, ref: kept };
    if (source.workspaceState === "present" && source.deviceId)
      return {
        refused: `branch_from ${key}'s working copy is on another computer; branch from it once its work is home and saved.`,
      };
    return {
      refused: `branch_from ${key} has no branch or saved work to start from: name a task that has started work in this project.`,
    };
  }

  /**
   * The typed hand-off a new task declares (INF-799 piece 1): its result
   * shape, checked to be a JSON Schema with an object at its root, and the
   * task it branches from, checked to hold a branch or saved work in the
   * same project and stored by key. A refusal is words, nothing filed.
   */
  handOffShape(
    ask: Pick<WorkShapeAsk, "result_schema" | "branch_from"> | undefined,
    repoId: string | null,
    selfId?: string,
  ): Pick<WorkShape, "result_schema" | "branch_from"> | { refused: string } {
    const refused = ask?.result_schema ? resultSchemaRefusal(ask.result_schema) : undefined;
    if (refused) return { refused };
    const ref = ask?.branch_from?.trim();
    const source = ref ? this.branchFromSource(ref, repoId, selfId) : undefined;
    // A step filed behind the step it continues names work that has not
    // started yet: its branch is checked again when this one starts.
    const named = ref ? this.options.tasks.resolve(ref) : undefined;
    const unstarted = named?.status === "open" && named.workspaceState === "none";
    if (
      source &&
      "refused" in source &&
      !(unstarted && named.repoId === repoId && named.id !== selfId)
    )
      return source;
    return {
      ...(ask?.result_schema ? { result_schema: ask.result_schema } : {}),
      ...(named ? { branch_from: named.key || named.id } : {}),
    };
  }

  /**
   * The program a new task declares (INF-799 piece 2, docs/programs.md):
   * its script checked for imports and that it compiles, its bound a
   * positive whole number. A refusal is words, nothing filed. A program
   * runs in a project's working copies, so it needs a project that is not
   * the personal workspace, and it has none of its own to branch.
   */
  private programShape(
    ask: WorkShapeAsk,
    repoId: string | null,
    personal: boolean,
  ): NonNullable<WorkShape["program"]> | string {
    const program = ask.program;
    if (!program) return "No program was given.";
    if (!this.options.programProcess) return "This app cannot run a program.";
    if (!repoId || personal)
      return "A program runs its parts in a project: give it a repo_id or a parent in one, not the personal workspace.";
    if (ask.branch_from)
      return "A program has no working copy of its own; give branch_from to its parts.";
    const refused = programRefusal(program);
    if (refused) return refused;
    return {
      script: program.script,
      bound: program.bound,
      ...(program.args !== undefined ? { args: program.args } : {}),
    };
  }

  /**
   * One task() call of a program, filed as a part (INF-799 piece 2): a
   * child of the program, when-ready, an internal step that delivers its
   * branch and its result (local-only, never a pull request), with the
   * script's schema as its result shape, the part it starts from as its
   * branch_from, and a `blocks` link from each part whose result it builds
   * on. It carries the captain's words the program was filed with.
   */
  private fileProgramPart(
    program: TaskRecord,
    part: ProgramPartAsk,
  ): TaskRecord | { refused: string } {
    const from = part.from ? this.options.tasks.get(part.from) : undefined;
    const ask: WorkShapeAsk = {
      internal_step: true,
      delivery_ask: "local-only",
      ...(part.schema ? { result_schema: part.schema } : {}),
      ...(from ? { branch_from: from.key || from.id } : {}),
    };
    const handOff = this.handOffShape(ask, program.repoId);
    if ("refused" in handOff) return { refused: handOff.refused };
    let intent: SpawnIntent;
    try {
      intent = parseSpawnIntent({
        goal: part.prompt,
        user_words: program.intent?.userWords || program.title,
        ...(program.intent?.constraints ? { constraints: program.intent.constraints } : {}),
      });
    } catch (caught) {
      return { refused: caught instanceof Error ? caught.message : String(caught) };
    }
    const placement = this.resolveGraphPlacement({
      parent: program.id,
      blockedBy: part.after,
      intent,
      shape: ask,
    });
    const shape = this.withDeliverable(
      {
        ...this.workShape(ask),
        ...handOff,
        program_part: { call: part.call, hash: part.hash, label: part.label },
      },
      intent,
    );
    const title = (part.prompt.trim().split("\n")[0] ?? part.label).slice(0, 64);
    const record = this.options.tasks.create({
      id: randomUUID().slice(0, 8),
      kind: "work",
      title,
      prompt: renderIntentBrief(intent, placement.delivery),
      intent,
      repoId: placement.repoId,
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      parentId: program.id,
      ...(placement.blockedBy.length > 0 ? { blockedBy: placement.blockedBy } : {}),
      startPolicy: "when-ready",
      status: "open",
    });
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `The program "${program.title}" (${program.key}) filed part ${record.key}: "${title}".`,
    });
    this.broadcastCrewCounts();
    void this.sweepGates(this.now());
    return record;
  }

  /**
   * A part reported the answer its program waits for: it closes done,
   * answered, its working copy retired with its work saved on its kept ref
   * so a later part or the shipping task can branch from it. After the
   * turn's own idle boundary, never inside it.
   */
  private closeProgramPart(partId: string): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const part = this.options.tasks.get(partId);
        if (!part || TaskService.isClosed(part)) return resolve();
        void this.settle
          .closeTask(partId, {
            status: "done",
            reason: "answered",
            actor: "host",
            text: "answered - its program read its result",
          })
          .catch((caught: unknown) => console.warn("[program] a part did not close:", caught))
          .finally(resolve);
      }, 0);
    });
  }

  /** A program's ask(): the question session's JSON answer, checked, or null. */
  private async programAsk(
    program: TaskRecord,
    prompt: string,
    schema: Record<string, unknown> | null,
  ): Promise<unknown> {
    const answer = this.options.answerJson;
    if (!answer) return null;
    return askJson(
      (instruction, text) =>
        answer(
          { purpose: "program-ask", taskId: program.id },
          instruction,
          text,
          new AbortController().signal,
        ),
      prompt,
      schema,
    );
  }

  /**
   * A program's call reached the bound the first mate proposed (the
   * `program-bound` hold, resting on the captain's consent): nothing more
   * is filed, and the first mate hears it once per bound, to ask the captain.
   */
  private programBounded(program: TaskRecord, calls: number): void {
    const bound = program.shape?.program?.bound ?? 0;
    if (this.programBoundTold.get(program.id) === bound) return;
    this.programBoundTold.set(program.id, bound);
    this.options.tasks.note(program.id, `held at its bound of ${bound} parts`, {
      news: true,
      actor: "host",
      feed: true,
    });
    this.hooks.notifyOp(
      {
        facts: {
          kind: "program-bound",
          task: { id: program.id, title: program.title },
          key: program.key || program.id,
          bound,
          calls,
        },
      },
      "agent",
      program.id,
    );
  }

  /**
   * A program's script ended (INF-799 piece 2). Parts it never waited for
   * are dropped. A returned value is its typed result - checked against
   * the program's own result shape when it declared one - recorded as its
   * report, and the program closes done. Its branch is only the part its
   * script names by label in the returned object's `branch`, whose saved
   * work a shipping task branches from; a script that names none - or an
   * empty one, null or "" - leaves nothing to ship. A thrown error, a result that does not fit, or a
   * `branch` naming no part that finished done closes it dropped as failed.
   * Either way the first mate hears it once.
   */
  private async finishProgram(program: TaskRecord, end: ProgramEnd): Promise<void> {
    const tasks = this.options.tasks;
    for (const part of tasks.children(program.id)) {
      if (TaskService.isClosed(part)) continue;
      await this.settle.closeTask(part.id, {
        status: "dropped",
        reason: "superseded",
        actor: "host",
        text: "superseded - its program ended without waiting for it",
        feed: false,
      });
    }
    const parts = tasks
      .children(program.id)
      .filter((part) => part.shape?.program_part)
      .sort((a, b) => (a.shape?.program_part?.call ?? 0) - (b.shape?.program_part?.call ?? 0));
    const task = { id: program.id, title: program.title };
    const schema = program.shape?.result_schema;
    const value = "value" in end ? end.value : undefined;
    const misfit = schema && "value" in end ? resultRefusal(schema, value) : undefined;
    const returned =
      value && typeof value === "object" ? (value as { branch?: unknown }).branch : undefined;
    // An empty branch is no branch: nothing to ship (the captain's N2 answer).
    const named =
      returned === null || (typeof returned === "string" && !returned.trim())
        ? undefined
        : returned;
    const branch =
      typeof named === "string"
        ? parts.find((part) => part.status === "done" && part.shape?.program_part?.label === named)
        : undefined;
    const error =
      "error" in end
        ? end.error
        : misfit
          ? `its script returned a result that does not fit its result shape: ${misfit}`
          : named !== undefined && !branch
            ? `its script returned branch ${JSON.stringify(named)}, which names no part's label that finished done`
            : undefined;
    const current = tasks.get(program.id);
    if (!current || TaskService.isClosed(current)) return;
    if (error) {
      tasks.close(program.id, {
        status: "dropped",
        reason: "failed",
        actor: "host",
        text: `its script stopped: ${error}`,
        error,
      });
    } else {
      const result =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : value === null
            ? undefined
            : { value };
      tasks.recordReport(program.id, {
        text: programReportText(parts.length, result, branch),
        actor: "host",
        ...(result ? { declared: { result } } : {}),
      });
      tasks.close(program.id, {
        status: "done",
        reason: "finished",
        actor: "host",
        text: "its script finished",
      });
    }
    this.programBoundTold.delete(program.id);
    this.broadcastCrewCounts();
    this.hooks.notifyOp(
      {
        facts: {
          kind: "program-ended",
          task,
          key: program.key || program.id,
          parts: parts.length,
          ...(error ? { error } : {}),
          ...(!error && value !== undefined && value !== null ? { result: value } : {}),
          ...(!error && branch ? { branch: branch.key || branch.id } : {}),
        },
      },
      "agent",
      program.id,
    );
  }

  /** The commit a branching task's working copy starts at, or undefined when it names none. */
  private async branchFromBase(
    record: TaskRecord | undefined,
    repoDir: string,
  ): Promise<DispatchBase | undefined> {
    const ref = record?.shape?.branch_from;
    if (!record || !ref) return undefined;
    const source = this.branchFromSource(ref, record.repoId, record.id);
    if ("refused" in source) throw new Error(source.refused);
    return this.options.workspace.baseAt(repoDir, source.ref);
  }

  /**
   * The hidden ref a task's unlanded work was saved on when its working
   * copy went, read off the timeline's save note (`retireWorktreeOf`); none
   * when nothing was saved - an answer task, or work that was all in.
   */
  private keptRefOf(taskId: string): string | undefined {
    const saves = this.options.tasks
      .timeline(taskId)
      .map((event) => (event.data as { saved?: { ref?: unknown } } | null)?.saved?.ref)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    return saves.at(-1);
  }

  /**
   * A shape with its basis verdict derived now, for the routing table. The
   * record never stores the verdict (`TaskService.basisHolds`): a step
   * planned behind the task it builds on names a basis that has not
   * answered yet, and the verdict that counts is the one at the moment the
   * work routes.
   */
  private withBasisVerdict(shape: WorkShape): WorkShape {
    if (!shape.basis) return shape;
    return { ...shape, basis_verified: this.basisHolds(shape.basis) };
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
    this.options.tasks.recordShape(taskId, {}, bucket);
  }

  /** Whether a named basis really carries a spec, a plan or a reproduction. */
  private basisHolds(ref: string): boolean {
    return this.options.tasks.basisHolds(ref);
  }

  /** A task by id or key, or a loud error naming the parameter at fault. */
  private resolveTaskRef(ref: string, param: string): TaskRecord {
    const record = this.options.tasks.resolve(ref);
    if (!record) {
      throw new Error(
        `Unknown task "${ref}" in ${param}. Use a task id or key from the tasks index, crew_status, or the tasks tool.`,
      );
    }
    return record;
  }

  /**
   * The wait a start_after asks for: another task closing is a `blocks`
   * edge (task-system P0; the old after-task gate, kept as an alias of
   * blocked_by), the rest are holds.
   */
  private waitFromStartAfter(
    startAfter: {
      afterTask?: string;
      whenQuotaResets?: string;
      at?: number;
    },
    blockedBy: string[] = [],
  ): { gate?: TaskGate; blockedBy?: string[] } {
    const blockers = [...blockedBy];
    if (startAfter.afterTask) {
      const after = this.options.tasks.resolve(startAfter.afterTask);
      if (!after) {
        throw new Error(
          `Unknown task "${startAfter.afterTask}" in start_after. Use a task id from crew_status.`,
        );
      }
      if (!blockers.includes(after.id)) blockers.push(after.id);
    }
    if (startAfter.whenQuotaResets) {
      if (this.options.quotaGateRefValid?.(startAfter.whenQuotaResets) === false) {
        throw new Error(
          `Unknown quota scope "${startAfter.whenQuotaResets}" in start_after. ` +
            "Use a provider name from the quota line, or bucket:premium / bucket:high / bucket:medium / bucket:low.",
        );
      }
      return {
        gate: { kind: "quota-reset", ref: startAfter.whenQuotaResets },
        ...(blockers.length > 0 ? { blockedBy: blockers } : {}),
      };
    }
    if (startAfter.at !== undefined) {
      return {
        gate: { kind: "at-time", until: startAfter.at },
        ...(blockers.length > 0 ? { blockedBy: blockers } : {}),
      };
    }
    if (blockers.length > 0) return { blockedBy: blockers };
    throw new Error("start_after needs after_task, when_quota_resets, or at_time.");
  }

  private insertQueuedWork(
    taskId: string,
    title: string,
    brief: string,
    intent: SpawnIntent,
    repoId: string | null,
    shape: WorkShape,
    wait: { gate?: TaskGate; blockedBy?: string[]; parentId?: string; priority?: number },
  ): void {
    this.options.tasks.create({
      id: taskId,
      kind: "work",
      title,
      prompt: brief,
      intent,
      repoId,
      // The tier the table gives this shape; R0 leaves it to the pin's own
      // slot, which only the router can resolve, so the row records none.
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      ...(wait.gate ? { gate: wait.gate } : {}),
      ...(wait.blockedBy ? { blockedBy: wait.blockedBy } : {}),
      ...(wait.parentId ? { parentId: wait.parentId } : {}),
      ...(wait.priority !== undefined ? { priority: wait.priority } : {}),
      status: "open",
    });
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
    /** Pictures the brief carries beyond those the task's messages keep (`commission`). */
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
    const pictures = this.briefPictures(taskId, spec.attachments ?? []);
    try {
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
        this.options.tasks.beginPlacementPreparation(taskId);
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
          throw new Error(this.folderMissing(spec.repoId, "start", this.options.tasks.get(taskId)));
        }
        const cwd = inPlace ? this.inPlaceDir(taskId, repoDir) : repoDir;
        task.workspace = { taskId, cwd, branch: "", repoDir };
      } else {
        // A task that needs the project's folder here is refused while it
        // is missing, naming it and the repair that brings it back (INF-572).
        if (spec.repoId && repoDir && !existsSync(repoDir)) {
          throw new Error(this.folderMissing(spec.repoId, "start", this.options.tasks.get(taskId)));
        }
        const headSha = this.reviewBuilderOf(record) ? record?.delivery?.headSha : undefined;
        // A task that branches from another starts at that task's last commit (INF-799).
        const branchFrom =
          !headSha && repoDir ? await this.branchFromBase(record, repoDir) : undefined;
        this.options.tasks.beginPlacementPreparation(taskId);
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
          ? this.options.accounts?.selectForSpawn(taskId, routedModel.provider)
          : placed
            ? spec.placementAccount
            : undefined;
      if (accountId) task.accountId = accountId;
      // Care must be stamped before opening the session: its first request
      // already carries the model's chosen effort.
      const rigor = this.deriveRigor(taskId);
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
      this.options.tasks.dispatch(taskId, {
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
      this.options.tasks.setSessionFile(taskId, crewmateResumeToken(session.resume()) ?? null);
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
      task.unsubscribe = this.follow(task, session);
      // From here every save in the workspace carries the task (the
      // running dot), until the task closes.
      minted = await this.mintBrief(taskId, brief, spec.repoId, pictures.section);
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
        this.options.tasks.releaseUnconfirmedStart(taskId);
        this.options.tasks.markStartChecking(taskId);
        this.sayAutomaticWait(this.options.tasks.get(taskId) ?? record);
        return { taskId, crewmate: "queued" };
      }
      if (
        record?.placement &&
        (!placed || elsewhere || !this.options.tasks.get(taskId)?.placement?.preparationStarted)
      )
        this.options.tasks.releasePlacement(taskId, record.placement.snapshot.orderId, "ended");
      if (caught instanceof ForgeAuthRequiredError && this.tasks.get(taskId) === task) {
        task.unsubscribe?.();
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
          this.holdForDeviceForge(taskId, machine, caught.host);
          const waiting = this.options.tasks.get(taskId);
          if (waiting)
            this.sayPlacedWait(this.waitSubject(waiting), machine, {
              kind: "forge",
              host: caught.host,
            });
          this.cards.scheduleBroadcast();
          this.broadcastCrewCounts();
          return { taskId, crewmate: "queued" };
        }
        this.options.tasks.requeue(
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
        task.unsubscribe?.();
        task.session?.dispose();
        this.tasks.delete(taskId);
        this.cards.deleteRowsForTask(taskId);
        if (task.workspace) {
          await this.options.workspace.removeTaskWorktree(task.workspace).catch(() => {});
        }
        this.options.tasks.requeue(
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
        : await this.placedBinding(
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
      procedure: crewmateProcedureFor(this.policiesOf(this.options.tasks.get(task.id))),
      // A crewmate on another computer is told which one (INF-567).
      ...(crewmate.machineId !== LOCAL_MACHINE_ID && this.options.machines
        ? { computer: this.options.machines.nameOf(crewmate.machineId) }
        : {}),
    };
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
      const token = crewmateResumeToken(session.resume());
      if (token) this.options.tasks.setSessionFile(task.id, token);
    }
    const restart: CrewmateRestart | undefined =
      renewal ??
      (unopenable
        ? movedTo
          ? { from: unopenable, changed: "moved", to: movedTo }
          : { from: unopenable, changed: "unopenable" }
        : undefined);
    if (restart) this.recordRestart(task, machine, restart);
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
      // A task held on another computer checks its recordings and fonts where it runs.
      ...(machine === LOCAL_MACHINE_ID && this.options.probeMedia
        ? { probeMedia: this.options.probeMedia }
        : {}),
      ...(machine === LOCAL_MACHINE_ID && this.options.probeTypeface
        ? { probeTypeface: this.options.probeTypeface }
        : {}),
      onCard: (card) => this.addCrewmateCard(task, card),
      onCardRefused: (refusal) => this.recordCardRefusal(task, refusal),
      onCloseCard: (input) =>
        this.closeCard(input.cardId, { kind: "crewmate", taskId: task.id }, input.reason),
      onFollowup: (input) => this.fileFollowup(task, input),
      onProgress: (text, plan) => this.noteProgress(task, text, plan),
      onReport: (text, summary, declared) =>
        this.recordReportFromSession(task, text, summary, declared),
      onReply: (input) => this.cards.replyFromCrewmate(task.id, input),
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
  ): Pick<CrewmateSpec, "browser" | "shell" | "integrations"> {
    const { browsers, taskCommands, integrations, machines } = this.options;
    if (machine !== LOCAL_MACHINE_ID) {
      // Its shell there is granted the commands; this Mac reads its browser
      // for the captain and answers its integrations' calls.
      return {
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
    if (!browser && !reach) return {};
    return {
      ...(browser ? { browser } : {}),
      ...(reach ? { integrations: reach } : {}),
      shell: taskCommands.grant(task.id, {
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
  private follow(task: TaskRuntime, session: ModelSession): () => void {
    task.clientJobs = undefined;
    task.clientJobsSince = undefined;
    task.clientTasks.clear();
    return session.subscribe((event) => {
      if (event.type === "background_work_changed") {
        task.clientJobs = event.count;
        task.clientJobsSince =
          (event.count ?? 0) > 0 ? (task.clientJobsSince ?? this.now()) : undefined;
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
        this.endAutonomousTurn(task, event.error, event.cutOff);
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
      if (!isBroadcastEvent(event)) return;
      this.noteTaskActivity(task);
      this.applyEvent(task, event);
      this.options.broadcastEvent(enrichEvent(task, event));
    });
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
    if (this.worksInPlace(task.id)) {
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
      ...(openChange && checkChange && !this.isAnswerTask(task.id)
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
   * The captain's pictures a fresh crewmate is briefed with
   * (`docs/task-capture.md`, "Pictures stay with the task"): those the
   * messages attached to this task keep copies of, then those of the work
   * its brief carries forward - its basis, the task it was discovered or
   * escalated from, the attempt it replaces - then `extra`, each picture
   * once. As many as one message may carry ride the first turn; every
   * copy is named by its path where the crewmate runs on this Mac, and a
   * copy that is gone is counted, never sent as words alone.
   */
  private briefPictures(
    taskId: string,
    extra: readonly AttachmentRef[],
  ): { section: string; riding: AttachmentRef[]; images?: TurnImage[] } {
    const tasks = this.options.tasks;
    const record = tasks.get(taskId);
    const basis = record?.shape?.basis ? tasks.resolve(record.shape.basis) : undefined;
    const sources = [
      taskId,
      ...(basis ? [basis.id] : []),
      ...tasks.discoveredOrigins(taskId).map((origin) => origin.id),
      ...tasks.replacedPredecessors(taskId).map((predecessor) => predecessor.id),
    ];
    const seen = new Set<string>();
    const refs = [...sources.flatMap((id) => tasks.pictures(id)), ...extra].filter((ref) => {
      if (seen.has(ref.sha256)) return false;
      seen.add(ref.sha256);
      return true;
    });
    if (refs.length === 0) return { section: "", riding: [] };
    const here = this.machineOf(taskId) === LOCAL_MACHINE_ID;
    const facts: BriefPictures = { riding: [], more: [], missing: 0 };
    const riding: AttachmentRef[] = [];
    const images: TurnImage[] = [];
    for (const ref of refs) {
      let image: TurnImage | undefined;
      try {
        [image] = loadImages([ref]);
      } catch {
        facts.missing += 1;
        continue;
      }
      const named = { name: ref.name, ...(here ? { path: attachmentPath(ref) } : {}) };
      if (image && riding.length < TURN_IMAGES_MAX) {
        riding.push(ref);
        images.push(image);
        facts.riding.push(named);
      } else {
        facts.more.push(named);
      }
    }
    return {
      section: renderPicturesSection(facts),
      riding,
      ...(images.length > 0 ? { images } : {}),
    };
  }

  /**
   * The single brief mint: the captain's pictures section (`briefPictures`),
   * the rigor section the host derived for this
   * dispatch (delivery rigor phase 2), the answer-shape section for a task
   * whose deliverable is an answer (captain lock 2 of 2026-09-19, the
   * visual-density audit; the deliverable is a stamped fact since Task B),
   * the basis section for a change grounded in a verified answer (Task B,
   * F3 A), then the project's knowledge lines. Runs at
   * dispatch, after the classifier - the kind is never sorted on any of
   * these lines - so a queued row is told the shape and rigor of the moment
   * it starts. It answers in pieces, each report it copied marked as its
   * event, for the receipt (`TaskService.recordBrief`).
   */
  private async mintBrief(
    taskId: string,
    brief: string,
    repoId: string | null,
    pictures = "",
  ): Promise<BriefPart[]> {
    const sections: BriefPart[][] = [];
    // The captain's pictures sit right under the captain's words.
    if (pictures) sections.push([pictures]);
    const rigor = this.deriveRigor(taskId);
    if (rigor) sections.push([renderRigorSection(rigor)]);
    this.stampAutonomy(taskId, repoId);
    const record = this.options.tasks.get(taskId);
    const policies = this.policiesOf(record);
    if (policies)
      sections.push([
        `Current task policies: ${JSON.stringify(policies)}. Read current policies before pushing or merging; later policy notices supersede this brief, not the scope.`,
      ]);
    const deliverable = this.deliverableOf(record);
    let base = brief;
    // Whatever the brief was rendered from: a crewmate's follow-up has no
    // intent, and its tools follow the deliverable all the same (FI3-598).
    if (deliverable === "answer") {
      sections.push([renderAnswerShapeSection(record?.shape?.internal_step === true)]);
    }
    // A typed hand-off (INF-799): the result shape the report must fit, and
    // the task whose last commit the working copy began at.
    if (record?.shape?.result_schema)
      sections.push([renderResultShapeSection(record.shape.result_schema)]);
    const program =
      record?.shape?.program_part && record.parentId
        ? this.options.tasks.get(record.parentId)
        : undefined;
    if (program)
      sections.push([
        renderProgramPartSection({ key: program.key || program.id, title: program.title }),
      ]);
    const branchFrom = record?.shape?.branch_from
      ? this.branchFromSource(record.shape.branch_from, record.repoId, record.id)
      : undefined;
    if (branchFrom && !("refused" in branchFrom))
      sections.push([
        renderBranchFromLine({
          key: branchFrom.task.key || branchFrom.task.id,
          title: branchFrom.task.title,
          ref: branchFrom.ref,
        }),
      ]);
    if (deliverable === "change") {
      const basis = this.basisFacts(record);
      if (basis) sections.push(basisSectionParts(await this.withCardFile(taskId, basis)));
      // A filing's discovered-from links are truthful provenance, not an
      // inferred accepted basis or a routing discount. Preserve same-session
      // direct builds/prototypes that legitimately have no external source.
      for (const origin of this.options.tasks.discoveredOrigins(taskId)) {
        if (origin.id === taskId) continue;
        if (origin.id === this.options.tasks.resolve(record?.shape?.basis ?? "")?.id) {
          if (basis) base = withoutOriginReadLine(base, origin.key);
          continue;
        }
        const facts = await this.withCardFile(taskId, this.sourceFacts(origin));
        sections.push(basisSectionParts(facts, "origin"));
        // Its findings are in the brief now, so its filing's line telling
        // it to go and read them goes: the origin reaches it once.
        base = withoutOriginReadLine(base, origin.key);
      }
    }
    // Dropped work can have saved edits without ever reporting. Its replacement
    // carries that work independently of basisHolds and of the deliverable.
    for (const predecessor of this.options.tasks.replacedPredecessors(taskId)) {
      if (predecessor.id === taskId) continue;
      sections.push(
        basisSectionParts(
          await this.withCardFile(taskId, this.sourceFacts(predecessor)),
          "replacement",
        ),
      );
    }
    const knowledge = this.knowledgeFor(taskId);
    if (knowledge) {
      const words = [record?.title ?? "", record?.goal ?? ""].join("\n");
      sections.push([
        renderBriefKnowledge(
          knowledgeShortlist(knowledge, [PRIVATE_SCOPE], words, {
            kind: "crewmate",
            taskId,
            repoId: repoId ?? "",
          }),
          (repoId ? this.options.repos.get(repoId)?.name : undefined) ?? "this task",
        ),
      ]);
      sections.push([renderReferenceImport()]);
    }
    return joinParts([[base], ...sections], "\n\n");
  }

  /**
   * The rigor a dispatch ships at (delivery rigor phase 2; derivation
   * revised by the captain 2026-09-19), derived by the host from facts it
   * holds - the posture, the captain's words on care, and the repository's
   * own standing rigor (`repos.rigor`, the column set by talking since
   * phase 3; null = derive) - and stamped on the shape so the record and a
   * re-dispatch carry it. Neither the intelligence tier nor an escalation
   * moves it: rejecting a result routes a stronger model, never more
   * ceremony. A shape that already names one keeps it: a pre-phase-2 row
   * reads as the quick work it was.
   *
   * Rigor exists only where a CHANGE lands through a gate. A task whose
   * deliverable is an answer ships nothing at all (Task B), a review task
   * reads a change rather than shipping one, and a task on the personal
   * workspace builds in place - there is no branch to review and no pull
   * request to hold - so none of those is gated and none takes a tier.
   */
  private deriveRigor(taskId: string): Rigor | undefined {
    const record = this.options.tasks.get(taskId);
    if (record?.kind !== "work") return undefined;
    const shape = record.shape;
    const decision = { rigor: this.policiesOf(record)?.rigor.value };
    if (!decision.rigor) return undefined;
    if (shape?.rigor) return decision.rigor;
    // A quiet write, like the kind stamp (S3): the rigor explains what the
    // crewmate was told, it is not a state change, and the facts it was
    // derived from - posture, ask, repo rigor - are all on the record.
    this.options.tasks.recordShape(taskId, { rigor: decision.rigor }, record.difficulty);
    return decision.rigor;
  }

  /**
   * The autonomy a dispatch was commissioned under, stamped on the shape
   * beside the rigor (captain ruling 2026-09-20: autonomy is a repository
   * default with a per-task ask). A quiet write like the rigor stamp - it
   * records what the task started under and changes nothing. It is NOT
   * what a merge attempt reads: `taskAutonomy` derives the effective value
   * live, so the captain turning a repository autonomous reaches the work
   * already in flight.
   */
  private stampAutonomy(taskId: string, repoId: string | null): void {
    const record = this.options.tasks.get(taskId);
    if (record?.kind !== "work") return;
    const shape = record.shape;
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    // A review ships nothing, the personal workspace builds in place, and
    // an answer task commits nothing (Task B) - none of the three has a
    // merge for anyone to be autonomous about. The same exemptions rigor
    // takes, for the same reason, and the reason the deliverable speaks
    // before this hold does.
    if (
      shape?.kind === "review" ||
      repo?.kind === "personal" ||
      shape?.in_place !== undefined ||
      this.deliverableOf(record) === "answer"
    ) {
      return;
    }
    if (shape?.autonomy !== undefined) return;
    const autonomy = this.policiesOf(record)?.autonomy.value ?? false;
    this.options.tasks.recordShape(taskId, { autonomy }, record.difficulty);
  }

  /**
   * Whether this task's green work may be merged without the captain: its
   * own ask, else the repository's standing flag (`autonomyFor`). The one
   * reader for the settle refusal, `crew_status` and the fact strip, so
   * none of the three can disagree with another.
   */
  taskAutonomy(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    if (!record) return false;
    return this.policiesOf(record)?.autonomy.value ?? false;
  }

  private policiesOf(record: TaskRecord | undefined): EffectiveTaskPolicies | null {
    if (!record) return null;
    return effectiveTaskPolicies(
      record,
      record.repoId ? this.options.repos.get(record.repoId) : undefined,
    );
  }

  /** Called after the atomic record edit; never dispatches or restarts work. */
  policiesChanged(
    taskId: string,
    edits: TaskPolicyEdits,
    before?: EffectiveTaskPolicies | null,
  ): string {
    const record = this.options.tasks.get(taskId);
    const policies = this.policiesOf(record);
    if (!record || !policies) return "";
    const wake: TypedWake = {
      facts: {
        kind: "task-policies-changed",
        task: { id: taskId, key: record.key, title: record.title },
        policies,
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
        this.options.tasks.recordDelivery(taskId, { captainWait: undefined });
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
          this.options.tasks.recordDelivery(taskId, { captainWait: undefined });
      }
      this.ladder.syncCaptainGate(taskId, this.now());
    }
    this.broadcastCrewCounts();
    return policyEditConsequences({
      edits,
      now: policies,
      before,
      mergeSent: this.settle.mergeWasSent(taskId),
    });
  }

  /** A spawn that failed before the crewmate ran leaves nothing behind. */
  private async cleanupFailedSpawn(task: TaskRuntime): Promise<void> {
    task.unsubscribe?.();
    task.session?.dispose();
    this.tasks.delete(task.id);
    this.cards.deleteRowsForTask(task.id);
    if (this.options.tasks.get(task.id)) {
      this.options.tasks.discardFailedSpawn(task.id);
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
    try {
      // The one place a crewmate is told its project's directions: the
      // brief holds none, so a first turn carries them once, and a brief
      // served again to a new conversation carries no stale copy.
      const repoId = this.options.tasks.get(task.id)?.repoId;
      if (this.options.knowledge && repoId) {
        const directions = renderDirections(
          this.options.knowledge.standingDirections({
            kind: "crewmate",
            taskId: task.id,
            repoId,
          }),
        );
        served += `\n\n${directions}`;
      }
      const assignment = await this.refreshReview(task);
      if (assignment)
        served += `\n\nCurrent review assignment (supersedes earlier heads):\n${assignment}`;
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
      if (task.cancelled) {
        this.finish(task, "cancelled");
      } else if (task.interruptRequested) {
        task.interruptRequested = false;
        this.turnComplete(task, { interrupted: true });
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
    // The task moving on its own ends its idle episode (docs/report-sort.md):
    // the clock, the rungs and the host's stall card all go. The one turn
    // that does not is the ladder's own nudge - that turn is the ladder
    // acting, and its episode goes on until something else moves the task.
    if (!this.isLadderTurn(task.id, inboxIds)) {
      this.options.tasks.endIdle(task.id);
      this.ladder.withdrawStallCard(task.id);
    }
    // Whatever the last report declared about whose turn followed it no
    // longer stands once a turn runs: a close, a click, a reply or a steer
    // started this one, and its own report says it again if it still holds.
    if (this.options.tasks.clearDeclaration(task.id)) {
      this.ladder.syncCaptainGate(task.id, this.now());
    }
    this.broadcastCrewCounts();
    this.options.tasks.setActivity(task.id, "running");
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
    return this.options.tasks.onlyLadderSteers(taskId, inboxIds);
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
    if (declared?.validation)
      return this.recordValidationReport(task, text, summary, declared).then((receipt) => {
        this.cards.closeOut({ kind: "crewmate", taskId: task.id }, "report");
        return receipt;
      });
    const receipt = this.recordExplicitReport(task, text, summary, declared);
    // The report is the crewmate's close-out: what it wrote on its cards
    // since the last one reaches the stage now, not at its turn's end.
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
  }

  /**
   * Complete an autonomous boundary exactly once, using the normal report
   * path; an interrupt the host asked for ends it the way it ends a prompt.
   */
  private endAutonomousTurn(task: TaskRuntime, error?: string, cutOff?: CutOff): void {
    if (!task.autonomousTurn || this.tasks.get(task.id) !== task) return;
    task.autonomousTurn = false;
    if (error && !task.lastTurnError) {
      task.lastTurnError = error;
      task.lastTurnCutOff = cutOff;
    }
    const interrupted = task.interruptRequested;
    task.interruptRequested = false;
    this.turnComplete(task, { interrupted });
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
    const placement = this.options.tasks.get(task.id)?.placement;
    if (placement)
      this.options.tasks.releasePlacement(task.id, placement.snapshot.orderId, "ended");
    const providerError = task.lastTurnError;
    let cutOff = task.lastTurnCutOff;
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
    const candidate = providerError ? undefined : (task.explicitReport ?? finalText);
    // The tool's own headline belongs to the tool's report, never to a
    // final text that stood in for it.
    const candidateSummary = task.explicitReport !== undefined ? task.explicitSummary : undefined;
    const declared = task.explicitReport !== undefined ? task.explicitDeclared : undefined;
    task.turnReport = undefined;
    task.explicitReport = undefined;
    task.explicitSummary = undefined;
    task.explicitDeclared = undefined;
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
      } else {
        // A steer no turn took in never reached the transcript: its rows
        // go back on the lane, due now, and the delivery below serves them
        // as the next turn - the Firstmate's own rule for its steers
        // (`redeliverUndeliveredSteers`).
        this.options.inbox.ack(inFlight.filter((id) => !unread.has(id)));
        this.options.inbox.reparkUndelivered(inFlight.filter((id) => unread.has(id)));
      }
    }
    // The first provider failure of an outage wakes the Firstmate; the rest
    // are the retry's, and each is still its own line on the task's
    // timeline. A failed turn that carried no guidance has no retry, so it
    // is reported as it always was.
    const retrying = providerError !== undefined && !signInFailure && inFlight.length > 0;
    const firstFailure = !retrying || outage.failures === 0;
    if (!providerError && outage.failures > 0) this.ladder.endOutage(task, outage.failures);
    task.state = "idle";
    if (report) task.lastCompleteText = report;
    // The record carries the report (task-system P0): crew_status reads the
    // outcome column after a restart, when no runtime remembers it.
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
      this.options.tasks.recordTurnFailure(task.id, turnError, typed);
    } else if (report) {
      this.options.tasks.recordReport(task.id, {
        text: report,
        ...(candidateSummary ? { summary: candidateSummary } : {}),
        ...(declared ? { declared } : {}),
      });
      // A declared wait places the captain gate before the sort reads it.
      if (declared?.wait) this.ladder.syncCaptainGate(task.id, this.now());
    }
    this.options.tasks.setActivity(task.id, "idle");
    this.options.tasks.markIdle(task.id, { providerFailed: providerError !== undefined });
    // Going idle is the crewmate's close-out when it did not report.
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
    const resumeToken = crewmateResumeToken(task.session?.resume());
    if (resumeToken) this.options.tasks.setSessionFile(task.id, resumeToken);
    // The personal workspace (Step 4): a report is the turn's commit, and - with no
    // captain-turn witness - the task's completion: the host commits
    // the workspace with the report as the message and, once the commit
    // lands, closes the record done. The report is already the feed line;
    // no wake goes anywhere, because nothing is owed - the panel is simply
    // there. A commit that fails keeps the task open and tells the Firstmate
    // (`commitFailed`). A report beside a decision or declared captain wait
    // is his turn, so it routes like any other.
    const personal = this.options.personal;
    // A teach task is a subject kept open across days: every finished turn is
    // committed (its records are files), and none closes the task or wakes
    // the Firstmate, with a report or without one. Only a report that asks
    // Firstmate for something, or says it is finished, routes like any other.
    if (
      !turnError &&
      !options.interrupted &&
      personal &&
      this.isPersonalTask(task.id) &&
      this.options.tasks.get(task.id)?.shape?.kind === "teach" &&
      !declared?.needsFirstmate &&
      declared?.finished !== true
    ) {
      void this.commitLiveTurn(task, report || "lesson turn", personal, { close: false });
      return;
    }
    if (report && !turnError && !options.interrupted && personal && this.isPersonalTask(task.id)) {
      // A declared wait holds it with or without a card up; with none, the sort wakes the Firstmate.
      const cardOpen =
        this.ladder.witnesses(task.id, this.now()).decisionCardOpen ||
        Boolean(this.options.tasks.get(task.id)?.delivery?.captainWait);
      void this.commitLiveTurn(task, report, personal, { close: !cardOpen });
      if (!cardOpen) return;
    }
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
        const plan = this.planMove(task.id);
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
    } else if (report && isRepairAssessment(this.options.tasks.get(task.id)?.shape)) {
      // An independent repair assessment's one report decides the kept
      // merge's undecided repair (FI3-663).
      void this.settleRepairAssessment(task, report);
    } else if (report && this.options.tasks.get(task.id)?.shape?.kind === "review") {
      // A reviewer's report is a verdict (delivery rigor phase 2): the host
      // reads its first line, records it on the builder, and on a pass
      // closes the review - which is what releases the merge hold.
      void this.settleReview(task, report);
    } else if (report) {
      this.sortReport(task, report, filed, declared);
    }
    // A captured settle owns this idle boundary. Do not start another queued
    // guidance turn before its normal close/CI gates run.
    const move = task.pendingMove;
    task.pendingMove = undefined;
    if (this.options.tasks.get(task.id)?.pendingSettle) {
      this.settle.releaseSettleBoundary(task.id);
    } else if (move) {
      // A move asked for mid-turn runs at this boundary, and delivers what
      // waits once the task reopens on its new provider (INF-849).
      void this.runMove(task.id, move);
    } else {
      this.deliverPendingToTask(task, { announce: true });
    }
    // Every idle boundary runs the one reconciler the tick runs.
    this.ladder.reconcileIdleTask(task.id, this.now());
    // The captain's kept merge approval runs once the crewmate's turn is
    // over; a no-op when none stands (FI3-304).
    void this.settle.runMergeAuthorization(task.id).catch((caught: unknown) => {
      console.warn("[crew] kept merge could not run:", caught);
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
    const finished = declared?.finished === true;
    const needsFirstmate = declared?.needsFirstmate;
    const record = this.options.tasks.get(task.id);
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
    const witnesses = this.ladder.witnesses(task.id, this.now());
    // A wait it declared with nothing on the captain's screen to answer is
    // the card the Firstmate owes (INF-11): the wake says what he must decide.
    const unseenWait = witnesses.decisionCardOpen ? undefined : record?.delivery?.captainWait;
    const wake: TypedWake = {
      facts: {
        kind: "report",
        task: { id: task.id, title: task.title },
        crewmate: task.crewmate,
        excerpt: capWithOverflow(report, "task-report"),
        filed: filed.map(({ key, title, blocks }) => ({ key, title, blocks })),
        ...(waits.length > 0 ? { waits } : {}),
        ...(waiting.length > 0 ? { waiting } : {}),
        cards: this.cards.shownCards(task.id),
        ...(refused ? { refused } : {}),
        ...(unseenWait ? { captainWait: unseenWait.reason } : {}),
        ...(finished ? { finished: true } : {}),
        ...(needsFirstmate ? { needsFirstmate } : {}),
        ...(declared?.result ? { result: declared.result } : {}),
        ...(ci ? { ci } : {}),
        ...(review ? { review } : {}),
      },
    };
    // A program's part answering its call is the program's to read (INF-799).
    const programPart =
      this.programs.awaits(task.id) &&
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
      waitedOn: waiting.length > 0,
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
      void this.closeProgramPart(task.id);
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
   * A review task reported (delivery rigor phase 2; verdict semantics
   * revised by the captain 2026-09-19). The host reads the first line -
   * `verdict: pass|findings|blocked` - the finding lines, and the closing
   * `risk:` line. A report with NO verdict line records nothing and spends
   * no round: a reviewer's acknowledgment is not a review, and the merge
   * stays held regardless. A stated findings verdict whose findings are
   * all info/no-op derives a pass - info never blocks (the no-mistakes
   * rule) - and a findings round counts only at a head not yet counted.
   * The verdict lands on the BUILDER's delivery facts as a `review`
   * timeline event, the risk beside CI and never a hold (Q4). A pass
   * closes the review task done - the one feed line is the builder's own
   * "review passed" event, the close itself is silent - which releases
   * the `blocks` hold on the builder's push, PR and merge; the wake to
   * the Firstmate then refs the builder, because the next move is on it
   * and a wake naming a closed task would be purged with it. Findings and
   * blocked leave the reviewer idle and steerable for a re-review, and
   * the wake refs the review task.
   */
  private async settleReview(task: TaskRuntime, report: string): Promise<void> {
    const review = this.options.tasks.get(task.id);
    const builder = this.reviewBuilderOf(review);
    const excerpt = capWithOverflow(report, "task-report");
    const reviewTask = { id: task.id, title: task.title };
    if (!review || !builder) {
      this.hooks.notifyOp(
        {
          facts: { kind: "review-orphan", task: reviewTask, crewmate: task.crewmate, excerpt },
        },
        "crewmate-report",
        task.id,
      );
      return;
    }
    const builderTask = { id: builder.id, title: builder.title };
    const parsed = parseReviewReport(report);
    // A report with no verdict line states nothing (captain ruling,
    // 2026-09-19): a reviewer's acknowledgment - "standing by", "no new
    // head yet" - is a plain report, never a verdict and never a round.
    // The merge stays held either way, so this still fails toward the
    // human. Four of the first thirteen recorded verdicts were these.
    if (!parsed.stated) {
      this.hooks.notifyOp(
        {
          facts: {
            kind: "review-unstated",
            task: reviewTask,
            builder: builderTask,
            crewmate: task.crewmate,
            excerpt,
          },
        },
        "crewmate-report",
        task.id,
      );
      return;
    }
    // A verdict belongs to the commit assigned before this turn, not a
    // newer builder commit that happened to arrive while the reviewer read.
    const sha = review.delivery?.headSha;
    if (!sha) {
      this.hooks.notifyOp(
        {
          facts: {
            kind: "review-unstated",
            task: reviewTask,
            builder: builderTask,
            crewmate: task.crewmate,
            excerpt:
              "No assigned review commit is recorded. Steer the reviewer for a new review before accepting a verdict.",
          },
        },
        "crewmate-report",
        task.id,
      );
      return;
    }
    const proof = this.options.tasks.get(builder.id)?.delivery?.liveValidation;
    const assigned = review.delivery?.validationAssignment;
    const typedVerdict = proof?.reviews.findLast(
      (item) =>
        item.reviewer === task.id &&
        item.head === sha &&
        item.revision === assigned?.revision &&
        (item.stateRevision ?? 0) === (assigned?.stateRevision ?? 0),
    );
    const acceptance = acceptedValidation(proof, sha);
    const validationReason = !acceptance.ready
      ? acceptance.reason
      : !assigned ||
          assigned.revision !== validationRevision(proof) ||
          assigned.scenarioRevision !== proof?.scenarioRevision ||
          (assigned.stateRevision !== undefined &&
            assigned.stateRevision !== validationStateRevision(proof))
        ? "The validation facts changed after assignment; re-review the current validation state, even at the same head."
        : !typedVerdict
          ? "The assigned reviewer has not reported a typed judgment of this validation state."
          : undefined;
    const blockedReason = parsed.verdict === "pass" ? validationReason : undefined;
    if (blockedReason) {
      parsed.verdict = "blocked";
      parsed.derivedPass = false;
    }
    const shortSha = sha.slice(0, 7);
    const at = this.now();
    const riskText = parsed.risk
      ? `risk ${parsed.risk}${parsed.riskNote ? `: ${parsed.riskNote}` : ""}`
      : "risk unstated";
    const derived = parsed.derivedPass ? " (info-only findings; derived pass)" : "";
    const facts = {
      reviewVerdict: parsed.verdict,
      ...(sha ? { reviewSha: sha } : {}),
      reviewChange: review.delivery?.reviewChange,
      reviewCarrySha: undefined,
      ...(parsed.risk ? { reviewRisk: parsed.risk } : {}),
      ...(parsed.riskNote ? { reviewRiskNote: parsed.riskNote } : {}),
      reviewedAt: at,
    };
    if (parsed.verdict === "pass") {
      this.options.tasks.recordDelivery(builder.id, facts, {
        kind: "review",
        text: `review passed at ${shortSha}, ${riskText}${derived}`,
        feed: true,
        data: { reviewTaskId: task.id },
      });
      try {
        await this.settle.closeTask(task.id, {
          status: "done",
          reason: "finished",
          actor: "host",
          text: `review passed - ${builder.title}`,
          feed: false,
        });
      } catch (caught) {
        // The verdict is on the record either way; a close that failed
        // (a worktree that would not go) is a timeline fact, never a lost
        // pass - the wake below still says the review passed.
        const message = caught instanceof Error ? caught.message : String(caught);
        if (this.options.tasks.get(task.id)) {
          this.options.tasks.note(task.id, `could not close the review: ${message}`, {
            news: true,
            data: { closeFailed: message },
          });
        }
      }
      this.hooks.notifyOp(
        {
          facts: {
            kind: "review-passed",
            task: builderTask,
            reviewKey: task.key,
            crewmate: task.crewmate,
            ...(sha ? { head: sha } : {}),
            ...(parsed.risk ? { risk: parsed.risk } : {}),
            ...(parsed.riskNote ? { riskNote: parsed.riskNote } : {}),
            derived: parsed.derivedPass,
            excerpt,
          },
        },
        "crewmate-report",
        builder.id,
      );
      return;
    }
    // A findings verdict is one round per version/evidence pair (captain ruling,
    // 2026-09-19): a stated verdict at a pair already counted - a repeat
    // of the same review - records the verdict without spending a round,
    // so only real re-reviews walk toward the cap.
    const pair = validationPair(sha, review.delivery?.validationAssignment?.revision ?? 0);
    const countedPairs =
      builder.delivery?.reviewRoundPairs ??
      (builder.delivery?.reviewRoundSha
        ? [validationPair(builder.delivery.reviewRoundSha, 0)]
        : []);
    const newHead = !countedPairs.includes(pair);
    const rounds =
      parsed.verdict === "findings" && newHead
        ? (builder.delivery?.reviewRounds ?? 0) + 1
        : undefined;
    this.options.tasks.recordDelivery(
      builder.id,
      {
        ...facts,
        ...(rounds !== undefined ? { reviewRounds: rounds } : {}),
        ...(rounds !== undefined && sha
          ? { reviewRoundSha: sha, reviewRoundPairs: [...countedPairs, pair] }
          : {}),
      },
      {
        kind: "review",
        text: `review ${parsed.verdict} at ${shortSha}, ${riskText}${
          rounds !== undefined ? ` - findings round ${rounds}` : ""
        }${parsed.verdict === "findings" && !newHead ? " - same head, round not counted" : ""}${blockedReason ? ` - ${blockedReason}` : ""}`,
        feed: false,
        data: {
          reviewTaskId: task.id,
          ...(blockedReason ? { validationReason: blockedReason } : {}),
        },
      },
    );
    const capped =
      this.policiesOf(this.options.tasks.get(builder.id))?.rigor.value === "reviewed" &&
      rounds !== undefined &&
      reviewCapReached(rounds) &&
      builder.delivery?.reviewCapAt === undefined &&
      !overridePasses(builder.delivery, "rounds", builder.delivery?.headSha);
    const verdict: ReviewVerdictFacts = {
      kind: "review-verdict",
      task: reviewTask,
      builder: builderTask,
      crewmate: task.crewmate,
      verdict: parsed.verdict,
      excerpt,
      cards: this.cards.shownCards(task.id),
      // The reviewed brief carries the fix rules; a builder dispatched at
      // another care never read them, so the wake names them for its steer.
      briefed: builder.shape?.rigor === "reviewed",
      ...(this.options.tasks.briefContains(builder.id, CAREFUL_LIVE_VALIDATION)
        ? {}
        : { liveValidationBriefed: false }),
      ...(blockedReason ? { validationReason: blockedReason } : {}),
    };
    this.hooks.notifyOp(
      capped
        ? this.ladder.holdForReviewCap(
            builder,
            rounds,
            at,
            verdict,
            reviewCapOwner(parsed.findings),
          )
        : { facts: verdict },
      "crewmate-report",
      task.id,
    );
  }

  /**
   * The end of a live crewmate turn (Step 4): stamp, lint, commit, and -
   * when the report completes the work - close the task done. The commit
   * and the lint land on the task's timeline (never the feed); the close's
   * feed line is the record's own. A commit that fails closes nothing
   * (`commitFailed`).
   */
  private async commitLiveTurn(
    task: TaskRuntime,
    report: string,
    personal: PersonalLiveDelegate,
    options: { close: boolean },
  ): Promise<void> {
    try {
      const commit = await personal.commitTurn(task.id, report);
      if (!this.options.tasks.get(task.id)) return;
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
      return;
    }
    if (!options.close) return;
    // Cancelled, closed, or resumed into another turn meanwhile: leave it.
    if (this.tasks.get(task.id) !== task || task.state !== "idle") return;
    await this.settle.closeTask(task.id, {
      status: "done",
      reason: "finished",
      actor: "host",
      delivery: { mode: "in-place", landedAt: this.now() },
    });
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
   * failed steers past their grace, and job results alike. With announce
   * the feed says so rather than letting the guidance arrive as if the
   * crewmate had thought of it - one quiet feed line, never a Firstmate
   * wake (interaction P0, WI-5): the Firstmate queued that guidance itself
   * and has nothing to act on. Rows are marked in-flight here and
   * acknowledged at the turn's end (runTurn -> turnComplete).
   */
  private deliverPendingToTask(task: TaskRuntime, options: { announce?: boolean } = {}): void {
    if (task.cancelled || !task.session || task.state !== "idle") return;
    if (this.laneHeld(task.id)) return;
    const rows = this.deliverableRows(task.id, this.now());
    if (rows.length === 0) return;
    const pictures = this.rowPictures(task.id, rows);
    if (pictures.blocked) return;
    if (options.announce) {
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Task ${task.title} guidance queued: it will be delivered when the task is free`,
      });
    }
    const ids = this.deliverRows(task.id, rows);
    void this.runTurn(task, laneTurnText(rows), ids, pictures.images);
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
    } = {},
  ): Promise<SteerDelivery> {
    const steer: SteerSource = {
      actor,
      via: source.via ?? "tool",
      decision: source.decision ?? null,
      cardId: source.cardId ?? null,
      ...(source.panel ? { panel: source.panel } : {}),
      ...(source.captainWords ? { captainWords: true } : {}),
    };
    return this.steerInternal(taskId, message, steer, source.images, source.attachments);
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
  ): Promise<SteerDelivery> {
    let message = renderWake(body);
    // A reply the captain typed under a card: the record reads the captain's words in the message.
    const words = replyWordsSpan(body);
    const source = words ? { ...given, words } : given;
    // A re-review past the review cap (phase 3) is refused as text: the
    // builder's decision card is the way out, and a steer to the builder
    // reopens the rounds - nothing is lost, the guidance just has a door.
    const reviewBuilder = this.reviewBuilderOf(this.options.tasks.get(taskId));
    if (
      reviewBuilder &&
      reviewBuilder.delivery?.reviewCapAt !== undefined &&
      !overridePasses(reviewBuilder.delivery, "rounds", reviewBuilder.delivery.headSha)
    ) {
      throw new Error(
        `Task ${taskId} is the review of task ${reviewBuilder.id}, which hit its review cap (${reviewBuilder.delivery.reviewRounds ?? 0} findings rounds; the cap is ${REVIEW_ROUND_CAP} re-reviews): ${reviewBuilder.delivery.reviewCapOwner === "firstmate" ? `steer task ${reviewBuilder.id} with the fixes or your decision to reopen its rounds before re-reviewing` : `no re-review goes out until the captain answers the decision card on task ${reviewBuilder.id} and you steer task ${reviewBuilder.id} with the answer, which reopens the rounds.`} ${softHoldWords("rounds", "firstmate")}`,
      );
    }
    // The captain's close of a card is not his answer to a cap.
    if (typeof body === "string" || body.facts.kind !== "card-closed") {
      this.ladder.resetCapsOnSteer(taskId, source);
    }
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
    const enqueue = (): number => {
      const mark = guidance ? this.settle.holdForGuidance(taskId) : undefined;
      if (mark !== undefined) {
        const marked = withGuidanceMark(body, mark);
        message = renderWake(marked);
        durable = withPictures(marked);
      }
      return this.enqueueSteer(taskId, durable);
    };
    const task = this.tasks.get(taskId);
    if (task?.session && !task.cancelled) {
      if (task.state === "streaming" || task.state === "starting") {
        // Its computer is out of reach: kept on the lane, and steered into
        // the turn once it is back and caught up.
        if (this.outOfReach(taskId)) {
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
      if (this.laneHeld(taskId)) {
        // Kept on the lane until the account serves again.
        this.recordSteer(taskId, message, source, "recorded-held", pending);
        return "recorded-held";
      }
      this.recordSteer(taskId, message, source, "mid-turn", pending);
      this.deliverPendingToTask(task);
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
    if (this.laneHeld(taskId)) {
      this.recordSteer(taskId, message, source, "recorded-held", resumeId);
      return "recorded-held";
    }
    try {
      const resumed = await this.resumeTask(record.id);
      this.recordSteer(taskId, message, source, "mid-turn", resumeId);
      this.deliverPendingToTask(resumed);
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
    const order = laneOrder(ids);
    try {
      if (images) await session.steer(text, images, order);
      else if (order) await session.steer(text, undefined, order);
      else await session.steer(text);
    } catch (caught) {
      task.inFlightInboxIds = task.inFlightInboxIds.filter((id) => !ids.includes(id));
      task.steeredInboxIds = task.steeredInboxIds.filter((steered) => steered !== ids);
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
      this.options.tasks.recordSteer(taskId, {
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
   * conversation when the new backend can reopen it.
   */
  private async resumeTask(taskId: string, move?: MoveTarget): Promise<TaskRuntime> {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
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
      this.options.tasks.setAccountId(record.id, attachment.accountId ?? null);
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
          resumeToken: record.sessionFile,
          ...(move ? { model: move.model, thinkingLevel: move.thinkingLevel } : {}),
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
    task.unsubscribe = this.follow(task, session);
    // A moved task's record names the conversation it opened now, so a quit
    // before its first turn ends reopens this one.
    const token = move ? crewmateResumeToken(session.resume()) : undefined;
    if (token) this.options.tasks.setSessionFile(record.id, token);
    livePersonal?.beginLiveTask(record.id);
    // A conversation on another computer may be in a turn this Mac follows
    // from here (`continuation_started`), which is no idle boundary.
    if (task.state === "idle") {
      this.options.tasks.setActivity(record.id, "idle");
      // A resume that went idle is an idle boundary: the record's own clock
      // carries across the restart, and a record a quit interrupted mid-turn
      // starts one now.
      this.options.tasks.markIdle(record.id);
    }
    this.broadcastCrewCounts();
    return task;
  }

  /** The name a person knows a provider by: its catalog name, else its id. */
  private providerName(provider: string): string {
    return PROVIDER_CATALOG.find((entry) => entry.id === provider)?.name ?? provider;
  }

  /** Why a move refuses the model its card offered, when the app would now pick another. */
  private offerGone(
    plan: { record: TaskRecord; choice: { provider: string; id: string } },
    ask: MoveAsk,
  ): string | undefined {
    if (!ask.offered || offeringKey(plan.choice) === ask.offered) return undefined;
    const handle = `${plan.record.key || plan.record.id} "${plan.record.title}"`;
    return `${handle} did not move: the app would now pick ${this.modelName(plan.choice)}, not the model its card offered.`;
  }

  /** A model by its Settings name, as the sign-in card's Move names it. */
  private modelName(model: { provider: string; id: string }): string {
    return this.options.modelName?.(model) ?? model.id;
  }

  /**
   * Where a move would take a started task now (INF-849): the router's
   * evaluation for its own shape, with its current provider left out - or
   * the model named, as R0 pins one - never recorded. A refusal is text:
   * a task not started or closed, one on another computer, none that serves.
   */
  private planMove(
    taskId: string,
    model?: string,
  ):
    | { refused: string }
    | {
        record: TaskRecord;
        from: string | undefined;
        preview: RoutePreview;
        choice: { provider: string; id: string };
      } {
    const record = this.options.tasks.get(taskId);
    if (!record) return { refused: `Unknown task "${taskId}".` };
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.kind !== "work" || record.status !== "active")
      return { refused: `${handle} is ${describeStatus(record)}; only started work moves.` };
    if (this.machineOf(taskId) !== LOCAL_MACHINE_ID)
      return {
        refused: `${handle} runs on another computer, so it stays on that computer's own subscriptions.`,
      };
    const router = this.options.router;
    const from =
      router?.servedProvider(taskId) ??
      (record.model ? parseOfferingKey(record.model).provider || undefined : undefined);
    if (!model && !from) return { refused: `${handle} has no provider on its record to move off.` };
    const { override_model_id: _named, ...shape } = this.queuedShape(record);
    const preview = router?.preview(
      record.prompt,
      model ? { ...shape, override_model_id: model } : shape,
      model || !from ? {} : { withoutProvider: from },
    );
    if (!preview)
      return { refused: "Automatic model choice is off, so the app cannot pick another model." };
    const choice = preview.result.choice;
    const named =
      choice && model
        ? model.includes("/")
          ? offeringKey(choice) === model
          : choice.id === model
        : true;
    if (!choice || !named)
      return {
        refused: model
          ? `${model} cannot take ${handle} now, so it stays where it runs.`
          : `No other signed-in provider can take ${handle} now, so it stays on ${this.providerName(from ?? "")}.`,
      };
    if (record.model === offeringKey(choice))
      return { refused: `${handle} already runs on ${offeringKey(choice)}.` };
    return { record, from, preview, choice: { provider: choice.provider, id: choice.id } };
  }

  /**
   * Move a started task to another provider (INF-849): the sign-in card's
   * Move, or update_task's model on started work. It keeps its key, branch,
   * working copy and record. A crewmate mid-turn moves once that turn ends,
   * and is never cut short. A refusal is text and changes nothing.
   */
  requestMove(taskId: string, ask: MoveAsk): { ok: boolean; text: string } {
    const plan = this.planMove(taskId, ask.model);
    if ("refused" in plan) return { ok: false, text: plan.refused };
    const { record, from, choice } = plan;
    const handle = `${record.key || record.id} "${record.title}"`;
    if (ask.from && from !== ask.from)
      return { ok: false, text: `${handle} already moved off ${this.providerName(ask.from)}.` };
    const gone = this.offerGone(plan, ask);
    if (gone) return { ok: false, text: gone };
    if (this.moving.has(taskId)) return { ok: false, text: `${handle} is already moving.` };
    const to = `${this.modelName(choice)} on ${this.providerName(choice.provider)}`;
    const runtime = this.tasks.get(taskId);
    if (runtime && runtime.state !== "idle") {
      runtime.pendingMove = ask;
      return { ok: true, text: `${handle} moves to ${to} once its crewmate's turn ends.` };
    }
    void this.runMove(taskId, ask);
    return {
      ok: true,
      text: `Moving ${handle} to ${to}; it keeps its key, branch and working copy.`,
    };
  }

  /**
   * The move itself, between turns: route again and record why, pick the
   * account, let go of the old session, write the record, take the sign-in
   * card down, end the lane's outage, and reopen in the same working copy -
   * the same conversation between two Pi providers, a new one told it moved
   * otherwise - then deliver what waited. A failure is a feed line and a
   * timeline row; the record then reopens on its new provider when next asked.
   */
  private async runMove(taskId: string, ask: MoveAsk): Promise<void> {
    if (this.moving.has(taskId)) return;
    this.moving.add(taskId);
    try {
      const runtime = this.tasks.get(taskId);
      if (runtime && runtime.state !== "idle") {
        runtime.pendingMove = ask;
        return;
      }
      const plan = this.planMove(taskId, ask.model);
      const refused = "refused" in plan ? plan.refused : this.offerGone(plan, ask);
      if (refused || "refused" in plan) {
        this.options.broadcastEvent({ type: "firstmate_note", text: refused ?? "", taskId });
        return;
      }
      const { record, from, preview, choice } = plan;
      const who = ask.by === "captain" ? "the captain" : "the first mate";
      preview.reasons.push(
        ask.model
          ? `moved by ${who} to the model named`
          : `moved by ${who} off ${from ?? "its provider"}`,
      );
      this.options.router?.commit(taskId, preview);
      const accountId = this.options.accounts?.selectForSpawn(taskId, choice.provider);
      if (runtime) {
        this.releaseSession(runtime);
        this.tasks.delete(taskId);
      }
      const fromName = from ? this.providerName(from) : "its provider";
      const toName = this.providerName(choice.provider);
      this.options.tasks.recordMove(taskId, {
        model: choice,
        accountId: accountId ?? null,
        actor: ask.by,
        text: `${who} moved it from ${fromName} to ${this.modelName(choice)} on ${toName}`,
        data: {
          moved: {
            from: record.model,
            to: offeringKey(choice),
            ...(accountId ? { accountId } : {}),
          },
        },
      });
      this.cards.clearAuthDecisionCard(crewSignInCardId(taskId));
      this.options.inbox.movedProvider(taskId);
      const level = preview.result.servedBucket ?? preview.result.bucket;
      const resumed = await this.resumeTask(taskId, {
        model: choice,
        ...(accountId ? { accountId } : {}),
        thinkingLevel:
          record.shape?.override_reasoning ??
          this.options.router?.reasoningChoice(choice, level) ??
          levelDefaultReasoning(level),
        providerName: toName,
      });
      this.deliverPendingToTask(resumed);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.options.tasks.note(taskId, `its move could not reopen it: ${message}`, { news: true });
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Task ${this.options.tasks.get(taskId)?.title ?? taskId} could not move: ${message}`,
        taskId,
      });
    } finally {
      this.moving.delete(taskId);
      this.broadcastCrewCounts();
    }
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
    this.settle.expectClosingSentence(id, closingSentence);
    try {
      await this.interruptOnce(taskId, mode, source);
    } catch (caught) {
      this.settle.forgetClosingSentence(id);
      throw caught;
    }
    // With no turn left to end, no later close will take it.
    if (!this.tasks.has(id)) this.settle.forgetClosingSentence(id);
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
          this.settle.closeRecord(record.id, "cancelled", undefined, source.actor);
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
    const ended = this.settle.endAuthorization(taskId, "revoked", "the captain withdrew it", {
      holds: true,
      feed: true,
    });
    if (ended) this.announceReach(taskId);
    return ended
      ? {
          ok: true,
          text: `Withdrew the captain's kept merge approval on ${handle}. Its work stays; only their new merge click merges it.`,
        }
      : { ok: false, text: `${handle} has no kept merge approval to withdraw.` };
  }

  /**
   * update_task override (docs/delivery-rigor.md, "The holds"): the
   * captain's words, which the first mate heard in this turn, pass the soft
   * holds it declares, for this version or the task's life. The host keeps
   * his words as the row's reason and never reads them; it checks only that
   * the task is live, since update_task has already refused a hold the
   * override cannot pass, in that hold's own words (`overrideRefusal`). One
   * override stands at a time: a new one replaces it. Naming a counted limit
   * reopens it now.
   */
  declareOverride(
    taskId: string,
    input: { words: string; holds: OverridableHold[]; until: "version" | "task" },
  ): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = `${record.key || record.id} "${record.title}"`;
    if (TaskService.isClosed(record))
      return { ok: false, text: `${handle} is closed, so no hold is left to pass.` };
    const holds = [...new Set(input.holds)];
    if (holds.length === 0)
      return { ok: false, text: "Name at least one soft hold the captain's words pass." };
    const head = record.delivery?.headSha;
    if (input.until === "version" && !head)
      return {
        ok: false,
        text: `${handle} has no version yet, so an override for this version has nothing to cover. Declare until task if their words mean the whole task.`,
      };
    const override: HoldOverride = {
      words: input.words,
      holds,
      until: input.until,
      ...(input.until === "version" && head ? { head } : {}),
      at: this.now(),
    };
    this.options.tasks.recordDelivery(
      taskId,
      { override },
      {
        kind: "note",
        actor: "firstmate",
        feed: true,
        text: overrideWords(override),
        data: { news: true },
      },
    );
    this.ladder.reopenForOverride(taskId, holds);
    // His kept merge click reads the same record: one waiting on a hold his
    // words pass runs now (a no-op when none stands).
    void this.settle.runMergeAuthorization(taskId).catch((caught: unknown) => {
      console.warn("[crew] kept merge could not run:", caught);
    });
    return {
      ok: true,
      text: `Recorded the captain's override on ${handle}: their words pass ${holdNames(holds)} ${overrideSpan(override)}. Every soft hold named reads it, their merge click included; go on as their words asked. override with empty holds takes it back.`,
    };
  }

  /** update_task override with empty holds: the captain takes his override back; a second row says so. */
  withdrawOverride(taskId: string): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error(`Unknown task "${taskId}".`);
    const handle = `${record.key || record.id} "${record.title}"`;
    const override = record.delivery?.override;
    if (!override) return { ok: false, text: `${handle} has no override to take back.` };
    this.options.tasks.recordDelivery(
      taskId,
      { override: undefined },
      {
        kind: "note",
        actor: "firstmate",
        feed: true,
        text: `You took back your words on ${holdNames(override.holds)}: they hold again.`,
        data: { news: true, overrideWithdrawn: override },
      },
    );
    this.ladder.syncCaptainGate(taskId, this.now());
    return {
      ok: true,
      text: `Took back the captain's override on ${handle}: ${holdNames(override.holds)} hold again.`,
    };
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
    this.settle.revokeMergeAuthorization(
      taskId,
      source.actor === "captain"
        ? "the captain interrupted the crewmate"
        : "the first mate interrupted the crewmate",
    );
    try {
      this.options.tasks.recordInterrupt(taskId, {
        actor: source.actor,
        mode,
        effect,
        via: source.via,
        decision: source.decision,
        error,
        ...(source.panel ? { panel: source.panel } : {}),
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

  crewStatus(taskId?: string): CrewStatusEntry[] {
    const records = taskId
      ? [this.options.tasks.get(taskId)].flatMap((r) => (r ? [r] : []))
      : this.options.tasks.listLive();
    // A decision row or a host card's row is its card, not crew work.
    return records
      .filter((record) => record.kind !== "decision" && record.kind !== "operation")
      .filter(
        (record) =>
          this.tasks.has(record.id) || record.status === "open" || record.status === "active",
      )
      .map((record) => {
        const runtime = this.tasks.get(record.id);
        const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
        const reportText = runtime?.lastCompleteText || record.outcome || "";
        const lastReport = reportText
          ? capWithOverflow(reportText, "crew-status-report")
          : undefined;
        const gate =
          record.status === "open"
            ? record.gate
              ? gateText(record.gate)
              : (this.waitingOnBlockers(record) ??
                (record.startPolicy === "on-request" ? "starts on request" : undefined))
            : undefined;
        const rigor = this.policiesOf(record)?.rigor.value;
        const review = this.reviewState(record);
        const thread = this.cards.threadFact(record.id);
        const stalled = this.ladder.stalledFact(record, this.now());
        const refused = record.delivery?.cardRefusal;
        const ci = ciFactOf(record.delivery, this.now());
        // A personal task carries no delivery: it builds in place, and
        // saying "local-only" here would be a posture the Firstmate could
        // act on. The brief omits the line for the same reason.
        const delivery =
          repo?.kind === "personal" ? undefined : deliveryForRecord(record, repo?.delivery);
        // Where its proposed change goes, in the person's word for the host
        // (git integration PR 1.3) - only where one goes somewhere.
        const goesIn =
          delivery === "direct-pr" && repo?.host
            ? forgePlace({ kind: repo.host.kind, host: repo.host.name })
            : null;
        return {
          taskId: record.id,
          key: record.key,
          title: record.title,
          status: runtime
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
          ...(lastReport ? { lastReport } : {}),
          premiumRetryEligible: premiumRetryPossible(record),
          ...(rigor ? { rigor } : {}),
          ...(review ? { review } : {}),
          ...(thread ? { thread } : {}),
          ...(stalled ? { stalled } : {}),
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
          ...(repo?.kind === "personal" || this.deliverableOf(record) === "answer"
            ? {}
            : { autonomy: autonomyForRecord(record, repo?.autonomy) }),
        };
      });
  }

  /** An open row's wait on its blockers, phrased; empty when none remain. */
  private waitingOnBlockers(record: TaskRecord): string | undefined {
    const waiting = this.options.tasks
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
      case "tool_end": {
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
   * A card emitted by a crewmate through its emit_card tool (D-9, Q3). A
   * merge decision on a direct-pr task clears the standing CI gate first
   * (`pendingCiGate`); every other card - notes, non-merge decisions, a
   * local-only task's "Put the work in" - publishes exactly as before, so this
   * stays synchronous whenever the gate does not apply, which is what most
   * of this file's tests exercise.
   */
  private addCrewmateCard(
    task: TaskRuntime,
    input: DeclaredCardInput,
    checkedHead?: string,
    presentationChecked?: { revision: number; head: string },
  ): string | Promise<string> {
    if (input.presentationRevision !== undefined) {
      const revision = input.presentationRevision;
      const offer =
        input.actions.length === 1 &&
        input.actions[0] !== undefined &&
        settleEffectOf(input.actions[0])?.mode === "merge";
      // A task that merges on its own shows the same story as a note before
      // its first mate merges it (INF-547, the captain's direction C): no
      // button, since the merge is not theirs to click, and no risk chart or
      // required actions, which ride only a merge offer.
      const note = input.actions.length === 0 && this.taskAutonomy(task.id);
      if (!this.options.completionPresentation || (!offer && !note))
        throw new Error(
          "A saved-story card is only a completion offer for this task, or its note when the task merges on its own.",
        );
      return this.options.completionPresentation(task.id, revision).then(async (story) => {
        try {
          const head = this.options.tasks.get(task.id)?.delivery?.presentation?.published?.head;
          if (!head) throw new Error("The current story has not been published.");
          const { presentationRevision: _revision, ...rest } = input;
          const shown = offer
            ? story
            : { title: story.title, body: story.body, pictures: story.pictures };
          return await this.addCrewmateCard(task, { ...rest, ...shown }, undefined, {
            revision,
            head,
          });
        } catch (caught) {
          const files = cardPictureFiles(story.body, this.options.paths.crewmatesDir);
          // A late failure after persistence must not delete a shown card's own evidence.
          const kept = cardPictureFiles(
            this.cards.newestForTask(task.id)?.body ?? "",
            this.options.paths.crewmatesDir,
          );
          const retained = new Set([...kept.pictures, ...kept.recordings]);
          const dir = crewmateCardPicturesDir(this.options.paths, task.id);
          await Promise.all(
            [...files.pictures, ...files.recordings].map(async (file) => {
              if (dirname(file) !== dir || retained.has(file)) return;
              await rm(file, { force: true }).catch((error: unknown) => {
                console.warn("Could not remove refused completion story copy", error);
              });
            }),
          );
          throw caught;
        }
      });
    }
    const ownPresentation = this.options.tasks.get(task.id)?.delivery?.presentation;
    if (
      ownPresentation &&
      input.actions.some((action) => settleEffectOf(action)?.mode === "merge") &&
      !presentationChecked
    )
      throw new Error(
        "Use presentation on the completion card so it shows the current published story, not a second account of the change.",
      );
    const before = this.options.tasks.get(task.id);
    const carefulMerge =
      before?.delivery?.reviewVerdict === "pass" &&
      this.policiesOf(before)?.rigor.value === "reviewed" &&
      input.actions.some((action) => settleEffectOf(action)?.mode === "merge");
    if (!checkedHead && (input.validationDecision || carefulMerge)) {
      if (!before || this.policiesOf(before)?.rigor.value !== "reviewed")
        throw new Error("A validation decision needs its Careful task.");
      return this.validationHead(before).then(async (head) => {
        const current = this.options.tasks.get(task.id);
        if (!current) throw new Error("The task closed while reading its version.");
        const binding = input.validationDecision;
        if (binding) {
          if (
            input.actions.some(
              (action) =>
                settleEffectOf(action) ||
                requestMergeEffectOf(action) ||
                requestWriteEffectOf(action),
            )
          )
            throw new Error(
              "A validation question cannot also merge or send another write; keep those separate.",
            );
          if (!input.actions.some((action) => action.id === binding.action && !action.effect))
            throw new Error(
              "The validation approval must be an ordinary decision action, not a merge or another effect.",
            );
          checkValidationTransition(
            current.delivery?.liveValidation,
            {
              kind: "decision",
              request: binding.request,
              card: input.id ?? "pending",
              action: binding.action,
            },
            {
              head,
              deviceId: current.deviceId ?? null,
              at: this.now(),
              decision: { offer: "pending" },
            },
          );
        }
        if (carefulMerge) {
          const proof = current.delivery?.liveValidation?.runs.at(-1);
          if (proof)
            await verifyKeptValidationEvidence(
              proof.evidence,
              crewmateCardPicturesDir(this.options.paths, task.id),
              task.id,
            );
        }
        this.options.tasks.recordDelivery(task.id, { validationHead: head });
        return this.addCrewmateCard(task, input, head, presentationChecked);
      });
    }
    // The task's holds speak before the card's shape: a card the task
    // cannot take at all is refused for that, not for its headings.
    if (
      this.isPersonalTask(task.id) &&
      (input.actions ?? []).some((action) => settleEffectOf(action) || requestMergeEffectOf(action))
    ) {
      throw new Error(
        "Card refused: this task builds in place on the personal workspace - there is no merge, land, or discard. Show what you built on a note with no actions, then report; a card with actions is only for a genuine decision the captain must make.",
      );
    }
    if (
      this.worksInPlace(task.id) &&
      (input.actions ?? []).some((action) => settleEffectOf(action) || requestMergeEffectOf(action))
    ) {
      throw new Error(
        "Card refused: this task works in place in the project's folder - there is no merge, land, or discard, and a completion card is never emitted. Report what you did with report; Infinitary closes the task once what it was for is done. A card is only for a question the captain must answer.",
      );
    }
    // An answer task ships nothing (Task B), so it has no completion card
    // either: the card carrying the answer IS the deliverable, and the task
    // closes when the captain resolves it.
    if (
      this.isAnswerTask(task.id) &&
      (input.actions ?? []).some((action) => settleEffectOf(action) || requestMergeEffectOf(action))
    ) {
      throw new Error(
        "Card refused: this task's deliverable is an answer, not a change - it commits nothing, pushes nothing, and opens no pull request, so there is nothing to merge or discard. Show the answer on this card without a settle action; the captain's choice on it, or your finished report after they close it, is what closes the task.",
      );
    }
    // A reviewed task's completion card waits on its review (delivery
    // rigor phase 2): the merge is held by the review's `blocks` edge, so a
    // merge decision before the pass could only be refused on the click.
    const record = this.options.tasks.get(task.id);
    if (
      (input.actions ?? []).some((action) => settleEffectOf(action)?.mode === "merge") &&
      input.requiredActions === undefined
    )
      throw new CardRefusedError(
        "Card refused: declare required_actions, including [] when none. Name every action the captain must take after merging.",
        "shape",
        "required_actions is missing",
      );
    if (input.requiredActions !== undefined)
      this.options.tasks.validateRequiredActions(task.id, input.requiredActions);
    const reviewHead = checkedHead ?? record?.delivery?.headSha ?? record?.delivery?.validationHead;
    // The review and its live proof are two soft holds: the captain's
    // override passes either, and the card follows the hold.
    const reviewHeld =
      record !== undefined &&
      !reviewCoversHead(record.delivery, reviewHead) &&
      !overridePasses(record.delivery, "review", reviewHead);
    const proofHeld =
      record !== undefined &&
      !acceptedValidation(record.delivery?.liveValidation, reviewHead).ready &&
      !overridePasses(record.delivery, "live-proof", reviewHead);
    if (
      record &&
      this.policiesOf(record)?.rigor.value === "reviewed" &&
      (reviewHeld || proofHeld) &&
      (input.actions ?? []).some((action) => settleEffectOf(action)?.mode === "merge")
    ) {
      const review = this.reviewState(record) ?? "awaiting review";
      throw new CardRefusedError(
        `Card refused: this task ships at the reviewed tier and its review has not passed yet (${review}). ${acceptedValidation(record.delivery?.liveValidation, reviewHead).reason} Report under the five headings with report instead; the first mate tells you when to emit the completion card.${this.options.tasks.briefContains(record.id, CAREFUL_LIVE_VALIDATION) ? "" : ` This contract was missing from your brief: ${CAREFUL_LIVE_VALIDATION}`} ${softHoldWords(reviewHeld ? "review" : "live-proof", "crewmate")}`,
        "review",
        `its review has not passed yet (${review})`,
      );
    }
    // A merge the blocks rule would refuse on the click is refused here
    // instead: only Firstmate can clear the wait, so the card would be a
    // button that cannot work. (Open children stay a click-time decision:
    // the captain can override that one.)
    if ((input.actions ?? []).some((action) => settleEffectOf(action)?.mode === "merge")) {
      const waiting = this.options.tasks.blockerRefusal(task.id);
      if (waiting) {
        throw new Error(
          `Card refused: this task still waits on open work, so the merge would be refused. ${waiting.text} Report under the five headings with report instead; the first mate clears the wait and tells you when to emit the completion card. ${softHoldWords("waits", "crewmate")}`,
        );
      }
    }
    // A card that asks to send a kept write asks for exactly one, and
    // nothing else that sends (FI3-1571 piece 4); the ask must be this
    // task's and never sent.
    const writes = (input.actions ?? []).flatMap((action) => requestWriteEffectOf(action) ?? []);
    if (writes.length > 0) {
      if (
        writes.length > 1 ||
        (input.actions ?? []).some(
          (action) => settleEffectOf(action) || requestMergeEffectOf(action),
        )
      ) {
        throw new Error(
          "Card refused: a card that asks to send a write asks for exactly one, and carries no merge or discard.",
        );
      }
      const ask = this.writeAskOf(task.id, writes[0]?.ask ?? "");
      if (!ask) {
        throw new Error(
          `Card refused: ask ${writes[0]?.ask} is not on this task. Name the id github_write or an integration's call answered with.`,
        );
      }
      if (ask.sentAt !== undefined) {
        throw new Error(
          `Card refused: ask ${ask.id} was already sent once and is ${NEVER_SENT_AGAIN}. Make a new write with github_write, or call the integration again, to ask again. ${fixedHoldWords("sent-once")}`,
        );
      }
    }
    const requested = (input.actions ?? [])
      .map((action) => requestMergeEffectOf(action))
      .find(Boolean);
    if (requested) {
      const review = this.mergeReviewOf(task.id, requested.review);
      if (review?.relationship === "owned") {
        const waiting = this.options.tasks.blockerRefusal(task.id);
        if (waiting) {
          throw new Error(
            `Card refused: this task still waits on open work, so the merge would be refused. ${waiting.text} Report under the five headings with report instead; the first mate clears the wait and tells you when to emit the completion card.`,
          );
        }
      }
    }
    // The completion card's BUTTONS are the host's (contract v3.6, captain
    // lock 3; audit 4.4b row 2): a crewmate declares the merge and the host
    // attaches the pair the task's posture calls for, so no agent learns
    // merge-pr from land and no prompt asks one to transcribe a label it
    // cannot see. Done before the lint, so the lint reads the card the
    // captain will actually get. So is the browser button: the crewmate
    // names its label and the host names the browser it opens.
    const {
      browserButton,
      browserHandoff,
      browserPage,
      attachment: _undeclared,
      risk: _undeclaredRisk,
      riskDeclaration,
      ...declared
    } = input;
    const handoff = this.browserHandoffOf(declared.actions ?? [], browserHandoff);
    // A browser button with a page opens that page from the project
    // (docs/task-browser.md, "A page from the project"); without one it is
    // the door to the browser the task holds now.
    const attachment =
      browserPage !== undefined
        ? this.pageAttachment(task.id, browserButton, browserPage, handoff !== undefined)
        : this.browserAttachment(task.id, browserButton, handoff !== undefined);
    const finished = this.withCompletionActions(task.id, {
      ...declared,
      ...(attachment ? { attachment } : {}),
    });
    // The shape lint runs at the crewmate boundary too (WI-11), whichever
    // backend's tool emitted the card; a refusal is the tool's error text.
    const refusal = lintCrewmateCard(finished, {
      rigor: this.policiesOf(this.options.tasks.get(task.id))?.rigor.value,
      tieredStory:
        presentationChecked !== undefined &&
        ownPresentation?.revisions.find((story) => story.revision === presentationChecked.revision)
          ?.version === 2,
    });
    if (refusal) throw new CardRefusedError(`Card refused: ${refusal}`, "shape", refusal);
    // A saved sign-in is offered after the lint: the crewmate never learns
    // which sites are saved, so it is never counted for an action it could
    // not declare. A request card is never a completion card, so the pair
    // above is not in it.
    const shown = handoff
      ? { ...finished, actions: this.withSavedSignIn(task.id, handoff.site, finished.actions) }
      : finished;
    // What the click sends, drawn by the host from its own record after the
    // lint (FI3-1571): the author words why, never the call itself.
    const strip =
      (this.requestStrip(task.id, shown.actions) ?? "") +
      (input.validationDecision
        ? this.validationRequestStrip(task.id, input.validationDecision.request)
        : "");
    const card = strip ? { ...shown, body: `${shown.body}${strip}` } : shown;
    // A request for the captain's help pauses the browser before the card
    // goes up (docs/task-browser.md, "Asking for help").
    const paused = handoff ? this.pauseForCaptain(task.id, handoff) : undefined;
    const publish = (checked: boolean, risk?: RiskAssessment) => {
      // The task may have closed while its completion checks were read.
      // A late tool result must not recreate choices retirement removed.
      const current = this.options.tasks.get(task.id);
      if (!current || TaskService.isClosed(current)) {
        throw new Error("Card refused: this task has closed.");
      }
      if (presentationChecked) {
        const ledger = current.delivery?.presentation;
        if (
          ledger?.revisions.at(-1)?.revision !== presentationChecked.revision ||
          ledger.publication?.state !== "confirmed" ||
          ledger.published?.head !== presentationChecked.head ||
          current.delivery?.headSha !== presentationChecked.head
        )
          throw new Error(
            "The story or the checked code changed before the completion card could be shown. Publish the current story first.",
          );
      }
      // The model rides beside the meta line as its own chip (the
      // captain's 1C, 2026-09-28), and where the task runs as its own
      // words, never inside it.
      const id = this.cards.emitCrewmateCard(
        task.id,
        risk ? { ...card, risk } : card,
        task.title,
        task.session?.modelLabel() ?? task.session?.modelRef()?.id ?? "Unknown model",
        this.cardPlace(task.id),
      );
      if (input.validationDecision) {
        const offered = this.cards.get(id);
        if (!offered?.offerId) throw new Error("The validation decision has no kept offer.");
        this.options.tasks.recordLiveValidation(
          task.id,
          {
            kind: "decision",
            request: input.validationDecision.request,
            card: id,
            action: input.validationDecision.action,
          },
          {
            head: current.delivery?.validationHead ?? "",
            decision: {
              offer: offered.offerId,
              ...(offered.lifecycleId ? { lifecycle: offered.lifecycleId } : {}),
            },
          },
        );
      }
      // A completion card is up: an earlier refusal no longer stands.
      if (card.actions.some((action) => settleEffectOf(action))) {
        this.options.tasks.clearCardRefusal(task.id);
      }
      if (
        card.actions.some(
          (action) => settleEffectOf(action)?.mode === "merge" || requestMergeEffectOf(action),
        )
      ) {
        if (card.actions.some((action) => settleEffectOf(action)?.mode === "merge"))
          this.recordCompletionOffer(task.id, id, checked, presentationChecked?.revision);
        const offered = this.cards.get(id);
        if (card.requiredActions !== undefined && offered?.offerId)
          this.options.tasks.declareRequiredActions(task.id, {
            cardId: id,
            offerId: offered.offerId,
            head:
              this.mergeReviewOf(
                task.id,
                card.actions.map((action) => requestMergeEffectOf(action)?.review).find(Boolean) ??
                  "",
              )?.headSha ?? current.delivery?.headSha,
            actions: card.requiredActions,
          });
        // The task keeps the risk of its newest completion card; one
        // without any leaves none standing.
        if (risk || current.delivery?.risk) this.options.tasks.recordDelivery(task.id, { risk });
      }
      return `${id}${revisionNotice(this.cards.revisionChanges(id))}`;
    };
    const gate = this.pendingCiGate(task.id, card);
    const advisory =
      card.actions?.length &&
      !card.actions.some(
        (action) =>
          settleEffectOf(action) || requestMergeEffectOf(action) || requestWriteEffectOf(action),
      ) &&
      record?.delivery?.ci === "green" &&
      (record.delivery.changeLabel || record.delivery.prNumber !== undefined)
        ? ` No button on this card can merge ${record.delivery.changeLabel ?? `#${record.delivery.prNumber}`}. If the rest needs that merged first, file it as Continue: … and emit the completion decision.`
        : "";
    const pausedWords = handoff
      ? " Your browser is paused for the captain: your browser commands refuse until the captain takes control and returns it, which wakes you once. End your turn when nothing else needs doing; report with waiting_on_captain naming this card."
      : "";
    const answer = (text: string) => `${text}${advisory}${pausedWords}`;
    // A revision that went up while the checks run says what still holds
    // the merge, and what to do once they pass.
    const gated = (risk?: RiskAssessment) =>
      (gate as Promise<"checked" | "running">).then((reading) => {
        const shown = publish(true, risk);
        return reading === "checked" ? shown : `${shown} ${COMPLETION_REVISED_WHILE_RUNNING}`;
      });
    if (riskDeclaration) {
      return gate
        ? gated({ declared: riskDeclaration }).then(answer)
        : answer(publish(false, { declared: riskDeclaration }));
    }
    if (paused) {
      return paused.then(() => (gate ? gated() : publish(false))).then(answer);
    }
    return gate ? gated().then(answer) : answer(publish(false));
  }

  /**
   * A crewmate's request that the captain take over its browser, as its
   * card declares it (`browser_handoff`, docs/task-browser.md "Asking for
   * help"): the site, why, and what it does after, each in its own words,
   * and exactly one action that opens the browser for him. An action that
   * opens it with no request is refused, and so is a request on a
   * completion card. The host reads none of the words.
   */
  private browserHandoffOf(
    actions: readonly DeclaredAction[],
    declared: EmittedCardInput["browserHandoff"],
  ): { site: string; reason: string; after: string } | undefined {
    if (actions.some((action) => action.effect?.kind === "open" && action.effect.savedSignIn)) {
      throw new Error(
        `Card refused: the saved sign-in choice is the host's to add, never a crewmate's. Declare only your own open-browser action; the host offers a saved sign-in beside it when ${HERE.this} has one for the site.`,
      );
    }
    const opens = actions.filter(
      (action) => action.effect?.kind === "open" && action.effect.target === "browser",
    );
    if (declared === undefined) {
      if (opens.length > 0) {
        throw new Error(
          "Card refused: an action that opens this task's browser for the captain needs browser_handoff - the site it is on, why you need the captain, and what you will do once control comes back.",
        );
      }
      return undefined;
    }
    const words = (text: unknown) =>
      typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
    const handoff = {
      site: words(declared.site),
      reason: words(declared.reason),
      after: words(declared.after),
    };
    if (
      !handoff.site ||
      !handoff.reason ||
      !handoff.after ||
      handoff.reason.length > TASK_BROWSER_REQUEST_MAX ||
      handoff.after.length > TASK_BROWSER_REQUEST_MAX
    ) {
      throw new Error(
        `Card refused: browser_handoff needs site, reason and after, each a short sentence of at most ${TASK_BROWSER_REQUEST_MAX} characters.`,
      );
    }
    if (opens.length !== 1) {
      throw new Error(
        'Card refused: a card with browser_handoff needs exactly one action whose effect is { kind: "open", target: "browser" }, labeled as the captain\'s step, such as Open browser and sign in.',
      );
    }
    if (actions.some((action) => settleEffectOf(action))) {
      throw new Error(
        "Card refused: a request for the captain to take over your browser is a decision of its own, never a completion card.",
      );
    }
    return handoff;
  }

  /**
   * A request card's actions once this Mac has a sign-in saved for its site
   * (docs/task-browser.md, "Saved sign-ins"): the host adds Use my saved
   * <site> sign-in as the default, and the crewmate's open-browser action
   * becomes Sign in myself beside it. The crewmate never learns which sites
   * are saved; without one its actions stand as it declared them.
   */
  private withSavedSignIn(
    taskId: string,
    site: string,
    actions: readonly EmittedAction[],
  ): EmittedAction[] {
    const saved = this.options.browsers?.savedSignInFor?.(taskId, site);
    if (!saved) return [...actions];
    const own = actions.map(({ default: _default, ...action }) =>
      action.effect?.kind === "open" && action.effect.target === "browser"
        ? { ...action, label: SIGN_IN_MYSELF_LABEL }
        : action,
    );
    return [
      ...own,
      {
        id: USE_SAVED_SIGN_IN_ACTION,
        label: savedSignInLabel(saved.site),
        default: true,
        effect: { kind: "open", target: "browser", savedSignIn: true },
      },
    ];
  }

  /** The host pauses the task's browser for the captain, or refuses the card in words. */
  private async pauseForCaptain(
    taskId: string,
    handoff: { site: string; reason: string; after: string },
  ): Promise<void> {
    const answer = await this.options.browsers?.requestHelp(taskId, handoff);
    if (!answer) throw new Error("Card refused: this task has no browser to hand over.");
    if (!answer.ok) throw new Error(`Card refused: ${answer.text}`);
  }

  /**
   * A crewmate's browser button as its card's live attachment
   * (docs/task-browser.md, "From a card"): the label it gave, and the
   * browser its task holds now - open, or stopped with Open again still
   * offered. Refused in words when the label is not one, or when the task
   * has no browser to open.
   */
  private browserAttachment(
    taskId: string,
    given: string | undefined,
    handoff: boolean,
  ): LiveAttachment | undefined {
    // A request for the captain's help always shows its browser: the site
    // it names comes from the host, never the card's words.
    const label = given ?? (handoff ? BROWSER_DOOR_LABEL : undefined);
    if (label === undefined) return undefined;
    const words = label.replace(/\s+/g, " ").trim();
    if (!words || words.length > LIVE_ATTACHMENT_LABEL_MAX) {
      throw new Error(
        `Card refused: browser_button is the label of one button, at most ${LIVE_ATTACHMENT_LABEL_MAX} characters, such as Try it or View booking.`,
      );
    }
    const fact = this.options.browsers?.fact(taskId);
    if (
      !fact ||
      fact.session === undefined ||
      fact.generation === undefined ||
      (fact.state === "stopped" && fact.stopped === "task-closed")
    ) {
      throw new Error(
        `Card refused: this task has no browser for browser_button to open. Open one with ${browserCommand("open <url>")} first, or emit the card without browser_button.`,
      );
    }
    if (handoff && fact.state !== "open") {
      throw new Error(
        `Card refused: this task's browser has stopped, so there is nothing to hand over. Open it with ${browserCommand("open <url>")} first.`,
      );
    }
    return {
      kind: "browser",
      label: words,
      taskId,
      session: fact.session,
      generation: fact.generation,
      ...(handoff ? { handoff: true as const } : {}),
    };
  }

  /**
   * A crewmate's browser button with a page (`browser_page`) as its card's
   * live attachment (docs/task-browser.md, "A page from the project"): the
   * label it gave and the path, once the host has found that file - an HTML
   * file reached through no link - in the task's working copy or its
   * project folder on this Mac. No browser need be open: the click opens
   * the page in the task's browser, checked again inside the project
   * folder, which is the only place it is served from. Refused in words
   * when the label is not one, the path is not a page, the card also asks
   * for help, the task has no project here, or the file is not there.
   */
  private pageAttachment(
    taskId: string,
    given: string | undefined,
    page: string,
    handoff: boolean,
  ): LiveAttachment {
    if (handoff) {
      throw new Error(
        "Card refused: browser_page opens a page for the captain to use, and browser_handoff asks for their help in the browser as it is: give one, on a card of its own.",
      );
    }
    const words = (given ?? "").replace(/\s+/g, " ").trim();
    if (!words || words.length > LIVE_ATTACHMENT_LABEL_MAX) {
      throw new Error(
        `Card refused: browser_page needs browser_button, the label of its button, at most ${LIVE_ATTACHMENT_LABEL_MAX} characters, such as Play.`,
      );
    }
    const path = page.trim();
    const rule = projectPagePathRefusal(path);
    if (rule) throw new Error(`Card refused: browser_page must name ${rule}.`);
    const record = this.options.tasks.get(taskId);
    const folder = record?.repoId ? this.options.repos.get(record.repoId)?.path : undefined;
    if (!record || !folder) {
      throw new Error(
        "Card refused: browser_page opens a page from your task's project, and this task has no project. Emit the card without browser_page.",
      );
    }
    if (record.deviceId) {
      throw new Error(
        `Card refused: browser_page opens a page from the project folder on ${HERE.this}, and this task runs on another computer. Emit the card without browser_page.`,
      );
    }
    const here = projectPageFile(record.worktreeDir, path, "your working copy");
    const there = "file" in here ? here : projectPageFile(folder, path);
    if ("refusal" in here && "refusal" in there) {
      throw new Error(
        `Card refused: browser_page found no page to open. ${here.refusal} ${there.refusal} Name the HTML file you built, relative to your working copy.`,
      );
    }
    return { kind: "page", label: words, taskId, path };
  }

  /**
   * A completion offer went up (FI3-304). It replaces any standing merge
   * approval - the crewmate is asking again - and, when its checks were
   * just read green, its offer is kept with the head they read: the
   * baseline a click on exactly that offer approves. An offer that shows
   * the same content at another head is ambiguous and keeps no baseline.
   */
  private recordCompletionOffer(
    taskId: string,
    cardId: string,
    checked: boolean,
    presentationRevision?: number,
  ): void {
    this.settle.endAuthorization(taskId, "superseded", "its crewmate put up a new completion card");
    const record = this.options.tasks.get(taskId);
    const offerId = this.cards.get(cardId)?.offerId;
    const head = record?.delivery?.headSha;
    const prNumber = record?.delivery?.prNumber;
    if (!checked || !record || !offerId || !head || prNumber === undefined) return;
    const offers = record.delivery?.completionOffers ?? [];
    const same = (offer: { cardId: string; offerId: string }) =>
      offer.cardId === cardId && offer.offerId === offerId;
    const rest = offers.filter((offer) => !same(offer));
    const ambiguous = offers.some((offer) => same(offer) && offer.headSha !== head);
    this.options.tasks.recordDelivery(taskId, {
      completionOffers: ambiguous
        ? rest
        : [
            ...rest,
            {
              cardId,
              offerId,
              headSha: head,
              prNumber,
              ...(presentationRevision
                ? {
                    presentationRevision,
                    presentationContentHash: record.delivery?.presentation?.published?.contentHash,
                  }
                : {}),
              at: this.now(),
            },
          ].slice(-4),
    });
  }

  /**
   * The completion card as the host finishes it (contract v3.6, captain lock
   * 3 of 2026-09-19 on the visual-density audit, 4.4b row 2). Until v3.5 the
   * crewmate descriptor spelled out the two buttons - their exact labels by
   * posture, the discard's `danger`, its `confirm` - and every Pi crewmate
   * dutifully transcribed facts the host already held, while the Claude
   * crewmates that never received the text got the label right 4 times in 8.
   * Now a crewmate declares the merge and nothing else: the host reads the
   * posture and writes the pair.
   *
   * `confirm` is deliberately NOT host-set. It means "the body already says
   * this branch has unlanded commits or uncommitted edits", which is a claim
   * about the body, not a fact the host holds - and setting it would discard
   * real work without the captain choosing. Left off, a discard that would
   * destroy something returns the structured `unlanded-work` refusal and its
   * ways out, which is the captain's confirmation (WI-12).
   *
   * The crewmate declares the merge without a label, as it is told
   * (FI3-249): every action the host keeps as declared needs words of its
   * own, and one without them refuses the card (`labeledActions`).
   */
  private mergeReviewOf(taskId: string, reviewId: string): MergeReview | undefined {
    return this.options.tasks
      .get(taskId)
      ?.delivery?.mergeReviews?.find((review) => review.id === reviewId);
  }

  /** A write this task's crewmate asked to send, by the id `github_write` answered with. */
  private writeAskOf(taskId: string, askId: string): WriteAsk | undefined {
    return this.options.tasks.get(taskId)?.delivery?.writeAsks?.find((ask) => ask.id === askId);
  }

  /**
   * The host's strip for a card whose button sends something where the
   * project lives (`./requestStrips.ts`): a kept write, or a merge past the
   * branch rules. Undefined for every other card.
   */
  private requestStrip(taskId: string, actions: readonly EmittedAction[]): string | undefined {
    for (const action of actions) {
      const write = requestWriteEffectOf(action);
      const ask = write ? this.writeAskOf(taskId, write.ask) : undefined;
      if (ask) return writeAskStrip(ask);
      const merge = requestMergeEffectOf(action);
      const review = merge ? this.mergeReviewOf(taskId, merge.review) : undefined;
      if (review?.skips) {
        return skipRulesStrip(
          review,
          forgePlace({ kind: "github", host: review.host }) ?? "GitHub",
        );
      }
    }
    return undefined;
  }

  private withCompletionActions(taskId: string, input: DeclaredCardInput): EmittedCardInput {
    const actions = input.actions ?? [];
    if (actions.some((action) => requestWriteEffectOf(action))) {
      // The host names the send, after where it goes (FI3-1571 piece 4); the
      // crewmate's own Not now stays beside it.
      const labeled = actions.map((action) => {
        const effect = requestWriteEffectOf(action);
        if (!effect) return action;
        const ask = this.writeAskOf(taskId, effect.ask);
        return {
          ...action,
          id: action.id || "send",
          label: sendWriteWords(ask?.place ?? "GitHub"),
          default: true,
          effect,
        };
      });
      return { ...input, actions: labeledActions(labeled) };
    }
    if (actions.some((action) => requestMergeEffectOf(action))) {
      // A request is not a completion pair. The host names the button; it
      // does not add Discard, which would close a task watching someone else's pull request.
      const labeled = actions.map((action) => {
        const effect = requestMergeEffectOf(action);
        if (!effect) return action;
        return {
          ...action,
          id: action.id || "merge",
          label: this.mergeReviewOf(taskId, effect.review)?.skips
            ? SKIP_RULES_MERGE_WORDS
            : MERGE_WORDS["merge-pr"],
          default: true,
          effect,
        };
      });
      return { ...input, actions: labeledActions(labeled) };
    }
    if (!actions.some((action) => settleEffectOf(action)?.mode === "merge")) {
      return { ...input, actions: labeledActions(actions) };
    }
    // Only the SETTLE actions are the host's. A card still carries exactly
    // the other actions its author declared (cards/tasks/agents P0): a
    // crewmate's own deferral, or a question it wants answered with the
    // merge, is its offer to make and comes back to it on the click.
    const declared = labeledActions(actions.filter((action) => !settleEffectOf(action)));
    const merge: EmittedAction = {
      id: "merge",
      label: MERGE_WORDS[this.mergeModeFor(taskId)],
      default: true,
      effect: { kind: "settle", mode: "merge" },
    };
    const discard: EmittedAction = {
      id: "discard",
      label: "Discard",
      danger: true,
      effect: { kind: "settle", mode: "discard" },
    };
    // A Quick or Default pull request can be made Careful from its merge
    // card (INF-562): drawn between Discard and Merge, so it takes ⌘2.
    const careful: EmittedAction[] = this.offersCareful(taskId)
      ? [{ id: "review-carefully", label: REVIEW_CAREFULLY_WORDS, care: "reviewed" }]
      : [];
    return { ...input, actions: [...declared, merge, discard, ...careful] };
  }

  /**
   * Whether a task's merge card offers Review carefully: pull-request work
   * the captain merges himself, below Careful. Local merges, work that
   * merges on its own and a Careful task get no button.
   */
  private offersCareful(taskId: string): boolean {
    if (this.mergeModeFor(taskId) !== "merge-pr") return false;
    const policies = this.policiesOf(this.options.tasks.get(taskId));
    return policies !== null && !policies.autonomy.value && policies.rigor.value !== "reviewed";
  }

  /**
   * Whether a task's own crewmate is still the one that emits its completion
   * card (contract v3.6, captain lock 3; audit 4.4b row 9). True while the
   * work is active on a posture that settles at all and no completion card
   * has been emitted on it yet - which is exactly the window in which a
   * Firstmate merge card would duplicate the one the crewmate is about to
   * write. Once that card exists the window closes: a settle refusal's ways
   * out are then a legitimate Firstmate card on the same task.
   */
  crewmateOwesCompletion(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    if (record?.status !== "active" || record.kind !== "work") return false;
    if (record.shape?.kind === "review" || this.isPersonalTask(taskId)) return false;
    if (record.shape?.in_place) return false;
    // An answer task emits no completion card at all (Task B): it ships
    // nothing, so nobody owes one.
    if (this.deliverableOf(record) === "answer") return false;
    return !this.cards.hasCompletionCard(taskId);
  }

  /**
   * The standing CI rule's counterpart for a crewmate's own completion card
   * (FIRSTMATE_PROMPT_CORE: "Not green: ... no captain card. ... Otherwise
   * the crewmate's completion card is the decision"). That rule only fires
   * when the Firstmate agent processes a crewmate's `report`; a completion
   * card reaches the captain straight through `emit_card`, on the
   * crewmate's own turn, without passing through the Firstmate at all - so
   * without this, a card carrying a merge default could show "CI not yet
   * checked" right alongside a captain review it never should have reached.
   * Runs the same live check_pr_ci lookup right before publish, so a stale
   * or missing reading can never let a red or pending build masquerade as a
   * ready review. Returns undefined (no gate) when `checkCi` is not wired
   * (tests, replay) or the card carries no merge decision on a direct-pr
   * task; otherwise a promise that resolves `checked` once CI reads green,
   * or rejects with the tool's refusal text.
   *
   * One exception (INF-834 friction 4): a revision of the completion card
   * already on the captain's stack goes up while the checks still run, so
   * his reply is answered in the card's own words at once. It resolves
   * `running`: the revision's offer is kept at the version whose checks
   * run, so its button reads Merge when checks pass and a click waits on
   * them (`mergeLabel`, the kept approval); a new card still waits for green.
   */
  private pendingCiGate(
    taskId: string,
    input: EmittedCardInput,
  ): Promise<"checked" | "running"> | undefined {
    const requested = input.actions.map((action) => requestMergeEffectOf(action)).find(Boolean);
    if (requested) {
      if (!this.options.reviewGate) return undefined;
      const reviewId = requested.review;
      return this.options.reviewGate(taskId, reviewId).then((refusal) => {
        if (refusal) throw new CardRefusedError(refusal, "checks", refusal);
        return "checked" as const;
      });
    }
    const carriesMerge = input.actions.some((action) => settleEffectOf(action)?.mode === "merge");
    if (!carriesMerge || this.taskDelivery(taskId) !== "direct-pr") return undefined;
    // The CI cap holds the card whatever CI says now (phase 3): the record
    // is what the captain's decision is about, and a green after the cap
    // is a fourth round, not an answer. Checked before the live reading so
    // a held card costs no gh call, and again after it, because the
    // reading that just landed may be the round that reached the cap.
    const held = this.ciCapRefusal(taskId);
    if (held) return Promise.reject(held);
    if (!this.options.checkCi) return undefined;
    return this.options.checkCi(taskId).then((overall) => {
      const capped = this.ciCapRefusal(taskId);
      if (capped) throw capped;
      // A pull request merged outside the app has nothing left to check:
      // the captain's click closes the task as merged (FI3-213).
      if (overall === "green" || overall === "merged") return "checked";
      // The captain's override on the checks lets the card go up at the
      // version it covers; the merge reads the same record.
      const delivery = this.options.tasks.get(taskId)?.delivery;
      if (overall !== "no-pr" && overridePasses(delivery, "checks", delivery?.headSha))
        return "checked";
      if (overall === "pending" && this.cards.openCompletionCard(taskId, input.id))
        return "running";
      const state = overall === "no-pr" ? "nothing - no open PR was found" : CHECK_WORDS[overall];
      throw new CardRefusedError(
        `Card refused: the checks read ${state}, not passed; a merge decision must wait. Re-check them with the repository's own check tools, fix or wait, and emit the completion card again once they pass.${this.waitingReplyNote(taskId)}${overall === "no-pr" ? "" : ` ${softHoldWords("checks", "crewmate")}`}`,
        "checks",
        overall === "no-pr"
          ? "no open pull request was found for its branch"
          : `its checks read ${state}, not passed`,
      );
    });
  }

  /**
   * The checks hold a completion card back while the captain's reply under
   * one of the task's cards still waits for its author (FI3-643): the
   * refusal asks for the thread answer now, so his reply is not left
   * silent until they pass. The card itself waits for them.
   */
  private waitingReplyNote(taskId: string): string {
    return this.cards.threadAwaitingAuthor(taskId)
      ? " The captain's reply in your card's thread is still unanswered: answer it now with reply, in one line saying what you did and who goes next, and update the card once the checks pass."
      : "";
  }

  /**
   * The card tool refused this task's completion card (FI3-401). The
   * refusal stands on the record until a completion card goes up, and the
   * report wake and `crew_status` carry it, so a report that says the card
   * went up is read beside the fact that it did not. A task that has no
   * completion card - the personal workspace, an answer task - or one
   * already closed records nothing: its refusal already says so.
   */
  private recordCardRefusal(task: TaskRuntime, refusal: Omit<CardRefusal, "at">): void {
    const record = this.options.tasks.get(task.id);
    if (!record || TaskService.isClosed(record)) return;
    if (this.isPersonalTask(task.id) || this.deliverableOf(record) === "answer") return;
    if (record.shape?.in_place) return;
    this.options.tasks.recordCardRefusal(task.id, refusal);
  }

  /** The completion card's refusal while the CI cap holds, or undefined. */
  private ciCapRefusal(taskId: string): CardRefusedError | undefined {
    const delivery = this.options.tasks.get(taskId)?.delivery;
    if (delivery?.ciCapAt === undefined) return undefined;
    if (overridePasses(delivery, "repairs", delivery.headSha)) return undefined;
    const rounds = delivery.ciRounds ?? CI_ROUND_CAP;
    return new CardRefusedError(
      `Card refused: this task hit its CI cap - ${rounds} own repairs failed (the cap is ${CI_ROUND_CAP}) - so its completion card is held, even with CI green now, until the captain answers the decision card on it and the first mate steers you with the answer. Report where CI stands with report and wait for that steer. ${softHoldWords("repairs", "crewmate")}`,
      "ci-cap",
      `it hit its CI cap (${rounds} own repairs failed), so the card is held until the captain answers`,
    );
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
    leavesStack = false,
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
    const text = withPastedFiles(typed, files);
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
    const toFirstmate =
      card.author === "firstmate" || (closedTask !== undefined && TaskService.isClosed(closedTask));
    // An accepted reply to a crewmate owns copies of its pictures before the
    // thread or the lane records it (the Firstmate's own turn keeps its own).
    const kept =
      hasImages && !toFirstmate && card.taskId ? keepImages(randomUUID(), images ?? []) : undefined;
    this.cards.addMessage(
      id,
      "captain",
      shown || "sent a picture",
      submission,
      answers,
      undefined,
      leavesStack,
    );
    if (toFirstmate) {
      this.hooks.converseAboutCard?.(id, context, hasImages ? images : undefined);
      return this.cards.thread(id);
    }
    const taskId = card.taskId;
    if (taskId) {
      // The card waits off the stack until its author answers and
      // closes out; this one line is what the captain sees meanwhile (the captain's Q2
      // A). The card's return is its own notice.
      const crewmate = this.tasks.get(taskId)?.crewmate ?? "the crewmate";
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: askedUnderCardLine(crewmate, card.title),
      });
      const reply: TypedWake = {
        facts: {
          kind: "thread-reply",
          card: { id: card.id, title: card.title },
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
    this.settle.releaseSettleBoundary(task.id);
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
      this.settle.closeRecord(task.id, status, error, "host", typed);
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

  /**
   * Lands a finished task's branch (captain decision Q5): a forge-agnostic
   * local merge through the workspace service, then the task CLOSES as
   * done/landed - the record and its session JSONL stay (captain decision
   * D2), only the worktree and branch go. Fail closed: the reason returns
   * to the caller; the supervisor never mints a card.
   */
  landTask(taskId: string, actor: "captain" | "firstmate" = "firstmate"): Promise<string> {
    return this.settleTask(taskId, "land", undefined, actor);
  }

  /** Put a direct-PR task's change in where the project lives, then close it and remove its worktree. */
  mergePrTask(taskId: string, actor: "captain" | "firstmate" = "firstmate"): Promise<string> {
    return this.settleTask(taskId, "merge-pr", undefined, actor);
  }

  /**
   * Conversational merge-pr / land / discard. Fail-closed reasons return as
   * the result text so Firstmate can judge the standing card rule; this
   * method never mints a card.
   */
  settleTask(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm?: boolean,
    actor: "captain" | "firstmate" = "firstmate",
    proceedWithOpen = false,
  ): Promise<string> {
    return this.settle.settleTask(taskId, mode, confirm, actor, proceedWithOpen);
  }

  /**
   * One of the first mate's settles with its closing sentence (INF-547):
   * the close it makes carries the sentence.
   */
  withClosingSentence<T>(taskId: string, sentence: string, run: () => Promise<T>): Promise<T> {
    return this.settle.withClosingSentence(taskId, sentence, run);
  }

  /** The settle a tool runs (WI-12): its prose, and the structured refusal when there is one. */
  settleTaskDetailed(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm?: boolean,
    proceedWithOpen?: boolean,
    actor: "captain" | "firstmate" = "firstmate",
  ): Promise<{ text: string; refusal?: SettleRefusal }> {
    return this.settle.settleTaskDetailed(taskId, mode, confirm, proceedWithOpen, actor);
  }

  /** A verified external release closes work without a task-owned change. */
  closeExternallyReleased(taskRef: string, releaseEvidence: string) {
    return this.settle.closeExternallyReleased(taskRef, releaseEvidence);
  }

  /** settle_task mode `answered`: an internal step's answer carried on in a live task. */
  closeAnswerUsedAsBasis(taskRef: string): Promise<{ ok: boolean; text: string }> {
    return this.settle.closeAnswerUsedAsBasis(taskRef);
  }

  /** A user-initiated discard from a leftover task card, or the shell's delete. */
  requestDiscard(taskId: string): Promise<void> {
    return this.settle.requestDiscard(taskId);
  }

  /** Settle a task: the crewmate stops, and the record, lane, cards and worktree close. */
  closeTask(taskId: string, close: TaskClose): Promise<void> {
    return this.settle.closeTask(taskId, close);
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
    if (session?.isStreaming()) {
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
    runtime.unsubscribe?.();
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
    if (!record.model) {
      this.options.tasks.recordServedModel(task.id, event.model);
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
    this.options.tasks.recordServedModel(task.id, event.model, {
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
   * What the host knows about a settle card's task and writes on the card
   * itself (contract v2.0, captain ruling D4; restyled at v2.7 as the fact
   * strip by the captain's design pass, 2026-09-19): the project, the
   * crewmate's model, the task's effective care, the PR link, and the CI
   * reading check_pr_ci recorded - facts the host holds at emit time, so
   * the crewmate's completion card and any Firstmate settle card need not
   * repeat them and cannot get them wrong. Each fact is one labeled
   * single-line cell (`.inf-facts`, frameStylesheet.ts); what a merge does,
   * the CI reading's age, and the review's risk note ride the cells'
   * `title` attributes, never lines of their own (the captain's call).
   * Returns an HTML fragment, or undefined when the task is unknown.
   */
  private settleFacts(taskId: string): string | undefined {
    const record = this.options.tasks.get(taskId);
    if (!record) return undefined;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const delivery = this.taskDelivery(taskId) ?? "local-only";
    const cells: string[] = [];
    // Each cell names its fact in `data-fact`, so a reader finds a fact by
    // what it is, never by its label's words.
    const cell = (fact: SettleFact, label: string, value: string, title?: string) =>
      cells.push(
        `<span class="inf-fact" data-fact="${fact}"${title ? ` title="${escapeCardText(title)}"` : ""}><span class="inf-fact-k">${label}</span><span class="${SETTLE_FACT_VALUE_CLASS}">${value}</span></span>`,
      );
    cell("project", "Project", repo ? escapeCardText(repo.name) : DEFAULT_WORKSPACE_WORD);
    // Where it runs, right after the project, for a task on a computer that
    // runs work (design skill `components/devices/RunsOn`).
    const place = record.deviceId ? this.options.machines?.placeOf(record.deviceId) : undefined;
    if (place) cell("device", "Runs", escapeCardText(place.where));
    // The model that built the work, named right after the project
    // (captain, 2026-09-19): the task record's model - what the session
    // reported at dispatch, kept current when the backend moved the work to
    // another (`recordServedModel`) - by the one model-name lookup with the
    // raw id as fallback, never the newest routing choice, which can
    // disagree with what actually served (review F1). Labelled Model, as
    // every surface labels a model (FI3-565 piece 2).
    if (record.model) {
      const slash = record.model.indexOf("/");
      const ref =
        slash > 0
          ? { provider: record.model.slice(0, slash), id: record.model.slice(slash + 1) }
          : undefined;
      const label = ref ? (this.options.router?.modelLabel(ref) ?? ref.id) : record.model;
      cell("crewmate", "Model", escapeCardText(label));
    }
    // The stamped tier is the care this task actually ran at, including
    // the captain's per-task ask, not the project's standing setting.
    const policies = this.policiesOf(record);
    if (policies) cell("care", "Care", CARE_WORDS[policies.rigor.value]);
    // The change by the forge's own label (`#N`, or the sent-up branch) and
    // its page where the host has one - never parsed back out of a link.
    const changeLabel =
      record.delivery?.changeLabel ??
      (record.delivery?.prNumber !== undefined ? `#${record.delivery.prNumber}` : undefined);
    const prUrl = record.delivery?.prUrl;
    const link = prUrl && /^https:\/\//.test(prUrl) ? escapeCardText(prUrl) : undefined;
    if (changeLabel || link) {
      const label = escapeCardText(changeLabel ?? (prUrl as string));
      cell(
        "change",
        record.delivery?.prNumber !== undefined ? "Pull request" : "Branch",
        link ? `<a href="${link}">${label}</a>` : label,
      );
    }
    const ci = record.delivery?.ci;
    const ciAt = record.delivery?.ciAt;
    if (ci && ciAt !== undefined) {
      // How long the checks ran or took and how long ago they finished, in
      // the open; when they started and when the app last read them, on
      // rest (INF-587). The host rewrites the strip on every tick, so both
      // ages stay current while the card is up.
      const span = record.delivery ? checksSpanOf(record.delivery) : null;
      const words = CHECK_WORDS[ci] ?? ci;
      const dot =
        ci === "green" || ci === "merged"
          ? "ok"
          : ci === "red"
            ? "failed"
            : ci === "pending"
              ? "running"
              : "idle";
      cell(
        "checks",
        "Checks",
        `${statusDot(dot)}${span ? checksSpanWords(words, span, this.now()) : words}${span?.finishedAt != null ? ` · ${checksFinishedAgo(span.finishedAt, this.now())}` : ""}`,
        checksRestWords(span, ciAt),
      );
    } else if (delivery === "direct-pr") {
      cell("checks", "Checks", `${statusDot("idle")}${CHECKS_NOT_READ_WORDS}`);
    }
    // What the host is holding on this task, drawn from its own records
    // (contract v3.6, captain lock 3): the rounds each cap counts and the
    // head CI last went red on. The prompts used to ask an agent to type a
    // count it cannot see; here the captain reads it off the card.
    const rounds = record.delivery;
    if (rounds?.ciRounds) {
      const red = rounds.ciRedHead ? ` at ${rounds.ciRedHead.slice(0, 7)}` : "";
      cell(
        "check-rounds",
        "Check rounds",
        `${rounds.ciCapAt !== undefined ? statusDot("failed") : ""}${rounds.ciRounds}/${CI_ROUND_CAP}`,
        rounds.ciCapAt !== undefined
          ? `held at the cap; the checks last failed${red}`
          : `unsuccessful tries at getting the checks to pass${red}`,
      );
    }
    if (rounds?.reviewRounds) {
      cell(
        "look-rounds",
        "Look rounds",
        `${rounds.reviewCapAt !== undefined ? statusDot("failed") : ""}${rounds.reviewRounds}/${REVIEW_ROUND_CAP}`,
        rounds.reviewCapAt !== undefined
          ? "held at the cap"
          : "rounds of findings this change has spent",
      );
    }
    // The independent review's word on a reviewed task (delivery rigor
    // phase 2): the verdict and the head it read, the risk beside CI and
    // never a hold (Q4), or where the review stands while it is live.
    if (this.policiesOf(record)?.rigor.value === "reviewed") {
      const review = record.delivery;
      if (review?.reviewVerdict) {
        const at = review.reviewSha
          ? ` <span class="inf-mono">${escapeCardText(review.reviewSha.slice(0, 7))}</span>`
          : "";
        const risk = review.reviewRisk ? ` · risk ${review.reviewRisk}` : "";
        cell(
          "review",
          "Review",
          `${statusDot(review.reviewVerdict === "pass" ? "ok" : review.reviewVerdict === "blocked" ? "failed" : "warn")}${REVIEW_WORDS[review.reviewVerdict]}${at}${risk}`,
          review.reviewRiskNote,
        );
      } else if (this.openReviewOf(record.id)) {
        cell("review", "Review", `${statusDot("running")}open`);
      } else {
        cell("review", "Review", `${statusDot("idle")}awaiting`);
      }
    }
    // The captain's standing override (docs/delivery-rigor.md, "The
    // holds"): what his words passed, with his words and how long on rest.
    // A merge that went without the review or its live proof says so here.
    // One for an earlier version passes nothing now, so it shows nothing.
    const override = record.delivery?.override;
    if (override && (override.until === "task" || override.head === record.delivery?.headSha)) {
      cell(
        "override",
        "Override",
        `${statusDot("warn")}${escapeCardText(overrideCellWords(override.holds))}`,
        `${overrideWords(override)}${override.holds.includes("live-proof") ? `. ${LIVE_VALIDATION_WORDS.exception}.` : ""}`,
      );
    }
    return `${SETTLE_FACTS_OPEN}${cells.join("")}</div>`;
  }

  /**
   * What a settle card must say about work the crew filed under this task's
   * name (captain, 2026-09-14; rows by FI3-430's plan): follow-ups are
   * planned work the captain never chose, and the decision to land is the
   * one moment they bear on it. Returns an HTML fragment - a micro label
   * and one row per open follow-up (key, title, one word) - or undefined
   * when there are none. The word comes from the record's links and status,
   * never the title: this merge waits on it (`blocks_me`), it waits for
   * this merge, a crewmate is on it, or it is queued or in the backlog by its
   * start policy. Each row's `title` attribute is the full sentence.
   */
  private followupNotice(taskId: string): string | undefined {
    const holding = new Set(
      this.options.tasks.blockersHoldingClose(taskId).map((blocker) => blocker.id),
    );
    const waiting = new Set(this.options.tasks.blocking(taskId).map((task) => task.id));
    const rows = this.options.tasks
      .discoveredFrom(taskId)
      .filter((followUp) => !TaskService.isClosed(followUp))
      .map((followUp) => {
        const state = holding.has(followUp.id)
          ? "hold"
          : waiting.has(followUp.id)
            ? "after"
            : followUp.status === "active"
              ? "working"
              : followUp.startPolicy === "on-request"
                ? "backlog"
                : "queued";
        return { followUp, state: state as FollowupState };
      })
      .map((row, index) => ({ ...row, index }))
      .sort(
        (a, b) =>
          FOLLOWUP_STATES.indexOf(a.state) - FOLLOWUP_STATES.indexOf(b.state) || a.index - b.index,
      );
    if (rows.length === 0) return undefined;
    const html = rows
      .map(({ followUp, state }) => {
        const { word, sentence } = FOLLOWUP_WORDS[state];
        const mark = state === "hold" ? statusDot("warn") : "";
        return `<div class="inf-followup" data-followup="${state}" title="${escapeCardText(sentence)}"><span class="inf-followup-key">${escapeCardText(followUp.key || followUp.id)}</span><span class="inf-followup-title">${escapeCardText(followUp.title)}</span><span class="inf-followup-word">${mark}${word}</span></div>`;
      })
      .join("");
    return `<div class="inf-followups" data-followups><div class="inf-followups-k">Filed while working on this</div>${html}</div>`;
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
      if ((await this.settle.retireWorkspace(record.id, { noteKept: false })) === "kept")
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
  }

  /** External activity proof for a task (a running R2 job reporting in). */
  taskActivity(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) this.noteTaskActivity(task);
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
      // A held lane keeps it until its account serves again.
      if (this.laneHeld(taskId)) return;
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
      ticker.register("in-place-folders", WATCHDOG_TICK_MS, () => void this.closeCurrentFolders()),
      ticker.register("check-watch", WATCHDOG_TICK_MS, (now) => void this.pollCheckWatches(now)),
      ticker.register("kept-merges", WATCHDOG_TICK_MS, (now) =>
        this.settle.reconcileMergeAuthorizations(now),
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
  async sweepInbox(now: number): Promise<void> {
    if (this.sweepingInbox) return;
    this.sweepingInbox = true;
    try {
      for (const recipient of this.options.inbox.recipientsWithRows()) {
        // The firstmate lane is the agent's own to drain; the tick pokes it
        // separately (startWatchdog). The retired supervision lane is
        // skipped so leftover rows are never swept as a task's - boot
        // reassigns them to the Firstmate instead (S7c, `services.ts`).
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
    if (record?.kind !== "work" || !TaskService.isResumable(record) || !record.sessionFile) {
      this.orphanTaskGuidance(taskId, record);
      return;
    }
    if (this.retiredProviderOf(taskId)) {
      // Its session belongs to a subscription this build no longer offers:
      // no backend can reopen it, so the guidance is kept, not retried.
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
    } catch {
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
   * One watchdog pass. Escalation only, never an automatic interrupt: a
   * quiet streaming task earns a feed line at ten minutes and a wake with
   * the choices at twenty; a turn past the wall-clock bound escalates once
   * more. The Firstmate holds interrupt_crewmate, so the wake is the whole
   * escalation - no host card (cards/tasks/agents P0, WI-3).
   */
  checkQuietTasks(now: number): void {
    for (const task of this.tasks.values()) {
      if (task.state !== "streaming" && task.state !== "starting") continue;
      // A turn on a computer out of reach goes on there, unseen here: not stuck.
      if (this.outOfReach(task.id)) continue;
      // A running background job is proof of life (R2): a quiet turn that
      // is waiting on its own build is not stuck.
      if (this.options.hasRunningJobs?.(task.id)) continue;
      const quietFor = now - task.lastEventAt;
      const minutes = Math.round(quietFor / 60_000);
      if (quietFor >= QUIET_CARD_MS && task.quietLevel < 2) {
        task.quietLevel = 2;
        this.options.tasks.note(task.id, `quiet for ${minutes} minutes; may be stuck`, {
          news: true,
        });
        this.routeCrewEvent(
          task.id,
          {
            facts: {
              kind: "quiet",
              task: { id: task.id, title: task.title },
              crewmate: task.crewmate,
              minutes,
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
      if (now - task.turnStartedAt >= TURN_WALL_CLOCK_MS && !task.wallClockEscalated) {
        task.wallClockEscalated = true;
        const hours = Math.round(((now - task.turnStartedAt) / 3_600_000) * 10) / 10;
        this.routeCrewEvent(
          task.id,
          {
            facts: {
              kind: "long-turn",
              task: { id: task.id, title: task.title },
              crewmate: task.crewmate,
              hours,
            },
          },
          "agent",
        );
      }
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
    if (task?.session) this.carryRestart(task, this.machineOf(taskId), task.session);
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

  /** The idle reconciler over every live idle record (docs/report-sort.md; idleLadder.ts). */
  reconcileIdle(now: number): void {
    this.ladder.reconcileIdle(now);
  }

  /** Resume work paused by a typed GitHub askpass/auth refusal after sign-in. */
  async resumeForgeSignInTasks(host: string): Promise<void> {
    const ref = `forge-sign-in:${host}`;
    for (const record of this.options.tasks.listOpen()) {
      if (record.kind !== "work" || record.gate?.ref !== ref) continue;
      this.options.tasks.setGate(record.id, null, "the GitHub sign-in is ready");
      await this.dispatchQueuedTask(record.id);
    }
  }

  /**
   * The ready sweep over open and active rows (docs/task-graph.md; the
   * ladder's `sweepGates`). Runs on the shared tick, after any close, after
   * a graph change, on quota refresh, and once at boot.
   */
  async sweepGates(now: number): Promise<void> {
    this.cards.fileMissingHostCardTasks();
    for (const record of this.options.tasks.listOpen()) {
      const action = record.delivery?.captainAction;
      if (
        action &&
        this.options.tasks.captainActionReady(record.id) &&
        (action.presentedGeneration < action.generation || action.state === "blocked")
      )
        this.showRequiredAction(record.id);
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
   * A container completes with its children (docs/task-graph.md, "The
   * close rules"). A parent that never started - on request, no crewmate,
   * no working copy - has nothing of its own to settle, so nothing else
   * could ever close it; once every child is closed it closes too: done
   * when any child is done, else dropped. A parent that carries a
   * crewmate, ever started, still has an open child, or has a card of its
   * own waiting on the captain is left exactly as it is.
   */
  private completeContainers(): void {
    for (const record of this.options.tasks.listOpen()) {
      if (record.kind !== "work" || record.startPolicy !== "on-request") continue;
      if (record.startedAt !== null || record.worktreeDir || this.tasks.has(record.id)) continue;
      // A program closes when its script ends, not when its parts so far have.
      if (record.shape?.program) continue;
      const children = this.options.tasks.children(record.id);
      if (children.length === 0 || children.some((child) => !TaskService.isClosed(child))) {
        continue;
      }
      if (this.cards.snapshot().some((card) => card.taskId === record.id)) continue;
      const done = children.some((child) => child.status === "done");
      this.settle.closeAndPurge([record.id], () =>
        this.options.tasks.close(record.id, {
          status: done ? "done" : "dropped",
          reason: done ? "finished" : "cancelled",
          actor: "host",
          text: done ? "everything under it is finished" : "nothing under it went ahead",
          data: { container: true },
        }),
      );
      this.broadcastCrewCounts();
    }
  }

  // ---- the graph (P2) -----------------------------------------------------

  /**
   * link_tasks: a typed edge between two records, ids or keys. A `blocks`
   * edge that would close a cycle is refused as tool text (never thrown),
   * and any change re-runs the ready query.
   */
  linkTasks(fromRef: string, toRef: string, type: TaskLinkType): string {
    const from = this.resolveTaskRef(fromRef, "from");
    const to = this.resolveTaskRef(toRef, "to");
    let created: boolean;
    try {
      created = this.options.tasks.link(from.id, to.id, type, "firstmate");
    } catch (caught) {
      if (caught instanceof TaskGraphRefusal) return caught.message;
      throw caught;
    }
    const phrase = linkPhrase(from, to, type);
    if (!created) return `${phrase} was already recorded.`;
    // Its tasks changed, though neither crewmate hears it: each sparks.
    this.announceReach(from.id);
    this.announceReach(to.id);
    this.graphChanged();
    return `Recorded: ${phrase}.`;
  }

  /**
   * link_tasks with remove: the edge goes, and the ready query judges the
   * row again on the sweep - a dead wait ends with its edge, nothing to
   * lift.
   */
  unlinkTasks(fromRef: string, toRef: string, type: TaskLinkType): string {
    const from = this.resolveTaskRef(fromRef, "from");
    const to = this.resolveTaskRef(toRef, "to");
    const removed = this.options.tasks.unlink(from.id, to.id, type, "firstmate");
    const phrase = linkPhrase(from, to, type);
    if (!removed) return `No such link: ${phrase}.`;
    this.announceReach(from.id);
    this.announceReach(to.id);
    this.graphChanged();
    return `Removed: ${phrase}.`;
  }

  /** A graph or field change: counts move, and the ready query runs again. */
  graphChanged(): void {
    this.broadcastCrewCounts();
    void this.sweepGates(this.now());
  }

  /**
   * update_task drop: an open row (planned or queued work) closes as
   * dropped. A parent with open children needs `confirm`, which drops
   * them too as superseded (design section 7). Work a crewmate holds is
   * settle_task's business - it has the unlanded-work guard - so this
   * refuses rather than tearing a worktree down from a field edit.
   * `replacedBy` names the task that does its work instead, linked
   * `replaced-by` before the close (docs/task-record.md, "Whom an event
   * concerns").
   */
  dropTask(
    taskRef: string,
    input: { reason: string; confirm?: boolean; replacedBy?: string },
  ): string {
    const record = this.resolveTaskRef(taskRef, "task");
    const replacement = input.replacedBy
      ? this.resolveTaskRef(input.replacedBy, "replaced_by")
      : undefined;
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.status !== "open") {
      return record.status === "active"
        ? `Cannot drop ${handle} here: a crewmate holds it. Use settle_task (discard) for work that has started.`
        : `${handle} is already ${describeStatus(record)}.`;
    }
    const started = this.options.tasks
      .descendants(record.id)
      .filter((child) => child.status === "active");
    if (record.shape?.program) {
      // With no part started, the close below may refuse for its open parts: then the program runs on.
      const refusal = started.length === 0 ? this.options.tasks.closeRefusal(record.id) : undefined;
      if (refusal && !input.confirm) return refusal.text;
      // A dropped program stops at once and files nothing more; its started
      // parts close first, their work saved, and then it drops (INF-799).
      this.programs.halt(record.id);
      if (started.length > 0) {
        void (async () => {
          for (const part of started)
            await this.settle.closeTask(part.id, {
              status: "dropped",
              reason: "superseded",
              actor: "firstmate",
              text: "superseded - its program was dropped",
            });
          this.dropTask(record.id, { ...input, confirm: true });
        })().catch((caught: unknown) => console.warn("[program] drop did not finish:", caught));
        const names = started.map((child) => child.key || child.id).join(", ");
        return `Dropping ${handle}: its program stopped, and its started ${started.length === 1 ? "part" : "parts"} ${names} close first, their work saved.`;
      }
    }
    if (started.length > 0) {
      const names = started.map((child) => `${child.key || child.id} "${child.title}"`).join(", ");
      return `Cannot drop ${handle}: ${started.length === 1 ? "its child has" : "children have"} started (${names}). Settle them first.`;
    }
    const refusal = this.options.tasks.closeRefusal(record.id);
    if (refusal && !input.confirm) return refusal.text;
    const affected = [record.id, ...this.options.tasks.descendants(record.id).map((c) => c.id)];
    const dropped = this.settle.closeAndPurge(affected, () =>
      this.options.tasks.dropWithChildren(record.id, {
        reason: input.reason,
        actor: "firstmate",
        ...(replacement ? { replacedBy: replacement.id } : {}),
      }),
    );
    this.cards.retireTaskCards(record.id, "dropped");
    for (const child of dropped) this.cards.retireTaskCards(child.id, "superseded");
    this.options.broadcastEvent({
      type: "firstmate_note",
      text:
        dropped.length > 0
          ? `Dropped "${record.title}" (${record.key}) and ${dropped.length} ${dropped.length === 1 ? "child" : "children"} under it - ${input.reason}.`
          : `Dropped "${record.title}" (${record.key}) - ${input.reason}.`,
    });
    this.cards.scheduleBroadcast();
    this.graphChanged();
    const replaces = replacement ? ` ${replacement.key || replacement.id} replaces it.` : "";
    return dropped.length > 0
      ? `Dropped ${handle} and ${dropped.map((child) => child.key || child.id).join(", ")} as superseded.${replaces}`
      : `Dropped ${handle}.${replaces}`;
  }

  /**
   * file_followup (design section 7): the crewmate found work it should not
   * do itself. The record files it as an on-request task of its own,
   * discovered-from the crewmate's task but never a child of it: a row, a
   * link, and one feed line - never a card and never a wake of its own
   * (cards/tasks/agents P0, WI-4). The Firstmate hears about it with the
   * report that ends this turn and triages it there, deciding whether the
   * follow-up runs now, later, or not at all. Only `blocks_me` holds the
   * origin up, and then the origin's settle says which task and why.
   */
  private fileFollowup(task: TaskRuntime, input: FollowupInput): string {
    const origin = this.options.tasks.get(task.id);
    if (!origin) throw new Error(`Task ${task.id} no longer exists.`);
    const title = input.title.trim().slice(0, 64);
    const goal = input.goal.trim();
    const why = input.why.trim();
    if (!title) throw new Error("title is required.");
    if (!goal) throw new Error("goal is required: one sentence saying what done looks like.");
    if (!why) throw new Error("why is required: what you found that makes this follow-up needed.");
    const personal = this.isPersonalTask(task.id);
    // The follow-up's own posture, never the origin's: an ask made of the
    // origin is not one made of it (FI3-733). It is written again at start.
    const repo = origin.repoId ? this.options.repos.get(origin.repoId) : undefined;
    const delivery = personal ? undefined : deliveryFor({ repo: repo?.delivery }).delivery;
    const filed = this.options.tasks.fileFollowup({
      id: randomUUID().slice(0, 8),
      originId: origin.id,
      title,
      goal,
      why,
      prompt: renderFollowupBrief(
        { goal, why, filedBy: task.crewmate, originTitle: origin.title, originKey: origin.key },
        delivery,
        personal ? this.personalFacts() : undefined,
      ),
      ...(input.blocksMe ? { blocksOrigin: true } : {}),
      ...(input.testFailure ? { testFailure: true } : {}),
      ...(input.testPath ? { testPath: input.testPath } : {}),
    });
    if (filed.duplicate) {
      return `Already filed as ${filed.record.key} "${filed.record.title}" for ${input.testPath?.trim()}. Name that key in your report; do not file another.`;
    }
    const record = filed.record;
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Task ${origin.title} follow-up filed: ${record.key} ${title}${input.blocksMe ? `; ${origin.title} must wait` : ""}`,
    });
    this.broadcastCrewCounts();
    task.filedThisTurn.push({ key: record.key, title, blocks: Boolean(input.blocksMe) });
    return `Filed follow-up ${record.key} "${title}", discovered from your task${input.blocksMe ? " and blocking it: your task cannot land until this one closes" : " and not holding it up"}. The first mate hears about it with your report and decides when it runs; keep going on your own task.`;
  }

  private validationRequestStrip(taskId: string, requestId: string): string {
    const permission = this.options.tasks
      .get(taskId)
      ?.delivery?.liveValidation?.permissions.find((item) => item.request.id === requestId);
    if (!permission) throw new Error("That validation request is not on this task.");
    const request = permission.request;
    const entries: [string, string][] = [
      ["Version", request.head.slice(0, 7)],
      ["Scenario", permission.scenario.action],
    ];
    if (request.kind === "effect")
      entries.push(
        ["Action", request.action],
        ["Destination", request.destination],
        ["Who can see it", request.audience],
        ["Purpose", request.purpose],
        ["Lasting effects", request.lastingEffects],
        ["Cleanup", request.cleanup],
        ["Access", request.access],
      );
    else
      entries.push(
        ["Missing access", request.missingCapability],
        ["Reason", request.reason],
        [
          "Safe alternatives tried",
          request.alternatives.map((item) => `${item.attempted}: ${item.result}`).join("\n"),
        ],
        ["Ways to close the gap", request.remedies.join("\n")],
      );
    const exact =
      request.kind === "effect" && request.forgeWrite
        ? `<details><summary>Exact request</summary><pre>${escapeCardText(`${request.forgeWrite.host} ${request.forgeWrite.method} ${request.forgeWrite.path}\nBody SHA-256: ${request.forgeWrite.bodyDigest ?? "No body"}`)}</pre></details>`
        : "";
    return `<section class="inf-panel"><h3>${request.kind === "gap" ? "Missing required proof" : "Validation action"}</h3><dl>${entries.map(([name, value]) => `<dt>${escapeCardText(name)}</dt><dd>${escapeCardText(value)}</dd>`).join("")}</dl>${exact}<p>This choice grants no merge permission${request.kind === "gap" ? " and never records a live pass" : " and covers only this action"}.</p></section>`;
  }

  verifyValidationEvidence(taskId: string): void {
    const run = this.options.tasks.get(taskId)?.delivery?.liveValidation?.runs.at(-1);
    if (run)
      verifyKeptValidationEvidenceSync(
        run.evidence,
        crewmateCardPicturesDir(this.options.paths, taskId),
        taskId,
      );
  }

  /** The write gateway calls this at execution, including a captain-approved kept write. */
  async consumeValidationEffect(
    taskId: string,
    request: string,
    write?: ValidationForgeWrite,
  ): Promise<void> {
    const task = this.options.tasks.get(taskId);
    if (!task) throw new Error("The task no longer exists; nothing was sent.");
    if (write) {
      const requested = task.delivery?.liveValidation?.permissions.find(
        (item) => item.request.id === request,
      )?.request;
      const approved = requested?.kind === "effect" ? requested.forgeWrite : undefined;
      if (
        !approved ||
        approved.host !== write.host ||
        approved.method !== write.method ||
        approved.path !== write.path ||
        approved.bodyDigest !== write.bodyDigest
      )
        throw new Error(
          "This exact write was not included in the validation request. Ask about its destination, action and contents before sending it.",
        );
    }
    const head = await this.validationHead(task);
    await this.requireCleanValidationWork(task, head);
    if (!head) throw new Error("The current version cannot be read; nothing was sent.");
    this.options.tasks.recordLiveValidation(
      taskId,
      {
        kind: "effect-state",
        request,
        state: "started",
        evidence: "The approved validation write passed the execution gate.",
      },
      { head },
    );
    this.options.tasks.recordLiveValidation(
      taskId,
      {
        kind: "effect-state",
        request,
        state: "unknown",
        evidence:
          "The write is being sent. Reconcile its result before any further action; never replay an unknown outcome.",
      },
      { head },
    );
  }

  private async validationHead(record: TaskRecord): Promise<string> {
    const head = record.deviceId
      ? (await this.options.machines?.revision(record.deviceId, record.id))?.headSha
      : record.branch
        ? await this.options.workspace.branchHead(record.repoDir, record.branch)
        : undefined;
    if (!head)
      throw new Error("The task's committed version cannot be read; validation remains held.");
    return head;
  }

  private async requireCleanValidationWork(record: TaskRecord, head: string): Promise<void> {
    if ((!record.deviceId && !record.worktreeDir) || !record.branch)
      throw new Error("The validation working copy cannot be read; nothing may run.");
    const status = record.deviceId
      ? await this.options.machines?.workStatus(record.id)
      : await this.options.workspace.taskWorkStatus(
          {
            taskId: record.id,
            cwd: record.worktreeDir,
            repoDir: record.repoDir,
            branch: record.branch,
          },
          { strict: true },
        );
    const actual = record.deviceId
      ? (await this.options.machines?.revision(record.deviceId, record.id))?.headSha
      : await this.options.workspace.branchHead(record.worktreeDir, "HEAD");
    if (!status || status.dirty || actual !== head)
      throw new Error(
        "Commit the current work before validation; proof and permission name one clean committed version.",
      );
  }

  private async recordValidationReport(
    task: TaskRuntime,
    text: string,
    summary: string | undefined,
    declared: ReportDeclaration,
  ): Promise<string> {
    const input = keptValidationInputSchema.parse(declared.validation);
    const record = this.options.tasks.get(task.id);
    if (!record) throw new Error("The task no longer exists.");
    const builder = this.reviewBuilderOf(record);
    const owner = builder ?? record;
    if (
      this.policiesOf(owner)?.rigor.value !== "reviewed" ||
      this.taskDelivery(owner.id) !== "direct-pr"
    )
      throw new Error(
        "Live validation belongs to a Careful change delivered through a pull request.",
      );
    const currentHead = await this.validationHead(owner);
    const head = builder ? record.delivery?.validationAssignment?.head : currentHead;
    if (!head)
      throw new Error(
        "The review has no assigned validation revision. Request a fresh review turn.",
      );
    if (input.kind === "decision")
      throw new Error(
        "Bind validation permission with emit_card.validation_request so the shown offer carries its exact facts; a report cannot attach permission to an unrelated card.",
      );
    if (
      input.kind === "run" ||
      (input.kind === "request" && input.request.kind === "effect") ||
      (input.kind === "effect-state" && input.state === "started")
    )
      await this.requireCleanValidationWork(owner, currentHead);
    if (input.kind === "request" && input.request.kind === "effect" && input.request.preChange) {
      const files = owner.deviceId
        ? (await this.options.machines?.revision(owner.deviceId, owner.id))?.changedFiles
        : await this.options.workspace.reviewChangedFiles(owner.repoDir, head);
      if (!files || files.length)
        throw new Error(
          "A changed branch needs code review before a validation effect; it is not a pre-change reproduction.",
        );
    }
    if (input.kind === "run")
      await verifyKeptValidationEvidence(
        input.evidence,
        crewmateCardPicturesDir(this.options.paths, owner.id),
        owner.id,
      );
    this.options.tasks.recordLiveValidation(owner.id, input, {
      head,
      ...(builder ? { reviewer: task.id, assignment: record.delivery?.validationAssignment } : {}),
    });
    this.options.tasks.recordDelivery(owner.id, { validationHead: currentHead });
    const { validation: _validation, ...declaration } = declared;
    const revision = validationRevision(this.options.tasks.get(owner.id)?.delivery?.liveValidation);
    if (
      input.kind !== "run" &&
      input.kind !== "review" &&
      !declaration.needsFirstmate &&
      !declaration.wait &&
      !declaration.finished
    )
      return `Validation ${input.kind} recorded at evidence revision ${revision}. This records facts, not a finished-work report or permission. Continue the task; report when the first mate must act.`;
    return `${this.recordExplicitReport(task, text, summary, declaration)} Validation recorded at evidence revision ${revision}.`;
  }

  /**
   * report (WI-1): the crewmate's explicit report for the turn in flight.
   * It wins over the turn's final text and is sorted exactly once, when the
   * turn ends; implausible text is refused here, with the fix, instead of
   * being set aside later. What it declares about whose turn follows
   * (FI3-435) is checked here too: a wait or finished, never both, and a
   * wait's card is one of the crewmate's own that is up. The receipt says
   * only what the sort will do (FI3-710): a report wakes the Firstmate when
   * the task's state or its own needs_firstmate says so, not by itself.
   */
  private recordExplicitReport(
    task: TaskRuntime,
    text: string,
    summary?: string,
    declared?: ReportDeclaration,
  ): string {
    const report = text.trim();
    if (!report) {
      throw new Error("text is required: what you finished, found, or are blocked on.");
    }
    const implausible = implausibleReport(report);
    if (implausible) {
      throw new Error(`Report refused: ${implausible}. Write it again in plain words.`);
    }
    const declaration = this.checkDeclaration(task, declared);
    task.explicitReport = report;
    task.explicitSummary = summary?.replace(/\s+/g, " ").trim() || undefined;
    task.explicitDeclared = declaration;
    this.noteTaskActivity(task);
    const receipt = ["Reported."];
    if (declaration?.wait) {
      receipt.push(
        "Your task now waits on the captain: nothing nudges you, and you hear when they act or you are steered.",
      );
      // He answers what is on his screen; with nothing there the Firstmate asks (INF-11).
      if (!declaration.wait.cardId && this.openCardsFor(task.id).length === 0) {
        receipt.push(
          "No card of yours is up, so the first mate is woken to ask them unless one is up when this turn ends.",
        );
      }
    }
    if (declaration?.needsFirstmate) {
      receipt.push(
        this.cards.threadAwaitingAuthor(task.id)
          ? "The first mate is woken for it when this turn ends only if the captain's reply under your card has your answer by then: answer it in that thread or revise the card."
          : "The first mate is woken for it when this turn ends.",
      );
    } else if (
      declaration?.finished &&
      this.openCardsFor(task.id).some((card) => cardEmitter(card.id, task.id) === "crewmate")
    ) {
      // Finished means the captain closed its card; the first mate hears it then (INF-731).
      receipt.push(
        "A card of yours is still on the captain's screen, so finished does not wake the first mate while it is up: their close comes back to you as a turn, and finished in that turn's report has the first mate close your task.",
      );
    } else if (declaration?.finished) {
      receipt.push("The first mate hears it when this turn ends and closes your task.");
    } else if (!declaration?.wait && this.options.tasks.get(task.id)?.shape?.internal_step) {
      receipt.push(
        "Your internal step's report is handed to the first mate when this turn ends, unless a card, pending reply, or continuing work holds its turn.",
      );
    } else if (!declaration?.wait) {
      receipt.push(
        "It goes on your task's record when this turn ends; whether the first mate is woken for it depends on your task's state. If the first mate must act on it, report again with needs_firstmate.",
      );
    }
    return receipt.join(" ");
  }

  /** A report's declaration, normalized, or a refusal with the fix (FI3-435, FI3-710). */
  private checkDeclaration(
    task: TaskRuntime,
    declared: ReportDeclaration | undefined,
  ): ReportDeclaration | undefined {
    const wait = declared?.wait;
    if (wait && declared?.finished) {
      throw new Error("Report refused: pass waiting_on_captain or finished, not both.");
    }
    const ask = declared?.needsFirstmate?.replace(/\s+/g, " ").trim();
    if (declared?.needsFirstmate !== undefined && !ask) {
      throw new Error(
        "Report refused: needs_firstmate needs a reason - what the first mate must do.",
      );
    }
    const result = this.checkResult(task, declared);
    const needs = {
      ...(ask ? { needsFirstmate: ask.slice(0, 300) } : {}),
      ...(result ? { result } : {}),
    };
    if (declared?.finished) return { finished: true, ...needs };
    if (!wait) return Object.keys(needs).length > 0 ? needs : undefined;
    const reason = wait.reason.replace(/\s+/g, " ").trim();
    if (!reason) {
      throw new Error(
        "Report refused: waiting_on_captain needs a reason - what the captain still has to read or decide.",
      );
    }
    const cardId = wait.cardId?.trim();
    if (cardId && !this.openCardsFor(task.id).some((card) => card.id === cardId)) {
      throw new Error(
        `Report refused: "${cardId}" is not an open card of yours. Pass the id emit_card returned, or omit card_id when no card is up.`,
      );
    }
    return { wait: { reason: reason.slice(0, 300), ...(cardId ? { cardId } : {}) }, ...needs };
  }

  /**
   * A report's typed result against its task's declared shape (INF-799
   * piece 1): a result that does not fit, or none where a shape stands, is
   * refused naming the first failing field, so the crewmate reports again.
   * A report that hands the turn to the captain or the first mate is taken
   * without one. A task with no shape keeps whatever object it was given.
   */
  private checkResult(
    task: TaskRuntime,
    declared: ReportDeclaration | undefined,
  ): Record<string, unknown> | undefined {
    const schema = this.options.tasks.get(task.id)?.shape?.result_schema;
    const result = declared?.result;
    if (!schema) return result;
    if (result === undefined) {
      if (declared?.wait || declared?.needsFirstmate?.trim()) return undefined;
      throw new Error(
        "Report refused: result is missing. Your task declares a result shape (your brief prints it): pass result, a JSON object that fits it, or declare waiting_on_captain or needs_firstmate.",
      );
    }
    const refusal = resultRefusal(schema, result);
    if (refusal)
      throw new Error(
        `Report refused: ${refusal} Fix that field so result fits your task's result shape, and report again.`,
      );
    return result;
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
    );
  }

  /**
   * note_progress: one line on the crewmate's own timeline; proof of life
   * too. A note that carries a list replaces the plan; one that omits it
   * keeps the last list standing rather than being refused (INF-484 move 5:
   * never refuse a shape). Only a list no surface could draw is refused in
   * words, writing nothing.
   */
  private noteProgress(task: TaskRuntime, text: string, plan?: unknown): string {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) throw new Error("text is required: one line of progress.");
    let items: PlanItem[] | undefined;
    if (plan !== undefined) {
      const read = readPlanItems(plan);
      if ("refusal" in read) return read.refusal;
      items = read.items;
    }
    const planned =
      !items &&
      this.options.tasks
        .timeline(task.id)
        .some(
          (event) =>
            (event.kind === "progress" || event.kind === "compacted") &&
            !("refusal" in readPlanItems(event.data?.plan)),
        );
    this.options.tasks.noteProgress(task.id, line.slice(0, 500), "crewmate", items);
    this.noteTaskActivity(task);
    if (items) return "Noted on your task's timeline, with your plan.";
    return planned
      ? "Noted on your task's timeline; your last plan stands."
      : "Noted on your task's timeline.";
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
    const classified = this.withDeliverable(
      await this.classifyShape(record.id, record.title, intent, record.repoId, shape),
      intent,
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
    this.options.tasks.recordShape(record.id, stamp, tierFor(stamped).bucket ?? null);
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
    return this.withBasisVerdict(
      record.shape ??
        (record.intent ? legacyShapeFromDifficulty(record.difficulty) : this.workShape(undefined)),
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
        : this.folderRepairBrief(repo, shape.in_place);
    }
    const personal = this.isPersonalTask(record.id);
    const delivery =
      shape.deliverable === "answer" || personal
        ? undefined
        : (this.taskDelivery(record.id) ?? "local-only");
    if (!record.intent) return withDeliveryLine(record.prompt, delivery);
    return renderIntentBrief(
      record.intent,
      delivery,
      personal ? this.personalFacts(shape.kind) : undefined,
    );
  }

  /**
   * Dispatch one queued row through the shared start path. `requested` is a
   * start someone asked for (`startQueuedNow`): its asker already knows, so
   * no queued-started wake follows, and a failure says who asked. `from`
   * writes the start on the history as the captain's task card click.
   */
  async dispatchQueuedTask(
    taskId: string,
    options: {
      ignoreAsk?: boolean;
      requested?: { by: "firstmate" | "captain"; from?: typeof TASK_CARD_VIA; panel?: string };
    } = {},
  ): Promise<void> {
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
    const blockers = this.options.tasks.blockers(taskId);
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
      const startsAt = this.startPlace(record);
      const moved = () => {
        const now = this.options.tasks.get(taskId);
        return !now || routingAskMoved(routedFrom, now.shape) || this.startPlace(now) !== startsAt;
      };
      // A task that waits for its computer chooses its model once that
      // computer is back, among its own subscriptions.
      const automatic = this.automaticFor(record);
      if (!automatic) this.options.tasks.setPlacementWait(taskId, null);
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
      if (automatic && !selected) {
        // Automatic declines a task that changed while computers were
        // compared, which is no wait for room.
        if (moved()) return this.dispatchQueuedTask(taskId, options);
        // A wait whose computers were compared says why; another keeps what was said.
        const waiting = choice && "wait" in choice ? choice : undefined;
        const wait =
          waiting?.wait ?? this.options.tasks.get(taskId)?.shape?.placement_wait ?? UNCOMPARED_WAIT;
        this.options.tasks.waitForPlacement(taskId, ignoreAsk, wait.words);
        this.sayAutomaticWait(record, wait);
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
      if (selected) this.options.tasks.setPlacementWait(taskId, null);
      const target = selected ? selected.computerId : this.placementOf(record);
      const ready = !target || this.options.machines?.ready(target, taskId) === true;
      // One that waits for its own sign-in there tries nothing until it
      // serves: known before routing once that computer said so, and after
      // routing found nothing there to take it.
      const signInWait = () =>
        !selected &&
        target !== null &&
        ready &&
        !this.tasks.has(taskId) &&
        this.waitsForSignIn(taskId, target);
      if (signInWait()) return;
      // One with no sign-in at all, or none for where its project lives,
      // tries nothing until that computer reports one.
      if (!selected && target !== null && ready && !this.tasks.has(taskId)) {
        const waitFor = await this.placedWaitFor(target, record.repoId);
        if (moved()) return this.dispatchQueuedTask(taskId, options);
        if (waitFor) {
          this.waitForSetup(taskId, target, waitFor);
          this.broadcastCrewCounts();
          return;
        }
      }
      const routed =
        selected?.routed ??
        (ready ? await this.routeTask(taskId, record.prompt, shape, target) : undefined);
      // From here to the claim nothing waits.
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
      // It runs on a computer that is out of reach: it waits, and never starts here instead.
      if (this.placeForStart(taskId)) return;
      if (
        !this.options.tasks.claimForDispatch(
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
      });
      if (start.crewmate === "queued") return;
      this.sayPlacedStarted(taskId);
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
        this.holdForDeviceForge(taskId, current.deviceId, caught.host);
        this.sayPlacedWait(this.waitSubject(current), current.deviceId, {
          kind: "forge",
          host: caught.host,
        });
        this.cards.scheduleBroadcast();
      } else if (caught instanceof ForgeAuthRequiredError && current?.status === "active") {
        this.options.tasks.requeue(
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
          this.options.tasks.failManualStart(taskId, message);
        } else {
          this.options.tasks.requeue(
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
    if (!this.options.tasks.startAttemptOf(record.id)) return;
    const now = this.options.tasks.get(record.id);
    if (!now) {
      this.options.tasks.clearStartAttempt(record.id);
      return;
    }
    if (now.status === "active") {
      if (
        now.activity === "starting" &&
        !this.tasks.has(now.id) &&
        now.deviceId &&
        this.outOfReach(now.id)
      ) {
        this.options.tasks.markStartChecking(now.id);
        return;
      }
      this.options.tasks.clearStartAttempt(now.id);
      return;
    }
    if (now.shape?.placement_wait) {
      this.options.tasks.clearStartAttempt(now.id);
      return;
    }
    const signIn = now.deviceId ? this.options.machines?.signInWait(now.deviceId) : undefined;
    const setup = now.deviceId ? await this.placedWaitFor(now.deviceId, now.repoId) : undefined;
    if (now.gate || signIn || setup || (now.deviceId && this.outOfReach(now.id))) {
      this.options.tasks.clearStartAttempt(now.id);
      return;
    }
    if (audience === "captain" && record.startPolicy === "on-request" && !now.startNotice) {
      this.options.tasks.failManualStart(now.id, "it did not start");
      return;
    }
    this.options.tasks.clearStartAttempt(now.id);
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
    const record = this.resolveTaskRef(taskRef, "task");
    const handle = `${record.key || record.id} "${record.title}"`;
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
    if (!this.options.tasks.startAttemptOf(record.id))
      this.options.tasks.beginStartAttempt(record.id);
    if (record.gate) this.options.tasks.setGate(record.id, null, "started on request");
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
      if (this.options.tasks.startAttemptOf(record.id))
        this.options.tasks.clearStartAttempt(record.id);
      return this.options.tasks.programStarted(record.id)
        ? `Started ${handle}.`
        : `${handle} could not start.`;
    }
    await this.settleStartAttempt(record, asCaptain ? "captain" : "tool");
    const now = this.options.tasks.get(record.id);
    if (this.options.tasks.startAttemptOf(record.id)?.phase === "checking") {
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
      const waitFor = await this.placedWaitFor(now.deviceId, now.repoId);
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
    const old = this.resolveTaskRef(taskRef, "task");
    const refusal = this.options.tasks.startAgainRefusal(old.id);
    if (refusal) return { ok: false, text: refusal };
    // Only declarations carry over: dispatch stamps, chosen accounts/models,
    // escalation floors and delivery outcomes all belong to the old attempt.
    const shape = this.workShape(old.shape ?? undefined);
    if (old.shape?.policies) shape.policies = { ...old.shape.policies, revision: 0 };
    const fresh = this.options.tasks.startAgain(old.id, {
      id: randomUUID().slice(0, 8),
      shape: old.intent ? this.withDeliverable(shape, old.intent) : shape,
      actor: audience === "tool" ? "firstmate" : "captain",
      ...(audience === "captain" ? { via: TASK_CARD_VIA } : {}),
      ...(panel ? { panel } : {}),
    });
    this.starting.add(fresh.id);
    const started = this.settle
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
    this.options.tasks.setGate(
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
      this.automaticFor(record)
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
   * When a client-run backend (Claude) last reported background work, if it
   * has any now: the host cannot see those commands, so the client's own
   * count stands in for its job list, bounded the same way.
   */
  private clientJobStart(taskId: string): number | undefined {
    const runtime = this.tasks.get(taskId);
    if (!runtime?.session || (runtime.clientJobs ?? 0) <= 0) return undefined;
    return runtime.clientJobsSince ?? this.now();
  }

  /** The host's longest-running job, or the client's work when it has no job list. */
  private oldestJob(taskId: string): RunningJob | undefined {
    const host = this.options.oldestRunningJob?.(taskId);
    const since = this.clientJobStart(taskId);
    if (since === undefined || (host && host.startedAt <= since)) return host;
    return {
      jobId: `client-${taskId}`,
      command: "background work in the Claude client",
      startedAt: since,
    };
  }

  /** Shared visual answer; deliberately independent of turn control and recovery. */
  workPosture(record: TaskRecord) {
    return deriveWorkPosture(record, () => {
      const runtime = this.tasks.get(record.id);
      const hold = this.holdOf(record);
      return {
        ...this.ladder.witnesses(record.id, this.now()),
        turnRunning: runtime !== undefined && runtime.state !== "idle",
        liveJobs: this.options.hasRunningJobs?.(record.id) === true,
        clientJobs: runtime?.session ? runtime.clientJobs : undefined,
        observable: runtime?.session?.controlProfile.backgroundWork === "host",
        blocked: this.options.tasks.flagsOf(record).blocked,
        ...(hold ? { hold } : {}),
      };
    });
  }

  /**
   * The typed cut-off on the account the hold witness reads
   * (`IdleLadder.cutOffHolds`), as a card thread's waiting line names it:
   * its class, the provider, and a spent allowance's reset.
   */
  private holdOf(record: TaskRecord): AccountHold | undefined {
    const held = this.ladder.heldBy(record);
    if (!held) return undefined;
    const { account, cutOff } = held;
    // A task on another computer waits on that computer's own sign-in, and
    // the line says where (docs/helper.md, "Its own sign-ins").
    const place = this.options.machines?.accountPlace(account);
    return {
      class: cutOff.class,
      provider:
        place?.provider ?? this.options.serveability?.providerName(account) ?? "the provider",
      ...(cutOff.class === "no_headroom" && cutOff.resetsAt !== undefined
        ? { resetsAt: cutOff.resetsAt }
        : {}),
      ...(place ? { where: place.where } : {}),
    };
  }

  crewCounts(): CrewCounts {
    let working = 0;
    let idle = 0;
    for (const record of this.options.tasks.listActive()) {
      if (record.kind !== "work") continue;
      if (this.workPosture(record).state === "active") working += 1;
      else idle += 1;
    }
    // Counted, not read: every crew event asks, and planned work only counts.
    return { working, idle, queued: this.options.tasks.count("open", "work") };
  }

  private broadcastCrewCounts(): void {
    this.options.broadcastEvent({ type: "crew_counts", ...this.crewCounts() });
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
    this.options.tasks.purge();
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
      : (this.options.tasks.openCardTaskFor(card.id) ?? this.options.tasks.taskForCard(card.id));
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
    const context = decisionTaskId ? this.options.tasks.decisionContext(decisionTaskId) : undefined;
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
    if (
      effect?.kind === "settle" &&
      effect.mode === "merge" &&
      associated?.delivery?.presentation
    ) {
      const ledger = associated.delivery.presentation;
      const offered = associated.delivery.completionOffers?.find(
        (offer) => offer.cardId === card.id && offer.offerId === card.offerId,
      );
      if (
        !offered?.presentationRevision ||
        offered.presentationRevision !== ledger.revisions.at(-1)?.revision ||
        ledger.published?.revision !== offered.presentationRevision ||
        ledger.publication?.state !== "confirmed"
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
      effect?.kind === "settle" &&
      effect.mode === "merge" &&
      card.taskId &&
      this.mergeModeFor(card.taskId) === "merge-pr"
        ? () =>
            this.settle.authorizeMerge(
              card.taskId as string,
              {
                cardId: card.id,
                ...(card.lifecycleId ? { lifecycleId: card.lifecycleId } : {}),
                ...(card.offerId ? { offerId: card.offerId } : {}),
                actionId,
                ...interactionOf(submission),
              },
              effect.proceedWithOpen ?? false,
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
      const [id, generation] = (effect.arg ?? "").split(":");
      const action = associated?.delivery?.captainAction;
      if (
        !id ||
        id !== card.taskId ||
        !action ||
        action.generation !== Number(generation) ||
        action.presentedGeneration !== Number(generation) ||
        !this.options.tasks.captainActionReady(id)
      ) {
        if (id && this.options.tasks.captainActionReady(id)) {
          this.showRequiredAction(id);
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
              this.options.tasks.declareRequiredActions(card.taskId as string, {
                cardId: card.id,
                offerId: card.offerId,
                actions: card.requiredActions,
                head:
                  effect?.kind === "request_merge"
                    ? this.mergeReviewOf(card.taskId as string, effect.review)?.headSha
                    : associated?.delivery?.headSha,
              });
            else if (associated?.delivery?.requiredActionOffer)
              this.options.tasks.recordDelivery(card.taskId as string, {
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
    let closedAnswer: ReturnType<CardService["resolve"]>;
    try {
      closedAnswer = this.cards.resolve(card, actionId, actionId, answers, by, evidence, () => {
        if (validationDecision && card.taskId && card.offerId)
          this.options.tasks.decideLiveValidation(card.taskId, {
            card: card.id,
            offer: card.offerId,
            action: actionId,
            label: chosen.label,
            head: associated?.delivery?.validationHead ?? "",
          });
        carryOffer?.();
        if (card.taskId && associated?.delivery?.captainAction) {
          if (effect?.kind === "host" && effect.op === "confirm-required-action") {
            const [id, generation] = (effect.arg ?? "").split(":");
            if (id === card.taskId)
              this.options.tasks.completeCaptainAction(id, Number(generation), "confirmed");
          } else this.options.tasks.deferCaptainAction(card.taskId);
        }
      });
    } catch (error) {
      if (!(error instanceof StaleValidationDecisionError) || !card.taskId || !card.offerId)
        throw error;
      this.options.tasks.expireValidationDecision(
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
        { actor: "supervisor", via: "supervision", decision: null, cardId: card.id },
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
    if (chosen.care && card.taskId && !closedAnswer) this.careFromCard(card.taskId, chosen.care);
    switch (effect?.kind) {
      case "settle": {
        // Host-owned teardown: the host runs it instead of steering the
        // crewmate, and reportCardSettle wakes the Firstmate with whatever
        // came back - so the choice still round-trips, just after the work.
        // Every emit boundary refuses a settle without a task; belt and
        // braces here rather than a settle of nothing.
        if (!card.taskId) return {};
        const mode = effect.mode === "merge" ? this.mergeModeFor(card.taskId) : "discard";
        void this.settle.reportCardSettle(
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
        const taskId = card.taskId;
        const reviewId = effect.review;
        void this.settle.requestMerge(taskId, reviewId).then((outcome) => {
          if (outcome.ok) void this.sweepGates(this.now());
          const still = this.options.tasks.get(taskId);
          if (!still || TaskService.isClosed(still)) return;
          const review = this.mergeReviewOf(taskId, reviewId);
          void this.steerCrewmate(
            taskId,
            {
              facts: {
                kind: "merge-continued",
                ok: outcome.ok,
                change: review ? `#${review.number}` : "the reviewed pull request",
                ...(review ? { head: review.headSha } : {}),
                text: outcome.text,
              },
              ...(outcome.ok ? { once: `merge-continued:${reviewId}` } : {}),
            },
            "captain",
            { via: "card", cardId: card.id },
          ).catch((caught: unknown) => {
            console.warn("[crew] merge continuation not delivered:", caught);
          });
        });
        return {};
      }
      case "request_write": {
        // The declaration sent nothing. Only this chrome click sends the
        // kept write, once; the crewmate hears what came of it once.
        if (!card.taskId || source !== "chrome" || !this.options.sendWriteAsk) return {};
        const taskId = card.taskId;
        const askId = effect.ask;
        void this.options.sendWriteAsk(taskId, askId).then((sent) => {
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
    } else if (card.taskId && !closedAnswer) {
      // The action round-trip: a declared choice on a crewmate's card
      // reaches its still-running session as a steering message.
      this.steerChoice(card.taskId, card, source, choice);
    }
    return {};
  }

  /**
   * The captain's care from a card's button (INF-562): the same writer and
   * notice as update_task, with the captain as its author and the merge
   * card as where it came from. A refusal is a feed line, never a silent no-op.
   */
  private careFromCard(taskId: string, care: Rigor): void {
    const before = this.policiesOf(this.options.tasks.get(taskId));
    try {
      this.options.tasks.updateFields(
        taskId,
        { policies: { rigor: care }, direction: "the merge card" },
        "captain",
      );
    } catch (caught) {
      if (!(caught instanceof TaskGraphRefusal)) throw caught;
      this.options.broadcastEvent({ type: "firstmate_note", text: caught.message, taskId });
      return;
    }
    this.policiesChanged(taskId, { rigor: care }, before);
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
          card: { title: card.title },
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
    this.options.tasks.endIdle(taskId);
    const wake: TypedWake = {
      facts: {
        kind: "browser-returned",
        site: returned.site,
        ...(returned.after ? { after: returned.after } : {}),
        ...(returned.saved ? { saved: true as const } : {}),
      },
      once: returned.once,
    };
    void this.steerInternal(taskId, wake, {
      actor: "supervisor",
      via: "supervision",
      decision: null,
      cardId: null,
    }).catch((caught: unknown) => {
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
    return this.taskDelivery(taskId) === "direct-pr" ? "merge-pr" : "land";
  }

  /**
   * What a completion card's merge says it does (INF-23): a click on checks
   * still running keeps the captain's approval and the host merges once
   * they pass, so it reads Merge when checks pass; on failed checks the
   * approval waits for a fix, so it reads Merge after fixing errors;
   * otherwise Merge the pull request. Undefined - the label as it stands -
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
    const ci = record.delivery?.ci;
    if (ci === "red") return MERGE_AFTER_FIXING_WORDS;
    return ci === "pending" ? MERGE_WHEN_CHECKS_PASS_WORDS : MERGE_WORDS["merge-pr"];
  }

  /**
   * The host cards' own operations, keyed on the declared op. `answers` are
   * what the captain's click carried from the card's own questions.
   */
  private runHostOp(effect: HostEffect, answers?: readonly CardAnswer[]): { effect?: ShellEffect } {
    switch (effect.op) {
      case "confirm-required-action": {
        const [id] = (effect.arg ?? "").split(":");
        if (id && this.options.tasks.get(id)?.status === "open") this.showRequiredAction(id);
        void this.sweepGates(this.now());
        return {};
      }
      case "defer-required-action":
        if (effect.arg) this.options.tasks.deferCaptainAction(effect.arg);
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
        const moved = this.requestMove(taskId, {
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
      case "show-card": {
        const action = this.options.tasks.get(taskId)?.delivery?.captainAction;
        if (action && !this.showRequiredAction(taskId))
          return "This action cannot be shown until its prerequisites finish.";
        const cardId =
          action?.cardId ??
          this.cards
            .snapshot()
            .find(
              (card) => card.taskId === taskId && card.status === "ready" && card.actions.length,
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
      this.settle.closeAndPurge([taskId], () => {
        const result = this.options.tasks.dropUnstarted(taskId, {
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
    this.graphChanged();
    return undefined;
  }

  /**
   * The task board's queue and unqueue on never-started work. A start
   * already requested refuses as started; the task service guards the rest
   * at write time. A queued task the ready query now takes starts on the
   * sweep `graphChanged` runs.
   */
  private queueFromBoard(
    taskId: string,
    op: "queue-task" | "unqueue-task",
    panel?: string,
  ): string | undefined {
    const record = this.options.tasks.get(taskId);
    const key = record?.key || taskId;
    if (!record) return queueMissingRefusal(key);
    if (this.starting.has(taskId) || this.pendingStarts.has(taskId) || this.tasks.has(taskId))
      return queueStartedRefusal(key);
    const result = this.options.tasks.setQueued(taskId, op, {
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
      if (this.options.tasks.listReady().some((ready) => ready.id === taskId)) {
        return this.startOnRequest(taskId, TASK_CARD_VIA, panel);
      }
      this.tellFirstmate(taskId, "queue");
    }
    this.graphChanged();
    return undefined;
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
      (this.options.tasks.startAttemptOf(record.id) && !awaitsFirstmate)
    )
      return `${handle} is already starting.`;
    const blockers = this.options.tasks
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
    this.options.tasks.beginStartAttempt(record.id);
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
    this.options.tasks.clearStartAttempt(taskId);
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
        this.options.tasks.beginStartAttempt(record.id);
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
   * follows its project instead (`projectMoved`), and one the captain said
   * runs there follows its parent's or its project's again.
   */
  async stopTasksOn(deviceId: string, boundMs = 60_000): Promise<void> {
    for (const taskId of this.options.tasks.forgetRunsOn(deviceId)) this.runsOnChanged(taskId);
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
          this.settle.closeRecord(taskId, "cancelled", undefined, "captain");
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

  /**
   * Chrome close: the card leaves the stack without a declared action. The
   * resolution is on the record (the card row, the task timeline) and one
   * feed line says so and where the card stays (the task's record, FI3-579). A crewmate's own card on a live task reaches that
   * crewmate, on the path a click takes (FI3-435): the author judges what
   * the close meant - read and finished, still waiting on the captain, or a
   * passing note - and its report declares it. Anything else wakes nobody
   * (Q4a): the Firstmate learns of it from its next context block
   * (`captainResolutionsSince`).
   */
  close(cardId: string, submission?: unknown): void {
    const card = this.cards.shown(cardId);
    if (!card) return;
    // The record the card stays on, read before the dismissal closes a
    // Firstmate decision's own row (FI3-579: the line says where it went).
    const home = card.taskId
      ? this.options.tasks.get(card.taskId)
      : this.options.tasks.openCardTaskFor(card.id);
    this.cards.dismiss(card, submission);
    // A host card that can turn something down treats the dismissal as that
    // answer (the consent card, A2a; the setup card): closing it is "don't
    // add", never a question left staged behind a card nobody can see.
    const decline = card.actions.find(
      (action) => action.effect?.kind === "host" && HOST_DECLINE_OPS.has(action.effect.op),
    )?.effect;
    if (card.author === "host" && decline?.kind === "host") this.runHostOp(decline);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text:
        home?.key && home.kind !== "operation"
          ? `You closed "${card.title}". It stays on ${home.key}'s record.`
          : `Captain dismissed the card "${card.title}".`,
    });
    this.tellCardClosed(card);
  }

  /**
   * A crewmate's own card on a live task closed without a choice: that
   * crewmate hears it, on the path a click takes, and judges what the close
   * meant. `duplicateOf` names the earlier card a duplicate close repeats.
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
          ...(duplicateOf ? { duplicateOf } : {}),
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

  workingCount(): number {
    return [...this.tasks.values()].filter((task) => task.state !== "idle").length;
  }

  /**
   * The quit: every crewmate is let go of, a running turn cut. The returned
   * promise waits, at most `QUIT_SETTLE_MS`, for the cut turns to settle so
   * their usage is kept.
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
      this.releaseSession(task);
    }
    this.tasks.clear();
    return this.settled(QUIT_SETTLE_MS);
  }

  /** Resolves once every session let go of mid-turn is gone, or `boundMs` has passed. */
  private settled(boundMs: number): Promise<void> {
    if (this.releasing.size === 0) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, boundMs);
    });
    return Promise.race([Promise.all(this.releasing).then(() => {}), bound]).finally(() =>
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

/**
 * The gate a queued premium ask waits on when no model of its class has
 * quota (P7 + R1): the class's own quota reset, so the sweep starts it when
 * headroom returns and nothing has to be clicked.
 */
function reasoningWaitGate(bucket: string): TaskGate {
  return { kind: "quota-reset", ref: `bucket:${bucket}` };
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
    event.type !== "background_work_changed" &&
    event.type !== "turn_closed" &&
    event.type !== "request_started" &&
    event.type !== "continuation_started" &&
    event.type !== "continuation_ended" &&
    event.type !== "input_read" &&
    event.type !== "model_served"
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

/** The task's timeline line for a kept write the captain's click took. */
function writeSentLine(sent: WriteAskSent): string {
  switch (sent.outcome.kind) {
    case "answered":
      return `Sent ${sent.call} to ${sent.place} once, on the captain's click: it answered ${sent.outcome.status}.`;
    case "ran":
      return `Ran ${sent.call} on ${sent.place} once, on the captain's click.`;
    case "unknown":
      return `Sent ${sent.call} to ${sent.place} once, on the captain's click; what came of it is unknown (${sent.outcome.why}). It is never sent again.`;
    default:
      return `The captain's click on ${sent.call} sent nothing: ${sent.outcome.why}`;
  }
}

/** A finished program's report: how many parts ran, its result and the branch it leaves. */
function programReportText(
  parts: number,
  result: Record<string, unknown> | undefined,
  branch: TaskRecord | undefined,
): string {
  return [
    `The program finished after ${parts} ${parts === 1 ? "part" : "parts"}.`,
    ...(result ? [`Its result: ${JSON.stringify(result)}`] : []),
    branch
      ? `Its branch: the last commit of ${branch.key || branch.id} "${branch.title}".`
      : "Its script returned no branch, so there is nothing to ship.",
  ].join(" ");
}
