/**
 * WI-19 - the replay engine behind `scripts/replay-captain-session.ts`.
 *
 * A captain session is replayed against the CURRENT host code: the real
 * FirstmateAgent (its emit_card lint, ownership rules and ask capture) and
 * the real CrewSupervisor (the whose-turn sort, wake routing, closes,
 * hygiene) run over an in-memory database built by the app's own
 * migrations. Only the MODELS are recorded: every Firstmate turn plays back
 * the tool calls the orchestrator made (crew_status, supervision_log,
 * check_pr_ci and the other read or outside-world tools answer from the
 * recording) and every crewmate turn plays back its recorded session.
 * Nothing reaches a provider, the network, or a real repository.
 *
 * Since S7c there is no recorded triage to play: what a report earns is the
 * whose-turn rule's answer over live state (`reportSort.ts`), so the
 * recording's own verdicts are history, not an input. What the replay
 * measures is exactly what a lint, prompt-wiring, tool or sort change does
 * to the same recorded decisions: a card the lint now refuses is not shown,
 * a wake the host no longer raises is never answered. A recorded answer is
 * matched to the wake the current code produces (same text, else the same
 * kind of wake about the same task); a wake with no recorded answer is
 * played as silence and counted under `fidelity`, never invented.
 *
 * Loaded through Vite's module runner by the CLI (core modules use path
 * aliases plain Node cannot resolve) and imported directly by vitest.
 */

import { isolatedWorkspace, wireIsolatedHost } from "./isolatedHost.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CrewSupervisor,
  CardChoiceUnavailableError,
} from "../../src/core/orchestrator/crewSupervisor.ts";
import {
  type CrewmateSpec,
  crewmateSessionSpec,
} from "../../src/core/orchestrator/crewSession.ts";
import {
  actionTookEffect,
  type DeliveryActionKind,
  type DeliveryNote,
} from "../../src/core/orchestrator/answerDelivery.ts";
import { FirstmateAgent } from "../../src/core/orchestrator/firstmateAgent.ts";
import { appPathsFor } from "../../src/core/paths.ts";
import {
  buildCrewmateSystemPrompt,
  buildFirstmateSystemPrompt,
} from "../../src/core/pi/piResources.ts";
import { PI_CONTROL_PROFILE } from "../../src/core/pi/session.ts";
import type { BoundTool } from "../../src/core/session/tools.ts";
import type { ModelRuntime } from "../../src/core/pi/types.ts";
import type {
  ModelSession,
  SessionEvent,
  SessionFactory,
  SessionSpec,
} from "../../src/core/session/session.ts";
import { CardStore } from "../../src/core/storage/cardStore.ts";
import { openInMemoryDatabase } from "../../src/core/storage/db.ts";
import {
  FIRSTMATE_RECIPIENT,
  InboxStore,
  SUPERVISION_RECIPIENT,
  WAKE_COALESCE_MS,
  wakeIdentity,
} from "../../src/core/storage/inboxStore.ts";
import { SettingsStore } from "../../src/core/storage/settingsStore.ts";
import { DecisionStore } from "../../src/core/storage/decisionStore.ts";
import { CLIENT_NOTICE, readSession } from "../../src/core/storage/sessionReader.ts";
import type { TaskRecord } from "../../src/core/storage/taskStore.ts";
import { type LegacyTaskStatus, seedTask } from "../../src/core/tasks/seedTask.ts";
import { TaskService } from "../../src/core/tasks/taskService.ts";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry.ts";
import {
  type Card,
  type CardAction,
  isPreviewBody,
  migrateLegacyActions,
} from "../../src/shared/cards.ts";
import {
  carriesEvidenceHeadings,
  reportEvidenceHeadings,
  type Rigor,
  rigorRequiresEvidence,
} from "../../src/shared/rigor.ts";
import { legacyShapeFromDifficulty } from "../../src/core/routing/policy.ts";
import { type WorkShape, workShapeSchema } from "../../src/shared/routingPolicy.ts";
import { groupSpawnArgs } from "../../src/core/pi/crewTools.ts";
import { preansweredQuestions, writeInGaps } from "../../src/core/pi/cardLint.ts";
import type { IntelligenceBucket } from "../../src/shared/modelSlots.ts";
import { parseServedInput, type ServedOrigin } from "../../src/shared/servedFrame.ts";
import {
  isCardClosedSteer,
  renderWake,
  type WakeFacts,
} from "../../src/core/orchestrator/wakes.ts";
import { type FmEvent, UNSTATED_TURN_ERROR } from "../../src/shared/events.ts";
import { FIRSTMATE_SESSION_ID } from "../../src/shared/observe.ts";
import {
  cardIdFromEmitResult,
  type DispatchTurn,
  extractTurnsFromJsonl,
  parseContextBlock,
  taskIdFromSpawnResult,
} from "../extract-dispatch-corpus.ts";
import {
  type CardPair,
  duplicatePairs,
  isFakeSettleAction,
  isQuestion,
  looksGarbled,
  type MetricScores,
  type ObservedCard,
  type ObservedDispatch,
  type ObservedQuestion,
  type ObservedReview,
  type ReviewEvent,
  isCompletionCard,
  type ObservedApproval,
  type SessionObservation,
  approvalLabelKey,
  parseApprovalLabels,
  observedReviews,
  overrideHoldsFrom,
  reviewEventFrom,
  scoreSession,
  cardLabelKey,
  parseClearLabels,
  parsePlainLabels,
  parsePrLinkLabels,
} from "../interaction-metrics.ts";
import {
  emptyTables,
  numberColumn,
  type RecordedTables,
  readRecordedTables,
  stringColumn,
  type TableRow,
} from "../recorded-tables.ts";
import {
  type ReplayWindow,
  windowEntries,
  windowJsonlText,
  windowTables,
} from "./window.ts";

// --------------------------------------------------------------------------
// Sources and report
// --------------------------------------------------------------------------

export type ReplaySources = {
  /** The session's name in reports and in the baseline file. */
  name: string;
  /** The Firstmate's rolling session transcripts. */
  orchestratorFiles: string[];
  /** Recorded task id -> that crewmate's session transcripts. */
  crewmateFiles: Record<string, string[]>;
  /**
   * The retired supervision session's transcripts. Still discovered so an
   * existing fixture directory loads unchanged; nothing replays them.
   */
  supervisionFiles: string[];
  /** firstmate.db, or a scrubbed tables.json dump. */
  tablesPath: string | null;
  /** Replay only this stretch of the recording (`--from` / `--to`, `./window.ts`). */
  window?: ReplayWindow | null;
  /**
   * The hand-scored plain-language labels (roadmap 1.5), one row per card
   * read: `tests/fixtures/plain-language/labels.jsonl` by default. A card
   * with no row scores as unknown.
   */
  plainLabels?: string | null;
  /**
   * The hand-labelled captain choices (the plan-to-build handoff), one row
   * per card and action: `tests/fixtures/approval-labels/labels.jsonl` by
   * default. A choice with no row is not scored.
   */
  approvalLabels?: string | null;
};

/**
 * Why a recorded crewmate turn never played: the input it answered never
 * reached it under the current host (`docs/replay-harness.md`, "Crewmate
 * turns").
 */
export type UnplayedCrewReason =
  /** The Firstmate turn whose spawn started the crewmate never played. */
  | "spawn-not-played"
  /** The replay never started the crewmate for any other reason. */
  | "not-started"
  /** It answered the captain's choice on a card the replay never showed. */
  | "card-not-shown"
  /** It answered the captain's thread reply under a card the replay never showed, or one the host refused. */
  | "reply-not-delivered"
  /** It answered a Firstmate steer whose recorded turn never played. */
  | "steer-not-played"
  /** It answered a Firstmate steer whose turn played, but whose words never reached it within ten minutes of its recorded moment. */
  | "steer-not-received"
  /** None of the above: an input the replay never served, with no named cause. */
  | "unserved";

export type SessionReport = {
  session: string;
  /** The window the recording was trimmed to, as ISO times; null for the whole recording. */
  window: { from: string | null; to: string | null } | null;
  provenance: {
    firstmate_prompt_sha: string;
    crewmate_prompt_sha: string;
  };
  /** How much of the recording the current code actually exercised. */
  fidelity: {
    recorded_captain_turns: number;
    replayed_captain_turns: number;
    recorded_op_turns: number;
    played_op_turns: number;
    unrecorded_firstmate_wakes: number;
    crewmate_sessions: number;
    /** Every turn the crewmates' recordings hold, and those the replay played. */
    recorded_crewmate_turns: number;
    played_crewmate_turns: number;
    unrecorded_crewmate_turns: number;
    missing_tools: string[];
    skipped_card_resolutions: number;
    /** The captain's replies in card threads, and those the current host never took. */
    recorded_thread_replies: number;
    skipped_thread_replies: number;
    settle_timeouts: number;
  };
  metrics: MetricScores;
  details: {
    /** Captain turns in playback order, with their recorded timestamps. */
    captain_turn_order: { at: string; user: string }[];
    /** Recorded choices current admission refuses; never force them through. */
    refused_card_choices: string[];
    /** Recorded resolutions that were the emitter's own close_card, by title: never captain inputs. */
    withdrawn_cards: string[];
    /** Recorded resolutions written by task retirement, by title: host output, never choices. */
    retired_cards: string[];
    /** Every recorded crewmate turn the replay never played, by crewmate and turn, and why. */
    unplayed_crewmate_turns: {
      crewmate: string;
      turn: number;
      at: string;
      reason: UnplayedCrewReason;
    }[];
    lock_refusals: { tool: string; task: string | null }[];
    duplicate_pairs: { task: string | null; first: string; second: string; similarity: number }[];
    /** `scored` is false when the recording carries no answer for this wake. */
    escalations: { handled: boolean; scored: boolean; wake: string }[];
    unrecorded_wakes: string[];
    unanswered_questions: string[];
    closed_with_worktree: string[];
    /**
     * Every labelled choice the recording answered, by its recorded card:
     * the plan it was about (its recorded key) and the builders grounded on
     * that plan the answering turn started.
     */
    approvals: {
      card: string;
      choice: string;
      builds: boolean;
      plan: string | null;
      grounded_starts: number;
    }[];
  };
};

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * Tools whose answer comes from the recording instead of running. The
 * replay binds no app dispatcher, so the action catalog's look and change
 * answer as recorded, like the repo tools they replaced, which recordings
 * from before the catalog still name. It binds no preferences writer, plugin
 * installer or knowledge store either: `personalize`, `install_plugin` and
 * the knowledge pair answer as recorded too, and so does the integrations
 * pair, which reaches GitHub through the captain's sign-in. `check_pr_ci` is
 * retired and answers as recorded for the same reason.
 */
const RECORDED_ANSWER_TOOLS = new Set([
  "crew_status",
  "supervision_log",
  "check_pr_ci",
  "locate_project",
  "app_state",
  "app_change",
  "setup_repo",
  "configure_repo",
  "unregister_repo",
  "schedule_prompt",
  "cancel_schedule",
  "personalize",
  "install_plugin",
  "knowledge",
  "record_knowledge",
  "integrations",
  "use_integration",
]);

/** A successful call to one of these is the Firstmate acting on a wake. */
const ACTION_TOOLS = new Set([
  "steer_crewmate",
  "interrupt_crewmate",
  "settle_task",
  "spawn_crewmate",
  "create_task",
  "update_task",
  "link_tasks",
  "recall_decision",
  "close_card",
  "app_change",
]);

/** The answer a recorded revision without one is replayed with. */
const RECORDED_REVISION_ANSWER = "(recorded before a revision carried its answer)";

const SPAWN_TOOLS = new Set(["spawn_crewmate", "create_task"]);

/**
 * The pre-WI-4 claim refusal, as the recording and any regression word it.
 * S7c retired the claim that produced it, so nothing in the current code
 * can say this; the count is the guard that keeps it that way.
 */
const LOCK_REFUSAL = /being triaged by fleet supervision|try again in a moment/i;
const REFUSAL_TEXT =
  /^(refused|could not|cannot|can't|unable|not allowed)\b|answer ownership conflict|being triaged|try again in a moment/i;

/**
 * Whether a played call was the Firstmate acting. A refusal never is, and
 * `app_change` answers its refusals and its Settings handover in words, so
 * only its applied answer - the action and the value it now holds - acts.
 */
function playedAction(name: string, text: string, refused: boolean): boolean {
  if (!ACTION_TOOLS.has(name) || refused) return false;
  if (name !== "app_change") return true;
  try {
    const applied = JSON.parse(text) as unknown;
    return (
      typeof applied === "object" &&
      applied !== null &&
      typeof (applied as JsonRecord).action === "string" &&
      "current" in applied
    );
  } catch {
    return false;
  }
}

/** A recorded answer may be matched to a wake at most this far ahead of it. */
const MATCH_LOOKAHEAD_MS = 10 * 60_000;

/**
 * The two lines a recorded crewmate session shows for a background job: the
 * bash result that hands the job id back, and the `[job]` message its exit
 * arrives as. Between them the host's job registry held that id, which is
 * what the whose-turn rule reads as "provably still moving" (S7c). Both are
 * recorded facts; reading them replaces a registry the replay does not run,
 * and invents nothing.
 */
const JOB_STARTED = /Still running as background job ([0-9a-f]+)/;
const JOB_FINISHED = /background job ([0-9a-f]+) finished/;
const TICK_MS = 60_000;
const SETTLE_LIMIT_MS = 5_000;

// --------------------------------------------------------------------------
// The recording
// --------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

type RecordedCall = {
  name: string;
  args: JsonRecord;
  result: { text: string; isError: boolean } | undefined;
};

export type RecordedFirstmateTurn = {
  at: number;
  kind: "captain" | "op";
  user: string;
  payloads: string[];
  normalized: string[];
  refs: string[];
  calls: RecordedCall[];
  closing: string;
  failed: boolean;
  error: string | null;
  fleet: ReturnType<typeof parseContextBlock> | null;
  consumed: boolean;
};


type CrewPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; args: JsonRecord };

type CrewSegment = {
  at: number;
  user: string;
  messages: { parts: CrewPart[]; error: string | null }[];
  results: Map<string, string>;
};

type CrewRecording = { alias: string; segments: CrewSegment[]; cancelAt: number | null };

type TimelineEvent =
  | { at: number; order: number; type: "captain"; turn: RecordedFirstmateTurn }
  | { at: number; order: number; type: "crew-start"; alias: string }
  | {
      at: number;
      order: number;
      type: "crew-input";
      alias: string;
      segment: number;
      input:
        | { kind: "job"; text: string }
        | { kind: "choice"; title: string; actionId: string }
        | { kind: "other" };
    }
  | { at: number; order: number; type: "crew-cancel"; alias: string }
  | {
      at: number;
      order: number;
      type: "card-resolution";
      cardId: string;
      taskAlias: string | null;
      title: string;
      action: string;
      source: "chrome" | "frame";
    }
  | {
      at: number;
      order: number;
      type: "thread-reply";
      cardId: string;
      taskAlias: string | null;
      title: string | null;
      text: string;
      /** The captain turn the reply was, when it reached the Firstmate. */
      turn: RecordedFirstmateTurn | null;
    };

/**
 * The same wake with host wording appended or trimmed (an answer-owner hint,
 * an overflow note): one normalized text starts with the other.
 */
function samePrefix(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 40 && long.startsWith(short);
}

/**
 * What a current Firstmate prompt carries: the captain's words (null for an
 * operational drain) and the wakes before them. A framed input (R2) is read
 * by its segments; historical text by its delimiters.
 */
export function firstmatePromptParts(text: string): { user: string | null; payloads: string[] } {
  const framed = parseServedInput(text);
  if (framed) {
    const words = framed
      .filter((segment) => segment.kind === "user")
      .map((segment) => segment.body.replace(/^\[user\]\n/, "").trim());
    return {
      user: words.length > 0 ? words.join("\n\n") : null,
      payloads: framed
        .filter((segment) => segment.kind === "wake")
        .map((segment) => segment.body.trim())
        .filter(Boolean),
    };
  }
  const marker = "\n\n[user]\n";
  const userAt = text.lastIndexOf(marker);
  const pre = userAt >= 0 ? text.slice(0, userAt) : text;
  const split = pre.indexOf("\n\n");
  return {
    user: userAt >= 0 ? text.slice(userAt + marker.length).trim() : null,
    payloads: splitPayloads(split >= 0 ? pre.slice(split + 2) : pre),
  };
}

function splitPayloads(text: string): string[] {
  return text
    .split(/\n\n(?=\[fm-op\] )/)
    .map((payload) => payload.trim())
    .filter(Boolean);
}

/** Wording that differs run to run and carries no meaning for matching. */
function normalizeWording(text: string): string {
  return text
    .replace(/crewmate \d+/g, "crewmate")
    .replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, "KEY")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The kind of wake and what it is about, for matching a recorded answer to a
 * wake whose wording the current code changed.
 */
export function wakeRef(payload: string): string {
  const task = (pattern: RegExp) => pattern.exec(payload)?.[1] ?? "";
  // Answer receipts are structured recordings, not prose to classify. Match the
  // same task/choice even when the live renderer adds a recovery instruction.
  if (payload.startsWith("[fm-op] {")) {
    try {
      const receipt = JSON.parse(payload.slice("[fm-op] ".length));
      if (receipt.event === "answer_task_closed" && typeof receipt.task?.id === "string" && typeof receipt.choice?.id === "string")
        return `answer-closed:${receipt.task.id}:${receipt.choice.id}`;
    } catch {}
  }
  if (/^\[fm-op\] fleet event escalated to you/.test(payload)) {
    return `escalated:${task(/escalated to you \(task ([^)\s]+)\)/)}`;
  }
  if (/ reported on task /.test(payload)) return `reported:${task(/reported on task (\S+)/)}`;
  if (/'s turn on task \S+ .* failed:/s.test(payload)) {
    return `turn-failed:${task(/turn on task (\S+)/)}`;
  }
  if (/ was interrupted on task /.test(payload)) {
    return `interrupted:${task(/interrupted on task (\S+)/)}`;
  }
  if (/filed a follow-up while working on task/.test(payload)) {
    return `followup:${task(/working on task (\S+)/)}`;
  }
  if (/^\[fm-op\] task \S+ ".*" failed:/s.test(payload)) {
    return `task-failed:${task(/^\[fm-op\] task (\S+)/)}`;
  }
  if (/the user chose/.test(payload)) return `chose:${task(/card "([^"]*)"/)}`;
  if (/dismissed the card/.test(payload)) return `dismissed:${task(/card "([^"]*)"/)}`;
  if (/deferred your card/.test(payload)) return `deferred:${task(/card "([^"]*)"/)}`;
  if (/guidance/.test(payload)) return `guidance:${task(/task (\S+)/)}`;
  if (/\bjob\b/.test(payload)) return `job:${task(/task (\S+)/)}`;
  return "other:";
}

/**
 * Every ref a wake may be matched by, widest last. The one alias S7c needs:
 * before it, a report the Firstmate heard about arrived wearing the retired
 * session's "fleet event escalated to you (task X)" wording, because that
 * session was the only thing that could hand one over. The whose-turn rule
 * hands over the report itself, so the same moment in the same recording
 * reads `reported:X` now and `escalated:X` in the recording. Matching one
 * to the other is the same kind-and-task fallback the engine already uses;
 * it changes no product behaviour and invents no answer.
 */
export function wakeRefAliases(payload: string): string[] {
  return refAliases(wakeRef(payload));
}

function refAliases(ref: string): string[] {
  const reported = /^reported:(.+)$/.exec(ref);
  return reported ? [ref, `escalated:${reported[1]}`] : [ref];
}

/**
 * The kind of a LIVE wake and what it is about, read off its typed facts
 * (the primitives review P6) in the recorded half's vocabulary (`wakeRef`),
 * so a live wake is classified by what the host knew and the recordings,
 * which are text, still by their words. A kind the recordings have no word
 * for has no ref: it matches a recorded answer by its text alone. An
 * outage's first failure is the failed turn a recording of that moment
 * spoke of. `name` puts a live id or title into the recorded half's terms.
 */
export function factsWakeRef(
  facts: WakeFacts,
  name: (text: string) => string = (text) => text,
): string | null {
  switch (facts.kind) {
    case "answer-closed":
      return `answer-closed:${name(facts.handoff.task.id)}:${facts.handoff.choice.id}`;
    case "report":
      return `reported:${name(facts.task.id)}`;
    case "turn-failed":
    case "outage-failed":
      return `turn-failed:${name(facts.task.id)}`;
    case "task-failed":
      return `task-failed:${name(facts.task.id)}`;
    case "job-bound":
      return `job:${name(facts.task.id)}`;
    case "guidance-set-aside":
      return `guidance:${name(facts.task.id)}`;
    case "card-choice":
      return `chose:${name(facts.card.title)}`;
    default:
      return null;
  }
}

/**
 * The live wakes whose task a closed record makes a wake after a cancel:
 * a report and a failed turn, as the recorded half's words name them.
 */
const TASK_WAKE_KINDS: ReadonlySet<WakeFacts["kind"]> = new Set([
  "report",
  "turn-failed",
  "outage-failed",
]);

/** One live wake a Firstmate turn was served, with the typed facts of the row it came from. */
type LiveWake = { payload: string; facts: WakeFacts | null; origin: ServedOrigin | null };

function firstmateTurnFrom(turn: DispatchTurn): RecordedFirstmateTurn | null {
  let kind: "captain" | "op";
  let user = "";
  let payloads: string[] = [];
  if (turn.kind === "op" && turn.op) {
    kind = "op";
    payloads = splitPayloads(turn.op);
  } else if (turn.user) {
    kind = "captain";
    user = turn.user;
  } else if (turn.context) {
    // A drained [fm-op] batch rides behind the context block with no [user]
    // marker, so the extractor reads it as an empty captain turn.
    const split = turn.context.indexOf("\n\n");
    if (split < 0) return null;
    kind = "op";
    payloads = splitPayloads(turn.context.slice(split + 2));
  } else {
    return null;
  }
  if (kind === "op" && payloads.length === 0) return null;
  const normalized = payloads.map(normalizeWording);
  return {
    at: turn.at,
    kind,
    user,
    payloads,
    normalized,
    refs: normalized.map(wakeRef),
    calls: turn.calls.map((call) => ({ name: call.name, args: call.args, result: call.result })),
    closing: turn.assistant.trim().split("\n").pop() ?? "",
    failed: turn.turnFailed,
    error: turn.error,
    fleet: turn.fleet,
    consumed: false,
  };
}

function timestampOf(entry: JsonRecord): number {
  const value = entry.timestamp;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as JsonRecord).type === "text"
        ? String((part as JsonRecord).text ?? "")
        : "",
    )
    .join("");
}

/**
 * The Firstmate's recorded turns across its session files, in recorded
 * order: the captain's turns and the operational drains. Every file is read
 * through the one session reader, so a Claude-served session
 * replays exactly as a Pi one holding the same turns.
 */
export function readFirstmateRecording(
  files: string[],
  window: ReplayWindow | null = null,
): { captain: RecordedFirstmateTurn[]; op: RecordedFirstmateTurn[] } {
  const captain: RecordedFirstmateTurn[] = [];
  const op: RecordedFirstmateTurn[] = [];
  for (const file of [...files].sort()) {
    const text = windowJsonlText(readSession(file).text, window);
    for (const turn of extractTurnsFromJsonl(text, file)) {
      const recorded = firstmateTurnFrom(turn);
      if (!recorded) continue;
      (recorded.kind === "captain" ? captain : op).push(recorded);
    }
  }
  captain.sort((a, b) => a.at - b.at);
  op.sort((a, b) => a.at - b.at);
  return { captain, op };
}

export function readCrewRecording(
  alias: string,
  files: string[],
  window: ReplayWindow | null = null,
): CrewRecording {
  const segments: CrewSegment[] = [];
  let cancelAt: number | null = null;
  for (const file of [...files].sort()) {
    // Through the one session reader, so a Claude-served crewmate's copy
    // plays exactly as a Pi one holding the same turns.
    const read = readSession(file);
    const entries = window
      ? windowEntries(read.text, window).map((item) => item.entry)
      : read.entries;
    for (const entry of entries) {
      if (entry.type === "replay_control" && entry.action === "cancel") {
        cancelAt = timestampOf(entry);
        continue;
      }
      if (entry.type !== "message") continue;
      const message = entry.message as JsonRecord | undefined;
      if (!message) continue;
      // A Claude client's own notice (one of its background commands
      // finished) was served by nobody: the turn carried on by itself, so
      // it plays as the running segment rather than waiting for an input
      // the host never gave.
      if (message.role === "user" && message.commandMode === CLIENT_NOTICE && segments.length > 0) {
        continue;
      }
      if (message.role === "user") {
        segments.push({
          at: timestampOf(entry),
          user: textOf(message.content),
          messages: [],
          results: new Map(),
        });
        continue;
      }
      const segment = segments.at(-1);
      if (!segment) continue;
      if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        segment.results.set(message.toolCallId, textOf(message.content));
        continue;
      }
      if (message.role !== "assistant") continue;
      const parts: CrewPart[] = [];
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const typed = part as JsonRecord;
        if (typed.type === "text" && typeof typed.text === "string") {
          parts.push({ type: "text", text: typed.text });
        } else if (typed.type === "toolCall" && typeof typed.name === "string") {
          parts.push({
            type: "toolCall",
            id: typeof typed.id === "string" ? typed.id : "",
            name: typed.name,
            args: (typed.arguments as JsonRecord) ?? {},
          });
        }
      }
      segment.messages.push({
        parts,
        error:
          message.stopReason === "error"
            ? typeof message.errorMessage === "string"
              ? message.errorMessage
              : "error"
            : null,
      });
    }
  }
  return { alias, segments, cancelAt };
}


// --------------------------------------------------------------------------
// The virtual clock: recorded time, advancing in real time between events
// --------------------------------------------------------------------------

class ReplayClock {
  private readonly realNow = Date.now;
  private offset = 0;
  private installed = false;

  now = (): number => this.realNow.call(Date) + this.offset;

  install(at: number): void {
    this.offset = at - this.realNow.call(Date);
    Date.now = this.now;
    this.installed = true;
  }

  /** Never backwards: real work between events keeps the clock moving. */
  advanceTo(at: number): void {
    if (at > this.now()) this.offset = at - this.realNow.call(Date);
  }

  restore(): void {
    if (this.installed) Date.now = this.realNow;
    this.installed = false;
  }
}

const realSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------
// The replay
// --------------------------------------------------------------------------

type PlayedTurn = {
  cardsShown: string[];
  actions: number;
  spawned: boolean;
  /** What the recording shows took effect (or was refused) after the captain's message, in order. */
  delivery: DeliveryNote[];
};

/**
 * What a recorded call's own answer says happened, for the answer-delivery
 * row. Read off the recording, never the replay: the replay re-runs today's
 * tools, so a refusal the host no longer makes would otherwise hide the
 * message that went unanswered that night. A lookup, or a call the recording
 * holds no answer for, says nothing.
 */
const RECORDED_ACTION: Record<string, { kind: DeliveryActionKind; ok: (text: string) => boolean }> = {
  emit_card: { kind: "card", ok: (text) => text.startsWith("Card shown") },
  close_card: { kind: "close", ok: (text) => text.startsWith("Closed card") },
  emote: { kind: "reaction", ok: () => true },
  spawn_crewmate: { kind: "work", ok: (text) => text.startsWith("Commissioned") },
  steer_crewmate: { kind: "work", ok: (text) => text.startsWith("Steered") },
  interrupt_crewmate: { kind: "work", ok: () => true },
  settle_task: { kind: "work", ok: (text) => !/^(PR merge blocked|Cannot )/.test(text) },
  create_task: { kind: "record", ok: (text) => text.startsWith("Planned") },
  update_task: { kind: "record", ok: (text) => /^(Updated|Dropped|Started)/.test(text) },
  link_tasks: { kind: "record", ok: () => true },
  schedule_prompt: { kind: "record", ok: () => true },
  cancel_schedule: { kind: "record", ok: () => true },
  remember: { kind: "record", ok: () => true },
  forget: { kind: "record", ok: () => true },
  // Only a write that changed the collection acts; a refusal or a repeated
  // request answers in other words.
  record_knowledge: {
    kind: "record",
    ok: (text) => /^(Recorded|Revised|Assessed|Linked|Retired) /.test(text),
  },
  app_change: { kind: "record", ok: () => true },
  personalize: { kind: "record", ok: () => true },
  install_plugin: { kind: "record", ok: () => true },
  setup_repo: { kind: "record", ok: () => true },
  configure_repo: { kind: "record", ok: () => true },
  unregister_repo: { kind: "record", ok: () => true },
  flag_missed_escalation: { kind: "record", ok: () => true },
  flag_duplicate: { kind: "record", ok: () => true },
};

function recordedDelivery(
  name: string,
  result: { text: string; isError: boolean } | undefined,
): DeliveryNote | null {
  const action = RECORDED_ACTION[name];
  if (!action || !result) return null;
  if (!result.isError && action.ok(result.text)) {
    return { outcome: "action", kind: action.kind, tool: name };
  }
  return name === "emit_card"
    ? { outcome: "refused", tool: name, reason: "card-refused" }
    : null;
}

function withdrawalKey(cardId: string, reason: string): string {
  return `${cardId}\u0000${reason}`;
}

/**
 * Every close_card the recording shows its emitter making, Firstmate's or a
 * crewmate's, keyed by card id and reason. The host stores that reason as
 * the card's `chosen_action` (`closed` when none was given), so a resolution
 * matching one of these is the emitter's own withdrawal, never the
 * captain's choice. Only a call whose recorded answer closed the card
 * counts; one answered "already closed" withdrew nothing.
 */
function recordedWithdrawals(
  turns: readonly RecordedFirstmateTurn[],
  crew: Iterable<CrewRecording>,
): Set<string> {
  const closed = (text: string | undefined) =>
    text !== undefined && RECORDED_ACTION.close_card?.ok(text) === true;
  const keys = new Set<string>();
  const note = (args: JsonRecord) => {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (typeof args.card_id === "string" && reason) keys.add(withdrawalKey(args.card_id, reason));
  };
  for (const turn of turns) {
    for (const call of turn.calls) {
      if (call.name === "close_card" && !call.result?.isError && closed(call.result?.text)) {
        note(call.args);
      }
    }
  }
  for (const recording of crew) {
    for (const segment of recording.segments) {
      for (const message of segment.messages) {
        for (const part of message.parts) {
          if (part.type !== "toolCall" || part.name !== "close_card") continue;
          if (closed(segment.results.get(part.id))) note(part.args);
        }
      }
    }
  }
  return keys;
}

/**
 * retireTaskCards writes the task's close reason into chosen_action. The
 * card must already exist when its own task closes, and resolve no earlier
 * than that close. A declared action remains a possible captain choice,
 * even when its id happens to equal the close reason; incomplete evidence
 * likewise stays on the ordinary admission path.
 */
function recordedRetirement(card: TableRow, task: TableRow | undefined): boolean {
  if (!task || (task.status !== "done" && task.status !== "dropped")) return false;
  const reason = stringColumn(task, "closed_reason");
  const closedAt = numberColumn(task, "closed_at");
  const createdAt = numberColumn(card, "created_at");
  const resolvedAt = numberColumn(card, "resolved_at");
  if (
    !reason ||
    stringColumn(card, "chosen_action") !== reason ||
    closedAt === null ||
    createdAt === null ||
    resolvedAt === null ||
    createdAt > closedAt ||
    resolvedAt < closedAt
  )
    return false;
  const actions = JSON.parse(stringColumn(card, "actions_json") ?? "[]") as { id: string }[];
  return !actions.some((action) => action.id === reason);
}

/** A labelled choice a turn is about to answer, with what was started before it. */
type PendingApproval = {
  card: string;
  choice: string;
  builds: boolean;
  plan: string | null;
  before: Set<string>;
};

type CrewState = {
  alias: string | null;
  taskId: string;
  recording: CrewRecording | undefined;
  cursor: number;
  /** Guidance steered into the running turn, in order: each plays the recorded turn that answered it. */
  injected: string[];
  streaming: boolean;
  listeners: Set<(event: SessionEvent) => void>;
};

/**
 * A steer telling the crewmate the captain closed its card, served where its
 * recording's next turn answers something else: recordings from before
 * FI3-435 never saw the host tell a card's author of its close.
 */
function unrecordedClose(text: string, state: CrewState): boolean {
  if (!isCardClosedSteer(text)) return false;
  const next = state.recording?.segments[state.cursor];
  return !next || !isCardClosedSteer(next.user);
}

/**
 * The background-job notice a recorded crewmate input carries: the whole
 * input, or its tail where the host batched it behind another input with a
 * blank line between. The current host serves the notice on its own.
 */
function jobNotice(text: string): string | null {
  if (text.startsWith("[job]")) return text;
  const at = text.indexOf("\n\n[job] ");
  return at >= 0 ? text.slice(at + 2) : null;
}

/** The host's words for a captain's choice on a crewmate's card, as recorded: the card's title and the action. */
const RECORDED_CHOICE = /^Card "(.*)": the user chose "(.*)" \((\S+)\)\.$/s;

/** A Firstmate steer the recording holds, to one crewmate, in the words it was served. */
type RecordedSteer = { words: string; turn: RecordedFirstmateTurn; delivered: boolean };

class Replay {
  private readonly clock = new ReplayClock();
  private readonly dir = mkdtempSync(join(tmpdir(), "infinitary-replay-"));
  private readonly db = openInMemoryDatabase();
  private readonly tasks = new TaskService({ db: this.db, strict: true });
  private readonly paths = appPathsFor(this.dir);
  private readonly repos = new RepoRegistry(this.db, this.paths.fleetDir);
  private readonly inbox = new InboxStore(this.db);
  private readonly ledger = new DecisionStore(this.db);
  private readonly settings = new SettingsStore(this.db);
  private supervisor!: CrewSupervisor;
  private firstmate!: FirstmateAgent;
  /**
   * The wakes the whose-turn rule escalated this run (S7c). The rule's
   * `captain` verdict IS the escalation now - the retired session's
   * "fleet event escalated to you" prefix has no writer - so the op-turn
   * loop scores a payload as an escalation when the rule recorded it.
   */
  /** A `captain` sort's wake with no typed facts, by its words. */
  private readonly ruleEscalations = new Set<string>();
  /** A `captain` sort's typed wake, by its identity (P6): what the Firstmate is served is that row. */
  private readonly escalatedWakes = new Set<string>();
  /** Jobs the recording says were running, per task: the registry, replayed. */
  private readonly runningJobs = new Map<string, Set<string>>();

  private readonly toReplay = new Map<string, string>();
  /** The task rows that existed before the session, seeded rather than commissioned. */
  private readonly seeded = new Set<string>();
  private readonly toRecorded = new Map<string, string>();
  private readonly crewCardIds = new Set<string>();
  private readonly crewStates = new Map<string, CrewState>();
  /** Each crewmate as the host started it, by task id: the callbacks its recorded tool calls play into. */
  private readonly crewmates = new Map<string, CrewmateSpec>();
  private pendingSpawnAlias: string | null = null;
  private inflight = 0;

  private readonly captainTurns: RecordedFirstmateTurn[] = [];
  private readonly cardChoiceTurns = new Set<RecordedFirstmateTurn>();
  /** Captain turns that were replies in a Firstmate card's thread: their reply plays them. */
  private readonly threadReplyTurns = new Set<RecordedFirstmateTurn>();
  /** Recorded resolutions that were their emitter's own withdrawal, by title. */
  private readonly withdrawnCards: string[] = [];
  private readonly retiredCards: string[] = [];
  /** The crewmates' recorded turns the replay played. */
  private readonly playedCrewSegments = new Set<CrewSegment>();
  /** The Firstmate's recorded steers, by the crewmate each went to. */
  private readonly recordedSteers = new Map<string, RecordedSteer[]>();
  /** Each recorded crewmate's served words the recording holds, read once (`heldInputs`). */
  private readonly heldWords = new Map<string, Set<string>>();
  /** The recorded Firstmate turn whose spawn started each crewmate, by its recorded task id. */
  private readonly spawnTurns = new Map<string, RecordedFirstmateTurn>();
  /** The captain's thread replies the replay never delivered, with the crewmate whose card they were under. */
  private readonly skippedReplies: { taskAlias: string | null; text: string }[] = [];
  /** The recording's first moment: rows created before it are the state the replay starts from. */
  private begins = Number.POSITIVE_INFINITY;
  private readonly opTurns: RecordedFirstmateTurn[] = [];
  private readonly captainPlays = new Map<RecordedFirstmateTurn, PlayedTurn>();
  private readonly captainTurnOrder: RecordedFirstmateTurn[] = [];
  private readonly pendingCaptainSteers: string[] = [];
  private crew = new Map<string, CrewRecording>();
  private tables!: RecordedTables;

  private readonly fidelity: SessionReport["fidelity"] = {
    recorded_captain_turns: 0,
    replayed_captain_turns: 0,
    recorded_op_turns: 0,
    played_op_turns: 0,
    unrecorded_firstmate_wakes: 0,
    crewmate_sessions: 0,
    recorded_crewmate_turns: 0,
    played_crewmate_turns: 0,
    unrecorded_crewmate_turns: 0,
    missing_tools: [],
    skipped_card_resolutions: 0,
    recorded_thread_replies: 0,
    skipped_thread_replies: 0,
    settle_timeouts: 0,
  };
  private readonly observed = {
    opWakes: 0,
    guidanceQueuedWakes: 0,
    wakesAfterCancel: 0,
    spawnStartFailures: 0,
    escalations: [] as { handled: boolean; scored: boolean; wake: string }[],
    lockRefusals: [] as { tool: string; task: string | null }[],
    unrecordedWakes: [] as string[],
    approvals: [] as (ObservedApproval & { card: string; choice: string; plan: string | null })[],
  };

  constructor(private readonly sources: ReplaySources) {}

  async run(): Promise<SessionReport> {
    this.load();
    const timeline = this.timeline();
    const startAt = timeline[0]?.at ?? 0;
    this.clock.install(startAt);
    try {
      this.wire();
      await this.seedBefore(Math.min(startAt, this.begins));
      await this.supervisor.reconcileFleetHygiene();
      await this.settle();
      let lastTick = startAt;
      for (const event of timeline) {
        this.clock.advanceTo(event.at);
        if (this.clock.now() - lastTick >= TICK_MS) {
          lastTick = this.clock.now();
          await this.tick();
        }
        await this.apply(event);
        await this.settle();
      }
      await this.flush();
      return this.report();
    } finally {
      this.firstmate?.dispose();
      this.supervisor?.disposeAll();
      this.clock.restore();
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  // ---- loading -----------------------------------------------------------

  private load(): void {
    const window = this.sources.window ?? null;
    this.tables = windowTables(
      this.sources.tablesPath ? readRecordedTables(this.sources.tablesPath) : emptyTables(),
      window,
    );
    const recording = readFirstmateRecording(this.sources.orchestratorFiles, window);
    this.captainTurns.push(...recording.captain);
    this.opTurns.push(...recording.op);
    this.fidelity.recorded_captain_turns = this.captainTurns.length;
    this.fidelity.recorded_op_turns = this.opTurns.length;
    for (const [alias, files] of Object.entries(this.sources.crewmateFiles)) {
      this.crew.set(alias, readCrewRecording(alias, files, window));
    }
    this.fidelity.crewmate_sessions = this.crew.size;
    this.fidelity.recorded_crewmate_turns = [...this.crew.values()].reduce(
      (sum, recording) => sum + recording.segments.length,
      0,
    );
  }

  /** Every input the captain or the outside world gave, in recorded order. */
  private timeline(): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    let order = 0;
    const spawned = new Set<string>();
    for (const turn of [...this.captainTurns, ...this.opTurns]) {
      for (const call of turn.calls) {
        if (call.name === "steer_crewmate") this.noteSteer(call, turn);
        if (!SPAWN_TOOLS.has(call.name) || !call.result) continue;
        const id = taskIdFromSpawnResult(call.result.text);
        if (!id) continue;
        spawned.add(id);
        if (!this.spawnTurns.has(id)) this.spawnTurns.set(id, turn);
      }
    }
    const resolvedByTable = new Set<string>();
    const withdrawals = recordedWithdrawals(
      [...this.captainTurns, ...this.opTurns],
      this.crew.values(),
    );
    const recordedTasks = new Map(this.tables.tasks.map((row) => [stringColumn(row, "id"), row]));
    for (const row of this.tables.cards) {
      const id = stringColumn(row, "id");
      const resolvedAt = numberColumn(row, "resolved_at");
      const resolution = stringColumn(row, "chosen_action");
      if (!id || resolvedAt === null || !resolution) continue;
      const title = stringColumn(row, "title") ?? "";
      // The emitter's own close_card is not the captain's input: it plays
      // when its recorded call does. Its row holds the call's reason, or
      // `closed` without one; only the recorded call tells that reason from
      // an action id (FI3-287).
      if (resolution === "closed" || withdrawals.has(withdrawalKey(id, resolution))) {
        this.withdrawnCards.push(title);
        continue;
      }
      const taskAlias = stringColumn(row, "task_id");
      // A settled task's retirement is host output, not a second captain
      // input. The recorded close facts prove it even without tool evidence
      // on the card itself (FI3-989).
      if (taskAlias && recordedRetirement(row, recordedTasks.get(taskAlias))) {
        this.retiredCards.push(title);
        continue;
      }
      const source = resolution.startsWith("script:") ? "frame" : "chrome";
      const action = source === "frame" ? resolution.slice("script:".length) : resolution;
      resolvedByTable.add(`${taskAlias ?? ""}|${title}`);
      // A new recording stores the footer click as captain speech. It is
      // replayed by this resolution, not a second converse with its label.
      if (id.startsWith("card-fm-") && action !== "close" && source === "chrome") {
        const actions = JSON.parse(stringColumn(row, "actions_json") ?? "[]") as {
          id: string;
          label: string;
        }[];
        const label = actions.find((entry) => entry.id === action)?.label;
        const turn = this.captainTurns.find(
          (candidate) =>
            label &&
            candidate.user.startsWith(`${label}\nChoice on card "${title}"`) &&
            Math.abs(candidate.at - resolvedAt) <= MATCH_LOOKAHEAD_MS,
        );
        if (turn) this.cardChoiceTurns.add(turn);
      }
      events.push({
        at: resolvedAt,
        order: order++,
        type: "card-resolution",
        cardId: id,
        taskAlias,
        title,
        action,
        source,
      });
    }
    for (const row of this.tables.card_messages) {
      const cardId = stringColumn(row, "card_id");
      const at = numberColumn(row, "at");
      const text = stringColumn(row, "text")?.trim();
      // Only the captain's lines are inputs: the author's answer and the
      // host's "revised" line are what the replay is about to produce.
      if (stringColumn(row, "who") !== "captain" || !cardId || at === null || !text) continue;
      const card = this.tables.cards.find((candidate) => stringColumn(candidate, "id") === cardId);
      // A reply that reached the Firstmate was a captain turn about the
      // card; the reply plays it, so it is not a second converse.
      const turn = this.captainTurns.find(
        (candidate) =>
          !this.cardChoiceTurns.has(candidate) &&
          !this.threadReplyTurns.has(candidate) &&
          candidate.user === text &&
          Math.abs(candidate.at - at) <= MATCH_LOOKAHEAD_MS,
      );
      if (turn) this.threadReplyTurns.add(turn);
      this.fidelity.recorded_thread_replies += 1;
      events.push({
        at,
        order: order++,
        type: "thread-reply",
        cardId,
        taskAlias: card ? stringColumn(card, "task_id") : null,
        title: card ? stringColumn(card, "title") : null,
        text,
        turn: turn ?? null,
      });
    }
    for (const turn of this.captainTurns) {
      if (!this.cardChoiceTurns.has(turn) && !this.threadReplyTurns.has(turn))
        events.push({ at: turn.at, order: order++, type: "captain", turn });
    }
    // A row is seeded only when it existed before the recording's first
    // moment (`seedBefore`). One created inside it by a crewmate the replay
    // holds no recording of is never seeded, so its own recorded crewmate
    // is commissioned at its first turn, as a standalone one is.
    this.begins = Math.min(
      ...events.map((event) => event.at),
      ...[...this.crew.values()].flatMap((recording) =>
        recording.segments.slice(0, 1).map((segment) => segment.at),
      ),
    );
    const seeded = new Set(
      this.tables.tasks
        .filter((row) => (numberColumn(row, "created_at") ?? this.begins) < this.begins)
        .map((row) => stringColumn(row, "id")),
    );
    for (const [alias, recording] of this.crew) {
      const first = recording.segments[0];
      if (!first) continue;
      if (!spawned.has(alias)) {
        if (seeded.has(alias) && !this.isStandaloneCrew(alias)) continue;
        events.push({ at: first.at, order: order++, type: "crew-start", alias });
      }
      for (const [index, segment] of recording.segments.entries()) {
        if (index === 0) continue;
        const choice = RECORDED_CHOICE.exec(segment.user);
        const job = jobNotice(segment.user);
        let input: Extract<TimelineEvent, { type: "crew-input" }>["input"] = { kind: "other" };
        if (job) input = { kind: "job", text: job };
        else if (choice && !resolvedByTable.has(`${alias}|${choice[1]}`)) {
          input = { kind: "choice", title: choice[1] ?? "", actionId: choice[3] ?? "" };
        }
        events.push({
          at: segment.at,
          order: order++,
          type: "crew-input",
          alias,
          segment: index,
          input,
        });
      }
      if (recording.cancelAt !== null) {
        events.push({ at: recording.cancelAt, order: order++, type: "crew-cancel", alias });
      }
    }
    return events.sort((a, b) => a.at - b.at || a.order - b.order);
  }

  /**
   * A recorded Firstmate steer, kept by the crewmate it went to: its words,
   * the turn that sent it, and whether its recorded answer says it landed.
   */
  private noteSteer(call: RecordedCall, turn: RecordedFirstmateTurn): void {
    const ref = typeof call.args.task_id === "string" ? call.args.task_id : null;
    const message = typeof call.args.message === "string" ? call.args.message : null;
    if (!ref || !message) return;
    const row = this.tables.tasks.find((task) => stringColumn(task, "key") === ref);
    const alias = (row ? stringColumn(row, "id") : null) ?? ref;
    const steers = this.recordedSteers.get(alias) ?? [];
    steers.push({
      words: normalizeWording(message),
      turn,
      delivered: recordedDelivery(call.name, call.result)?.outcome === "action",
    });
    this.recordedSteers.set(alias, steers);
  }

  /** A crewmate session whose task row the tables also carry but that no spawn names. */
  private isStandaloneCrew(alias: string): boolean {
    const row = this.tables.tasks.find((task) => stringColumn(task, "id") === alias);
    const created = row ? numberColumn(row, "created_at") : null;
    const first = this.crew.get(alias)?.segments[0]?.at ?? 0;
    return created !== null && created >= first - 60_000;
  }

  // ---- wiring the real host ----------------------------------------------

  private wire(): void {
    const workspace = isolatedWorkspace(this.paths, true);
    // The replay's one session factory: a session with the coding set is a
    // crewmate's recorded session, any other the Firstmate's recorded turns.
    const sessions: SessionFactory = {
      backend: "pi",
      controlProfile: PI_CONTROL_PROFILE,
      open: async (spec) =>
        spec.builtins === "coding" ? this.crewmate(spec) : this.firstmateSession(spec.tools),
    };
    const cardStore = new CardStore(this.db);
    const crewOptions: ConstructorParameters<typeof CrewSupervisor>[0] = {
      sessions: { pi: sessions },
      bind: async () => ({ backend: "pi", runtime: {} as ModelRuntime }),
      // The crewmate preset, keeping each crewmate's callbacks for its
      // recorded tool calls to play into.
      sessionSpec: (crewmate, binding) => {
        this.crewmates.set(crewmate.taskId, crewmate);
        return crewmateSessionSpec(this.paths, crewmate, binding);
      },
      workspace,
      repos: this.repos,
      tasks: this.tasks,
      cardStore,
      inbox: this.inbox,
      paths: this.paths,
      mergePullRequest: async () => ({ ok: true, text: "merged (replay)" }),
      hasRunningJobs: (taskId) => (this.runningJobs.get(taskId)?.size ?? 0) > 0,
      // The whose-turn sort's record (S7c), exactly as services.ts wires
      // it, plus the set the escalation metric reads: an escalation is a
      // `captain` verdict now, not a prefix in the wake's wording.
      recordSort: ({ taskId, wake, facts, verdict, summary, rule, wakeKind, effect }) => {
        this.ledger.transaction(() => {
          this.ledger.recordSort({ taskId, wake, facts, verdict, summary, rule, wakeKind });
          effect?.();
        });
        if (verdict !== "captain") return;
        if (facts) this.escalatedWakes.add(wakeIdentity({ facts }, wakeKind));
        else this.ruleEscalations.add(wake);
      },
      broadcastEvent: () => {},
      broadcastCards: () => {},
    };
    const selfSourceDir = join(this.dir, "self-source");
    mkdirSync(selfSourceDir, { recursive: true });
    const seatOptions: Omit<ConstructorParameters<typeof FirstmateAgent>[0], "supervisor"> = {
      paths: this.paths,
      inbox: this.inbox,
      settings: this.settings,
      modelRuntime: {} as ModelRuntime,
      availableModels: () => [{ provider: "replay", id: "recorded" }],
      quotaModels: () => undefined,
      quotaLine: () => "replay",
      repos: this.repos,
      tasks: this.tasks,
      broadcastEvent: () => {},
      selfSourceDir,
      supervisionLog: (limit) => this.ledger.recent(limit),
      flagMissedEscalation: (input) => this.ledger.flagMissedEscalation(input),
      // The captain's duplicate label lands on the replay's own card, as
      // services.ts wires it, so the duplicate metric counts it.
      flagDuplicate: (input) => this.supervisor.flagDuplicate(input),
      seats: { pi: sessions },
    };
    const host = wireIsolatedHost(crewOptions, seatOptions);
    this.supervisor = host.supervisor;
    this.firstmate = host.firstmate;
  }

  /** Repos the recorded context block names, adopted from empty folders under the recorded names. */
  private async ensureRepos(fleet: RecordedFirstmateTurn["fleet"]): Promise<void> {
    for (const repo of fleet?.repos ?? []) {
      if (this.toReplay.has(repo.id)) continue;
      const path = join(this.dir, "repos", repo.name);
      mkdirSync(path, { recursive: true });
      // Where it lived (git integration PR 1.1): every recording predates
      // the forge seam, when a proposed change could only go to GitHub, so
      // a recorded direct-pr project lived there. Give its folder that
      // origin before adopting it, so the host renders what it rendered.
      if (repo.delivery === "direct-pr") {
        execFileSync("git", ["init", "-q", "-b", "main", path]);
        execFileSync("git", [
          "-C",
          path,
          "remote",
          "add",
          "origin",
          `https://github.com/replay/${repo.name}.git`,
        ]);
      }
      const { repo: view } = await this.repos.setup({ kind: "adopt", path, name: repo.name });
      this.repos.configure(view.id, {
        delivery: repo.delivery === "direct-pr" ? "direct-pr" : "local-only",
        autonomy: repo.autonomy,
      });
      this.alias(repo.id, view.id);
    }
  }

  /** Task rows that existed before the session, driven through the one writer. */
  private async seedBefore(startAt: number): Promise<void> {
    const firstFleet = this.captainTurns.find((turn) => turn.fleet)?.fleet ?? null;
    await this.ensureRepos(firstFleet);
    for (const row of this.tables.tasks) {
      const id = stringColumn(row, "id");
      const created = numberColumn(row, "created_at");
      if (!id || created === null || created >= startAt) continue;
      // The tables hold each row as it stood at export. A row whose own
      // start time falls after the replay begins was still waiting then.
      const startedAt = numberColumn(row, "started_at");
      const legacy: ReturnType<typeof legacyStateOf> =
        startedAt !== null && startedAt > startAt
          ? { status: "queued", worktree: false }
          : legacyStateOf(row);
      if (!legacy) continue;
      const repoId = stringColumn(row, "repo_id");
      // How the row starts and the work's declared facts (its basis among
      // them) as the record held them: an on-request row must not start on
      // the replay's first sweep, and a builder planned behind a plan stays
      // grounded on it.
      const startPolicy = stringColumn(row, "start_policy");
      const shape = seededShape(stringColumn(row, "shape_json"));
      seedTask(this.tasks, {
        id,
        title: stringColumn(row, "title") ?? "Recorded task",
        kind: "work",
        status: legacy.status,
        ...(startPolicy === "on-request" ? { startPolicy } : {}),
        ...(shape ? { shape } : {}),
        createdAt: created,
        repoId: repoId ? (this.toReplay.get(repoId) ?? null) : null,
        worktreeDir: legacy.worktree ? join(this.paths.worktreesDir, id) : "",
        branch: legacy.worktree ? `fm/task-${id}` : "",
      });
      this.alias(id, id);
      this.seeded.add(id);
      const key = stringColumn(row, "key");
      const seededKey = this.tasks.get(id)?.key;
      if (key && seededKey) this.alias(key, seededKey);
    }
  }

  private alias(recorded: string, replay: string): void {
    this.toReplay.set(recorded, replay);
    this.toRecorded.set(replay, recorded);
  }

  private aliasTask(recorded: string, replay: string): void {
    this.alias(recorded, replay);
    const recordedKey = this.tables.tasks.find((row) => stringColumn(row, "id") === recorded);
    const key = recordedKey ? stringColumn(recordedKey, "key") : null;
    const replayKey = this.tasks.get(replay)?.key;
    if (key && replayKey) this.alias(key, replayKey);
  }

  /** Recorded ids inside a model's arguments, rewritten to the replay's. */
  private mapArgs(value: unknown): unknown {
    if (typeof value === "string") return this.toReplay.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => this.mapArgs(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, inner]) => [key, this.mapArgs(inner)]),
    );
  }

  /** Replay ids in host text, rewritten to the recorded ones, then wording-normalized. */
  private normalize(text: string): string {
    let out = text;
    for (const [replay, recorded] of this.toRecorded) {
      if (replay === recorded || replay.length < 6) continue;
      out = out.split(replay).join(recorded);
    }
    return normalizeWording(out);
  }

  // ---- the Firstmate's recorded turns ------------------------------------

  private firstmateSession(served: readonly BoundTool[]): ModelSession {
    const tools = new Map(served.map((tool) => [tool.name, tool]));
    const listeners = new Set<(event: SessionEvent) => void>();
    let streaming = false;
    const endTurn = (closing: { text: string; failed: boolean; error: string | null }) => {
      const taskId = FIRSTMATE_SESSION_ID;
      const text = closing.text.trim();
      const events: SessionEvent[] = [
        ...(closing.failed
          ? [{ type: "turn_failed" as const, taskId, error: closing.error || UNSTATED_TURN_ERROR }]
          : []),
        { type: "turn_end", taskId },
        { type: "turn_closed", ...(text ? { text } : {}) },
      ];
      for (const event of events) {
        for (const listener of listeners) listener(event);
      }
    };
    return {
      sessionId: "replay-firstmate",
      controlProfile: PI_CONTROL_PROFILE,
      // The recorded turns are the record: the replay keeps none of its own.
      resume: () => undefined,
      recordPath: () => undefined,
      isStreaming: () => streaming,
      modelRef: () => ({ provider: "replay", id: "recorded" }),
      modelLabel: () => undefined,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: async (text) => {
        streaming = true;
        this.inflight += 1;
        try {
          endTurn(await this.onFirstmatePrompt(text, tools));
          while (this.pendingCaptainSteers.length > 0) {
            const steer = this.pendingCaptainSteers.shift() as string;
            endTurn(await this.onFirstmatePrompt(steer, tools));
          }
        } finally {
          streaming = false;
          this.inflight -= 1;
        }
      },
      steer: async (text) => {
        // The recorded model has already stopped reading. Refuse instead
        // of accepting into a closed prompt: steerRecorded keeps the inbox
        // row pending, and the host drains it when this turn closes.
        if (!streaming) throw new Error("The replay prompt has finished reading steers");
        this.pendingCaptainSteers.push(text);
      },
      // If a prompt exits with unread steers, hand ownership back to the
      // host once instead of keeping them for an unrelated later prompt.
      takeUndeliveredSteers: () => this.pendingCaptainSteers.splice(0),
      // The recorded turns ran at whatever level they ran at, on whatever
      // instructions they were served.
      setThinkingLevel: () => {},
      reasoning: () => undefined,
      serveInstructions: () => {},
      takeRenewal: () => undefined,
      servedState: () => undefined,
      abort: async () => {},
      detach: async () => {},
      dispose: () => {},
      closed: async () => {},
    };
  }

  /**
   * Count the operational wakes a captain turn carried (WI-13): the text
   * before its [user] line holds the pending `[fm-op]` payloads the turn
   * absorbed. They are not a standalone op wake, but an escalation among them
   * still reached the Firstmate, so it is scored like any other - `handled`
   * from this captain turn's own play. The leading context (never `[fm-op]`)
   * is skipped.
   *
   * A live wake is read by its typed facts (P6; `liveWakes`), and only a
   * prose one by its WORDING, which is how the recorded half is read: the
   * recordings are text, carry no stamped origin, and stay text. The facts
   * speak the recorded half's vocabulary (`factsWakeRef`), so the two halves
   * still meet. None of this is origin classification: the product
   * classifies by `ServedOrigin` alone.
   */
  private countCarriedWakes(wakes: LiveWake[], handled: boolean): void {
    for (const wake of wakes) {
      if (!wake.facts && !wake.payload.startsWith("[fm-op]")) continue;
      this.countWakeFacts(wake);
      if (this.isEscalation(wake)) {
        // Carried by a captain turn: that turn's own play IS the answer.
        this.observed.escalations.push({
          handled,
          scored: true,
          wake: excerpt(this.normalize(wake.payload)),
        });
      }
    }
  }

  /**
   * The frustration counters one live wake moves: a guidance-queued wake,
   * and a wake about a task already closed. A typed wake is read by its
   * facts (P6) - no kind the host composes today is a guidance-queued wake
   * - and a prose one by its words, as the recordings are.
   */
  private countWakeFacts(wake: LiveWake): void {
    const { facts, payload } = wake;
    if (!facts && /guidance queued|is being delivered now/i.test(payload)) {
      this.observed.guidanceQueuedWakes += 1;
    }
    const taskId = facts
      ? TASK_WAKE_KINDS.has(facts.kind) && "task" in facts
        ? facts.task.id
        : undefined
      : /escalated to you|reported on task|'s turn on task/.test(payload)
        ? /task ([A-Za-z0-9_-]{6,})/.exec(payload)?.[1]
        : undefined;
    const record = taskId ? this.tasks.get(taskId) : undefined;
    if (record && TaskService.isClosed(record)) this.observed.wakesAfterCancel += 1;
  }

  /**
   * An escalation is a wake the host decided the Firstmate must answer.
   * Two writers, because a replay mixes eras: the whose-turn rule's own
   * `captain` verdict (S7c - the record says so, not the wording), read by
   * the typed wake's identity (P6), and the retired supervision session's
   * prefix, which pre-S7c recordings carry.
   */
  private isEscalation(wake: LiveWake): boolean {
    if (wake.facts) {
      return this.escalatedWakes.has(wakeIdentity({ facts: wake.facts }, wake.origin));
    }
    return (
      this.ruleEscalations.has(wake.payload) ||
      /^\[fm-op\] fleet event escalated to you/.test(wake.payload)
    );
  }

  /**
   * The turn's wakes joined to the rows they were served from - the rows
   * the Firstmate still holds, awaiting their ack - so each is classified
   * by its typed facts (P6). The session hears only the framed text, and a
   * served wake is its row's rendering byte for byte (the one renderer), so
   * the join is by those bytes; a wake no row renders is read by its words.
   */
  private liveWakes(payloads: string[]): LiveWake[] {
    const rows = this.inbox.inFlight(FIRSTMATE_RECIPIENT);
    return payloads.map((payload) => {
      const at = rows.findIndex((row) => renderWake(row).trim() === payload);
      const row = at >= 0 ? rows.splice(at, 1)[0] : undefined;
      return { payload, facts: row?.facts ?? null, origin: row?.origin ?? null };
    });
  }

  /** The refs a live wake may be matched by: its facts' kind and task, else its words'. */
  private liveRefs(wake: LiveWake, normalized: string): string[] {
    if (!wake.facts) return wakeRefAliases(normalized).filter((ref) => !ref.endsWith(":"));
    const ref = factsWakeRef(wake.facts, (text) => this.normalize(text));
    return ref ? refAliases(ref) : [];
  }

  private async onFirstmatePrompt(
    text: string,
    tools: Map<string, BoundTool>,
  ): Promise<{ text: string; failed: boolean; error: string | null }> {
    const parts = firstmatePromptParts(text);
    if (parts.user !== null) {
      const user = parts.user;
      const choiceRow = this.inbox.inFlight(FIRSTMATE_RECIPIENT).find(
        (row) => row.origin === "captain" && row.facts?.kind === "card-choice" &&
          renderWake(row).replace(/^\[user\]\n/, "").trim() === user,
      );
      if (choiceRow?.facts?.kind === "card-choice") {
        const facts = choiceRow.facts;
        const ref = factsWakeRef(facts, (word) => this.normalize(word));
        const turn = [...this.cardChoiceTurns, ...this.opTurns].find(
          (candidate) => !candidate.consumed &&
            (this.cardChoiceTurns.has(candidate)
              ? candidate.user.startsWith(`${facts.choice.label}\nChoice on card "${facts.card.title}"`)
              : ref !== null && candidate.refs.includes(ref)),
        );
        if (!turn) {
          this.fidelity.unrecorded_firstmate_wakes += 1;
          return { text: "", failed: false, error: null };
        }
        turn.consumed = true;
        if (this.cardChoiceTurns.has(turn)) {
          this.fidelity.replayed_captain_turns += 1;
          this.captainTurnOrder.push(turn);
        } else this.fidelity.played_op_turns += 1;
        await this.ensureRepos(turn.fleet);
        const approvals = this.pendingApprovals([facts]);
        await this.playCalls(turn.calls, tools);
        this.settleApprovals(approvals);
        return { text: turn.closing, failed: turn.failed, error: turn.error };
      }
      const turn = this.captainTurns.find((candidate) => !candidate.consumed && candidate.user === user);
      if (!turn) return { text: "", failed: false, error: null };
      turn.consumed = true;
      this.fidelity.replayed_captain_turns += 1;
      this.captainTurnOrder.push(turn);
      await this.ensureRepos(turn.fleet);
      const approvals = this.pendingApprovals(
        this.liveWakes(parts.payloads).map((wake) => wake.facts),
      );
      const play = await this.playCalls(turn.calls, tools);
      this.settleApprovals(approvals);
      this.captainPlays.set(turn, play);
      // The wake diet (WI-13): a captain turn carries the pending operational
      // wakes before its [user] line, so those escalations DID reach the
      // Firstmate - count them as escalations (handled by this turn's play),
      // just not as a standalone op wake. Without this the carry would look
      // like escalations simply vanishing.
      this.countCarriedWakes(
        this.liveWakes(parts.payloads),
        play.cardsShown.length > 0 || play.actions > 0,
      );
      return { text: turn.closing, failed: turn.failed, error: turn.error };
    }

    const wakes = this.liveWakes(parts.payloads);
    const matched: RecordedFirstmateTurn[] = [];
    const answered: (WakeFacts | null)[] = [];
    const escalations: { payload: string; scored: boolean }[] = [];
    // The wake diet (WI-13) is measured in interruptions, not facts: an
    // operational drain that hears several wakes together is ONE wake of the
    // Firstmate, matching the report's "turns on operations" framing. The
    // per-payload loop below still counts every distinct fact (guidance,
    // wakes-after-cancel, escalations) and matches each to its recorded turn.
    if (wakes.length > 0) this.observed.opWakes += 1;
    for (const wake of wakes) {
      const payload = wake.payload;
      this.countWakeFacts(wake);
      const escalated = this.isEscalation(wake);
      const normalized = this.normalize(payload);
      const refs = this.liveRefs(wake, normalized);
      const horizon = Date.now() + MATCH_LOOKAHEAD_MS;
      const open = this.opTurns.filter(
        (turn) => !turn.consumed && !matched.includes(turn) && turn.at <= horizon,
      );
      const found =
        open.find((turn) => turn.normalized.includes(normalized)) ??
        open.find((turn) => turn.normalized.some((text) => samePrefix(text, normalized))) ??
        open.find((turn) => refs.some((ref) => turn.refs.includes(ref)));
      if (found) {
        matched.push(found);
        answered.push(wake.facts);
        if (escalated) escalations.push({ payload, scored: true });
      } else {
        // No recorded answer: the recording cannot say what the Firstmate
        // would have done, so this counts under fidelity and is NOT scored
        // for precision. An unanswerable escalation is unknown, never a
        // failure - the same denominator rule the rigor metrics keep.
        if (escalated) escalations.push({ payload, scored: false });
        this.fidelity.unrecorded_firstmate_wakes += 1;
        this.observed.unrecordedWakes.push(excerpt(normalized));
      }
    }
    let played: PlayedTurn = { cardsShown: [], actions: 0, spawned: false, delivery: [] };
    let closing = { text: "", failed: false, error: null as string | null };
    // A labelled choice among the drained wakes is answered by the turns
    // the drain played; one with no recorded answer stays unknown.
    const approvals = this.pendingApprovals(answered);
    for (const turn of matched.sort((a, b) => a.at - b.at)) {
      turn.consumed = true;
      this.fidelity.played_op_turns += 1;
      await this.ensureRepos(turn.fleet);
      const result = await this.playCalls(turn.calls, tools);
      played = {
        cardsShown: [...played.cardsShown, ...result.cardsShown],
        actions: played.actions + result.actions,
        spawned: played.spawned || result.spawned,
        delivery: [...played.delivery, ...result.delivery],
      };
      closing = { text: turn.closing, failed: turn.failed, error: turn.error };
    }
    this.settleApprovals(approvals);
    const handled = played.cardsShown.length > 0 || played.actions > 0;
    for (const escalation of escalations) {
      this.observed.escalations.push({
        handled: escalation.scored && handled,
        scored: escalation.scored,
        wake: excerpt(this.normalize(escalation.payload)),
      });
    }
    return closing;
  }

  private async playCalls(
    calls: RecordedCall[],
    tools: Map<string, BoundTool>,
  ): Promise<PlayedTurn> {
    const played: PlayedTurn = { cardsShown: [], actions: 0, spawned: false, delivery: [] };
    for (const call of calls) {
      const recordedNote = recordedDelivery(call.name, call.result);
      if (recordedNote) played.delivery.push(recordedNote);
      const args = this.mapArgs(call.args) as JsonRecord;
      // The sessions were recorded under the reserved-id contract; the live
      // tool wants effects (P1), so the ids the host used to dispatch on
      // become the effects they meant.
      if (call.name === "emit_card") {
        if (typeof args.body === "string") args.body = recordedQuestions(args.body, args.actions);
        args.actions = recordedActions(args.actions);
      }
      // The same for a spawn recorded under the pre-v2.8 contract: its
      // judged `difficulty` and `model_id` become the shape facts they
      // meant, so the replay exercises today's tool with what the captain
      // actually asked for.
      if (call.name === "spawn_crewmate") recordedShape(args);
      const recorded = call.result;
      let text: string;
      let isError: boolean;
      if (RECORDED_ANSWER_TOOLS.has(call.name)) {
        text = recorded?.text ?? "";
        isError = recorded?.isError ?? false;
      } else {
        const tool = tools.get(call.name);
        if (!tool) {
          if (!this.fidelity.missing_tools.includes(call.name)) {
            this.fidelity.missing_tools.push(call.name);
          }
          continue;
        }
        if (SPAWN_TOOLS.has(call.name) && recorded) {
          this.pendingSpawnAlias = taskIdFromSpawnResult(recorded.text);
        }
        try {
          text = (await tool.run(args)).text;
          isError = false;
        } catch (caught) {
          text = caught instanceof Error ? caught.message : String(caught);
          isError = true;
        } finally {
          if (SPAWN_TOOLS.has(call.name)) this.pendingSpawnAlias = null;
        }
      }
      if (LOCK_REFUSAL.test(text)) {
        const taskId = typeof args.task_id === "string" ? args.task_id : null;
        this.observed.lockRefusals.push({
          tool: call.name,
          task: taskId ? (this.toRecorded.get(taskId) ?? taskId) : null,
        });
      }
      const refused = isError || REFUSAL_TEXT.test(text.slice(0, 240));
      if (call.name === "emit_card" && !isError) {
        const shown = cardIdFromEmitResult(text);
        const was = recorded ? cardIdFromEmitResult(recorded.text) : null;
        if (shown) {
          played.cardsShown.push(shown);
          if (was) this.alias(was, shown);
        }
      }
      if (SPAWN_TOOLS.has(call.name)) {
        const was = recorded ? taskIdFromSpawnResult(recorded.text) : null;
        const now = refused ? null : taskIdFromSpawnResult(text);
        if (was && now) this.aliasTask(was, now);
        if (now) played.spawned = true;
        if (call.name === "spawn_crewmate" && (refused || /could not start/i.test(text))) {
          this.observed.spawnStartFailures += 1;
        }
      }
      if (playedAction(call.name, text, refused)) played.actions += 1;
    }
    return played;
  }


  // ---- the plan-to-build handoff -----------------------------------------

  private approvalLabelMap: Map<string, boolean> | null = null;

  /** The hand labels, read once per engine; an unreadable file is a loud failure, never an empty sample. */
  private approvalLabels(): Map<string, boolean> {
    if (this.approvalLabelMap) return this.approvalLabelMap;
    const file = this.sources.approvalLabels ?? null;
    this.approvalLabelMap = file ? parseApprovalLabels(readFileSync(file, "utf8")) : new Map();
    return this.approvalLabelMap;
  }

  /**
   * The labelled choices among the wakes a turn answers: an answer task the
   * captain's choice closed, or a choice returned to the Firstmate on a card
   * of its own. The card, the choice and the task are the wake's typed
   * facts; whether the choice authorized a build is the label's, never the
   * card's words. What was started before the turn is taken now.
   */
  private pendingApprovals(facts: (WakeFacts | null)[]): PendingApproval[] {
    const pending: PendingApproval[] = [];
    for (const fact of facts) {
      const choice =
        fact?.kind === "answer-closed"
          ? { card: fact.handoff.card.id, id: fact.handoff.choice.id, task: fact.handoff.task.id }
          : fact?.kind === "card-choice" && fact.card.id
            ? { card: fact.card.id, id: fact.choice.id, task: fact.card.taskId ?? null }
            : null;
      if (!choice) continue;
      const card = this.toRecorded.get(choice.card) ?? choice.card;
      const builds = this.approvalLabels().get(approvalLabelKey(card, choice.id));
      if (builds === undefined) continue;
      const plan = this.planOf(choice.task);
      pending.push({ card, choice: choice.id, builds, plan, before: this.groundedStarted(plan) });
    }
    return pending;
  }

  /**
   * The plan a choice is about: the task it closed, or - on a builder's own
   * card - the basis that builder is grounded on.
   */
  private planOf(taskId: string | null): string | null {
    const record = taskId ? this.tasks.get(taskId) : undefined;
    if (!record) return null;
    const basis = record.shape?.basis;
    return basis ? (this.tasks.resolve(basis)?.id ?? null) : record.id;
  }

  /** The started builders grounded on a plan, as the record holds them. */
  private groundedStarted(plan: string | null): Set<string> {
    if (!plan) return new Set();
    return new Set(
      this.tasks
        .list()
        .filter((record) => {
          const basis = record.shape?.basis;
          return Boolean(basis) && record.startedAt !== null && this.tasks.resolve(basis as string)?.id === plan;
        })
        .map((record) => record.id),
    );
  }

  /** What each answered choice started, now that its turn has played. */
  private settleApprovals(pending: PendingApproval[]): void {
    for (const approval of pending) {
      const after = this.groundedStarted(approval.plan);
      const key = approval.plan ? this.tasks.get(approval.plan)?.key : undefined;
      this.observed.approvals.push({
        card: approval.card,
        choice: approval.choice,
        builds: approval.builds,
        plan: key ? (this.toRecorded.get(key) ?? key) : approval.plan,
        groundedStarts: [...after].filter((id) => !approval.before.has(id)).length,
      });
    }
  }

  // ---- crewmates' recorded sessions --------------------------------------

  private crewmate(session: SessionSpec): ModelSession {
    const spec = this.crewmates.get(session.owner);
    if (!spec) throw new Error(`the replay opened no crewmate ${session.owner}`);
    const alias = this.toRecorded.get(spec.taskId) ?? this.pendingSpawnAlias;
    if (alias && !this.toReplay.has(alias)) this.aliasTask(alias, spec.taskId);
    const state: CrewState = {
      alias,
      taskId: spec.taskId,
      recording: alias ? this.crew.get(alias) : undefined,
      cursor: 0,
      injected: [],
      streaming: false,
      listeners: new Set(),
    };
    if (alias) this.crewStates.set(alias, state);
    const emit = (event: FmEvent) => {
      for (const listener of state.listeners) listener(event);
    };
    return {
      sessionId: `replay-crewmate-${alias ?? spec.taskId}`,
      controlProfile: PI_CONTROL_PROFILE,
      // The recordings are the record: the replay keeps none of its own.
      resume: () => undefined,
      recordPath: () => undefined,
      isStreaming: () => state.streaming,
      modelRef: () => ({ provider: "replay", id: "recorded" }),
      modelLabel: () => undefined,
      subscribe: (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      prompt: (text) => this.playCrewTurn(state, spec, emit, text),
      steer: async (text) => {
        // Guidance into a running turn: the recording's turn that answered it
        // is the same turn continuing, not a new prompt (`playCrewTurn`).
        if (state.streaming) state.injected.push(text);
      },
      // A steer during a recorded turn is played as that turn continuing.
      takeUndeliveredSteers: () => [],
      // The recorded turns ran at whatever level and on whatever prompt they ran.
      setThinkingLevel: () => {},
      reasoning: () => undefined,
      serveInstructions: () => {},
      takeRenewal: () => undefined,
      servedState: () => undefined,
      abort: async () => {},
      detach: async () => {},
      dispose: () => {},
      closed: async () => {},
    };
  }

  private playCrewTurn(
    state: CrewState,
    spec: CrewmateSpec,
    emit: (event: FmEvent) => void,
    text = "",
  ): Promise<void> {
    this.inflight += 1;
    state.streaming = true;
    return new Promise((resolve) => {
      setTimeout(() => {
        void (async () => {
          try {
            const first = this.answering(state, text);
            // Words the recording holds no answer to from here - a close a
            // recording from before FI3-435 never saw, a steer it refused -
            // are a silent turn, never the crewmate's recorded answer to
            // something else.
            if (!first) {
              this.fidelity.unrecorded_crewmate_turns += 1;
              emit({ type: "turn_end", taskId: state.taskId });
              return;
            }
            this.playCrewSegment(first, state, spec, emit);
            for (let steer = state.injected.shift(); steer !== undefined; steer = state.injected.shift()) {
              const next = this.answering(state, steer);
              if (next) this.playCrewSegment(next, state, spec, emit);
            }
          } finally {
            state.streaming = false;
            state.injected = [];
            this.inflight -= 1;
            resolve();
          }
        })();
      }, 0);
    });
  }

  /**
   * The recorded turn that answers what the host just served a crewmate,
   * with its cursor moved on; null when the recording holds no answer.
   *
   * Served words are answered by the turn not yet played whose input holds
   * the same words, within ten minutes of when the recording shows it, as a
   * wake is matched to its recorded answer. A steer reaches the replay as
   * its Firstmate turn begins, a moment before the crewmate's recording
   * shows it, so that turn plays, and the turns before it whose moment has
   * gone by waited on inputs the current host never served. One that
   * arrives late still plays the turn that answered it. Words the recording
   * holds no answer to from here - a steer it refused, an input whose turn
   * has played - and a close a recording from before FI3-435 never saw play
   * nothing. Anything else (a brief, a choice in today's words) is the next
   * recorded turn, as before.
   */
  private answering(state: CrewState, text: string): CrewSegment | null {
    const segments = state.recording?.segments ?? [];
    const played = (index: number) =>
      this.playedCrewSegments.has(segments[index] as CrewSegment);
    while (state.cursor < segments.length && played(state.cursor)) state.cursor += 1;
    const words = this.normalize(text);
    const now = Date.now();
    const holds = (index: number) => {
      const segment = segments[index] as CrewSegment;
      return (
        !played(index) &&
        Math.abs(segment.at - now) <= MATCH_LOOKAHEAD_MS &&
        normalizeWording(segment.user) === words
      );
    };
    for (let index = state.cursor; index < segments.length; index += 1) {
      if (!holds(index)) continue;
      // Never past a turn whose input is still to come.
      while (state.cursor < index && (segments[state.cursor] as CrewSegment).at <= now) {
        state.cursor += 1;
      }
      if (state.cursor === index) state.cursor += 1;
      return segments[index] as CrewSegment;
    }
    for (let index = state.cursor - 1; index >= 0; index -= 1) {
      if (holds(index)) return segments[index] as CrewSegment;
    }
    if (this.heldInputs(state).has(words) || unrecordedClose(text, state)) return null;
    const next = segments[state.cursor];
    if (next) state.cursor += 1;
    return next ?? null;
  }

  /** The words a crewmate's recording holds as served to it: its turns' inputs and the Firstmate's steers. */
  private heldInputs(state: CrewState): Set<string> {
    const alias = state.alias ?? "";
    const known = this.heldWords.get(alias);
    if (known) return known;
    const words = new Set([
      ...(state.recording?.segments ?? []).map((segment) => normalizeWording(segment.user)),
      ...(this.recordedSteers.get(alias) ?? []).map((steer) => steer.words),
    ]);
    this.heldWords.set(alias, words);
    return words;
  }

  private noteJobStarted(taskId: string, jobId: string): void {
    const running = this.runningJobs.get(taskId) ?? new Set<string>();
    running.add(jobId);
    this.runningJobs.set(taskId, running);
  }

  private noteJobFinished(taskId: string, jobId: string): void {
    this.runningJobs.get(taskId)?.delete(jobId);
  }

  private playCrewSegment(
    segment: CrewSegment,
    state: CrewState,
    spec: CrewmateSpec,
    emit: (event: FmEvent) => void,
  ): void {
    if (!this.playedCrewSegments.has(segment)) {
      this.playedCrewSegments.add(segment);
      this.fidelity.played_crewmate_turns += 1;
    }
    for (const message of segment.messages) {
      for (const part of message.parts) {
        if (part.type === "text") {
          emit({ type: "assistant_delta", taskId: state.taskId, text: part.text });
          continue;
        }
        const result = segment.results.get(part.id);
        const started = result ? JOB_STARTED.exec(result) : null;
        if (started?.[1]) this.noteJobStarted(state.taskId, started[1]);
        this.crewTool(part, result, spec);
      }
      if (message.error) emit({ type: "turn_failed", taskId: state.taskId, error: message.error });
      emit({ type: "turn_end", taskId: state.taskId });
    }
  }

  private crewTool(
    part: Extract<CrewPart, { type: "toolCall" }>,
    recordedResult: string | undefined,
    spec: CrewmateSpec,
  ): void {
    const args = this.mapArgs(part.args) as JsonRecord;
    const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
    try {
      switch (part.name) {
        case "emit_card": {
          const shown = syncCardId(
            spec.onCard?.({
              title: text("title"),
              body: recordedQuestions(text("body"), args.actions),
              actions: recordedActions(args.actions),
              ...(text("id") ? { id: text("id") } : {}),
              // A revision recorded before revisions carried an answer stands
              // in with one, or today's host refuses it while the captain waits.
              reply: text("reply") || RECORDED_REVISION_ANSWER,
            }),
          );
          if (shown) {
            this.crewCardIds.add(shown);
            const was = recordedResult ? cardIdFromEmitResult(recordedResult) : null;
            if (was) this.alias(was, shown);
          }
          break;
        }
        case "close_card":
          spec.onCloseCard?.({ cardId: text("card_id"), reason: text("reason") || undefined });
          break;
        case "reply":
          spec.onReply?.({ cardId: text("card_id"), text: text("text") });
          break;
        case "report":
          spec.onReport?.(text("text"));
          break;
        case "note_progress":
          spec.onProgress?.(text("text"));
          break;
        case "file_followup":
          spec.onFollowup?.({
            title: text("title"),
            goal: text("goal"),
            why: text("why"),
            blocksMe: args.blocks_me === true,
          });
          break;
        default:
          break;
      }
    } catch {
      // A refusal at the crewmate's own boundary: the card is simply not shown.
    }
  }

  private readonly refusedCardChoices: string[] = [];

  private applyChoice(card: Card, action: string, source: "chrome" | "frame" = "chrome"): void {
    try {
      this.supervisor.act(card.id, action, source);
    } catch (error) {
      if (!(error instanceof CardChoiceUnavailableError)) throw error;
      // The recording is an input, not permission to bypass current admission.
      this.fidelity.skipped_card_resolutions += 1;
      this.refusedCardChoices.push(card.title);
    }
  }

  // ---- inputs ------------------------------------------------------------

  private async apply(event: TimelineEvent): Promise<void> {
    switch (event.type) {
      case "captain":
        await this.ensureRepos(event.turn.fleet);
        await this.firstmate.converse(event.turn.user);
        return;
      case "crew-start": {
        const recording = this.crew.get(event.alias);
        const brief = recording?.segments[0]?.user ?? "";
        const goal = /^Goal: (.*)$/m.exec(brief)?.[1] ?? brief.split("\n")[0] ?? "Recorded task";
        const words =
          /verbatim[^\n]*\n(.*)$/m.exec(brief)?.[1] ?? goal;
        this.pendingSpawnAlias = event.alias;
        try {
          await this.supervisor.commission({
            title: goal.slice(0, 64),
            intent: { goal, userWords: words },
          });
        } finally {
          this.pendingSpawnAlias = null;
        }
        return;
      }
      case "crew-input": {
        const state = this.crewStates.get(event.alias);
        const taskId = this.toReplay.get(event.alias);
        if (state) state.cursor = Math.max(state.cursor, event.segment);
        if (!taskId) return;
        if (event.input.kind === "job") {
          const finished = JOB_FINISHED.exec(event.input.text);
          if (finished?.[1]) this.noteJobFinished(taskId, finished[1]);
          this.supervisor.deliverJobResult(taskId, event.input.text);
        } else if (event.input.kind === "choice") {
          const title = event.input.title;
          const card = this.supervisor
            .cardsSnapshot()
            .find((candidate) => candidate.taskId === taskId && candidate.title === title);
          if (card) this.applyChoice(card, event.input.actionId);
          else this.fidelity.skipped_card_resolutions += 1;
        }
        return;
      }
      case "crew-cancel": {
        const taskId = this.toReplay.get(event.alias);
        const record = taskId ? this.tasks.get(taskId) : undefined;
        if (!taskId || !record || TaskService.isClosed(record)) return;
        await this.supervisor.interruptCrewmate(taskId, "cancel").catch(() => {});
        return;
      }
      case "card-resolution": {
        const card = this.openCard(event.cardId, event.taskAlias, event.title);
        if (!card) {
          this.fidelity.skipped_card_resolutions += 1;
          return;
        }
        if (event.action === "close") this.supervisor.close(card.id);
        else this.applyChoice(card, event.action, event.source);
        return;
      }
      case "thread-reply": {
        // The current host never showed the card, so there is nothing to
        // reply under: the author's recorded answer cannot play.
        const card = this.openCard(event.cardId, event.taskAlias, event.title);
        if (!card) {
          this.fidelity.skipped_thread_replies += 1;
          this.skippedReplies.push({ taskAlias: event.taskAlias, text: event.text });
          return;
        }
        if (event.turn) await this.ensureRepos(event.turn.fleet);
        try {
          // The host's own reply path: a steer to the crewmate that wrote
          // the card, or a captain turn about the Firstmate's own.
          this.supervisor.replyToCard(card.id, event.text);
        } catch {
          // The recording is an input, not permission to bypass a refusal.
          this.fidelity.skipped_thread_replies += 1;
          this.skippedReplies.push({ taskAlias: event.taskAlias, text: event.text });
        }
        return;
      }
    }
  }

  /** The replay's open card for a recorded one: by its id, else by its title on the same task. */
  private openCard(
    cardId: string,
    taskAlias: string | null,
    title: string | null,
  ): Card | undefined {
    const open = this.supervisor.cardsSnapshot();
    const mapped = this.toReplay.get(cardId);
    const taskId = taskAlias ? this.toReplay.get(taskAlias) : undefined;
    const sameTitle = (candidate: Card) =>
      candidate.title === title && (taskId ? candidate.taskId === taskId : true);
    return (
      open.find((candidate) => candidate.id === mapped) ??
      (title === null ? undefined : open.find(sameTitle))
    );
  }

  /**
   * End-of-timeline flush (WI-13). The coalescing window holds a wake until
   * the clock moves past it, and in production a real timer supplies that
   * move; the replay's clock only advances between recorded events, so at the
   * end it advances the clock past the window and settles, repeatedly, until
   * both lanes are empty. Each pass drains one hop - a held wake, then the
   * escalations it cascades into, then those - so a bounded loop covers the
   * supervision -> firstmate chain without waiting on wall time.
   */
  private async flush(): Promise<void> {
    for (let pass = 0; pass < 6; pass += 1) {
      this.clock.advanceTo(Date.now() + WAKE_COALESCE_MS + 1);
      await this.tick();
      await this.settle();
      const pending = this.inbox.pending(FIRSTMATE_RECIPIENT, Date.now(), { limit: 1 }).length;
      if (pending === 0) return;
    }
  }

  /** The supervisor's shared tick, on recorded time. */
  private async tick(): Promise<void> {
    const now = Date.now();
    await this.supervisor.sweepInbox(now).catch(() => {});
    await this.supervisor.sweepGates(now).catch(() => {});
    this.firstmate.pokeInbox();
  }

  /** Wait until every actor is idle and nothing due is left undrained. */
  private async settle(): Promise<void> {
    const deadline = performance.now() + SETTLE_LIMIT_MS;
    let quiet = 0;
    let pokes = 0;
    while (performance.now() < deadline) {
      await realSleep(2);
      const busy = this.firstmate.isBusy() || this.inflight > 0;
      if (busy) {
        quiet = 0;
        continue;
      }
      const now = Date.now();
      const due = this.inbox.pending(FIRSTMATE_RECIPIENT, now, { limit: 1 }).length;
      if (due > 0 && pokes < 3) {
        pokes += 1;
        quiet = 0;
        this.firstmate.pokeInbox();
        continue;
      }
      quiet += 1;
      if (quiet >= 4) return;
    }
    this.fidelity.settle_timeouts += 1;
  }

  // ---- scoring -----------------------------------------------------------

  /** Every recorded crewmate turn the replay never played, by crewmate and turn, and why. */
  private unplayedCrewTurns(): SessionReport["details"]["unplayed_crewmate_turns"] {
    const unplayed: SessionReport["details"]["unplayed_crewmate_turns"] = [];
    for (const [alias, recording] of [...this.crew].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [turn, segment] of recording.segments.entries()) {
        if (this.playedCrewSegments.has(segment)) continue;
        unplayed.push({
          crewmate: alias,
          turn,
          at: new Date(segment.at).toISOString(),
          reason: this.unplayedReason(alias, segment),
        });
      }
    }
    return unplayed;
  }

  /**
   * Why one recorded crewmate turn never played, read off what the replay
   * did with the input it answered: the crewmate never started, the card
   * its choice or thread reply was on was never shown, or the Firstmate
   * steer it answered never played or never reached it in time. The host
   * serves a thread reply with the captain's words verbatim.
   */
  private unplayedReason(alias: string, segment: CrewSegment): UnplayedCrewReason {
    if (!this.crewStates.has(alias)) {
      return this.spawnTurns.get(alias)?.consumed === false ? "spawn-not-played" : "not-started";
    }
    // A batched input is read by its first part, the one its turn opened on.
    const choice = RECORDED_CHOICE.exec(segment.user.split("\n\n")[0] ?? "");
    if (choice) return this.everShown(alias, choice[1] ?? "") ? "unserved" : "card-not-shown";
    const reply = this.skippedReplies.find(
      (skipped) =>
        (skipped.taskAlias === null || skipped.taskAlias === alias) &&
        segment.user.includes(skipped.text),
    );
    if (reply) return "reply-not-delivered";
    const words = normalizeWording(segment.user);
    const steer = this.recordedSteers
      .get(alias)
      ?.find((candidate) => candidate.delivered && candidate.words === words);
    if (steer) return steer.turn.consumed ? "steer-not-received" : "steer-not-played";
    return "unserved";
  }

  /** Whether the replay ever showed a card with this title on the crewmate's task. */
  private everShown(alias: string, title: string): boolean {
    const taskId = this.toReplay.get(alias);
    if (!taskId) return false;
    return (
      this.db
        .prepare("SELECT 1 FROM cards WHERE task_id = ? AND title = ? LIMIT 1")
        .get(taskId, title) !== undefined
    );
  }

  private report(): SessionReport {
    const rows = this.db.prepare("SELECT * FROM cards").all() as TableRow[];
    const cards: ObservedCard[] = rows.map((row) => this.observeCard(row));
    const questions: ObservedQuestion[] = this.captainTurns
      .filter((turn) => isQuestion(turn.user))
      .map((turn) => {
        const played = this.captainPlays.get(turn);
        return {
          at: turn.at,
          text: turn.user,
          answeredInTurn: Boolean(played && played.cardsShown.length > 0 && !played.spawned),
          answerCardIds: played?.cardsShown ?? [],
        };
      });
    const records = this.tasks.list();
    const closed = records.filter((record) => TaskService.isClosed(record));
    const observation: SessionObservation = {
      captainTurns: this.captainTurns.length,
      questions,
      cards,
      opWakes: this.observed.opWakes,
      guidanceQueuedWakes: this.observed.guidanceQueuedWakes,
      escalations: this.observed.escalations,
      wakesAfterCancel: this.observed.wakesAfterCancel,
      lockRefusals: this.observed.lockRefusals.length,
      closedTasks: closed.map((record) => ({
        status: record.status as "done" | "dropped",
        worktreePresent: record.workspaceState === "present",
        // WI-11 retired `delivered`: only merge and land close as done, and
        // host closes are dropped, so a close without evidence is structural.
        deliveredWithoutEvidence: false,
      })),
      implausibleOutcomes: records.filter((record) => record.outcome && looksGarbled(record.outcome))
        .length,
      spawnStartFailures: this.observed.spawnStartFailures,
      dispatches: this.dispatches(records, rows),
      reviews: this.reviews(),
      approvals: this.observed.approvals,
      asksWithoutAction: [...this.captainPlays.values()].filter(
        (play) => !actionTookEffect(play.delivery.map((note) => ({ ...note, at: 0 }))),
      ).length,
    };
    const authored = cards.filter((card) => card.author !== "host");
    const titles = new Map(authored.map((card) => [card.id, card.title]));
    const pairs: CardPair[] = duplicatePairs(authored);
    const window = this.sources.window ?? null;
    const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
    return {
      session: this.sources.name,
      window: window ? { from: iso(window.from), to: iso(window.to) } : null,
      provenance: {
        firstmate_prompt_sha: sha(buildFirstmateSystemPrompt()),
        crewmate_prompt_sha: sha(buildCrewmateSystemPrompt()),
      },
      fidelity: { ...this.fidelity, missing_tools: [...this.fidelity.missing_tools].sort() },
      metrics: scoreSession(observation),
      details: {
        captain_turn_order: this.captainTurnOrder.map((turn) => ({
          at: new Date(turn.at).toISOString(),
          user: turn.user,
        })),
        refused_card_choices: this.refusedCardChoices,
        withdrawn_cards: this.withdrawnCards,
        retired_cards: this.retiredCards,
        unplayed_crewmate_turns: this.unplayedCrewTurns(),
        lock_refusals: this.observed.lockRefusals,
        // Ordered by the recorded ids, never the replay's own: those are
        // minted fresh every run, and the report must read the same twice.
        duplicate_pairs: pairs
          .map((pair) => ({
            task: this.toRecorded.get(pair.taskId) ?? null,
            first: titles.get(pair.first) ?? "",
            second: titles.get(pair.second) ?? "",
            similarity: Math.round(pair.similarity * 10_000) / 10_000,
          }))
          .sort(
            (a, b) =>
              (a.task ?? "").localeCompare(b.task ?? "") ||
              a.first.localeCompare(b.first) ||
              a.second.localeCompare(b.second),
          ),
        escalations: this.observed.escalations,
        unrecorded_wakes: this.observed.unrecordedWakes,
        unanswered_questions: questions
          .filter((question) => !question.answeredInTurn)
          .map((question) => excerpt(question.text)),
        closed_with_worktree: closed
          .filter((record) => record.workspaceState === "present")
          .map((record) => record.title),
        approvals: this.observed.approvals.map((approval) => ({
          card: approval.card,
          choice: approval.choice,
          builds: approval.builds,
          plan: approval.plan,
          grounded_starts: approval.groundedStarts,
        })),
      },
    };
  }

  /**
   * The work this replay commissioned, as the record holds it (S5). A row
   * carries a shape the real `CrewSupervisor` computed; a seeded pre-session
   * row keeps the shape it was recorded with, and is not a dispatch of this
   * replay either way. The served tier comes from
   * the ledger's routing rows, which are empty here: a replay has no live catalog
   * to route against, so the downgrade rate is honestly unmeasurable rather
   * than a clean zero.
   */
  private dispatches(records: TaskRecord[], cardRows: TableRow[]): ObservedDispatch[] {
    const served = new Map<string, string | null>();
    for (const row of this.ledger.routing()) served.set(row.taskId, row.served);
    // The caps this replay placed, as the record holds them (phase 4): a
    // cap still standing is on the delivery facts, and one that was
    // answered left a `cap_reset` behind - the hold survives its counters.
    const resets = new Map<string, number>();
    for (const row of this.db
      .prepare("SELECT task_id, COUNT(*) AS resets FROM task_events WHERE kind = 'cap_reset' GROUP BY task_id")
      .all() as { task_id: string; resets: number }[]) {
      resets.set(row.task_id, row.resets);
    }
    // The captain's overrides this replay recorded (INF-484 move 8).
    const overrides = new Map<string, string[][]>();
    for (const row of this.db
      .prepare(
        `SELECT task_id, data_json FROM task_events
           WHERE kind = 'note' AND data_json LIKE '%"override":%' ORDER BY at, id`,
      )
      .all() as { task_id: string; data_json: string | null }[]) {
      const holds = overrideHoldsFrom(row.data_json);
      if (holds) overrides.set(row.task_id, [...(overrides.get(row.task_id) ?? []), holds]);
    }
    // Whether a change SETTLED at all still reads off its completion card -
    // the newest one that could, because a revision replaces the reading its
    // earlier version gave - but the evidence contract is now read on the
    // report (contract v3.6, captain lock 3): the five headings left the
    // card's open body and stayed required in the report and the PR body,
    // so grading the card would grade a rule the lint no longer applies.
    const settled = new Set<string>();
    for (const row of cardRows) {
      const taskId = stringColumn(row, "task_id");
      if (taskId && isCompletionCard(stringColumn(row, "actions_json"))) settled.add(taskId);
    }
    return records
      .filter((record) => record.shape !== null && !this.seeded.has(record.id))
      .map((record) => {
        // A review task ships nothing, so it reports no rigor at all.
        const rigor =
          record.shape?.kind === "review" ? null : (record.shape?.rigor ?? "quick");
        const delivery = record.delivery;
        return {
          taskId: record.id,
          tier: record.difficulty,
          served: served.get(record.id) ?? null,
          kindSource: record.shape?.kind_source ?? null,
          escalatedFrom: record.shape?.escalation?.from ?? null,
          skippedPlanBecause: record.shape?.skipped_plan_because ?? null,
          rigor,
          // What the row DELIVERS (Task B); a recorded spawn from before the
          // axis shipped a change, which is what null reads as.
          deliverable: record.shape?.deliverable ?? null,
          delivery: delivery?.mode ?? null,
          hasPr: Boolean(delivery?.prUrl || delivery?.prNumber),
          ciRounds: delivery?.ciRounds ?? (delivery?.ci !== undefined ? 0 : null),
          capHits:
            (delivery?.ciCapAt !== undefined ? 1 : 0) +
            (delivery?.reviewCapAt !== undefined ? 1 : 0) +
            (resets.get(record.id) ?? 0),
          overrides: overrides.get(record.id) ?? [],
          evidence:
            rigorRequiresEvidence(rigor as Rigor | undefined) && settled.has(record.id)
              ? carriesEvidenceHeadings(reportEvidenceHeadings(record.outcome))
              : null,
        };
      });
  }

  /**
   * Every verdict a reviewer returned in this replay, off the builders' own
   * timelines (`review` events, phase 2), paired with the report text the
   * review task still holds so the findings can be counted.
   */
  private reviews(): ObservedReview[] {
    const events: ReviewEvent[] = (
      this.db
        .prepare(
          "SELECT task_id, at, data_json FROM task_events WHERE kind = 'review' ORDER BY at, id",
        )
        .all() as { task_id: string; at: number; data_json: string | null }[]
    ).map((row) => reviewEventFrom(row.task_id, row.at, row.data_json));
    const reports = new Map<string, string | null>();
    for (const record of this.tasks.list()) {
      if (record.shape?.kind === "review") reports.set(record.id, record.outcome ?? null);
    }
    return observedReviews(events, reports);
  }

  private plainLabelMap: Map<string, boolean> | null = null;
  private clearLabelMap: Map<string, boolean> | null = null;
  private prLinkLabelMap: Map<string, boolean> | null = null;

  /** The hand labels, read once per engine; an unreadable file is a loud failure, never an empty sample. */
  private plainLabels(): Map<string, boolean> {
    if (this.plainLabelMap) return this.plainLabelMap;
    const file = this.sources.plainLabels ?? null;
    const text = file ? readFileSync(file, "utf8") : null;
    this.plainLabelMap = text === null ? new Map() : parsePlainLabels(text);
    this.clearLabelMap = text === null ? new Map() : parseClearLabels(text);
    this.prLinkLabelMap = text === null ? new Map() : parsePrLinkLabels(text);
    return this.plainLabelMap;
  }

  /** The sentence-habit labels: the second reading filed in the same rows. */
  private clearLabels(): Map<string, boolean> {
    this.plainLabels();
    return this.clearLabelMap ?? new Map();
  }

  /** The pull request link labels: the third reading, on the rows whose body names one. */
  private prLinkLabels(): Map<string, boolean> {
    this.plainLabels();
    return this.prLinkLabelMap ?? new Map();
  }

  private observeCard(row: TableRow): ObservedCard {
    const id = stringColumn(row, "id") ?? "";
    const body = stringColumn(row, "body") ?? "";
    const title = stringColumn(row, "title") ?? "";
    let actions: JsonRecord[] = [];
    try {
      const parsed = JSON.parse(stringColumn(row, "actions_json") ?? "[]") as unknown;
      if (Array.isArray(parsed)) actions = parsed as JsonRecord[];
    } catch {
      actions = [];
    }
    const chosen = stringColumn(row, "chosen_action");
    const resolvedAt = numberColumn(row, "resolved_at");
    return {
      id,
      taskId: stringColumn(row, "task_id"),
      title,
      body,
      createdAt: numberColumn(row, "created_at") ?? 0,
      author: id.startsWith("card-fm-")
        ? "firstmate"
        : this.crewCardIds.has(id)
          ? "crewmate"
          : "host",
      // The body as the frame renders it: since the sanitizer was removed
      // (captain decision, 2026-09-15) nothing stands between the two.
      visual: /<(table|svg|figure|canvas)\b/i.test(body),
      resolvedAt,
      resolution:
        resolvedAt === null
          ? "open"
          : chosen === "closed"
            ? "withdrawn"
            : chosen === "close" || chosen === "dismiss"
              ? "dismissed"
              : "acted",
      duplicateOf: stringColumn(row, "duplicate_of"),
      // The hand-scored plain-language label, keyed by the card's own words.
      plain: this.plainLabels().get(cardLabelKey({ title, body })) ?? null,
      // The hand-scored sentence-habit label, filed in the same row.
      clear: this.clearLabels().get(cardLabelKey({ title, body })) ?? null,
      // The hand-scored pull request link label, filed in the same row.
      prLinks: this.prLinkLabels().get(cardLabelKey({ title, body })) ?? null,
      hasDefault: actions.some((action) => action.default === true),
      fakeSettle: actions.some(
        (action) =>
          typeof action.id === "string" &&
          isFakeSettleAction({
            id: action.id,
            label: typeof action.label === "string" ? action.label : "",
            effect: (action.effect as { kind: string } | undefined) ?? null,
          }),
      ),
    };
  }

}

/**
 * A recorded card's actions in P1's vocabulary. The sessions were recorded
 * under the reserved-id contract, so the ids the host used to dispatch on
 * (merge-pr, land, discard, open-settings, ...) become the effects they
 * meant - `migrateLegacyActions`, the same mapping migration 29 runs over
 * an upgraded database. A recorded `keeps_open` action loses only its flag,
 * retired at contract 4.65: it stays the effect-free reply it is today,
 * whose click returns to its author with the captain's answers, as the
 * button asked. It was one of the card's 2 or 3 actions when recorded, so
 * dropping it would leave a recorded decision a lone action the count
 * refuses (FI3-411; FI3-309's plan card offered Agree and Use these
 * answers). A recorded click on one would close the card where the old
 * button kept it open; no committed recording has one. A lookalike id
 * ("merge-pr55") stays a reply with no effect, which is exactly what the
 * fake-button metric counts.
 */
/**
 * onCard's return can be a promise now that a merge decision on a
 * direct-pr task may clear a live CI gate first; replay never wires
 * `checkCi` (its mergePullRequest is a stub), so the gate never applies
 * here and every card resolves synchronously, exactly as before.
 */
function syncCardId(id: string | Promise<string | undefined> | undefined): string | undefined {
  if (id instanceof Promise) {
    throw new Error("replay does not expect a pending CI gate on a recorded card");
  }
  return id;
}

/**
 * A recorded spawn in today's vocabulary: v2.8's facts, grouped as v4.12
 * serves them. `premium_ask` and
 * `override_model_id` are the two facts a pre-S2 spawn really carried:
 * `difficulty: premium` was only ever set because the captain asked in
 * words (the v2.7 routing rule), and `model_id` is the same override under
 * its old name. A judged low/medium/high carried no fact the policy reads,
 * so it drops and the work routes as `unclear` does - which is the
 * contract change the baseline is expected to move for.
 */
export function recordedShape(args: JsonRecord): void {
  const shape = legacyShapeFromDifficulty(
    typeof args.difficulty === "string" ? (args.difficulty as IntelligenceBucket) : null,
    typeof args.model_id === "string" ? args.model_id : null,
  );
  delete args.difficulty;
  delete args.model_id;
  if (shape.premium_ask) args.premium_ask = true;
  if (shape.override_model_id) args.override_model_id = shape.override_model_id;
  // A recording from before contract v4.12 carries the work-shape facts and
  // the waits flat; today's tool groups them under `shape` and
  // `start_after`, and a grouped recording passes through as it is.
  const grouped = groupSpawnArgs(args);
  for (const key of Object.keys(args)) delete args[key];
  Object.assign(args, grouped);
  // A recorded session predates delivery rigor (phase 2): nothing derived a
  // tier and no reviewer ran, so the spawn replays as the quick work it was
  // - through the one ask channel the tool has - rather than as a reviewed
  // task whose reports would skip the supervision the recording answers.
  const facts = (args.shape ?? {}) as JsonRecord;
  if (shape.rigor && facts.rigor_ask === undefined) {
    args.shape = { ...facts, rigor_ask: shape.rigor };
  }
}

/** A recorded row's work shape, read through today's schema; null when it carries none. */
function seededShape(raw: string | null): WorkShape | null {
  if (!raw) return null;
  try {
    const parsed = workShapeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A recorded decision's questions in today's authoring (contract 4.56).
 * Until then CARD_AUTHORING told the author to check or select the option
 * it proposed, so a recorded decision can ask a required question already
 * answered, which today's lint refuses (FI3-309's plan card asked nine).
 * What it checked or selected was its proposal, and today's author marks
 * that `data-inf-recommended` instead - the frame bridge reads the mark as
 * the proposal - with a select opening on an empty Choose option. Until
 * FI3-1002 no author ended a question with a Something else row either, and
 * today's lint refuses a question with options and none, so the row is added
 * where today's author writes it: past the question's last row. Like
 * `recordedActions`, this replays what the author meant through today's
 * tool. Only the start tags the lint names move and the rows it asks for
 * are added; every other byte stays as recorded, and a card the lint would
 * pass is returned unchanged.
 */
export function recordedQuestions(body: string, actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0 || isPreviewBody(body)) return body;
  const edits: { at: number; end: number; text: string }[] = [];
  for (const gap of writeInGaps(body)) {
    if (gap.at < 0) continue;
    edits.push({ at: gap.at, end: gap.at, text: somethingElseRow(gap) });
  }
  for (const question of preansweredQuestions(body)) {
    for (const pick of question.picks) {
      const tag = START_TAG.exec(body.slice(pick.at))?.[0];
      if (!tag) continue;
      edits.push({ at: pick.at, end: pick.at + tag.length, text: markRecommended(tag, pick) });
    }
    for (const at of question.chooseAt) {
      const tag = START_TAG.exec(body.slice(at))?.[0];
      if (tag) edits.push({ at: at + tag.length, end: at + tag.length, text: CHOOSE_OPTION });
    }
  }
  // From the end backwards, so every offset still names the recorded byte;
  // at one offset the tag's own edit goes before an insertion in front of it.
  edits.sort((a, b) => b.at - a.at || b.end - a.end);
  return edits.reduce((text, edit) => text.slice(0, edit.at) + edit.text + text.slice(edit.end), body);
}

const CHOOSE_OPTION = '<option value="">Choose</option>';

/** The Something else row today's author ends a question with (FI3-1002). */
function somethingElseRow(gap: { name: string; control: "radio" | "checkbox" | "select" }): string {
  if (gap.control === "select") return '<option value="other" data-inf-write-in>Something else</option>';
  const name = gap.name.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<label><input type="${gap.control}" name="${name}" value="other" data-inf-write-in> Something else</label>`;
}
/** One start tag at the head of a string: its name, then each attribute, quoted values whole. */
const START_TAG = /^<[a-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/i;
const TAG_ATTRIBUTE = /\s+([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

/** The start tag with its written pick turned into the recommendation mark, or the mark added. */
function markRecommended(
  tag: string,
  pick: { attribute: "checked" | "selected"; written: boolean },
): string {
  if (!pick.written) return tag.replace(/\s*\/?>$/, (end) => ` data-inf-recommended${end}`);
  const head = /^<[^\s/>]+/.exec(tag)?.[0] ?? "";
  const rest = tag.slice(head.length);
  return (
    head +
    rest.replace(TAG_ATTRIBUTE, (whole, name: string) =>
      name.toLowerCase() === pick.attribute ? " data-inf-recommended" : whole,
    )
  );
}

function recordedActions(raw: unknown): CardAction[] {
  if (!Array.isArray(raw)) return [];
  const actions = raw
    .filter(
      (action): action is JsonRecord =>
        !!action && typeof action === "object" && typeof (action as JsonRecord).id === "string",
    )
    .map(({ keeps_open: _retired, ...action }) => action as unknown as CardAction);
  return migrateLegacyActions(actions);
}

function legacyStateOf(row: TableRow): { status: LegacyTaskStatus; worktree: boolean } | null {
  const status = stringColumn(row, "status");
  const activity = stringColumn(row, "activity");
  const reason = stringColumn(row, "closed_reason");
  const worktree =
    stringColumn(row, "workspace_state") === "present" ||
    (stringColumn(row, "workspace_state") === null && Boolean(stringColumn(row, "worktree_dir")));
  switch (status) {
    case "queued":
    case "running":
    case "idle":
    case "interrupted":
    case "completed":
    case "cancelled":
    case "failed":
      return { status, worktree };
    case "open":
      return { status: "queued", worktree: false };
    case "active":
      return {
        status: activity === "interrupted" ? "interrupted" : activity === "running" ? "running" : "idle",
        worktree: true,
      };
    case "delivered":
      return { status: "completed", worktree: true };
    case "done":
      return { status: "completed", worktree: false };
    case "dropped":
      return { status: reason === "failed" ? "failed" : "cancelled", worktree };
    default:
      return null;
  }
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function excerpt(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Replay one recorded captain session against the current code and score it. */
export async function replaySession(sources: ReplaySources): Promise<SessionReport> {
  return new Replay(sources).run();
}
