import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import type { ActionActor, ActionName } from "@shared/actions";
import type { AttachmentRef } from "@shared/attachments";
import { type CutOff, isAuthFailureMessage } from "@shared/authFailure";
import {
  type Card,
  cardAnswerLines,
  cardPresentation,
  cardWord,
  isPreviewBody,
  type TurnImage,
} from "@shared/cards";
import { isCustomApiProvider } from "@shared/customApi";
import { deviceUpdateCardOfOffer } from "@shared/deviceUpdateNudge";
import type { TurnFailureReason, TurnTrigger } from "@shared/diagnostics";
import { AUTOMATIC_EMOTE_WORDS, type HostReplyEmote } from "@shared/emotes";
import type { FmEvent, FmUsage } from "@shared/events";
import { forgePlace } from "@shared/forge";
import type { ForgeSignInState } from "@shared/forges";
import type { LastTurnReply } from "@shared/lastTurn";
import { pastCardEndingWords } from "@shared/pastCard";
import { isRunawayProviderError, plainProblem } from "@shared/plainProblem";
import {
  backendForProvider,
  isRetiredProvider,
  PROVIDER_CATALOG,
  providerServesRole,
} from "@shared/providers";
import {
  clockTime,
  type ModelsCatalogView,
  PREMIUM_SLOT,
  type QuotaSnapshotView,
  SLOTS,
  type Slot,
  servedModelKey,
  servedProviderOf,
} from "@shared/quota";
import type { RepoView } from "@shared/repos";
import {
  frameServedInput,
  type ServedSegmentInput,
  type ServedWakeOrigin,
} from "@shared/servedFrame";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import { encode } from "@toon-format/toon";
import { AttachmentUnavailableError, keepImages, loadImages } from "../attachments";
import type { CoreDispatch } from "../dispatcher";
import type { IntegrationsService } from "../integrations";
import { contextKnowledge, knowledgeShortlist } from "../knowledge/context";
import { renderDirections } from "../knowledge/directions";
import { type KnowledgeService, PRIVATE_SCOPE } from "../knowledge/knowledgeService";
import {
  KNOWLEDGE_TOOL,
  knowledgeBinding,
  RECORD_KNOWLEDGE_TOOL,
} from "../knowledge/knowledgeTools";
import { classifyInboxBatch, type KnowledgeOrigin } from "../knowledge/origin";
import type { MessageFile } from "../overflow";
import type { AppPaths } from "../paths";
import {
  type SequencesFallback,
  SequencesSource,
  type ServedSequences,
} from "../personal/sequencesSkill";
import { createAppTools } from "../pi/appTools";
import { lintFirstmateCard, steerNotAnswerRefusal } from "../pi/cardLint";
import {
  createCloseCardTool,
  createEmitCardTool,
  type EmittedCard,
  resolveFirstmateCardId,
} from "../pi/cardTool";
import { type CrewDelegate, createCrewTools } from "../pi/crewTools";
import { createEmoteTool } from "../pi/emoteTool";
import { createIntegrationTools } from "../pi/integrationTools";
import { createLocateProjectTool } from "../pi/locateTool";
import {
  createPersonalizeTool,
  listSurfaces,
  type PersonalizeDelegate,
  panelsOffLine,
  SURFACES_CONTEXT_LIMIT,
  surfaceState,
} from "../pi/personalizeTool";
import {
  FIRSTMATE_CONTRACT_VERSION,
  firstmatePromptSha,
  toolsFingerprint,
} from "../pi/piResources";
import { createInstallPluginTool } from "../pi/pluginTools";
import { createScheduleTools } from "../pi/scheduleTools";
import { createPiSessionFactory } from "../pi/sessionFactory";
import {
  createFlagDuplicateTool,
  createFlagMissedEscalationTool,
  createSupervisionLogTool,
} from "../pi/supervisionTools";
import { createTaskTools, type TaskToolsDelegate } from "../pi/taskTools";
import type { ModelRuntime } from "../pi/types";
import type { PluginInstallRequest } from "../plugins/pluginInstaller";
import type { ShellPreferencesService } from "../preferences/shellPreferences";
import { timeZoneFact } from "../prompts/timeZone";
import type {
  ModelSession,
  SessionEvent,
  SessionFactories,
  SessionRenewal,
  SessionResume,
} from "../session/session";
import { type BoundTool, bindTool } from "../session/tools";
import type { CardResolution, DuplicateResult } from "../storage/cardStore";
import type { MissedEscalationResult, SupervisionOutcome } from "../storage/decisionStore";
import {
  FIRSTMATE_RECIPIENT,
  INBOX_ATTEMPT_MAX,
  type InboxRow,
  type InboxStore,
  WAKE_COALESCE_MS,
} from "../storage/inboxStore";
import type { FirstmatePaused, SettingsStore } from "../storage/settingsStore";
import type { TaskRecord } from "../storage/taskStore";
import { standingDependencyWaits } from "../tasks/dependencyWaits";
import { queryTasks } from "../tasks/taskQuery";
import {
  type SettleRefusal,
  type TaskCardClick,
  TaskGraphRefusal,
  TaskService,
} from "../tasks/taskService";
import { locateProject, renderLocated } from "../workspace/projectLocator";
import type { RepoRegistry } from "../workspace/repoRegistry";
import {
  ANSWER_ONLY_REFUSAL,
  ANSWER_ONLY_REFUSED_TOOLS,
  type DeliveryNote,
  type DeliveryRefusal,
} from "./answerDelivery";
import { AnswerDeliveryCheck } from "./answerDeliveryCheck";
import { AskCapture } from "./askCapture";
import {
  FIRSTMATE_FAILURE_CARD_ID,
  FIRSTMATE_MOVE_BACK_CARD_ID,
  type FirstmatePauseCard,
  type ThreadOwed,
} from "./cardService";
import { escapeCardText } from "./cardText";
import { type CrewSupervisor, QUIET_CARD_MS, QUIET_FEED_MS } from "./crewSupervisor";
import { DecisionCapture, type ServedInput } from "./decisionCapture";
import type { Flagship } from "./flagship";
import type { LocalOrchestratorSeat } from "./localOrchestrator";
import { type ReplyFacts, replyLine, replyWords, startedReply } from "./replyLine";
import { scheduleText } from "./scheduler";
import {
  ALLOWANCE_CHECKING_WORDS,
  allowanceCheckedWords,
  FIRSTMATE_CAPTAIN_THINKING_LEVEL,
  FIRSTMATE_OPERATIONAL_THINKING_LEVEL,
  type FirstmateThinkingLevel,
  keptMessageWords,
  type SeatBackend,
  type SeatBinding,
  type SeatPause,
  seatMovedLine,
  seatPausedLine,
  seatSessionSpec,
} from "./seat";
import { appendDigest, digestEntry, digestFor, seatIdentity } from "./seatDigest";
import {
  captainTurn,
  drainWakes,
  renderWake,
  rowAttachments,
  type SeatMoveReason,
  type TypedWake,
  type WakeSeat,
} from "./wakes";

/**
 * The Firstmate agent: one persistent embedded Pi session that takes every
 * user turn and decides answer vs ask vs steer vs spawn (the orchestrator
 * loop; docs/architecture.md section 2). Its output contract is cards-only:
 * emit_card is the single card channel. Final assistant text is unused for
 * the UI and is never a feed line or chat (captain refinement 4a).
 *
 * Context discipline (index-plus-query): every user turn carries a compact
 * [fm-op] context block - registered repos, the crew, the task index, quota,
 * own source - built as one JavaScript object and encoded as TOON, while
 * crew_status pulls detail on demand. The host state is
 * authoritative; the transcript is lossy by design (Pi compaction bounds the
 * rolling session, captain decision Q4).
 *
 * Capture (task-system P1, design section 6): every captain turn opens a
 * `captain_asks` row before it runs; the tools attach it to the task they
 * act on (attach first, D1), and `AskCapture.endTurn` files whatever is
 * still loose at turn end. Nothing the captain says falls outside the task
 * system.
 */

const AUTH_CARD_ID = "card-fm-auth";

/** The task index in the context block: rows per project, and in total. */
export const TASK_INDEX_PER_PROJECT = 12;
export const TASK_INDEX_TOTAL = 36;
/**
 * What the captain did outside the conversation that a context block lists -
 * his card choices and closes and his task card clicks: the newest this many,
 * this recent, then a count of the rest (FI3-695; the captain raised it from 8).
 */
const RESOLVED_CONTEXT_LIMIT = 32;
const RESOLVED_CONTEXT_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * The card threads a context block lists, bounded like the captain's actions
 * beside it (cards-as-threads phase 1, captain's C9 A): a busy conversation
 * must never swell the block, and the record holds the rest.
 */
const THREAD_CONTEXT_LIMIT = 8;
const THREAD_CONTEXT_WINDOW_MS = RESOLVED_CONTEXT_WINDOW_MS;
/** How much of a thread's newest message the section quotes. */
const THREAD_EXCERPT_CHARS = 120;
/** How a thread activity line ends: who owes the captain an answer on that card now. */
const THREAD_OWED_WORDS: Record<ThreadOwed, string> = {
  author: "awaiting the author",
  firstmate: "awaiting your answer",
  none: "no answer owed",
  closed: "card closed, no answer owed",
};

/**
 * Consecutive flagship runaways (max_time_limit / token-generation /
 * turn-timeout) after which Firstmate refuses a new turn until Retry.
 * Does not change the captain's chosen flagship model.
 */
export const RUNAWAY_REFUSE_AFTER = 2;

/**
 * Name the provider and model on a flagship error so the captain can tell
 * a provider fault from a local crash: "Grok grok-4.6: Response incomplete:
 * max_time_limit" rather than a 120-character first sentence.
 */
export function formatFlagshipError(
  model: { provider: string; id: string } | undefined | null,
  error: string,
): string {
  const trimmed = error.trim();
  if (!trimmed) return "unknown error";
  if (!model) return trimmed;
  const name =
    PROVIDER_CATALOG.find((entry) => entry.id === model.provider)?.name ?? model.provider;
  const prefix = `${name} ${model.id}: `;
  if (trimmed.startsWith(prefix)) return trimmed;
  return `${prefix}${trimmed}`;
}

export type RunningComputerVersion = {
  id: string;
  name: string;
  role: string;
  connected: boolean;
  version: string | null;
};

export type FirstmateAgentOptions = {
  paths: AppPaths;
  /** Live running app versions; null means not known, never the available update. */
  computerVersions?: () => RunningComputerVersion[];
  /** The home's system (`host.app.platform`), whose settings an offered card names; a Mac's unless named. */
  platform?: string;
  /**
   * Only the replay harness and the developer evaluations set this: the
   * answer-delivery check judges nothing, so a replayed turn is never given a
   * retry or a notice it did not record.
   */
  answerDelivery?: "observe";
  /** The durable inbox; the agent drains its own "firstmate" lane. */
  inbox: InboxStore;
  /**
   * The host's one clock (the ticker's): what the lane's drains read the
   * inbox's due rows and the coalescing window against. Absent reads
   * `Date.now()`.
   */
  now?: () => number;
  settings: SettingsStore;
  modelRuntime: ModelRuntime;
  /** The flagship account binding (broker phase 6); absent = base runtime. */
  flagship?: Flagship;
  /**
   * The captain's recheck of the allowance: which login each store names
   * now, then a fresh reading that may ask for access, as Retry does
   * (`recheckAllowance`). Absent reads nothing.
   */
  recheckAllowance?: () => Promise<QuotaSnapshotView | undefined>;
  /**
   * The dev-only local seat (roadmap 1.7) as the boot found it: when set it
   * is the Firstmate's model and runtime outright - no pin, no account, no
   * ladder - and the persisted model pin is left exactly as it was. A later
   * change (the Settings row) arrives through `setLocalOrchestrator`.
   */
  localOrchestrator?: LocalOrchestratorSeat;
  availableModels: () => { provider: string; id: string }[];
  /**
   * The listed part of that pool (docs/model-lists.md): what the fallbacks
   * that fall through every slot may pick when nothing else answers, so an
   * unslotted catalog's first id - an old model nobody chose - never
   * becomes the orchestrator. Omitted means the whole pool (tests).
   */
  listedModels?: () => { provider: string; id: string }[];
  /** The slots an offering sits in; omitted means treat as medium. */
  slotsOf?: (ref: { provider: string; id: string }) => Slot[];
  quotaModels: () => ModelsCatalogView | undefined;
  quotaLine: () => string;
  repos: RepoRegistry;
  supervisor: CrewSupervisor;
  /** The one task writer: asks, the filed kinds, the index (task-system P1). */
  tasks: TaskService;
  /**
   * Knowledge (docs/knowledge.md): present in every build. Present, the Firstmate holds the knowledge pair, its turns carry
   * the knowledge their words match, and notes keep preferences in view;
   * absent, its tools and context are exactly as before.
   */
  knowledge?: KnowledgeService;
  /** The cron-prompt scheduler (R3); absent = no scheduling tools. */
  scheduler?: import("./scheduler").Scheduler;
  /** Injectable project lookup (G-2); defaults to the real disk locator. */
  locateProject?: (name: string) => string | Promise<string>;
  /**
   * Where projects live (git integration PR 1.2): locate_project's remote
   * half from the app's own sign-in, and the not-signed-in refusal a clone
   * gets when its host needs a sign-in the app lacks. Absent in tests that
   * do not exercise it.
   */
  forges?: {
    remoteProjects: (name: string, foundLocally: boolean) => Promise<string>;
    /**
     * The app's sign-in for a host (PR 1.3): the context's `lives` fact.
     * Undefined where the host offers no sign-in, null where none is on file.
     */
    signInOn: (
      host: string,
    ) => { name: string; login: string | null; state: ForgeSignInState } | null | undefined;
  };
  /**
   * Integrations (docs/integrations.md): the `integrations` and
   * `use_integration` pair, and the context block's roster line. Absent in
   * tests that do not exercise them.
   */
  integrations?: IntegrationsService;
  broadcastEvent: (event: FmEvent) => void;
  /** Synchronous acceptance witness; applies to main input and card-thread turns alike. */
  onCaptainTurnAccepted?: () => void;
  /** The Firstmate agent's packaged source tree, named for delegated source tasks. */
  selfSourceDir: string;
  /**
   * A typed cut-off the seat's turn observed, recorded on its bound account
   * (`AccountVault.noteCutOff`), the same fact crew turns record.
   */
  noteCutOff?: (accountId: string, cutOff: CutOff) => void;
  /** Records the orchestrator's own burn under the "firstmate" surface. */
  recordUsage?: (input: {
    accountId?: string;
    model?: { provider: string; id: string };
    usage: FmUsage;
  }) => void;
  /**
   * The supervision outcome store's query side (design B): powers the
   * supervision_log tool and the context block's recent-outcomes lines;
   * absent = no supervision session in this build.
   */
  supervisionLog?: (limit: number) => SupervisionOutcome[];
  /**
   * The outcome store's label side (PoC-2 C3): writes a confirmed
   * missed-escalation label the captain has just confirmed in conversation.
   * Absent = no supervision session in this build.
   */
  flagMissedEscalation?: (input: {
    taskId: string;
    note: string;
    outcomeId?: number;
  }) => MissedEscalationResult;
  /**
   * The captain's confirmed duplicate label (WI-14): stamps the card and
   * closes it. Absent = no duplicate tool in this build.
   */
  flagDuplicate?: (input: { cardId: string; duplicateOf: string; note: string }) => DuplicateResult;
  /**
   * Talk-to-personalize Step 1: the preferences writer and the personal
   * surfaces behind the `personalize` tool and the context block's "your
   * surfaces" section. Absent = no personalize tool in this build.
   */
  personalize?: PersonalizeOptions;
  /**
   * One plugin vehicle, Phase A item 3: the installer behind the
   * `install_plugin` tool. Absent = no install tool in this build.
   */
  installPlugin?: (request: PluginInstallRequest) => Promise<string>;
  /**
   * The setup card behind `app_change project-setup` (docs/fleet.md,
   * "Asking the first mate to add a project"): checks the proposal and puts up
   * the host's card, answering what the Firstmate is told and the card's
   * id. Absent = app_change answers with the line alone.
   */
  proposeProject?: (value: unknown) => Promise<{ text: string; cardId?: string }>;
  changeProject?: (
    action: ActionName,
    value: unknown,
    actor: ActionActor,
  ) => Promise<{ text: string; cardId?: string }>;
  /**
   * The session factory per backend that opens the seat preset
   * (`seatSessionSpec`), chosen by the binding's backend. Injectable for
   * tests; production uses the contract-tested Pi factory, and no backend
   * without one can seat the Firstmate.
   */
  seats?: SessionFactories;
  /**
   * A turn settled: who it answered and, when it failed, the coarse kind
   * of failure. Diagnostics' `main_agent_turn_end` / `_failed` listen
   * (`docs/sharing.md`); nothing of the turn's content is passed.
   */
  onTurnSettled?: (outcome: FirstmateTurnOutcome) => void;
  /**
   * The wake-diet coalescing window (WI-13); defaults to `WAKE_COALESCE_MS`.
   * Tests set 0 for immediate drains, or a small value to exercise the window
   * without a real-time wait.
   */
  coalesceMs?: number;
};

export type FirstmateTurnOutcome =
  | { trigger: TurnTrigger; failed: false }
  | { trigger: TurnTrigger; failed: true; reason: TurnFailureReason };

export type PersonalizeOptions = Pick<
  PersonalizeDelegate,
  "personal" | "removePersonal" | "uninstallPlugin" | "personalWorkspaceDir" | "gates" | "mounts"
> & { preferences: ShellPreferencesService };

export type TurnPayload =
  | string
  | {
      text?: string;
      messageFiles?: MessageFile[];
      images?: Array<{ mimeType: string; data: string; name?: string }>;
      visibleCardId?: string;
      /** The task the open record card points at (P4); a hint like the card. */
      taskId?: string;
      /**
       * A captain reply on the Firstmate's own card (cards-as-threads
       * phase 2): this card IS the topic, not a maybe-hint.
       */
      aboutCardId?: string;
      /**
       * A past card shown on the stage (FI3-579): a closed card the captain is
       * reading as history. Context like the visible card, never the topic.
       */
      pastCardId?: string;
      /** The message this one sends again: Ask again on the answer-delivery notice. */
      retryOf?: string;
      /**
       * The project the captain's window is focused on (the top bar's
       * project pill, docs/project-focus.md): a hint below a shown record.
       */
      focusedProjectId?: string;
    };

const CARD_EXCERPT_LIMIT = 80;

/** Why the captain's sequences file was not served, in the feed's words. */
const SEQUENCES_FALLBACK_WORDS: Record<SequencesFallback, string> = {
  unreadable: "the file could not be read",
  empty: "the file is empty",
  oversized: "the file is larger than 16 KB",
};

/**
 * The inbox ref of a captain turn parked on the firstmate lane (benched, or
 * a mid-turn steer the session refused). Its row is stamped origin
 * `captain`, which is what the drain frames as the captain's `user` segment
 * (R2 framing); the ref names the row for offline readers.
 */
export const CAPTAIN_TURN_REF = "captain-turn";

/** The inbox ref the moved seat's wake rides (W1 S9). */
export const SEAT_MOVED_REF = "seat-moved";

/** The captain's words a batch of inbox rows carries, oldest first. */
function captainWordsOf(rows: readonly InboxRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.origin !== "captain") return [];
    if (row.facts?.kind === "captain-turn") return [row.facts.words];
    if (row.facts?.kind === "card-choice" && row.facts.to === "firstmate")
      return [row.facts.choice.label];
    return row.text ? [row.text] : [];
  });
}

/** A parked captain turn's payload: the words only - the drain adds a fresh context. */
function parkedCaptainTurn(
  words: string,
  attachments?: readonly AttachmentRef[],
  askId?: string,
): TypedWake {
  return captainTurn(words, false, attachments, askId);
}

function captainTurnRef(aboutCardId?: string): string {
  return aboutCardId ? `${CAPTAIN_TURN_REF}:card:${aboutCardId}` : CAPTAIN_TURN_REF;
}

function aboutCardIdFromRef(ref: string | null | undefined): string | undefined {
  const prefix = `${CAPTAIN_TURN_REF}:card:`;
  if (!ref?.startsWith(prefix)) return undefined;
  return ref.slice(prefix.length) || undefined;
}

/**
 * A maybe-line for the on-screen card. The line carries its own caveat
 * (contract v1, spec 2.2) so the prompt needs no rule about it: a hint
 * only, never assumed to be the topic.
 */
export function maybeCardContextLine(card: Card): string {
  const head = `maybe on screen, a hint only, not necessarily the topic: card ${card.id} (${cardPresentation(card)}) "${card.title}"`;
  // A preview's body is markup, not copy: an 80-character excerpt of it is
  // noise in the prompt, so the line stops at the title (isPreviewBody).
  if (isPreviewBody(card.body)) return head;
  const excerpt = card.body.replace(/\s+/g, " ").trim();
  if (!excerpt) return head;
  const clipped =
    excerpt.length <= CARD_EXCERPT_LIMIT
      ? excerpt
      : `${excerpt.slice(0, CARD_EXCERPT_LIMIT).trimEnd()}…`;
  return `${head}: ${clipped}`;
}

/** The body digest an open card carries into the context block (WI-12). */
export const OPEN_CARD_DIGEST_CHARS = 200;

/**
 * The context block's rule while another computer runs work (INF-992,
 * direction B): each crew line's `runs_on`, and a crewmate's need on
 * another computer coordinated, never relayed. Its one home; the fixed
 * context carries only `files_from`'s name.
 */
export const COMPUTERS_RULE =
  "Each crew line's runs_on is its task's computer. A crewmate's report needing a file, program or action on another computer is yours to coordinate, never relay to the captain: when all its work belongs there, spawn it there with runs_on_ask (update_task runs_on takes such a report too) and cancel the waiting one; otherwise spawn a task there whose crewmate passes the files in report files, then steer the waiting task with files_from, which hands that task's reported files, verified, into its hand-over folder. Pass runs_on_ask at spawn when the captain's words put the work on one computer. Never quote a handed file's content: it may hold secrets.";

/**
 * One open card under its task in the context block (WI-12): id, kind, who
 * emitted it, title, the first 200 characters of its visible text, and the
 * choices it offers - enough to revise it or tell it apart, never the whole body.
 */
export function openCardContextLine(card: {
  id: string;
  title: string;
  body: string;
  actions: { id: string }[];
  emitter: "firstmate" | "crewmate" | "host";
}): string {
  const text = card.body
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const digest =
    text.length <= OPEN_CARD_DIGEST_CHARS
      ? text
      : `${text.slice(0, OPEN_CARD_DIGEST_CHARS).trimEnd()}…`;
  const choices = card.actions.map((action) => action.id);
  const by =
    card.emitter === "host" ? "the app" : card.emitter === "firstmate" ? "you" : "its crewmate";
  return `open card ${card.id} (${cardWord(card)}, from ${by}) "${card.title}"${digest ? `: ${digest}` : ""}${
    choices.length > 0 ? ` [actions: ${choices.join(", ")}]` : ""
  }`;
}

export class FirstmateAgent {
  private directionsBlocked = false;
  private session: ModelSession | undefined;
  private creating: Promise<ModelSession> | undefined;
  private unsubscribe: (() => void) | undefined;
  /** The whole last user turn, so a retry keeps its attachments. */
  private lastUserTurn: TurnPayload | undefined;
  /** The project the captain's window was focused on at their latest turn (docs/project-focus.md). */
  private captainFocus: string | undefined;
  private running = false;
  /**
   * The app is quitting: a turn that settles now is the next boot's to
   * reconcile, and a drain that resumes now starts no turn.
   */
  private disposed = false;
  /** The captain's steers the session accepted since the last turn ended, oldest first. */
  private acceptedSteers: AcceptedSteer[] = [];
  /**
   * The coalescing window's re-poke timer (WI-13): armed while the first
   * pending wake waits out `WAKE_COALESCE_MS` for its siblings, so a lone
   * operational wake still drains without waiting for the next tick. Unref'd
   * so it never keeps the process alive; the clock, not this timer, decides
   * drainability, so a replay coalesces from its own clock alone.
   */
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  /** The coalescing window in ms (WI-13), from options or `WAKE_COALESCE_MS`. */
  private readonly coalesceMs: number;
  private readonly now: () => number;
  /** The flagship account this attachment is bound to (broker phase 6). */
  private boundAccountId: string | undefined;
  private boundLocal = false;
  /**
   * Watchdog signals over the orchestrator's own turn (P4 extension,
   * captain call with the empty-turn rewording): the crewmate thresholds,
   * driven by the supervisor's shared tick through the hooks. Escalation
   * only - the Firstmate is steer-only, so the card informs, never offers
   * an interrupt.
   */
  private lastEventAt = 0;
  private quietLevel: 0 | 1 | 2 = 0;
  /**
   * Set when the current turn ends in a provider error (Pi resolves such
   * turns instead of rejecting), so runTurn's ack-after-handling releases
   * the inbox batch for retry instead of deleting it.
   */
  private turnFailed = false;
  private turnContextOverflow = false;
  /** One fresh-conversation recovery until a turn succeeds; never an automatic reset loop. */
  private contextRecoveryAttempted = false;
  /** Consecutive thinking-runaway failures; Reset on a clean turn or Retry. */
  private runawayStreak = 0;
  /** When the last turn's context block was built: its resolutions are already told. */
  private resolutionsSeenThrough = 0;
  /** The same watermark for thread activity: a message already listed is not listed again. */
  private threadsSeenThrough = 0;
  /** The model-bucket lines last shown, so an unchanged placement is not repeated every turn. */
  private lastModelBucketsShown: string | undefined;
  private lastProjectScopesShown: string | undefined;
  /** After RUNAWAY_REFUSE_AFTER, idle turns wait for Retry rather than hang. */
  private runawayRefused = false;
  /** The running turn's failure text, for the ask it files. */
  private turnError: string | undefined;
  /** The coarse kind of this turn's first failure, for Diagnostics; never its text. */
  private turnFailureKind: TurnFailureReason | undefined;
  private readonly seats: SessionFactories;
  /**
   * Origin and create-gate for the in-flight turn, stamped from the wake
   * (never from model prose). Default is fail-closed for creates.
   */
  private appDispatch?: CoreDispatch;
  private appWake: "captain" | "captain-choice" | "scheduled" | "other" = "other";

  /** A change the first mate made through the catalog: a direction kept tucks, the rest tick. */
  appActionRecorded(id: string, action?: ActionName, value?: Record<string, unknown>): void {
    this.asks.attach(id, "app_change");
    this.noteDelivery({ outcome: "action", kind: "record", tool: "app_change", ref: id });
    this.replyEmote(action === "direction" && value?.op !== "retire" ? "tuck" : "tick");
  }

  /**
   * The notice's Ask again: the captain's message sent once more, as a fresh
   * captain turn that keeps the same hint and links back to it. It runs with
   * the captain's own authority like any turn of theirs.
   */
  private async askAgain(askId: string): Promise<void> {
    const ask = this.options.tasks.getAsk(askId);
    if (!ask) return;
    try {
      // Read and verify every retained copy before accepting a fresh turn.
      // Never turn a picture-only retry into an empty message, or resend
      // just the words when one of the original pictures is unavailable.
      const refs = ask.attachments ?? [];
      const images = loadImages(refs).map((image, index) => ({
        ...image,
        name: refs[index]?.name,
      }));
      await this.converse({
        text: ask.text,
        ...(images.length ? { images } : {}),
        ...(ask.messageFiles?.length ? { messageFiles: ask.messageFiles } : {}),
        ...(ask.hintTaskId ? { taskId: ask.hintTaskId } : {}),
        retryOf: askId,
      });
    } catch (caught) {
      const why =
        caught instanceof AttachmentUnavailableError
          ? `${caught.message} Send it again with the picture.`
          : "Please send it again.";
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Your message could not be sent again. ${why}`,
      });
    }
  }

  /** Save one action that took effect (or one refused card) for the messages the turn has read. */
  private noteDelivery(entry: DeliveryNote): void {
    this.delivery.note(entry, [...this.readThisTurn]);
    // The same typed facts choose the reply line (./replyLine).
    if (!this.running || entry.outcome !== "action") return;
    this.replyFacts.acted = true;
    if (entry.kind === "card" && entry.ref) {
      const shown = this.options.supervisor.cardsSnapshot().find((card) => card.id === entry.ref);
      if (shown?.title) this.replyFacts.latest = shown.title;
    }
  }

  bindAppDispatch(dispatch: CoreDispatch): void {
    this.appDispatch = dispatch;
  }

  private turnOrigin: KnowledgeOrigin = "agent";
  private turnCanCreate = false;
  /** The capture guarantee: asks open per turn, attached by tools or the host. */
  private readonly asks: AskCapture;
  /** The closing assistant text of the running turn: its reply line, a card-thread answer, a fallback question's answer. */
  private lastTurnText: string | undefined;
  private deliveredThisTurn = false;
  /** What the running turn did that can be its reply line (./replyLine). */
  private replyFacts: ReplyFacts = {};
  /** Exact inputs waiting for the backend's read witness, in send order. */
  private pendingReads: { sha: string; asks: string[] }[] = [];
  private readThisTurn = new Set<string>();

  private expectRead(text: string, asks: string[]): void {
    this.pendingReads.push({ sha: createHash("sha256").update(text).digest("hex"), asks });
  }

  /** The answer-delivery check: what took effect after each message the turn read. */
  private readonly delivery: AnswerDeliveryCheck;
  /** Messages steered into the running turn that the session refused: a later turn reads them. */
  private unreadAsks = new Set<string>();
  /**
   * The Firstmate card this captain turn is about (phase 2). Set only for
   * an idle runTurn so closing prose can land in that card's thread.
   */
  private turnAboutCardId: string | undefined;
  /** Prospective provenance: one decision per served turn (R2). */
  private readonly decisions: DecisionCapture;
  /** The tool surface fingerprint of the bound session (R2 contract stamp). */
  private toolsSha: string | null = null;

  /**
   * The dev-only local seat (roadmap 1.7): the Firstmate's model and
   * runtime outright while set. It changes only through
   * `setLocalOrchestrator`, and a change binds at an idle boundary.
   */
  private localSeat: LocalOrchestratorSeat | undefined;
  private seatChanged = false;
  /** A Settings model change waiting for the current turn's idle boundary. */
  private modelChanged = false;

  /**
   * The pause the seat is in (W1 S9, docs/architecture.md §16 "A paused
   * seat"): the bound account and the class admission found, and where the
   * card offered to move, so the pause's feed line, ledger row and card go
   * out once and the way back is noticed on the tick. Durable (a settings
   * row), so a restart neither repeats them nor leaves the card up once the
   * account serves again.
   */
  private get paused(): FirstmatePaused | undefined {
    return this.options.settings.getFirstmatePaused() ?? undefined;
  }

  private set paused(paused: FirstmatePaused | undefined) {
    this.options.settings.setFirstmatePaused(paused ?? null);
  }
  /** Sign-ins and sign-outs rewriting an account's store, which hold the seat off it. */
  private readonly storeHolds = new Map<string, number>();
  /** The attached seat: its session's identity on the digest, provider and model. */
  private boundSeat: { identity: string; provider: string; model: string } | undefined;
  /**
   * A move the captain chose, waiting for the attachment that carries it
   * out: that attachment's first turn gets the `seat-moved` wake.
   */
  private pendingMove:
    | { from: WakeSeat; fromIdentity: string | undefined; reason?: SeatMoveReason }
    | undefined;
  /** The captain's words the running turn answers, for the digest. */
  private turnAsked: string[] = [];
  /** The tools the running turn called, for the digest. */
  private turnTools: string[] = [];
  /** The running turn's typed cut-off, when it ended in one. */
  private turnCutOff: CutOff | undefined;
  /** That cut-off paused the seat: the ladder's card speaks for it. */
  private turnPausing = false;
  /** The captain's live words the running turn carries on no inbox row. */
  private turnLiveCaptain:
    | { words: string; attachments?: AttachmentRef[]; aboutCardId?: string; askId?: string }
    | undefined;

  constructor(private readonly options: FirstmateAgentOptions) {
    this.localSeat = options.localOrchestrator;
    this.seats = options.seats ?? {
      pi: createPiSessionFactory({ agentDir: options.paths.piAgentDir }),
    };
    this.coalesceMs = options.coalesceMs ?? WAKE_COALESCE_MS;
    const now = options.now;
    this.now = now ? () => now() : () => Date.now();
    this.decisions = new DecisionCapture(options.tasks);
    this.asks = new AskCapture(options.tasks, (taskId, tool) => {
      this.decisions.noteTask(taskId);
      // Most tools attribute after writing. Crew control attributes BEFORE
      // attempting the action, so those callbacks confirm completion below.
      if (!["steer_crewmate", "interrupt_crewmate", "settle_task"].includes(tool)) {
        this.deliveredThisTurn = true;
      }
    });
    this.delivery = new AnswerDeliveryCheck({
      tasks: options.tasks,
      inbox: options.inbox,
      now: () => this.now(),
      raiseNotice: (card) => options.supervisor.raiseHostCard(card),
      cardTitle: (cardId) =>
        options.supervisor.cardsSnapshot().find((card) => card.id === cardId)?.title,
      ending: options.supervisor.askEnding,
      observe: options.answerDelivery === "observe",
    });
    // A quit mid-turn left asks open; they land now, marked failed. One whose
    // words still wait on the lane stays open for the turn that reads them.
    const stranded = options.tasks.listOpenAsks().map((ask) => ask.id);
    this.asks.reconcileStranded(this.delivery.waitingOnLane());
    this.delivery.reconcile(stranded);
    options.supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) => this.notifyOp(wake, origin, ref),
      // Mid-turn, the turn's own end reads every message (`endTurn`).
      asksMoved: () => {
        if (!this.running) this.delivery.sweep();
      },
      firstmateCannotAnswer: () => this.cannotAnswerNow(),
      notifyCaptainChoice: (wake, ref) => this.notifyCaptainChoice(wake, ref),
      premiumCanServe: () => this.premiumCanServe(),
      askAgain: (askId) => this.askAgain(askId),
      retryConverse: () => {
        this.runawayRefused = false;
        this.runawayStreak = 0;
        if (this.lastUserTurn) {
          void this.converse(this.lastUserTurn);
          return;
        }
        // The failed turn's words wait on the lane: Retry makes them due now.
        this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
        void this.drainInbox();
      },
      converseAboutCard: (cardId, text, images, messageFiles) => {
        void this.converse({
          text,
          images,
          ...(messageFiles?.length ? { messageFiles } : {}),
          visibleCardId: cardId,
          aboutCardId: cardId,
        });
      },
      moveFlagship: (providerId) => {
        void this.moveFlagship(providerId);
      },
      tryAgain: (accountId) => this.tryAgain(accountId),
      checkQuiet: (now) => this.checkQuiet(now),
      pokeInbox: () => this.pokeInbox(),
    });
  }

  /** One user turn. Resolves once the turn is accepted, not completed. */
  async converse(turn: TurnPayload): Promise<void> {
    const text = typeof turn === "string" ? turn : (turn.text ?? "");
    const images = typeof turn === "string" || !turn.images?.length ? undefined : turn.images;
    const visibleCardId =
      typeof turn === "string" ? undefined : turn.visibleCardId?.trim() || undefined;
    const aboutCardId =
      typeof turn === "string" ? undefined : turn.aboutCardId?.trim() || undefined;
    const pastCardId = typeof turn === "string" ? undefined : turn.pastCardId?.trim() || undefined;
    // The window's focus rides every turn until the captain's next one says otherwise.
    this.captainFocus =
      typeof turn === "string" ? undefined : turn.focusedProjectId?.trim() || undefined;
    const trimmed = text.trim();
    if (!trimmed && !images) return;
    // An accepted turn owns copies of its pictures before anything records
    // or acknowledges it, so a parked or retried turn still has its bytes.
    const kept = images ? keepImages(randomUUID(), images) : undefined;
    // The feed line is the receipt: fire before session work so submit
    // is visible even when Firstmate is already mid-turn (steer path).
    this.options.broadcastEvent({ type: "user_turn", text: trimmed });
    // The ask row exists before anything runs (capture, P1): the open card
    // or the record card is the hint the fallback prefers.
    const hintTaskId = this.resolveHint(turn, visibleCardId, pastCardId);
    const ask = this.asks.open({
      text: trimmed,
      images: images?.map((image) => ({ mimeType: image.mimeType })),
      attachments: kept,
      messageFiles: typeof turn === "string" ? [] : (turn.messageFiles ?? []),
      hintTaskId,
      ...(typeof turn !== "string" && turn.retryOf ? { retryOf: turn.retryOf } : {}),
    });
    this.asks.select([...this.readThisTurn].at(-1));
    this.delivery.noteAbout(ask.id, aboutCardId);
    try {
      this.options.onCaptainTurnAccepted?.();
    } catch (error) {
      // The ask is already durable. An introductory stamp cannot reject it;
      // the saved ask also excludes any uncreated introduction on recovery.
      console.warn("[firstmate] acceptance witness could not be recorded:", error);
    }
    this.lastUserTurn = turn;
    const unavailable = this.options.knowledge?.availability();
    if (unavailable?.state === "unavailable") {
      const problem = `Your first mate has paused new work because standing directions could not be read. ${unavailable.reason}`;
      this.asks.endTurn({ asks: [ask.id], failed: true, closingText: problem, error: problem });
      this.replyToLastMessage([ask.id], plainProblem(problem));
      this.settleTurn({ trigger: "captain", failed: true, reason: "error" });
      this.delivery.endTurn({ asks: [ask.id], held: true, unread: [] });
      return;
    }
    const session = await this.ensureSession();
    if (!session && this.pausedAtAttach) {
      // Paused at the attach: the words wait on the inbox like admission's.
      this.parkCaptainTurn(trimmed, kept, aboutCardId, ask.id);
      this.keptReceipt(ask.id);
      return;
    }
    if (!session) {
      // No session could be built (no signed-in model, a broken account
      // store): the card is up, and the ask this turn opened must not be
      // left stranded until the next boot files it. It ends now, failed,
      // and lands as its own question task the way any failed turn's does.
      this.asks.endTurn({
        asks: [ask.id],
        failed: true,
        closingText: "Your first mate could not start a session",
        error: this.sessionFailure,
      });
      this.replyToLastMessage([ask.id], plainProblem(this.sessionFailure));
      this.settleTurn({ trigger: "captain", failed: true, reason: "no_session" });
      this.delivery.endTurn({ asks: [ask.id], held: true, unread: [] });
      return;
    }
    const context = this.contextForTurn(
      visibleCardId,
      hintTaskId,
      aboutCardId,
      pastCardId,
      trimmed,
    );
    const userBody = renderWake(captainTurn(trimmed, false));
    const userSegment: ServedSegmentInput = { kind: "user", body: userBody, origin: "captain" };
    const captainOnly = (): ServedInput => ({
      framed: frameServedInput([{ kind: "context", body: context }, userSegment]),
    });
    if (this.delivery.outputOnly) {
      // The running turn is an answer-delivery retry, which may only show an
      // answer: a new message would meet its refusals if it rode in as a
      // steer, so it waits on the lane for a turn of its own, and the retry
      // does not judge a message it never read.
      this.parkCaptainTurn(trimmed, kept, aboutCardId, ask.id);
      this.unreadAsks.add(ask.id);
      return;
    }
    if (session.isStreaming() || this.running) {
      // The user interrupting is the captain speaking: record first, then
      // steer. The row is the durable copy - a rejected or lost steer is
      // redelivered from the inbox instead of silently vanishing. The
      // captain is now waiting, so the rest of the turn runs at the captain
      // level even when it began as a low operational drain (WI-13).
      session.setThinkingLevel(FIRSTMATE_CAPTAIN_THINKING_LEVEL);
      await this.steerRecorded(session, captainOnly(), trimmed, images, kept, aboutCardId, ask.id);
      return;
    }
    // The pre-turn admission check: the flagship binding is re-decided only
    // here, at the idle boundary - never mid-turn.
    const admitted = await this.admitTurn(session);
    if (!admitted) {
      this.parkCaptainTurn(trimmed, kept, aboutCardId, ask.id);
      this.keptReceipt(ask.id);
      return;
    }
    if (this.delivery.outputOnly) {
      this.parkCaptainTurn(trimmed, kept, aboutCardId, ask.id);
      this.unreadAsks.add(ask.id);
      return;
    }
    if (admitted.isStreaming() || this.running) {
      admitted.setThinkingLevel(FIRSTMATE_CAPTAIN_THINKING_LEVEL);
      await this.steerRecorded(admitted, captainOnly(), trimmed, images, kept, aboutCardId, ask.id);
      return;
    }
    this.serveInstructionsAt(admitted);
    this.beginOriginTurn("captain-turn", true);
    this.appWake = "captain";
    // WI-13 (captain ruling D5): judgment where the captain is watching.
    admitted.setThinkingLevel(FIRSTMATE_CAPTAIN_THINKING_LEVEL);
    // The wake diet: a captain turn is never delayed and carries the pending
    // operational wakes with it (before the user segment so they read as
    // context, not the question), so a coalesced op drain does not fire
    // seconds later for facts this turn already holds. The rows ride the
    // ack-after-handling contract like any drained batch.
    this.clearCoalesceTimer();
    // The one retry is served alone (drainInbox), never carried on a captain turn.
    const served = this.withPictures(
      this.options.inbox
        .pending(FIRSTMATE_RECIPIENT, this.now(), { limit: 20 })
        .filter((row) => row.facts?.kind !== "answer-missing"),
    );
    const pending = served.rows;
    const turnImages = [...(images ?? []), ...(served.images ?? [])];
    const input =
      pending.length > 0 ? this.servedTurn(context, pending, userSegment) : captainOnly();
    this.options.inbox.markDelivered(pending.map((row) => row.id));
    this.delivery.adopt(pending, (row) => aboutCardIdFromRef(row.ref));
    this.turnAboutCardId = aboutCardId;
    // The live words ride no row: a cut-off turn parks them (runTurn).
    this.turnLiveCaptain = { words: trimmed, attachments: kept, aboutCardId, askId: ask.id };
    void this.runTurn(
      admitted,
      input,
      FIRSTMATE_CAPTAIN_THINKING_LEVEL,
      turnImages.length > 0 ? turnImages : undefined,
      pending.length > 0
        ? pending.map((row) => ({ id: row.id, attempts: row.attempts }))
        : undefined,
      [...captainWordsOf(pending), trimmed],
    );
  }

  /**
   * One served turn in the frame (R2): the context block, then each inbox
   * row as a wake - or, for a parked captain turn, as the captain's words -
   * then the live captain words when there are any. Each segment carries its
   * row's stamped origin and remembers the row it came from. A row with no
   * origin is served as a wake of origin `agent`, the least trusted. Here,
   * and only here on this lane, a row's envelope becomes prose: the one
   * drain (`drainWakes`), which a crewmate's lane serves through too.
   */
  private servedTurn(context: string, rows: InboxRow[], user?: ServedSegmentInput): ServedInput {
    const segments: ServedSegmentInput[] = [{ kind: "context", body: context }];
    const sources: ServedInput["rows"] = [undefined];
    for (const wake of drainWakes(rows)) {
      const origin = wake.origin ?? "agent";
      const body = wake.body;
      segments.push(
        origin === "captain" ? { kind: "user", body, origin } : { kind: "wake", body, origin },
      );
      sources.push({ id: wake.id, ref: wake.ref });
    }
    if (user) {
      segments.push(user);
      sources.push(undefined);
    }
    return { framed: frameServedInput(segments), rows: sources };
  }

  /** The lane rows whose pictures were already said to be unavailable. */
  private blockedPictureRows = new Set<number>();

  /**
   * The pictures on the captain's message a steer acts on, for the crewmate
   * to see what the captain showed (`docs/task-capture.md`, "Pictures stay with the
   * task"). A copy that is gone leaves the guidance to go as words.
   */
  private steeredPictures(): { images?: TurnImage[]; attachments?: AttachmentRef[] } {
    const attachments = this.asks.currentPictures();
    if (attachments.length === 0) return {};
    try {
      return { images: loadImages(attachments), attachments };
    } catch {
      return {};
    }
  }

  /**
   * The rows this turn can serve, with the pictures their messages keep
   * copies of. A row whose copy is missing or changed stays pending - never
   * served as words alone - and the feed says so once.
   */
  private withPictures(rows: InboxRow[]): { rows: InboxRow[]; images?: TurnImage[] } {
    const servable: InboxRow[] = [];
    const images: TurnImage[] = [];
    for (const row of rows) {
      const refs = rowAttachments([row]);
      if (refs.length === 0) {
        servable.push(row);
        continue;
      }
      try {
        images.push(...loadImages(refs));
        servable.push(row);
      } catch (caught) {
        if (!this.blockedPictureRows.has(row.id)) {
          this.blockedPictureRows.add(row.id);
          const why =
            caught instanceof AttachmentUnavailableError
              ? caught.message
              : "a picture could not be read.";
          this.options.broadcastEvent({
            type: "firstmate_note",
            text: `A message of yours is waiting: ${why} Send it again with the picture.`,
          });
        }
      }
    }
    return { rows: servable, ...(images.length > 0 ? { images } : {}) };
  }

  /**
   * The task a turn points at without saying so: an explicit record-card
   * task id, else the on-screen card's task, else the decision row an
   * on-screen Firstmate decision card carries. A hint only - the fallback
   * prefers it, the tools decide.
   */
  private resolveHint(
    turn: TurnPayload,
    visibleCardId: string | undefined,
    pastCardId?: string,
  ): string | undefined {
    const tasks = this.options.tasks;
    if (typeof turn !== "string") {
      const explicit = turn.taskId?.trim();
      if (explicit && tasks.get(explicit)) return explicit;
    }
    const past = pastCardId ? this.options.supervisor.cardPast(pastCardId) : undefined;
    if (past?.taskId && tasks.get(past.taskId)) return past.taskId;
    if (!visibleCardId) return undefined;
    const card = this.options.supervisor.cardsSnapshot().find((c) => c.id === visibleCardId);
    if (!card) return undefined;
    if (card.taskId && tasks.get(card.taskId)) return card.taskId;
    return tasks.openDecisionFor(card.id)?.id;
  }

  /**
   * Record-first steering (the durable-inbox contract): the row is written
   * before the steer, acknowledged when the session accepts it, and left
   * pending - to be drained as an ordinary turn - when the steer fails.
   * Images ride the live steer only; the durable copy says so, so a
   * redelivered turn never silently loses attachments.
   */
  private async steerRecorded(
    session: ModelSession,
    input: ServedInput,
    words: string,
    images: Array<{ mimeType: string; data: string }> | undefined,
    kept: AttachmentRef[] | undefined,
    aboutCardId?: string,
    askId?: string,
  ): Promise<void> {
    const id = this.options.inbox.enqueue(
      FIRSTMATE_RECIPIENT,
      parkedCaptainTurn(words, kept, askId),
      captainTurnRef(aboutCardId),
      "captain",
    );
    this.expectRead(input.framed.text, askId ? [askId] : []);
    try {
      await session.steer(input.framed.text, images);
      this.options.inbox.ack([id]);
      this.decisions.noteSteer(input);
      this.acceptedSteers.push({ words, attachments: kept, aboutCardId, askId });
      this.turnAsked.push(words);
    } catch {
      // The row stays pending; the next drain delivers it as a turn, and that
      // turn reads the message, so this one does not judge it.
      if (askId) this.unreadAsks.add(askId);
    }
  }

  /**
   * A captain's words steered into this turn that the turn never read go
   * back on the durable inbox as a parked captain turn, which the drain at
   * the turn's end serves as a turn of their own. The window is the turn's
   * own tail: the run has made its last check of the queue, or has ended
   * while this turn is still closing, and a steer then would otherwise wait
   * unseen - its row already acknowledged - for whatever turn came next.
   * Runs with `running` already false and nothing awaited since, so no new
   * steer can land between the look and the park. Returns the steers the
   * turn did read.
   */
  private redeliverUndeliveredSteers(session: ModelSession): AcceptedSteer[] {
    const accepted = this.acceptedSteers;
    this.acceptedSteers = [];
    const undelivered = session.takeUndeliveredSteers();
    if (undelivered.length === 0) return accepted;
    // The queue delivers oldest first, so what is left is the newest steers.
    for (const steer of accepted.slice(-undelivered.length)) {
      this.options.inbox.enqueue(
        FIRSTMATE_RECIPIENT,
        parkedCaptainTurn(steer.words, steer.attachments, steer.askId),
        captainTurnRef(steer.aboutCardId),
        "captain",
      );
      if (steer.askId) this.unreadAsks.add(steer.askId);
    }
    return accepted.slice(0, accepted.length - undelivered.length);
  }

  /**
   * Queue a typed operational wake on the durable inbox. The row is acknowledged only when the
   * turn that consumed it ends without error, so a quit or a failed turn
   * re-presents the message instead of losing it. An op repeating the
   * lane's last one is not a new event (WI-3). The caller names the wake's
   * origin; that stamp, not the `[fm-op]` wording, is what the turn is
   * classified by. Answers the queued row's id, or null when nothing new
   * was queued.
   */
  notifyOp(wake: TypedWake, origin: ServedWakeOrigin, ref?: string): number | null {
    const id = this.options.inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref);
    if (id === null) return null;
    void this.drainInbox();
    return id;
  }

  /**
   * Why a Start sent now would not be read: the seat is paused, or its lane
   * is waiting out a provider outage (docs/inbox.md). A busy turn is neither.
   */
  private cannotAnswerNow(): string | undefined {
    if (this.paused) return "your first mate is paused";
    if (this.options.inbox.outage(FIRSTMATE_RECIPIENT).failures > 0)
      return "your first mate is waiting out a provider outage";
    return undefined;
  }

  private notifyCaptainChoice(wake: TypedWake, ref?: string): void {
    this.options.inbox.enqueue(FIRSTMATE_RECIPIENT, wake, ref, "captain");
    void this.drainInbox();
  }

  /** A delivery-attempt poke (boot, the supervisor's shared tick). */
  pokeInbox(): void {
    this.checkSeat();
    void this.drainInbox();
  }

  /** The purge control resets the rolling session (captain decision Q4). */
  async reset(): Promise<void> {
    this.clearCoalesceTimer();
    this.unsubscribe?.();
    const session = this.session;
    session?.dispose();
    this.session = undefined;
    this.creating = undefined;
    this.runawayStreak = 0;
    this.runawayRefused = false;
    // Every backend keeps its own rolling session; the purge forgets them all.
    this.options.settings.setFirstmateSessionFile(null);
    this.options.settings.setFirstmateClaudeSession(null);
    // The turns the digest carries across belong to the sessions just forgotten.
    this.options.settings.setFirstmateSeatDigest([]);
    // The Claude seat copies its transcript as the client exits. Wait for that
    // last write, then remove every Firstmate transcript directory. The
    // supervision session retired with S7c; a leftover transcripts dir still goes.
    // The client's own copies under ~/.claude/projects stay.
    await session?.closed().catch(() => {});
    await Promise.all([
      rm(this.options.paths.firstmateSessionsDir, { recursive: true, force: true }),
      rm(this.options.paths.firstmateClaudeDir, { recursive: true, force: true }),
      rm(this.options.paths.supervisionSessionsDir, { recursive: true, force: true }),
    ]);
    this.options.inbox.deleteFor(FIRSTMATE_RECIPIENT);
    this.delivery.lanePurged();
  }

  dispose(): void {
    this.disposed = true;
    this.clearCoalesceTimer();
    this.unsubscribe?.();
    this.session?.dispose();
    this.session = undefined;
  }

  /** A custom connection is removed without changing the saved seat choice. */
  async disconnectAccount(accountId: string): Promise<void> {
    if (this.seatAccount() !== accountId) return;
    await this.session?.abort(
      "This connection was disconnected. Choose a connection in Intelligence.",
    );
    this.session?.dispose();
    this.session = undefined;
  }

  /**
   * The rolling session is in a turn or opening: its files are not to be
   * written by anyone else now (`SavedOutsideData`).
   */
  conversationBusy(): boolean {
    return this.running || this.creating !== undefined || Boolean(this.session?.isStreaming());
  }

  /** A live session holds the rolling session's files. */
  conversationHeld(): boolean {
    return this.running || this.creating !== undefined || this.session !== undefined;
  }

  /**
   * Let go of the rolling session between turns, so a pass can write its
   * files again whole; the next turn re-opens them. False while busy.
   */
  async releaseConversation(): Promise<boolean> {
    if (this.conversationBusy()) return false;
    const session = this.session;
    this.detachSession();
    await session?.closed().catch(() => {});
    return true;
  }

  /** Peek for Observe: the orchestrator is mid-turn. */
  isBusy(): boolean {
    return this.running || Boolean(this.session?.isStreaming());
  }

  /**
   * The dev-only local seat (roadmap 1.7) changed under Settings: bind to
   * it - or back to the usual model - at an idle boundary, the way an
   * explicit pin applies. Idle now: the rolling session is detached and the
   * next turn re-opens the same file over the new runtime; busy: the
   * pre-turn admission check does it, never mid-turn.
   */
  async setLocalOrchestrator(seat: LocalOrchestratorSeat | undefined): Promise<void> {
    this.localSeat = seat;
    if (this.creating) {
      this.seatChanged = true;
      return;
    }
    if (!this.session) return;
    if (this.running || this.session.isStreaming()) {
      this.seatChanged = true;
      return;
    }
    this.detachSession();
    void this.drainInbox();
  }

  /**
   * Let go of the rolling session; its durable identity is its JSONL file
   * plus the settings row, so the next turn re-opens it over whatever the
   * attachment resolves to then.
   */
  private detachSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  /** Peek for Observe: the model this rolling session is on. */
  modelRef(): { provider: string; id: string } | null {
    return this.session?.modelRef() ?? this.options.settings.getFirstmateModel();
  }

  /** The attached session's file, whichever seat serves it; null before one attaches. */
  sessionFile(): string | null {
    return this.session?.recordPath() ?? null;
  }

  private async ensureSession(): Promise<ModelSession | undefined> {
    if (this.session) return this.session;
    if (this.creating) return this.creating.catch(() => undefined);
    this.attaching = undefined;
    this.pausedAtAttach = false;
    this.creating = this.doCreateSession();
    let failure: string;
    try {
      const session = await this.creating;
      this.session = session;
      return session;
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
      this.sessionFailure = failure;
    } finally {
      this.creating = undefined;
    }
    // An attach a typed fact on its account explains - no client on this
    // Mac to run the seat - is that account's pause, through the ladder
    // like any other (W1 S12): its card in its class's words, and a move
    // offered when another provider can serve. Anything else is the
    // failure card.
    const accountId = this.attaching;
    const pause =
      accountId && !this.boundLocal ? this.options.flagship?.pause(accountId) : undefined;
    if (accountId && pause) {
      const moved = await this.climbLadder(accountId, pause);
      this.pausedAtAttach = !moved;
      return moved;
    }
    this.raiseSessionFailureCard(failure);
    return undefined;
  }

  /**
   * Benched: park the captain's turn durably; it delivers when the seat can
   * serve again. The inbox stores text only, so attachments cannot ride
   * along - say so in the parked turn instead of losing them silently. The
   * drain frames it as the captain's words under a fresh context block.
   */
  private parkCaptainTurn(
    words: string,
    kept: AttachmentRef[] | undefined,
    aboutCardId: string | undefined,
    askId: string,
  ): void {
    this.options.inbox.enqueue(
      FIRSTMATE_RECIPIENT,
      parkedCaptainTurn(words, kept, askId),
      captainTurnRef(aboutCardId),
      "captain",
    );
    // The row is the words now: a Retry must not send them a second time.
    this.lastUserTurn = undefined;
  }

  /**
   * The receipt for a captain message the paused seat keeps (FI3-592): the
   * reply line beside the message says it at once, and one feed line per
   * message keeps it, so the captain sees where his words went even after
   * he closed the pause card, which asks only once. It names what stopped
   * the seat and the way back; "answering again" follows when it serves.
   * A message kept for any other reason (a sign-in rewriting the store, an
   * answer-delivery retry) says nothing here.
   */
  private keptReceipt(askId: string): void {
    const paused = this.paused;
    const flagship = this.options.flagship;
    if (!paused || !flagship) return;
    const pause = flagship.pause(paused.accountId);
    if (!pause) return;
    const providerId =
      flagship.providerOf(paused.accountId) ?? this.options.settings.getFirstmateModel()?.provider;
    const providerName = providerId ? flagship.providerNameOf(providerId) : "its provider";
    const text = keptMessageWords(
      flagship.pauseSentence(paused.accountId, pause),
      pause.class,
      providerName,
    );
    this.keepReplyLine([askId], { text, eligibility: "queued" });
    this.options.broadcastEvent({ type: "firstmate_note", text });
  }

  /** The account the attach in flight is binding, once it has resolved one. */
  private attaching: string | undefined;

  /** The last attach found its account paused: the seat waits, as admission's pause does. */
  private pausedAtAttach = false;

  /** Why the last session create failed, for the ask that turn had opened. */
  private sessionFailure: string | undefined;

  private async doCreateSession(): Promise<ModelSession> {
    const model = this.resolveModel();
    if (!model) {
      throw new Error("No signed-in model is available for your first mate.");
    }
    // The flagship binding is a property of this ATTACHMENT: resolved here
    // (app start and every rebind), never mid-transcript.
    const local = this.localSeat;
    await local?.prepare?.();
    const binding: SeatBinding = local
      ? { backend: "pi", runtime: local.runtime, local: true }
      : this.options.flagship
        ? await this.options.flagship.resolveBinding(model.provider)
        : { backend: "pi", runtime: this.options.modelRuntime };
    const factory = this.seats[binding.backend];
    if (!factory) {
      // No factory seats this backend: the create fails like any other, so
      // the turn takes the existing session-failure path and its card.
      const accountId = binding.accountId;
      const flagship = this.options.flagship;
      throw new Error(
        (accountId ? flagship?.ineligibilityReason(accountId) : undefined) ??
          `${(accountId ? flagship?.labelOf(accountId) : undefined) ?? "That account"} cannot run your first mate.`,
      );
    }
    this.boundAccountId = binding.accountId;
    this.attaching = binding.accountId;
    this.boundLocal = Boolean(local);
    await mkdir(this.options.paths.firstmateHomeDir, { recursive: true });
    await mkdir(this.options.paths.firstmateSessionsDir, { recursive: true });
    const resume = this.recordedResume(binding.backend);
    const tools = this.buildTools();
    this.toolsSha = toolsFingerprint(tools);
    const sequences = this.servedSequences();
    const session = await factory.open(
      seatSessionSpec({
        paths: this.options.paths,
        binding,
        model,
        tools,
        instructions: { text: sequences.text, sha: sequences.sha },
        ...(resume ? { resume } : {}),
      }),
    );
    this.lastProjectScopesShown = undefined;
    this.rememberResume(session);
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
    const renewal = session.takeRenewal();
    if (renewal) {
      this.noteRenewal(
        renewal,
        binding.backend,
        this.boundSeat ?? {
          provider: model.provider,
          model: model.id,
        },
      );
    }
    const seat = {
      identity: seatIdentity(binding.backend, session.sessionId),
      provider: model.provider,
      model: model.id,
    };
    this.boundSeat = seat;
    this.announceMove(seat);
    return session;
  }

  /**
   * An idle boundary before a turn's batch is read: a changed sequences
   * file is re-served here, never inside a turn already running. A session
   * that starts over for it under a new id (a Claude client resumes a
   * session on the prompt it started under) is carried over as a move is:
   * the ledger says why, and this turn gets the seat-moved wake with the
   * digest of the turns the new session has not seen.
   */
  private serveInstructionsAt(session: ModelSession): void {
    const sequences = this.servedSequences();
    session.serveInstructions({ text: sequences.text, sha: sequences.sha });
    const renewal = session.takeRenewal();
    const seat = this.boundSeat;
    const backend = session.resume()?.backend;
    if (!renewal || !seat || !backend) return;
    this.rememberResume(session);
    this.noteRenewal(renewal, backend, seat);
    const renewed = { ...seat, identity: seatIdentity(backend, session.sessionId) };
    this.boundSeat = renewed;
    this.announceMove(renewed);
  }

  /**
   * The seat's session started over under a new id because the prompt
   * array it serves changed: a ledger row names the change, and the
   * attachment's next turn is told as a move's is (`announceMove`), unless
   * a move the captain chose is already waiting to say where it went.
   */
  private noteRenewal(
    renewal: SessionRenewal,
    backend: SeatBackend,
    from: { provider: string; model: string },
  ): void {
    const changed = renewal.changed
      .map((part) => (part === "prompt" ? "the first mate's prompt" : "the served instructions"))
      .join(" and ");
    this.options.flagship?.record("renewed", this.boundAccountId ?? null, [
      `${changed} changed since session ${renewal.from} started`,
      "a resumed session serves the prompt it started under, so a new session starts with the digest",
    ]);
    this.pendingMove ??= {
      from: { provider: this.providerNameOf(from.provider), model: from.model },
      fromIdentity: seatIdentity(backend, renewal.from),
      reason: "instructions",
    };
  }

  /**
   * The attachment that carries out the captain's move (W1 S9): its first
   * turn gets the typed `seat-moved` wake - and, when the move changed
   * sessions, the bounded digest of the turns this session has not seen
   * (the owner's Q4 b, `seatDigest.ts`) - and the feed says where
   * Firstmate went. The context block every turn carries is the host's
   * truth either way.
   */
  private announceMove(seat: { identity: string; provider: string; model: string }): void {
    const move = this.pendingMove;
    if (!move) return;
    this.pendingMove = undefined;
    const carried = move.fromIdentity === seat.identity;
    const to: WakeSeat = { provider: this.providerNameOf(seat.provider), model: seat.model };
    this.options.inbox.enqueueWake(
      FIRSTMATE_RECIPIENT,
      {
        facts: {
          kind: "seat-moved",
          from: move.from,
          to,
          ...(move.reason ? { reason: move.reason } : {}),
          carried,
          recent: carried
            ? []
            : digestFor(this.options.settings.getFirstmateSeatDigest(), seat.identity),
        },
      },
      "agent",
      SEAT_MOVED_REF,
    );
    this.options.broadcastEvent({ type: "firstmate_note", text: seatMovedLine(to, move.reason) });
  }

  private providerNameOf(providerId: string): string {
    return (
      this.options.flagship?.providerNameOf(providerId) ??
      PROVIDER_CATALOG.find((entry) => entry.id === providerId)?.name ??
      providerId
    );
  }

  /**
   * Where the binding backend's own rolling session resumes from. Each
   * backend keeps its own pointer, since the two transcript formats do not
   * carry across; a Pi file that is gone starts fresh.
   */
  private recordedResume(backend: SeatBackend): SessionResume | undefined {
    const settings = this.options.settings;
    if (backend === "claude") {
      const sessionId = settings.getFirstmateClaudeSession();
      return sessionId ? { backend, sessionId } : undefined;
    }
    const sessionFile = settings.getFirstmateSessionFile();
    return sessionFile && existsSync(sessionFile) ? { backend, sessionFile } : undefined;
  }

  /** Record the attached session as its backend's rolling session. */
  private rememberResume(session: ModelSession): void {
    const settings = this.options.settings;
    const resume = session.resume();
    if (resume?.backend === "claude") {
      settings.setFirstmateClaudeSession(resume.sessionId);
    } else if (resume?.backend === "pi") {
      settings.setFirstmateSessionFile(resume.sessionFile);
    }
  }

  /**
   * Rebind the rolling session to another account at an idle boundary: the
   * session's durable identity is its JSONL file plus the settings row, so
   * this is the same operation as an app-restart resume - dispose, re-open
   * the same file over the other account's runtime. Never mid-turn.
   */
  async rebind(accountId: string, note?: string): Promise<ModelSession | undefined> {
    if (this.running || this.session?.isStreaming()) return undefined;
    this.options.settings.setFirstmateAccount(accountId);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    const session = await this.ensureSession();
    if (session && note) {
      this.options.broadcastEvent({ type: "firstmate_note", text: note });
    }
    return session;
  }

  /** The account the current attachment is bound to (settings surface). */
  boundAccount(): string | undefined {
    return this.boundAccountId;
  }

  /** A quota refresh may un-pause the orchestrator: read the way back, then drain. */
  onQuotaRefreshed(): void {
    this.checkSeat();
    void this.drainInbox();
  }

  /**
   * A cut-off was recorded or cleared on an account (`AccountVault
   * .onCutOffChange`): the seat reads its way back now, as the crew lanes
   * do, rather than at the next tick - a changed login or client, or a
   * refusal a crewmate met on the seat's own account.
   */
  onCutOffChanged(): void {
    this.checkSeat();
    void this.drainInbox();
  }

  /**
   * Apply an explicit flagship pin change now if the session is idle; a
   * busy session picks it up at the next idle boundary (the pre-turn
   * admission check), never mid-turn.
   */
  async applyAccountSetting(): Promise<void> {
    const flagship = this.options.flagship;
    if (!flagship || !this.session) return;
    if (this.localSeat) return;
    if (this.running || this.session.isStreaming()) return;
    const persisted = this.options.settings.getFirstmateAccount();
    if (!persisted || persisted === this.boundAccountId) return;
    if (!flagship.isEligible(persisted)) return;
    // The same ledger row admission writes when the change waits for idle.
    flagship.record("pinned", persisted, [
      `the setting names ${flagship.labelOf(persisted) ?? persisted}`,
    ]);
    await this.rebind(persisted);
  }

  /**
   * Persist a model together with an account from that provider, then move
   * the rolling session at the next safe attachment boundary.
   */
  async applyModelSetting(model: { provider: string; id: string } | null): Promise<void> {
    const flagship = this.options.flagship;
    const accountId = model ? flagship?.deriveForProvider(model.provider) : undefined;
    const seat = this.boundSeat;
    // A pick that takes the seat to another account or backend is a move:
    // the ledger says why, and the attachment that carries it out tells its
    // first turn (`announceMove`), as the move card's does.
    if (
      model &&
      seat &&
      !this.localSeat &&
      (accountId !== this.boundAccountId ||
        backendForProvider(model.provider) !== backendForProvider(seat.provider))
    ) {
      flagship?.record("pinned", accountId ?? null, [
        `the captain picked ${this.providerNameOf(model.provider)} (${model.id}) in Settings`,
      ]);
      this.pendingMove = {
        from: { provider: this.providerNameOf(seat.provider), model: seat.model },
        fromIdentity: seat.identity,
      };
    }
    this.options.settings.setFirstmateBinding(model, accountId ?? null);
    // The captain chose the seat outright: a pending way back is moot.
    if (this.options.settings.getFirstmateMovedFrom()) {
      this.options.settings.setFirstmateMovedFrom(null);
      this.options.supervisor.withdrawHostCard(FIRSTMATE_MOVE_BACK_CARD_ID, "model chosen");
    }
    if (!this.session || this.localSeat) return;
    if (this.running || this.session.isStreaming()) {
      this.modelChanged = true;
      return;
    }
    this.detachSession();
    await this.ensureSession();
    void this.drainInbox();
  }

  /**
   * The pre-turn admission check and exhaustion ladder. Returns the session
   * to run on (possibly rebound to a sibling), or undefined when the
   * orchestrator is benched - rung 2 and 3 raise their cards and the turn
   * waits in the durable inbox.
   */
  private async admitTurn(initial: ModelSession): Promise<ModelSession | undefined> {
    if (this.runawayRefused) return undefined;
    let session = initial;
    // The dev-only local seat (roadmap 1.7) changed while a turn ran: this
    // idle boundary is where the rolling session moves onto it, or off it.
    while (this.seatChanged) {
      this.seatChanged = false;
      this.detachSession();
      const reopened = await this.ensureSession();
      if (!reopened) return undefined;
      session = reopened;
    }
    // The seat has no account to ladder: it stays.
    if (this.localSeat) return session;
    // A picker change made during the preceding turn becomes one coherent
    // model/account attachment now, before allowance admission reads it.
    if (this.modelChanged) {
      this.modelChanged = false;
      this.detachSession();
      const reopened = await this.ensureSession();
      if (!reopened) return undefined;
      session = reopened;
    }
    const flagship = this.options.flagship;
    if (!flagship) return session;
    // A sign-in or sign-out is rewriting the bound account's store: the
    // seat waits it out, its turns kept on the inbox.
    if (this.boundAccountId && this.storeHolds.has(this.boundAccountId)) return undefined;
    // An explicit pin change in Settings applies at this idle boundary.
    const persisted = this.options.settings.getFirstmateAccount();
    if (persisted && persisted !== this.boundAccountId && flagship.isEligible(persisted)) {
      flagship.record("pinned", persisted, [
        `the setting names ${flagship.labelOf(persisted) ?? persisted}`,
      ]);
      return this.rebind(persisted);
    }
    const accountId = this.boundAccountId;
    if (!accountId) return session;
    const pause = flagship.pause(accountId);
    if (!pause) {
      this.servesAgain();
      return session;
    }
    return this.climbLadder(accountId, pause);
  }

  /**
   * The ladder for a seat whose account cannot serve (docs/architecture.md
   * §16 "A paused seat"), the same for every class and every backend (the
   * owner's Q5 a). Rung 1: a sibling of the same provider - same model,
   * the system working - is a feed line, not a card. Otherwise the seat
   * pauses: rung 2 asks by card to move to another provider with headroom,
   * rung 3 says it waits. Nothing moves or retries until the captain
   * clicks, and the durable inbox keeps every word meanwhile.
   */
  private async climbLadder(
    accountId: string,
    pause: SeatPause,
  ): Promise<ModelSession | undefined> {
    const flagship = this.options.flagship;
    if (!flagship) return undefined;
    const label = flagship.labelOf(accountId);
    // A removed account has no siblings of its own: the model's provider does.
    const provider = this.options.settings.getFirstmateModel()?.provider;
    const derived = !label && provider ? flagship.deriveForProvider(provider) : undefined;
    const sibling =
      flagship.sibling(accountId) ??
      (derived ? { id: derived, label: flagship.labelOf(derived) ?? derived } : undefined);
    if (sibling) {
      flagship.record("rebound", sibling.id, [
        `${label ?? accountId}: ${pause.class}`,
        `picked ${sibling.label}: an account of the same provider that can serve`,
      ]);
      const why =
        label && pause.class !== "unavailable"
          ? flagship.pauseSentence(accountId, pause)
          : "its previous account is no longer available.";
      return this.rebind(sibling.id, `Your first mate moved to ${sibling.label} - ${why}`);
    }
    this.pauseSeat(accountId, pause);
    return undefined;
  }

  /**
   * The seat pauses on this account: the pause card for its class and rung,
   * and - once per pause - its feed line and ledger row. The seat lets go
   * of a client that holds the account's sign-in, so its health can be read
   * while nothing runs; the next admitted turn attaches again.
   */
  private pauseSeat(accountId: string, pause: SeatPause): void {
    const flagship = this.options.flagship;
    if (!flagship) return;
    const providerId =
      flagship.providerOf(accountId) ?? this.options.settings.getFirstmateModel()?.provider;
    const providerName = providerId ? flagship.providerNameOf(providerId) : "its provider";
    const other = providerId ? flagship.otherProviderOption(providerId) : undefined;
    const previous = this.paused;
    const fresh =
      previous?.accountId !== accountId ||
      previous.class !== pause.class ||
      previous.move !== other?.providerId;
    if (fresh) {
      this.paused = {
        accountId,
        class: pause.class,
        ...(other ? { move: other.providerId } : {}),
      };
    }
    void this.session?.detach();
    // The pause card speaks for a lost sign-in: the generic sign-in card a
    // failed turn raised before the proof came is not a second card for it.
    this.options.supervisor.clearAuthDecisionCard(AUTH_CARD_ID);
    const card = this.pauseCard(accountId, pause);
    if (!fresh) {
      // The same pause: its card stands, revised in place if its words
      // moved; one the captain dismissed stays down.
      this.options.supervisor.addFirstmatePauseCard(card, { reviseOnly: true });
      return;
    }
    // A changed pause is a new question: the old card's is gone.
    if (previous) this.options.supervisor.withdrawFirstmatePauseCards("superseded");
    const sentence = flagship.pauseSentence(accountId, pause);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: seatPausedLine(pause.class, sentence, providerId ? providerName : "Its provider"),
    });
    flagship.record(other ? "move-offered" : "paused", accountId, [
      `${flagship.labelOf(accountId) ?? accountId}: ${pause.class}`,
      ...(other ? [`offered ${other.providerName}: it has headroom`] : ["nothing else can serve"]),
    ]);
    this.options.supervisor.addFirstmatePauseCard(card);
  }

  /** The pause card for the seat's account and its pause, as it stands now. */
  private pauseCard(accountId: string, pause: SeatPause): FirstmatePauseCard {
    const flagship = this.options.flagship;
    const providerId =
      flagship?.providerOf(accountId) ?? this.options.settings.getFirstmateModel()?.provider;
    const providerName =
      providerId && flagship ? flagship.providerNameOf(providerId) : "its provider";
    const other = providerId ? flagship?.otherProviderOption(providerId) : undefined;
    return {
      pause: pause.class,
      body: this.pauseCardBody(accountId, pause, providerName, other?.providerName),
      ...(flagship?.labelOf(accountId) ? { accountId } : {}),
      providerName,
      ...(other ? { move: other } : {}),
      ...(this.rechecking ? { checking: true } : {}),
    };
  }

  /** What a pause card says: what stopped the seat, what is kept, and what it asks. */
  private pauseCardBody(
    accountId: string,
    pause: SeatPause,
    providerName: string,
    moveTo: string | undefined,
  ): string {
    const flagship = this.options.flagship;
    if (!flagship) return "";
    const providerId = flagship.providerOf(accountId);
    if (pause.class === "no_headroom") {
      const summary = providerId ? flagship.exhaustionSummary(providerId) : undefined;
      // One account (Claude has one login ever) is named, never counted.
      const spent =
        providerId && flagship.accountCount(providerId) > 1
          ? `Your first mate's ${providerName} accounts have used up their allowance (${summary}).`
          : flagship.pauseSentence(accountId, pause);
      const checked = this.allowanceCheckWords(accountId);
      return moveTo
        ? `${spent} Your messages are kept.${checked} Move your first mate to ${moveTo} until then?`
        : `No connected account has allowance left for your first mate right now${
            summary ? ` (${summary})` : ""
          }. Your messages are kept. It will resume when one resets.${checked}`;
    }
    if (pause.class === "unavailable" && !moveTo) {
      return "Your first mate's account was disconnected and no other account can serve it. Connect an account to continue.";
    }
    const said =
      pause.class === "refused"
        ? `${providerName} is not answering your first mate right now, and your messages are kept. If something on your ${providerName} account needed fixing, such as billing, fix it there first.`
        : `${flagship.pauseSentence(accountId, pause)} Your messages are kept.`;
    if (moveTo) return `${said} Move your first mate to ${moveTo} in the meantime?`;
    if (pause.class === "refused") return `${said} Then choose Try ${providerName} again.`;
    if (pause.class === "signed_out")
      return `${said} Your first mate picks them up once you sign in.`;
    return `${said} Your first mate picks them up once it can run.`;
  }

  /**
   * When the spent allowance was last read and who is signed in, with a
   * leading space, for the pause card: a person who switched accounts
   * elsewhere sees whether the reading is the new one. A reading that could
   * not be taken says so, never that the allowance is still spent.
   */
  private allowanceCheckWords(accountId: string): string {
    const flagship = this.options.flagship;
    if (!flagship) return "";
    if (this.rechecking) return ` ${ALLOWANCE_CHECKING_WORDS}`;
    const check = flagship.allowanceCheck(accountId);
    if (!check) return "";
    return ` ${allowanceCheckedWords(
      check.read
        ? {
            read: true,
            time: clockTime(check.at),
            ...(check.identity ? { identity: check.identity } : {}),
          }
        : { read: false, ...(check.at !== undefined ? { time: clockTime(check.at) } : {}) },
    )}`;
  }

  /**
   * The paused seat's account serves again (the way back, W1 S9): a feed
   * line, the ledger row, and the pause cards go - nothing moved, so there
   * is nothing to ask. A pause on an account the seat is no longer bound
   * to simply ends: its question is gone.
   */
  private servesAgain(): void {
    // Whatever pause card is up - one a previous run left, too - asks a
    // question that is gone. Taking one down is idempotent.
    this.options.supervisor.withdrawFirstmatePauseCards("serves again");
    const paused = this.paused;
    if (!paused) return;
    this.paused = undefined;
    const flagship = this.options.flagship;
    if (!flagship || paused.accountId !== this.seatAccount()) return;
    this.options.supervisor.clearAuthDecisionCard(AUTH_CARD_ID);
    // What waited out the pause is due now, whatever its backoff said.
    this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
    const label = flagship.labelOf(paused.accountId) ?? "its account";
    flagship.record("serves-again", paused.accountId, [`${label}: no longer ${paused.class}`]);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Your first mate is answering again on ${label}.`,
    });
  }

  /**
   * The seat's way back, read on the shared tick and a quota refresh (W1
   * S9): a paused seat whose account serves again resumes - its feed line,
   * then the next drain - and a seat the captain moved off an account that
   * serves again is offered the move back, once, by card. Nothing moves on
   * its own.
   */
  private checkSeat(): void {
    const flagship = this.options.flagship;
    if (!flagship || this.localSeat) return;
    const paused = this.paused;
    if (paused && (paused.accountId !== this.seatAccount() || !flagship.pause(paused.accountId))) {
      this.servesAgain();
    }
    const movedFrom = this.options.settings.getFirstmateMovedFrom();
    if (!movedFrom) return;
    if (!flagship.labelOf(movedFrom.accountId)) {
      // The account it left is gone: there is nowhere to move back to.
      this.options.settings.setFirstmateMovedFrom(null);
      this.options.supervisor.withdrawHostCard(FIRSTMATE_MOVE_BACK_CARD_ID, "account removed");
      return;
    }
    const back = !flagship.pause(movedFrom.accountId);
    if (back && !movedFrom.offered) {
      const label = flagship.labelOf(movedFrom.accountId) ?? movedFrom.accountId;
      const providerName = flagship.providerNameOf(movedFrom.providerId);
      const current = this.boundSeat ? this.providerNameOf(this.boundSeat.provider) : undefined;
      this.options.settings.setFirstmateMovedFrom({ ...movedFrom, offered: true });
      flagship.record("move-back-offered", movedFrom.accountId, [
        `${label}: no longer ${movedFrom.class}`,
      ]);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `${label} can serve your first mate again.`,
      });
      this.options.supervisor.addFirstmateMoveBackCard({
        providerId: movedFrom.providerId,
        providerName,
        body: `${label} can serve your first mate again.${
          current ? ` Your first mate stays on ${current} until you choose.` : ""
        }`,
      });
    } else if (!back && movedFrom.offered) {
      // It stopped serving again before the captain chose: the offer is stale.
      this.options.settings.setFirstmateMovedFrom({ ...movedFrom, offered: false });
      this.options.supervisor.withdrawHostCard(FIRSTMATE_MOVE_BACK_CARD_ID, "stopped serving");
    }
  }

  /** The account the seat is on: the attachment's, else - before one - the setting's. */
  private seatAccount(): string | undefined {
    return this.boundAccountId ?? this.options.settings.getFirstmateAccount() ?? undefined;
  }

  /**
   * The refused card's "Try again" (W1 S9): the captain's word clears the
   * refusal (S7's clearing), the pause cards go, and the lane drains once -
   * the waiting rows are due now, so that drain is the attempt. A turn that
   * is refused again pauses again; nothing tries on its own.
   */
  private tryAgain(accountId: string): void {
    const flagship = this.options.flagship;
    if (!flagship) return;
    // On a spent allowance, trying again is reading it again.
    if (flagship.pause(accountId)?.class === "no_headroom") {
      void this.recheckAllowance({ fromCard: true });
      return;
    }
    flagship.tryAgain(accountId);
    if (this.paused?.accountId === accountId) this.paused = undefined;
    this.options.supervisor.withdrawFirstmatePauseCards("trying again");
    this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
    void this.drainInbox();
  }

  /**
   * The captain's Recheck allowance (the spent-allowance card, Settings'
   * Refresh, command search): one at a time, and a second ask shares the
   * one running. While it runs the card says so and offers no second
   * recheck; then the seat reads its way back - serving again closes the
   * card and the kept messages go, once, through the inbox - and a seat
   * still paused gets its card back with what the reading said.
   */
  recheckAllowance(options: { fromCard?: boolean } = {}): Promise<QuotaSnapshotView | undefined> {
    // The card's own click closed it: the card comes back, saying it checks.
    // A recheck from elsewhere revises a card that is up and raises none.
    if (options.fromCard) this.recheckRaises = true;
    this.recheck ??= this.runRecheck().finally(() => {
      this.recheck = undefined;
    });
    if (options.fromCard) this.showSpentAllowanceCard();
    return this.recheck;
  }

  private recheck: Promise<QuotaSnapshotView | undefined> | undefined;

  /** A recheck is running: the pause card says so. */
  private rechecking = false;

  /** The running recheck came from the card, so its card comes back. */
  private recheckRaises = false;

  private async runRecheck(): Promise<QuotaSnapshotView | undefined> {
    this.rechecking = true;
    this.showSpentAllowanceCard();
    try {
      return await this.options.recheckAllowance?.();
    } finally {
      this.rechecking = false;
      this.checkSeat();
      this.showSpentAllowanceCard();
      this.recheckRaises = false;
      void this.drainInbox();
    }
  }

  /** The seat is paused on a spent allowance: its card, as it stands now, is up. */
  private showSpentAllowanceCard(): void {
    const flagship = this.options.flagship;
    const paused = this.paused;
    if (!flagship || paused?.class !== "no_headroom") return;
    const pause = flagship.pause(paused.accountId);
    if (pause?.class !== "no_headroom") return;
    this.options.supervisor.addFirstmatePauseCard(this.pauseCard(paused.accountId, pause), {
      reviseOnly: !this.recheckRaises,
    });
  }

  /**
   * A sign-in or sign-out is about to rewrite an account's store (W1 S9):
   * the seat stays off that account until the returned release, and a
   * client holding its store lets go first - at an idle boundary, never
   * mid-turn, so this waits out a running turn. The release drains.
   */
  async holdSeatFor(accountId: string): Promise<() => void> {
    this.storeHolds.set(accountId, (this.storeHolds.get(accountId) ?? 0) + 1);
    if (this.boundAccountId === accountId) await this.session?.detach();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.storeHolds.get(accountId) ?? 1) - 1;
      if (left > 0) this.storeHolds.set(accountId, left);
      else this.storeHolds.delete(accountId);
      void this.drainInbox();
    };
  }

  /**
   * The move, on the captain's click (rung 2, or the way back): pick the
   * target provider's best model and account, persist both, and rebind at
   * an idle boundary - any provider, either backend. A move off a paused
   * account remembers where the seat was, so the way back can ask; a move
   * back forgets it. The attachment that carries it out tells its first
   * turn (`announceMove`).
   */
  private async moveFlagship(providerId: string): Promise<void> {
    const model = this.deriveModelForProvider(providerId);
    if (!model) {
      this.raiseTurnFailureCard(`No signed-in model is available on that subscription.`);
      return;
    }
    const flagship = this.options.flagship;
    const accountId = flagship?.deriveForProvider(providerId);
    const fromAccount = this.boundAccountId;
    const fromProvider =
      (fromAccount ? flagship?.providerOf(fromAccount) : undefined) ?? this.boundSeat?.provider;
    const pause = fromAccount ? flagship?.pause(fromAccount) : undefined;
    const movedFrom = this.options.settings.getFirstmateMovedFrom();
    if (movedFrom?.providerId === providerId) {
      this.options.settings.setFirstmateMovedFrom(null);
    } else if (fromAccount && fromProvider && fromProvider !== providerId && pause) {
      this.options.settings.setFirstmateMovedFrom({
        providerId: fromProvider,
        accountId: fromAccount,
        class: pause.class,
      });
    }
    flagship?.record("moved", accountId ?? null, [
      `from ${fromProvider ?? "no provider"}${pause ? `: ${pause.class}` : ""}`,
      "the captain chose it on the card",
    ]);
    if (this.boundSeat) {
      this.pendingMove = {
        from: {
          provider: this.providerNameOf(this.boundSeat.provider),
          model: this.boundSeat.model,
        },
        fromIdentity: this.boundSeat.identity,
        ...(pause ? { reason: pause.class } : {}),
      };
    }
    this.paused = undefined;
    this.options.supervisor.withdrawFirstmatePauseCards("moved");
    this.options.supervisor.withdrawHostCard(FIRSTMATE_MOVE_BACK_CARD_ID, "moved");
    this.options.settings.setFirstmateBinding(model, accountId ?? null);
    // Rows held for the account the seat leaves (a spent allowance's reset)
    // are due on the seat it goes to.
    this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
    if (this.running || this.session?.isStreaming()) return; // applies at the next idle boundary
    this.detachSession();
    const session = await this.ensureSession();
    if (session) void this.drainInbox();
  }

  /** The provider-scoped cousin of resolveModel, for a move: any provider, either backend. */
  private deriveModelForProvider(providerId: string): { provider: string; id: string } | undefined {
    const available = this.options
      .availableModels()
      .filter((model) => model.provider === providerId);
    if (available.length === 0) return undefined;
    return this.deriveFrom(available);
  }

  /** `available` narrowed to the listed pool, keeping its order. */
  private listed<T extends { provider: string; id: string }>(available: readonly T[]): T[] {
    if (!this.options.listedModels) return [...available];
    const listed = new Set(
      this.options.listedModels().map((model) => `${model.provider}/${model.id}`),
    );
    return available.filter((model) => listed.has(`${model.provider}/${model.id}`));
  }

  private slotsOf(model: { provider: string; id: string }): Slot[] {
    return this.options.slotsOf?.(model) ?? ["medium"];
  }

  /** A premium membership, used to check whether a premium crew option can serve. */
  private isPremium(model: { provider: string; id: string }): boolean {
    return this.slotsOf(model).includes(PREMIUM_SLOT);
  }

  private premiumCanServe(): boolean {
    const catalog = this.options.quotaModels()?.models;
    return this.options.availableModels().some((model) => {
      if (!this.isPremium(model)) return false;
      const reading = catalog?.find((entry) => servedModelKey(entry) === servedModelKey(model));
      // No quota reading is unknown, never zero; a measured exhausted
      // premium offering is not a way this captain can take right now.
      return (
        reading?.effectivePercentRemaining === undefined || reading.effectivePercentRemaining > 0
      );
    });
  }

  /** Local preflight's chosen model, or its normal initial Auto choice; never opens a session. */
  preflightModel(): { provider: string; id: string } | undefined {
    return (
      this.localSeat?.model ?? this.options.settings.getFirstmateModel() ?? this.resolveModel()
    );
  }

  /**
   * The fixed orchestrator model (captain decision Q2): the persisted
   * choice, or a subscription-derived default picked once and persisted so
   * behavior never silently changes - high, medium, premium, then low in
   * catalog allowance order, else the first listed one. Only
   * a model that can answer the Firstmate is derived: its provider's role,
   * and an account the seat can stand on (`Flagship.servesFirstmate`), so a
   * pick never persists a model no seat would open.
   */
  private resolveModel(): { provider: string; id: string } | undefined {
    if (this.localSeat) return this.localSeat.model;
    const chosen = this.options.settings.getFirstmateModel();
    // Leftover Anthropic sessions stay on disk; they are not offered until
    // API-key support lands, so pick a new default rather than crashing.
    // A pin onto a provider this build no longer offers (Cursor) is
    // the same as a leftover Anthropic pin: derive a default instead of
    // opening a session that cannot run.
    if (chosen && chosen.provider !== "anthropic" && !isRetiredProvider(chosen.provider)) {
      return chosen;
    }
    const serves = new Map<string, boolean>();
    const servesFirstmate = (providerId: string): boolean => {
      let known = serves.get(providerId);
      if (known === undefined) {
        known =
          this.options.flagship?.servesFirstmate(providerId) ??
          providerServesRole(providerId, "firstmate");
        serves.set(providerId, known);
      }
      return known;
    };
    const available = this.options
      .availableModels()
      .filter(
        (model) =>
          model.provider !== "anthropic" &&
          !isRetiredProvider(model.provider) &&
          servesFirstmate(model.provider),
      );
    if (available.length === 0) return undefined;
    // A fresh Auto pick considers every serving backend in the same pool.
    // A later cross-provider move still asks the captain.
    const derived = this.deriveFrom(available);
    if (derived) this.options.settings.setFirstmateModel(derived);
    return derived;
  }

  /**
   * The Firstmate's automatic pick: high, medium, premium, low; catalog
   * allowance order within each slot, across serving backends alike.
   */
  private deriveFrom(
    available: readonly { provider: string; id: string }[],
  ): { provider: string; id: string } | undefined {
    if (available.length === 0) return undefined;
    const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
    const catalog = this.options.quotaModels()?.models ?? [];
    const listed = this.listed(available).filter((model) => {
      const reading = catalog.find((entry) => servedModelKey(entry) === servedModelKey(model));
      return reading?.effectivePercentRemaining !== 0;
    });
    for (const bucket of ["high", "medium", "premium", "low"] as const) {
      for (const model of catalog) {
        const provider = servedProviderOf(model.provider);
        if (!availableKeys.has(servedModelKey(model))) continue;
        if (model.effectivePercentRemaining === 0) continue;
        if (this.slotsOf({ provider, id: model.id }).includes(bucket)) {
          return { provider, id: model.id };
        }
      }
      const model = listed.find((entry) => this.slotsOf(entry).includes(bucket));
      if (model) return model;
    }
    return listed[0];
  }

  // Inferred, never annotated `BoundTool[]`: the e2e stand-ins type their
  // scripted calls from this list (`tests/helpers/scriptedCalls.ts`).
  private buildTools() {
    const supervisor = this.options.supervisor;
    // Knowledge (docs/knowledge.md) runs in every build.
    // A write that changed the collection is the turn's action; a read,
    // a refusal or a repeated request is not.
    const knowledge = this.options.knowledge && {
      knowledge: knowledgeBinding(
        this.options.knowledge,
        () => ({ kind: "firstmate", origin: this.turnOrigin, canCreate: this.turnCanCreate }),
        (outcome, input) => {
          this.noteDelivery({
            outcome: "action",
            kind: "record",
            tool: "record_knowledge",
            ...(outcome.ids[0] ? { ref: outcome.ids[0] } : {}),
          });
          if (input.action === "publish" || input.action === "revise") this.replyEmote("tuck");
        },
      ),
    };
    const delegate: CrewDelegate = {
      escalationEligible: (taskId) => supervisor.escalationEligible(taskId),
      premiumCanServe: () => this.premiumCanServe(),
      commission: async (input) => {
        // The message's pictures ride the brief, which goes out before the
        // message attaches to the new task below.
        const attachments = this.asks.currentPictures();
        const handle = await supervisor.commission({
          ...input,
          messageFiles: this.asks.current()?.messageFiles ?? [],
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        // Attach first (P1): the ask that caused the spawn is about the new task.
        this.asks.attach(handle.taskId, "spawn_crewmate");
        const started = this.options.tasks.get(handle.taskId)?.title;
        if (started) this.replyFacts.app = startedReply(started);
        this.noteDelivery({
          outcome: "action",
          kind: "work",
          tool: "spawn_crewmate",
          ref: handle.taskId,
        });
        return handle;
      },
      // The ask is about the task the captain named, whatever the tool then
      // says about it - a refused settle is still about that task.
      steerCrewmate: async (taskId, message) => {
        this.asks.attach(taskId, "steer_crewmate");
        const delivery = await supervisor.steerCrewmate(taskId, message, "firstmate", {
          via: "tool",
          decision: this.decisions.current() ?? null,
          // In a turn that carries the captain's own words, the steer is his
          // guidance: it holds a kept merge until its crewmate declares it (FI3-662).
          captainWords: this.turnOrigin === "captain-turn",
          ...this.steeredPictures(),
        });
        this.deliveredThisTurn = true;
        // A steer the app saved because the crewmate's account is held counts
        // too (the captain's call; paused accounts are FI3-592's).
        this.noteDelivery({ outcome: "action", kind: "work", tool: "steer_crewmate", ref: taskId });
        // Every delivery outcome means the guidance is on its way (a refused
        // steer throws before this): the captain gets a "got it".
        this.replyEmote("nod");
        return delivery;
      },
      handFiles: (fromTask, toTask) => supervisor.handFiles(fromTask, toTask),
      interruptCrewmate: async (taskId, mode, closingSentence) => {
        this.asks.attach(taskId, "interrupt_crewmate");
        await supervisor.interruptCrewmate(
          taskId,
          mode,
          {
            actor: "firstmate",
            via: "tool",
            decision: this.decisions.current() ?? null,
          },
          closingSentence,
        );
        this.deliveredThisTurn = true;
        this.noteDelivery({
          outcome: "action",
          kind: "work",
          tool: "interrupt_crewmate",
          ref: taskId,
        });
      },
      crewStatus: (taskId) => supervisor.crewStatus(taskId),
      // The escalation gate (S4): the same wake stamp memory and the miss
      // label read, so `escalate_from` is reachable only from a turn that
      // carries the captain's own words.
      isCaptainTurn: () => this.turnOrigin === "captain-turn",
      settleTask: async (taskId, mode, confirm, proceedWithOpen, evidence, closingSentence) => {
        this.asks.attach(taskId, "settle_task");
        const settle = async (): Promise<{ text: string; refusal?: SettleRefusal }> =>
          mode === "answered"
            ? { text: (await supervisor.closeAnswerUsedAsBasis(taskId)).text }
            : mode === "released"
              ? await supervisor.closeExternallyReleased(taskId, evidence ?? "")
              : mode === "finished"
                ? await supervisor.closeFinishedFolderWork(taskId, evidence ?? "")
                : await supervisor.settleTaskDetailed(taskId, mode, confirm, proceedWithOpen);
        // The close carries the first mate's sentence (INF-547), keyed by
        // the record whichever reference named it.
        const result = closingSentence
          ? await supervisor.withClosingSentence(
              this.options.tasks.resolve(taskId)?.id ?? taskId,
              closingSentence,
              settle,
            )
          : await settle();
        const status = this.options.tasks.get(taskId)?.status;
        if (!result.refusal && (status === "done" || status === "dropped")) {
          this.deliveredThisTurn = true;
          this.noteDelivery({ outcome: "action", kind: "work", tool: "settle_task", ref: taskId });
        }
        return result;
      },
    };
    const scheduler = this.options.scheduler;
    const flagMissedEscalation = this.options.flagMissedEscalation;
    const flagDuplicate = this.options.flagDuplicate;
    const personalize = this.options.personalize;
    const installPlugin = this.options.installPlugin;

    const forges = this.options.forges;
    const locate =
      this.options.locateProject ??
      (async (name: string) => {
        const found = locateProject(name, {
          managed: this.options.repos
            .list()
            .map((repo) => ({ id: repo.id, name: repo.name, path: repo.path })),
        });
        const local = renderLocated(name, found);
        const remote = forges ? await forges.remoteProjects(name, found.length > 0) : "";
        return remote ? `${local}\n\n${remote}` : local;
      });
    // The typed reason the last refused card gives, read off the lint: a card
    // refused for a crewmate's own card on the task names that card.
    let cardOwner: { id: string } | undefined;
    const emitCard = createEmitCardTool(
      (card) => {
        const cardId = supervisor.addFirstmateCard(card);
        this.decisions.noteCard(cardId);
        // Attach first (P1): the card lands on its task, or files one.
        this.recordCardFiling(card, cardId);
        supervisor.declareStandaloneRequiredActions(card, cardId);
        this.noteDelivery({ outcome: "action", kind: "card", tool: "emit_card", ref: cardId });
        return cardId;
      },
      (card) => {
        let crewCard: { id: string; title: string } | undefined;
        const refusal = lintFirstmateCard(card, {
          resolveCardId: resolveFirstmateCardId,
          taskExists: (taskId) => Boolean(this.options.tasks.get(taskId)),
          taskClosed: (taskId) => {
            const record = this.options.tasks.get(taskId);
            return Boolean(record && TaskService.isClosed(record));
          },
          // Steer, not answer (WI-12): the stack decides, not a turn flag.
          openCrewmateCard: (taskId) => {
            // A task closed done keeps its crewmate's notes, but the crewmate
            // is gone: there is nobody to steer, so its note is no refusal.
            const record = this.options.tasks.get(taskId);
            if (record && TaskService.isClosed(record)) return undefined;
            const crew = supervisor
              .openCardDigests(taskId)
              .filter((open) => open.emitter === "crewmate")
              .at(-1);
            crewCard = crew ? { id: crew.id, title: crew.title } : undefined;
            return crewCard;
          },
          isOpenFirstmateCard: (cardId, taskId) =>
            supervisor
              .openCardDigests(taskId)
              .some((open) => open.id === cardId && open.emitter === "firstmate"),
          // The merge decision is the crewmate's (contract v3.6, captain
          // lock 3): a settle merge card is refused while its task's own
          // crewmate has yet to emit the completion card.
          crewmateOwesCompletion: (taskId) => supervisor.crewmateOwesCompletion(taskId),
        });
        cardOwner =
          refusal !== undefined &&
          card.taskId &&
          crewCard &&
          refusal === steerNotAnswerRefusal(card.taskId, crewCard)
            ? { id: crewCard.id }
            : undefined;
        return refusal;
      },
      { role: "firstmate" },
    );
    const emitCardTool = {
      ...emitCard,
      run: async (params: Parameters<typeof emitCard.run>[0]) => {
        cardOwner = undefined;
        try {
          return await emitCard.run(params);
        } catch (caught) {
          // A refused card is saved with its typed reason: it voids a
          // reaction after it, and the retry and the notice can name it.
          const reason: DeliveryRefusal = cardOwner ? "crewmate-owns" : "card-refused";
          this.noteDelivery({
            outcome: "refused",
            tool: "emit_card",
            reason,
            ...(cardOwner ? { ref: (cardOwner as { id: string }).id } : {}),
          });
          throw caught;
        }
      },
    };
    const tools = [
      // The emit_card boundary runs the card lint: attach-first, the
      // carded-task refusal (WI-12), the settle-needs-a-task check, and the
      // shape rules (WI-11). A refused card returns corrective text and is
      // never shown. The description is the card contract plus the
      // Firstmate's addendum, and only this role's schema carries task_id
      // and standalone (contract v2.0).
      emitCardTool,
      createCloseCardTool((input) => {
        const result = supervisor.closeCard(input.cardId, { kind: "firstmate" }, input.reason);
        this.deliveredThisTurn = true;
        this.noteDelivery({
          outcome: "action",
          kind: "close",
          tool: "close_card",
          ref: input.cardId,
        });
        return result;
      }),
      createEmoteTool((emote) => {
        this.deliveredThisTurn = true;
        this.noteDelivery({ outcome: "action", kind: "reaction", tool: "emote" });
        this.options.broadcastEvent({ type: "firstmate_emote", emote });
      }),
      ...createCrewTools(delegate),
      // The graph (task-system P2): file on request by default or start when ready,
      // edit or drop a record, link records, and query the record.
      ...createTaskTools(this.taskToolsDelegate()),
      // Project discovery stays a host-owned typed operation; CI state rides crew_status.
      createLocateProjectTool(locate),
      ...(scheduler
        ? this.filingOperations(
            createScheduleTools({
              create: (spec, prompt, extra) => {
                const project = extra.project
                  ? (this.options.tasks.projects.byKey(extra.project) ??
                    this.options.tasks.projects.get(extra.project))
                  : undefined;
                if (extra.project && (!project || project.archivedAt !== null)) {
                  throw new Error(`No project "${extra.project}"; use a key from the tasks index.`);
                }
                const record = scheduler.create(
                  spec,
                  prompt,
                  this.turnOrigin === "captain-turn",
                  extra.name,
                  project?.id,
                  { draft: extra.draft === true },
                );
                this.replyFacts.app =
                  record.state === "draft"
                    ? `Saved a draft: ${record.prompt}`
                    : `Scheduled: ${record.prompt}`;
                this.noteDelivery({
                  outcome: "action",
                  kind: "record",
                  tool: "schedule_prompt",
                  ref: record.id,
                });
                return record;
              },
              // Settings → Automation's Delete, through the same catalog
              // line (docs/automation.md, "One owner"): its trail is the
              // operation and the feed line, and records the delivery.
              cancel: async (id) => {
                const record = scheduler.rules().find((schedule) => schedule.id === id);
                if (!record) return false;
                if (!this.appDispatch) throw new Error("App actions are not connected.");
                await this.appDispatch("inf:automation:delete", [id], {
                  kind: "firstmate",
                  wake: this.appWake,
                  action: "automation-delete",
                  evidence: "cancel_schedule",
                });
                this.replyFacts.app = `Cancelled schedule: ${record.prompt}`;
                return true;
              },
            }),
            {
              schedule_prompt: (params) => ({
                title: `Scheduled: ${clipTitle(stringParam(params.prompt) ?? "a prompt")}`,
              }),
            },
          )
        : []),
      // Design B: the durable outcome store's query side - what the fleet
      // did while the captain was not looking, on demand, never as a turn.
      ...(this.options.supervisionLog
        ? [createSupervisionLogTool(this.options.supervisionLog)]
        : []),
      // PoC-2 C3: the one path from "you should have told me about that" to a
      // durable label. Captain-turn gated by the same wake stamp memory uses.
      ...(flagMissedEscalation
        ? this.filingOperations(
            [
              createFlagMissedEscalationTool({
                flag: (input) => {
                  // The ask is about the task whose outcome was the miss.
                  this.asks.attach(input.taskId, "flag_missed_escalation");
                  const result = flagMissedEscalation(input);
                  if (result.status === "flagged") {
                    this.noteDelivery({
                      outcome: "action",
                      kind: "record",
                      tool: "flag_missed_escalation",
                      ref: input.taskId,
                    });
                  }
                  return result;
                },
                isCaptainTurn: () => this.turnOrigin === "captain-turn",
              }),
            ],
            {
              flag_missed_escalation: (params) => {
                const taskId = stringParam(params.task_id);
                const about = taskId ? this.options.tasks.get(taskId) : undefined;
                return {
                  title: `Flagged a missed escalation on ${about?.key ?? taskId ?? "a task"}`,
                  ...(about ? { projectId: about.projectId } : {}),
                };
              },
            },
          )
        : []),
      // WI-14: the captain's "this card repeats that one" as a durable
      // label, gated by the same captain-turn stamp.
      ...(flagDuplicate
        ? this.filingOperations(
            [
              createFlagDuplicateTool({
                flag: (input) => {
                  const card = supervisor.cardsSnapshot().find((open) => open.id === input.cardId);
                  if (card?.taskId && this.options.tasks.get(card.taskId)) {
                    this.asks.attach(card.taskId, "flag_duplicate");
                  }
                  const result = flagDuplicate(input);
                  if (result.status === "flagged") {
                    this.noteDelivery({
                      outcome: "action",
                      kind: "record",
                      tool: "flag_duplicate",
                      ref: input.cardId,
                    });
                  }
                  return result;
                },
                isCaptainTurn: () => this.turnOrigin === "captain-turn",
              }),
            ],
            {
              flag_duplicate: (params) => ({
                title: `Flagged card ${stringParam(params.card_id) ?? ""} as a duplicate`,
              }),
            },
          )
        : []),
      // Knowledge is the single owner of directions and personal context.
      ...(knowledge
        ? this.filingOperations(
            [bindTool(KNOWLEDGE_TOOL, knowledge), bindTool(RECORD_KNOWLEDGE_TOOL, knowledge)],
            {
              record_knowledge: (params) => {
                const scope = stringParam(params.scope);
                const action = stringParam(params.action) ?? "record";
                const what = stringParam(params.title) ?? stringParam(params.id) ?? "knowledge";
                return {
                  title: `Knowledge ${action}: ${clipTitle(what)}`,
                  ...(scope && this.options.repos.get(scope) ? { repoId: scope } : {}),
                };
              },
            },
          )
        : []),
      // Two fixed tools whatever is connected (docs/integrations.md). A held
      // call's approval card is what the turn did, on the row the host filed
      // for it; a change or send that ran is an operation (INF-1108).
      ...(this.options.integrations
        ? createIntegrationTools(this.options.integrations, (fact) => {
            if ("ran" in fact) {
              this.noteDelivery({ outcome: "action", kind: "record", tool: "use_integration" });
              return;
            }
            const row = this.options.tasks.openCardTaskFor(fact.card);
            if (row) this.asks.attach(row.id, "use_integration");
            this.noteDelivery({
              outcome: "action",
              kind: "card",
              tool: "use_integration",
              ref: fact.card,
            });
          })
        : []),
      ...createAppTools({
        ...(this.options.platform ? { platform: this.options.platform } : {}),
        dispatch: (channel, args, actor) => {
          if (!this.appDispatch) throw new Error("App actions are not connected.");
          return this.appDispatch(channel, args, actor);
        },
        // The host builds the card from the line's offer, never the
        // Firstmate, so its button does what its words say (docs/devices.md,
        // "Asking the first mate").
        handover: (target, offer) => {
          // The app's own card for a computer behind is the one card.
          const standing = deviceUpdateCardOfOffer(offer.cardId);
          if (standing && supervisor.hasCard(standing))
            return "The update card for that computer is already on the stack.";
          const card: EmittedCard = {
            id: offer.cardId,
            title: offer.title,
            body: offer.paragraphs.map((text) => `<p>${escapeCardText(text)}</p>`).join("\n"),
            actions: [
              {
                id: "open",
                label: offer.label,
                default: true,
                ...(offer.danger ? { danger: true } : {}),
                effect: { kind: "open", target, ...offer.arrival },
              },
              { id: "not-now", label: offer.decline },
            ],
          };
          const id = supervisor.addFirstmateCard(card);
          this.decisions.noteCard(id);
          this.recordCardFiling(card, id);
          this.noteDelivery({ outcome: "action", kind: "card", tool: "app_change", ref: id });
          return `Settings button offered on ${id}.`;
        },
        // The setup card is the host's own, written from the checked
        // request: the turn's ask lands on its row, and the card is what
        // the turn did.
        ...(this.options.proposeProject
          ? {
              propose: async (_action, value) => {
                const proposed = await this.options.proposeProject?.(value);
                if (!proposed) return "";
                if (proposed.cardId) {
                  const row = this.options.tasks.openCardTaskFor(proposed.cardId);
                  if (row) this.asks.attach(row.id, "app_change");
                  this.noteDelivery({
                    outcome: "action",
                    kind: "card",
                    tool: "app_change",
                    ref: proposed.cardId,
                  });
                }
                return proposed.text;
              },
            }
          : {}),
        changeProject: async (action, value, actor) => {
          if (!this.options.changeProject) throw new Error("Project changes are not connected.");
          const result = await this.options.changeProject(action, value, actor);
          if (result.cardId) {
            const row = this.options.tasks.openCardTaskFor(result.cardId);
            if (row) this.asks.attach(row.id, "app_change");
            this.noteDelivery({
              outcome: "action",
              kind: "card",
              tool: "app_change",
              ref: result.cardId,
            });
          }
          return result.text;
        },
        actor: () => ({ kind: "firstmate", wake: this.appWake }),
      }),
      // Talk-to-personalize Step 1 (Tier A): one call applies a preference
      // about the app itself and the feed gets one line; no card. It files
      // an operation like every other operate tool.
      ...(personalize
        ? this.filingOperations(
            [
              createPersonalizeTool({
                ...personalize,
                isCaptainTurn: () => this.turnOrigin === "captain-turn",
                // Only an applied change is announced (refusals return
                // early), so its feed line is also the "all set".
                broadcastEvent: (event) => {
                  this.options.broadcastEvent(event);
                  if (event.type === "personalized") {
                    this.noteDelivery({ outcome: "action", kind: "record", tool: "personalize" });
                    this.replyEmote("tick");
                  }
                },
              }),
            ],
            {
              personalize: (params) => ({ title: personalizeTitle(params) }),
            },
          )
        : []),
      // One plugin vehicle, Phase A item 3 (captain's A2a): an operate move
      // that stages a panel from elsewhere and asks the captain on the
      // host's consent card; the tool itself adds nothing.
      ...(installPlugin
        ? this.filingOperations(
            [
              createInstallPluginTool({
                install: async (request) => {
                  const text = await installPlugin(request);
                  this.noteDelivery({
                    outcome: "action",
                    kind: "record",
                    tool: "install_plugin",
                  });
                  return text;
                },
                isCaptainTurn: () => this.turnOrigin === "captain-turn",
              }),
            ],
            {
              install_plugin: (params) => ({
                title: `Asked to add a panel from ${stringParam(params.spec) ?? "elsewhere"}`,
              }),
            },
          )
        : []),
    ];
    // The one retry only shows an answer: every work-changing tool answers
    // with a refusal as text, the way a graph refusal does.
    return tools.map((tool): typeof tool =>
      ANSWER_ONLY_REFUSED_TOOLS.has(tool.name)
        ? {
            ...tool,
            run: async (params: Parameters<typeof tool.run>[0]) =>
              this.delivery.outputOnly ? { text: ANSWER_ONLY_REFUSAL } : tool.run(params),
          }
        : tool,
    );
  }

  /**
   * The emit_card boundary's task side (attach first, D1). A card with
   * task_id lands on that task: a note is an `answered` event carrying the
   * body, a decision a `card_raised` event whose resolution act() records.
   * A decision without a task becomes its own decision task waiting on the
   * captain (its card id is the gate ref); a standalone note becomes its
   * own question task, born closed with the body as its outcome. Either way
   * the turn's ask attaches to the task the card is about.
   */
  private recordCardFiling(card: EmittedCard, cardId: string): void {
    const tasks = this.options.tasks;
    const decision = card.actions.length > 0;
    if (card.taskId) {
      if (decision) {
        tasks.recordCardRaised(card.taskId, { cardId, kind: "decision", title: card.title });
      } else {
        tasks.recordAnswer(card.taskId, { cardId, title: card.title, body: card.body });
      }
      this.asks.attach(card.taskId, "emit_card");
      return;
    }
    if (decision) {
      // A revision in place keeps its row; a fresh decision files one in the
      // hinted task's project, else Scratch.
      const existing = tasks.openDecisionFor(cardId);
      if (existing) {
        this.asks.attach(existing.id, "emit_card");
        return;
      }
      const hinted = this.asks.hintedTask();
      const row = tasks.fileDecision({
        id: randomUUID().slice(0, 8),
        title: clipTitle(card.title),
        cardId,
        repoId: hinted?.repoId ?? null,
        ...(hinted ? { projectId: hinted.projectId } : {}),
      });
      this.asks.attach(row.id, "emit_card");
      return;
    }
    // A standalone note: the model asserted the ask is about no other work.
    const revised = tasks.taskForCard(cardId);
    if (revised) {
      tasks.recordAnswer(revised.id, {
        cardId,
        title: card.title,
        body: card.body,
        asOutcome: true,
      });
      this.asks.attach(revised.id, "emit_card");
      return;
    }
    const row = tasks.fileQuestion({
      id: randomUUID().slice(0, 8),
      title: clipTitle(card.title),
      outcome: card.body,
      cardId,
    });
    this.asks.attach(row.id, "emit_card");
  }

  /**
   * The one host helper the operate tools report through (P1): after a
   * tool succeeds, file an `operation` task - done/settled, the tool's own
   * result as its outcome - in the repo's project or Scratch, and attach the
   * turn's ask to it. A thrown tool error files nothing; the turn-end
   * fallback still lands the ask.
   */
  private filingOperations<Tool extends BoundTool>(
    tools: Tool[],
    describe: Record<string, (params: Record<string, unknown>) => OperationDescription>,
  ): Tool[] {
    return tools.map((tool): Tool => {
      const describer = describe[tool.name];
      if (!describer) return tool;
      return {
        ...tool,
        run: async (params) => {
          const output = await tool.run(params);
          try {
            const described = describer((params ?? {}) as Record<string, unknown>);
            const row = this.options.tasks.fileOperation({
              id: randomUUID().slice(0, 8),
              title: clipTitle(described.title),
              outcome: output.text.trim(),
              tool: tool.name,
              repoId: described.repoId ?? null,
              ...(described.projectId ? { projectId: described.projectId } : {}),
            });
            this.asks.attach(row.id, tool.name);
          } catch (caught) {
            console.warn(`[firstmate] could not file the ${tool.name} operation:`, caught);
          }
          return output;
        },
      };
    });
  }

  /**
   * The graph tools' host side (P2). Each write attaches the turn's ask to
   * the task it acts on (attach first, D1); a graph refusal - a cycle, a
   * parent with open children, a move a workspace forbids - returns as the
   * tool's text so the agent reads it in conversation.
   */
  private taskToolsDelegate(): TaskToolsDelegate {
    const supervisor = this.options.supervisor;
    const tasks = this.options.tasks;
    const resolve = (ref: string): TaskRecord => {
      const record = tasks.resolve(ref);
      if (!record) {
        throw new Error(
          `Unknown task "${ref}". Use a task id or key from the tasks index, crew_status, or the tasks tool.`,
        );
      }
      return record;
    };
    const asText = (run: () => string): string => {
      try {
        return run();
      } catch (caught) {
        if (caught instanceof TaskGraphRefusal) return caught.message;
        throw caught;
      }
    };
    return {
      plan: (input) => {
        let record: TaskRecord;
        try {
          record = supervisor.plan(input);
        } catch (caught) {
          // A refused hand-off (INF-799) files nothing and reads as words.
          if (caught instanceof TaskGraphRefusal)
            return { taskId: "", key: "", text: caught.message };
          throw caught;
        }
        this.asks.attach(record.id, "create_task");
        this.replyFacts.app = `Filed ${record.key}: ${record.title}`;
        this.noteDelivery({
          outcome: "action",
          kind: "record",
          tool: "create_task",
          ref: record.id,
        });
        // A when-ready row nothing waits on is dispatched by this very sweep:
        // the answer says a crewmate starts, the fact the feed line states.
        const waiting =
          supervisor.crewStatus(record.id)[0]?.gate ??
          (record.startPolicy === "when-ready" ? "a crewmate starts on it now" : undefined);
        return {
          taskId: record.id,
          key: record.key,
          text: `Planned ${record.key} "${record.title}" (task_id ${record.id})${waiting ? ` - ${waiting}` : ""}.`,
        };
      },
      update: (input) => {
        try {
          const text = (() => {
            const record = resolve(input.task);
            // Resolve before any write. An unknown prerequisite is a tool error,
            // and two references to one task count once. INF-416 piece I: add
            // what is not linked yet; never compare the list or remove a link.
            const declared =
              input.declaredBlockers === undefined
                ? undefined
                : [...new Set(input.declaredBlockers.map((ref) => resolve(ref).id))];
            this.asks.attach(record.id, "update_task");
            const beforePolicies = input.policies
              ? effectiveTaskPolicies(
                  record,
                  record.repoId ? this.options.repos.get(record.repoId) : undefined,
                )
              : null;
            const runsOn =
              typeof input.runsOn === "string"
                ? supervisor.resolveRunsOn(input.runsOn)
                : input.runsOn;
            // A model named for started work moves it there between turns,
            // keeping its key, branch and working copy (INF-849).
            const moveTo =
              record.kind === "work" && record.status === "active"
                ? input.model?.trim()
                : undefined;
            // A typed hand-off is checked as a new task's is (INF-799); empty clears it.
            const handOff = (() => {
              if (input.resultSchema === undefined && input.branchFrom === undefined) return {};
              const checked = supervisor.handOffShape(
                {
                  ...(input.resultSchema ? { result_schema: input.resultSchema } : {}),
                  ...(input.branchFrom?.trim() ? { branch_from: input.branchFrom } : {}),
                },
                record.repoId,
                record.id,
              );
              if ("refused" in checked) throw new TaskGraphRefusal(checked.refused);
              return {
                ...(input.resultSchema !== undefined
                  ? { resultSchema: checked.result_schema ?? null }
                  : {}),
                ...(input.branchFrom !== undefined
                  ? { branchFrom: checked.branch_from ?? "" }
                  : {}),
              };
            })();
            // What updateFields applies first - a reopening, a move to another
            // project or under another parent - lands before where it runs is
            // judged, in one transaction: it is judged, and its words written,
            // where the task lands, and a refusal changes nothing.
            const moves = {
              ...(input.correctRequiredAction ? { correctRequiredAction: true } : {}),
              ...(input.project !== undefined ? { project: input.project } : {}),
              ...(input.parent !== undefined ? { parent: input.parent } : {}),
            };
            // A program's bound is the captain's consent (INF-799): raised only on the captain's turn.
            if (input.programBound !== undefined && this.turnOrigin !== "captain-turn")
              throw new TaskGraphRefusal(
                "program_bound is raised only on the captain's words: ask the captain on a card first.",
              );
            const rest = {
              ...(input.title !== undefined ? { title: input.title.trim().slice(0, 64) } : {}),
              ...(input.programBound !== undefined ? { programBound: input.programBound } : {}),
              ...(input.basis !== undefined ? { basis: input.basis } : {}),
              ...handOff,
              ...(input.internalStep !== undefined ? { internalStep: input.internalStep } : {}),
              ...(input.speed !== undefined ? { speed: input.speed } : {}),
              ...(input.model !== undefined && !moveTo ? { model: input.model } : {}),
              ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
              ...(input.placementRequirements !== undefined
                ? { placementRequirements: input.placementRequirements }
                : {}),
              ...(input.policies ? { policies: input.policies } : {}),
              ...(input.direction ? { direction: input.direction } : {}),
              ...(input.goal !== undefined ? { goal: input.goal.trim() || null } : {}),
              ...(input.priority !== undefined ? { priority: input.priority } : {}),
              ...(input.startPolicy ? { startPolicy: input.startPolicy } : {}),
              ...(input.verdict !== undefined
                ? { verdict: input.verdict?.trim().slice(0, 280) || null }
                : {}),
            };
            const changes = tasks.atomic(
              () => {
                const moved =
                  Object.keys(moves).length > 0
                    ? tasks.updateFields(record.id, moves, "firstmate")
                    : [];
                const refused =
                  runsOn !== undefined ? supervisor.runsOnRefusal(record.id, runsOn) : undefined;
                if (refused) throw new TaskGraphRefusal(refused);
                const added: string[] = [];
                if (declared) {
                  const linked = new Set(tasks.blockers(record.id).map((row) => row.id));
                  for (const blockerId of declared) {
                    if (linked.has(blockerId)) continue;
                    // A cycle throws inside this transaction, so the field edits
                    // above and below roll back with the link.
                    if (!tasks.link(blockerId, record.id, "blocks", "firstmate")) continue;
                    const blocker = tasks.get(blockerId);
                    added.push(`waits for ${blocker?.key || blockerId}`);
                  }
                }
                const where =
                  runsOn !== undefined
                    ? { runsOn: { ask: runsOn, words: supervisor.runsOnWords(record.id, runsOn) } }
                    : {};
                return [
                  ...moved,
                  ...tasks.updateFields(record.id, { ...rest, ...where }, "firstmate"),
                  ...added,
                ];
              },
              () => {},
            );
            const move = moveTo
              ? supervisor.requestMove(record.id, { by: "firstmate", model: moveTo })
              : undefined;
            if (move?.ok)
              this.noteDelivery({
                outcome: "action",
                kind: "work",
                tool: "update_task",
                ref: record.id,
              });
            if (changes.length === 0) {
              if (move && !move.ok) throw new TaskGraphRefusal(move.text);
              if (move) return move.text;
              return `${record.key || record.id} is unchanged.`;
            }
            const updated = tasks.get(record.id) ?? record;
            if (input.speed) supervisor.noteUnsupportedSpeed(updated.id, input.speed);
            this.replyFacts.app = `Updated ${updated.key}: ${updated.title}`;
            this.noteDelivery({
              outcome: "action",
              kind: "record",
              tool: "update_task",
              ref: record.id,
            });
            const policyNote = input.policies
              ? supervisor.policiesChanged(record.id, input.policies, beforePolicies)
              : "";
            // A task under another parent or in another project, or told
            // where it runs, goes there.
            if (runsOn !== undefined || input.parent !== undefined || input.project !== undefined)
              supervisor.runsOnChanged(record.id);
            // Policy edits alone never dispatch a queued row.
            if (
              Object.keys(input).some(
                (key) => key !== "task" && key !== "policies" && key !== "direction",
              )
            ) {
              // An edit its crewmate never hears still sparks to it: its task
              // changed (INF-759). A policy notice sparks as it lands.
              supervisor.announceReach(record.id);
              supervisor.graphChanged();
            }
            const now = tasks.get(record.id);
            return `Updated ${now?.key || record.id}: ${changes.join(", ")}.${policyNote ? ` ${policyNote}` : ""}${move ? ` ${move.text}` : ""}`;
          })();
          return { text, ok: true };
        } catch (caught) {
          if (caught instanceof TaskGraphRefusal) return { text: caught.message, ok: false };
          throw caught;
        }
      },
      drop: (input) =>
        asText(() => {
          const record = resolve(input.task);
          this.asks.attach(record.id, "update_task");
          const text = supervisor.dropTask(record.id, {
            reason: input.reason,
            ...(input.confirm ? { confirm: true } : {}),
            ...(input.replacedBy ? { replacedBy: input.replacedBy } : {}),
          });
          // A refusal comes back as text; only a task that is now dropped took effect.
          if (record.status !== "dropped" && tasks.get(record.id)?.status === "dropped") {
            this.replyFacts.app = `Dropped ${record.key}: ${record.title}`;
            this.noteDelivery({
              outcome: "action",
              kind: "work",
              tool: "update_task",
              ref: record.id,
            });
          }
          return text;
        }),
      withdrawMerge: (input) =>
        asText(() => {
          const record = resolve(input.task);
          this.asks.attach(record.id, "update_task");
          const withdrawn = supervisor.withdrawMergeApproval(record.id);
          if (withdrawn.ok) {
            this.replyFacts.app = `Withdrew merge approval for ${record.key}: ${record.title}`;
            this.noteDelivery({
              outcome: "action",
              kind: "work",
              tool: "update_task",
              ref: record.id,
            });
          }
          return withdrawn.text;
        }),
      override: (input) =>
        asText(() => {
          const record = resolve(input.task);
          // Consent is the one fact the host checks: the words are the
          // captain's own - this turn's, or the message on this task the
          // first mate cites (INF-1216) - which the row keeps and nothing
          // reads. A scheduled check carries none of his words.
          let words: string;
          if (input.from) {
            if (!this.turnCanCreate)
              return "Override refused: nothing was recorded. A scheduled check records no override, since no words of the captain's arrived with it; the one standing still applies.";
            const cited = supervisor.citedCaptainWords(record.id, input.from);
            if (!cited.ok) return cited.text;
            words = cited.words;
          } else {
            words = this.turnOrigin === "captain-turn" ? this.turnAsked.join("\n").trim() : "";
            if (!words)
              return "Override refused: only the captain's own words declare one: this turn's, or their reply under a card of the task or line in its Crewmate tab, cited with from.";
          }
          this.asks.attach(record.id, "update_task");
          const declared = supervisor.declareOverride(record.id, {
            words,
            holds: input.holds,
            until: input.until,
          });
          if (declared.ok) {
            this.replyFacts.app = `Recorded your override on ${record.key}: ${record.title}`;
            this.noteDelivery({
              outcome: "action",
              kind: "work",
              tool: "update_task",
              ref: record.id,
            });
          }
          return declared.text;
        }),
      withdrawOverride: (input) =>
        asText(() => {
          const record = resolve(input.task);
          this.asks.attach(record.id, "update_task");
          const withdrawn = supervisor.withdrawOverride(record.id);
          if (withdrawn.ok) {
            this.replyFacts.app = `Took back your override on ${record.key}: ${record.title}`;
            this.noteDelivery({
              outcome: "action",
              kind: "work",
              tool: "update_task",
              ref: record.id,
            });
          }
          return withdrawn.text;
        }),
      startAgain: async (input) => {
        const record = resolve(input.task);
        const result = supervisor.startAgain(record.id);
        if (!result.ok) return result.text;
        this.asks.attach(record.id, "update_task");
        this.asks.attach(result.task.id, "update_task");
        this.replyFacts.app = `Started ${record.key} again as ${result.task.key}: ${result.task.title}`;
        this.noteDelivery({
          outcome: "action",
          kind: "work",
          tool: "update_task",
          ref: result.task.id,
        });
        return `${result.task.key} replaces ${record.key}. ${await result.started}`;
      },
      startNow: async (input) => {
        const record = resolve(input.task);
        this.asks.attach(record.id, "update_task");
        const text = await supervisor.startQueuedNow(record.id);
        // A refusal comes back as text; only a task a crewmate now holds took effect.
        if (record.status !== "active" && tasks.get(record.id)?.status === "active") {
          this.replyFacts.app = startedReply(record.title);
          this.noteDelivery({
            outcome: "action",
            kind: "work",
            tool: "update_task",
            ref: record.id,
          });
        }
        return text;
      },
      link: (input) => {
        const from = resolve(input.from);
        const to = resolve(input.to);
        this.asks.attach(to.id, "link_tasks");
        this.asks.attach(from.id, "link_tasks");
        const linked = () =>
          tasks.linksTo(to.id).some((link) => link.fromId === from.id && link.type === input.type);
        const before = linked();
        const text = input.remove
          ? supervisor.unlinkTasks(from.id, to.id, input.type)
          : supervisor.linkTasks(from.id, to.id, input.type);
        // A refusal comes back as text; only an edge that now differs took effect.
        if (linked() !== before) {
          this.replyFacts.app = `${input.remove ? "Unlinked" : "Linked"} ${from.key} and ${to.key}`;
          this.noteDelivery({
            outcome: "action",
            kind: "record",
            tool: "link_tasks",
            ref: to.id,
          });
        }
        return text;
      },
      query: (input) =>
        queryTasks(
          tasks,
          input,
          (repoId) => this.options.repos.get(repoId)?.name,
          (taskId) => this.options.supervisor.newestCardBody(taskId),
          (taskId) => this.options.supervisor.newestCardResolution(taskId),
          (record) => this.options.supervisor.workPosture(record),
          this.options.supervisor.taskQueryReach(),
        ),
    };
  }

  private repoName(repoId: unknown): string {
    const id = stringParam(repoId);
    return (id && this.options.repos.get(id)?.name) || id || "";
  }

  /**
   * The host's own reply emotes (captain's board verdict, 2026-09-22,
   * trigger C): a steer delivered nods, a note kept tucks, a personalize
   * applied ticks - on a captain turn only, because a reply answers the
   * captain, and an operational or scheduled wake answers nobody. The
   * character holds it until the turn ends (renderer character/machine.ts),
   * and so does the line above it with the app's own words (FI3-1077),
   * marked automatic so the Firstmate's own words for the same reply win.
   */
  private replyEmote(emote: HostReplyEmote): void {
    if (this.turnOrigin !== "captain-turn") return;
    this.replyFacts.app = AUTOMATIC_EMOTE_WORDS[emote];
    this.options.broadcastEvent({
      type: "firstmate_emote",
      emote,
      text: AUTOMATIC_EMOTE_WORDS[emote],
      automatic: true,
    });
  }

  /**
   * The context block a turn actually carries: once it is built, the
   * captain's resolutions it listed are behind the Firstmate, so the next
   * turn lists only newer ones, and any model-bucket placements it showed
   * are the new baseline an unchanged next turn stays quiet about.
   */
  private contextForTurn(
    visibleCardId?: string,
    hintTaskId?: string,
    aboutCardId?: string,
    pastCardId?: string,
    words?: string,
  ): string {
    const builtAt = Date.now();
    const block = this.buildContextBlock(
      visibleCardId,
      hintTaskId,
      aboutCardId,
      pastCardId,
      words,
      this.captainFocus,
    );
    this.resolutionsSeenThrough = builtAt;
    this.threadsSeenThrough = builtAt;
    this.lastModelBucketsShown = this.modelBucketLines().join("\n");
    this.lastProjectScopesShown = JSON.stringify(this.projectScopes());
    return block;
  }

  /**
   * What the captain did outside this conversation since the Firstmate's
   * last turn, newest first, in one list: his card choices and closes (fable
   * review Q4a and the captain's note) and his clicks on a task card's own
   * buttons (FI3-695). None wakes anybody on its own, so the next turn is
   * told - bounded to the newest few inside a few hours, with a count of the
   * rest. Card lines cover tasks and the Firstmate's own task-less cards.
   */
  private renderCaptainResolutions(now: number): string[] {
    const since = Math.max(this.resolutionsSeenThrough + 1, now - RESOLVED_CONTEXT_WINDOW_MS);
    const cardLines = this.options.supervisor
      .captainResolutionsSince(since, Number.POSITIVE_INFINITY)
      .filter(({ card }) => card.taskId !== undefined || card.id.startsWith("card-fm-"))
      .map((resolution) => ({
        at: resolution.resolvedAt,
        lines: () => this.cardResolutionLines(resolution, now),
      }));
    const clickLines = this.options.tasks.taskCardClicksSince(since).map((click) => ({
      at: click.at,
      lines: () => [this.taskCardClickLine(click, now)],
    }));
    const entries = [...cardLines, ...clickLines].sort((a, b) => b.at - a.at);
    if (entries.length === 0) return [];
    const rest = entries.length - RESOLVED_CONTEXT_LIMIT;
    return [
      "what the captain did outside this conversation since your last turn (already done; not a request; a card line summarizes the choice and submitted answers; tasks by key carries the full saved report and closing offer):",
      ...entries.slice(0, RESOLVED_CONTEXT_LIMIT).flatMap((entry) => entry.lines()),
      ...(rest > 0
        ? [`- and ${rest} more, older; each task's record holds them (tasks by key)`]
        : []),
    ];
  }

  /** One card the captain resolved: his choice or close, and the answers it carried. */
  private cardResolutionLines(
    { card: stored, offer, action, resolvedAt, answers }: CardResolution,
    now: number,
  ): string[] {
    const card = offer
      ? { ...stored, title: offer.title, body: offer.body, actions: offer.actions }
      : stored;
    const task = card.taskId ? this.options.tasks.get(card.taskId) : undefined;
    const about = card.taskId
      ? `on ${task?.key || card.taskId} (task_id: ${card.taskId})`
      : "no task";
    const label = card.actions.find((entry) => entry.id === action)?.label ?? action;
    const what = action === "close" ? "dismissed" : `chose "${label}"`;
    const line = `- card ${card.id} (${cardPresentation(card)}) "${card.title}" ${about}: ${what}, ${ageText(now - resolvedAt)}`;
    // The answers to the body's own questions ride the choice (contract
    // 4.22), indented under it.
    if (!answers?.length) return [line];
    return [
      `${line}, answering its questions:`,
      ...cardAnswerLines(answers).map((answer) => `  ${answer}`),
    ];
  }

  /** One click of the captain's on a task card's own buttons, in that button's words. */
  private taskCardClickLine({ taskId, at, op, panel }: TaskCardClick, now: number): string {
    const task = this.options.tasks.get(taskId);
    // A move a panel made on his click names it, so "task card" never says where it did not happen.
    const age = panel ? `from the ${panel} panel, ${ageText(now - at)}` : ageText(now - at);
    const what =
      op === "start-again"
        ? `the captain started it again as ${this.options.tasks.replacementOf(taskId) ?? "a new task"} (Start again), ${age}; the old task stays dropped`
        : op === "start-task"
          ? `the captain started it ${panel ? "" : "from its task card, "}${age}${task?.status === "active" ? "; a crewmate is on it" : ""}`
          : op === "continue-task"
            ? `the captain told its crewmate to carry on (Continue), ${age}`
            : op === "drop-task"
              ? `the captain dropped it before it started, ${age}`
              : op === "queue-task"
                ? `the captain queued it to start by itself when nothing holds it, ${age}`
                : op === "unqueue-task"
                  ? `the captain moved it back to the backlog; it starts only on request, ${age}`
                  : `the captain stopped it and dropped it; its unfinished work is kept, ${age}`;
    return `- task ${task?.key || taskId} (task_id: ${taskId}) "${task?.title ?? ""}": ${what}`;
  }

  /**
   * What happened in the cards' threads since the Firstmate's last turn
   * (cards-as-threads phase 1, the captain's C9 A). A thread message wakes
   * nobody - the captain's words go to the card's author and the author
   * answers there - so this is the only way the Firstmate hears of it, and
   * it costs nothing until the next turn runs anyway.
   *
   * One line per card: who wrote last, the first ~120 characters, how many
   * messages the thread holds, and who owes an answer now - read from the
   * card's current lifecycle (`ThreadOwed`), never from who wrote last, so a
   * captain message a closed or reopened card kept owes nothing. Bounded the
   * way the resolutions beside it are; the task record holds the rest for
   * the `tasks` query when the Firstmate wants more.
   */
  private renderThreadActivity(now: number): string[] {
    const since = Math.max(this.threadsSeenThrough + 1, now - THREAD_CONTEXT_WINDOW_MS);
    const summaries = this.options.supervisor.threadActivitySince(since, THREAD_CONTEXT_LIMIT);
    if (summaries.length === 0) return [];
    return [
      "thread activity since your last turn (already on the record; not a request - the card's author answers it; each line ends with what its card waits on now, not who wrote last):",
      ...summaries.map(({ card, count, last, owed }) => {
        const task = card.taskId ? this.options.tasks.get(card.taskId) : undefined;
        const about = card.taskId
          ? `on ${task?.key || card.taskId} (task_id: ${card.taskId})`
          : "no task";
        const excerpt = last.text.replace(/\s+/g, " ").trim().slice(0, THREAD_EXCERPT_CHARS);
        return `- card ${card.id} "${card.title}" ${about}: ${count} message${
          count === 1 ? "" : "s"
        }, last from ${last.who} ${ageText(now - last.at)} - "${excerpt}" (${THREAD_OWED_WORDS[owed]})`;
      }),
    ];
  }

  /**
   * Every available offering the user has placed in a bucket (premium is
   * opt-in only - the automatic ladder never reaches it), grouped
   * strongest-first. An offering placed in more than one bucket is listed
   * under each. An offering in no bucket (off) is not listed; it is still
   * reachable by pinning it by name. Bucket order and names are the same
   * four words the work-shape tier table and defer_until's bucket:<x>
   * speak.
   */
  private modelBucketLines(): string[] {
    const available = this.options.availableModels();
    const availableKeys = new Set(available.map((model) => `${model.provider}/${model.id}`));
    const byBucket = new Map<Slot, string[]>();
    for (const model of this.options.quotaModels()?.models ?? []) {
      const piProvider = servedProviderOf(model.provider);
      const key = servedModelKey(model);
      if (!availableKeys.has(key)) continue;
      const memberSlots = this.options.slotsOf?.({ provider: piProvider, id: model.id }) ?? [];
      if (memberSlots.length === 0) continue; // off: not placed in any bucket
      const providerName =
        PROVIDER_CATALOG.find((entry) => entry.id === piProvider)?.name ?? piProvider;
      for (const slot of memberSlots) {
        const rows = byBucket.get(slot) ?? [];
        rows.push(`  - ${key} "${model.label}" (${providerName})`);
        byBucket.set(slot, rows);
      }
    }
    if (byBucket.size === 0) return ["- none placed; settings > models assigns a bucket"];
    const lines: string[] = [];
    for (const bucket of SLOTS) {
      const rows = byBucket.get(bucket);
      if (!rows || rows.length === 0) continue;
      lines.push(
        `${bucket}${bucket === PREMIUM_SLOT ? " (crew: never picked automatically)" : ""}:`,
      );
      lines.push(...rows);
    }
    return lines;
  }

  /** The snapshot whose lifetime is the current model context, not an app setting. */
  private projectScopes() {
    return this.options.repos
      .list()
      .filter((repo) => repo.kind !== "personal")
      .map((repo) => ({
        repo_id: repo.id,
        name: repo.name,
        scope: repo.scope || "not set",
      }));
  }

  /**
   * The model-bucket section only when what it would show has changed since
   * it was last shown (the captain's ask): an unchanged placement is not
   * repeated every turn the way it used to be.
   */
  private renderModelBuckets(): string[] {
    const lines = this.modelBucketLines();
    if (lines.join("\n") === this.lastModelBucketsShown) return [];
    return [
      "models by intelligence bucket (changed since last shown to you; not shown again until it changes):",
      ...lines,
    ];
  }

  /**
   * The compact per-turn context index. Small on purpose: crew_status and
   * the read tools are the query side. The marker stays plain model-facing
   * wording; every byte after it is one TOON-encoded JavaScript object.
   */
  buildContextBlock(
    visibleCardId?: string,
    hintTaskId?: string,
    aboutCardId?: string,
    pastCardId?: string,
    words?: string,
    focusedProjectId?: string,
  ): string {
    const repos = this.options.repos.list();
    const crew = this.options.supervisor.crewStatus();
    const schedules = this.options.scheduler?.list() ?? [];
    const outcomes = this.options.supervisionLog?.(5) ?? [];
    const shown =
      visibleCardId !== undefined
        ? this.options.supervisor.cardsSnapshot().find((card) => card.id === visibleCardId)
        : undefined;
    const aboutCard = aboutCardId
      ? this.options.supervisor.cardsSnapshot().find((card) => card.id === aboutCardId)
      : undefined;
    const requiredActionTask =
      aboutCard?.taskId && this.options.tasks.get(aboutCard.taskId)?.delivery?.captainAction
        ? aboutCard.taskId
        : undefined;
    // INF-1137 friction 2: guidance belongs to this conversation, not the
    // fixed instructions every unrelated turn pays for.
    const requiredActionGuide = requiredActionTask
      ? `; required captain action task_id ${requiredActionTask}. Answer with emit_card using this same id, task_id and reply; the host preserves instructions and controls. For failure, read the output, arrange repair through the crew and keep repair status in this thread. Never confirm for the captain.`
      : "";
    // INF-1670: the host's stuck alert names the first mate as its answerer;
    // the host wrote it, so the answer is the turn's closing words.
    const hostAlertGuide =
      aboutCard?.author === "host" && aboutCard.answeredBy === "firstmate"
        ? `; the host's stuck alert on task_id ${aboutCard.taskId ?? ""}, which you answer and cannot revise: your closing words are the answer in its thread, and any act it asks goes through your tools`
        : "";
    const aboutCardLine = aboutCard
      ? `about: card ${aboutCard.id} (${cardPresentation(aboutCard)}) "${aboutCard.title}" - the captain replied in its thread${requiredActionGuide}${hostAlertGuide}`
      : undefined;
    const maybeCard = aboutCardLine ? undefined : shown ? maybeCardContextLine(shown) : undefined;
    // The task the turn points at (the open card, or the record card): the
    // fallback prefers it, and the agent should pass its task_id (P1). A
    // Firstmate-card reply names the card instead - that card IS the topic.
    const hinted = hintTaskId ? this.options.tasks.get(hintTaskId) : undefined;
    const past = pastCardId ? this.options.supervisor.cardPast(pastCardId) : undefined;
    const pastLine = past
      ? `past card ${past.id} "${past.title}" (${pastCardEndingWords(past)}) - the captain is reading it as history${
          hinted ? ` on ${hinted.key || hinted.id}` : ""
        }; it is closed and nothing on it can be clicked, so any change comes through your tools`
      : undefined;
    const about =
      aboutCardLine ??
      pastLine ??
      (hinted
        ? `about: ${hinted.key || hinted.id} "${hinted.title}" (${indexStatus(hinted)}) - task_id ${hinted.id}; the open card points at it`
        : undefined);
    // The captain's window is focused on one project: a hint like the
    // shown record, one step weaker, never a limit on what can be done.
    const focusedProject = focusedProjectId
      ? this.options.tasks.projects.get(focusedProjectId)
      : undefined;
    const focusLine =
      focusedProject && focusedProject.archivedAt === null
        ? `${focusedProject.key} "${focusedProject.name}" - the captain's window is focused on this project, so new work they ask for belongs to it unless they name another; a hint, never a limit`
        : undefined;
    const knowledge = this.knowledgeForTurn(words, hinted?.repoId ?? undefined);
    const directions = this.options.knowledge
      ? renderDirections(
          this.options.knowledge.standingDirections({
            kind: "firstmate",
            origin: this.turnOrigin,
            canCreate: this.turnCanCreate,
          }),
        )
      : undefined;
    const surfaces = this.renderSurfaces();
    const integrations = this.options.integrations?.rosterLine();
    const captainResolutions = this.renderCaptainResolutions(Date.now());
    const threadActivity = this.renderThreadActivity(Date.now());
    const modelBuckets = this.renderModelBuckets();
    const scopes = this.projectScopes();
    const showScopes = JSON.stringify(scopes) !== this.lastProjectScopesShown;
    const introductionId = this.options.settings.getFirstRun().welcomeCardId;
    const introduction = introductionId
      ? this.options.tasks.taskForCard(introductionId)
      : undefined;

    // Build one plain JavaScript value first, then give the entire payload to
    // the TOON encoder. No section concatenates its own syntax into the
    // envelope; the model-facing marker remains outside the data so served-frame
    // and Observe readers can continue to identify the context segment.
    const context = {
      ...(showScopes
        ? {
            project_scopes: {
              note: "Project scopes: use these to choose where new work goes. Not repeated until a project or scope changes, or this context is lost.",
              projects: scopes,
            },
          }
        : {}),
      repos: repos.map((repo) => ({
        name: repo.name,
        repo_id: repo.id,
        path: repo.path,
        setup: repo.setupKind,
        workspace: repo.kind,
        // Where the project lives and, where its changes go there, the
        // app's sign-in (git integration PR 1.3).
        lives: this.livesFact(repo),
        // The computer keeping its folder, and where its tasks run (INF-567).
        ...this.placesFact(repo),
        ...(repo.kind === "personal"
          ? { delivery: "builds in place" }
          : {
              delivery: repo.delivery,
              autonomy: repo.autonomy,
              ...(repo.rigor ? { rigor: repo.rigor } : {}),
            }),
      })),
      crew: crew.map((entry) => ({
        task_id: entry.taskId,
        status: entry.status,
        title: entry.title,
        repo: entry.repoName ?? "default workspace",
        // The computer it runs on, while another computer runs work (INF-992).
        ...(entry.computer ? { runs_on: entry.computer } : {}),
        ...(entry.gate ? { gate: entry.gate } : {}),
        ...(entry.rigor ? { rigor: entry.rigor } : {}),
        ...(entry.autonomy === undefined ? {} : { autonomy: entry.autonomy }),
        ...(entry.review ? { review: entry.review } : {}),
        ...(entry.thread ? { thread: entry.thread } : {}),
        ...(entry.restart ? { restart: entry.restart } : {}),
        ...(entry.stalled ? { stalled: entry.stalled } : {}),
        // Durations to read, never guess (INF-1244).
        ...(entry.job ? { job: entry.job } : {}),
        ...(entry.reported ? { reported: entry.reported } : {}),
        ...(entry.checkBack ? { check_back: entry.checkBack } : {}),
        ...(entry.override ? { override: entry.override.passes } : {}),
      })),
      // Served only while another computer runs work, so one computer pays nothing (INF-992).
      ...(this.options.supervisor.computersListed() ? { computers: COMPUTERS_RULE } : {}),
      ...(this.options.computerVersions
        ? { computer_versions: this.options.computerVersions() }
        : {}),
      task_index: this.renderTaskIndex(),
      ...this.renderOpenAsks(),
      ...(introduction && introductionId
        ? {
            introduction: {
              card_id: introductionId,
              title: introduction.title,
              body: introduction.outcome,
              already_created: true,
            },
          }
        : {}),
      ...(captainResolutions.length > 0 ? { captain_resolutions: captainResolutions } : {}),
      ...(threadActivity.length > 0 ? { thread_activity: threadActivity } : {}),
      ...(schedules.length > 0
        ? {
            schedules: schedules.map((record) => ({
              id: record.id,
              timing: scheduleTextOf(record),
              prompt: record.prompt.slice(0, 80),
            })),
          }
        : {}),
      ...(outcomes.length > 0
        ? {
            recent_fleet_outcomes: outcomes.map((outcome) => ({
              verdict: outcome.verdict,
              task_id: outcome.taskId,
              summary: outcome.summary.slice(0, 100),
            })),
          }
        : {}),
      ...(knowledge ? { knowledge } : {}),
      ...(directions ? { directions } : {}),
      ...(surfaces ? { surfaces } : {}),
      // One name per connected integration; its actions are read on request.
      ...(integrations ? { integrations } : {}),
      ...(modelBuckets.length > 0 ? { models_by_intelligence_bucket: modelBuckets } : {}),
      quota: this.options.quotaLine(),
      // The zone CARD_AUTHORING's time rule says times in (FI3-1006).
      captain_time_zone: timeZoneFact(this.now()),
      self_source: this.options.selfSourceDir,
      ...(maybeCard ? { visible_card_hint: maybeCard } : {}),
      ...(about ? { about } : {}),
      ...(focusLine ? { focused_project: focusLine } : {}),
    };
    return `[fm-op] context (not the user)\n${encode(context)}`;
  }

  /**
   * The knowledge a turn's words match (docs/knowledge.md, "Knowledge
   * as needed"): the captain's collection only. Project collections stay
   * readable by an explicit search, and are not offered as candidates.
   * Absent where knowledge is off or the words give nothing to search for.
   */
  private knowledgeForTurn(
    words: string | undefined,
    _repoId: string | undefined,
  ): Record<string, string | string[]> | undefined {
    const knowledge = this.options.knowledge;
    if (!knowledge || !words) return undefined;
    const scopes = [PRIVATE_SCOPE];
    try {
      return contextKnowledge(knowledgeShortlist(knowledge, scopes, words));
    } catch (error) {
      console.warn("[firstmate] the knowledge lookup failed:", error);
      return { unavailable: "the lookup failed this turn" };
    }
  }

  /**
   * Where a project lives, as the context's `lives` fact (git integration
   * PR 1.1, sign-in added by PR 1.3): the host's kind from its origin -
   * github, gitlab, bitbucket, git, or none for a project kept only on
   * this Mac - and, only where the project's changes go there, the app's
   * sign-in: `github (signed in as octo)`, `github (not signed in)`. A
   * project whose work goes straight in never needs a sign-in, so its fact
   * names none (the captain's constraint: a host is never required); a
   * plain host names its address, which is all there is to know about it.
   */
  /** A project's folder computer and where its tasks run, while another computer runs work. */
  private placesFact(repo: RepoView): { folder_on?: string; tasks_run_on?: string } {
    const places = this.options.supervisor.projectPlaces(repo);
    return places ? { folder_on: places.folder, tasks_run_on: places.tasks } : {};
  }

  private livesFact(repo: RepoView): string {
    const host = repo.host;
    if (!host) return "none";
    if (repo.kind === "personal" || repo.delivery !== "direct-pr") return host.kind;
    const signIn = host.name ? this.options.forges?.signInOn(host.name) : undefined;
    if (signIn === undefined) {
      // A plain host has no name of its own but its address.
      const place = forgePlace({ kind: host.kind, host: host.name });
      return place && place === host.name ? `${host.kind} (${place})` : host.kind;
    }
    if (signIn === null) return `${host.kind} (not signed in)`;
    const who = signIn.login ? `signed in as ${signIn.login}` : "signed in";
    if (signIn.state === "needs_reauth") {
      return `${host.kind} (${signIn.name} no longer accepts the sign-in)`;
    }
    if (signIn.state === "unavailable") return `${host.kind} (${who}; not reachable just now)`;
    return `${host.kind} (${who})`;
  }

  /**
   * The captain's surfaces (talk-to-personalize Step 1): the theme and every
   * panel with its rail, position and visibility under the layout - bounded,
   * one row per surface, each carrying the id `personalize` takes. Absent in
   * a build with no personalize tool.
   */
  private renderSurfaces(): Record<string, unknown> | undefined {
    const personalize = this.options.personalize;
    if (!personalize) return undefined;
    const preferences = personalize.preferences.get();
    const personal = personalize.personal();
    const all = listSurfaces(preferences.layout, personal, personalize.gates());
    const mounts = personalize.mounts?.() ?? null;
    const personalSurfaces = all.filter((surface) => surface.kind === "personal");
    const shown = [
      ...all.filter((surface) => surface.kind === "app"),
      ...personalSurfaces.slice(0, SURFACES_CONTEXT_LIMIT),
    ];
    const omitted =
      personalSurfaces.length - Math.min(personalSurfaces.length, SURFACES_CONTEXT_LIMIT);
    const panelsOff = panelsOffLine(preferences.panels);
    return {
      description: "app_change panel and personalize remove act on these ids",
      theme: preferences.appearance.theme,
      panels: shown.map((surface) => ({
        id: surface.id,
        title: surface.title,
        owner: surface.kind === "personal" ? "captain" : "app",
        rail: surface.placement.x,
        position: surface.placement.y,
        // The window's own word on it (docs/personal-panels.md, "Placed on the rail").
        state: surfaceState(surface, mounts),
      })),
      ...(omitted > 0 ? { personal_panels_omitted: omitted } : {}),
      ...(panelsOff ? { panels_off: panelsOff } : {}),
    };
  }

  /**
   * The captain's sequences (docs/sequences.md), read at each idle boundary
   * and served after the prompt. Created on first use, because the personal
   * workspace is an option the constructor has not unpacked yet.
   */
  private sequences: SequencesSource | undefined;
  /** The fallback last announced, so a broken file is one feed line, not one per turn. */
  private sequencesFallback: SequencesFallback | undefined;

  private servedSequences(): ServedSequences {
    this.sequences ??= new SequencesSource(this.options.personalize?.personalWorkspaceDir);
    const served = this.sequences.current();
    if (served.fallback !== this.sequencesFallback) {
      this.sequencesFallback = served.fallback;
      if (served.fallback) {
        this.options.broadcastEvent({
          type: "firstmate_note",
          text: `Your instructions on how to approach work could not be used (${SEQUENCES_FALLBACK_WORDS[served.fallback]}); following the built-in ones`,
        });
      }
    }
    return served;
  }

  /**
   * The open-task index (design section 9.1): per project, counts plus the
   * top rows - needs-you first, then active, then open - so the agent can
   * find the task an ask is about and pass its task_id. Closed work is not
   * listed here (it was noise on every turn); the `tasks` tool's `status:
   * closed` is the on-demand way to reach it. Bounded per project and in
   * total; one-off question/operation rows appear only in the counts, never
   * as rows, so a chatty day cannot crowd the work out.
   */
  /**
   * The captain's messages that have not ended on an answer they accepted
   * (INF-1610, docs/task-capture.md "How a message ends"), newest first and
   * bounded like the task index: so "what is still open?" needs no
   * crewmate. A message the notice answered stays listed while its notice
   * is up. Answered ones are read through the tasks tool.
   */
  private renderOpenAsks(): { open_asks?: Record<string, unknown> } {
    const ending = this.options.supervisor.askEnding;
    const shown = new Set(this.options.supervisor.cardsSnapshot().map((card) => card.id));
    const rows: { at: number; row: Record<string, unknown> }[] = [];
    try {
      for (const chain of ending.openChains()) {
        const state = ending.state(chain);
        const newest = chain.members.at(-1) ?? chain.root;
        const live = ending.ownWork(chain).filter((task) => !TaskService.isClosed(task));
        rows.push({
          at: newest.at,
          row: {
            ask_id: chain.root.id,
            sent: new Date(chain.root.at).toISOString(),
            ...(chain.members.length > 1 ? { later_messages: chain.members.length - 1 } : {}),
            state:
              state.kind === "working"
                ? "working"
                : state.kind === "waiting"
                  ? `waiting on the captain: card ${state.cardId}`
                  : state.kind === "accepted"
                    ? "answer accepted"
                    : "no answer yet",
            ...(live.length > 0
              ? {
                  running: live
                    .slice(0, 4)
                    .map((task) => `${task.key || task.id}: ${task.title.slice(0, 80)}`),
                }
              : {}),
          },
        });
      }
      for (const ask of this.options.tasks.listAsksByDelivery("unresolved")) {
        if (!ask.followed || !ask.noticeCardId || !shown.has(ask.noticeCardId)) continue;
        rows.push({
          at: ask.at,
          row: {
            ask_id: ask.id,
            sent: new Date(ask.at).toISOString(),
            state: `unanswered: the app's notice ${ask.noticeCardId} is up`,
          },
        });
      }
    } catch (caught) {
      console.warn("[firstmate] the open messages could not be read:", caught);
      return {};
    }
    if (rows.length === 0) return {};
    rows.sort((a, b) => b.at - a.at);
    return {
      open_asks: {
        note: "The captain's messages not yet answered on a card they accepted, newest first, by when each was sent; their words are in your conversation. Each ends on the card marked answering that they accept.",
        asks: rows.slice(0, TASK_INDEX_PER_PROJECT).map((entry) => entry.row),
        ...(rows.length > TASK_INDEX_PER_PROJECT
          ? { more: rows.length - TASK_INDEX_PER_PROJECT }
          : {}),
      },
    };
  }

  private renderTaskIndex(): string[] {
    const tasks = this.options.tasks;
    const byProject = new Map<string, TaskRecord[]>();
    // The live set alone: reading a long record's closed rows each turn
    // costs the main process time a keystroke waits on (INF-703).
    for (const record of tasks.listLive()) {
      const rows = byProject.get(record.projectId) ?? [];
      rows.push(record);
      byProject.set(record.projectId, rows);
    }
    if (byProject.size === 0) return ["tasks:", "- none yet"];
    const lines = [
      "tasks (live only; task_id for tools; kinds other than work are marked; closed work: tasks tool, status: closed):",
    ];
    let total = 0;
    let omitted = 0;
    for (const project of tasks.projects.list()) {
      const rows = byProject.get(project.id);
      if (!rows || rows.length === 0) continue;
      const count = (predicate: (record: TaskRecord) => boolean) => rows.filter(predicate).length;
      const counts = [
        `${count((r) => r.status === "open")} open`,
        `${count((r) => r.status === "active")} active`,
      ];
      lines.push(`- ${project.key} ${project.name}: ${counts.join(", ")}`);
      const rank = (a: TaskRecord, b: TaskRecord) =>
        indexRank(a) - indexRank(b) || a.priority - b.priority || b.updatedAt - a.updatedAt;
      // A live child nests under its live parent, so a parent and the work
      // under it read as one row and count as one against the caps.
      const live = new Set(rows.map((record) => record.id));
      const childrenOf = new Map<string, TaskRecord[]>();
      for (const record of rows) {
        if (!record.parentId || !live.has(record.parentId)) continue;
        const siblings = childrenOf.get(record.parentId) ?? [];
        siblings.push(record);
        childrenOf.set(record.parentId, siblings);
      }
      const listed = rows
        .filter((record) => !record.parentId || !live.has(record.parentId))
        .sort(rank);
      const renderRow = (record: TaskRecord, depth: number, nested: boolean) => {
        const indent = "  ".repeat(depth + 1);
        const kind = record.kind === "work" ? "" : `${record.kind} `;
        lines.push(
          `${indent}- ${record.key || record.id} (task_id: ${record.id}) ${kind}${indexStatus(record)} "${record.title}"${this.indexGraphNote(record, nested)}`,
        );
        // What is on screen for the task (WI-12): the agent revises an
        // overlapping card, steers a crewmate that already carded it, and
        // adds a card only for something distinct.
        for (const card of this.options.supervisor.openCardDigests(record.id)) {
          lines.push(`${indent}  - ${openCardContextLine(card)}`);
        }
        for (const child of (childrenOf.get(record.id) ?? []).sort(rank)) {
          renderRow(child, depth + 1, true);
        }
      };
      for (const record of listed.slice(0, TASK_INDEX_PER_PROJECT)) {
        if (total >= TASK_INDEX_TOTAL) {
          omitted += 1;
          continue;
        }
        total += 1;
        renderRow(record, 0, false);
      }
      omitted += Math.max(0, listed.length - TASK_INDEX_PER_PROJECT);
    }
    if (omitted > 0) {
      lines.push(
        `  - and ${omitted} more; crew_status lists the live crew, tasks queries the rest`,
      );
    }
    return lines;
  }

  /**
   * The graph in a few words on an index row (P2): the parent, where a
   * follow-up was found, and what the row waits on - blockers by key, an
   * on-request policy - so the agent can answer "why has this not started"
   * (or "why can this not land") without a query.
   */
  private indexGraphNote(record: TaskRecord, nested = false): string {
    const tasks = this.options.tasks;
    const parts: string[] = [];
    // A nested row sits under its parent already; saying so again is noise.
    const parent = record.parentId && !nested ? tasks.get(record.parentId) : undefined;
    if (parent) parts.push(`under ${parent.key || parent.id}`);
    // A parent no crewmate holds is a container: say so, and how the work
    // under it stands, since nothing else on its row would.
    const children = record.status === "open" ? tasks.children(record.id) : [];
    const container = children.length > 0;
    if (container) {
      const count = (status: TaskRecord["status"]) =>
        children.filter((child) => child.status === status).length;
      parts.push(
        `no crewmate; children: ${count("active")} running, ${count("open")} open, ${count("done")} done`,
      );
    }
    // A follow-up is no longer a child of the task it was found on, so its
    // discovered-from edge is the only thing that places it.
    const origins = tasks.discoveredOrigins(record.id);
    if (origins.length > 0) {
      parts.push(`found on ${origins.map((origin) => origin.key || origin.id).join(", ")}`);
    }
    if (record.status === "active") {
      const holding = tasks.blockersHoldingClose(record.id);
      if (holding.length > 0) {
        parts.push(
          `cannot land until ${holding.map((blocker) => blocker.key || blocker.id).join(", ")}`,
        );
      }
      // A baseline wait holds no close, but the task waits on that work
      // all the same; it resumes when that work closes (FI3-250).
      const waits = standingDependencyWaits(tasks, record.delivery)
        .map((wait) => wait.task)
        .filter((task) => TaskService.blockerHoldsClose(task))
        .filter((task) => !holding.some((blocker) => blocker.id === task.id));
      if (waits.length > 0) {
        parts.push(`waits on ${waits.map((task) => task.key || task.id).join(", ")}`);
      }
    }
    if (record.status === "open" && record.kind === "work") {
      const waiting = tasks.waitingOn(record.id);
      if (waiting.length > 0) {
        const dead = waiting.some((blocker) => blocker.status === "dropped");
        parts.push(
          `blocked by ${waiting.map((blocker) => blocker.key || blocker.id).join(", ")}${dead ? " (dropped)" : ""}`,
        );
      } else if (!record.gate && record.startPolicy === "on-request" && !container) {
        parts.push("on request");
      }
    }
    return parts.length > 0 ? ` [${parts.join("; ")}]` : "";
  }

  private async runTurn(
    session: ModelSession,
    input: ServedInput,
    thinkingLevel: FirstmateThinkingLevel,
    images?: Array<{ mimeType: string; data: string }>,
    inboxRows?: { id: number; attempts: number }[],
    asked: readonly string[] = [],
  ): Promise<void> {
    this.running = true;
    this.turnFailed = false;
    this.turnContextOverflow = false;
    this.turnAsked = [...asked];
    this.turnTools = [];
    this.turnCutOff = undefined;
    this.turnPausing = false;
    this.lastEventAt = Date.now();
    this.quietLevel = 0;
    this.lastTurnText = undefined;
    this.deliveredThisTurn = false;
    this.replyFacts = {};
    this.pendingReads = [];
    this.readThisTurn.clear();
    this.expectRead(input.framed.text, [
      ...this.delivery.adoptedAsks(),
      ...(this.turnLiveCaptain?.askId ? [this.turnLiveCaptain.askId] : []),
    ]);
    const localTurn = this.boundLocal;
    this.turnError = undefined;
    this.turnFailureKind = undefined;
    // Tools attach only to messages the backend has actually read.
    this.asks.beginTurn();
    this.asks.select(undefined);
    // The policy-step boundary (R2): the decision opens as the input is
    // served and closes once its asks, inbox rows and effects are settled.
    this.decisions.begin({
      tag: "fm",
      producer: {
        actor: "firstmate",
        role: "firstmate",
        model: session.modelRef() ?? null,
        accountId: this.boundAccountId ?? null,
        thinkingLevel,
      },
      contract: {
        version: FIRSTMATE_CONTRACT_VERSION,
        promptSha: firstmatePromptSha(),
        toolsSha: this.toolsSha,
      },
      input,
    });
    this.options.broadcastEvent({ type: "firstmate_state", busy: true });
    let threw = false;
    try {
      await session.prompt(input.framed.text, images);
      if (
        localTurn &&
        !this.turnFailed &&
        this.options.tasks.listOpenAsks().some((ask) => this.readThisTurn.has(ask.id)) &&
        !this.deliveredThisTurn &&
        !(this.turnAboutCardId && String(this.lastTurnText ?? "").trim())
      ) {
        throw new Error(
          "The local model finished without showing an answer or taking an action. Try again or choose a different model.",
        );
      }
    } catch (caught) {
      // The thrown channel: Pi's pre-request auth preflight lands here, so
      // route through the same auth-vs-generic dispatch as session failures.
      threw = true;
      const message = caught instanceof Error ? caught.message : String(caught);
      this.turnError = message;
      this.turnFailureKind ??= turnFailureReason(message, false);
      this.noteRunaway(message);
      this.raiseSessionFailureCard(message);
    } finally {
      // A quit cut this turn: nothing it read is answered, acknowledged or
      // judged now. Its lane rows stay in flight and its messages open, so the
      // next boot reconciles it as it does a crash (docs/task-capture.md).
      if (this.disposed) this.running = false;
      else this.closeTurn(session, threw, inboxRows);
    }
  }

  /**
   * The end of a turn that settled while the app runs: its lane rows are
   * acknowledged or released, its messages filed and judged, and the lane
   * drained again.
   */
  private closeTurn(
    session: ModelSession,
    threw: boolean,
    inboxRows: { id: number; attempts: number }[] | undefined,
  ): void {
    let asks: { id: string; taskId: string | null; via: string | null }[] = [];
    // The messages this turn read, as they stood before its close filed them.
    let readAsks: string[] = [];
    // Ack after handling: the batch is deleted only when the turn ended
    // clean. A turn that failed at the provider (provider failures resolve
    // rather than throw, so the turn_failed flag counts) takes the honest
    // retry (docs/inbox.md): no attempt spent, backing off - and never
    // before a spent allowance's reset. One that threw spends its attempt
    // and is due again one grace later.
    // Set by the turn's own events, which the reset above cannot see.
    const cutOff = this.turnCutOff as CutOff | undefined;
    if (inboxRows && inboxRows.length > 0) {
      const ids = inboxRows.map((row) => row.id);
      if (!threw && this.turnFailed) {
        this.options.inbox.releaseAfterProviderFailure(
          ids,
          cutOff?.resetsAt !== undefined ? { notBefore: cutOff.resetsAt } : {},
        );
      } else if (threw) {
        this.options.inbox.release(ids);
        if (inboxRows.some((row) => row.attempts + 1 === INBOX_ATTEMPT_MAX)) {
          // The firstmate lane never escalates to a card - operational
          // messages have nowhere else to go - but the repeated failure
          // is said once in the feed instead of staying invisible.
          this.options.broadcastEvent({
            type: "firstmate_note",
            text: `Operational updates could not be handled after ${INBOX_ATTEMPT_MAX} attempts; they retry when your first mate recovers.`,
          });
        }
      } else {
        this.options.inbox.ack(ids);
      }
    }
    // A Start this turn read and did not start begins as it is, and its wake
    // is then served.
    if (inboxRows && inboxRows.length > 0) {
      const began = this.options.supervisor.firstmateTurnEnded(
        inboxRows.map((row) => row.id),
        threw ? "broke" : this.turnFailed ? "failed" : "clean",
      );
      this.options.inbox.ack(began);
    }
    // The provider answered: whatever was backing off on this lane is due now.
    if (!threw && !this.turnFailed) this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
    // The captain's live words ride no row until here.
    const live = this.turnLiveCaptain;
    this.turnLiveCaptain = undefined;
    const pausing = cutOff !== undefined && this.turnPausing;
    // The captain's words the turn answered none of - the live ones and
    // every steer it took in, oldest first - go back on the lane as theirs,
    // and the row is then their one copy: Retry drains it, never re-sends.
    const words = [...(live ? [live] : []), ...this.acceptedSteers];
    if (pausing) {
      // Paused: due when the seat serves again.
      this.acceptedSteers = [];
      for (const entry of words) {
        this.options.inbox.enqueue(
          FIRSTMATE_RECIPIENT,
          parkedCaptainTurn(entry.words, entry.attachments, entry.askId),
          captainTurnRef(entry.aboutCardId),
          "captain",
        );
      }
      this.lastUserTurn = undefined;
    } else if (this.turnFailed && !threw) {
      // Failed at the provider and paused nothing: they wait through the
      // honest retry beside the failure card, never due at once (and never
      // before a spent allowance's reset). Retry makes them due now.
      this.acceptedSteers = [];
      const ids = words.map((entry) =>
        this.options.inbox.enqueue(
          FIRSTMATE_RECIPIENT,
          parkedCaptainTurn(entry.words, entry.attachments, entry.askId),
          captainTurnRef(entry.aboutCardId),
          "captain",
        ),
      );
      this.options.inbox.markDelivered(ids);
      this.options.inbox.releaseAfterProviderFailure(
        ids,
        cutOff?.resetsAt !== undefined ? { notBefore: cutOff.resetsAt } : {},
      );
      if (ids.length > 0) this.lastUserTurn = undefined;
    } else if (!threw) {
      // A clean turn answered what it carried: nothing is left to retry.
      this.lastUserTurn = undefined;
      this.options.supervisor.withdrawHostCard(FIRSTMATE_FAILURE_CARD_ID, "recovered");
    }
    // The capture floor (P1): whatever no tool attached lands now - on
    // the hinted task, else as its own question task. A failed turn files
    // too, apart from a message whose words now wait on the lane for a
    // retry: the turn that serves them again attaches and closes it.
    // Never lets a bookkeeping fault take the turn down with it.
    try {
      const turnAsks = this.options.tasks.listOpenAsks().map((ask) => ask.id);
      readAsks = turnAsks.filter((id) => this.readThisTurn.has(id));
      const waiting = this.delivery.waitingOnLane();
      this.asks.endTurn({
        asks: readAsks.filter((id) => !waiting.includes(id)),
        failed: threw || this.turnFailed,
        closingText: this.lastTurnText,
        error: this.turnError,
      });
      asks = readAsks.map((id) => {
        const ask = this.options.tasks.getAsk(id);
        return { id, taskId: ask?.taskId ?? null, via: ask?.attachedVia ?? null };
      });
    } catch (caught) {
      console.warn("[firstmate] ask capture failed at turn end:", caught);
    }
    const failed = threw || this.turnFailed;
    const decision = this.decisions.finish({
      served: session.servedState(),
      outcome: failed ? "failed" : "clean",
      error: failed ? this.turnError : undefined,
      inbox: inboxRows && inboxRows.length > 0 ? (failed ? "released" : "acked") : "none",
      asks,
    });
    // A scheduled prompt this turn handled is handled in its rule's
    // history, with the work the turn touched (docs/automation.md).
    if (decision) {
      try {
        this.options.scheduler?.noteDecision(decision);
      } catch (caught) {
        console.warn("[firstmate] automation history failed at turn end:", caught);
      }
    }
    const trigger: TurnTrigger = this.turnOrigin === "captain-turn" ? "captain" : "operation";
    this.recordDigest(trigger, failed);
    const recoverContext = this.turnContextOverflow && !this.contextRecoveryAttempted && !threw;
    if (!failed) this.contextRecoveryAttempted = false;
    if (recoverContext) {
      this.contextRecoveryAttempted = true;
      // Keep the old transcript and the failed decision; only forget this backend's
      // resume pointer. The normal durable lane owns redelivery, including steers.
      const backend = session.resume()?.backend;
      if (backend === "claude") this.options.settings.setFirstmateClaudeSession(null);
      else this.options.settings.setFirstmateSessionFile(null);
      const recent = digestFor(this.options.settings.getFirstmateSeatDigest(), "");
      this.options.inbox.enqueue(
        FIRSTMATE_RECIPIENT,
        `[fm-op] The previous conversation reached the model's context limit. A fresh conversation starts with this bounded recent-turn digest. Check the task records before repeating any action.\n${JSON.stringify(recent)}`,
        "context-recovery",
        "agent",
      );
      // The changed conversation, like Retry, makes the kept words due now.
      this.options.inbox.endOutage(FIRSTMATE_RECIPIENT);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: "Your first mate reached the conversation limit and is continuing with recent context in a new conversation.",
      });
    }
    this.settleTurn(
      failed
        ? {
            trigger,
            failed: true,
            reason: this.turnFailureKind ?? turnFailureReason(this.turnError, this.turnFailed),
          }
        : { trigger, failed: false },
    );
    this.running = false;
    const tookIn = this.redeliverUndeliveredSteers(session);
    if (recoverContext) this.detachSession();
    this.clearQuiet();
    // The closing words answer every card reply this turn read - its own
    // about card, and one the captain sent while it ran - unless it
    // revised that card instead.
    const threadAnswer = (this.lastTurnText ?? "").trim();
    const answered = new Set(
      [this.turnAboutCardId, ...tookIn.map((steer) => steer.aboutCardId)].filter(
        (cardId): cardId is string => cardId !== undefined,
      ),
    );
    // The reply line goes out before the busy signal falls, so the
    // working line turns straight into it; an answer in a card's replies
    // is an answer on that card, and its words are the line too.
    if (!failed && threadAnswer && answered.size > 0) this.replyFacts.acted = true;
    this.replyToLastMessage(
      [...this.readThisTurn],
      failed ? plainProblem(this.turnError, cutOff ? { cutOff } : undefined) : undefined,
    );
    this.options.broadcastEvent({ type: "firstmate_state", busy: false });
    if (!failed && threadAnswer) {
      for (const cardId of answered) {
        try {
          if (this.options.supervisor.recordFirstmateThreadAnswer(cardId, threadAnswer)) {
            this.delivery.creditReply(cardId);
          }
        } catch (caught) {
          console.warn("[firstmate] card-thread answer failed at turn end:", caught);
        }
      }
    }
    this.turnAboutCardId = undefined;
    // The turn's end is the Firstmate's close-out: a card of its own it
    // answered since the captain's reply reaches the stage now.
    this.options.supervisor.firstmateClosedOut();
    // Answer delivery: the normal capture above is done, so each message
    // this turn read is judged by what took effect after it.
    const unread = [...this.unreadAsks];
    this.unreadAsks.clear();
    this.delivery.endTurn({ asks: readAsks, held: failed || pausing, unread });
    this.pendingReads = [];
    this.readThisTurn.clear();
    // A cut-off pauses the seat now, not when the next row falls due.
    if (pausing) void this.admitAfterCutOff();
    else void this.drainInbox();
  }

  /**
   * The reply line beside the captain's newest message (docs/composer.md
   * "The last turn"), when the turn that just ended read it: the problem's
   * plain words for a turn that failed, else the line its closing words
   * and facts choose (./replyLine). It is kept beside the message for the next launch and
   * sent to the window. A turn that did not read the newest message, or
   * where nothing took effect, leaves the line as it is.
   */
  private replyToLastMessage(read: readonly string[], problem: string | undefined): void {
    const text = problem ?? replyLine(this.replyFacts);
    const words = problem ? undefined : replyWords(this.replyFacts);
    if (text)
      this.keepReplyLine(
        read,
        problem
          ? { text, problem: true }
          : { text, eligibility: "completed", ...(words ? { words } : {}) },
      );
  }

  /** Keeps a reply line beside the newest message, when it is one of `read`, and sends it. */
  private keepReplyLine(read: readonly string[], reply: LastTurnReply): void {
    try {
      const latest = this.options.tasks.latestAskId();
      if (!latest || !read.includes(latest)) return;
      this.options.tasks.setAskReply(latest, reply);
      this.options.broadcastEvent({ type: "firstmate_reply", ...reply });
    } catch (caught) {
      console.warn("[firstmate] the reply line could not be kept:", caught);
    }
  }

  /**
   * One turn on the digest a seat move carries across (Q4 b,
   * `seatDigest.ts`): who it answered, the captain's words, the tools it
   * called and its closing words - capped, and never a turn's transcript.
   */
  private recordDigest(trigger: TurnTrigger, failed: boolean): void {
    const seat = this.boundSeat;
    if (!seat) return;
    try {
      const settings = this.options.settings;
      settings.setFirstmateSeatDigest(
        appendDigest(
          settings.getFirstmateSeatDigest(),
          digestEntry({
            seat: seat.identity,
            at: this.now(),
            // A turn that served the captain's words answered the captain,
            // whatever else its batch carried.
            trigger: this.turnAsked.length > 0 ? "captain" : trigger,
            asked: this.turnAsked,
            tools: this.turnTools,
            ...(this.lastTurnText ? { said: this.lastTurnText } : {}),
            failed,
          }),
        ),
      );
    } catch (caught) {
      console.warn("[firstmate] seat digest failed at turn end:", caught);
    }
  }

  /**
   * Whether a typed cut-off on this seat is the ladder's to answer: the
   * seat is bound to an account the cut-off is recorded on. Otherwise (the
   * base runtime, the local seat) the turn fails the ordinary way.
   */
  private pausesOnCutOff(): boolean {
    return Boolean(
      this.options.flagship && this.options.noteCutOff && this.boundAccountId && !this.boundLocal,
    );
  }

  /** Whether the bound account, as the cut-off just left it, pauses the seat. */
  private pausesNow(): boolean {
    const accountId = this.boundAccountId;
    return Boolean(accountId && this.options.flagship?.pause(accountId));
  }

  /** A turn ended in a cut-off: admission reads the account now, and pauses or moves on. */
  private async admitAfterCutOff(): Promise<void> {
    const session = await this.ensureSession();
    if (!session || this.running || session.isStreaming()) return;
    const admitted = await this.admitTurn(session);
    if (admitted) void this.drainInbox();
  }

  /**
   * One watchdog pass over the orchestrator's own turn, on the supervisor's
   * shared tick: the 10-minute feed line and 20-minute card a crewmate gets.
   */
  checkQuiet(now: number): void {
    if (!this.isBusy()) return;
    const quietFor = now - this.lastEventAt;
    const minutes = Math.round(quietFor / 60_000);
    if (quietFor >= QUIET_CARD_MS && this.quietLevel < 2) {
      this.quietLevel = 2;
      this.options.supervisor.addFirstmateQuietCard(
        `Your first mate has said nothing for ${minutes} minutes while working. It may be stuck; it recovers on its own when it finishes.`,
      );
    } else if (quietFor >= QUIET_FEED_MS && this.quietLevel < 1) {
      this.quietLevel = 1;
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Your first mate has been quiet for ${minutes} minutes while working.`,
      });
    }
  }

  /** Any session event is proof of life; a stale quiet card retires. */
  private noteActivity(): void {
    this.lastEventAt = Date.now();
    if (this.quietLevel > 0) this.clearQuiet();
  }

  private clearQuiet(): void {
    this.quietLevel = 0;
    this.options.supervisor.clearFirstmateQuietCard();
  }

  /**
   * Deliver queued [fm-op] messages when the session is idle. Streaming
   * turns are never interrupted; agent-end triggers the next drain, and the
   * supervisor's shared tick pokes so retries happen even in a quiet app.
   * Rows are marked in-flight at hand-off and acknowledged only when the
   * consuming turn ends without error (runTurn), so a failed turn or a quit
   * re-presents the batch instead of losing it.
   *
   * The wake diet (WI-13): the first pending wake waits `WAKE_COALESCE_MS`
   * for its siblings, then everything pending drains as ONE turn - so a burst
   * of crew reports or escalations is one interruption, not one each. The
   * window is anchored to the oldest pending row's `createdAt` and read from
   * the clock, so a stranded row from a past session (long aged) drains at
   * once and a replay's frozen clock coalesces identically.
   */
  private async drainInbox(): Promise<void> {
    if (this.disposed || this.running) return;
    const now = this.now();
    const rows = this.options.inbox.pending(FIRSTMATE_RECIPIENT, now, { limit: 20 });
    const oldest = rows[0];
    if (!oldest) return;
    const waited = now - oldest.createdAt;
    // A captain's words never wait out the window, nor does the one retry
    // for a message nothing took effect after, nor how his click on a setup
    // card came out: someone is waiting on it.
    const waiting = rows.some(
      (row) =>
        row.origin === "captain" ||
        row.facts?.kind === "answer-missing" ||
        row.facts?.kind === "project-setup",
    );
    if (waited < this.coalesceMs && !waiting) {
      this.scheduleCoalesceDrain(this.coalesceMs - waited);
      return;
    }
    this.clearCoalesceTimer();
    // A quit that lands while the drain waits ends it before it reads the
    // lane again: the rows stay undelivered for the next boot.
    const session = await this.ensureSession();
    if (this.disposed || !session || session.isStreaming() || this.running) return;
    // Paused (no account can serve): rows stay queued for a later drain.
    const admitted = await this.admitTurn(session);
    if (this.disposed || !admitted || admitted.isStreaming() || this.running) return;
    this.serveInstructionsAt(admitted);
    // Admission or the instructions served may have queued the moved seat's
    // wake: the batch is read after it.
    const served = this.withPictures(
      this.options.inbox.pending(FIRSTMATE_RECIPIENT, this.now(), { limit: 20 }),
    );
    const pending = served.rows;
    // A card click has its own turn: no operational report can borrow its
    // authority. Ordinary parked captain words retain their prior co-batching.
    const choice = pending.find(
      (row) => row.origin === "captain" && row.facts?.kind === "card-choice",
    );
    // The answer-delivery retry is served alone: a typed wake of its own,
    // never batched with anything and never carried on a captain's turn.
    const retry = choice ? undefined : pending.find((row) => row.facts?.kind === "answer-missing");
    const batch = choice ? [choice] : retry ? [retry] : pending;
    if (batch.length === 0) return;
    const batchImages = choice ? undefined : served.images;
    const classified = classifyInboxBatch(batch);
    this.beginOriginTurn(classified.origin, classified.canCreate);
    this.appWake =
      classified.kind === "captain"
        ? choice
          ? "captain-choice"
          : "captain"
        : classified.kind === "scheduled" &&
            batch.every(
              (row) =>
                row.origin === "scheduled" &&
                row.facts?.kind === "scheduled" &&
                row.facts.captainRequested === true,
            )
          ? "scheduled"
          : "other";
    // WI-13: a parked captain turn keeps its judgment budget; operational
    // wakes run at the low default.
    const thinkingLevel =
      classified.origin === "captain-turn" || retry
        ? FIRSTMATE_CAPTAIN_THINKING_LEVEL
        : FIRSTMATE_OPERATIONAL_THINKING_LEVEL;
    admitted.setThinkingLevel(thinkingLevel);
    const aboutCardId = batch
      .map((row) =>
        row.facts?.kind === "answer-missing"
          ? row.facts.aboutCard?.id
          : aboutCardIdFromRef(row.ref),
      )
      .find(Boolean);
    const unavailable = this.options.knowledge?.availability();
    if (unavailable?.state === "unavailable") {
      if (!this.directionsBlocked) {
        this.options.broadcastEvent({
          type: "firstmate_note",
          text: "Your first mate has paused new work because standing directions could not be read. Your saved work is unchanged.",
        });
        this.directionsBlocked = true;
      }
      return;
    }
    this.directionsBlocked = false;
    const input = this.servedTurn(
      this.contextForTurn(
        undefined,
        undefined,
        aboutCardId,
        undefined,
        captainWordsOf(batch).join("\n"),
      ),
      batch,
    );
    this.options.inbox.markDelivered(batch.map((row) => row.id));
    this.delivery.adopt(batch, (row) => aboutCardIdFromRef(row.ref));
    this.turnAboutCardId = aboutCardId;
    void this.runTurn(
      admitted,
      input,
      thinkingLevel,
      batchImages,
      batch.map((row) => ({ id: row.id, attempts: row.attempts })),
      captainWordsOf(batch),
    );
  }

  /**
   * Arm the coalescing window's re-poke (WI-13). One timer only - the window
   * stays anchored to the first pending wake, so a later wake does not push
   * the drain out. Unref'd so a quiet app can still exit; the clock decides
   * drainability, so this is only the nudge that a lone wake needs when no
   * later wake or tick would otherwise re-drain within the window.
   */
  private scheduleCoalesceDrain(ms: number): void {
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined;
      void this.drainInbox();
    }, ms);
    this.coalesceTimer.unref?.();
  }

  private clearCoalesceTimer(): void {
    if (!this.coalesceTimer) return;
    clearTimeout(this.coalesceTimer);
    this.coalesceTimer = undefined;
  }

  private onSessionEvent(event: SessionEvent): void {
    if (event.type === "context_compacted") {
      this.lastProjectScopesShown = undefined;
      return;
    }
    if (event.type === "input_read") {
      const index = this.pendingReads.findIndex((input) => input.sha === event.textSha256);
      if (!this.running || index < 0) return;
      const [input] = this.pendingReads.splice(index, 1);
      if (!input) return;
      for (const id of input.asks) this.readThisTurn.add(id);
      this.asks.select([...this.readThisTurn].at(-1));
      if (input.asks.includes(this.options.tasks.latestAskId() ?? "")) this.replyFacts = {};
      return;
    }
    // A session's owner-only events other than a turn's close say nothing
    // the agent reads yet, and are never broadcast.
    if (
      event.type === "background_work_changed" ||
      event.type === "request_started" ||
      event.type === "continuation_started" ||
      event.type === "continuation_ended" ||
      event.type === "model_served"
    ) {
      return;
    }
    this.noteActivity();
    this.decisions.noteSessionEvent(event);
    if (event.type === "turn_closed") {
      if (event.text) this.lastTurnText = event.text;
      // The reply line takes the words of the turn's last model request,
      // and only after the newest message was read (./replyLine).
      if (this.running) this.replyFacts.closing = event.text;
      return;
    }
    if (event.type === "tool_start") this.turnTools.push(event.toolName);
    if (event.type !== "turn_failed") {
      this.options.broadcastEvent(event);
    }
    if (event.type === "turn_failed") {
      // A provider-failed turn resolves instead of throwing, so runTurn's
      // catch never sees it - this is that failure's only path to a card
      // (auth decision or retryable error). The flag also tells runTurn to
      // release the inbox batch it delivered.
      this.turnFailed = true;
      this.turnContextOverflow = event.contextOverflow === true;
      if (event.cutOff && this.boundAccountId) {
        this.options.noteCutOff?.(this.boundAccountId, event.cutOff);
      }
      // A cut-off is a designed path: when it pauses the seat, the card the
      // ladder raises for its class speaks for it, in product words, never
      // the client's. One the account does not hold (a spent allowance with
      // no known reset) pauses nothing, so it is an ordinary failure: its
      // card, its feed line, and the honest retry - never invisible and
      // retried.
      const pausing = Boolean(event.cutOff && this.pausesOnCutOff() && this.pausesNow());
      const labeled = {
        ...event,
        error: formatFlagshipError(this.session?.modelRef(), event.error),
        ...(pausing ? { paused: true } : {}),
      };
      this.options.broadcastEvent(labeled);
      this.turnError = labeled.error;
      this.turnFailureKind ??= turnFailureReason(event.error, true);
      this.noteRunaway(event.error);
      if (event.cutOff) this.turnCutOff = event.cutOff;
      if (event.cutOff && this.pausesOnCutOff()) {
        this.turnPausing = pausing;
        if (this.turnPausing) return;
      }
      if (!this.turnContextOverflow || this.contextRecoveryAttempted) {
        this.raiseSessionFailureCard(event.error);
      }
    } else if (event.type === "turn_end" || event.type === "tool_end") {
      if (event.type === "turn_end" && !this.turnFailed) {
        this.runawayStreak = 0;
        this.runawayRefused = false;
      }
      if (event.usage) {
        const model = this.session?.modelRef();
        this.options.recordUsage?.({
          ...(this.boundAccountId ? { accountId: this.boundAccountId } : {}),
          ...(model ? { model } : {}),
          usage: event.usage,
        });
      }
    }
  }

  /** Auth-vs-generic dispatch for every failure channel (create, throw, provider). */
  private raiseSessionFailureCard(message: string): void {
    if (isAuthFailureMessage(message) || message.includes("No signed-in model")) {
      this.options.supervisor.addAuthDecisionCard(AUTH_CARD_ID, "firstmate", this.signInCardBody());
      return;
    }
    this.raiseTurnFailureCard(formatFlagshipError(this.session?.modelRef(), message));
  }

  /**
   * The sign-in card's body, in product words from what the host knows - the
   * seat's provider and connection - and never the failure's own text: Pi's
   * adds its terminal sign-in instructions and paths into the app's files.
   * The raw text stays on the turn's own records (its ask and decision
   * rows). A crewmate's card says it the same way
   * (`CrewSupervisor.signInCardBody`): a custom connection is named, with the
   * way to check it again, since a sign-in is not what it needs. With no
   * provider to name, it lists the ones that can serve Firstmate.
   */
  private signInCardBody(): string {
    const account = this.seatAccount();
    const flagship = this.options.flagship;
    // The session's own provider while it knows one the app offers, else
    // the chosen model's - a Pi session whose custom connection has no
    // runtime reads "unknown", and a create that failed has no session. A
    // dev checkout's local seat is none of them, so it names nothing.
    const candidates: (string | undefined)[] = this.localSeat
      ? []
      : [
          this.session?.modelRef()?.provider,
          this.options.settings.getFirstmateModel()?.provider,
          account ? flagship?.providerOf(account) : undefined,
        ];
    const provider = candidates.find(
      (id) =>
        id !== undefined &&
        (isCustomApiProvider(id) || PROVIDER_CATALOG.some((entry) => entry.id === id)),
    );
    if (provider && isCustomApiProvider(provider)) {
      const label =
        account && flagship?.providerOf(account) === provider
          ? flagship.labelOf(account)
          : undefined;
      const connection = label ? `${label}, your custom connection` : "its custom connection";
      return `Your first mate could not reach ${connection}. In Settings → Intelligence, press Edit on ${label ? "it" : "that connection"}, then Save to check it again.`;
    }
    const name = PROVIDER_CATALOG.find((entry) => entry.id === provider)?.name;
    return name
      ? `Your first mate could not reach ${name}, which needs you to sign in again.`
      : "Your first mate needs a signed-in subscription to answer - Codex, Grok, Claude, Kimi Code or Copilot, or OpenRouter with an API key.";
  }

  private raiseTurnFailureCard(message: string): void {
    // The agent-down set (ruling D6): a host card under a stable id, so
    // repeated failures (a provider outage across several turns) revise
    // one card in place instead of stacking copies.
    const body = this.runawayRefused
      ? `${message}\n\nFirstmate will not try again until you press Retry.`
      : message;
    this.options.supervisor.addFirstmateFailureCard(body);
  }

  /**
   * Last-resort safety net for a pinned reasoning flagship: after repeated
   * max_time_limit / token-generation failures, refuse the next idle turn
   * instead of hanging again. Retry (or a clean turn) clears it. Never
   * changes the captain's chosen default flagship.
   */
  private noteRunaway(error: string): void {
    if (!isRunawayProviderError(error)) {
      this.runawayStreak = 0;
      return;
    }
    this.runawayStreak += 1;
    if (this.runawayStreak >= RUNAWAY_REFUSE_AFTER) {
      this.runawayRefused = true;
    }
  }

  /** Tell the turn's listener how it went; a listener fault never reaches the turn. */
  private settleTurn(outcome: FirstmateTurnOutcome): void {
    try {
      this.options.onTurnSettled?.(outcome);
    } catch (caught) {
      console.warn("[firstmate] turn listener failed:", caught);
    }
  }

  /** Stamp origin and writing authority from the wake. */
  private beginOriginTurn(origin: KnowledgeOrigin, canCreate: boolean): void {
    this.turnOrigin = origin;
    this.turnCanCreate = canCreate;
  }
}

/**
 * The coarse kind of a failed turn, for Diagnostics: a refused sign-in,
 * the provider's time limit, a provider-failed turn, or anything else that
 * threw. Only the kind leaves; the message never does.
 */
export function turnFailureReason(
  error: string | undefined,
  providerFailed: boolean,
): TurnFailureReason {
  // Classified from the raw message: the model-labelled one moves a status
  // code out of the position the auth classifier reads.
  const message = error ?? "";
  if (isAuthFailureMessage(message) || message.includes("No signed-in model")) return "sign_in";
  if (isRunawayProviderError(message)) return "time_limit";
  return providerFailed ? "provider" : "error";
}

function scheduleTextOf(record: import("../storage/scheduleStore").ScheduleRecord): string {
  return record.state === "paused" || record.state === "draft"
    ? `${scheduleText(record.spec)} (${record.state})`
    : scheduleText(record.spec);
}

type OperationDescription = { title: string; repoId?: string | null; projectId?: string };

/** A captain's steer the session accepted: his words, and the card they were about, if any. */
type AcceptedSteer = {
  words: string;
  attachments?: AttachmentRef[];
  aboutCardId?: string;
  askId?: string;
};

/** The operation row a personalize call files, titled by what it did. */
function personalizeTitle(params: Record<string, unknown>): string {
  const action = stringParam(params.action);
  const surface = stringParam(params.surface);
  switch (action) {
    case "theme": {
      const theme = stringParam(params.theme);
      return theme ? `Switched to the ${theme} theme` : "Changed the theme";
    }
    case "panel":
      return `Arranged the ${surface ?? "panel"} surface`;
    case "remove":
      return `Removed the ${surface ?? "panel"} surface`;
    default:
      return "Personalized the app";
  }
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A task title from free text: one line, at most 64 characters. */
function clipTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 64 ? flat : `${flat.slice(0, 63).trimEnd()}…`;
}

/** The status word an index row shows: the record's, or its activity while active. */
/** "just now", "4m ago", "2h ago": an age a context line can carry. */
function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function indexStatus(record: TaskRecord): string {
  if (record.status === "active") return record.activity ?? "active";
  if (record.status === "open") {
    if (record.kind === "decision") return "waiting on you";
    if (record.gate?.kind === "captain") return "waiting on you";
    return "open";
  }
  return record.closedReason ?? record.status;
}

/** Index order: needs-you first, then live before closed, then priority, then recency. */
function indexRank(record: TaskRecord): number {
  const needsYou =
    record.status === "open" && (record.kind === "decision" || record.gate?.kind === "captain");
  if (needsYou) return 0;
  if (record.status === "active") return 1;
  if (record.status === "open") return 2;
  return 3;
}
